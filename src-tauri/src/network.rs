use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Iface {
    pub name: String,
    pub address: String,
}

pub fn interfaces() -> Vec<Iface> {
    let mut list: Vec<Iface> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_link_local() => Some(Iface { name: i.name.clone(), address: ip.to_string() }),
            _ => None,
        })
        .collect();
    list.sort_by_key(|i| !(i.name.starts_with("wl") || i.name.starts_with("en") || i.name.starts_with("eth")));
    list.dedup();
    list
}

#[derive(Clone, Debug, Serialize)]
pub struct Network {
    pub port: u16,
    pub address: Option<String>,
    pub interfaces: Vec<Iface>,
    #[serde(skip)]
    pub manual: bool,
    #[serde(skip)]
    pub fixed: Option<String>,
}

impl Network {
    pub fn new(port: u16, interfaces: Vec<Iface>, fixed: Option<String>) -> Self {
        let address = fixed.clone().or_else(|| interfaces.first().map(|i| i.address.clone()));
        Self { port, address, interfaces, manual: false, fixed }
    }

    pub fn refresh(&mut self, interfaces: Vec<Iface>) -> bool {
        let previous = self.address.clone();
        self.interfaces = interfaces;
        if let Some(fixed) = &self.fixed {
            self.address = Some(fixed.clone());
        } else {
            if !self.interfaces.iter().any(|i| Some(&i.address) == self.address.as_ref()) {
                self.manual = false;
            }
            if !self.manual {
                self.address = self.interfaces.first().map(|i| i.address.clone());
            }
        }
        self.address != previous
    }

    pub fn set_manual(&mut self, address: String) {
        self.address = Some(address);
        self.fixed = None;
        self.manual = true;
    }

    pub fn valid_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = ["localhost", "127.0.0.1"].iter().map(|h| h.to_string()).collect();
        hosts.extend(self.interfaces.iter().map(|i| i.address.clone()));
        hosts.extend(self.address.clone());
        hosts.into_iter().map(|h| format!("{h}:{}", self.port)).collect()
    }

    pub fn origin(&self) -> Option<String> {
        self.address.as_ref().map(|a| format!("http://{a}:{}", self.port))
    }
}

pub fn valid_address(address: &str) -> bool {
    match address.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => !ip.is_loopback() && !ip.is_unspecified() && !ip.is_broadcast(),
        Err(_) => false,
    }
}

pub fn qr_svg(text: &str) -> String {
    match QrCode::with_error_correction_level(text, EcLevel::M) {
        Ok(code) => code.render::<svg::Color>().min_dimensions(240, 240).quiet_zone(true).dark_color(svg::Color("#000000")).light_color(svg::Color("#ffffff")).build(),
        Err(_) => String::new(),
    }
}

pub fn wifi_payload(ssid: &str, password: &str) -> String {
    let escape = |value: &str| {
        value.chars().fold(String::new(), |mut out, c| {
            if matches!(c, '\\' | ';' | ',' | ':' | '"' | '\'') {
                out.push('\\');
            }
            out.push(c);
            out
        })
    };
    format!("WIFI:T:WPA;S:{};P:{};;", escape(ssid), escape(password))
}

pub fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname").map(|h| h.trim().to_string()).unwrap_or_else(|_| "Ce PC".into())
}
