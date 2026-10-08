use crate::connections::{BoxFuture, Connections, Gateway, GatewayFactory};
use crate::core::{AppError, Brise, Device, Direction, CHUNK_SIZE, IDLE_TIMEOUT, MAX_TEXT};
use crate::network::Network;
use crate::settings::Store;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

const PHONE_HTML: &str = include_str!("../../ui/phone.html");
const PHONE_JS: &str = include_str!("../../ui/phone.js");
const PHONE_CSS: &str = include_str!("../../ui/phone.css");
const COMMON_JS: &str = include_str!("../../ui/common.js");
const I18N_JS: &str = include_str!("../../ui/i18n.js");
const STYLES: &str = include_str!("../../ui/styles.css");
const THEME_JS: &str = include_str!("../../ui/theme.js");
const ICON: &str = include_str!("../../ui/icon.svg");
const MANIFEST: &str = include_str!("../../ui/pwa/manifest.webmanifest");
const ICON_180: &[u8] = include_bytes!("../../ui/pwa/icon-180.png");
const ICON_192: &[u8] = include_bytes!("../../ui/pwa/icon-192.png");
const ICON_512: &[u8] = include_bytes!("../../ui/pwa/icon-512.png");
const ICON_MASKABLE: &[u8] = include_bytes!("../../ui/pwa/icon-maskable.png");
const FONT_LATIN: &[u8] = include_bytes!("../../ui/fonts/manrope-latin.woff2");
const FONT_LATIN_EXT: &[u8] = include_bytes!("../../ui/fonts/manrope-latin-ext.woff2");
const WALLPAPER_FILES: &[(&str, &[u8])] = &[
    ("grain.png", include_bytes!("../../ui/wallpapers/grain.png")),
    ("brume-light.svg", include_bytes!("../../ui/wallpapers/brume-light.svg")),
    ("brume-dark.svg", include_bytes!("../../ui/wallpapers/brume-dark.svg")),
    ("dunes-light.svg", include_bytes!("../../ui/wallpapers/dunes-light.svg")),
    ("dunes-dark.svg", include_bytes!("../../ui/wallpapers/dunes-dark.svg")),
    ("maree-light.svg", include_bytes!("../../ui/wallpapers/maree-light.svg")),
    ("maree-dark.svg", include_bytes!("../../ui/wallpapers/maree-dark.svg")),
    ("nuit-light.svg", include_bytes!("../../ui/wallpapers/nuit-light.svg")),
    ("nuit-dark.svg", include_bytes!("../../ui/wallpapers/nuit-dark.svg")),
    ("aurore-light.svg", include_bytes!("../../ui/wallpapers/aurore-light.svg")),
    ("aurore-dark.svg", include_bytes!("../../ui/wallpapers/aurore-dark.svg")),
    ("prairie-light.svg", include_bytes!("../../ui/wallpapers/prairie-light.svg")),
    ("prairie-dark.svg", include_bytes!("../../ui/wallpapers/prairie-dark.svg")),
    ("papier-light.svg", include_bytes!("../../ui/wallpapers/papier-light.svg")),
    ("papier-dark.svg", include_bytes!("../../ui/wallpapers/papier-dark.svg")),
    ("carreaux-light.svg", include_bytes!("../../ui/wallpapers/carreaux-light.svg")),
    ("carreaux-dark.svg", include_bytes!("../../ui/wallpapers/carreaux-dark.svg")),
];

const ATTR: &AsciiSet = &NON_ALPHANUMERIC.remove(b'!').remove(b'#').remove(b'$').remove(b'&').remove(b'+').remove(b'-').remove(b'.').remove(b'^').remove(b'_').remove(b'`').remove(b'|').remove(b'~');

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.body())).into_response()
    }
}

pub struct Ctx {
    pub brise: Arc<Brise>,
    pub network: Arc<Mutex<Network>>,
    pub connections: Option<Arc<Connections>>,
    pub settings: Arc<Store>,
    pub public: bool,
    pub gateway_port: AtomicU16,
}

type Shared = State<Arc<Ctx>>;
type Result<T> = std::result::Result<T, AppError>;

