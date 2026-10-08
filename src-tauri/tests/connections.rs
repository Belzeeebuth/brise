use brise_lib::connections::{Connections, Runner};
use brise_lib::core::{Brise, Status};
use brise_lib::network::{Iface, Network};
use brise_lib::server::gateway_factory;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PREVIOUS: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

#[derive(Default)]
struct Fake {
    current: Mutex<Option<String>>,
    profile: Mutex<Option<String>>,
    calls: Mutex<Vec<Vec<String>>>,
    fail_hotspot: bool,
    fail_restore: bool,
    broken: bool,
}

impl Fake {
    fn new(fail_hotspot: bool, fail_restore: bool) -> Arc<Self> {
        Arc::new(Self { current: Mutex::new(Some(PREVIOUS.into())), fail_hotspot, fail_restore, ..Default::default() })
    }
    fn handle(&self, command: &str, args: &[String]) -> std::io::Result<String> {
        self.calls.lock().unwrap().push(args.to_vec());
        if self.broken {
            return Err(std::io::Error::other("absent"));
        }
        let has = |value: &str| args.iter().any(|a| a == value);
        let after = |key: &str| args.iter().position(|a| a == key).map(|i| args[i + 1].clone()).unwrap();
        if command.contains("cloudflared") {
            return Ok("cloudflared test".into());
        }
        if has("DEVICE,TYPE") {
            return Ok("wlan0:wifi\neth0:ethernet".into());
        }
        if has("WIFI-PROPERTIES.AP") {
            return Ok("yes".into());
        }
        if has("GENERAL.CON-UUID") {
            return Ok(self.current.lock().unwrap().clone().unwrap_or_else(|| "--".into()));
        }
        if has("IP4.ADDRESS") {
            return Ok("10.42.0.1/24".into());
        }
        if args[0] == "radio" {
            return Ok(if args.len() == 2 { "enabled".into() } else { String::new() });
        }
        if has("add") {
            *self.profile.lock().unwrap() = Some(after("connection.uuid"));
            return Ok(String::new());
        }
        if has("up") {
            let uuid = after("uuid");
            let profile = self.profile.lock().unwrap().clone();
            if (Some(&uuid) == profile.as_ref() && self.fail_hotspot) || (uuid == PREVIOUS && self.fail_restore) {
                return Err(std::io::Error::other("activation failed"));
            }
            *self.current.lock().unwrap() = Some(uuid);
            return Ok(String::new());
        }
        if has("delete") {
            let mut current = self.current.lock().unwrap();
            if *current == *self.profile.lock().unwrap() {
                *current = None;
            }
            *self.profile.lock().unwrap() = None;
            return Ok(String::new());
        }
        if has("UUID") {
            let profile = self.profile.lock().unwrap().clone();
            return Ok([Some(PREVIOUS.to_string()), profile].into_iter().flatten().collect::<Vec<_>>().join("\n"));
        }
        Err(std::io::Error::other(format!("commande inattendue : {}", args.join(" "))))
    }
    fn called(&self, words: &[&str]) -> bool {
        self.calls.lock().unwrap().iter().any(|call| words.iter().all(|w| call.iter().any(|a| a == w)))
    }
}

fn runner(fake: Arc<Fake>) -> Runner {
    Arc::new(move |command: &str, args: Vec<String>| {
        let fake = fake.clone();
        let command = command.to_string();
        Box::pin(async move { fake.handle(&command, &args) })
    })
}

struct Setup {
    _dir: tempfile::TempDir,
    brise: Arc<Brise>,
    network: Arc<Mutex<Network>>,
    interfaces: Arc<Mutex<Vec<Iface>>>,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let brise = Brise::open(dir.path().join("data"), dir.path().join("received")).unwrap();
    let list = vec![Iface { name: "wlan0".into(), address: "192.168.1.42".into() }];
    let network = Arc::new(Mutex::new(Network::new(53318, list.clone(), None)));
    Setup { _dir: dir, brise, network, interfaces: Arc::new(Mutex::new(list)) }
}

async fn connections(s: &Setup, fake: Arc<Fake>) -> Arc<Connections> {
    let source = s.interfaces.clone();
    let c = Connections::new(s.brise.clone(), s.network.clone(), runner(fake), Some(gateway_factory(s.brise.clone(), s.network.clone(), Arc::new(brise_lib::settings::Store::open(&s.brise.data_dir)))), Some(Arc::new(move || source.lock().unwrap().clone())));
    c.init().await;
    c
}

