pub mod connections;
pub mod core;
pub mod network;
pub mod server;

use crate::connections::{system_runner, Connections};
use crate::core::{AppError, Brise, Event};
use crate::network::{hostname, interfaces, qr_svg, valid_address, wifi_payload, Network};
use crate::server::{gateway_factory, serve, Ctx};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub const DEFAULT_PORT: u16 = 53318;

pub struct App {
    pub brise: Arc<Brise>,
    pub network: Arc<Mutex<Network>>,
    pub connections: Arc<Connections>,
    pub server_error: Mutex<Option<String>>,
    lock: PathBuf,
    hidden_once: AtomicBool,
}

pub fn paths() -> (PathBuf, PathBuf) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let data = std::env::var_os("BRISE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| home.join(".local/share")).join("brise"));
    let receive = std::env::var_os("BRISE_RECEIVE_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::download_dir().unwrap_or_else(|| home.join("Téléchargements")).join("Brise"));
    (data, receive)
}

fn acquire_lock(data_dir: &std::path::Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let lock = data_dir.join("server.lock");
    for _ in 0..2 {
        match std::fs::create_dir(&lock) {
            Ok(()) => {
                std::fs::write(lock.join("pid"), std::process::id().to_string()).map_err(|e| e.to_string())?;
                return Ok(lock);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let pid = std::fs::read_to_string(lock.join("pid")).ok().and_then(|p| p.trim().parse::<u32>().ok());
                if let Some(pid) = pid {
                    if pid != std::process::id() && PathBuf::from(format!("/proc/{pid}")).exists() {
                        return Err("Une autre instance de Brise est déjà lancée (peut-être l’ancienne version dans le navigateur). Quittez-la depuis ses réglages, puis relancez Brise.".into());
                    }
                }
                let _ = std::fs::remove_dir_all(&lock);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Impossible de verrouiller le dossier de données de Brise.".into())
}

pub async fn start(data_dir: PathBuf, receive_dir: PathBuf) -> Result<Arc<App>, String> {
    let lock = acquire_lock(&data_dir)?;
    let brise = match Brise::open(data_dir, receive_dir) {
        Ok(brise) => brise,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&lock);
            return Err(format!("Impossible de préparer les dossiers de Brise : {error}"));
        }
    };
    let port = std::env::var("BRISE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let fixed = std::env::var("BRISE_ADDRESS").ok().filter(|a| valid_address(a));
    let network = Arc::new(Mutex::new(Network::new(port, interfaces(), fixed)));
    let connections = Connections::new(brise.clone(), network.clone(), system_runner(), Some(gateway_factory(brise.clone(), network.clone())), None);
    let app = Arc::new(App { brise: brise.clone(), network: network.clone(), connections: connections.clone(), server_error: Mutex::new(None), lock, hidden_once: AtomicBool::new(false) });
    let ctx = Arc::new(Ctx { brise: brise.clone(), network: network.clone(), connections: Some(connections.clone()), public: false, gateway_port: AtomicU16::new(0) });
    match serve(ctx, ("0.0.0.0", port)).await {
        Ok((bound, _)) => network.lock().unwrap_or_else(|p| p.into_inner()).port = bound,
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::AddrInUse {
                format!("Le port {port} est déjà utilisé par une autre application. Fermez-la, ou lancez Brise avec BRISE_PORT=<autre port>.")
            } else {
                format!("Le serveur de partage n’a pas pu démarrer : {error}")
            };
            *app.server_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
        }
    }
    let init = connections.clone();
    tokio::spawn(async move { init.init().await });
    let sync = connections.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            sync.sync_network();
        }
    });
    let sweep = brise.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            sweep.sweep();
        }
    });
    Ok(app)
}

impl App {
    pub fn pair_url(&self) -> Option<String> {
        let (token, _) = self.brise.pair_token();
        self.connections.origin().map(|origin| format!("{origin}/connect#{token}"))
    }

