pub mod connections;
pub mod core;
pub mod i18n;
pub mod network;
pub mod server;
pub mod settings;

use crate::connections::{system_runner, Connections};
use crate::core::{AppError, Brise, Event};
use crate::i18n::{system_lang, tr, Lang};
use crate::network::{hostname, interfaces, qr_svg, valid_address, wifi_payload, Network};
use crate::server::{gateway_factory, serve, Ctx};
use crate::settings::{autostart_enabled, set_autostart, Store};
use serde::ser::{Serialize, Serializer};
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

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.body().serialize(serializer)
    }
}

pub struct App {
    pub brise: Arc<Brise>,
    pub network: Arc<Mutex<Network>>,
    pub connections: Arc<Connections>,
    pub settings: Arc<Store>,
    pub server_error: Mutex<Option<AppError>>,
    pub lang: Lang,
    lock: PathBuf,
    hidden_once: AtomicBool,
}

pub fn paths() -> (PathBuf, PathBuf) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let data = std::env::var_os("BRISE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| home.join(".local/share")).join("brise"));
    let receive = std::env::var_os("BRISE_RECEIVE_DIR").map(PathBuf::from).unwrap_or_else(|| dirs::download_dir().unwrap_or_else(|| home.join("Downloads")).join("Brise"));
    (data, receive)
}

fn acquire_lock(data_dir: &std::path::Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|_| "data_dirs".to_string())?;
    let lock = data_dir.join("server.lock");
    for _ in 0..2 {
        match std::fs::create_dir(&lock) {
            Ok(()) => {
                std::fs::write(lock.join("pid"), std::process::id().to_string()).map_err(|_| "lock_failed".to_string())?;
                return Ok(lock);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let pid = std::fs::read_to_string(lock.join("pid")).ok().and_then(|p| p.trim().parse::<u32>().ok());
                if let Some(pid) = pid {
                    if pid != std::process::id() && PathBuf::from(format!("/proc/{pid}")).exists() {
                        return Err("already_running".into());
                    }
                }
                let _ = std::fs::remove_dir_all(&lock);
            }
            Err(_) => return Err("lock_failed".into()),
        }
    }
    Err("lock_failed".into())
}