pub fn router(ctx: Arc<Ctx>) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/connect", get(page))
        .route("/phone.js", get(|| async { asset(PHONE_JS, "text/javascript; charset=utf-8") }))
        .route("/common.js", get(|| async { asset(COMMON_JS, "text/javascript; charset=utf-8") }))
        .route("/i18n.js", get(|| async { asset(I18N_JS, "text/javascript; charset=utf-8") }))
        .route("/theme.js", get(|| async { asset(THEME_JS, "text/javascript; charset=utf-8") }))
        .route("/styles.css", get(|| async { asset(STYLES, "text/css; charset=utf-8") }))
        .route("/phone.css", get(|| async { asset(PHONE_CSS, "text/css; charset=utf-8") }))
        .route("/icon.svg", get(|| async { asset(ICON, "image/svg+xml") }))
        .route("/manifest.webmanifest", get(|| async { asset(MANIFEST, "application/manifest+json") }))
        .route("/icon-180.png", get(|| async { png(ICON_180) }))
        .route("/icon-192.png", get(|| async { png(ICON_192) }))
        .route("/icon-512.png", get(|| async { png(ICON_512) }))
        .route("/icon-maskable.png", get(|| async { png(ICON_MASKABLE) }))
        .route("/fonts/manrope-latin.woff2", get(|| async { font(FONT_LATIN) }))
        .route("/fonts/manrope-latin-ext.woff2", get(|| async { font(FONT_LATIN_EXT) }))
        .route("/wallpapers/{name}", get(wallpaper))
        .route("/api/look", get(look))
        .route("/api/pair", post(pair))
        .route("/api/state", get(phone_state))
        .route("/api/uploads", post(begin_upload))
        .route("/api/notes", post(send_note))
        .route("/api/uploads/{id}", get(upload_status).post(append).delete(discard))
        .route("/api/uploads/{id}/finish", post(finish))
        .route("/api/files/{id}", get(download).head(download))
        .fallback(|| async { AppError::new(404, "not_found") })
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

fn asset(content: &'static str, kind: &'static str) -> Response {
    ([(header::CONTENT_TYPE, kind)], content).into_response()
}

fn font(content: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, "font/woff2")], content).into_response()
}

fn png(content: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, "image/png")], content).into_response()
}

async fn page() -> Response {
    asset(PHONE_HTML, "text/html; charset=utf-8")
}

async fn wallpaper(State(ctx): Shared, Path(name): Path<String>) -> Result<Response> {
    let missing = || AppError::new(404, "not_found");
    if name == "custom" {
        let path = ctx.settings.custom_path().ok_or_else(missing)?;
        let bytes = tokio::fs::read(&path).await.map_err(|_| missing())?;
        let kind = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("webp") => "image/webp",
            _ => "image/jpeg",
        };
        return Ok(([(header::CONTENT_TYPE, kind)], bytes).into_response());
    }
    let (_, bytes) = WALLPAPER_FILES.iter().find(|(file, _)| *file == name).ok_or_else(missing)?;
    let kind = if name.ends_with(".png") { "image/png" } else { "image/svg+xml" };
    Ok(([(header::CONTENT_TYPE, kind)], *bytes).into_response())
}

async fn look(State(ctx): Shared) -> Json<Value> {
    Json(ctx.settings.view())
}

