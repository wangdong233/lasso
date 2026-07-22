<h1 align="center">Lasso</h1>

> Le « point d' prise de Claude Code pour tout ce qui est à l'extérieur » — rechercher, aspirer le web, aspirer les pages connectées, piloter le bureau, le tout en une seule phrase.
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
| « Récupère le texte de la page d'accueil github.com » | Du texte d'article propre (barres de nav / pubs / clutter retirés — 30 à 70 % de tokens en moins) |
| « Ouvre mon Jira connecté et montre-moi mes à-faire » | Un instantané de la page connectée (réutilise votre Chrome local ; vous gérez le 2FA vous-même) |
| « Ce lien est mort, trouve une archive » | L'instantané le plus récent de l'Internet Archive |
| « Liste les fichiers de ma fenêtre Finder actuelle » | Une liste des fenêtres et contrôles du bureau (un arbre sémantique, pas une capture d'écran) |
| « Fais une capture pleine page de cette page » / « Enregistre en PDF » | Un chemin de fichier sur le disque (pas de gros blob d'image balancé dans le chat) |
| « Quels traceurs tiers cette page a-t-elle chargés ? » | Une liste de ressources avec le compte par domaine traceur |
| « Liste tout ce que je peux contrôler là tout de suite » | Une seule liste unifiée (pages web et fenêtres du bureau tout dedans) |
| « Désactive le mode sombre » | Clic / frappe / raccourci clavier automatique (avec vérification du résultat — il confirme que c'est vraiment arrivé) |
| « Récupère juste ce endpoint JSON » | Des octets bruts (le plus rapide, le moins cher) |
| « Ce site a Cloudflare, je n'arrive pas à l'aspirer » | Contournement anti-bot via Chrome cloud (désactivé par défaut ; vous l'activez explicitement) |
| « Est-ce que Lasso est bien configuré ? » | Un rapport d'auto-diagnostic (vous dit ce qui manque) |

> Vous n'avez aucun nom de capacité à retenir. Dites simplement ce que vous voulez — Claude choisit la bonne façon de l'obtenir.

---

## 💰 Coût en un coup d'œil

Lasso lui-même est **totalement gratuit + MIT open source**. Voilà ce que chaque capacité coûte réellement :

| Capacité | Coût | Remarques |
|---|---|---|
| Lasso lui-même (serveur MCP + toutes les capacités cœur) | ✅ Gratuit | MIT open source, gratuit pour toujours |
| Recherche (Zhipu + Brave + Bing) | ✅ Palier gratuit disponible | Zhipu facturé au token ; Brave **2 000 requêtes/mois gratuites**, Bing **1 000 requêtes/mois gratuites** — utilisable sans payer |
| Aspirer des pages publiques / captures / PDF / audit réseau / octets bruts | ✅ Gratuit | Tourne en local, pas de clé, pas de paiement |
| Aspirer des pages connectées (réutilise Chrome local) | ✅ Gratuit | Tourne en local, pas de clé, pas de paiement |
| Piloter le bureau (macOS / Windows / Linux) | ✅ Gratuit | Construit et exécuté en local, seule une autorisation OS est nécessaire ; compte Apple Developer \$99/an **facultatif** pour une autorisation persistante signée (fonctionne aussi sans signature — il faut juste réautoriser à chaque fois) |
| Navigateur cloud (browserbase / stagehand) | ⚠️ Payant, désactivé par défaut | Payant après l'essai ; **ne coûte rien si vous ne le configurez pas** — le seul élément payant de Lasso |

> En une phrase : **tant que vous n'activez pas le navigateur cloud, Lasso ne coûte rien** — la recherche a des paliers gratuits suffisants pour un usage quotidien, et tout le reste est totalement gratuit.

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

### Aspirer des pages publiques (sans login)

> Vous : « Récupère le texte de example.com » → texte d'article propre, trois granularités disponibles

Retire automatiquement barres de navigation, pubs, barres latérales et autre clutter — **30 à 70 % de tokens économisés** (et de l'argent). Besoin de marqueurs de citation (parfait pour la recherche, alimenter du RAG) ? Une phrase change de mode.

### Aspirer des pages connectées (même avec 2FA)

> Vous : « Montre-moi mes à-faire Jira » → instantané de la page connectée

Réutilise **votre Chrome localement connecté** — vous gérez le 2FA une fois ; Lasso prend le relais. Fonctionne pour les dépôts GitHub privés, les intranets d'entreprise, le contenu sur abonnement payant, etc.

> 🔴 **Ligne rouge** : Lasso **ne résout jamais le 2FA / codes SMS / CAPTCHA / liens magiques à votre place**. Vous devez les passer vous-même une fois dans votre Chrome local.

### Récupérer les octets bruts (le plus rapide, le moins cher)

> Vous : « GET ce endpoint JSON » → octets bruts

Quand vous n'avez pas besoin de rendre une page complète, le HTTP direct est **~4× plus rapide et ~4× moins cher** que de passer par un navigateur. Détection automatique du type de contenu (JSON / texte / binaire).

### Capture / Archive

> Vous : « Fais une capture pleine page » / « Enregistre en PDF » → chemin de fichier sur disque

Toutes les images et PDFs sont **enregistrés sur disque et un chemin est renvoyé** — pas de gros blob balancé dans votre chat pour gaspiller le contexte.

### Voir ce qu'une page charge

> Vous : « Quels traceurs tiers cette page a-t-elle chargés ? » → liste de ressources avec compte par domaine traceur

Identifie automatiquement chaque ressource chargée par la page, groupée par domaine tiers — pratique pour repérer les risques de confidentialité et les goulots de performance.

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

**Complètement désactivé par défaut.** Ne s'active que lorsque vous l'allumez explicitement ET avez configuré une clé de navigateur cloud. Vous n'en avez pas besoin pour les pages normales.

---

## Installer

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
| Aspirer des sites protégés par Cloudflare | Double confirmation + une clé cloud | Désactivé par défaut ; nécessite votre opt-in explicite |

Ci-dessous, chacun des quatre modules est détaillé avec le chemin le plus court vers « ça marche, juste ».

### 1. Recherche (✅ Gratuit · palier gratuit ; une clé pour démarrer, trois pour quasi-zéro échec)

**Ce que ça fait** : Cherche n'importe quoi, renvoie des résultats structurés (titre, extrait, lien).

**Clé nécessaire** : Oui — une clé Zhipu (gratuite à demander) suffit.

**Comment configurer** :

```bash
lasso config init        # crée le modèle ~/.lasso/config.json
```

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

**Comment configurer** : Lancez la commande ci-dessous une fois. Elle détecte automatiquement votre Chrome local et réutilise chaque session à laquelle vous êtes déjà connecté (y compris celles où vous avez déjà passé le 2FA vous-même) :

```bash
lasso launch-chrome
```

Ensuite, dites « ouvre mon Jira connecté » à Claude et il se connectera automatiquement.

> 🔴 **Ligne rouge** : 2FA / codes SMS / CAPTCHA / liens magiques — Lasso ne les résout jamais pour vous. Vous devez les passer vous-même une fois dans votre Chrome local.

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

### 4. Anti-bot cloud (⚠️ Payant, désactivé par défaut · nécessite double confirmation)

**Ce que ça fait** : Aspire les sites gardés par Cloudflare ou une protection anti-bot lourde.

**Clé nécessaire** : Oui — et ne s'active que lorsque **vous l'allumez explicitement**.

**Comment configurer** : Les deux conditions doivent être réunies en même temps :

1. Interrupteur maître : mettre `LASSO_ALLOW_CLOUD_BROWSER` à `true`
2. Au moins une clé cloud (browserbase ou stagehand — choisissez-en une)

Écrivez-le dans `~/.lasso/config.json` :

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Désactivé par défaut — pas de config, pas de telle capacité. Vous n'en avez pas besoin pour les pages normales, **et elle ne s'active que lorsque vous optez explicitement**.

**Comment demander des clés cloud, quotas d'essai** → voir le [Guide de configuration des clés · Navigateur cloud](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Réglages avancés (facultatif — les utilisateurs ordinaires peuvent ignorer)</b></summary>

Vous pouvez **complètement ignorer** ce qui suit pour un usage quotidien. Ce ne sont que des scénarios spéciaux, et la plupart peuvent être définis via `lasso config init` dans `~/.lasso/config.json` ou surchargés via des variables d'environnement (les variables d'env prennent le pas sur le fichier de config, pratique pour des permutations temporaires) :

- Changer le port de débogage du Chrome connecté (quand le `9222` par défaut est pris)
- Déplacer les fichiers de cache / état vers un autre emplacement
- Restreindre aux sources de recherche gratuites uniquement
- Autoriser l'intranet d'entreprise / des plages de proxy spéciales
- Définir votre propre phrase de passe pour chiffrer les cookies de login (si non défini, le trousseau macOS est utilisé)
- Enregistrer les instantanés de résultats de recherche sur disque (pour les tests de régression)

Liste complète des variables et valeurs par défaut : [Guide de configuration des clés · Réglages avancés](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Les réseaux proxy Surge / Clash TUN (fake-ip) sont déjà autorisés nativement.**

> **Rétro-compatible** : si vous aviez précédemment installé avec `claude mcp add -e KEY=VAL`, ces variables d'env **fonctionnent toujours** et **surchargent** le fichier de config. Le fichier de config n'est qu'un chemin supplémentaire, plus convivial — il ne remplace pas les variables d'env.

</details>

---

## Confidentialité et sécurité

Vos données vous appartiennent.

- **Les cookies de login ne sont jamais exportés**, sauf si vous optez explicitement et les faites chiffrer sur disque. Lasso ne shippe jamais secrètement votre état de connexion nulle part.
- **Les journaux d'actions de bureau restent locaux** — zéro rapport distant. Lasso ne téléphone pas à la maison pour raconter ce que vous faites.
- **Le navigateur cloud est désactivé par défaut** — nécessite votre **double confirmation explicite** (interrupteur maître + clé) pour s'activer. Sans ça, la capacité n'existe effectivement pas.
- **Pas de résolution de 2FA / CAPTCHA / code de vérification** (ligne rouge). Ceux-ci exigent toujours que vous, en personne, les passiez une fois dans votre navigateur local.
- **Les étrangers ne peuvent pas sonder vos services internes** — l'accès au réseau interne est refusé par défaut ; les réseaux proxy Surge / Clash TUN sont déjà autorisés nativement.
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

## Licence

**MIT** © wangdong233. Le processus helper de bureau et les dépendances du moteur de navigateur sont toutes MIT / Apache-2.0 — sûr pour un usage en entreprise.

> Vous voulez l'architecture interne, les principes de conception, les frontières multi-plateformes et les commandes de dev ? Voir [ARCHITECTURE.md](./ARCHITECTURE.md) et [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Construit pour tous ceux qui préfèrent <strong>le dire</strong> plutôt que <strong>le coder</strong>.</sub><br>
  <sub>Installez une fois — recherche, aspiration, aspiration connectée, contrôle du bureau, tout en une seule phrase.</sub>
</p>
