use std::path::PathBuf;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let (data_dir, receive_dir) = brise_lib::paths();
    let app = brise_lib::start(data_dir, receive_dir).await.expect("démarrage");
    {
        let mut network = app.network.lock().unwrap();
        network.fixed = Some("127.0.0.1".into());
        network.address = Some("127.0.0.1".into());
    }
    let shared: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    if !shared.is_empty() {
        app.brise.share_paths(&shared).expect("partage");
    }
    if let Ok(text) = std::env::var("BRISE_E2E_TEXT") {
        app.brise.share_text(&text).expect("texte");
    }
    let port = app.network.lock().unwrap().port;
    let (token, _) = app.brise.pair_token();
    println!("{}", serde_json::json!({ "port": port, "pairUrl": format!("http://127.0.0.1:{port}/connect#{token}"), "pairCode": app.brise.pair_code() }));
    loop {
        for device in app.brise.desktop_view().devices {
            if device["status"] == "pending" {
                let _ = app.brise.decide(device["id"].as_str().unwrap_or_default(), true);
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
