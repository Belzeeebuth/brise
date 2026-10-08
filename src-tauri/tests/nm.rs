use brise_lib::nm::{parse, settings, Command};
use zbus::zvariant::Value;

fn args(line: &str) -> Vec<String> {
    line.split(' ').map(String::from).collect()
}

#[test]
fn every_nmcli_command_used_by_brise_is_understood() {
    let cases = [
        ("-t -f DEVICE,TYPE device status", Command::DeviceTypes),
        ("-g WIFI-PROPERTIES.AP device show wlan0", Command::CanBeAccessPoint("wlan0")),
        ("-g GENERAL.CON-UUID device show wlan0", Command::ActiveUuid("wlan0")),
        ("-g IP4.ADDRESS device show wlan0", Command::Ipv4Addresses("wlan0")),
        ("-g UUID connection show", Command::ConnectionUuids),
        ("radio wifi", Command::WifiRadio),
        ("radio wifi on", Command::SetWifiRadio(true)),
        ("radio wifi off", Command::SetWifiRadio(false)),
        ("--wait 30 connection up uuid 1234", Command::Up { uuid: "1234", wait: 30 }),
        ("--wait 15 connection delete uuid 1234", Command::Delete("1234")),
    ];
    for (line, expected) in cases {
        let list = args(line);
        assert_eq!(parse(&list).unwrap(), expected, "{line}");
    }
    assert!(parse(&args("device wifi hotspot")).is_err());
    assert!(parse(&args("--wait")).is_err());
}

#[test]
fn a_hotspot_profile_becomes_networkmanager_settings() {
    let line = "--wait 15 connection add type wifi ifname wlan0 con-name Brise-1a2b connection.uuid 0b6f connection.autoconnect no ssid Brise-1a2b 802-11-wireless.mode ap 802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.proto rsn 802-11-wireless-security.psk secret ipv4.method shared ipv6.method disabled";
    let list = args(line);
    let Command::Add(props) = parse(&list).unwrap() else { panic!("add attendu") };
    let values = settings(props).unwrap();
    assert_eq!(values["connection"]["type"], Value::from("802-11-wireless"));
    assert_eq!(values["connection"]["interface-name"], Value::from("wlan0"));
    assert_eq!(values["connection"]["id"], Value::from("Brise-1a2b"));
    assert_eq!(values["connection"]["uuid"], Value::from("0b6f"));
    assert_eq!(values["connection"]["autoconnect"], Value::from(false));
    assert_eq!(values["802-11-wireless"]["ssid"], Value::from(b"Brise-1a2b".to_vec()));
    assert_eq!(values["802-11-wireless"]["mode"], Value::from("ap"));
    assert_eq!(values["802-11-wireless-security"]["proto"], Value::from(vec!["rsn".to_string()]));
    assert_eq!(values["802-11-wireless-security"]["psk"], Value::from("secret"));
    assert_eq!(values["ipv4"]["method"], Value::from("shared"));
    assert_eq!(values["ipv6"]["method"], Value::from("disabled"));
    assert!(settings(&args("type")).is_err());
    assert!(settings(&args("inconnu x")).is_err());
}

/// Compare avec le vrai nmcli sur la machine (lecture seule) :
/// `cargo test --test nm -- --ignored`
#[tokio::test]
#[ignore]
async fn the_dbus_answers_match_the_real_nmcli() {
    let real = |line: &str| {
        let out = std::process::Command::new("nmcli").args(line.split(' ')).env("LC_ALL", "C").output().expect("nmcli");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    for line in ["-t -f DEVICE,TYPE device status", "-g UUID connection show", "radio wifi"] {
        let ours = brise_lib::nm::nmcli(&args(line)).await.unwrap();
        let theirs = real(line);
        if line.contains("DEVICE,TYPE") {
            let wifi = |text: &str| text.lines().filter(|l| l.ends_with(":wifi")).map(String::from).collect::<Vec<_>>();
            assert_eq!(wifi(&ours), wifi(&theirs), "{line}");
        } else {
            let mut a: Vec<_> = ours.lines().collect();
            let mut b: Vec<_> = theirs.lines().collect();
            a.sort();
            b.sort();
            assert_eq!(a, b, "{line}");
        }
    }
    let wifi = real("-t -f DEVICE,TYPE device status").lines().find_map(|l| l.strip_suffix(":wifi").map(String::from));
    if let Some(interface) = wifi {
        for field in ["WIFI-PROPERTIES.AP", "GENERAL.CON-UUID", "IP4.ADDRESS"] {
            let line = format!("-g {field} device show {interface}");
            let ours = brise_lib::nm::nmcli(&args(&line)).await.unwrap();
            let theirs = real(&line).replace(" | ", "\n");
            assert_eq!(ours, theirs, "{line}");
        }
    }
}

/// Crée puis supprime un profil de point d'accès par D-Bus, sans jamais
/// l'activer (la connexion de la machine n'est pas touchée) :
/// `cargo test --test nm -- --ignored`
#[tokio::test]
#[ignore]
async fn a_hotspot_profile_is_added_and_deleted_without_activation() {
    let real = |line: &str| {
        let out = std::process::Command::new("nmcli").args(line.split(' ')).env("LC_ALL", "C").output().expect("nmcli");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let Some(interface) = real("-t -f DEVICE,TYPE device status").lines().find_map(|l| l.strip_suffix(":wifi").map(String::from)) else { return };
    let uuid = uuid::Uuid::new_v4().to_string();
    let add = format!("--wait 15 connection add type wifi ifname {interface} con-name Brise-test connection.uuid {uuid} connection.autoconnect no ssid Brise-test 802-11-wireless.mode ap 802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.proto rsn 802-11-wireless-security.psk motdepasse-test ipv4.method shared ipv6.method disabled");
    brise_lib::nm::nmcli(&args(&add)).await.unwrap();
    assert!(brise_lib::nm::nmcli(&args("-g UUID connection show")).await.unwrap().lines().any(|u| u == uuid));
    let shown = real(&format!("-g 802-11-wireless.mode,802-11-wireless.ssid,802-11-wireless-security.key-mgmt,ipv4.method,ipv6.method,connection.autoconnect,connection.interface-name connection show {uuid}"));
    brise_lib::nm::nmcli(&args(&format!("--wait 15 connection delete uuid {uuid}"))).await.unwrap();
    assert_eq!(shown.lines().collect::<Vec<_>>(), vec!["ap", "Brise-test", "wpa-psk", "shared", "disabled", "no", interface.as_str()]);
    assert!(!real("-g UUID connection show").lines().any(|u| u == uuid), "le profil est supprimé");
}