async fn settle(c: &Connections) {
    for _ in 0..400 {
        if !c.busy_switching() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("le changement de mode ne se termine pas");
}

fn approved(brise: &Brise, name: &str) -> String {
    let (token, _) = brise.pair_token();
    let device = brise.pair(&token, name).unwrap();
    brise.decide(&device.id, true).unwrap();
    device.id
}

fn status(brise: &Brise, id: &str) -> Option<Status> {
    brise.desktop_view().devices.iter().find(|d| d["id"] == id).map(|d| serde_json::from_value(d["status"].clone()).unwrap())
}

#[tokio::test]
async fn hotspot_needs_confirmation_uses_wpa2_and_restores_the_previous_wifi() {
    let s = setup();
    let fake = Fake::new(false, false);
    let c = connections(&s, fake.clone()).await;
    let phone = approved(&s.brise, "Avant");
    let pending = s.brise.pair(&s.brise.pair_token().0, "Hésitant").unwrap();
    assert_eq!(c.select("hotspot", Some("wlan0".into()), false).unwrap_err().status, 409);
    assert_eq!(c.select("hotspot", Some("eth9".into()), true).unwrap_err().status, 400);
    c.select("hotspot", Some("wlan0".into()), true).unwrap();
    settle(&c).await;
    assert_eq!(c.view()["status"], "ready");
    assert_eq!(s.network.lock().unwrap().address.as_deref(), Some("10.42.0.1"));
    assert_eq!(c.origin().as_deref(), Some("http://10.42.0.1:53318"));
    assert_eq!(status(&s.brise, &phone), Some(Status::Approved), "un appareil accepté reste connu après un changement de mode");
    assert_eq!(status(&s.brise, &pending.id), None, "une demande en attente est abandonnée");
    let hotspot = c.hotspot().unwrap();
    assert!(hotspot.password.len() >= 12);
    assert!(fake.called(&["add", "wpa-psk", "rsn", "connection.autoconnect", "no"]));
    c.select("local", None, false).unwrap();
    settle(&c).await;
    assert!(fake.called(&["delete", &hotspot.uuid]));
    assert!(fake.called(&["up", PREVIOUS]));
    assert!(c.hotspot().is_none());
    assert_eq!(s.network.lock().unwrap().address.as_deref(), Some("192.168.1.42"));
}

#[tokio::test]
async fn a_network_chosen_meanwhile_is_kept_and_a_lost_wifi_does_not_block_local_mode() {
    let s = setup();
    let fake = Fake::new(false, false);
    let c = connections(&s, fake.clone()).await;
    c.select("hotspot", Some("wlan0".into()), true).unwrap();
    settle(&c).await;
    *fake.current.lock().unwrap() = Some("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into());
    c.select("local", None, false).unwrap();
    settle(&c).await;
    assert!(!fake.called(&["up", PREVIOUS]));

    let s = setup();
    let c = connections(&s, Fake::new(false, true)).await;
    c.select("hotspot", Some("wlan0".into()), true).unwrap();
    settle(&c).await;
    c.select("local", None, false).unwrap();
    settle(&c).await;
    assert_eq!(c.view()["status"], "ready");
    assert_eq!(c.view()["message"], "wifi_not_restored");
    assert!(!s.brise.data_dir.join("hotspot.json").exists());
}

#[tokio::test]
async fn the_next_launch_cleans_a_hotspot_left_by_a_crash() {
    let s = setup();
    let fake = Fake::new(false, false);
    let first = connections(&s, fake.clone()).await;
    first.select("hotspot", Some("wlan0".into()), true).unwrap();
    settle(&first).await;
    let profile = first.hotspot().unwrap().uuid;
    assert!(s.brise.data_dir.join("hotspot.json").exists());
    let second = connections(&s, fake.clone()).await;
    assert_eq!(second.view()["mode"], "local");
    assert!(second.hotspot().is_none());
    assert!(fake.called(&["delete", &profile]));
    assert!(!s.brise.data_dir.join("hotspot.json").exists());
}

#[tokio::test]
async fn failures_clean_up_and_running_transfers_or_missing_tools_block_changes() {
    let s = setup();
    let fake = Fake::new(true, false);
    let c = connections(&s, fake.clone()).await;
    let (token, _) = s.brise.pair_token();
    let sender = s.brise.pair(&token, "Envoi 2").unwrap();
    s.brise.decide(&sender.id, true).unwrap();
    let upload = s.brise.begin_upload(&sender, "attente.txt", 1).unwrap();
    assert_eq!(c.select("internet", None, false).unwrap_err().status, 409);
    s.brise.discard_upload(&upload, None).unwrap();
    c.select("hotspot", Some("wlan0".into()), true).unwrap();
    settle(&c).await;
    assert_eq!(c.view()["status"], "error");
    assert!(c.hotspot().is_none());
    assert!(fake.called(&["delete"]));

    let s = setup();
    let missing = connections(&s, Arc::new(Fake { broken: true, ..Default::default() })).await;
    assert_eq!(missing.view()["capabilities"]["internet"]["available"], false);
    assert_eq!(missing.view()["capabilities"]["hotspot"]["available"], false);
    assert_eq!(missing.select("internet", None, false).unwrap_err().status, 409);
    assert_eq!(missing.select("hotspot", Some("wlan0".into()), true).unwrap_err().status, 409);
}

#[tokio::test]
async fn local_mode_follows_network_changes_and_keeps_manual_or_fixed_addresses() {
    let s = setup();
    let c = connections(&s, Fake::new(false, false)).await;
    let (token, _) = s.brise.pair_token();
    *s.interfaces.lock().unwrap() = vec![Iface { name: "wlan0".into(), address: "10.0.0.7".into() }];
    c.sync_network();
    assert_eq!(c.origin().as_deref(), Some("http://10.0.0.7:53318"));
    assert_ne!(s.brise.pair_token().0, token);
    let hosts = s.network.lock().unwrap().valid_hosts();
    assert!(hosts.contains(&"10.0.0.7:53318".to_string()) && !hosts.contains(&"192.168.1.42:53318".to_string()));

    *s.interfaces.lock().unwrap() = vec![Iface { name: "wlan0".into(), address: "10.0.0.7".into() }, Iface { name: "tun0".into(), address: "172.16.0.2".into() }];
    s.network.lock().unwrap().set_manual("172.16.0.2".into());
    c.sync_network();
    assert_eq!(s.network.lock().unwrap().address.as_deref(), Some("172.16.0.2"));
    *s.interfaces.lock().unwrap() = vec![Iface { name: "wlan0".into(), address: "10.0.0.7".into() }];
    c.sync_network();
    assert_eq!(s.network.lock().unwrap().address.as_deref(), Some("10.0.0.7"));

    let mut fixed = Network::new(53318, vec![], Some("203.0.113.5".into()));
    fixed.address = Some("10.42.0.1".into());
    fixed.refresh(vec![Iface { name: "wlan0".into(), address: "10.0.0.7".into() }]);
    assert_eq!(fixed.address.as_deref(), Some("203.0.113.5"));
}

async fn raw(port: u16, request: String) -> String {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response)).await;
    String::from_utf8_lossy(&response).to_string()
}

