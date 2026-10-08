use brise_lib::parse_args;
use brise_lib::settings::{autostart_enabled, set_autostart};

#[test]
fn arguments_give_files_to_share_and_the_hidden_flag() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.jpg");
    std::fs::write(&file, b"x").unwrap();
    std::fs::create_dir(dir.path().join("dossier")).unwrap();
    let args = vec!["--hidden".to_string(), "photo.jpg".into(), "dossier".into(), "absent.txt".into(), "--inconnu".into(), format!("file://{}", file.display())];
    let (hidden, paths) = parse_args(args, Some(dir.path()));
    assert!(hidden);
    assert_eq!(paths, vec![file.clone(), file.clone()], "chemins relatifs résolus, dossiers et absents ignorés, URL file:// acceptée");
    let (hidden, paths) = parse_args(vec![file.to_string_lossy().to_string()], None);
    assert!(!hidden);
    assert_eq!(paths, vec![file]);
}

#[test]
fn autostart_writes_and_removes_a_desktop_entry() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_CONFIG_HOME", dir.path());
    assert!(!autostart_enabled());
    set_autostart(true).unwrap();
    assert!(autostart_enabled());
    let entry = std::fs::read_to_string(dir.path().join("autostart/brise.desktop")).unwrap();
    assert!(entry.contains("--hidden"), "{entry}");
    assert!(entry.starts_with("[Desktop Entry]"));
    set_autostart(false).unwrap();
    set_autostart(false).unwrap();
    assert!(!autostart_enabled());
}