    pub fn state(&self) -> Value {
        let view = self.brise.desktop_view();
        let network = self.network.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let server_error = self.server_error.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let connection = self.connections.view();
        json!({
            "role": "admin",
            "status": "approved",
            "network": { "address": network.address, "port": network.port, "interfaces": network.interfaces, "hostname": hostname() },
            "connectionMode": connection["mode"],
            "connection": connection,
            "devices": view.devices,
            "files": view.files,
            "transfers": view.transfers,
            "expiresAt": view.expires_at,
            "pairUrl": if server_error.is_some() { None } else { self.pair_url() },
            "receiveDir": self.brise.receive_dir,
            "maxFileSize": self.brise.max_file_size,
            "serverError": server_error,
        })
    }

    pub async fn shutdown(&self) {
        self.brise.cancel_all();
        self.connections.close().await;
        let _ = std::fs::remove_dir_all(&self.lock);
    }
}

type Shared<'a> = State<'a, Arc<App>>;
type Reply<T> = Result<T, String>;

fn text(error: AppError) -> String {
    error.message
}

#[tauri::command]
fn get_state(app: Shared<'_>) -> Value {
    app.state()
}

#[tauri::command]
fn qr(app: Shared<'_>) -> Reply<String> {
    app.pair_url().map(|url| qr_svg(&url)).ok_or_else(|| "Aucune adresse réseau disponible.".into())
}

#[tauri::command]
fn wifi_qr(app: Shared<'_>) -> Reply<String> {
    app.connections.hotspot().map(|h| qr_svg(&wifi_payload(&h.ssid, &h.password))).ok_or_else(|| "Le point d’accès n’est pas actif.".into())
}

#[tauri::command]
fn decide(app: Shared<'_>, id: String, approve: bool) -> Reply<()> {
    app.brise.decide(&id, approve).map_err(text)
}

#[tauri::command]
fn rotate(app: Shared<'_>) {
    app.brise.rotate();
}

#[tauri::command]
fn set_address(app: Shared<'_>, address: String) -> Reply<()> {
    if app.connections.mode() != connections::Mode::Local || app.connections.busy_switching() {
        return Err("L’adresse manuelle est réservée au mode réseau local.".into());
    }
    let address = address.trim().to_string();
    if !valid_address(&address) {
        return Err("Indiquez l’adresse IPv4 du PC sur votre réseau local.".into());
    }
    app.network.lock().unwrap_or_else(|p| p.into_inner()).set_manual(address);
    app.brise.rotate();
    Ok(())
}

#[tauri::command]
fn select_mode(app: Shared<'_>, mode: String, interface: Option<String>, confirm_wifi_change: Option<bool>) -> Reply<Value> {
    app.connections.select(&mode, interface, confirm_wifi_change.unwrap_or(false)).map_err(text)
}

#[tauri::command]
async fn probe_modes(app: Shared<'_>) -> Reply<Value> {
    Ok(app.connections.probe().await)
}

#[tauri::command]
async fn pick_files(handle: AppHandle, app: Shared<'_>) -> Reply<usize> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.dialog().file().set_title("Choisir des fichiers à partager").pick_files(move |files| {
        let _ = tx.send(files);
    });
    let Some(files) = rx.await.ok().flatten() else { return Ok(0) };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    app.brise.share_paths(&paths).map_err(text)
}

#[tauri::command]
fn remove_shared(app: Shared<'_>, id: String) -> Reply<()> {
    app.brise.remove_shared(&id).map_err(text)
}

#[tauri::command]
fn open_folder(handle: AppHandle, app: Shared<'_>) -> Reply<()> {
    handle.opener().open_path(app.brise.receive_dir.to_string_lossy(), None::<&str>).map_err(|_| "Impossible d’ouvrir le gestionnaire de fichiers.".to_string())
}

