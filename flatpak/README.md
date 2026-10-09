# Flatpak de Brise

- `io.github.belzeeebuth.brise.yml` : manifeste (runtime GNOME 50, Rust et Go
  depuis les extensions du SDK). Il construit Brise depuis un tag Git publié.
- `cargo-sources.json` : dépendances Rust pour la compilation hors ligne.
- `cloudflared/` : sources Go de cloudflared (une archive par module) et le
  `modules.txt` du dossier `vendor/`.
- `shared-modules/` : sous-module Git de Flathub, pour libayatana-appindicator.
- `io.github.belzeeebuth.brise.desktop` : lanceur ; les métadonnées AppStream
  sont dans `src-tauri/io.github.belzeeebuth.brise.metainfo.xml`.

## Construire

```bash
git submodule update --init
flatpak-builder --user --install --force-clean build-flatpak flatpak/io.github.belzeeebuth.brise.yml
```

Sur GitHub, le workflow « Flatpak » construit le paquet depuis le commit courant
et passe le linter de Flathub. Après chaque release, le workflow « Dépôt Flatpak »
construit le paquet signé depuis le tag, l’ajoute à la release et publie le dépôt
sur GitHub Pages (`site/` : page `index.html`, `brise.flatpakrepo`,
`io.github.belzeeebuth.brise.flatpakref`, clé publique `brise.gpg.asc`). Il se
relance à la main pour un tag existant :

```bash
gh workflow run depot-flatpak.yml -f tag=v0.5.1
```

Le dépôt est signé par la clé `9901F9200D0F7813A9552C36461E1ADF26B8993B`, dont la
partie privée est le secret GitHub `FLATPAK_GPG_KEY`. Une nouvelle clé obligerait
chaque utilisateur à réinstaller le dépôt : gardez-en une sauvegarde.

## Mettre à jour les sources générées

Après un changement de `src-tauri/Cargo.lock` :

```bash
python3 flatpak-cargo-generator.py src-tauri/Cargo.lock -o flatpak/cargo-sources.json
```

(`flatpak-cargo-generator.py` vient de
[flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools/tree/master/cargo)
et demande les modules Python `aiohttp`, `toml` et `tomlkit`.)

Pour une nouvelle version de cloudflared : changer `tag` et `commit` dans le
manifeste, puis, depuis une copie de cloudflared à ce tag,

```bash
go install github.com/dennwc/flatpak-go-mod@latest
flatpak-go-mod -json -out sortie chemin/vers/cloudflared
sed 's|"path": "modules.txt"|"path": "cloudflared/modules.txt"|' sortie/go.mod.json > flatpak/cloudflared/sources.json
cp sortie/modules.txt flatpak/cloudflared/modules.txt
```

Les chemins des sources incluses se lisent depuis le manifeste, d’où le `sed`.
Penser aussi à la version passée à `-X main.Version=` dans le manifeste.
