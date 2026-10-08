use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Fr,
    En,
}

pub fn system_lang() -> Lang {
    for key in ["BRISE_LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(key) else { continue };
        let value = value.trim().to_lowercase();
        if value.is_empty() || value == "c" || value.starts_with("c.") || value == "posix" {
            continue;
        }
        return if value.starts_with("fr") { Lang::Fr } else { Lang::En };
    }
    Lang::En
}

pub fn tr(lang: Lang, key: &str) -> &'static str {
    let fr = lang == Lang::Fr;
    match key {
        "tray_open" => if fr { "Ouvrir Brise" } else { "Open Brise" },
        "tray_quit" => if fr { "Quitter Brise" } else { "Quit Brise" },
        "pick_title" => if fr { "Choisir des fichiers à partager" } else { "Choose files to share" },
        "pick_wallpaper_title" => if fr { "Choisir une image de fond" } else { "Choose a background picture" },
        "pick_wallpaper_filter" => if fr { "Images" } else { "Pictures" },
        "received" => if fr { "Fichier reçu" } else { "File received" },
        "received_many" => if fr { "{count} fichiers reçus" } else { "{count} files received" },
        "received_text" => if fr { "Texte reçu" } else { "Text received" },
        "autostart_reason" => if fr { "Brise démarre avec la session pour rester joignable par vos téléphones." } else { "Brise starts with your session so your phones can reach it." },
        "pair_title" => if fr { "{name} souhaite se connecter" } else { "{name} wants to connect" },
        "pair_body" => if fr { "Code {code} : vérifiez qu’il s’affiche sur le téléphone, puis acceptez dans Brise." } else { "Code {code}: check that the phone shows the same code, then accept in Brise." },
        "still_running_title" => if fr { "Brise reste actif" } else { "Brise keeps running" },
        "still_running_body" => if fr { "Le partage continue depuis la barre système. Choisissez « Quitter Brise » dans son menu pour l’arrêter." } else { "Sharing continues from the system tray. Choose “Quit Brise” in its menu to stop it." },
        "startup_title" => if fr { "Brise ne peut pas démarrer" } else { "Brise can’t start" },
        "already_running" => if fr { "Une autre instance de Brise est déjà lancée. Quittez-la, puis relancez Brise." } else { "Another instance of Brise is already running. Quit it, then start Brise again." },
        "lock_failed" => if fr { "Impossible de verrouiller le dossier de données de Brise." } else { "Brise couldn’t lock its data folder." },
        "data_dirs" => if fr { "Impossible de préparer les dossiers de Brise." } else { "Brise couldn’t prepare its folders." },
        _ => "",
    }
}
