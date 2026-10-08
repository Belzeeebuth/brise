#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$root/src-tauri/target/release/brise"
[ -x "$binary" ] || { echo "Compilez d’abord Brise : npm run build" >&2; exit 1; }
data="${XDG_DATA_HOME:-$HOME/.local/share}"
install -Dm755 "$binary" "$HOME/.local/bin/brise"
for size in 32x32 64x64 128x128; do
  install -Dm644 "$root/src-tauri/icons/$size.png" "$data/icons/hicolor/$size/apps/brise.png"
done
install -Dm644 "$root/src-tauri/icons/128x128@2x.png" "$data/icons/hicolor/256x256/apps/brise.png"
install -Dm644 "$root/src-tauri/icons/icon.png" "$data/icons/hicolor/512x512/apps/brise.png"
install -Dm644 "$root/ui/icon.svg" "$data/icons/hicolor/scalable/apps/brise.svg"
install -Dm644 /dev/stdin "$data/applications/brise.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Brise
GenericName=Partage de fichiers
Comment=Partagez vos fichiers avec votre téléphone
Exec=$HOME/.local/bin/brise %F
Icon=brise
Terminal=false
Categories=Network;FileTransfer;Utility;
Keywords=partage;fichiers;airdrop;QR;téléphone;share;files;phone;
MimeType=$(grep '^MimeType=' "$root/src-tauri/brise.desktop.hbs" | cut -d= -f2-)
StartupWMClass=brise
StartupNotify=true
DESKTOP
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$data/icons/hicolor" || true
command -v update-desktop-database >/dev/null && update-desktop-database -q "$data/applications" || true
echo "Brise est installé : ~/.local/bin/brise et le lanceur d’applications."