fn secure_headers(headers: &mut HeaderMap) {
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

fn check(ctx: &Ctx, req: &Request) -> Result<()> {
    let public_origin = if ctx.public {
        Some(ctx.connections.as_ref().and_then(|c| c.public_origin()).ok_or_else(|| AppError::new(503, "internet_closed"))?)
    } else {
        None
    };
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default().to_string();
    let valid = if ctx.public {
        host == format!("127.0.0.1:{}", ctx.gateway_port.load(Ordering::Relaxed))
    } else {
        ctx.network.lock().unwrap_or_else(|p| p.into_inner()).valid_hosts().contains(&host)
    };
    if !valid {
        return Err(AppError::new(403, "host_refused"));
    }
    let method = req.method();
    if ![Method::GET, Method::HEAD, Method::POST, Method::DELETE].contains(method) {
        return Err(AppError::new(405, "method_refused"));
    }
    if [Method::POST, Method::DELETE].contains(method) {
        let expected = public_origin.unwrap_or_else(|| format!("http://{host}"));
        let marked = req.headers().get("x-brise").is_some_and(|v| v == "1");
        let origin_ok = req.headers().get(header::ORIGIN).is_none_or(|o| o.to_str().is_ok_and(|o| o == expected));
        if !marked || !origin_ok {
            return Err(AppError::new(403, "origin_refused"));
        }
    }
    Ok(())
}

async fn guard(State(ctx): Shared, req: Request, next: Next) -> Response {
    let mut response = match check(&ctx, &req) {
        Ok(()) => next.run(req).await,
        Err(error) => error.into_response(),
    };
    secure_headers(response.headers_mut());
    response
}

fn cookie(headers: &HeaderMap) -> String {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .find_map(|c| c.strip_prefix("brise="))
        .unwrap_or_default()
        .to_string()
}

fn device(ctx: &Ctx, headers: &HeaderMap) -> Result<Device> {
    ctx.brise.authenticate(&cookie(headers))
}

async fn small_json(body: Body) -> Result<Value> {
    let bytes = axum::body::to_bytes(body, 4096).await.map_err(|_| AppError::new(413, "request_too_large"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::new(400, "invalid_request"))
}

async fn pair(State(ctx): Shared, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Body) -> Result<Response> {
    let key = if ctx.public { headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()).unwrap_or("internet").to_string() } else { addr.ip().to_string() };
    ctx.brise.throttle(&key)?;
    let value = small_json(body).await?;
    let code = value["code"].as_str().unwrap_or_default();
    let name = value["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or("Mon téléphone");
    let device = ctx.brise.pair(code, name)?;
    let secure = if ctx.public { "; Secure" } else { "" };
    let cookie = format!("brise={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000{secure}", device.secret);
    Ok((StatusCode::CREATED, [(header::SET_COOKIE, cookie)], Json(json!({ "id": device.id }))).into_response())
}

async fn phone_state(State(ctx): Shared, headers: HeaderMap) -> Result<Json<Value>> {
    let device = device(&ctx, &headers)?;
    let mut state = ctx.brise.phone_state(&device);
    state["connectionMode"] = json!(if ctx.public { "internet".into() } else { ctx.connections.as_ref().map(|c| json!(c.mode())).unwrap_or(json!("local")) });
    state["chunkSize"] = json!(CHUNK_SIZE);
    state["pc"] = json!(crate::network::hostname());
    state["wallpaper"] = ctx.settings.view();
    Ok(Json(state))
}

async fn send_note(State(ctx): Shared, headers: HeaderMap, body: Body) -> Result<Response> {
    let device = device(&ctx, &headers)?;
    let bytes = axum::body::to_bytes(body, MAX_TEXT + 4096).await.map_err(|_| AppError::new(413, "text_too_long"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| AppError::new(400, "invalid_request"))?;
    let note = ctx.brise.receive_text(&device, value["text"].as_str().unwrap_or_default()).await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": note.id }))).into_response())
}

async fn begin_upload(State(ctx): Shared, headers: HeaderMap, body: Body) -> Result<Response> {
    let device = device(&ctx, &headers)?;
    let value = small_json(body).await?;
    let size = value["size"].as_u64().ok_or_else(|| AppError::new(400, "invalid_size"))?;
    let id = ctx.brise.begin_upload(&device, value["name"].as_str().unwrap_or("Fichier"), size)?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "chunkSize": CHUNK_SIZE, "offset": 0 }))).into_response())
}

async fn upload_status(State(ctx): Shared, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>> {
    let device = device(&ctx, &headers)?;
    Ok(Json(ctx.brise.upload_status(&id, &device.id)?))
}

async fn append(State(ctx): Shared, Path(id): Path<String>, headers: HeaderMap, body: Body) -> Result<Json<Value>> {
    let device = device(&ctx, &headers)?;
    let offset = headers
        .get("x-chunk-offset")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| AppError::new(400, "chunk_offset_missing"))?;
    let offset = ctx.brise.append(&id, &device.id, offset, body.into_data_stream(), IDLE_TIMEOUT).await?;
    Ok(Json(json!({ "offset": offset })))
}

