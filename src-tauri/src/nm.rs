//! Client NetworkManager par D-Bus.
//!
//! Il répond aux quelques commandes nmcli dont `connections.rs` a besoin, avec
//! la même sortie que `nmcli` : Brise n'a ainsi besoin ni de nmcli, ni de sortir
//! du bac à sable Flatpak (seul l'accès au bus système de NetworkManager est
//! demandé).
use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};
use zbus::proxy::{Builder, CacheProperties};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, Proxy};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const SETTINGS_PATH: &str = "/org/freedesktop/NetworkManager/Settings";
const DEVICE_WIFI: u32 = 2;
const DEVICE_ETHERNET: u32 = 1;
const DEVICE_LOOPBACK: u32 = 32;
const WIFI_CAP_AP: u32 = 0x40;
const STATE_ACTIVATED: u32 = 2;
const STATE_DEACTIVATED: u32 = 4;

/// Commande nmcli reconnue, après lecture des options.
#[derive(Debug, PartialEq, Eq)]
pub enum Command<'a> {
    DeviceTypes,
    CanBeAccessPoint(&'a str),
    ActiveUuid(&'a str),
    Ipv4Addresses(&'a str),
    ConnectionUuids,
    WifiRadio,
    SetWifiRadio(bool),
    Up { uuid: &'a str, wait: u64 },
    Delete(&'a str),
    Add(&'a [String]),
}

pub fn parse(args: &[String]) -> io::Result<Command<'_>> {
    let mut i = 0;
    let mut wait = 30;
    let mut field: Option<&str> = None;
    while i < args.len() {
        match args[i].as_str() {
            "--wait" => {
                wait = args.get(i + 1).and_then(|w| w.parse().ok()).ok_or_else(|| unsupported(args))?;
                i += 2;
            }
            "-t" => i += 1,
            "-f" | "-g" => {
                field = Some(args.get(i + 1).ok_or_else(|| unsupported(args))?.as_str());
                i += 2;
            }
            _ => break,
        }
    }
    let rest: Vec<&str> = args[i..].iter().map(String::as_str).collect();
    let command = match (field, rest.as_slice()) {
        (Some("DEVICE,TYPE"), ["device", "status"]) => Command::DeviceTypes,
        (Some("WIFI-PROPERTIES.AP"), ["device", "show", _]) => Command::CanBeAccessPoint(&args[i + 2]),
        (Some("GENERAL.CON-UUID"), ["device", "show", _]) => Command::ActiveUuid(&args[i + 2]),
        (Some("IP4.ADDRESS"), ["device", "show", _]) => Command::Ipv4Addresses(&args[i + 2]),
        (Some("UUID"), ["connection", "show"]) => Command::ConnectionUuids,
        (None, ["radio", "wifi"]) => Command::WifiRadio,
        (None, ["radio", "wifi", "on"]) => Command::SetWifiRadio(true),
        (None, ["radio", "wifi", "off"]) => Command::SetWifiRadio(false),
        (None, ["connection", "up", "uuid", _]) => Command::Up { uuid: &args[i + 3], wait },
        (None, ["connection", "delete", "uuid", _]) => Command::Delete(&args[i + 3]),
        (None, ["connection", "add", ..]) => Command::Add(&args[i + 2..]),
        _ => return Err(unsupported(args)),
    };
    Ok(command)
}

fn unsupported(args: &[String]) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, format!("nmcli {} : commande non prise en charge", args.join(" ")))
}

fn fail(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

/// Réglages D-Bus (a{sa{sv}}) d'un profil décrit comme pour `nmcli connection add`.
pub fn settings(props: &[String]) -> io::Result<HashMap<String, HashMap<String, Value<'static>>>> {
    if props.len() % 2 != 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "nmcli connection add : valeur manquante"));
    }
    let mut out: HashMap<String, HashMap<String, Value<'static>>> = HashMap::new();
    let mut put = |section: &str, key: &str, value: Value<'static>| {
        out.entry(section.to_string()).or_default().insert(key.to_string(), value);
    };
    for pair in props.chunks(2) {
        let (key, value) = (pair[0].as_str(), pair[1].as_str());
        match key {
            "type" => put("connection", "type", Value::from(if value == "wifi" { "802-11-wireless".to_string() } else { value.to_string() })),
            "ifname" => put("connection", "interface-name", Value::from(value.to_string())),
            "con-name" => put("connection", "id", Value::from(value.to_string())),
            "ssid" => put("802-11-wireless", "ssid", Value::from(value.as_bytes().to_vec())),
            _ => {
                let (section, name) = key.split_once('.').ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("réglage inconnu : {key}")))?;
                let value = match name {
                    "autoconnect" => Value::from(value == "yes"),
                    "proto" => Value::from(value.split(',').map(String::from).collect::<Vec<_>>()),
                    "ssid" => Value::from(value.as_bytes().to_vec()),
                    _ => Value::from(value.to_string()),
                };
                put(section, name, value);
            }
        }
    }
    Ok(out)
}

