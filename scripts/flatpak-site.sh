#!/usr/bin/env bash
# Assemble le site GitHub Pages du dépôt Flatpak :
#   scripts/flatpak-site.sh <dépôt OSTree construit> <dossier de sortie> <clé GPG>
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${1:?dépôt}"
out="${2:?sortie}"
key="${3:?clé GPG}"

find "$repo/refs/heads" -type f \( -path '*.Debug/*' -o -path '*.Sources/*' \) -print -delete
flatpak build-update-repo --title=Brise --default-branch=stable --generate-static-deltas --prune --gpg-sign="$key" "$repo"

rm -rf "$out"
mkdir -p "$out/fonts" "$out/wallpapers"
cp -r "$repo" "$out/repo"
cp "$root"/flatpak/site/* "$out/"
cp "$root/ui/icon.svg" "$out/icon.svg"
cp "$root/src-tauri/icons/128x128.png" "$out/brise-128.png"
cp "$root"/ui/fonts/*.woff2 "$out/fonts/"
cp "$root"/ui/wallpapers/brume-light.svg "$root"/ui/wallpapers/brume-dark.svg "$root"/ui/wallpapers/grain.png "$out/wallpapers/"
cp "$root/docs/screenshots/connexion.png" "$out/capture.png"
touch "$out/.nojekyll"
du -sh "$out" "$out/repo"