async fn discard(State(ctx): Shared, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>> {
    let device = device(&ctx, &headers)?;
    ctx.brise.allowed(&device.id)?;
    ctx.brise.discard_upload(&id, Some(&device.id))?;
    Ok(Json(json!({ "ok": true })))
}

async fn finish(State(ctx): Shared, Path(id): Path<String>, headers: HeaderMap) -> Result<Response> {
    let device = device(&ctx, &headers)?;
    let completion = ctx.brise.start_finish(&id, &device.id)?;
    Ok((StatusCode::ACCEPTED, Json(completion)).into_response())
}

fn range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (first, last) = spec.split_once('-')?;
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(first) || !digits(last) || (first.is_empty() && last.is_empty()) {
        return None;
    }
    let end = size.checked_sub(1)?;
    let (start, end) = if first.is_empty() {
        (size.saturating_sub(last.parse().ok()?), end)
    } else {
        let start: u64 = first.parse().ok()?;
        (start, if last.is_empty() { end } else { last.parse::<u64>().ok()?.min(end) })
    };
    (start <= end && start < size).then_some((start, end))
}

struct DownloadGuard {
    brise: Arc<Brise>,
    id: String,
    file_id: String,
    count: bool,
    sent: u64,
    length: u64,
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        self.brise.end_download(&self.id, &self.file_id, self.count && self.sent >= self.length);
    }
}

async fn download(State(ctx): Shared, method: Method, Path(id): Path<String>, headers: HeaderMap) -> Result<Response> {
    let device = device(&ctx, &headers)?;
    let file = ctx.brise.file_for(&id, &device.id)?;
    let gone = || AppError::new(404, "file_changed");
    let mut handle = tokio::fs::File::open(&file.path).await.map_err(|_| gone())?;
    let meta = handle.metadata().await.map_err(|_| gone())?;
    if !meta.is_file() || (file.direction == Direction::Outgoing && meta.len() != file.size) {
        return Err(gone());
    }
    let size = meta.len();
    let (mut start, mut end, mut status) = (0, size.saturating_sub(1), StatusCode::OK);
    let mut response_headers = HeaderMap::new();
    if let Some(value) = headers.get(header::RANGE) {
        match value.to_str().ok().and_then(|v| range(v, size)) {
            Some((s, e)) => {
                (start, end, status) = (s, e, StatusCode::PARTIAL_CONTENT);
                response_headers.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {s}-{e}/{size}")).unwrap());
            }
            None => {
                let mut response = AppError::new(416, "invalid_range").into_response();
                response.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
                return Ok(response);
            }
        }
    }
    let length = if size == 0 { 0 } else { end - start + 1 };
    let disposition = format!("attachment; filename=\"download\"; filename*=UTF-8''{}", utf8_percent_encode(&file.name, ATTR));
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    response_headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(|_| AppError::new(500, "invalid_filename"))?);
    if method == Method::HEAD || length == 0 {
        return Ok((status, response_headers).into_response());
    }
    handle.seek(SeekFrom::Start(start)).await?;
    let (transfer_id, cancel) = ctx.brise.start_download(&device, &file, length);
    let mut guard = DownloadGuard { brise: ctx.brise.clone(), id: transfer_id, file_id: file.id.clone(), count: status == StatusCode::OK, sent: 0, length };
    let brise = ctx.brise.clone();
    let stream = ReaderStream::with_capacity(handle.take(length), 64 * 1024)
        .map(move |chunk| {
            if let Ok(bytes) = &chunk {
                guard.sent += bytes.len() as u64;
                brise.download_progress(&guard.id, bytes.len() as u64);
            }
            chunk
        })
        .take_until(cancel.cancelled_owned());
    Ok((status, response_headers, Body::from_stream(stream)).into_response())
}

pub async fn serve(ctx: Arc<Ctx>, address: (&str, u16)) -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    let port = listener.local_addr()?.port();
    ctx.gateway_port.store(port, Ordering::Relaxed);
    let app = router(ctx).into_make_service_with_connect_info::<SocketAddr>();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((port, handle))
}

pub fn gateway_factory(brise: Arc<Brise>, network: Arc<Mutex<Network>>, settings: Arc<Store>) -> GatewayFactory {
    Arc::new(move |connections: Arc<Connections>| -> BoxFuture<std::io::Result<Gateway>> {
        let ctx = Arc::new(Ctx { brise: brise.clone(), network: network.clone(), connections: Some(connections), settings: settings.clone(), public: true, gateway_port: AtomicU16::new(0) });
        Box::pin(async move {
            let (port, handle) = serve(ctx, ("127.0.0.1", 0)).await?;
            Ok(Gateway { port, handle })
        })
    })
}
