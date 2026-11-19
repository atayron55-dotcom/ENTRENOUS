# Entre Nous Desktop — P2P (version 2.0.0)

**Entre Nous** est une messagerie privée à deux sous forme de véritables applications de bureau Windows, Linux et macOS. Chaque version est autonome : Electron embarque son propre moteur d’affichage et le runtime nécessaire. Il n’est pas nécessaire d’installer Python, Node.js ou un navigateur sur les ordinateurs qui utilisent l’application.

Les trois systèmes utilisent le même protocole WebRTC et peuvent donc communiquer entre eux : Windows ↔ Linux, Windows ↔ macOS, Linux ↔ macOS, ou deux machines du même système.

## Ce qui change par rapport à la première version

Il n’y a plus de serveur de discussion, de base de données centrale ou de stockage central des messages. Les messages, images, avatars et emojis sont échangés directement entre les deux applications par un canal WebRTC DataChannel.

Un **tout petit service de mise en relation** reste nécessaire pour le code d’invitation. Il joue le rôle d’un lobby de jeu : il met les deux appareils en contact et transmet uniquement les informations techniques nécessaires à l’ouverture de WebRTC (SDP et candidats ICE). Il ne reçoit jamais le texte des messages ni les photos, et ne conserve pas d’historique.

> Une connexion Internet directe entre deux réseaux ne peut pas être déclenchée par un simple code sans aucun échange préalable d’informations réseau. C’est pour cela qu’un service de rendez-vous minimal est nécessaire pour l’invitation courte. Le trafic de discussion reste pair-à-pair.

## Fonctionnalités de cette version

- Création d’une session et code d’invitation à copier/coller.
- Connexion directe P2P avec WebRTC DataChannels.
- Chiffrement DTLS de WebRTC et chiffrement applicatif AES-256-GCM ; la clé est dérivée du secret aléatoire contenu dans le code d’invitation. Le secret n’est jamais envoyé au service de mise en relation.
- Recherche de chemin réseau avec STUN (Google et Cloudflare configurés par défaut).
- Paramètres TURN facultatifs pour les réseaux qui empêchent le P2P direct. Même avec TURN, le contenu du DataChannel reste chiffré.
- Historique conservé localement dans IndexedDB sur chaque ordinateur. Les messages manquants sont synchronisés lors de la prochaine session, dans la limite des 400 derniers éléments synchronisés par échange.
- Envoi d’images dans les messages (jusqu’à 5 Mo avant compression).
- Avatar personnel et emojis importés depuis PNG, JPEG ou WebP.
- Fonctionne avec Windows, Linux et macOS sans dépendre du système de l’autre personne.

## Comment se déroule une conversation ?

1. La première personne ouvre Entre Nous et choisit **Créer une session**.
2. L’application crée un code aléatoire. Utilise le bouton **Copier** pour le transmettre à l’autre personne.
3. La deuxième personne ouvre Entre Nous, colle le code et choisit **Rejoindre**.
4. Les deux applications négocient la connexion. Une fois le secret vérifié, elles ouvrent le chat.
5. Les messages et les fichiers sont transférés entre les ordinateurs, sans passer par le service de mise en relation.

La personne qui crée la session lance l’offre WebRTC, mais ne devient pas un serveur central de messages : une fois la connexion établie, le canal est bidirectionnel. Si l’un des deux ferme son application ou perd sa connexion, la session s’interrompt ; l’historique local reste enregistré sur les deux machines. Recréez une session pour vous retrouver, et les historiques se synchroniseront.

## 1. Déployer le service minimal de mise en relation

Ce service doit être joignable depuis Internet. Il peut tourner sur un petit VPS Linux. Il n’héberge aucune conversation et n’a pas besoin d’une base de données.

### Prérequis