async fn bus() -> io::Result<Connection> {
    static BUS: tokio::sync::OnceCell<Connection> = tokio::sync::OnceCell::const_new();
    BUS.get_or_try_init(|| async { Connection::system().await.map_err(fail) }).await.cloned()
}

async fn proxy(bus: &Connection, path: ObjectPath<'static>, interface: &'static str) -> io::Result<Proxy<'static>> {
    Builder::new(bus)
        .destination(NM)
        .and_then(|b| b.path(path))
        .and_then(|b| b.interface(interface))
        .map_err(fail)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(fail)
}

async fn manager(bus: &Connection) -> io::Result<Proxy<'static>> {
    proxy(bus, ObjectPath::from_static_str_unchecked(NM_PATH), "org.freedesktop.NetworkManager").await
}

async fn device(bus: &Connection, interface: &str) -> io::Result<ObjectPath<'static>> {
    let path: OwnedObjectPath = manager(bus).await?.call("GetDeviceByIpIface", &(interface,)).await.map_err(fail)?;
    Ok(path.into_inner())
}

async fn connection_by_uuid(bus: &Connection, uuid: &str) -> io::Result<ObjectPath<'static>> {
    let settings = proxy(bus, ObjectPath::from_static_str_unchecked(SETTINGS_PATH), "org.freedesktop.NetworkManager.Settings").await?;
    let path: OwnedObjectPath = settings.call("GetConnectionByUuid", &(uuid,)).await.map_err(fail)?;
    Ok(path.into_inner())
}

fn is_root(path: &ObjectPath<'_>) -> bool {
    path.as_str() == "/"
}

async fn device_types(bus: &Connection) -> io::Result<String> {
    let devices: Vec<OwnedObjectPath> = manager(bus).await?.call("GetDevices", &()).await.map_err(fail)?;
    let mut lines = Vec::new();
    for path in devices {
        let device = proxy(bus, path.into_inner(), "org.freedesktop.NetworkManager.Device").await?;
        let name: String = device.get_property("Interface").await.map_err(fail)?;
        let kind = match device.get_property::<u32>("DeviceType").await.map_err(fail)? {
            DEVICE_WIFI => "wifi",
            DEVICE_ETHERNET => "ethernet",
            DEVICE_LOOPBACK => "loopback",
            _ => "other",
        };
        lines.push(format!("{name}:{kind}"));
    }
    Ok(lines.join("\n"))
}

async fn can_be_access_point(bus: &Connection, interface: &str) -> io::Result<String> {
    let wifi = proxy(bus, device(bus, interface).await?, "org.freedesktop.NetworkManager.Device.Wireless").await?;
    let capabilities: u32 = wifi.get_property("WirelessCapabilities").await.map_err(fail)?;
    Ok(if capabilities & WIFI_CAP_AP != 0 { "yes" } else { "no" }.into())
}

async fn active_uuid(bus: &Connection, interface: &str) -> io::Result<String> {
    let device = proxy(bus, device(bus, interface).await?, "org.freedesktop.NetworkManager.Device").await?;
    let active: OwnedObjectPath = device.get_property("ActiveConnection").await.map_err(fail)?;
    if is_root(&active) {
        return Ok(String::new());
    }
    let active = proxy(bus, active.into_inner(), "org.freedesktop.NetworkManager.Connection.Active").await?;
    active.get_property::<String>("Uuid").await.map_err(fail)
}

