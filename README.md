# Brise

Application Linux de transfert de fichiers entre votre PC et n’importe quel
téléphone (iPhone ou Android), **sans rien installer sur le téléphone** :
un QR code suffit.

- Fenêtre native et icône dans la barre système : fermer la fenêtre laisse le
  partage actif, « Quitter Brise » dans le menu de l’icône l’arrête.
- Notifications quand un téléphone demande à se connecter et quand un fichier
  arrive.
- Partage depuis le PC par glisser-déposer ou « Parcourir… » : les fichiers
  restent à leur place, sans copie.
- Envois du téléphone par blocs, avec reprise automatique après une coupure.
- Trois modes : réseau local, Internet (tunnel Cloudflare) et point d’accès
  Wi-Fi créé par le PC.
- Interface en français et en anglais, selon la langue du système (et celle du
  navigateur côté téléphone) ; thème clair, sombre ou celui du système, au choix
  dans les réglages.
- Huit fonds d’écran dessinés pour Brise (brume, dunes, marée, nuit, aurore,
  prairie, papier, carreaux), chacun en version jour et nuit, ou votre propre
  image : la couleur d’accent de l’interface suit le fond, et le téléphone
  reprend le fond choisi sur le PC.
- Miniatures des photos reçues et partagées, ouverture directe des fichiers reçus.

## Installer

| Paquet | Pour | Taille |
| --- | --- | --- |
| `Brise_<version>_amd64.AppImage` | toutes les distributions | ~110 Mo (WebKitGTK inclus) |
| `Brise_<version>_amd64.deb` | Debian, Ubuntu, Mint… | ~5 Mo |
| `Brise-<version>-1.x86_64.rpm` | Fedora, openSUSE… | ~5 Mo |

Les paquets sont produits par `npm run build` dans
`src-tauri/target/release/bundle/`.

Les paquets `.deb` et `.rpm` dépendent de WebKitGTK 4.1 et de
libayatana-appindicator (icône de la barre système), présents sur la plupart des
bureaux. Optionnels : `cloudflared` pour le mode Internet, NetworkManager et une
carte Wi-Fi compatible avec le mode AP pour le point d’accès.

Depuis les sources, sur Arch/CachyOS :

```bash
sudo pacman -S --needed webkit2gtk-4.1 libayatana-appindicator rust nodejs npm
npm install
npm run build
npm run install-local   # ~/.local/bin/brise + entrée du lanceur d’applications
```

## Utiliser

1. Ouvrez Brise depuis le lanceur d’applications.
2. Scannez le QR code avec l’appareil photo du téléphone.
3. Sur le téléphone, choisissez un nom puis touchez **Demander la connexion**.
4. Comparez le code à six chiffres affiché sur les deux appareils et acceptez
   dans Brise. Une notification signale la demande même si la fenêtre est fermée.
5. **PC → téléphone** : glissez des fichiers dans la fenêtre ou cliquez sur
   **Parcourir…**, puis ouvrez **Recevoir** sur le téléphone.
6. **Téléphone → PC** : ouvrez **Envoyer au PC** et choisissez vos fichiers.
   Si l’écran se verrouille ou si la connexion saute, l’envoi reprend là où il
   s’était arrêté en revenant sur la page.

Les fichiers reçus vont dans `Brise`, à l’intérieur du dossier de
téléchargements XDG (par défaut `~/Téléchargements/Brise`). **Historique**
permet de les afficher dans le gestionnaire de fichiers.

Sur iPhone, les fichiers téléchargés depuis le PC arrivent dans l’app
**Fichiers**. En mode Internet, un bouton **Photos** (ou **Partager** sur Android)
enregistre directement les images et vidéos de moins de 500 Mo : Safari réserve
cette fonction aux pages HTTPS, elle n’existe donc pas en mode local.

## Modes de connexion

Le sélecteur **Connexion**, à côté du QR code, propose trois modes. Changer de
mode déconnecte les téléphones, qui scannent le nouveau QR code. Le changement
est refusé pendant un transfert actif.

**Réseau local.** PC et téléphone sur le même réseau, sans Internet. Si le PC
change de réseau, l’adresse et le QR se mettent à jour d’eux-mêmes. Le transport
est en HTTP : à utiliser sur un réseau de confiance.

