use brise_lib::core::{safe_name, Brise, Completion, Direction, Status, CHUNK_SIZE};
use bytes::Bytes;
use futures_util::stream;
use std::sync::Arc;
use std::time::Duration;

type Chunk = Result<Bytes, std::io::Error>;

fn open(dir: &tempfile::TempDir) -> Arc<Brise> {
    Brise::open(dir.path().join("data"), dir.path().join("received")).unwrap()
}

fn body(data: &[u8]) -> impl futures_util::Stream<Item = Chunk> + Unpin {
    stream::iter(vec![Ok(Bytes::copy_from_slice(data))])
}

fn channel() -> (tokio::sync::mpsc::UnboundedSender<Chunk>, std::pin::Pin<Box<dyn futures_util::Stream<Item = Chunk> + Send>>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Chunk>();
    (tx, Box::pin(stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) })))
}

fn phone(brise: &Brise) -> brise_lib::core::Device {
    let (token, _) = brise.pair_token();
    let device = brise.pair(&token, "iPhone de test").unwrap();
    brise.decide(&device.id, true).unwrap();
    device
}

async fn upload(brise: &Arc<Brise>, device: &brise_lib::core::Device, name: &str, data: &[u8]) -> String {
    let id = brise.begin_upload(device, name, data.len() as u64).unwrap();
    let mut offset = 0;
    while offset < data.len() {
        let end = (offset + CHUNK_SIZE as usize).min(data.len());
        brise.append(&id, &device.id, offset as u64, body(&data[offset..end]), Duration::from_secs(5)).await.unwrap();
        offset = end;
    }
    brise.start_finish(&id, &device.id).unwrap();
    for _ in 0..200 {
        if let Some(status) = brise.upload_status(&id, &device.id).unwrap().get("status").and_then(|s| s.as_str()) {
            if status == "done" {
                return id;
            }
            assert_ne!(status, "error");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("upload never finished");
}

#[test]
fn names_are_safe_and_keep_their_extension() {
    assert_eq!(safe_name("..\\..\\hello.txt"), "hello.txt");
    assert_eq!(safe_name("../../été 🌿.txt"), "été 🌿.txt");
    assert_eq!(safe_name("..."), "Fichier");
    assert_eq!(safe_name("a\u{202e}b<c>.txt"), "a_b_c_.txt");
    let long = safe_name(&format!("{}.mov", "Vidéo de vacances 🌿 ".repeat(20)));
    assert!(long.len() <= 180 && long.starts_with("Vidéo de vacances") && long.ends_with(".mov"));
    assert!(safe_name(&"🌿".repeat(200)).len() <= 180);
    let started = std::time::Instant::now();
    safe_name(&"a".repeat(100_000));
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn pairing_requires_approval_and_revocation_closes_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let (token, _) = brise.pair_token();
    assert_eq!(brise.pair("mauvais", "x").unwrap_err().status, 403);
    let device = brise.pair(&token, "Téléphone").unwrap();
    assert_eq!(device.status, Status::Pending);
    assert_eq!(device.code.len(), 6);
    assert_eq!(brise.allowed(&device.id).unwrap_err().status, 403);
    assert_eq!(brise.phone_state(&device)["files"].as_array().unwrap().len(), 0);
    brise.decide(&device.id, true).unwrap();
    assert!(brise.allowed(&device.id).is_ok());
    brise.decide(&device.id, false).unwrap();
    assert_eq!(brise.authenticate(&device.secret).unwrap_err().status, 401);
    brise.rotate();
    assert_eq!(brise.pair(&token, "ancien QR").unwrap_err().status, 403);
}

#[tokio::test]
async fn chunked_uploads_rebuild_the_file_and_never_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let mut data = vec![0xabu8; CHUNK_SIZE as usize];
    data.extend_from_slice(&[0, 1, 254, 255]);
    let first = upload(&brise, &device, "../photo.bin", &data).await;
    let second = upload(&brise, &device, "photo.bin", b"second").await;
    let one = brise.file(&first).unwrap();
    let two = brise.file(&second).unwrap();
    assert_eq!(std::fs::read(&one.path).unwrap(), data);
    assert_eq!(two.disk_name.as_deref(), Some("photo (1).bin"));
    assert_eq!(std::fs::read(&two.path).unwrap(), b"second");
    assert_eq!(std::fs::read_dir(&brise.partial_dir).unwrap().count(), 0);
    assert_eq!(brise.file_for(&first, &device.id).unwrap_err().status, 404);
}

#[tokio::test]
async fn an_interrupted_block_resumes_from_the_last_stored_offset() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let first = vec![1u8; CHUNK_SIZE as usize];
    let second = vec![2u8; 1000];
    let id = brise.begin_upload(&device, "video.mov", (first.len() + second.len()) as u64).unwrap();
    brise.append(&id, &device.id, 0, body(&first), Duration::from_secs(5)).await.unwrap();
    let cut = stream::iter(vec![Ok(Bytes::copy_from_slice(&second[..300])), Err(std::io::Error::other("coupure"))]);
    assert!(brise.append(&id, &device.id, CHUNK_SIZE, cut, Duration::from_secs(5)).await.is_err());
    assert_eq!(brise.upload_status(&id, &device.id).unwrap()["offset"], CHUNK_SIZE);
    assert_eq!(brise.append(&id, &device.id, 0, body(&first), Duration::from_secs(5)).await.unwrap_err().status, 409);
    brise.append(&id, &device.id, CHUNK_SIZE, body(&second), Duration::from_secs(5)).await.unwrap();
    assert_eq!(brise.start_finish(&id, &device.id).unwrap(), Completion::Processing);
    for _ in 0..100 {
        if brise.upload_status(&id, &device.id).unwrap()["status"] == "done" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut expected = first.clone();
    expected.extend_from_slice(&second);
    assert_eq!(std::fs::read(brise.file(&id).unwrap().path).unwrap(), expected);
}

#[tokio::test]
async fn a_new_block_replaces_a_stalled_request() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let id = brise.begin_upload(&device, "stalled.txt", 4).unwrap();
    let (tx, rx) = channel();
    tx.send(Ok(Bytes::from_static(b"ab"))).unwrap();
    let stalled = {
        let brise = brise.clone();
        let (id, device_id) = (id.clone(), device.id.clone());
        tokio::spawn(async move { brise.append(&id, &device_id, 0, rx, Duration::from_secs(30)).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(brise.append(&id, &device.id, 0, body(b"abcd"), Duration::from_secs(5)).await.unwrap(), 4);
    assert!(stalled.await.unwrap().is_err());
    drop(tx);
}

#[tokio::test]
async fn an_idle_block_request_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let id = brise.begin_upload(&device, "idle.txt", 4).unwrap();
    let (_tx, rx) = channel();
    assert_eq!(brise.append(&id, &device.id, 0, rx, Duration::from_millis(100)).await.unwrap_err().status, 408);
    assert_eq!(brise.upload_status(&id, &device.id).unwrap()["offset"], 0);
}

#[tokio::test]
async fn slots_count_only_running_uploads_and_revocation_discards_them() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let shared = dir.path().join("partage.txt");
    std::fs::write(&shared, b"x").unwrap();
    brise.share_paths(std::slice::from_ref(&shared)).unwrap();
    let file = brise.desktop_view().files[0].clone();
    for _ in 0..3 {
        brise.start_download(&device, &file, 1);
    }
    let ids: Vec<String> = (0..3).map(|i| brise.begin_upload(&device, &format!("f{i}"), 10).unwrap()).collect();
    assert_eq!(brise.begin_upload(&device, "extra", 10).unwrap_err().status, 429);
    assert!(brise.busy());
    brise.sweep_with(Duration::ZERO);
    tokio::time::sleep(Duration::from_millis(5)).await;
    brise.sweep_with(Duration::ZERO);
    assert!(brise.desktop_view().transfers.iter().all(|t| t.direction != "download"));
    brise.decide(&device.id, false).unwrap();
    for id in &ids {
        assert!(brise.upload_status(id, &device.id).is_err());
    }
    assert_eq!(std::fs::read_dir(&brise.partial_dir).unwrap().count(), 0);
    assert!(!brise.busy());
}

#[tokio::test]
async fn history_survives_a_restart_but_shares_and_sessions_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let brise = open(&dir);
        let device = phone(&brise);
        let shared = dir.path().join("partage.txt");
        std::fs::write(&shared, b"copie").unwrap();
        assert_eq!(brise.share_paths(&[shared, dir.path().to_path_buf()]).unwrap().len(), 1);
        upload(&brise, &device, "durable.txt", b"conserver").await
    };
    let brise = open(&dir);
    let view = brise.desktop_view();
    assert_eq!(view.files.len(), 1);
    assert_eq!(view.files[0].direction, Direction::Incoming);
    assert_eq!(std::fs::read(brise.file(&id).unwrap().path).unwrap(), b"conserver");
    assert!(view.devices.is_empty());
}

#[tokio::test]
async fn removing_a_share_keeps_the_original_and_never_touches_received_files() {
    let dir = tempfile::tempdir().unwrap();
    let brise = open(&dir);
    let device = phone(&brise);
    let received = upload(&brise, &device, "recu.txt", b"a").await;
    let original = dir.path().join("original.txt");
    std::fs::write(&original, b"b").unwrap();
    brise.share_paths(std::slice::from_ref(&original)).unwrap();
    let shared = brise.desktop_view().files.into_iter().find(|f| f.direction == Direction::Outgoing).unwrap();
    assert_eq!(brise.remove_shared(&received).unwrap_err().status, 404);
    brise.remove_shared(&shared.id).unwrap();
    assert!(original.exists());
    assert!(brise.file(&received).is_some());
    assert_eq!(brise.share_paths(&[dir.path().to_path_buf()]).unwrap_err().status, 400);
}