#[tokio::test]
async fn internet_mode_exposes_only_phone_routes_and_a_dead_tunnel_closes_everything() {
    let s = setup();
    let script = s.brise.data_dir.join("fake-cloudflared");
    std::fs::write(&script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo test; exit 0; fi\necho 'INF |  https://example-tunnel.trycloudflare.com  |' >&2\necho 'INF Registered tunnel connection connIndex=0' >&2\nsleep 2\nexit 1\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("BRISE_CLOUDFLARED", &script);
    let c = connections(&s, Fake::new(false, false)).await;
    let before = approved(&s.brise, "Avant");
    c.select("internet", None, false).unwrap();
    settle(&c).await;
    assert_eq!(c.origin().as_deref(), Some("https://example-tunnel.trycloudflare.com"));
    assert_eq!(status(&s.brise, &before), Some(Status::Approved));

    let origin = "https://example-tunnel.trycloudflare.com";
    let port = c.gateway_port().unwrap();
    let (token, _) = s.brise.pair_token();
    let body = serde_json::json!({ "code": token, "name": "Internet" }).to_string();
    let pair = raw(port, format!("POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nX-Brise: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).await;
    assert!(pair.starts_with("HTTP/1.1 201"), "{pair}");
    assert!(pair.to_lowercase().contains("; secure"));
    let forged = raw(port, format!("POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nX-Brise: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}")).await;
    assert!(forged.starts_with("HTTP/1.1 403"));
    let spoofed = raw(port, "GET /api/state HTTP/1.1\r\nHost: 192.168.1.42:53318\r\nConnection: close\r\n\r\n".to_string()).await;
    assert!(spoofed.starts_with("HTTP/1.1 403"));

    for _ in 0..400 {
        if c.view()["status"] == "error" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(c.view()["status"], "error");
    assert!(c.origin().is_none());
    let devices = s.brise.desktop_view().devices;
    assert_eq!(devices.len(), 1, "l’appareil accepté reste connu, la demande en attente du tunnel est abandonnée");
    assert_eq!(devices[0]["name"], "Avant");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let closed = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
    assert!(closed.is_err() || raw(port, format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")).await.contains("503"));
}

#[tokio::test]
async fn switching_modes_from_a_plain_thread_does_not_panic() {
    let s = setup();
    let c = connections(&s, Fake::new(false, false)).await;
    let from_ui = c.clone();
    let outcome = std::thread::spawn(move || from_ui.select("hotspot", Some("wlan0".into()), true).map(|_| ())).join();
    assert!(matches!(outcome, Ok(Ok(()))), "le changement de mode a paniqué hors du runtime");
    settle(&c).await;
    assert_eq!(c.view()["mode"], "hotspot");
    assert_eq!(c.view()["status"], "ready");
}
