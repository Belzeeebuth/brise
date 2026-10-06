use base64::Engine;
use futures_util::{Stream, StreamExt};
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

pub const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024 * 1024;
pub const TOKEN_TTL: u64 = 10 * 60 * 1000;
pub const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DEVICES: usize = 12;
const MAX_UPLOADS: usize = 3;
const PAUSE_DELAY: u64 = 30_000;
const UPLOAD_IDLE_LIMIT: u64 = 15 * 60 * 1000;

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppError {
    pub status: u16,
    pub code: String,
    pub params: serde_json::Value,
}

impl AppError {
    pub fn new(status: u16, code: impl Into<String>) -> Self {
        Self { status, code: code.into(), params: serde_json::Value::Null }
    }

    pub fn with(status: u16, code: impl Into<String>, params: serde_json::Value) -> Self {
        Self { status, code: code.into(), params }
    }

    pub fn body(&self) -> serde_json::Value {
        if self.params.is_null() {
            serde_json::json!({ "error": self.code })
        } else {
            serde_json::json!({ "error": self.code, "params": self.params })
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        if error.raw_os_error() == Some(28) {
            return AppError::new(507, "disk_full");
        }
        eprintln!("Brise : {error}");
        AppError::new(500, "unexpected")
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

pub fn token() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

pub fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

pub fn safe_name(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '\u{0}'..='\u{1f}' | '\u{7f}' | '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => '_',
            c => c,
        })
        .collect();
    let mut name = cleaned.trim_start_matches('.').trim().to_string();
    if name.len() > 180 {
        let mut extension = extname(&name).to_string();
        if extension.len() > 24 {
            extension.clear();
        }
        let mut stem = String::new();
        for c in name[..name.len() - extension.len()].chars() {
            if stem.len() + c.len_utf8() + extension.len() > 180 {
                break;
            }
            stem.push(c);
        }
        name = format!("{}{}", stem.trim(), extension).trim_start_matches('.').to_string();
    }
    if name.is_empty() { "Fichier".into() } else { name }
}

pub fn is_id(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Approved,
    Revoked,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub secret: String,
    pub status: Status,
    pub created_at: u64,
    pub last_seen: u64,
    pub code: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Incoming,
    Outgoing,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub direction: Direction,
    pub sender: String,
    pub created_at: u64,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_name: Option<String>,
    #[serde(skip)]
    pub path: PathBuf,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StoredFile {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Completion {
    Processing,
    Done { result: StoredFile },
    Error { error: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferView {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub size: u64,
    pub bytes: u64,
    pub direction: &'static str,
    pub sender: String,
    pub started_at: u64,
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

struct Upload {
    owner_id: String,
    sender: String,
    name: String,
    size: u64,
    bytes: u64,
    receiving: u64,
    path: PathBuf,
    started_at: u64,
    updated_at: u64,
    in_flight: Option<CancellationToken>,
    completion: Option<Completion>,
    cancel: CancellationToken,
}

impl Upload {
    fn paused(&self, now: u64) -> bool {
        self.in_flight.is_none() && self.completion.is_none() && now.saturating_sub(self.updated_at) > PAUSE_DELAY
    }
    fn visible(&self) -> bool {
        matches!(self.completion, None | Some(Completion::Processing))
    }
}

struct Download {
    file_id: String,
    owner_id: String,
    sender: String,
    name: String,
    size: u64,
    bytes: u64,
    started_at: u64,
    last_progress: u64,
    cancel: CancellationToken,
}

#[derive(Clone, Debug)]
pub enum Event {
    PairRequest { name: String, code: String },
    Received { name: String },
}

struct Inner {
    devices: Vec<Device>,
    files: HashMap<String, FileEntry>,
    uploads: HashMap<String, Upload>,
    downloads: HashMap<String, Download>,
    pair_token: String,
    expires_at: u64,
    attempts: HashMap<String, (u32, u64)>,
}

pub struct Brise {
    pub data_dir: PathBuf,
    pub receive_dir: PathBuf,
    pub partial_dir: PathBuf,
    pub max_file_size: u64,
    inner: Mutex<Inner>,
    changed: watch::Sender<u64>,
    events: broadcast::Sender<Event>,
    save_lock: tokio::sync::Mutex<()>,
}

fn private_dir(path: &Path) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)
}

pub struct DesktopView {
    pub devices: Vec<serde_json::Value>,
    pub files: Vec<FileEntry>,
    pub transfers: Vec<TransferView>,
    pub pair_token: String,
    pub expires_at: u64,
}

impl Brise {
    pub fn open(data_dir: PathBuf, receive_dir: PathBuf) -> io::Result<Arc<Self>> {
        let partial_dir = receive_dir.join(".partial");
        for dir in [&data_dir, &receive_dir, &partial_dir] {
            private_dir(dir)?;
        }
        for entry in fs::read_dir(&partial_dir)?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".part") && is_id(&name[..name.len() - 5]) {
                let _ = fs::remove_file(entry.path());
            }
        }
        let mut files = HashMap::new();
        let history_path = data_dir.join("history.json");
        match fs::read_to_string(&history_path) {
            Ok(text) => match serde_json::from_str::<Vec<FileEntry>>(&text) {
                Ok(history) => {
                    for mut file in history {
                        let Some(disk_name) = file.disk_name.clone() else { continue };
                        if file.direction != Direction::Incoming || !is_id(&file.id) || disk_name != safe_name(&disk_name) {
                            continue;
                        }
                        let path = receive_dir.join(&disk_name);
                        if path.is_file() {
                            file.path = path;
                            files.insert(file.id.clone(), file);
                        }
                    }
                }
                Err(_) => {
                    let backup = data_dir.join(format!("history.illisible-{}.json", now()));
                    eprintln!("Brise : historique illisible, conservé dans {}", backup.display());
                    fs::rename(&history_path, backup)?;
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let (changed, _) = watch::channel(0);
        let (events, _) = broadcast::channel(32);
        Ok(Arc::new(Self {
            data_dir,
            receive_dir,
            partial_dir,
            max_file_size: MAX_FILE_SIZE,
            inner: Mutex::new(Inner {
                devices: Vec::new(),
                files,
                uploads: HashMap::new(),
                downloads: HashMap::new(),
                pair_token: token(),
                expires_at: now() + TOKEN_TTL,
                attempts: HashMap::new(),
            }),
            changed,
            events,
            save_lock: tokio::sync::Mutex::new(()),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn notify(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub fn rotate(&self) {
        {
            let mut inner = self.lock();
            inner.pair_token = token();
            inner.expires_at = now() + TOKEN_TTL;
        }
        self.notify();
    }

    pub fn pair_token(&self) -> (String, u64) {
        let inner = self.lock();
        (inner.pair_token.clone(), inner.expires_at)
    }

    pub fn throttle(&self, key: &str) -> Result<()> {
        let now = now();
        let mut inner = self.lock();
        inner.attempts.retain(|_, (_, until)| *until > now);
        let entry = inner.attempts.entry(key.to_string()).or_insert((0, now + 60_000));
        entry.0 += 1;
        if entry.0 > 15 {
            return Err(AppError::new(429, "too_many_attempts"));
        }
        Ok(())
    }

    pub fn pair(&self, code: &str, name: &str) -> Result<Device> {
        let now = now();
        let device = {
            let mut inner = self.lock();
            if !equal(code, &inner.pair_token) || now >= inner.expires_at {
                return Err(AppError::new(403, "qr_expired"));
            }
            inner.devices.retain(|d| match d.status {
                Status::Pending => now.saturating_sub(d.created_at) <= TOKEN_TTL,
                Status::Revoked => now.saturating_sub(d.last_seen) <= 3_600_000,
                Status::Approved => true,
            });
            if inner.devices.iter().filter(|d| d.status != Status::Revoked).count() >= MAX_DEVICES {
                return Err(AppError::new(429, "too_many_devices"));
            }
            let name: String = safe_name(name).chars().take(48).collect();
            let device = Device {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                secret: token(),
                status: Status::Pending,
                created_at: now,
                last_seen: now,
                code: format!("{:06}", rand::rng().random_range(0..1_000_000)),
            };
            inner.devices.push(device.clone());
            device
        };
        self.notify();
        let _ = self.events.send(Event::PairRequest { name: device.name.clone(), code: device.code.clone() });
        Ok(device)
    }

    pub fn decide(&self, id: &str, approve: bool) -> Result<()> {
        let mut temps = Vec::new();
        {
            let mut inner = self.lock();
            let device = inner.devices.iter_mut().find(|d| d.id == id).ok_or_else(|| AppError::new(404, "device_not_found"))?;
            device.status = if approve { Status::Approved } else { Status::Revoked };
            if !approve {
                for download in inner.downloads.values().filter(|d| d.owner_id == id) {
                    download.cancel.cancel();
                }
                inner.downloads.retain(|_, d| d.owner_id != id);
                let ids: Vec<String> = inner.uploads.iter().filter(|(_, u)| u.owner_id == id && u.completion != Some(Completion::Processing)).map(|(k, _)| k.clone()).collect();
                for upload_id in ids {
                    if let Some(upload) = inner.uploads.remove(&upload_id) {
                        upload.cancel.cancel();
                        temps.push(upload.path);
                    }
                }
            }
        }
        for path in temps {
            let _ = fs::remove_file(path);
        }
        self.notify();
        Ok(())
    }

    pub fn revoke_all(&self) {
        let ids: Vec<String> = self.lock().devices.iter().filter(|d| d.status != Status::Revoked).map(|d| d.id.clone()).collect();
        for id in ids {
            let _ = self.decide(&id, false);
        }
        self.rotate();
    }

    pub fn authenticate(&self, secret: &str) -> Result<Device> {
        let mut inner = self.lock();
        let device = inner
            .devices
            .iter_mut()
            .find(|d| equal(&d.secret, secret))
            .filter(|d| d.status != Status::Revoked)
            .ok_or_else(|| AppError::new(401, "session_closed"))?;
        device.last_seen = now();
        Ok(device.clone())
    }

    pub fn allowed(&self, device_id: &str) -> Result<()> {
        let inner = self.lock();
        match inner.devices.iter().find(|d| d.id == device_id) {
            Some(d) if d.status == Status::Approved => Ok(()),
            _ => Err(AppError::new(403, "not_approved")),
        }
    }

    fn transfers(inner: &Inner, owner: Option<&str>) -> Vec<TransferView> {
        let now = now();
        let mut list: Vec<TransferView> = inner
            .uploads
            .iter()
            .filter(|(_, u)| u.visible() && owner.is_none_or(|o| o == u.owner_id))
            .map(|(id, u)| TransferView {
                id: id.clone(),
                owner_id: u.owner_id.clone(),
                name: u.name.clone(),
                size: u.size,
                bytes: (u.bytes + u.receiving).min(u.size),
                direction: "incoming",
                sender: u.sender.clone(),
                started_at: u.started_at,
                paused: u.paused(now),
                file_id: None,
            })
            .chain(inner.downloads.iter().filter(|(_, d)| owner.is_none_or(|o| o == d.owner_id)).map(|(id, d)| TransferView {
                id: id.clone(),
                owner_id: d.owner_id.clone(),
                name: d.name.clone(),
                size: d.size,
                bytes: d.bytes,
                direction: "download",
                sender: d.sender.clone(),
                started_at: d.started_at,
                paused: false,
                file_id: Some(d.file_id.clone()),
            }))
            .collect();
        list.sort_by_key(|t| t.started_at);
        list
    }

    pub fn phone_state(&self, device: &Device) -> serde_json::Value {
        let inner = self.lock();
        let current = inner.devices.iter().find(|d| d.id == device.id);
        let approved = current.is_some_and(|d| d.status == Status::Approved);
        let mut files: Vec<&FileEntry> = if approved { inner.files.values().filter(|f| f.direction == Direction::Outgoing).collect() } else { Vec::new() };
        files.sort_by_key(|f| std::cmp::Reverse(f.created_at));
        let files: Vec<serde_json::Value> = files
            .into_iter()
            .map(|f| serde_json::json!({ "id": f.id, "name": f.name, "size": f.size, "direction": f.direction, "sender": f.sender, "createdAt": f.created_at, "downloads": f.downloads }))
            .collect();
        serde_json::json!({
            "role": "phone",
            "name": device.name,
            "status": current.map(|d| d.status),
            "code": current.map(|d| d.code.clone()),
            "files": files,
            "transfers": if approved { Self::transfers(&inner, Some(&device.id)) } else { Vec::new() },
            "maxFileSize": self.max_file_size,
        })
    }

    pub fn desktop_view(&self) -> DesktopView {
        let inner = self.lock();
        let now = now();
        let devices = inner
            .devices
            .iter()
            .filter(|d| d.status != Status::Revoked)
            .map(|d| {
                let mut value = serde_json::to_value(d).unwrap_or_default();
                value["online"] = serde_json::Value::Bool(now.saturating_sub(d.last_seen) < 15_000);
                value
            })
            .collect();
        let mut files: Vec<FileEntry> = inner.files.values().cloned().collect();
        files.sort_by_key(|f| std::cmp::Reverse(f.created_at));
        DesktopView { devices, files, transfers: Self::transfers(&inner, None), pair_token: inner.pair_token.clone(), expires_at: inner.expires_at }
    }

    pub fn share_paths(&self, paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
        let mut added = Vec::new();
        let mut skipped_dir = false;
        for path in paths {
            let Ok(meta) = fs::metadata(path) else { continue };
            if meta.is_dir() {
                skipped_dir = true;
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let path = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
            let name = safe_name(&path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            let mut inner = self.lock();
            let existing = inner.files.values_mut().find(|f| f.direction == Direction::Outgoing && f.path == path);
            if let Some(file) = existing {
                file.size = meta.len();
                file.created_at = now();
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                let file = FileEntry { id: id.clone(), name, size: meta.len(), direction: Direction::Outgoing, sender: String::new(), created_at: now(), downloads: 0, disk_name: None, path: path.clone() };
                inner.files.insert(id, file);
            }
            drop(inner);
            added.push(path);
        }
        self.notify();
        if skipped_dir && added.is_empty() {
            return Err(AppError::new(400, "only_files"));
        }
        Ok(added)
    }

    pub fn remove_shared(&self, id: &str) -> Result<()> {
        {
            let mut inner = self.lock();
            match inner.files.get(id) {
                Some(f) if f.direction == Direction::Outgoing => {}
                _ => return Err(AppError::new(404, "shared_not_found")),
            }
            inner.files.remove(id);
        }
        self.notify();
        Ok(())
    }

    pub fn file(&self, id: &str) -> Option<FileEntry> {
        self.lock().files.get(id).cloned()
    }

    pub fn file_for(&self, id: &str, device_id: &str) -> Result<FileEntry> {
        self.allowed(device_id)?;
        match self.lock().files.get(id) {
            Some(f) if f.direction == Direction::Outgoing => Ok(f.clone()),
            _ => Err(AppError::new(404, "file_unavailable")),
        }
    }

    pub fn start_download(&self, device: &Device, file: &FileEntry, size: u64) -> (String, CancellationToken) {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let now = now();
        self.lock().downloads.insert(
            id.clone(),
            Download { file_id: file.id.clone(), owner_id: device.id.clone(), sender: device.name.clone(), name: file.name.clone(), size, bytes: 0, started_at: now, last_progress: now, cancel: cancel.clone() },
        );
        self.notify();
        (id, cancel)
    }

    pub fn download_progress(&self, id: &str, bytes: u64) {
        if let Some(d) = self.lock().downloads.get_mut(id) {
            d.bytes += bytes;
            d.last_progress = now();
        }
    }

    pub fn end_download(&self, id: &str, file_id: &str, complete: bool) {
        {
            let mut inner = self.lock();
            inner.downloads.remove(id);
            if complete {
                if let Some(f) = inner.files.get_mut(file_id) {
                    f.downloads += 1;
                }
            }
        }
        self.notify();
    }

    pub fn uploads_running(&self) -> usize {
        let now = now();
        self.lock().uploads.values().filter(|u| u.visible() && !u.paused(now)).count()
    }

    pub fn busy(&self) -> bool {
        let now = now();
        let inner = self.lock();
        !inner.downloads.is_empty() || inner.uploads.values().any(|u| u.visible() && !u.paused(now))
    }

    pub fn begin_upload(&self, device: &Device, name: &str, size: u64) -> Result<String> {
        self.allowed(&device.id)?;
        if size > self.max_file_size {
            return Err(AppError::new(400, "invalid_size"));
        }
        if self.uploads_running() >= MAX_UPLOADS {
            return Err(AppError::new(429, "too_many_uploads"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.partial_dir.join(format!("{id}.part"));
        OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
        let now = now();
        self.lock().uploads.insert(
            id.clone(),
            Upload {
                owner_id: device.id.clone(),
                sender: device.name.clone(),
                name: safe_name(name),
                size,
                bytes: 0,
                receiving: 0,
                path,
                started_at: now,
                updated_at: now,
                in_flight: None,
                completion: None,
                cancel: CancellationToken::new(),
            },
        );
        self.notify();
        Ok(id)
    }

    fn owned<'a>(inner: &'a mut Inner, id: &str, device_id: &str) -> Result<&'a mut Upload> {
        match inner.uploads.get_mut(id) {
            Some(u) if u.owner_id == device_id => Ok(u),
            _ => Err(AppError::new(404, "upload_not_found")),
        }
    }

    pub fn upload_status(&self, id: &str, device_id: &str) -> Result<serde_json::Value> {
        self.allowed(device_id)?;
        let mut inner = self.lock();
        let upload = Self::owned(&mut inner, id, device_id)?;
        Ok(match &upload.completion {
            Some(c) => serde_json::to_value(c).unwrap_or_default(),
            None => serde_json::json!({ "status": "uploading", "offset": upload.bytes }),
        })
    }

    pub async fn append<S, E>(&self, id: &str, device_id: &str, offset: u64, mut body: S, idle: Duration) -> Result<u64>
    where
        S: Stream<Item = std::result::Result<bytes::Bytes, E>> + Unpin,
    {
        self.allowed(device_id)?;
        for _ in 0..500 {
            let previous = {
                let mut inner = self.lock();
                Self::owned(&mut inner, id, device_id)?.in_flight.clone()
            };
            match previous {
                Some(token) => {
                    token.cancel();
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                None => break,
            }
        }
        let (path, expected, token) = {
            let mut inner = self.lock();
            let upload = Self::owned(&mut inner, id, device_id)?;
            if upload.in_flight.is_some() {
                return Err(AppError::new(409, "block_busy"));
            }
            if upload.completion.is_some() {
                return Err(AppError::new(409, "upload_done"));
            }
            if offset != upload.bytes {
                return Err(AppError::new(409, "block_offset"));
            }
            let expected = CHUNK_SIZE.min(upload.size - upload.bytes);
            if expected == 0 {
                return Err(AppError::new(409, "blocks_complete"));
            }
            let token = upload.cancel.child_token();
            upload.in_flight = Some(token.clone());
            upload.receiving = 0;
            (upload.path.clone(), expected, token)
        };
        let result = self.receive_block(id, &path, offset, expected, &token, &mut body, device_id, idle).await;
        {
            let mut inner = self.lock();
            if let Some(upload) = inner.uploads.get_mut(id) {
                if let Ok(total) = result {
                    upload.bytes = total;
                }
                upload.in_flight = None;
                upload.receiving = 0;
                upload.updated_at = now();
            }
        }
        self.notify();
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn receive_block<S, E>(&self, id: &str, path: &Path, offset: u64, expected: u64, token: &CancellationToken, body: &mut S, device_id: &str, idle: Duration) -> Result<u64>
    where
        S: Stream<Item = std::result::Result<bytes::Bytes, E>> + Unpin,
    {
        let mut buffer: Vec<u8> = Vec::with_capacity(expected as usize);
        let mut last_tick = 0u64;
        loop {
            let next = tokio::select! {
                _ = token.cancelled() => return Err(AppError::new(409, "cancelled")),
                next = tokio::time::timeout(idle, body.next()) => next,
            };
            match next {
                Err(_) => return Err(AppError::new(408, "idle")),
                Ok(None) => break,
                Ok(Some(Err(_))) => return Err(AppError::new(400, "block_incomplete")),
                Ok(Some(Ok(chunk))) => {
                    if buffer.len() as u64 + chunk.len() as u64 > expected {
                        return Err(AppError::new(413, "block_too_large"));
                    }
                    buffer.extend_from_slice(&chunk);
                    if let Some(upload) = self.lock().uploads.get_mut(id) {
                        upload.receiving = buffer.len() as u64;
                    }
                    let now = now();
                    if now - last_tick > 250 {
                        last_tick = now;
                        self.notify();
                    }
                }
            }
        }
        if buffer.len() as u64 != expected {
            return Err(AppError::new(400, "block_incomplete"));
        }
        self.allowed(device_id)?;
        if token.is_cancelled() {
            return Err(AppError::new(409, "cancelled"));
        }
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || -> io::Result<()> {
            let file = OpenOptions::new().write(true).open(&path)?;
            file.write_all_at(&buffer, offset)
        })
        .await
        .map_err(|_| AppError::new(500, "write_interrupted"))??;
        Ok(offset + expected)
    }

    pub fn start_finish(self: &Arc<Self>, id: &str, device_id: &str) -> Result<Completion> {
        self.allowed(device_id)?;
        {
            let mut inner = self.lock();
            let upload = Self::owned(&mut inner, id, device_id)?;
            if let Some(completion) = &upload.completion {
                return Ok(completion.clone());
            }
            if upload.in_flight.is_some() || upload.bytes != upload.size {
                return Err(AppError::new(409, "upload_incomplete"));
            }
            upload.completion = Some(Completion::Processing);
        }
        let brise = self.clone();
        let id = id.to_string();
        let device_id = device_id.to_string();
        tokio::spawn(async move {
            let completion = match brise.store(&id, &device_id).await {
                Ok(result) => Completion::Done { result },
                Err(error) if error.status < 500 || error.status == 507 => Completion::Error { error: error.code },
                Err(_) => Completion::Error { error: "finish_failed".into() },
            };
            if let Some(upload) = brise.lock().uploads.get_mut(&id) {
                upload.completion = Some(completion);
                upload.updated_at = now();
            }
            brise.notify();
        });
        self.notify();
        Ok(Completion::Processing)
    }

    async fn store(&self, id: &str, device_id: &str) -> Result<StoredFile> {
        self.allowed(device_id)?;
        let (name, size, temp, sender) = {
            let mut inner = self.lock();
            let u = Self::owned(&mut inner, id, device_id)?;
            (u.name.clone(), u.size, u.path.clone(), u.sender.clone())
        };
        let receive_dir = self.receive_dir.clone();
        let link_name = name.clone();
        let (disk_name, destination) = tokio::task::spawn_blocking(move || place(&temp, &receive_dir, &link_name))
            .await
            .map_err(|_| AppError::new(500, "unexpected"))??;
        let file = FileEntry { id: id.to_string(), name: name.clone(), size, direction: Direction::Incoming, sender, created_at: now(), downloads: 0, disk_name: Some(disk_name), path: destination };
        self.lock().files.insert(id.to_string(), file);
        self.save().await?;
        let _ = self.events.send(Event::Received { name: name.clone() });
        self.notify();
        Ok(StoredFile { id: id.to_string(), name, size })
    }

    pub fn discard_upload(&self, id: &str, device_id: Option<&str>) -> Result<()> {
        let removed = {
            let mut inner = self.lock();
            match inner.uploads.get(id) {
                Some(u) if device_id.is_none_or(|d| d == u.owner_id) => {
                    if u.completion == Some(Completion::Processing) {
                        return Err(AppError::new(409, "upload_finishing"));
                    }
                    inner.uploads.remove(id)
                }
                _ => return Err(AppError::new(404, "upload_not_found")),
            }
        };
        if let Some(upload) = removed {
            upload.cancel.cancel();
            let _ = fs::remove_file(upload.path);
        }
        self.notify();
        Ok(())
    }

    pub fn sweep(&self) {
        self.sweep_with(IDLE_TIMEOUT);
    }

    pub fn sweep_with(&self, idle: Duration) {
        let now = now();
        let mut stale_uploads = Vec::new();
        let mut changed = false;
        {
            let mut inner = self.lock();
            for (id, u) in inner.uploads.iter() {
                if u.in_flight.is_none() && u.completion != Some(Completion::Processing) && now.saturating_sub(u.updated_at) > UPLOAD_IDLE_LIMIT {
                    stale_uploads.push(id.clone());
                }
            }
            let idle = idle.as_millis() as u64;
            let before = inner.downloads.len();
            inner.downloads.retain(|_, d| {
                let alive = now.saturating_sub(d.last_progress) <= idle;
                if !alive {
                    d.cancel.cancel();
                }
                alive
            });
            changed |= inner.downloads.len() != before;
            if now >= inner.expires_at {
                inner.pair_token = token();
                inner.expires_at = now + TOKEN_TTL;
                changed = true;
            }
        }
        for id in stale_uploads {
            let _ = self.discard_upload(&id, None);
        }
        if changed {
            self.notify();
        }
    }

    pub async fn save(&self) -> Result<()> {
        let _guard = self.save_lock.lock().await;
        let snapshot: Vec<FileEntry> = self.lock().files.values().filter(|f| f.direction == Direction::Incoming).cloned().collect();
        let text = serde_json::to_string_pretty(&snapshot).map_err(|_| AppError::new(500, "history_unreadable"))?;
        let data_dir = self.data_dir.clone();
        tokio::task::spawn_blocking(move || -> io::Result<()> {
            let temp = data_dir.join("history.json.tmp");
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true).mode(0o600);
            io::Write::write_all(&mut options.open(&temp)?, text.as_bytes())?;
            fs::rename(temp, data_dir.join("history.json"))
        })
        .await
        .map_err(|_| AppError::new(500, "unexpected"))??;
        Ok(())
    }

    pub fn cancel_all(&self) {
        let inner = self.lock();
        for u in inner.uploads.values() {
            u.cancel.cancel();
        }
        for d in inner.downloads.values() {
            d.cancel.cancel();
        }
    }
}

fn place(temp: &Path, dir: &Path, name: &str) -> io::Result<(String, PathBuf)> {
    let extension = extname(name);
    let stem = &name[..name.len() - extension.len()];
    for n in 0u32.. {
        let disk_name = if n == 0 { name.to_string() } else { format!("{stem} ({n}){extension}") };
        let destination = dir.join(&disk_name);
        match fs::hard_link(temp, &destination) {
            Ok(()) => {
                let _ = fs::remove_file(temp);
                return Ok((disk_name, destination));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) if destination.exists() => continue,
            Err(_) => {
                fs::rename(temp, &destination)?;
                return Ok((disk_name, destination));
            }
        }
    }
    unreachable!()
}
