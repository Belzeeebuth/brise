Brise transfère des fichiers, des photos et des textes entre un PC Linux et n’importe quel téléphone (iPhone ou Android), sans rien installer sur le téléphone : un QR code suffit.

## Installer

| Paquet | Pour |
| --- | --- |
| `Brise_<version>_amd64.AppImage` | toutes les distributions (WebKitGTK inclus) : rendez-le exécutable et lancez-le |
| `Brise_<version>_amd64.deb` | Debian, Ubuntu, Mint… |
| `Brise-<version>-1.x86_64.rpm` | Fedora, openSUSE… |

Les paquets .deb et .rpm ont besoin de WebKitGTK 4.1 et de libayatana-appindicator. Optionnels : `cloudflared` pour le mode Internet, NetworkManager pour le point d’accès Wi-Fi.

Brise écoute sur le port 53318/TCP : autorisez-le dans votre pare-feu si le téléphone n’arrive pas à se connecter.

## Changements
