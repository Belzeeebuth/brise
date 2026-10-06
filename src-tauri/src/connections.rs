use crate::core::{is_id, AppError, Brise};
use crate::network::{interfaces, Iface, Network};
use base64::Engine;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Runner = Arc<dyn Fn(&str, Vec<String>) -> BoxFuture<io::Result<String>> + Send + Sync>;
pub type GatewayFactory = Arc<dyn Fn(Arc<Connections>) -> BoxFuture<io::Result<Gateway>> + Send + Sync>;
pub type InterfaceSource = Arc<dyn Fn() -> Vec<Iface> + Send + Sync>;

pub struct Gateway {
    pub port: u16,
    pub handle: tokio::task::JoinHandle<()>,
}

pub fn system_runner() -> Runner {
    Arc::new(|command: &str, args: Vec<String>| {
        let command = command.to_string();
        Box::pin(async move {
            let output = tokio::time::timeout(Duration::from_secs(45), Command::new(&command).args(&args).env("LC_ALL", "C").stdin(Stdio::null()).output())
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, format!("{command} ne répond pas")))??;
            if !output.status.success() {
                return Err(io::Error::other(String::from_utf8_lossy(&output.stderr).trim().to_string()));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Internet,
    Hotspot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Ready,
    Starting,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    pub uuid: String,
    pub interface: String,
    pub previous: Option<String>,
    pub radio_was_off: bool,
    pub ssid: String,
    pub password: String,
}

struct Tunnel {
    stop: oneshot::Sender<()>,
    done: oneshot::Receiver<()>,
}

struct State {
    mode: Mode,
    phase: Phase,
    message: String,
    internet: Value,
    hotspot_capability: Value,
    hotspot_interfaces: Vec<String>,
    hotspot: Option<Hotspot>,
    public_origin: Option<String>,
    tunnel: Option<Tunnel>,
    gateway: Option<Gateway>,
    job: bool,
    generation: u64,
}

pub struct Connections {
    brise: Arc<Brise>,
    pub network: Arc<Mutex<Network>>,
    run: Runner,
    gateway_factory: Option<GatewayFactory>,
    get_interfaces: InterfaceSource,
    cloudflared: String,
    journal: PathBuf,
    state: Mutex<State>,
}

const NETWORK_ERROR: &str = "Impossible de démarrer le point d’accès. Vérifiez les permissions NetworkManager et la compatibilité de la carte Wi-Fi.";

fn find_origin(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let candidate: String = line[start..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '-')).collect();
    let host = candidate.strip_prefix("https://")?;
    let label = host.strip_suffix(".trycloudflare.com")?;
    (!label.is_empty() && label.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')).then_some(candidate)
}

impl Connections {
    pub fn new(brise: Arc<Brise>, network: Arc<Mutex<Network>>, run: Runner, gateway_factory: Option<GatewayFactory>, get_interfaces: Option<InterfaceSource>) -> Arc<Self> {
        let journal = brise.data_dir.join("hotspot.json");
        Arc::new(Self {
            brise,
            network,
            run,
            gateway_factory,
            get_interfaces: get_interfaces.unwrap_or_else(|| Arc::new(interfaces)),
            cloudflared: std::env::var("BRISE_CLOUDFLARED").unwrap_or_else(|_| "cloudflared".into()),
            journal,
            state: Mutex::new(State {
                mode: Mode::Local,
                phase: Phase::Ready,
                message: String::new(),
                internet: json!({ "available": false, "reason": "Vérification…" }),
                hotspot_capability: json!({ "available": false, "reason": "Vérification…" }),
                hotspot_interfaces: Vec::new(),
                hotspot: None,
                public_origin: None,
                tunnel: None,
                gateway: None,
                job: false,
                generation: 0,
            }),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn net(&self) -> MutexGuard<'_, Network> {
        self.network.lock().unwrap_or_else(|p| p.into_inner())
    }

    async fn run(&self, command: &str, args: &[&str]) -> io::Result<String> {
        (self.run)(command, args.iter().map(|a| a.to_string()).collect()).await
    }

    pub async fn init(self: &Arc<Self>) {
        self.recover_hotspot().await;
        self.probe().await;
    }

    pub async fn probe(&self) -> Value {
        let internet = match self.run(&self.cloudflared, &["--version"]).await {
            Ok(_) => json!({ "available": true }),
            Err(_) => json!({ "available": false, "reason": "cloudflared est requis pour le mode Internet.", "install": "sudo pacman -S cloudflared" }),
        };
        let (hotspot, devices) = match self.run("nmcli", &["-t", "-f", "DEVICE,TYPE", "device", "status"]).await {
            Ok(lines) => {
                let mut devices = Vec::new();
                for line in lines.lines() {
                    let Some(name) = line.strip_suffix(":wifi") else { continue };
                    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
                        continue;
                    }
                    if self.run("nmcli", &["-g", "WIFI-PROPERTIES.AP", "device", "show", name]).await.map(|v| v == "yes").unwrap_or(false) {
                        devices.push(name.to_string());
                    }
                }
                let reason = if devices.is_empty() { "Aucune carte Wi-Fi compatible point d’accès détectée." } else { "" };
                (json!({ "available": !devices.is_empty(), "reason": reason }), devices)
            }
            Err(_) => (json!({ "available": false, "reason": "NetworkManager est inaccessible. Vérifiez qu’il fonctionne dans votre session." }), Vec::new()),
        };
        {
            let mut state = self.state();
            state.internet = internet;
            state.hotspot_capability = hotspot;
            state.hotspot_interfaces = devices;
        }
        self.brise.notify();
        self.view()
    }

    pub fn view(&self) -> Value {
        let state = self.state();
        let mut hotspot = state.hotspot_capability.clone();
        hotspot["interfaces"] = json!(state.hotspot_interfaces);
        json!({
            "mode": state.mode,
            "status": state.phase,
            "message": state.message,
            "capabilities": { "internet": state.internet, "hotspot": hotspot },
            "hotspot": state.hotspot.as_ref().map(|h| json!({ "ssid": h.ssid, "password": h.password, "interface": h.interface })),
            "publicOrigin": state.public_origin,
        })
    }

    pub fn mode(&self) -> Mode {
        self.state().mode
    }

    pub fn hotspot(&self) -> Option<Hotspot> {
        let state = self.state();
        if state.phase == Phase::Ready { state.hotspot.clone() } else { None }
    }

    pub fn origin(&self) -> Option<String> {
        let (mode, phase, public) = {
            let state = self.state();
            (state.mode, state.phase, state.public_origin.clone())
        };
        match (phase, mode) {
            (Phase::Ready, Mode::Internet) => public,
            (Phase::Ready, _) => self.net().origin(),
            _ => None,
        }
    }

    pub fn public_origin(&self) -> Option<String> {
        let state = self.state();
        if state.mode == Mode::Internet && state.phase == Phase::Ready { state.public_origin.clone() } else { None }
    }

    pub fn sync_network(&self) {
        {
            let state = self.state();
            if state.mode != Mode::Local || state.phase != Phase::Ready || state.job {
                return;
            }
        }
        let list = (self.get_interfaces)();
        if self.net().refresh(list) {
            self.brise.rotate();
        }
    }

    pub fn select(self: &Arc<Self>, mode: &str, interface: Option<String>, confirm: bool) -> Result<Value, AppError> {
        let mode = match mode {
            "local" => Mode::Local,
            "internet" => Mode::Internet,
            "hotspot" => Mode::Hotspot,
            _ => return Err(AppError::new(400, "Mode inconnu.")),
        };
        {
            let state = self.state();
            if state.job {
                return Err(AppError::new(409, "Un changement de mode est en cours."));
            }
            if mode == Mode::Hotspot {
                if state.hotspot_capability["available"] != json!(true) {
                    return Err(AppError::new(409, state.hotspot_capability["reason"].as_str().unwrap_or("Point d’accès indisponible.")));
                }
                if !confirm {
                    return Err(AppError::new(409, "Confirmez le remplacement de la connexion Wi-Fi sur la carte choisie."));
                }
                if !interface.as_ref().is_some_and(|i| state.hotspot_interfaces.contains(i)) {
                    return Err(AppError::new(400, "Carte Wi-Fi invalide."));
                }
            }
            if mode == Mode::Internet && state.internet["available"] != json!(true) {
                return Err(AppError::new(409, state.internet["reason"].as_str().unwrap_or("Mode Internet indisponible.")));
            }
        }
        if self.brise.busy() {
            return Err(AppError::new(409, "Attendez la fin des transferts avant de changer de mode."));
        }
        {
            let mut state = self.state();
            state.phase = Phase::Starting;
            state.message.clear();
            state.job = true;
        }
        self.brise.revoke_all();
        let this = self.clone();
        tokio::spawn(async move { this.transition(mode, interface).await });
        Ok(self.view())
    }

    async fn transition(self: &Arc<Self>, mode: Mode, interface: Option<String>) {
        let result = async {
            self.stop_resources().await?;
            {
                let mut state = self.state();
                state.mode = mode;
                state.public_origin = None;
            }
            self.brise.notify();
            match mode {
                Mode::Local => {
                    let list = (self.get_interfaces)();
                    self.net().refresh(list);
                    Ok(())
                }
                Mode::Internet => self.start_tunnel().await,
                Mode::Hotspot => self.start_hotspot(interface.as_deref().unwrap_or_default()).await,
            }
        }
        .await;
        {
            let mut state = self.state();
            match result {
                Ok(()) => state.phase = Phase::Ready,
                Err(message) => {
                    state.phase = Phase::Error;
                    state.message = message;
                }
            }
            state.job = false;
        }
        self.brise.rotate();
    }

    pub fn gateway_port(&self) -> Option<u16> {
        self.state().gateway.as_ref().map(|g| g.port)
    }

    pub fn busy_switching(&self) -> bool {
        self.state().job
    }

    async fn start_tunnel(self: &Arc<Self>) -> Result<(), String> {
        let factory = self.gateway_factory.clone().ok_or_else(|| "Mode Internet indisponible.".to_string())?;
        let gateway = factory(self.clone()).await.map_err(|_| "Impossible d’ouvrir le relais local du tunnel.".to_string())?;
        let port = gateway.port;
        self.state().gateway = Some(gateway);
        let result = self.launch_tunnel(port).await;
        if result.is_err() {
            self.stop_tunnel().await;
        }
        result
    }

    async fn launch_tunnel(self: &Arc<Self>, port: u16) -> Result<(), String> {
        let config = self.brise.data_dir.join("quick-tunnel.yml");
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&config)
            .and_then(|mut f| io::Write::write_all(&mut f, b"{}\n"))
            .map_err(|_| "Impossible de préparer le tunnel.".to_string())?;
        let mut command = Command::new(&self.cloudflared);
        command
            .arg("tunnel")
            .arg("--config")
            .arg(&config)
            .args(["--no-autoupdate", "--loglevel", "info", "--url", &format!("http://127.0.0.1:{port}"), "--http-host-header", &format!("127.0.0.1:{port}"), "--protocol", "http2"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars() {
            if key.starts_with("TUNNEL_") {
                command.env_remove(key);
            }
        }
        let mut child = command.spawn().map_err(|_| "Impossible de lancer cloudflared. Installez-le puis réessayez.".to_string())?;
        let (tx, mut rx) = mpsc::channel::<String>(64);
        if let Some(out) = child.stdout.take() {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(line).await;
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(line).await;
                }
            });
        }
        drop(tx);
        let wait = async {
            let mut origin = None;
            let mut registered = false;
            while let Some(line) = rx.recv().await {
                origin = origin.or_else(|| find_origin(&line));
                registered |= line.contains("Registered tunnel connection");
                if let (Some(origin), true) = (&origin, registered) {
                    return Ok(origin.clone());
                }
            }
            Err("Le tunnel s’est arrêté avant la connexion.".to_string())
        };
        let origin = tokio::time::timeout(Duration::from_secs(45), wait).await.map_err(|_| "Le tunnel n’a pas démarré. Vérifiez la connexion Internet du PC.".to_string())??;
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let generation = {
            let mut state = self.state();
            state.generation += 1;
            state.public_origin = Some(origin);
            state.tunnel = Some(Tunnel { stop: stop_tx, done: done_rx });
            state.generation
        };
        let this = self.clone();
        tokio::spawn(async move {
            let _drain = rx;
            tokio::select! {
                _ = child.wait() => this.tunnel_died(generation).await,
                _ = stop_rx => {
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
                }
            }
            let _ = done_tx.send(());
        });
        Ok(())
    }

    async fn tunnel_died(&self, generation: u64) {
        let gateway = {
            let mut state = self.state();
            if state.generation != generation || state.tunnel.is_none() {
                return;
            }
            state.tunnel = None;
            state.public_origin = None;
            state.phase = Phase::Error;
            state.message = "Le tunnel Internet s’est arrêté. Cliquez sur Réessayer.".into();
            state.gateway.take()
        };
        if let Some(gateway) = gateway {
            gateway.handle.abort();
        }
        self.brise.revoke_all();
    }

    async fn stop_tunnel(&self) {
        let (tunnel, gateway) = {
            let mut state = self.state();
            state.public_origin = None;
            (state.tunnel.take(), state.gateway.take())
        };
        if let Some(tunnel) = tunnel {
            let _ = tunnel.stop.send(());
            let _ = tokio::time::timeout(Duration::from_secs(5), tunnel.done).await;
        }
        if let Some(gateway) = gateway {
            gateway.handle.abort();
        }
    }

    async fn start_hotspot(&self, interface: &str) -> Result<(), String> {
        let previous = self.run("nmcli", &["-g", "GENERAL.CON-UUID", "device", "show", interface]).await.map_err(|_| NETWORK_ERROR.to_string())?;
        let radio = self.run("nmcli", &["radio", "wifi"]).await.map_err(|_| NETWORK_ERROR.to_string())?;
        let mut secret = [0u8; 12];
        rand::rng().fill_bytes(&mut secret);
        let hotspot = Hotspot {
            uuid: uuid::Uuid::new_v4().to_string(),
            interface: interface.to_string(),
            previous: is_id(&previous).then_some(previous),
            radio_was_off: radio == "disabled",
            ssid: format!("Brise-{:04x}", rand::rng().random::<u16>()),
            password: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
        };
        self.state().hotspot = Some(hotspot.clone());
        let journal = serde_json::to_string(&hotspot).unwrap_or_default();
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&self.journal)
            .and_then(|mut f| io::Write::write_all(&mut f, journal.as_bytes()))
            .map_err(|_| NETWORK_ERROR.to_string())?;
        let result: io::Result<String> = async {
            let h = &hotspot;
            self.run(
                "nmcli",
                &[
                    "--wait", "15", "connection", "add", "type", "wifi", "ifname", &h.interface, "con-name", &h.ssid, "connection.uuid", &h.uuid, "connection.autoconnect", "no", "ssid", &h.ssid,
                    "802-11-wireless.mode", "ap", "802-11-wireless-security.key-mgmt", "wpa-psk", "802-11-wireless-security.proto", "rsn", "802-11-wireless-security.psk", &h.password,
                    "ipv4.method", "shared", "ipv6.method", "disabled",
                ],
            )
            .await?;
            if h.radio_was_off {
                self.run("nmcli", &["radio", "wifi", "on"]).await?;
            }
            self.run("nmcli", &["--wait", "30", "connection", "up", "uuid", &h.uuid]).await?;
            let addresses = self.run("nmcli", &["-g", "IP4.ADDRESS", "device", "show", &h.interface]).await?;
            addresses
                .lines()
                .filter_map(|a| a.split('/').next())
                .find(|a| a.parse::<std::net::Ipv4Addr>().is_ok())
                .map(String::from)
                .ok_or_else(|| io::Error::other("Le point d’accès n’a pas obtenu d’adresse IPv4."))
        }
        .await;
        match result {
            Ok(address) => {
                let list = (self.get_interfaces)();
                let mut net = self.net();
                net.interfaces = list;
                net.address = Some(address);
                Ok(())
            }
            Err(_) => {
                let _ = self.stop_hotspot().await;
                Err(NETWORK_ERROR.to_string())
            }
        }
    }

    async fn stop_hotspot(&self) -> Result<(), String> {
        let Some(h) = self.state().hotspot.clone() else { return Ok(()) };
        let failure = |_| "Le point d’accès n’a pas pu être arrêté. Vérifiez NetworkManager puis revenez au mode local.".to_string();
        let profiles = self.run("nmcli", &["-g", "UUID", "connection", "show"]).await.map_err(failure)?;
        if profiles.lines().any(|p| p == h.uuid) {
            self.run("nmcli", &["--wait", "15", "connection", "delete", "uuid", &h.uuid]).await.map_err(failure)?;
        }
        let current = self.run("nmcli", &["-g", "GENERAL.CON-UUID", "device", "show", &h.interface]).await.map_err(failure)?;
        let free = current.is_empty() || current == "--" || current == h.uuid;
        if let (Some(previous), true) = (&h.previous, free) {
            if self.run("nmcli", &["--wait", "30", "connection", "up", "uuid", previous]).await.is_err() {
                self.state().message = "Le point d’accès est arrêté, mais la connexion Wi-Fi précédente n’a pas pu être rétablie. Reconnectez le PC depuis les réglages réseau.".into();
            }
        }
        if h.radio_was_off && free {
            self.run("nmcli", &["radio", "wifi", "off"]).await.map_err(failure)?;
        }
        match std::fs::remove_file(&self.journal) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(failure(error)),
            _ => {}
        }
        self.state().hotspot = None;
        let list = (self.get_interfaces)();
        self.net().refresh(list);
        Ok(())
    }

    async fn recover_hotspot(&self) {
        let Ok(text) = std::fs::read_to_string(&self.journal) else { return };
        let valid = serde_json::from_str::<Hotspot>(&text).ok().filter(|h| is_id(&h.uuid) && !h.interface.is_empty() && h.interface.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')));
        let Some(hotspot) = valid else {
            let _ = std::fs::remove_file(&self.journal);
            return;
        };
        self.state().hotspot = Some(hotspot);
        if let Err(message) = self.stop_hotspot().await {
            let mut state = self.state();
            state.mode = Mode::Hotspot;
            state.phase = Phase::Error;
            state.message = message;
        }
    }

    async fn stop_resources(&self) -> Result<(), String> {
        self.stop_tunnel().await;
        self.stop_hotspot().await
    }

    pub async fn close(&self) {
        for _ in 0..200 {
            if !self.state().job {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if self.stop_resources().await.is_err() {
            eprintln!("Brise : arrêt du point d’accès incomplet ; restauration prévue au prochain lancement.");
        }
    }
}