pub async fn start(data_dir: PathBuf, receive_dir: PathBuf) -> Result<Arc<App>, String> {
    let lock = acquire_lock(&data_dir)?;
    let brise = match Brise::open(data_dir, receive_dir) {
        Ok(brise) => brise,
        Err(error) => {
            eprintln!("Brise : {error}");
            let _ = std::fs::remove_dir_all(&lock);
            return Err("data_dirs".into());
        }
    };
    let port = std::env::var("BRISE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let fixed = std::env::var("BRISE_ADDRESS").ok().filter(|a| valid_address(a));
    let network = Arc::new(Mutex::new(Network::new(port, interfaces(), fixed)));
    let settings = Arc::new(Store::open(&brise.data_dir));
    let connections = Connections::new(brise.clone(), network.clone(), system_runner(), Some(gateway_factory(brise.clone(), network.clone(), settings.clone())), None);
    let app = Arc::new(App {
        brise: brise.clone(),
        network: network.clone(),
        connections: connections.clone(),
        settings: settings.clone(),
        server_error: Mutex::new(None),
        lang: system_lang(),
        lock,
        hidden_once: AtomicBool::new(false),
    });
    let ctx = Arc::new(Ctx { brise: brise.clone(), network: network.clone(), connections: Some(connections.clone()), settings, public: false, gateway_port: AtomicU16::new(0) });
    match serve(ctx, ("0.0.0.0", port)).await {
        Ok((bound, _)) => network.lock().unwrap_or_else(|p| p.into_inner()).port = bound,
        Err(error) => {
            let failure = if error.kind() == std::io::ErrorKind::AddrInUse {
                AppError::with(500, "port_in_use", json!({ "port": port }))
            } else {
                AppError::with(500, "server_failed", json!({ "detail": error.to_string() }))
            };
            *app.server_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(failure);
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
        let server_error = self.server_error.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|e| e.body());
        let connection = self.connections.view();
        let files: Vec<Value> = view
            .files
            .iter()
            .map(|f| {
                let mut value = serde_json::to_value(f).unwrap_or_default();
                value["path"] = json!(f.path);
                value
            })
            .collect();
        json!({
            "lang": self.lang,
            "version": env!("CARGO_PKG_VERSION"),
            "network": { "address": network.address, "port": network.port, "interfaces": network.interfaces, "hostname": hostname() },
            "connectionMode": connection["mode"],
            "connection": connection,
            "devices": view.devices,
            "files": files,
            "notes": view.notes,
            "transfers": view.transfers,
            "pairCode": view.pair_code,
            "expiresAt": view.expires_at,
            "pairUrl": if server_error.is_some() { None } else { self.pair_url() },
            "receiveDir": self.brise.receive_dir,
            "maxFileSize": self.brise.max_file_size,
            "serverError": server_error,
            "wallpaper": self.wallpaper(),
            "autostart": autostart_enabled(),
        })
    }

    pub fn wallpaper(&self) -> Value {
        let mut view = self.settings.view();
        view["customPath"] = json!(self.settings.custom_path());
        view
    }

    pub async fn shutdown(&self) {
        self.brise.cancel_all();
        self.connections.close().await;
        let _ = std::fs::remove_dir_all(&self.lock);
    }

    fn share(&self, handle: &AppHandle, paths: &[PathBuf]) -> Result<usize, AppError> {
        let added = self.brise.share_paths(paths)?;
        let scope = handle.asset_protocol_scope();
        for path in &added {
            let _ = scope.allow_file(path);
        }
        Ok(added.len())
    }
}

type Shared<'a> = State<'a, Arc<App>>;
type Reply<T> = Result<T, AppError>;

#[tauri::command]
fn get_state(app: Shared<'_>) -> Value {
    app.state()
}

#[tauri::command]
fn qr(app: Shared<'_>) -> Reply<String> {
    app.pair_url().map(|url| qr_svg(&url)).ok_or_else(|| AppError::new(409, "no_address"))
}

#[tauri::command]
fn wifi_qr(app: Shared<'_>) -> Reply<String> {
    app.connections.hotspot().map(|h| qr_svg(&wifi_payload(&h.ssid, &h.password))).ok_or_else(|| AppError::new(409, "hotspot_inactive"))
}

#[tauri::command]
fn decide(app: Shared<'_>, id: String, approve: bool) -> Reply<()> {
    app.brise.decide(&id, approve)
}

#[tauri::command]
fn rotate(app: Shared<'_>) {
    app.brise.rotate();
}

#[tauri::command]
fn set_address(app: Shared<'_>, address: String) -> Reply<()> {
    if app.connections.mode() != connections::Mode::Local || app.connections.busy_switching() {
        return Err(AppError::new(409, "manual_local_only"));
    }
    let address = address.trim().to_string();
    if !valid_address(&address) {
        return Err(AppError::new(400, "invalid_address"));
    }
    app.network.lock().unwrap_or_else(|p| p.into_inner()).set_manual(address);
    app.brise.rotate();
    Ok(())
}

#[tauri::command]
async fn select_mode(app: Shared<'_>, mode: String, interface: Option<String>, confirm_wifi_change: Option<bool>) -> Reply<Value> {
    app.connections.select(&mode, interface, confirm_wifi_change.unwrap_or(false))
}

#[tauri::command]
async fn probe_modes(app: Shared<'_>) -> Reply<Value> {
    Ok(app.connections.probe().await)
}

#[tauri::command]
async fn pick_files(handle: AppHandle, app: Shared<'_>) -> Reply<usize> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.dialog().file().set_title(tr(app.lang, "pick_title")).pick_files(move |files| {
        let _ = tx.send(files);
    });
    let Some(files) = rx.await.ok().flatten() else { return Ok(0) };
    let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    app.share(&handle, &paths)
}

#[tauri::command]
fn set_wallpaper(app: Shared<'_>, id: String) -> Reply<()> {
    app.settings.set_wallpaper(&id)?;
    app.brise.notify();
    Ok(())
}

