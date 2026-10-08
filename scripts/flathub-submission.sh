#!/usr/bin/env bash
# Prépare les fichiers à proposer à Flathub pour un tag publié :
#   scripts/flathub-submission.sh v0.5.1 [dossier de sortie]
# Le manifeste y pointe vers le tag et son commit, comme Flathub l'exige.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:?usage : $0 <tag> [dossier]}"
out="${2:-$root/build-flathub}"
app=io.github.belzeeebuth.brise
commit="$(git -C "$root" rev-list -n 1 "$tag")"
git -C "$root" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || { echo "Le tag $tag n'est pas sur GitHub : poussez-le d'abord." >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/cloudflared"
git -C "$root" show "$tag:flatpak/$app.yml" > "$out/$app.yml"
git -C "$root" show "$tag:flatpak/cargo-sources.json" > "$out/cargo-sources.json"
git -C "$root" show "$tag:flatpak/cloudflared/sources.json" > "$out/cloudflared/sources.json"
git -C "$root" show "$tag:flatpak/cloudflared/modules.txt" > "$out/cloudflared/modules.txt"
python3 - "$out/$app.yml" "$tag" "$commit" <<'PY'
import sys
path, tag, commit = sys.argv[1:]
text = open(path).read()
old = f"        url: https://github.com/Belzeeebuth/brise.git\n        tag: {tag}\n"
if old not in text:
    sys.exit(f"source de Brise introuvable pour {tag} dans le manifeste")
open(path, "w").write(text.replace(old, old + f"        commit: {commit}\n"))
PY
echo "Soumission prête dans $out (Brise $tag, commit $commit)."
echo "Ajouter aussi le sous-module : git submodule add https://github.com/flathub/shared-modules.git"
