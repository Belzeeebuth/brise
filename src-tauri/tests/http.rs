use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use brise_lib::core::Brise;
use brise_lib::network::{Iface, Network};
use brise_lib::server::{router, Ctx};
use brise_lib::settings::Store;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::AtomicU16;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
    fn cookie(&self) -> String {
        self.headers["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string()
    }
}

const HOST: &str = "192.168.1.42:53318";

fn setup(dir: &tempfile::TempDir) -> (Arc<Brise>, Router) {
    let brise = Brise::open(dir.path().join("data"), dir.path().join("received")).unwrap();
    let network = Network::new(53318, vec![Iface { name: "wlan0".into(), address: "192.168.1.42".into() }], None);
    let settings = Arc::new(Store::open(&brise.data_dir));
    let ctx = Arc::new(Ctx { brise: brise.clone(), network: Arc::new(Mutex::new(network)), connections: None, settings, public: false, gateway_port: AtomicU16::new(0) });
    (brise, router(ctx))
}

async fn send(app: &Router, method: &str, uri: &str, headers: &[(&str, &str)], body: impl Into<Body>) -> Reply {
    let mut builder = Request::builder().method(method).uri(uri).header("host", HOST);
    if method == "POST" || method == "DELETE" {
        builder = builder.header("x-brise", "1").header("origin", format!("http://{HOST}"));
    }
    for (key, value) in headers {
        builder = builder.header(*key, *value);
    }
    let mut request = builder.body(body.into()).unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([192, 168, 1, 10], 50000))));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    Reply { status, headers, body }
}

async fn paired(brise: &Arc<Brise>, app: &Router) -> String {
    let (token, _) = brise.pair_token();
    let pair = send(app, "POST", "/api/pair", &[], json!({ "code": token, "name": "Android" }).to_string()).await;
    assert_eq!(pair.status, StatusCode::CREATED);
    assert!(pair.headers["set-cookie"].to_str().unwrap().contains("HttpOnly; SameSite=Strict"));
    let cookie = pair.cookie();
    assert_eq!(send(app, "GET", "/api/state", &[("cookie", &cookie)], "").await.json()["status"], "pending");
    brise.decide(pair.json()["id"].as_str().unwrap(), true).unwrap();
    cookie
}

#[tokio::test]
async fn the_page_has_strict_headers_and_hostile_requests_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (_, app) = setup(&dir);
    let page = send(&app, "GET", "/connect", &[], "").await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.headers["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert!(String::from_utf8_lossy(&page.body).contains("phone.js"));
    let mut request = Request::builder().uri("/").header("host", "evil.invalid:53318").body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([1, 2, 3, 4], 1))));
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(send(&app, "POST", "/api/pair", &[("origin", "https://evil.invalid")], "{}").await.status, StatusCode::FORBIDDEN);
    assert_eq!(send(&app, "POST", "/api/pair", &[("x-brise", "")], "{}").await.status, StatusCode::FORBIDDEN);
    assert_eq!(send(&app, "GET", "/api/files/00000000-0000-0000-0000-000000000000", &[], "").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, "GET", "/../../src/server.rs", &[], "").await.status, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, "GET", "/api/admin/login", &[], "").await.status, StatusCode::NOT_FOUND);
    for (path, kind) in [("/i18n.js", "text/javascript"), ("/phone.css", "text/css"), ("/fonts/manrope-latin.woff2", "font/woff2"), ("/fonts/manrope-latin-ext.woff2", "font/woff2")] {
        let reply = send(&app, "GET", path, &[], "").await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert!(reply.headers["content-type"].to_str().unwrap().starts_with(kind), "{path}");
    }
    let refused = send(&app, "POST", "/api/pair", &[], json!({ "code": "faux", "name": "x" }).to_string()).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.json(), json!({ "error": "qr_expired" }));
}

