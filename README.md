# Brise

Application de transfert de fichiers entre Linux, iPhone et Android.
Connexion par QR code, validation sur le PC et interface mobile sans installation.

L’interface PC s’ouvre dans votre navigateur. Le serveur et les fichiers restent
sur votre PC. Les modes locaux fonctionnent sans Internet ; le mode Internet
utilise un tunnel HTTPS temporaire Cloudflare. Aucun compte Brise n’est nécessaire.

## Lancer

Node.js 22 ou plus récent est nécessaire. Il est déjà installé sur cette machine.
Aucun `npm install` n’est nécessaire. Le mode Internet nécessite aussi
`cloudflared` ; le point d’accès nécessite NetworkManager et une carte Wi-Fi
compatible avec le mode AP.

```bash
cd /home/ana/Projets/brise
./brise
```

Le raccourci **Brise** est également disponible dans le lanceur d’applications
de votre session Niri après l’installation ci-dessous :

```bash
npm run install-desktop
```

Le lanceur réutilise le serveur existant lorsqu’il est déjà actif. Fermer l’onglet
ne termine pas le partage : utilisez **Réglages → Quitter Brise** pour arrêter
le serveur. Pour un lancement au premier plan, avec arrêt par `Ctrl+C` :

```bash
npm run serve
```

Ouvrez alors l’adresse « Interface PC » affichée dans ce terminal. Son fragment
contient la clé d’administration locale : ne partagez pas cette adresse.
Le lien destiné au téléphone est celui du QR code dans l’interface.

## Choisir le mode de connexion

Le sélecteur **Connexion**, à côté du QR code, propose trois modes.
L’application démarre en mode local ; elle n’ouvre aucun tunnel automatiquement.
Après cette mise à jour, quittez Brise depuis ses réglages puis relancez-le
pour charger le nouveau serveur.

### Réseau local

Le fonctionnement initial : même réseau local, aucune dépendance à Internet.

### Internet

1. Sur CachyOS, installez l’outil optionnel dans un terminal :
   `sudo pacman -S cloudflared`.
2. Choisissez **Internet**, puis **Activer internet**. Si l’outil vient d’être
   installé, utilisez **Vérifier à nouveau** dans le dialogue.
3. Attendez la connexion du tunnel puis scannez le QR ou copiez le lien HTTPS.
   Le téléphone peut être en 4G/5G ou sur un autre Wi-Fi.