- Un nom de domaine ou sous-domaine, par exemple `signal.mondomaine.fr`.
- Un petit serveur Linux avec Docker et Docker Compose.
- Le DNS du sous-domaine pointant vers l’adresse IP publique du serveur.
- Les ports TCP 80 et 443 autorisés sur le pare-feu.

### Installation

Depuis la racine de ce projet, sur le serveur :

```bash
cp .env.example .env
```

Remplace `SIGNAL_DOMAIN` dans `.env` par ton domaine réel. Puis lance :

```bash
docker compose -f docker-compose.rendezvous.yml up -d --build
```

Caddy demande automatiquement un certificat TLS et renouvelle celui-ci. Le service WebSocket sera disponible à :

```text
wss://signal.mondomaine.fr/signal
```

Vérifie le service :

```bash
curl https://signal.mondomaine.fr/health
```

La réponse doit indiquer que le rendezvous est actif et qu’aucun message n’est stocké.

### Données vues par le service

Le service reçoit :

- l’identifiant temporaire de la salle (10 caractères), nécessaire pour retrouver l’invitation ;
- un vérificateur HMAC dérivé du secret, pour refuser une personne qui ne possède pas le bon code ;
- des descriptions SDP et candidats ICE nécessaires à la négociation WebRTC ;
- les connexions réseau des participants (adresse IP source visible par l’hébergeur).

Le secret de chiffrement (24 caractères aléatoires) n’est pas envoyé. Un vérificateur HMAC dérivé du secret est utilisé pour valider l’invitation sans transmettre le secret en clair. Aucun contenu de message, avatar, emoji ou fichier n’est transmis par ce service. Les salles sont gardées uniquement en mémoire et supprimées à la fermeture des sockets ou après 24 heures.

Le service utilise une limitation basique des tentatives par adresse IP et ne journalise pas les SDP ou les données échangées. Cela ne rend pas l’adresse IP invisible à l’hébergeur : elle est nécessaire pour établir une connexion Internet.

## 2. Configurer les deux applications

Sur chaque ordinateur :

1. Lance Entre Nous.
2. Ouvre **Paramètres** (icône engrenage).
3. Dans **Adresse du service**, entre la même adresse : `wss://signal.mondomaine.fr/signal`.
4. Clique sur **Enregistrer les paramètres**.
5. Crée ou rejoins une session.

### Connexion directe et relais facultatif

L’application tente une connexion directe avec STUN. Dans la plupart des réseaux domestiques, cela suffit. Certains réseaux d’entreprise, réseaux mobiles ou NAT stricts peuvent empêcher le P2P direct.

Dans ce cas, il faut disposer d’un serveur TURN et renseigner dans les paramètres :

- URL, par exemple `turns:turn.mondomaine.fr:5349` ;
- identifiant TURN ;
- mot de passe TURN.

Le relais TURN transporte les paquets chiffrés de WebRTC ; il ne reçoit pas les messages en clair. Aucun serveur TURN n’est fourni ou hébergé par défaut dans ce projet. Si aucun chemin direct ou relais TURN n’est disponible, la session ne pourra pas se connecter.

## 3. Créer les applications autonomes

Les ordinateurs des utilisateurs n’ont besoin d’aucune installation Node.js. Node.js et npm ne servent qu’à construire les packages.

Sur la machine de compilation, à la racine du projet :

```bash
npm install
```

Puis exécute la commande correspondant au système de compilation :

| Système de compilation | Commande | Résultat autonome |
|---|---|---|
| Windows x64 | `npm run dist:win` | Installateur `.exe` et `.exe` portable |
| Linux x64 | `npm run dist:linux` | `.AppImage` portable et paquet `.deb` |
| macOS | `npm run dist:mac` | `.dmg` et `.zip` contenant l’application universelle Intel + Apple Silicon |

Les fichiers sont placés dans `release/`.