#[tauri::command]
fn reveal_file(handle: AppHandle, app: Shared<'_>, id: String) -> Reply<()> {
    let file = app.brise.file(&id).ok_or_else(|| "Ce fichier n’existe plus.".to_string())?;
    if !file.path.exists() {
        return Err("Ce fichier a été déplacé ou supprimé.".into());
    }
    handle.opener().reveal_item_in_dir(&file.path).map_err(|_| "Impossible d’ouvrir le gestionnaire de fichiers.".to_string())
}

#[tauri::command]
async fn quit(handle: AppHandle, app: Shared<'_>) -> Reply<()> {
    app.shutdown().await;
    handle.exit(0);
    Ok(())
}

fn show_window(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn notify(handle: &AppHandle, title: &str, body: &str) {
    let _ = handle.notification().builder().title(title).body(body).show();
}

fn quit_from_tray(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(app) = handle.try_state::<Arc<App>>() {
            app.shutdown().await;
        }
        handle.exit(0);
    });
}

fn bridge(handle: AppHandle, app: Arc<App>) {
    let mut changes = app.brise.subscribe();
    let emitter = handle.clone();
    tauri::async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            let _ = emitter.emit("brise:changed", ());
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    });
    let mut events = app.brise.events();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(Event::PairRequest { name, code }) => {
                    show_window(&handle);
                    notify(&handle, &format!("{name} souhaite se connecter"), &format!("Code {} {} — vérifiez qu’il s’affiche sur le téléphone, puis acceptez dans Brise.", &code[..3], &code[3..]));
                }
                Ok(Event::Received { name }) => {
                    let focused = handle.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
                    if !focused {
                        notify(&handle, "Fichier reçu", &name);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, _, _| show_window(handle)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_state, qr, wifi_qr, decide, rotate, set_address, select_mode, probe_modes, pick_files, remove_shared, open_folder, reveal_file, quit])
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let (data_dir, receive_dir) = paths();
            match tauri::async_runtime::block_on(start(data_dir, receive_dir)) {
                Ok(app) => {
                    tauri_app.manage(app.clone());
                    bridge(handle.clone(), app);
                }
                Err(message) => {
                    let exit = handle.clone();
                    handle.dialog().message(message).title("Brise ne peut pas démarrer").kind(MessageDialogKind::Error).show(move |_| exit.exit(1));
                    return Ok(());
                }
            }
            let open = MenuItem::with_id(tauri_app, "open", "Ouvrir Brise", true, None::<&str>)?;
            let quit = MenuItem::with_id(tauri_app, "quit", "Quitter Brise", true, None::<&str>)?;
            let menu = Menu::with_items(tauri_app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("brise").tooltip("Brise").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = tauri_app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|handle, event| match event.id.as_ref() {
                "open" => show_window(handle),
                "quit" => quit_from_tray(handle),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    show_window(tray.app_handle());
                }
            })
            .build(tauri_app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let handle = window.app_handle();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(app) = handle.try_state::<Arc<App>>() {
                        if !app.hidden_once.swap(true, Ordering::Relaxed) {
                            notify(handle, "Brise reste actif", "Le partage continue dans la barre système. Utilisez « Quitter Brise » dans son menu pour l’arrêter.");
                        }
                    }
                }
                WindowEvent::DragDrop(DragDropEvent::Enter { .. }) => {
                    let _ = handle.emit("brise:drag", true);
                }
                WindowEvent::DragDrop(DragDropEvent::Leave) => {
                    let _ = handle.emit("brise:drag", false);
                }
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    let _ = handle.emit("brise:drag", false);
                    if let Some(app) = handle.try_state::<Arc<App>>() {
                        let message = match app.brise.share_paths(paths) {
                            Ok(0) => json!({ "error": true, "message": "Aucun fichier à partager." }),
                            Ok(n) => json!({ "error": false, "message": if n == 1 { "Fichier ajouté au partage.".to_string() } else { format!("{n} fichiers ajoutés au partage.") } }),
                            Err(error) => json!({ "error": true, "message": error.message }),
                        };
                        let _ = handle.emit("brise:toast", message);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Brise n’a pas pu démarrer");
}
