use crate::connections::{BoxFuture, Connections, Gateway, GatewayFactory};
use crate::core::{AppError, Brise, Device, Direction, CHUNK_SIZE, IDLE_TIMEOUT};
use crate::network::Network;
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
const COMMON_JS: &str = include_str!("../../ui/common.js");
const STYLES: &str = include_str!("../../ui/styles.css");
const ICON: &str = include_str!("../../ui/icon.svg");

const ATTR: &AsciiSet = &NON_ALPHANUMERIC.remove(b'!').remove(b'#').remove(b'$').remove(b'&').remove(b'+').remove(b'-').remove(b'.').remove(b'^').remove(b'_').remove(b'`').remove(b'|').remove(b'~');

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub struct Ctx {
    pub brise: Arc<Brise>,
    pub network: Arc<Mutex<Network>>,
    pub connections: Option<Arc<Connections>>,
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
        .route("/styles.css", get(|| async { asset(STYLES, "text/css; charset=utf-8") }))
        .route("/icon.svg", get(|| async { asset(ICON, "image/svg+xml") }))
        .route("/api/pair", post(pair))
        .route("/api/state", get(phone_state))
        .route("/api/uploads", post(begin_upload))
        .route("/api/uploads/{id}", get(upload_status).post(append).delete(discard))
        .route("/api/uploads/{id}/finish", post(finish))
        .route("/api/files/{id}", get(download).head(download))
        .fallback(|| async { AppError::new(404, "Page introuvable.") })
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

fn asset(content: &'static str, kind: &'static str) -> Response {
    ([(header::CONTENT_TYPE, kind)], content).into_response()
}

async fn page() -> Response {
    asset(PHONE_HTML, "text/html; charset=utf-8")
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
        Some(ctx.connections.as_ref().and_then(|c| c.public_origin()).ok_or_else(|| AppError::new(503, "Le mode Internet est fermé."))?)
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
        return Err(AppError::new(403, "Adresse de connexion non autorisée."));
    }
    let method = req.method();
    if ![Method::GET, Method::HEAD, Method::POST, Method::DELETE].contains(method) {
        return Err(AppError::new(405, "Méthode non autorisée."));
    }
    if [Method::POST, Method::DELETE].contains(method) {
        let expected = public_origin.unwrap_or_else(|| format!("http://{host}"));
        let marked = req.headers().get("x-brise").is_some_and(|v| v == "1");
        let origin_ok = req.headers().get(header::ORIGIN).is_none_or(|o| o.to_str().is_ok_and(|o| o == expected));
        if !marked || !origin_ok {
            return Err(AppError::new(403, "Origine de la requête non autorisée."));
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
    let bytes = axum::body::to_bytes(body, 4096).await.map_err(|_| AppError::new(413, "Requête trop volumineuse."))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::new(400, "Requête invalide."))
}

async fn pair(State(ctx): Shared, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap, body: Body) -> Result<Response> {
    let key = if ctx.public { headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()).unwrap_or("internet").to_string() } else { addr.ip().to_string() };
    ctx.brise.throttle(&key)?;
    let value = small_json(body).await?;
    let code = value["code"].as_str().unwrap_or_default();
    let name = value["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or("Mon téléphone");
    let device = ctx.brise.pair(code, name)?;
    let secure = if ctx.public { "; Secure" } else { "" };
    let cookie = format!("brise={}; HttpOnly; SameSite=Strict; Path=/{secure}", device.secret);
    Ok((StatusCode::CREATED, [(header::SET_COOKIE, cookie)], Json(json!({ "id": device.id }))).into_response())
}

async fn phone_state(State(ctx): Shared, headers: HeaderMap) -> Result<Json<Value>> {
    let device = device(&ctx, &headers)?;
    let mut state = ctx.brise.phone_state(&device);
    state["connectionMode"] = json!(if ctx.public { "internet".into() } else { ctx.connections.as_ref().map(|c| json!(c.mode())).unwrap_or(json!("local")) });
    state["chunkSize"] = json!(CHUNK_SIZE);
    Ok(Json(state))
}

async fn begin_upload(State(ctx): Shared, headers: HeaderMap, body: Body) -> Result<Response> {
    let device = device(&ctx, &headers)?;
    let value = small_json(body).await?;
    let size = value["size"].as_u64().ok_or_else(|| AppError::new(400, "Taille de fichier invalide (10 Go maximum)."))?;
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
        .ok_or_else(|| AppError::new(400, "Position du bloc manquante."))?;
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
    let gone = || AppError::new(404, "Ce fichier a été modifié, déplacé ou supprimé sur le PC.");
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
                let mut response = AppError::new(416, "Plage de téléchargement invalide.").into_response();
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
    response_headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(|_| AppError::new(500, "Nom de fichier invalide."))?);
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

pub fn gateway_factory(brise: Arc<Brise>, network: Arc<Mutex<Network>>) -> GatewayFactory {
    Arc::new(move |connections: Arc<Connections>| -> BoxFuture<std::io::Result<Gateway>> {
        let ctx = Arc::new(Ctx { brise: brise.clone(), network: network.clone(), connections: Some(connections), public: true, gateway_port: AtomicU16::new(0) });
        Box::pin(async move {
            let (port, handle) = serve(ctx, ("127.0.0.1", 0)).await?;
            Ok(Gateway { port, handle })
        })
    })
}