- **Windows portable** : lance directement le fichier `Entre-Nous-2.0.0-win-portable.exe`. Aucun installateur n’est nécessaire ; le dossier `EntreNousData` créé à côté du fichier conserve le profil et l’historique.
- **Linux AppImage** : rends le fichier exécutable (`chmod +x Entre-Nous-*.AppImage`) puis double-clique dessus. Certaines distributions demandent la bibliothèque FUSE pour les AppImages ; quand le dossier de l’AppImage est accessible en écriture, `EntreNousData` y conserve le profil et l’historique.
- **macOS ZIP/DMG** : le ZIP contient l’application `.app`, et le DMG permet de la glisser dans Applications. Les données sont conservées dans le dossier utilisateur standard de macOS.

La compilation macOS doit être réalisée sur macOS. La compilation croisée n’est pas garantie pour toutes les versions du SDK Apple.

## 4. Construire les trois familles automatiquement avec GitHub Actions

Le workflow `.github/workflows/build-desktop.yml` construit chaque famille sur son propre système : Windows, Ubuntu et macOS.

1. Crée un dépôt GitHub privé et pousse le contenu de ce dossier.
2. Dans le dépôt, ouvre l’onglet **Actions**.
3. Sélectionne **Build Entre Nous desktop apps** puis **Run workflow**.
4. À la fin, télécharge les artefacts Windows, Linux et macOS.

Les artefacts sont conservés 14 jours par GitHub Actions. Il s’agit de fichiers portables/installeurs non signés.

### Avertissement sur les signatures

Les fichiers générés sans certificats de développeur peuvent déclencher Microsoft SmartScreen sur Windows ou Gatekeeper sur macOS. Ce n’est pas une alerte indiquant que le programme est un virus ; cela signifie simplement que l’application n’est pas signée/notariée par un éditeur identifié. Pour une distribution sans ces avertissements, il faut configurer une signature de code Windows et la signature/notarisation Apple.

## 5. Limites importantes

- Les deux personnes doivent être en ligne en même temps pour discuter en direct. Les messages sont synchronisés à la prochaine connexion, mais il n’y a pas de remise instantanée lorsque l’autre application est fermée.
- Le premier utilisateur qui crée la session initie la négociation, mais le trafic de chat est bidirectionnel et direct.
- STUN ne relaie pas les messages. En cas de NAT strict ou de pare-feu, un serveur TURN peut être nécessaire.
- Le service de rendez-vous peut voir les IP publiques et les métadonnées réseau de la négociation, mais pas le secret d’invitation ni le contenu chiffré.
- L’historique est local à chaque appareil. Il n’existe pas de sauvegarde cloud automatique ; sauvegarder le dossier de données de l’application sauvegarde aussi cet historique. Le chiffrement protège les échanges réseau, mais la base locale IndexedDB n’est pas chiffrée séparément au repos : protège le compte Windows/macOS/Linux qui contient ces données.
- Cette version gère texte, photos, avatars et emojis ; pas encore les appels audio/vidéo, les notifications natives ou la synchronisation des suppressions. Le chiffrement n’a pas fait l’objet d’un audit indépendant.
- Les emojis personnalisés sont transmis à l’autre appareil lorsqu’une session est connectée ou à la prochaine connexion. La synchronisation des suppressions d’emojis n’est pas encore implémentée.

## Arborescence

```text
entre-nous-p2p/
├── desktop/
│   ├── main.cjs                 # fenêtre Electron et préférences locales
│   ├── preload.cjs              # pont IPC restreint
│   ├── index.html               # interface de bureau
│   ├── style.css                # thème sombre
│   ├── app.js                   # WebRTC, chiffrement, messages et stockage local
│   └── assets/                  # icônes Windows, Linux et macOS
├── rendezvous/
│   ├── server.js                # serveur minimal de signalisation, sans stockage
│   ├── package.json
│   └── Dockerfile
├── docker-compose.rendezvous.yml
├── Caddyfile
├── .env.example
├── package.json
└── .github/workflows/build-desktop.yml
```