Le tunnel est un [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
sans compte ni nom de domaine requis. Il utilise une adresse temporaire
`trycloudflare.com`. Ce service est destiné aux essais et au développement et
ne garantit pas sa disponibilité. Les fichiers transitent par Cloudflare :
HTTPS protège les liaisons, **sans chiffrement de bout en bout vis-à-vis du relais**.
Il ne s’agit pas de WebRTC ni d’une connexion directe entre les appareils.

L’interface d’administration ne passe jamais par ce tunnel : une seconde écoute
HTTP sur la boucle locale expose seulement les routes destinées au téléphone.
Les anciens liens cessent de fonctionner à l’arrêt du tunnel. Cloudflared est
arrêté lorsque vous changez de mode ou quittez Brise normalement.

Les envois depuis Internet sont découpés en blocs de 8 Mio, sous la limite des
requêtes HTTP du relais. Chaque fichier est assemblé sur le PC, puis enregistré
avec les mêmes contrôles qu’en local. La finalisation est suivie par des requêtes
courtes pour ne pas dépendre du délai d’une seule requête de longue durée.
Prévoyez temporairement jusqu’à deux fois la taille du fichier sur le disque.
Les envois abandonnés sont nettoyés après quinze minutes d’inactivité.

### Point d’accès Wi-Fi

1. Choisissez **Point d’accès Wi-Fi** et la carte disponible.
2. Confirmez le remplacement de sa connexion Wi-Fi actuelle pendant le partage.
3. Sur le téléphone, scannez le QR **Rejoindre le Wi-Fi**, ou saisissez le nom
   et le mot de passe affichés dans les réglages Wi-Fi.
4. Scannez ensuite le QR **Ouvrir Brise** et acceptez la connexion sur le PC.

Brise crée un profil NetworkManager WPA2 avec un mot de passe aléatoire, sans
connexion automatique. Il ne faut ni box ni Internet. Sur une carte Wi-Fi unique,
le PC peut perdre son accès Internet pendant ce mode. NetworkManager doit
être démarré et autoriser votre session à gérer ses connexions ; Brise ne modifie
pas les règles Polkit pour obtenir ces permissions.

À l’arrêt du point d’accès, Brise supprime uniquement le profil qu’il a créé
et tente de rétablir la connexion précédente. Une connexion sélectionnée
manuellement entre-temps est conservée. Un journal privé permet de réessayer
le nettoyage au prochain démarrage après un arrêt inattendu. Un arrêt forcé
peut laisser le point d’accès actif jusqu’à ce nettoyage.

Le passage d’un mode à un autre est refusé pendant un transfert. Les appareils
associés sont déconnectés et doivent scanner le nouveau QR code.

## Partager

1. Choisissez le mode de connexion adapté, comme décrit ci-dessus.
2. Lancez Brise sur le PC et scannez son QR code avec l’appareil photo du téléphone.
3. Sur le téléphone, choisissez un nom puis touchez **Demander la connexion**.
4. Comparez le code à six chiffres affiché sur les deux appareils et acceptez sur le PC.
5. **PC → téléphone** : déposez des fichiers sur le PC, puis ouvrez **Recevoir**
   sur le téléphone et téléchargez les fichiers souhaités.
6. **Téléphone → PC** : ouvrez **Envoyer au PC**, puis choisissez vos fichiers.
   Gardez la page ouverte pendant le transfert.

Les fichiers reçus vont dans **Brise**, à l’intérieur du dossier de téléchargements
XDG du PC. Par défaut, en l’absence de réglage XDG : `~/Téléchargements/Brise`.
Le bouton **Ouvrir le dossier** et l’historique permettent de les retrouver.

## Comportement

- Envoi de plusieurs fichiers, file d’attente, progression, annulation et nouvel essai.
- Limite de 10 Gio par fichier (libellée 10 Go dans l’interface) ; écriture en flux,
  sans charger l’intégralité des fichiers en mémoire.
- Les noms identiques sont renommés avec un suffixe, sans écraser les fichiers reçus.
- Les copies temporaires incomplètes sont retirées après erreur ou au redémarrage.
- Les originaux sélectionnés sur le PC sont conservés : Brise crée une copie de partage.
  L’espace libre doit donc suffire à cette copie.
- Les fichiers reçus et leur historique persistent après redémarrage.
- Les partages sortants et les autorisations des téléphones expirent au redémarrage.
  Les copies de partage de la session précédente sont nettoyées à ce moment-là.
- Le QR code change après dix minutes. Le changement du QR ne déconnecte pas les
  appareils déjà acceptés ; ils peuvent être déconnectés individuellement.
- Le compteur « Récupéré » indique que le serveur a transmis un fichier complet
  au navigateur. Il ne garantit pas l’enregistrement final par le système mobile.
- Les téléchargements acceptent les requêtes HTTP Range. Les envois interrompus
  repartent du début lorsque vous choisissez **Réessayer**.

## Réseau et confidentialité

Le QR code contient un lien vers le PC et un jeton de connexion temporaire.
Les fichiers voyagent sur le réseau choisi, **pas à travers le QR code**.
Le serveur écoute sur les interfaces IPv4 du PC au port **53317/TCP** par défaut.

Les modes locaux utilisent **HTTP sans chiffrement du transport**. Utilisez-les
sur un réseau de confiance. Le point d’accès protège la liaison Wi-Fi par WPA2. Le jeton et la validation sur le PC contrôlent l’accès,
mais ne remplacent pas HTTPS face à quelqu’un qui intercepte le trafic local.

L’administration exige une connexion depuis la boucle locale et une clé aléatoire.
Les sessions utilisent des cookies HttpOnly/SameSite ; les mutations contrôlent
l’origine et un en-tête dédié. Les fichiers reçus ne sont jamais exposés aux
téléphones. Les appareils acceptés ont accès à tous les fichiers actuellement
partagés par le PC, sans sélection par destinataire.

**Si le QR code ne fonctionne pas :**

- Choisissez la bonne adresse IPv4 dans **Réglages**. Sur un PC avec plusieurs
  interfaces, une interface VPN ou virtuelle peut avoir été sélectionnée.
- Évitez un réseau invité qui isole les appareils et vérifiez votre VPN.
- Si un pare-feu bloque les connexions entrantes, autorisez le port 53317/TCP
  depuis votre réseau local dans votre outil de gestion du pare-feu.
  Brise ne modifie pas les règles du système.
- Sans box, utilisez le mode **Point d’accès Wi-Fi**. Si le téléphone indique
  que ce réseau n’a pas Internet, choisissez de rester connecté.
- Si le mode Internet est indisponible, installez `cloudflared` puis cliquez sur
  **Vérifier à nouveau**. Une connexion Internet et l’accès à Cloudflare sont nécessaires.

## Configuration

Variables d’environnement à définir avant de démarrer le serveur :

| Variable | Usage |
| --- | --- |
| `BRISE_PORT` | Port HTTP, par défaut `53317` |
| `BRISE_ADDRESS` | Adresse IPv4 du PC à encoder dans le QR |
| `BRISE_RECEIVE_DIR` | Dossier de réception personnalisé |
| `BRISE_DATA_DIR` | Historique, copies de partage et état du serveur |

Les données techniques sont conservées dans `$XDG_DATA_HOME/brise`, ou
`~/.local/share/brise`. Les fichiers reçus restent dans leur dossier distinct.
Le journal `server.log` et `runtime.json` contiennent le lien d’administration
et sont créés avec des permissions privées.

## Développement et vérification

```bash
npm test
# Rapport détaillé avec le Node installé sur cette machine :
node --test --test-isolation=none --test-reporter=spec tests/*.test.mjs
# Aperçus HTML autonomes avec données fictives, jamais servis en production :
node scripts/preview.mjs
```

Les tests couvrent l’approbation et la révocation, les transferts bidirectionnels,
les noms de fichiers et doublons, les flux interrompus, la persistance, les requêtes
Range, les accès anonymes/interdits et les origines HTTP. Les nouveaux tests
couvrent les blocs binaires, les changements de mode, la fermeture du tunnel,
l’isolation de l’administration et la restauration du Wi-Fi (commandes simulées). Un test utilise un vrai
serveur HTTP ; il est explicitement ignoré si l’environnement interdit les sockets.

Dans l’environnement de développement de cette livraison, les sockets réseau
sont interdites et Firefox headless se termine avant le rendu. Les tests de logique
et des routes en mémoire ont été exécutés ; le QR SVG a été relu avec ZBar.
Le fonctionnement du mode local a été confirmé par l’utilisateur.
**Le tunnel Internet et le point d’accès réels restent à vérifier depuis la
session CachyOS** : cet environnement interdit les sockets réseau et l’accès
à NetworkManager. `cloudflared` n’est pas installé dans cet environnement.

Organisation : `src/` pour le serveur, `public/` pour les interfaces, `tests/` pour
les tests et `vendor/` pour le générateur QR autonome avec ses licences conservées.
