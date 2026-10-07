use crate::core::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const WALLPAPERS: &[&str] = &["brume", "dunes", "maree", "nuit", "aurore", "prairie", "papier", "carreaux"];
pub const DEFAULT_WALLPAPER: &str = "brume";
const CUSTOM_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Accent {
    pub light: String,
    pub dark: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub wallpaper: String,
    #[serde(default)]
    pub accent: Option<Accent>,
}

/// Réglages persistants (settings.json) et image de fond personnelle.
pub struct Store {
    path: PathBuf,
    data_dir: PathBuf,
    settings: Mutex<Settings>,
}

impl Store {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        let mut settings: Settings = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let store = Store { path, data_dir: data_dir.to_path_buf(), settings: Mutex::new(Settings::default()) };
        if !valid(&settings.wallpaper) || (settings.wallpaper == "custom" && store.custom_path().is_none()) {
            settings.wallpaper = DEFAULT_WALLPAPER.into();
        }
        if settings.wallpaper != "custom" {
            settings.accent = None;
        }
        *store.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings;
        store
    }

    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn custom_path(&self) -> Option<PathBuf> {
        CUSTOM_EXTENSIONS.iter().map(|ext| self.data_dir.join(format!("wallpaper.{ext}"))).find(|path| path.is_file())
    }

    fn save(&self, settings: Settings) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| AppError::new(500, "settings_write"))?;
        std::fs::write(&self.path, bytes).map_err(|_| AppError::new(500, "settings_write"))?;
        *self.settings.lock().unwrap_or_else(|p| p.into_inner()) = settings;
        Ok(())
    }

    pub fn set_wallpaper(&self, id: &str) -> Result<(), AppError> {
        if !valid(id) || (id == "custom" && self.custom_path().is_none()) {
            return Err(AppError::new(400, "unknown_wallpaper"));
        }
        let mut settings = self.get();
        settings.wallpaper = id.into();
        self.save(settings)
    }

    /// Copie l'image choisie dans le dossier de données et en fait le fond actif.
    pub fn install_custom(&self, source: &Path) -> Result<PathBuf, AppError> {
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| CUSTOM_EXTENSIONS.contains(&e.as_str()))
            .ok_or_else(|| AppError::new(400, "wallpaper_invalid"))?;
        let accent = accent_of(source).map_err(|_| AppError::new(400, "wallpaper_invalid"))?;
        let target = self.data_dir.join(format!("wallpaper.{ext}"));
        self.remove_files(Some(&target));
        std::fs::copy(source, &target).map_err(|_| AppError::new(500, "wallpaper_copy"))?;
        let mut settings = self.get();
        settings.wallpaper = "custom".into();
        settings.accent = accent;
        self.save(settings)?;
        Ok(target)
    }

    pub fn remove_custom(&self) -> Result<(), AppError> {
        self.remove_files(None);
        let mut settings = self.get();
        if settings.wallpaper == "custom" {
            settings.wallpaper = DEFAULT_WALLPAPER.into();
        }
        settings.accent = None;
        self.save(settings)
    }

    fn remove_files(&self, keep: Option<&Path>) {
        for ext in CUSTOM_EXTENSIONS {
            let path = self.data_dir.join(format!("wallpaper.{ext}"));
            if keep != Some(path.as_path()) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// Change à chaque nouvelle image : sert à contourner le cache du navigateur.
    pub fn version(&self) -> u64 {
        self.custom_path()
            .and_then(|p| p.metadata().ok())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    pub fn view(&self) -> Value {
        let settings = self.get();
        json!({ "id": settings.wallpaper, "accent": settings.accent, "version": self.version() })
    }
}

fn valid(id: &str) -> bool {
    id == "none" || id == "custom" || WALLPAPERS.contains(&id)
}

/// Couleur d'accent dominante d'une image : la teinte la plus présente parmi
/// les pixels colorés, déclinée en version claire et sombre. `None` pour une
/// image sans couleur franche ; `Err` si l'image ne se décode pas.
pub fn accent_of(path: &Path) -> Result<Option<Accent>, image::ImageError> {
    let image = image::ImageReader::open(path)?.with_guessed_format()?.decode()?;
    let small = image.thumbnail(96, 96).to_rgb8();
    let mut buckets = [(0f32, 0f32, 0f32, 0f32); 24];
    for pixel in small.pixels() {
        let (hue, sat, light) = hsl(pixel[0], pixel[1], pixel[2]);
        let weight = sat * (1.0 - (light - 0.5).abs() * 1.6).max(0.0);
        if weight < 0.05 {
            continue;
        }
        let bucket = &mut buckets[((hue / 15.0) as usize).min(23)];
        bucket.0 += weight;
        bucket.1 += weight * hue.to_radians().cos();
        bucket.2 += weight * hue.to_radians().sin();
        bucket.3 += weight * sat;
    }
    let best = buckets.iter().max_by(|a, b| a.0.total_cmp(&b.0)).copied().unwrap_or_default();
    if best.0 < (small.width() * small.height()) as f32 * 0.01 {
        return Ok(None);
    }
    let hue = best.2.atan2(best.1).to_degrees().rem_euclid(360.0);
    let sat = (best.3 / best.0).clamp(0.3, 0.65);
    Ok(Some(Accent { light: hex(rgb(hue, sat, 0.36)), dark: hex(rgb(hue, sat, 0.72)) }))
}

fn hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let light = (max + min) / 2.0;
    let delta = max - min;
    if delta < 1e-6 {
        return (0.0, 0.0, light);
    }
    let sat = delta / (1.0 - (2.0 * light - 1.0).abs());
    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    (hue.rem_euclid(360.0), sat, light)
}

fn rgb(hue: f32, sat: f32, light: f32) -> [u8; 3] {
    let c = (1.0 - (2.0 * light - 1.0).abs()) * sat;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = light - c / 2.0;
    let (r, g, b) = match (hue / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [((r + m) * 255.0).round() as u8, ((g + m) * 255.0).round() as u8, ((b + m) * 255.0).round() as u8]
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}