#[tauri::command]
async fn pick_wallpaper(handle: AppHandle, app: Shared<'_>) -> Reply<bool> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle
        .dialog()
        .file()
        .set_title(tr(app.lang, "pick_wallpaper_title"))
        .add_filter(tr(app.lang, "pick_wallpaper_filter"), &["jpg", "jpeg", "png", "webp"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.ok().flatten() else { return Ok(false) };
    let source = file.into_path().map_err(|_| AppError::new(400, "wallpaper_invalid"))?;
    let settings = app.settings.clone();
    let target = tauri::async_runtime::spawn_blocking(move || settings.install_custom(&source)).await.map_err(|_| AppError::new(500, "unexpected"))??;
    let _ = handle.asset_protocol_scope().allow_file(&target);
    app.brise.notify();
    Ok(true)
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Reply<bool> {
    set_autostart(enabled)?;
    Ok(autostart_enabled())
}

#[tauri::command]
fn remove_wallpaper(app: Shared<'_>) -> Reply<()> {
    app.settings.remove_custom()?;
    app.brise.notify();
    Ok(())
}

#[tauri::command]
fn share_text(app: Shared<'_>, text: String) -> Reply<Value> {
    Ok(serde_json::to_value(app.brise.share_text(&text)?).unwrap_or_default())
}

#[tauri::command]
fn remove_note(app: Shared<'_>, id: String) -> Reply<()> {
    app.brise.remove_note(&id)
}

#[tauri::command]
fn remove_shared(app: Shared<'_>, id: String) -> Reply<()> {
    app.brise.remove_shared(&id)
}

#[tauri::command]
fn open_folder(handle: AppHandle, app: Shared<'_>) -> Reply<()> {
    handle.opener().open_path(app.brise.receive_dir.to_string_lossy(), None::<&str>).map_err(|_| AppError::new(500, "file_manager"))
}

fn existing_file(app: &App, id: &str) -> Reply<PathBuf> {
    let file = app.brise.file(id).ok_or_else(|| AppError::new(404, "file_missing"))?;
    if !file.path.exists() {
        return Err(AppError::new(404, "file_missing"));
    }
    Ok(file.path)
}

#[tauri::command]
fn reveal_file(handle: AppHandle, app: Shared<'_>, id: String) -> Reply<()> {
    let path = existing_file(&app, &id)?;
    handle.opener().reveal_item_in_dir(&path).map_err(|_| AppError::new(500, "file_manager"))
}

#[tauri::command]
fn open_file(handle: AppHandle, app: Shared<'_>, id: String) -> Reply<()> {
    let path = existing_file(&app, &id)?;
    handle.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|_| AppError::new(500, "file_open"))
}

#[tauri::command]
async fn quit(handle: AppHandle, app: Shared<'_>) -> Reply<()> {
    app.shutdown().await;
    handle.exit(0);
    Ok(())
}

/// Lit une ligne de commande : `--hidden` et des chemins de fichiers à partager.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&std::path::Path>) -> (bool, Vec<PathBuf>) {
    let mut hidden = false;
    let mut paths = Vec::new();
    for arg in args {
        if arg == "--hidden" {
            hidden = true;
        } else if arg.starts_with("--") {
            continue;
        } else {
            let path = if let Some(stripped) = arg.strip_prefix("file://") { PathBuf::from(percent_encoding::percent_decode_str(stripped).decode_utf8_lossy().as_ref()) } else { PathBuf::from(&arg) };
            let path = if path.is_absolute() { path } else { cwd.map(|c| c.join(&path)).unwrap_or(path) };
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    (hidden, paths)
}

fn share_from_args(handle: &AppHandle, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    if let Some(app) = handle.try_state::<Arc<App>>() {
        let outcome = match app.share(handle, paths) {
            Ok(0) => AppError::new(400, "nothing_to_share").body(),
            Ok(count) => json!({ "count": count }),
            Err(error) => error.body(),
        };
        let _ = handle.emit("brise:shared", outcome);
    }
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

fn app_hidden_notice(handle: &AppHandle) {
    if let Some(app) = handle.try_state::<Arc<App>>() {
        app.hidden_once.store(true, Ordering::Relaxed);
    }
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

fn window_focused(handle: &AppHandle) -> bool {
    handle.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false)
}

fn bridge(handle: AppHandle, app: Arc<App>) {
    let mut changes = app.brise.subscribe();
    let emitter = handle.clone();
    tauri::async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            let _ = emitter.emit("brise:changed", ());
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    });
    let mut events = app.brise.events();
    let lang = app.lang;
    tauri::async_runtime::spawn(async move {
        let mut pending: Vec<String> = Vec::new();
        loop {
            let next = if pending.is_empty() { Some(events.recv().await) } else { tokio::time::timeout(Duration::from_millis(1500), events.recv()).await.ok() };
            match next {
                Some(Ok(Event::PairRequest { name, code })) => {
                    show_window(&handle);
                    let code = format!("{} {}", &code[..3], &code[3..]);
                    notify(&handle, &tr(lang, "pair_title").replace("{name}", &name), &tr(lang, "pair_body").replace("{code}", &code));
                }
                Some(Ok(Event::Received { name })) => pending.push(name),
                Some(Ok(Event::ReceivedText { preview })) => {
                    if !window_focused(&handle) {
                        notify(&handle, tr(lang, "received_text"), &preview);
                    }
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Some(Err(_)) => break,
                None => {
                    if !window_focused(&handle) {
                        if pending.len() == 1 {
                            notify(&handle, tr(lang, "received"), &pending[0]);
                        } else {
                            let body = pending.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
                            notify(&handle, &tr(lang, "received_many").replace("{count}", &pending.len().to_string()), &body);
                        }
                    }
                    pending.clear();
                }
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, argv, cwd| {
            let (hidden, paths) = parse_args(argv.into_iter().skip(1), Some(std::path::Path::new(&cwd)));
            share_from_args(handle, &paths);
            if !hidden || !paths.is_empty() {
                show_window(handle);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![get_state, qr, wifi_qr, decide, rotate, set_address, select_mode, probe_modes, pick_files, remove_shared, share_text, remove_note, open_folder, reveal_file, open_file, set_wallpaper, pick_wallpaper, remove_wallpaper, set_autostart_enabled, quit])
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let (data_dir, receive_dir) = paths();
            let lang = system_lang();
            let (hidden, startup_paths) = parse_args(std::env::args().skip(1), std::env::current_dir().ok().as_deref());
            match tauri::async_runtime::block_on(start(data_dir, receive_dir.clone())) {
                Ok(app) => {
                    let _ = tauri_app.asset_protocol_scope().allow_directory(&receive_dir, true);
                    if let Some(path) = app.settings.custom_path() {
                        let _ = tauri_app.asset_protocol_scope().allow_file(&path);
                    }
                    tauri_app.manage(app.clone());
                    bridge(handle.clone(), app);
                    share_from_args(&handle, &startup_paths);
                    if !hidden || !startup_paths.is_empty() {
                        show_window(&handle);
                    } else {
                        app_hidden_notice(&handle);
                    }
                }
                Err(code) => {
                    let exit = handle.clone();
                    handle.dialog().message(tr(lang, &code)).title(tr(lang, "startup_title")).kind(MessageDialogKind::Error).show(move |_| exit.exit(1));
                    return Ok(());
                }
            }
            let open = MenuItem::with_id(tauri_app, "open", tr(lang, "tray_open"), true, None::<&str>)?;
            let quit = MenuItem::with_id(tauri_app, "quit", tr(lang, "tray_quit"), true, None::<&str>)?;
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
                            notify(handle, tr(app.lang, "still_running_title"), tr(app.lang, "still_running_body"));
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
                        let outcome = match app.share(handle, paths) {
                            Ok(0) => AppError::new(400, "nothing_to_share").body(),
                            Ok(count) => json!({ "count": count }),
                            Err(error) => error.body(),
                        };
                        let _ = handle.emit("brise:shared", outcome);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Brise");
}