#[tokio::test]
async fn a_phone_pairs_uploads_in_blocks_and_downloads_with_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let (brise, app) = setup(&dir);
    let cookie = paired(&brise, &app).await;
    let auth = [("cookie", cookie.as_str())];
    let begin = send(&app, "POST", "/api/uploads", &auth, json!({ "name": "mobile.txt", "size": 7 }).to_string()).await;
    assert_eq!(begin.status, StatusCode::CREATED);
    let id = begin.json()["id"].as_str().unwrap().to_string();
    let path = format!("/api/uploads/{id}");
    assert_eq!(send(&app, "POST", &path, &[auth[0], ("x-chunk-offset", "1")], "bonjour").await.status, StatusCode::CONFLICT);
    assert_eq!(send(&app, "POST", &path, &[auth[0], ("x-chunk-offset", "0")], "bonjour").await.json()["offset"], 7);
    assert_eq!(send(&app, "POST", &format!("{path}/finish"), &auth, "").await.status, StatusCode::ACCEPTED);
    let mut done = Value::Null;
    for _ in 0..100 {
        done = send(&app, "GET", &path, &auth, "").await.json();
        if done["status"] == "done" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(done["result"]["name"], "mobile.txt");
    assert_eq!(std::fs::read(dir.path().join("received/mobile.txt")).unwrap(), b"bonjour");
    assert_eq!(send(&app, "DELETE", &path, &auth, "").await.status, StatusCode::OK);

    let original = dir.path().join("été.txt");
    std::fs::write(&original, b"abcdefghij").unwrap();
    brise.share_paths(std::slice::from_ref(&original)).unwrap();
    let state = send(&app, "GET", "/api/state", &auth, "").await.json();
    assert_eq!(state["files"].as_array().unwrap().len(), 1);
    assert_eq!(state["pc"], json!(brise_lib::network::hostname()));
    assert!(state.get("receiveDir").is_none());
    let file = format!("/api/files/{}", state["files"][0]["id"].as_str().unwrap());
    let full = send(&app, "GET", &file, &auth, "").await;
    assert_eq!(full.body, b"abcdefghij");
    assert!(full.headers["content-disposition"].to_str().unwrap().contains("%C3%A9t%C3%A9.txt"));
    let partial = send(&app, "GET", &file, &[auth[0], ("range", "bytes=2-5")], "").await;
    assert_eq!(partial.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(partial.body, b"cdef");
    assert_eq!(partial.headers["content-range"], "bytes 2-5/10");
    assert_eq!(send(&app, "GET", &file, &[auth[0], ("range", "bytes=-2")], "").await.body, b"ij");
    for range in ["bytes=99-100", "bytes=3-1", "bytes=-", "garbage"] {
        assert_eq!(send(&app, "GET", &file, &[auth[0], ("range", range)], "").await.status, StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(brise.desktop_view().files.iter().find(|f| f.name == "été.txt").unwrap().downloads, 1);
    std::fs::write(&original, b"modifie").unwrap();
    assert_eq!(send(&app, "GET", &file, &auth, "").await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_stalled_download_is_released_by_the_sweep() {
    let dir = tempfile::tempdir().unwrap();
    let (brise, app) = setup(&dir);
    let cookie = paired(&brise, &app).await;
    let original = dir.path().join("big.bin");
    std::fs::write(&original, vec![0u8; 4 * 1024 * 1024]).unwrap();
    brise.share_paths(std::slice::from_ref(&original)).unwrap();
    let id = brise.desktop_view().files[0].id.clone();
    let mut request = Request::builder().uri(format!("/api/files/{id}")).header("host", HOST).header("cookie", &cookie).body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::from(([192, 168, 1, 10], 50000))));
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(brise.desktop_view().transfers.len(), 1);
    tokio::time::sleep(Duration::from_millis(5)).await;
    brise.sweep_with(Duration::ZERO);
    assert!(brise.desktop_view().transfers.is_empty());
    let received = response.into_body().collect().await.map(|b| b.to_bytes().len()).unwrap_or(0);
    assert!(received < 4 * 1024 * 1024);
}

#[tokio::test]
async fn wallpapers_are_served_and_the_look_is_public() {
    let dir = tempfile::tempdir().unwrap();
    let (_brise, app) = setup(&dir);
    let svg = send(&app, "GET", "/wallpapers/brume-dark.svg", &[], "").await;
    assert_eq!(svg.status, StatusCode::OK);
    assert_eq!(svg.headers["content-type"], "image/svg+xml");
    assert!(svg.body.starts_with(b"<svg"));
    let grain = send(&app, "GET", "/wallpapers/grain.png", &[], "").await;
    assert_eq!(grain.headers["content-type"], "image/png");
    assert_eq!(send(&app, "GET", "/wallpapers/custom", &[], "").await.status, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, "GET", "/wallpapers/settings.json", &[], "").await.status, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, "GET", "/theme.js", &[], "").await.headers["content-type"], "text/javascript; charset=utf-8");
    let look = send(&app, "GET", "/api/look", &[], "").await;
    assert_eq!(look.status, StatusCode::OK);
    assert_eq!(look.json()["id"], "brume");
    assert!(look.json()["accent"].is_null());
}
