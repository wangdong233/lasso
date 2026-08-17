<h1 align="center">Lasso</h1>

> Le « point de prise » de Claude Code pour tout ce qui est à l'extérieur — rechercher, aspirer le web, aspirer les pages connectées, piloter le bureau, le tout en une seule phrase.
> Le lasso du cowboy — capturer n'importe quelle interface.

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**Installez Lasso une seule fois pour Claude Code, et dès lors rechercher, aspirer des pages, aspirer des pages connectées et piloter le bureau ne font qu'une seule phrase.** Si chaque semaine vous cherchez, récupérez une page ou naviguez dans des applications de bureau — et que vous ne voulez pas d'un outil distinct pour chacune — installez ceci une fois et confiez tout à Claude.

Étoile jumelle de [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (le point de prise image) : « toutes les opérations image dans un seul MCP » ↔ « toutes les interactions externes dans un seul MCP ».

<div align="center">

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Français** | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

## Table des matières

- [Ce que vous dites, ce que vous obtenez](#ce-que-vous-dites-ce-que-vous-obtenez)
- [💰 Coût en un coup d'œil](#-coût-en-un-coup-dœil)
- [Démarrage en 60 secondes](#démarrage-en-60-secondes)
- [Ce que ça peut faire pour vous](#ce-que-ça-peut-faire-pour-vous)
- [Installer](#installer)
- [Configurer](#configurer)
- [Confidentialité et sécurité](#confidentialité-et-sécurité)
- [Dépannage](#dépannage)
- [À qui ça s'adresse / à qui non](#à-qui-ça-sadresse--à-qui-non)
- [Soutenir l'auteur](#soutenir-lauteur)
- [Licence](#licence)

---

## Ce que vous dites, ce que vous obtenez

| Vous dites… | Vous obtenez |
|---|---|
| « Cherche les dernières nouvelles sur l'écosystème async de rust » | Des résultats de recherche structurés (bascule automatiquement sur le moteur suivant si l'un est en panne — vous ne sentez rien) |
| « Cherche les mises à jour de Claude Code de la dernière semaine » (v1.11) | Des résultats filtrés dans le temps via `freshness=week` — plus de dates tapées à la main dans la requête |
| « Récupère le texte de la page d'accueil github.com » | Du texte d'article propre (barres de nav / pubs / clutter retirés — 30 à 70 % de tokens en moins ; 20+ sites à fort trafic passent par des extracteurs dédiés, les tableaux gardent leur structure — v1.12) |
| « Ouvre mon Jira connecté et montre-moi mes à-faire » | Un instantané de la page connectée (réutilise votre Chrome local ; vous gérez le 2FA vous-même) |
| « Ce lien est mort, trouve une archive » | L'instantané le plus récent de l'Internet Archive |
| « Liste les fichiers de ma fenêtre Finder actuelle » | Une liste des fenêtres et contrôles du bureau (un arbre sémantique, pas une capture d'écran ; si l'arbre est tronqué, il le dit clairement `truncated:true` — v1.12) |
| « Clique sur le bouton nouveau dossier » / « Tape XX dans le champ de recherche » (v1.11) | Une action de bureau réellement exécutée (clic / saisie sémantique AXAPI + vérification du résultat ; repli automatique en clic coordonné pour canvas / Electron) |
| « Fais une capture pleine page de cette page » / « Enregistre en PDF » | Un chemin de fichier sur le disque (pas de gros blob d'image balancé dans le chat) |
| « Quels traceurs tiers cette page a-t-elle chargés ? » | Une liste de ressources avec le compte par domaine traceur |
| « Liste tout ce que je peux contrôler là tout de suite » | Une seule liste unifiée (pages web et fenêtres du bureau tout dedans) |
| « Désactive le mode sombre » | Clic / frappe / raccourci clavier automatique (avec vérification du résultat — il confirme que c'est vraiment arrivé) |
| « Récupère juste ce endpoint JSON » | Des octets bruts (le plus rapide, le moins cher) |
| « Ce site semble avoir un peu d'anti-bot, essaye » | `browse_headless` embarque l'anti-détection (passe les vérifications de base) — beaucoup de sites s'aspirent directement, sans config |
| « Ce site a Cloudflare, je n'arrive pas à l'aspirer » | Contournement anti-bot via Chrome cloud — **Steel auto-hébergé (gratuit)** ou browserbase / stagehand (payant, désactivé par défaut) |
| « Est-ce que Lasso est bien configuré ? » | Un rapport d'auto-diagnostic (vous dit ce qui manque) |

> Vous n'avez aucun nom de capacité à retenir. Dites simplement ce que vous voulez — Claude choisit la bonne façon de l'obtenir.

---

## 💰 Coût en un coup d'œil

Lasso lui-même est **totalement gratuit + MIT open source**. Voilà ce que chaque capacité coûte réellement :

| Capacité | Coût | Remarques |
|---|---|---|
| Lasso lui-même (serveur MCP + toutes les capacités cœur) | ✅ Gratuit | MIT open source, gratuit pour toujours |
| Recherche (Zhipu + Brave + Bing) | ✅ Palier gratuit disponible | Zhipu facturé au token ; Brave **2 000 requêtes/mois gratuites**, Bing **1 000 requêtes/mois gratuites** — utilisable sans payer. **Le MCP `web-search-prime` de Zhipu est déjà configuré sur votre machine ? Lasso le détecte et le réutilise automatiquement — pas besoin de configurer un ZHIPU_API_KEY séparé** |
| Aspirer des pages publiques / captures / PDF / audit réseau / octets bruts | ✅ Gratuit | Tourne en local, pas de clé, pas de paiement |
| Aspirer des pages connectées (réutilise Chrome local) | ✅ Gratuit | Tourne en local, pas de clé, pas de paiement |
| Piloter le bureau (macOS / Windows / Linux) | ✅ Gratuit | Construit et exécuté en local, seule une autorisation OS est nécessaire ; compte Apple Developer \$99/an **facultatif** pour une autorisation persistante signée (fonctionne aussi sans signature — il faut juste réautoriser à chaque fois) |
| Navigateur cloud · Steel auto-hébergé (nouveauté v1.6) | ✅ Gratuit | Steel (open source Apache-2.0) dans un Docker local — **zéro coût par session + les cookies ne quittent jamais votre machine** ; nécessite `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| Navigateur cloud · hébergé (browserbase / stagehand) | ⚠️ Payant, désactivé par défaut | browserbase facturé à l'usage après l'essai ; stagehand est un canal expérimental programmatique (aucun outil MCP exposé) ; **ne coûte rien tant que vous ne le configurez pas** |
| Anti-détection `browse_headless` (nouveauté v1.5) | ✅ Gratuit | 16 couches d'anti-détection injectées par défaut (UA / webdriver / webgl, etc.) — passe beaucoup de vérifications de base toutes seules |

> En une phrase : **tant que vous n'activez pas le navigateur cloud hébergé (browserbase / stagehand), Lasso ne coûte rien** — la recherche a des paliers gratuits suffisants pour un usage quotidien, et le Steel auto-hébergé est gratuit aussi.

---

## Démarrage en 60 secondes

### 30 secondes · Installation en une ligne (zéro config)

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Redémarrez Claude Code → tapez `/mcp` → voyez `lasso ✓ Connected`. C'est tout. **Aucune clé dans la commande d'installation** — la configuration est une étape séparée (niveau suivant).

### 30 secondes · Sans rien configurer, vous pouvez déjà faire tout ça

Aucune clé nécessaire juste après l'installation (ceci est le **Tier 1 : zéro config**) :

- Aspirer le texte de n'importe quelle **page web publique**, converti en markdown propre
- **Captures pleines pages** et **enregistrement en PDF**, qui renvoient un chemin de fichier
- Voir **quels traceurs tiers une page charge**
- Récupérer les octets bruts directement depuis une API JSON ou un fichier
- Contrôler les applications natives macOS (Finder / Mail / Réglages Système, etc. — nécessite un clic unique dans les Réglages Système)

> 💡 **La recherche peut aussi marcher en zéro config** : si le `~/.claude.json` de votre machine a déjà le MCP `web-search-prime` de Zhipu configuré, Lasso le détecte et le réutilise au démarrage — pas besoin de `ZHIPU_API_KEY` séparé, la recherche fonctionne direct. Lancez `lasso doctor` et vérifiez que `#36 machine_search_mcp` est `pass`.

Votre première sortie — dites simplement à Claude :

> « Récupère le texte de example.com et convertis-le en markdown »

### Vous voulez plus ? Ajoutez-le dans le fichier de config (Tier 2)

- **Recherche** → lancez `lasso config init` pour créer `~/.lasso/config.json`, puis remplissez une clé Zhipu (voir [Configurer](#configurer))
- **Aspirer des pages connectées** (Jira / GitHub privé / intranet d'entreprise) → lancez `lasso launch-chrome` une fois
- **Contrôler le bureau macOS** → lancez `lasso doctor` une fois pour être guidé dans l'autorisation

Comment obtenir chaque clé, quels paliers gratuits existent — voir le [**Guide de configuration des clés**](./doc/KEY-GUIDE.md).

---

## Ce que ça peut faire pour vous

Groupé par **ce que vous voulez faire**, pas par nom d'outil. Chaque entrée : une phrase en, une phrase en sortie.

### Recherche

> Vous : « Cherche X » → résultats de recherche structurés

Zhipu par défaut (fort pour le chinois) ; vous pouvez ajouter Brave et Bing pour du multi-source. **Si l'une des sources atteint sa limite ou tombe en panne, bascule automatique sur la suivante — vous ne sentez rien.** Atteindre le quota gratuit d'un fournisseur ne casse pas l'ensemble.

Pour les contenus **d'actualité — nouvelles, mouvements de versions**, dites simplement « cherche le X de la dernière semaine / du dernier mois » : le filtre de fraîcheur s'applique automatiquement (day / week / month / year, pour tous les moteurs — seul Bing n'a pas de granularité annuelle et la saute, v1.11), sans écrire de dates à la main dans la requête.

### Aspirer des pages publiques (sans login)

> Vous : « Récupère le texte de example.com » → texte d'article propre, trois granularités disponibles

Retire automatiquement barres de navigation, pubs, barres latérales et autre clutter — **30 à 70 % de tokens économisés** (et de l'argent). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium et **plus de 20 sites à fort trafic passent par des extracteurs dédiés** ; tableaux et formules mathématiques gardent leur structure (v1.12) — et les liens dans le corps du texte sont des adresses absolues, complètes et cliquables. Besoin de marqueurs de citation (parfait pour la recherche, alimenter du RAG) ? Une phrase change de mode.

> **Depuis la v1.5, `browse_headless` active l'anti-détection par défaut** (UA maquillé / `navigator.webdriver` effacé / webgl, plugins, codecs falsifiés — une quinzaine de couches). **Aucune config — effet automatique** : beaucoup de sites « détecteurs de headless » s'aspirent maintenant directement (la v1.8 a réparé un défaut qui désactivait silencieusement l'injection — c'est maintenant réellement actif, et un échec d'injection est honnêtement signalé dans les logs). Depuis la v1.11, l'anti-détection s'applique **dès le lancement du navigateur** : UA, viewport et langue descendent du même profil — l'en-tête HTTP réseau et le JS de la page voient les mêmes valeurs, plus de contradiction ; depuis la v1.12, sur macOS l'empreinte par défaut **s'aligne sur votre système** (fini « l'UA dit Windows, les caractéristiques de la machine avouent macOS »). Seul l'anti-bot de niveau Cloudflare justifie le navigateur cloud (voir « Contournement anti-bot » ci-dessous). Envie de vérifier l'anti-détection ? Lancez `lasso doctor --stealth-check` pour une comparaison via creepjs.

### Aspirer des pages connectées (même avec 2FA)

> Vous : « Montre-moi mes à-faire Jira » → instantané de la page connectée

Réutilise **votre Chrome localement connecté** — vous gérez le 2FA une fois ; Lasso prend le relais. Fonctionne pour les dépôts GitHub privés, les intranets d'entreprise, le contenu sur abonnement payant, etc.

> 🔴 **Ligne rouge** : Lasso **ne résout jamais le 2FA / codes SMS / CAPTCHA / liens magiques à votre place**. Vous devez les passer vous-même une fois dans votre Chrome local.

### Récupérer les octets bruts (le plus rapide, le moins cher)

> Vous : « GET ce endpoint JSON » → octets bruts

Quand vous n'avez pas besoin de rendre une page complète, le HTTP direct est **~4× plus rapide et ~4× moins cher** que de passer par un navigateur. Détection automatique du type de contenu (JSON / texte / binaire).

### Capture / Archive

> Vous : « Fais une capture pleine page » / « Enregistre en PDF » → chemin de fichier sur disque

Toutes les images et PDFs sont **enregistrés sur disque et un chemin est renvoyé** — pas de gros blob balancé dans votre chat pour gaspiller le contexte. Les très gros volumes de texte (fetch_url / network, etc.) dépassant 48 KiB sont aussi automatiquement écrits sur disque, avec un aperçu + un handle de pagination `@oN` — à lire page par page avec l'outil `read_text` (appelable directement via MCP depuis la v1.8).

### Voir ce qu'une page charge

> Vous : « Quels traceurs tiers cette page a-t-elle chargés ? » → liste de ressources avec compte par domaine traceur

Identifie automatiquement chaque ressource chargée par la page, groupée par domaine tiers — pratique pour repérer les risques de confidentialité et les goulots de performance. Depuis la v1.11, la collecte passe par la couche réseau native du moteur du navigateur — **complète même derrière un proxy / réseau TUN**, et chaque ressource arrive avec sa méthode de requête et son code de statut.

### Piloter les applications de bureau natives

> Vous : « Désactive le mode sombre » / « Lis le premier élément de ma boîte Mail » → action automatisée (avec vérification)

Sur macOS vous pouvez piloter Finder / Mail / Safari / Notes / Réglages Système et toute application native. **Windows et Linux fonctionnent aussi** (voir la frontière honnête ci-dessous). Chaque action est vérifiée — il confirme « c'est vraiment arrivé », ne simule jamais un succès.

> **Frontière honnête** : macOS est vérifié sur du vrai matériel ; Windows / Linux passent les auto-tests à la compilation et au niveau contrat, mais les tests manuels complets sur machine réelle sont encore en cours. **Nous ne prétendons pas « entièrement vérifié sur Win/Linux » à tort.**

### Ordonnancement unifié entre web et bureau

> Vous : « Liste tout ce que je peux contrôler là tout de suite » → une seule liste unifiée

Les pages web et les fenêtres du bureau partagent une seule liste — vous n'avez pas à distinguer « ceci est dans le navigateur » vs « ceci est sur le bureau ». Claude choisit sur quoi agir, et tout découle de là.

### Réssusciter les liens morts

> Vous : « Ce lien est en 404 » → l'instantané le plus récent de l'Internet Archive

Va à l'Internet Archive (Wayback Machine) pour retrouver la dernière copie archivée de cette URL. **Ne traite jamais un lien vivant comme mort** — ne cherche que lorsque vous dites « celui-ci a disparu ».

### Contournement anti-bot (désactivé par défaut)

> Vous : « Ce site a Cloudflare, je n'arrive pas à l'aspirer » → Chrome cloud anti-bot

**Complètement désactivé par défaut.** Ne s'active que lorsque vous l'allumez explicitement ET avez configuré un navigateur cloud (Steel auto-hébergé ou browserbase / stagehand hébergé). L'anti-bot léger passe déjà grâce à l'anti-détection intégrée de `browse_headless` — **seule la protection de niveau Cloudflare justifie le navigateur cloud**.

- **Steel auto-hébergé (recommandé · gratuit)** : un navigateur cloud open source dans un Docker local — zéro coût par session, cookies qui ne quittent pas votre machine. Une commande pour l'ouvrir, voir [Guide de configuration des clés · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).
- **browserbase (hébergé · payant)** : à l'usage après l'essai — l'alternative quand vous ne voulez pas gérer Docker vous-même.
- **stagehand (hébergé · payant)** : ⚠️ canal expérimental programmatique — configurer la clé n'assemble qu'un canal interne, **sans outil MCP exposé** (contrat REST non vérifié ; `lasso doctor` #39 `stagehand_rest_contract_probe` teste précisément cela).

---

## Installer

**Version actuelle v1.13.0** (v1.13 : 7 ajustements de la couche d'implémentation (3ᵉ tour de revue d'optimalité) : **cohérence de l'empreinte linguistique du navigateur headless** — l'en-tête HTTP `Accept-Language` suit désormais le profil stealth (auparavant la valeur réelle de l'hôte était envoyée : sur une machine chinoise avec un profil anglais, on voyait la contradiction « en-tête zh-CN ↔ page en-US »), et `navigator.languages` devient lui aussi conscient du profil ; **correction du point d'impact des captures VLM avec région** — dans le scénario `screenshot_region`, les coordonnées déduites par le VLM sont reconverties en coordonnées plein écran (auparavant décalage systématique d'une origine de région, avec un succès déclaré à tort) ; **`desktop find` rejette les requêtes en ref pur** — `where` n'accepte que text / role, une requête ref pure renvoie honnêtement invalid_params (auparavant dégradation silencieuse en correspondance sur tout l'arbre, explosion de tokens et succès simulé) ; **sortie plus rapide et plus stable** — la libération de session Steel reçoit une borne supérieure de 3 secondes (quand un Steel auto-hébergé est à l'arrêt, la sortie de CC ne reste plus bloquée jusqu'à 5 minutes) ; en cas de permission de synthèse d'entrée macOS manquante pour le scénario VLM, message explicite « autorisation requise » au lieu d'un échec vague ; v1.12 : 14 ajustements de la couche d'implémentation (2ᵉ tour de revue d'optimalité) : **double activation de l'extraction markdown** — extracteurs dédiés par site defuddle (HN / Reddit / GitHub / Wikipedia / Substack / Medium, etc., plus de 20 sites) + conversion fidèle des structures tableaux / maths (les tables GFM ne perdent plus leur structure ; les liens relatifs deviennent absolus ; la sortie peut contenir des dialectes Obsidian comme `==surlignage==` ou les notes `[^N]`) ; **empreinte par défaut du navigateur headless alignée sur le système hôte** — sur macOS, empreinte macOS Chrome par défaut (élimine la contradiction « l'UA dit Windows, les client hints avouent macOS » ; doctor signale l'écart de version avec le Chrome installé) ; **honnêteté en bout de chaîne desktop** — l'inférence par capture VLM ne ment plus sur le succès (exécute vraiment si possible, sinon unknown honnête), `wait/expect` exige deux touches consécutives (les éléments fugaces au chargement ne donnent plus de faux succès), `snapshot` signale `truncated:true` au sommet quand il tronque, `find` attache aux nœuds trouvés la liste des actions exécutables ; **correctif des champs de saisie Electron** — pour les contrôles qui avalent AXSetValue (Slack / VSCode, etc.), type bascule automatiquement en « focus + synthèse clavier » (ASCII) ; **le glisser-déposer devient utilisable** — appui 200 ms + trajectoire interpolée en 12 points + stabilisation 100 ms (sliders et tri par glisser passent d'un échec probable à utilisable) ; **cohérence de bout en bout de freshness** — machine_mcp et le repli DuckDuckGo ne suppriment plus silencieusement le paramètre de fraîcheur ; à la sortie anormale de CC, le processus Lasso fait son ménage immédiatement (auparavant suspension jusqu'à 1 heure) ; v1.11 « la prise universelle » complète la dimension implémentation : **le bureau passe de « voir » à « cliquer »** — click / type / scroll de `desktop` atterrissent pour de vrai (clic sémantique AXAPI + vérification écriture-lecture + erreur honnête sur référence périmée), avec en plus des actions souris coordonnées (glisser / molette / déplacer, repli canvas / Electron) et l'élagage d'arbre `skeleton` (forte baisse de tokens sur les apps denses) ; **couche pilote mise à niveau chrome-devtools-mcp 0.3.0 → 1.7.0** (11 mois et 57 versions de bénéfices ; anti-détection au niveau lancement UA / viewport ; télémétrie amont désactivée par défaut) ; **search gagne le filtre temporel `freshness`** (day / week / month / year transmis à tous les moteurs — plus de dates tapées à la main dans les requêtes pour suivre actus / versions) ; le repli sans clé pour les requêtes anglaises passe de Baidu à DuckDuckGo ; nouveau `LASSO_PROXY`, proxy de sortie navigateur (n'affecte que les navigateurs headless / cloud — la sortie du Chrome connecté ne bouge pas) ; v1.10 navigateur silencieux par défaut + fermeture après usage : `launch-chrome` démarre par défaut sans fenêtre et sans déranger (adapté macOS / Windows, `--mode visible` pour revenir en arrière), toujours avec anti-throttling en arrière-plan et muet ; pendant l'exécution du serveur, fermeture automatique ~60 s après la dernière utilisation (`LASSO_LAUNCH_IDLE_MS` réglable, la sémantique 5 minutes reste disponible avec 300000) ; v1.9 rajoute la fin de vie du navigateur : recyclage automatique du navigateur headless après 5 minutes d'inactivité, `lasso chrome-stop` ferme selon le registre les Chrome lancés par Lasso, `tab_restore` restaure votre liste d'onglets d'origine — voir « Nettoyage après usage » ci-dessus ; v1.8 a corrigé les 24 défauts exposés par le test complet : adaptation au contrat amont chrome-devtools-mcp@0.3.0, captures réellement écrites sur disque, sonde de vie launch-chrome, câblage des quotas par appel, outil de pagination `read_text`, etc. — liste complète dans [doc/17-功能测试清单.md](doc/17-功能测试清单.md), section « v1.8 修复记录 ».)

**Prérequis** : Node.js ≥ 20 ; Claude Code (ou tout client compatible MCP).

```bash
# Claude Code (recommandé)
claude mcp add lasso -- npx -y lasso-mcp
```

Redémarrez Claude Code → `/mcp` → `lasso ✓ Connected`. **C'est tout — aucune clé dans la commande d'installation.** Navigation / captures / PDF / contrôle du bureau fonctionnent immédiatement (la recherche est la seule exception — voir [Configurer](#configurer)).

**Utilisateurs macOS voulant le contrôle du bureau** : lancez `lasso doctor` une fois et suivez les invites pour cocher `lasso-rust-helper` sous « Réglages Système → Confidentialité et sécurité » à la fois pour Accessibilité et pour Capture d'écran (`doctor` vous guide — pas besoin de chercher le chemin vous-même).

---

## Configurer

**L'installation est zéro config** — la commande d'installation ci-dessus active déjà navigation / récupération / captures / PDF / inspection des ressources tierces / contrôle du bureau. **Seule la recherche nécessite une clé.**

### Cherchez par ce que vous voulez faire

| Ce que vous voulez | Ce qu'il faut configurer | Ce que ça débloque |
|---|---|---|
| Aspirer des pages publiques / captures / PDF / voir les traceurs / récupérer des octets bruts / piloter le bureau | **Rien** | Fonctionne dès l'installation |
| Recherche | Une clé Zhipu (gratuite à demander) | L'entrée de recherche principale |
| Quasi-zéro échec de recherche (multi-source) | Ajouter des clés Brave / Bing (les deux ont des paliers gratuits) | Bascule auto si l'un tombe — vous ne sentez rien |
| Aspirer des pages connectées | Lancer `lasso launch-chrome` une fois | Réutilise votre session Chrome locale |
| Piloter le bureau macOS | Lancer `lasso doctor` une fois | Piloter les applications natives |
| Aspirer des sites protégés par Cloudflare | Double confirmation + un canal navigateur cloud (Steel auto-hébergé gratuit / hébergé payant) | Désactivé par défaut ; nécessite votre opt-in explicite |

Ci-dessous, chacun des quatre modules est détaillé avec le chemin le plus court vers « ça marche, juste ».

### 1. Recherche (✅ Gratuit · palier gratuit ; une clé pour démarrer, trois pour quasi-zéro échec)

**Ce que ça fait** : Cherche n'importe quoi, renvoie des résultats structurés (titre, extrait, lien).

**Clé nécessaire** : Oui — mais si votre machine a déjà le MCP `web-search-prime` de Zhipu configuré (dans le `mcpServers` du `~/.claude.json` local, type=http + Authorization), **Lasso le détecte au démarrage et réutilise sa clé comme première source — pas besoin de ZHIPU_API_KEY séparé**. Si le MCP machine est limité ou en échec, repli automatique sur la clé propre de Lasso (à remplir ci-dessous). Lancez `lasso doctor` : `#36 machine_search_mcp` affiche `pass` (host=open.bigmodel.cn) ou `warn` (non détecté).

> Ordre de priorité zéro config : réutilisation du MCP machine → `ZHIPU_API_KEY` de Lasso → Brave → Bing → repli `browse_headless`. Le premier qui échoue cède la place au suivant — vous ne sentez rien.

**Comment configurer** (utile seulement si le MCP machine n'existe pas / pour une clé indépendante) :

```bash
lasso config init        # crée le modèle ~/.lasso/config.json
lasso --version          # affiche le numéro de version (dès la v1.8)
lasso --help             # usage de toutes les sous-commandes
```

> Depuis la v1.8, la ligne de commande suit les conventions habituelles : sous-commande ou paramètre inconnu → affiche l'usage et sort avec un code non nul ; fini le mode serveur MCP silencieux qui se met à attendre une entrée.

Ouvrez `~/.lasso/config.json` et remplissez :

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key"
}
```

**Vous voulez plus de robustesse** (hautement recommandé) : ajoutez Brave et Bing aussi — les deux ont des paliers gratuits. Si une source atteint sa limite ou tombe, bascule automatique sur la suivante et vous ne sentez rien :

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

> Séparez plusieurs clés par des virgules — N clés vous donnent N× le quota gratuit, rotation automatique.

Les noms de clé correspondent à ce qui est écrit dans le tableau ci-dessus — remplissez-les simplement. Enregistrez le fichier ; Lasso le prend en compte au prochain démarrage.

**Comment demander des clés, quotas des paliers gratuits, détails de rotation multi-clés** → voir le [Guide de configuration des clés · Recherche](./doc/KEY-GUIDE.md#a-搜索).

### 2. Aspirer des pages connectées (✅ Gratuit · pas de clé, une seule commande à lancer)

**Ce que ça fait** : Aspire les pages auxquelles vous êtes connecté — à-faire Jira, dépôts GitHub privés, intranets d'entreprise, contenu sur abonnement payant.

**Clé nécessaire** : Non.

**Comment configurer** : Lancez la commande ci-dessous une fois. Elle trouve automatiquement votre Chrome local et le démarre avec un port de débogage. Depuis la v1.8, Lasso utilise par défaut son **profil dédié** (Chrome 136+ interdit le port de débogage sur le profil par défaut — l'ancienne méthode se fermait aussitôt) ; connectez vos comptes une première fois dans cette fenêtre (2FA à votre charge), ensuite **la session de ce profil est réutilisée en continu** :

```bash
lasso launch-chrome
```

Au démarrage, Lasso sonde le port de débogage (vérification de type `curl /json/version`) : Chrome absent / port occupé → **erreur explicite**, fini le « succès annoncé mais connexion impossible ». Pour réutiliser un dossier de profil existant : `lasso launch-chrome --profile <dossier>`.

**Depuis la v1.10, « travail silencieux » par défaut** : ce Chrome démarre **sans fenêtre, sans voler votre clavier / focus, toujours muet** — vous codez au premier plan, il aspire en arrière-plan, sans se gêner (la seule trace perceptible est une icône Chrome en plus dans le Dock / la barre des tâches, impossible à retirer au niveau de l'OS). Pour le voir travailler : `lasso launch-chrome --mode visible` (ou `"LASSO_LAUNCH_MODE": "visible"` dans `~/.lasso/config.json`).

Ensuite, dites « ouvre mon Jira connecté » à Claude et il se connectera automatiquement.

> 🔴 **Ligne rouge** : 2FA / codes SMS / CAPTCHA / liens magiques — Lasso ne les résout jamais pour vous. Vous devez les passer vous-même une fois dans votre Chrome local.

**Nettoyage après usage (depuis la v1.10, presque plus rien à gérer)** : pendant que le serveur tourne, ce Chrome **se ferme automatiquement ~60 s après sa dernière utilisation** (fermé quand plus utilisé — rien à attendre, rien à retenir). Pour régler le seuil : `LASSO_LAUNCH_IDLE_MS=300000` pour revenir à 5 minutes, `=1000` pour du quasi-instantané (au prix d'un redémarrage à froid de ~11 s pour des opérations espacées), `=0` pour désactiver la fermeture auto. Pour une longue tâche ponctuelle : `lasso launch-chrome --idle-ms 3600000`. Fermeture manuelle possible à tout moment (seulement les Chrome lancés par Lasso, propriété vérifiée — jamais vos navigateurs ouverts à la main) :

```bash
lasso chrome-stop          # ferme tous les Chrome lancés par Lasso (registre)
lasso chrome-stop --port 9222   # ferme uniquement celui du port indiqué
```

> Frontière honnête : `lasso launch-chrome` lancé seul (hors serveur) n'a pas de fermeture idle automatique — la sortie reste `chrome-stop` ; `browse_logged_in` connecté à **votre Chrome visible ouvert par vous-même** est « peu intrusif, pas zéro intrusion » (limitation amont de la plateforme macOS — certaines actions peuvent prendre le focus une fois) — pour du purement silencieux, utilisez le mode hidden lancé par lasso ou `browse_headless` ; le canal `desktop` simule clavier / souris réels, **il occupe par conception le clavier et la souris physiques**, pas de forme silencieuse.

Les onglets ouverts par `browse_logged_in` dans votre Chrome : à la fin de la tâche, dites `admin {action:"tab_restore", reason:"tâche terminée"}` — les onglets ouverts par Lasso se ferment et votre liste d'onglets d'origine est restaurée (fait aussi automatiquement à la sortie du serveur). Le navigateur headless, lui, est **recyclé automatiquement après 5 minutes sans usage** — il ne reste pas en mémoire ; pour économiser les démarrages à froid en usage intensif, `LASSO_HEADLESS_IDLE_MS=3600000` (1 heure) ; `0` désactive complètement.

**Détails** → [Guide de configuration des clés · Navigation connectée](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Piloter le bureau (✅ Gratuit · pas de clé, autoriser une fois dans votre OS)

**Ce que ça fait** : Pilote les applications natives sur macOS / Windows / Linux (clic, frappe, lecture du contenu des fenêtres, raccourcis clavier).

**Clé nécessaire** : Non.

**Comment configurer** (choisissez votre OS) :

- **macOS** : Lancez `lasso doctor` une fois et suivez les invites pour cocher `lasso-rust-helper` sous « Réglages Système → Confidentialité et sécurité » à la fois pour **Accessibilité** et pour **Capture d'écran**. `doctor` vous guide — pas besoin de chercher le chemin.
- **Windows** : La première fois que vous demandez à Claude une action de bureau, le système affiche une invite d'autorisation — cliquez « Autoriser » (équivalent à l'Accessibilité macOS).
- **Linux** : Assurez-vous que l'interface d'accessibilité est installée (la plupart des bureaux GNOME / MATE l'ont par défaut ; sinon, `sudo apt install at-spi2-core`).

> **Frontière honnête** : macOS est vérifié sur du vrai matériel ; Windows / Linux passent les auto-tests à la compilation et au niveau contrat, mais les tests manuels complets sur machine réelle sont encore en cours. **Nous ne prétendons pas « entièrement vérifié sur Win/Linux » à tort.**

**Détails** → [Guide de configuration des clés · Contrôle du bureau](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Navigateur cloud : auto-hébergé ou hébergé (auto-hébergé gratuit / hébergé payant, désactivé par défaut · double confirmation requise)

**Ce que ça fait** : Aspire les sites bloqués par Cloudflare ou un anti-bot lourd (l'anti-bot léger passe déjà avec l'anti-détection intégrée de `browse_headless` — ceci ne concerne que le lourd).

**Clé nécessaire** : Ça dépend du chemin. Trois canaux cloud au choix — **seul le chemin hébergé demande une clé** :

- **(a) Steel auto-hébergé (recommandé · gratuit)** : un navigateur cloud open source dans un Docker local — **zéro coût par session + cookies qui ne quittent jamais votre machine**. Aucune clé à demander ; lancez simplement Docker.
- **(b) browserbase hébergé (payant)** : 100 minutes d'essai, puis facturation à l'usage.
- **(c) stagehand hébergé (payant)** : observation de page adaptée à l'IA, plutôt pour l'essai. ⚠️ **Canal expérimental programmatique** — même avec une clé, **aucun outil MCP n'est exposé** (contrat REST non vérifié à l'exécution, `lasso doctor` #39 teste spécifiquement cela) ; pour franchir réellement l'anti-bot, préférez Steel ou browserbase.

**Comment configurer** : Les deux conditions doivent être réunies en même temps :

1. Interrupteur maître : mettre `LASSO_ALLOW_CLOUD_BROWSER` à `true`
2. Au moins un canal cloud — Steel (définir `STEEL_ENDPOINT`) ou browserbase (la clé correspondante) ; une clé stagehand n'assemble que le canal expérimental interne, sans exposer d'outil

**Config minimale · Steel auto-hébergé (gratuit, recommandé)** :

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

Steel démarre en une commande Docker : `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`. Étapes complètes d'ouverture dans [Guide de configuration des clés · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).

**Config minimale · browserbase hébergé (payant)** :

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Désactivé par défaut — pas de config, pas de telle capacité. Vous n'en avez pas besoin pour les pages normales, **et elle ne s'active que lorsque vous optez explicitement**. L'anti-bot léger n'a nullement besoin du navigateur cloud — l'anti-détection intégrée de `browse_headless` suffit.

**Comment demander des clés hébergées, comment ouvrir Steel Docker** → voir le [Guide de configuration des clés · Navigateur cloud](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Réglages avancés (facultatif — les utilisateurs ordinaires peuvent ignorer)</b></summary>

Vous pouvez **complètement ignorer** ce qui suit pour un usage quotidien. Ce ne sont que des scénarios spéciaux, et la plupart peuvent être définis via `lasso config init` dans `~/.lasso/config.json` ou surchargés via des variables d'environnement (les variables d'env prennent le pas sur le fichier de config, pratique pour des permutations temporaires) :

- Changer le port de débogage du Chrome connecté (quand le `9222` par défaut est pris)
- Déplacer les fichiers de cache / état vers un autre emplacement
- Restreindre aux sources de recherche gratuites uniquement
- Autoriser l'intranet d'entreprise / des plages de proxy spéciales
- Définir votre propre phrase de passe pour chiffrer les cookies de login (si non défini, le trousseau macOS est utilisé)
- Enregistrer les instantanés de résultats de recherche sur disque (pour les tests de régression)
- Régler le recyclage automatique du navigateur headless (`LASSO_HEADLESS_IDLE_MS`, 5 minutes par défaut ; `0` pour désactiver)
- Régler la fermeture « après usage » du Chrome de launch-chrome (`LASSO_LAUNCH_IDLE_MS`, 60 secondes par défaut ; `300000` pour 5 minutes, `0` pour désactiver) ou revenir au démarrage visible (`LASSO_LAUNCH_MODE=visible`)
- Configurer un proxy de sortie pour les navigateurs (`LASSO_PROXY`, p. ex. `http://127.0.0.1:7890` ; **n'affecte que les navigateurs headless et le Steel cloud — la sortie du Chrome connecté reste toujours inchangée** — v1.11)
- Définir l'endpoint du navigateur cloud Steel auto-hébergé (`STEEL_ENDPOINT`, p. ex. `http://localhost:3000` ; nécessite aussi `LASSO_ALLOW_CLOUD_BROWSER=true` pour s'activer)

Liste complète des variables et valeurs par défaut : [Guide de configuration des clés · Réglages avancés](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Les réseaux proxy TUN type Surge / Clash (fake-ip, `198.18.0.0/15`) et `127.0.0.1` (le port de débogage CDP du Chrome local) sont déjà autorisés nativement**, sans configuration supplémentaire — c'est un comportement voulu, pas un oubli de config.

> **Rétro-compatible** : si vous aviez précédemment installé avec `claude mcp add -e KEY=VAL`, ces variables d'env **fonctionnent toujours** et **surchargent** le fichier de config. Le fichier de config n'est qu'un chemin supplémentaire, plus convivial — il ne remplace pas les variables d'env.

</details>

---

## Confidentialité et sécurité

Vos données vous appartiennent.

- **Les cookies de login ne sont jamais exportés**, sauf si vous optez explicitement et les faites chiffrer sur disque. Lasso ne shippe jamais secrètement votre état de connexion nulle part.
- **Les journaux d'actions de bureau restent locaux** — zéro rapport distant. Lasso ne téléphone pas à la maison pour raconter ce que vous faites.
- **Le navigateur cloud est désactivé par défaut** — nécessite votre **double confirmation explicite** (interrupteur maître + clé) pour s'activer. Sans ça, la capacité n'existe effectivement pas.
- **Pas de résolution de 2FA / CAPTCHA / code de vérification** (ligne rouge). Ceux-ci exigent toujours que vous, en personne, les passiez une fois dans votre navigateur local.
- **Les étrangers ne peuvent pas sonder vos services internes** — l'accès au réseau interne est refusé par défaut ; les réseaux proxy Surge / Clash TUN sont déjà autorisés nativement, sans configuration supplémentaire.
- **Les résultats de recherche ne sont pas écrits sur disque par défaut** — uniquement si vous activez explicitement le mode enregistrement (pour les tests de régression).

---

## Dépannage

**Pour tout problème, la première étape est toujours `lasso doctor`.** Il s'auto-vérifie et vous dit ce qui est mal configuré.

| Symptôme | Que faire |
|---|---|
| Le contrôle du bureau macOS ne fonctionne pas | Cochez `lasso-rust-helper` sous « Réglages Système → Confidentialité et sécurité → Accessibilité / Capture d'écran » (`lasso doctor` vous guide) |
| L'aspiration de page connectée échoue | Connectez-vous une fois manuellement dans votre Chrome local (gérez aussi le 2FA), puis dites « ouvre mon X connecté » |
| L'enregistrement en PDF échoue | Dites plutôt « fais une capture pleine page de cette page » |
| La recherche ne renvoie toujours rien | Vérifiez si la clé a expiré / le quota est épuisé ; ajouter plusieurs fournisseurs (Zhipu + Brave + Bing) réduit fortement le taux d'échec |
| Un lien ne s'ouvre pas | Dites « ce lien est mort, trouve une archive » pour interroger l'Internet Archive |
| Invite indiquant que l'accès au réseau interne a été bloqué | Vérifiez l'URL ; les réseaux proxy TUN sont autorisés par défaut, les autres réseaux internes nécessitent une permission explicite |
| Envie de vérifier l'anti-détection | Lancez `lasso doctor --stealth-check` — il pilote la page de détection creepjs et compare à la ligne de base (optionnel, sans impact sur l'usage quotidien) |

FAQ complète et astuces de débogage dans [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

---

## À qui ça s'adresse / à qui non

**Pour**

- **Gros utilisateurs de Claude Code** — recherche, aspiration et contrôle du bureau chaque semaine, sans vouloir installer un MCP distinct pour chacun
- **Chercheurs / rédacteurs de rapports / gens de données** — chercher, récupérer du texte propre, ressusciter des liens morts, de bout en bout
- **Ceux qui construisent du RAG / des bases de connaissances** — pages web vers markdown propre, avec marqueurs de citation, économisant tokens et argent
- **Gens d'automatisation / DevOps** — piloter les applications natives macOS, aspirer des tableaux de bord internes connectés
- **Quiconque aspire souvent des pages connectées** — réutilise la session Chrome locale, pas besoin de re-stocker des identifiants dans la config

**Pas pour**

- **Ceux qui n'utilisent pas Claude Code ou un autre client MCP** — Lasso est un service MCP et a besoin d'un client MCP pour le piloter
- **Ceux qui n'ont besoin que d'une seule capacité et ont déjà une solution dédiée** — le tout-en-un peut être redondant
- **Ceux qui cherchent à contourner le 2FA / CAPTCHA** — ligne rouge ; nous ne le faisons pas, et ne le ferons pas.

---

## Soutenir l'auteur

Si Lasso vous aide, offrez un café à l'auteur ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat sponsor QR"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay sponsor QR">

</div>

Ou ⭐ [Mettre une étoile au dépôt](../../stargazers), [ouvrir une Issue](../../issues), ou [envoyer une PR](../../pulls) — chacun d'entre eux encourage l'auteur.

---

## Plus de documentation

- Envie de l'architecture en profondeur ? Voir [Architecture fonctionnelle](doc/08-media-interact-功能架构.md)
- Envie de la feuille de route des versions ? Voir [Planning d'implémentation](doc/09-media-interact-实施排期.md)
- Envie de l'obtention des clés ? Voir [Guide de configuration des clés](doc/KEY-GUIDE.md)

## Licence

**MIT** © wangdong233. Le processus helper de bureau et les dépendances du moteur de navigateur sont toutes MIT / Apache-2.0 — sûr pour un usage en entreprise.

> Vous voulez l'architecture interne, les principes de conception, les frontières multi-plateformes et les commandes de dev ? Voir [ARCHITECTURE.md](./ARCHITECTURE.md) et [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Construit pour tous ceux qui préfèrent <strong>le dire</strong> plutôt que <strong>le coder</strong>.</sub><br>
  <sub>Installez une fois — recherche, aspiration, aspiration connectée, contrôle du bureau, tout en une seule phrase.</sub>
</p>