**Internet.** Le téléphone peut être en 4G/5G ou sur un autre Wi-Fi. Brise lance
un [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
(adresse temporaire `trycloudflare.com`, sans compte). Installez d’abord
`cloudflared` (`sudo pacman -S cloudflared`). HTTPS protège les liaisons, **sans
chiffrement de bout en bout vis-à-vis de Cloudflare**. Le tunnel n’expose que les
pages du téléphone, sur une écoute séparée. Ce service gratuit ne garantit pas
sa disponibilité.

**Point d’accès Wi-Fi.** Le PC crée un réseau WPA2 avec un mot de passe aléatoire ;
le téléphone le rejoint via un premier QR code, puis ouvre Brise avec le second.
Sur une carte Wi-Fi unique, le PC perd son accès Internet pendant ce mode. À
l’arrêt, Brise supprime son profil NetworkManager et rétablit la connexion
précédente ; après un arrêt brutal, le nettoyage a lieu au lancement suivant.

## Pare-feu

Brise écoute sur le port **53318/TCP** (53317 est celui de LocalSend : les deux
applications peuvent cohabiter). Brise ne modifie jamais le pare-feu. Avec ufw,
par exemple :

```bash
sudo ufw allow in on wlan0 proto tcp from 192.168.1.0/24 to any port 53318
sudo ufw allow in on wlan0 proto tcp from 10.42.0.0/24 to 10.42.0.1 port 53318
```

La première ligne sert au réseau local, la seconde au point d’accès. Adaptez
l’interface et le réseau à votre machine.

## Sécurité et confidentialité

- Le QR code contient l’adresse du PC et un jeton valable dix minutes ; les
  fichiers passent par le réseau choisi, pas par le QR.
- Chaque téléphone doit être accepté sur le PC après comparaison du code.
  Les sessions disparaissent à l’arrêt de Brise ou au changement de mode.
- L’administration n’est pas exposée sur le réseau : seule la fenêtre de
  l’application peut accepter un appareil, partager ou changer de mode.
- Le serveur refuse les noms d’hôte inconnus et les requêtes d’une autre
  origine ; les cookies sont HttpOnly et SameSite=Strict.
- Les appareils acceptés voient tous les fichiers actuellement partagés.
  Les fichiers reçus ne leur sont jamais exposés.

## Configuration

| Variable | Usage |
| --- | --- |
| `BRISE_PORT` | Port d’écoute, par défaut `53318` |
| `BRISE_ADDRESS` | Adresse IPv4 fixe à encoder dans le QR (sinon suivie automatiquement) |
| `BRISE_RECEIVE_DIR` | Dossier de réception |
| `BRISE_DATA_DIR` | Historique, réglages et image de fond (`~/.local/share/brise` par défaut) |

## Développement

```bash
npm run dev      # fenêtre de développement
npm test         # tests Rust : cœur, HTTP, modes de connexion
npm run build    # binaire optimisé et paquets
```

Organisation :
- `src-tauri/src/core.rs` : appareils, fichiers, envois par blocs, historique ;
- `server.rs` : serveur HTTP du téléphone (axum) ;
- `connections.rs` : modes réseau local, Internet et point d’accès ;
- `network.rs` : interfaces réseau et QR codes ;
- `lib.rs` : fenêtre, icône de la barre système, notifications et commandes de
  l’interface ;
- `i18n.rs` : langue du système et textes natifs (menu de l’icône, notifications) ;
- `settings.rs` : réglages persistants (`settings.json`), image de fond
  personnelle et calcul de sa couleur d’accent ;
- `ui/` : interface du PC (`index.html`, `desktop.js`, `desktop.css`) et du
  téléphone (`phone.html`, `phone.js`, `phone.css`). En commun : `styles.css`
  (thèmes et composants), `common.js`, `i18n.js` (textes français et anglais,
  y compris les codes d’erreur renvoyés par le moteur), `theme.js` (thème et
  fond appliqués avant le premier rendu), la police Manrope (`ui/fonts`, licence
  SIL OFL) et les fonds d’écran (`ui/wallpapers`, SVG produits par
  `scripts/wallpapers.py`, à relancer après toute retouche).

`src-tauri/examples/e2e_server.rs` lance le serveur seul et accepte
automatiquement les téléphones, pour tester la page du téléphone dans un
navigateur.