async fn ipv4_addresses(bus: &Connection, interface: &str) -> io::Result<String> {
    let device = proxy(bus, device(bus, interface).await?, "org.freedesktop.NetworkManager.Device").await?;
    let config: OwnedObjectPath = device.get_property("Ip4Config").await.map_err(fail)?;
    if is_root(&config) {
        return Ok(String::new());
    }
    let config = proxy(bus, config.into_inner(), "org.freedesktop.NetworkManager.IP4Config").await?;
    let data: Vec<HashMap<String, OwnedValue>> = config.get_property("AddressData").await.map_err(fail)?;
    let lines: Vec<String> = data
        .into_iter()
        .filter_map(|entry| {
            let address = entry.get("address").and_then(|v| String::try_from(v.clone()).ok())?;
            let prefix = entry.get("prefix").and_then(|v| u32::try_from(v.clone()).ok()).unwrap_or(32);
            Some(format!("{address}/{prefix}"))
        })
        .collect();
    Ok(lines.join("\n"))
}

async fn connection_uuids(bus: &Connection) -> io::Result<String> {
    let settings = proxy(bus, ObjectPath::from_static_str_unchecked(SETTINGS_PATH), "org.freedesktop.NetworkManager.Settings").await?;
    let paths: Vec<OwnedObjectPath> = settings.call("ListConnections", &()).await.map_err(fail)?;
    let mut uuids = Vec::new();
    for path in paths {
        let connection = proxy(bus, path.into_inner(), "org.freedesktop.NetworkManager.Settings.Connection").await?;
        let values: HashMap<String, HashMap<String, OwnedValue>> = connection.call("GetSettings", &()).await.map_err(fail)?;
        if let Some(uuid) = values.get("connection").and_then(|c| c.get("uuid")).and_then(|v| String::try_from(v.clone()).ok()) {
            uuids.push(uuid);
        }
    }
    Ok(uuids.join("\n"))
}

async fn activate(bus: &Connection, uuid: &str, wait: u64) -> io::Result<String> {
    let connection = connection_by_uuid(bus, uuid).await?;
    let root = ObjectPath::from_static_str_unchecked("/");
    let active: OwnedObjectPath = manager(bus).await?.call("ActivateConnection", &(connection, root.clone(), root)).await.map_err(fail)?;
    let active = proxy(bus, active.into_inner(), "org.freedesktop.NetworkManager.Connection.Active").await?;
    let deadline = Instant::now() + Duration::from_secs(wait.max(1));
    loop {
        match active.get_property::<u32>("State").await {
            Ok(STATE_ACTIVATED) => return Ok(String::new()),
            Ok(STATE_DEACTIVATED) | Err(_) => return Err(io::Error::other(format!("activation de {uuid} échouée"))),
            Ok(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, format!("activation de {uuid} trop longue")));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn delete(bus: &Connection, uuid: &str) -> io::Result<String> {
    let connection = proxy(bus, connection_by_uuid(bus, uuid).await?, "org.freedesktop.NetworkManager.Settings.Connection").await?;
    connection.call::<_, _, ()>("Delete", &()).await.map_err(fail)?;
    Ok(String::new())
}

async fn add(bus: &Connection, props: &[String]) -> io::Result<String> {
    let values = settings(props)?;
    let settings_proxy = proxy(bus, ObjectPath::from_static_str_unchecked(SETTINGS_PATH), "org.freedesktop.NetworkManager.Settings").await?;
    let _: OwnedObjectPath = settings_proxy.call("AddConnection", &(values,)).await.map_err(fail)?;
    Ok(String::new())
}

/// Exécute une commande nmcli par D-Bus et renvoie la sortie qu'aurait donnée nmcli.
pub async fn nmcli(args: &[String]) -> io::Result<String> {
    let command = parse(args)?;
    let bus = bus().await?;
    match command {
        Command::DeviceTypes => device_types(&bus).await,
        Command::CanBeAccessPoint(interface) => can_be_access_point(&bus, interface).await,
        Command::ActiveUuid(interface) => active_uuid(&bus, interface).await,
        Command::Ipv4Addresses(interface) => ipv4_addresses(&bus, interface).await,
        Command::ConnectionUuids => connection_uuids(&bus).await,
        Command::WifiRadio => {
            let enabled: bool = manager(&bus).await?.get_property("WirelessEnabled").await.map_err(fail)?;
            Ok(if enabled { "enabled" } else { "disabled" }.into())
        }
        Command::SetWifiRadio(enabled) => {
            manager(&bus).await?.set_property("WirelessEnabled", enabled).await.map_err(fail)?;
            Ok(String::new())
        }
        Command::Up { uuid, wait } => activate(&bus, uuid, wait).await,
        Command::Delete(uuid) => delete(&bus, uuid).await,
        Command::Add(props) => add(&bus, props).await,
    }
}
