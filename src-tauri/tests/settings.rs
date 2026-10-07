use brise_lib::settings::{accent_of, Store, DEFAULT_WALLPAPER};
use image::{ImageBuffer, Rgb};

fn picture(dir: &std::path::Path, name: &str, color: [u8; 3]) -> std::path::PathBuf {
    let path = dir.join(name);
    ImageBuffer::from_pixel(40, 30, Rgb(color)).save(&path).unwrap();
    path
}

#[test]
fn the_store_validates_choices_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    assert_eq!(store.view()["id"], DEFAULT_WALLPAPER);
    assert_eq!(store.set_wallpaper("plage").unwrap_err().code, "unknown_wallpaper");
    assert_eq!(store.set_wallpaper("custom").unwrap_err().code, "unknown_wallpaper");
    store.set_wallpaper("nuit").unwrap();
    store.set_wallpaper("none").unwrap();
    assert_eq!(Store::open(dir.path()).view()["id"], "none");
    std::fs::write(dir.path().join("settings.json"), r#"{"wallpaper":"custom"}"#).unwrap();
    assert_eq!(Store::open(dir.path()).view()["id"], DEFAULT_WALLPAPER, "une image absente ramène au fond par défaut");
}

#[test]
fn a_custom_picture_is_copied_and_gives_its_accent() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let store = Store::open(&data);
    let blue = picture(dir.path(), "ciel.png", [40, 90, 200]);
    let target = store.install_custom(&blue).unwrap();
    assert_eq!(target, data.join("wallpaper.png"));
    let view = store.view();
    assert_eq!(view["id"], "custom");
    let light = view["accent"]["light"].as_str().unwrap();
    let (r, b) = (u8::from_str_radix(&light[1..3], 16).unwrap(), u8::from_str_radix(&light[5..7], 16).unwrap());
    assert!(b > r + 60, "accent bleu attendu, obtenu {light}");
    assert!(view["version"].as_u64().unwrap() > 0);

    let grey = picture(dir.path(), "gris.jpg", [120, 120, 120]);
    store.install_custom(&grey).unwrap();
    assert!(!data.join("wallpaper.png").exists(), "l’ancienne image est remplacée");
    assert!(store.view()["accent"].is_null(), "une image grise garde l’accent par défaut");
    assert_eq!(Store::open(&data).view()["id"], "custom");

    std::fs::write(dir.path().join("texte.png"), b"pas une image").unwrap();
    assert_eq!(store.install_custom(&dir.path().join("texte.png")).unwrap_err().code, "wallpaper_invalid");
    assert_eq!(store.install_custom(&dir.path().join("photo.gif")).unwrap_err().code, "wallpaper_invalid");
    assert!(accent_of(&dir.path().join("texte.png")).is_err());

    store.remove_custom().unwrap();
    assert!(store.custom_path().is_none());
    assert_eq!(store.view()["id"], DEFAULT_WALLPAPER);
}
