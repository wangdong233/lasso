<h1 align="center">Lasso</h1>

> Claude Codes „Griff für alles da draußen" — suchen, Webseiten scrapen, eingeloggte Seiten scrapen, den Desktop steuern, alles in einem Satz.
> Cowboy-Lasso — leg den Lasso um jede Oberfläche.

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**Installiere Lasso einmal für Claude Code, und von da an sind Suchen, Scrapen, Scrapen von eingeloggten Seiten und die Desktop-Steuerung alles in einem einzigen Satz erledigt.** Wenn du jede Woche suchst, eine Seite holst oder in Desktop-Apps herumklickst — und dafür nicht jeweils ein separates Werkzeug willst — installiere das hier einmal und übergib alles an Claude.

Zwilling von [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (der Bild-Griff): „jede Bild-Operation in einem MCP" ↔ „jede externe Interaktion in einem MCP".

<div align="center">

[简体中文](README.md) | [English](README.en.md) | **Deutsch** | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

## Inhaltsverzeichnis

- [Was du sagst, was du bekommst](#was-du-sagst-was-du-bekommst)
- [💰 Kosten auf einen Blick](#-kosten-auf-einen-blick)
- [60-Sekunden-Start](#60-sekunden-start)
- [Was es für dich tun kann](#was-es-für-dich-tun-kann)
- [Installation](#installation)
- [Konfigurieren](#konfigurieren)
- [Datenschutz & Sicherheit](#datenschutz--sicherheit)
- [Fehlerbehebung](#fehlerbehebung)
- [Für wen / Nicht für wen](#für-wen--nicht-für-wen)
- [Den Autor unterstützen](#den-autor-unterstützen)
- [Lizenz](#lizenz)

---

## Was du sagst, was du bekommst

| Du sagst …… | Du bekommst |
|---|---|
| „Suche nach dem Neuesten zum Rust-Async-Ökosystem" | Strukturierte Suchergebnisse (wechselt automatisch zur nächsten Engine, falls eine ausfällt — du merkst nichts davon) |
| „Suche nach Claude-Code-Updates der letzten Woche" (v1.11) | Zeitgefilterte Ergebnisse via `freshness=week` — keine handgeschriebenen Daten in der Anfrage |
| „Hol mir den Text der github.com-Startseite" | Sauberer Artikeltext (Navigationsleisten / Werbung / Schnickschnack entfernt — spart 30–70 % Tokens; 20+ stark frequentierte Sites bekommen dedizierte Extraktoren, Tabellen behalten ihre Struktur — v1.12) |
| „Öffne mein eingeloggt Jira und zeig meine To-dos" | Ein Snapshot der eingeloggten Seite (nutzt dein lokales Chrome; 2FA machst du selbst) |
| „Dieser Link ist tot, find ein Archiv" | Den aktuellsten Snapshot aus dem Internet Archive |
| „Liste die Dateien in meinem aktuellen Finder-Fenster auf" | Eine Liste der Desktop-Fenster und -Steuerelemente (ein semantischer Baum, kein Screenshot; meldet beim Abschneiden des Baums ehrlich `truncated:true` — v1.12) |
| „Klick auf den Button ‚Neuer Ordner'" / „Tippe XX ins Suchfeld" (v1.11) | Desktop-Aktionen werden wirklich ausgeführt (AXAPI-semantisches Klicken/Tippen + Ergebniserklärung; bei Canvas/Electron automatischer Rückfall auf Koordinatenklicks) |
| „Mach einen Ganzseiten-Screenshot von dieser Seite" / „Als PDF speichern" | Ein Dateipfad auf der Festplatte (kein riesiger Bild-Datenberg im Chat) |
| „Welche Drittanbieter-Tracker hat diese Seite geladen?" | Eine Ressourcenliste mit Zählungen pro Tracker-Domain |
| „Liste alles, was ich gerade steuern kann" | Eine einzige vereinheitlichte Liste (Webseiten und Desktop-Fenster zusammen drin) |
| „Mach den Dark Mode aus" | Automatischer Klick / Tippen / Hotkey (mit Ergebniserklärung — es bestätigt, dass es wirklich passiert ist) |
| „Hol einfach diesen JSON-Endpoint" | Rohe Bytes (am schnellsten, am günstigsten) |
| „Diese Seite scheint etwas Anti-Bot zu haben, probier's mal" | `browse_headless` hat eingebaute Anti-Erkennung (besteht einfache Bot-Checks) — viele Sites lassen sich direkt scrapen, ohne Konfiguration |
| „Diese Seite hat Cloudflare, ich kann sie nicht scrapen" | Cloud-Chrome-Anti-Bot — **Steel selbst gehostet (kostenlos)** oder browserbase/stagehand (kostenpflichtig, standardmäßig aus) |
| „Ist Lasso richtig eingerichtet?" | Ein Health-Check-Bericht (sagt dir, was fehlt) |

> Du musst dir keine Fähigkeitsnamen merken. Sag einfach, was du willst — Claude wählt den richtigen Weg, es zu erledigen.

---

## 💰 Kosten auf einen Blick

Lasso selbst ist **komplett kostenlos + MIT-Open-Source**. Hier ist, was jede Fähigkeit tatsächlich kostet:

| Fähigkeit | Kosten | Hinweise |
|---|---|---|
| Lasso selbst (MCP-Server + alle Kernfähigkeiten) | ✅ Kostenlos | MIT-Open-Source, für immer kostenlos |
| Suche (Zhipu + Brave) | ✅ Kostenloser Start mit Zhipu | Zhipu wird pro Token abgerechnet (Neukunden erhalten Startguthaben); ist auf der Maschine schon das Zhipu-MCP konfiguriert, ist es ohne jede Konfiguration nutzbar. Brave ist inzwischen ein bezahlter Plan mit \$5/Monat Guthaben (das kostenlose Kontingent entfiel ab 2026-02); Lasso bringt außerdem einen kostenlosen Live-Such-Fallback mit — auch ganz ohne konfigurierten Anbieter hast du Suche |
| Öffentliche Seiten scrapen / Screenshots / PDF / Netzwerk-Audit / rohe Bytes | ✅ Kostenlos | Läuft lokal, kein Key, keine Zahlung |
| Eingeloggte Seiten scrapen (lokales Chrome wiederverwenden) | ✅ Kostenlos | Läuft lokal, kein Key, keine Zahlung |
| Desktop steuern (macOS / Windows / Linux) | ✅ Kostenlos | Lokal gebaut und ausgeführt, nur OS-Autorisierung nötig; **optionaler** Apple Developer Account 99 $/Jahr für signierte dauerhafte Autorisierung (funktioniert auch ohne Signierung — dann einfach jedes Mal neu autorisieren) |
| Cloud-Browser · selbst gehostetes Steel (v1.6 neu) | ✅ Kostenlos | Steel (Apache-2.0 Open Source) im lokalen Docker betreiben — **null Kosten pro Session + Cookies verlassen nie deine Maschine**; benötigt `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| Cloud-Browser · gehostet (browserbase / stagehand) | ⚠️ Kostenpflichtig, standardmäßig aus | browserbase nach Testphase nutzungsabhängig; stagehand ist ein programmatischer Experimentalkanal (kein MCP-Werkzeugeingang); **unkonfiguriert kostet es nichts** |
| `browse_headless` Anti-Erkennung (v1.5 neu) | ✅ Kostenlos | Injiziert standardmäßig 16 Anti-Erkennungs-Schichten (UA / webdriver / webgl usw.) — besteht viele einfache Bot-Checks direkt ohne Konfiguration |

> In einem Satz: **Solange du den gehosteten Cloud-Browser (browserbase/stagehand) nicht aktivierst, kostet Lasso durchgehend null** — die Suche hat kostenlose Kontingente, die für die tägliche Nutzung reichen, und selbst gehostetes Steel ist ebenfalls kostenlos.

---

## 60-Sekunden-Start

### 30 Sekunden · Einzeilige Installation (Zero Config)

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Claude Code neu starten → `/mcp` eingeben → `lasso ✓ Connected` sehen. Fertig. **Keine Keys im Installationsbefehl** — die Konfiguration ist ein separater Schritt (nächste Stufe).

### 30 Sekunden · Ohne jegliche Konfiguration kannst du schon all das

Direkt nach der Installation brauchst du keine Keys (das ist **Stufe 1: Zero Config**):

- Den Text jeder **öffentlichen Webseite** scrapen, in sauberes Markdown umgewandelt
- **Ganzseitige Screenshots** und **Als-PDF-speichern**, die einen Dateipfad zurückgeben
- Sehen, **welche Drittanbieter-Tracker eine Seite lädt**
- Rohe Bytes direkt von einer JSON-API oder Datei holen
- Native macOS-Apps steuern (Finder / Mail / Systemeinstellungen usw. — erfordert einmaligen Haken in den Systemeinstellungen)

> 💡 **Auch die Suche kann ohne Konfiguration funktionieren**: Wenn in deinem `~/.claude.json` bereits Zhipus `web-search-prime` MCP eingetragen ist, erkennt und nutzt Lasso es beim Start automatisch — du musst nicht mal einen separaten `ZHIPU_API_KEY` anlegen, die Suche funktioniert einfach. Führ `lasso doctor` aus und schau, ob `#36 machine_search_mcp` auf `pass` steht.

Deine erste Ausgabe — sag einfach zu Claude:

> „Hol den Text von example.com und mach Markdown daraus"

### Mehr gewollt? Füg es in die Config-Datei ein (Stufe 2)

- **Suche** → führ `lasso config init` aus, um `~/.lasso/config.json` zu erstellen, dann fülle einen Zhipu-Key ein (siehe [Konfigurieren](#konfigurieren))
- **Eingeloggte Seiten scrapen** (Jira / privates GitHub / Firmen-Intranet) → führ einmal `lasso launch-chrome` aus
- **Den macOS-Desktop steuern** → führ einmal `lasso doctor` aus, um durch die Autorisierung geführt zu werden

Wie du jeden Key bekommst, welche kostenlosen Kontingente es gibt — siehe den [**Key-Konfigurationsleitfaden**](./doc/KEY-GUIDE.md).

---

## Was es für dich tun kann

Gruppiert nach **dem, was du tun willst**, nicht nach Werkzeugname. Jedes ist ein Satz rein, ein Satz raus.

### Suche

> Du: „Suche nach X" → strukturierte Suchergebnisse

Standard ist Zhipu (stark für Chinesisch); für Multiple-Quellen kannst du zusätzlich Brave konfigurieren (der Bing-Upstream ist eingestellt — der Konfigurationsschlüssel bleibt erhalten und wird automatisch übersprungen). **Wenn eine einzelne Quelle rate-limitiert oder down ist, wird automatisch zur nächsten gewechselt — du merkst nichts davon.** Das Ausschöpfen des kostenlosen Kontingents eines Anbieters bringt nicht das Ganze zum Absturz.

Für zeitkritisches Material wie **Nachrichten und Release-Tracking** sag einfach „suche nach X der letzten Woche / des letzten Monats" — der Zeitfilter (day / week / month / year, v1.11) wird automatisch mitgegeben, ohne handgeschriebene Daten in der Anfrage.

### Öffentliche Seiten scrapen (ohne Login)

> Du: „Hol mir den Text von example.com" → sauberer Artikeltext, drei Granularitäten verfügbar

Entfernt automatisch Navigationsleisten, Werbung, Sidebars und anderen Schnickschnack — **spart 30–70 % Tokens** (und Geld). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium und weitere **stark frequentierte Sites — insgesamt 20+ — bekommen dedizierte Extraktoren**, sodass auch Tabellen und Mathe-Formeln ihre Struktur behalten (v1.12) — und jeder Link im Text ist eine vollständig klickbare absolute Adresse. Brauchst du Zitatmarker (top für Recherche, zum Füttern von RAG)? Ein Satz schaltet den Modus um.

> **Seit v1.5 hat `browse_headless` standardmäßig Anti-Erkennung aktiv** (getarnter UA / `navigator.webdriver` entfernt / gefälschte webgl-, plugins- und codecs-Werte sowie gut ein Dutzend weitere Schichten). **Keine Konfiguration — automatisch.** Viele „erkennen Headless"-Sites lassen sich jetzt direkt scrapen (v1.8 behob einen Defekt, bei dem die Injektion stumm wirkungslos blieb — sie greift jetzt wirklich, und fehlgeschlagene Injektionen werden ehrlich im Log gemeldet). Seit v1.11 greift die Anti-Erkennung **bereits auf Browser-Startebene**: UA, Viewport und Sprache werden einheitlich aus dem Profil bezogen — der HTTP-Header der Netzwerkschicht und das Seiten-JS sehen dieselben Werte, kein Widerspruch mehr. Seit v1.12 passt der Standard-Fingerabdruck unter macOS **zu deinem System** (kein „UA sagt Windows, Maschinen-Merkmale verraten macOS" mehr). Nur Cloudflare-schwerer Anti-Bot braucht den Cloud-Browser (siehe „Anti-Bot-Bypass" unten). Willst du die Wirkung der Anti-Erkennung prüfen? Führ `lasso doctor --stealth-check` für einen creepjs-Erkennungsvergleich aus.

### Eingeloggte Seiten scrapen (auch mit 2FA)

> Du: „Zeig mir meine Jira-To-dos" → Snapshot der eingeloggten Seite

Nutzt **dein lokal eingeloggt Chrome** — du machst die 2FA einmal; Lasso übernimmt den Rest. Funktioniert für private GitHub-Repos, Firmen-Intranets, Content mit kostenpflichtigem Abo usw.

> 🔴 **Rote Linie**: Lasso **löst niemals 2FA / SMS-Codes / CAPTCHA / Magic Links für dich**. Du musst diese einmal manuell in deinem lokalen Chrome bestehen.

### Rohe Bytes holen (am schnellsten, am günstigsten)

> Du: „GET diesen JSON-Endpoint" → rohe Bytes

Wenn du keine vollständige Seite rendern musst, ist direktes HTTP **~4× schneller und ~4× günstiger** als der Weg über den Browser. Erkennt automatisch den Content-Type (JSON / Text / Binär).

### Screenshot / Archiv

> Du: „Mach einen Ganzseiten-Screenshot" / „Als PDF speichern" → Dateipfad auf der Festplatte

Alle Bilder und PDFs werden **auf der Festplatte gespeichert und ein Pfad zurückgegeben** — kein riesiger Datenberg im Chat, der den Kontext verbraucht. Auch übergroße Textausgaben (fetch_url / network usw.) jenseits von 48 KiB werden automatisch auf die Festplatte geschrieben und geben eine Vorschau plus ein `@oN`-Fortsetzungs-Handle zurück — blätter dich mit dem `read_text`-Werkzeug seitenweise durch (seit v1.8 direkt über MCP aufrufbar).

### Sehen, was eine Seite lädt

> Du: „Welche Drittanbieter-Tracker hat diese Seite geladen?" → Ressourcenliste mit Zählungen pro Tracker-Domain

Erkennt automatisch jede Ressource, die die Seite lädt, gruppiert nach Drittanbieter-Domain — praktisch, um Privacy-Risiken und Performance-Engpässe zu erkennen. Seit v1.11 läuft die Ressourcenerfassung direkt über die native Netzwerkschicht der Browser-Engine — **auch unter Proxy-/TUN-Netzwerken vollständig** — und jede Ressource trägt ihre HTTP-Methode und ihren Statuscode.

### Native Desktop-Apps steuern

> Du: „Mach den Dark Mode aus" / „Lies den ersten Eintrag in meinem Mail-Posteingang" → automatisierte Aktion (mit Verifikation)

Auf macOS kannst du Finder / Mail / Safari / Notes / Systemeinstellungen und jede native App steuern. **Windows und Linux funktionieren ebenfalls** (siehe die ehrliche Grenze unten). Jede Aktion wird verifiziert — sie bestätigt „es ist wirklich passiert", sie täuscht nie Erfolg vor.

> **Ehrliche Grenze**: macOS ist auf echter Hardware verifiziert; Windows / Linux bestehen Compile-Zeit- und Contract-Level-Selbstchecks, aber vollständiges manuelles Testen auf echten Maschinen läuft noch. **Wir tun nicht so, als wäre Win/Linux „vollständig verifiziert".**

### Vereinheitlichte Planung über Web und Desktop

> Du: „Liste alles, was ich gerade steuern kann" → eine vereinheitlichte Liste

Webseiten und Desktop-Fenster teilen sich eine Liste — du musst nicht zwischen „das ist im Browser" und „das ist auf dem Desktop" unterscheiden. Claude wählt aus, worauf es wirkt, und alles fließt von dort.

### Tote Links wiederbeleben

> Du: „Dieser Link 404t" → der aktuellste Internet-Archive-Snapshot

Geht zum Internet Archive (Wayback Machine), um die zuletzt archivierte Kopie dieser URL zu finden. **Es behandelt nie einen Live-Link als tot** — es schaut nur nach, wenn du sagst „das ist weg".

### Anti-Bot-Bypass (standardmäßig aus)

> Du: „Diese Seite hat Cloudflare, ich kann sie nicht scrapen" → Cloud-Chrome-Anti-Bot

**Standardmäßig komplett aus.** Aktiviert sich nur, wenn du es explizit einschaltest UND einen Cloud-Browser konfiguriert hast (selbst gehostetes Steel oder gehostetes browserbase/stagehand). Leichter Anti-Bot wird bereits von `browse_headless`' eingebauter Anti-Erkennung handled — **nur Cloudflare-schwerer Schutz braucht den Cloud-Browser**.

- **Steel selbst gehostet (empfohlen · kostenlos)**: einen Open-Source-Cloud-Browser im lokalen Docker betreiben — null Kosten pro Session, Cookies verlassen nie deine Maschine. Mit einem Befehl eingerichtet, siehe [Key-Leitfaden · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).
- **browserbase (gehostet · kostenpflichtig)**: nach Testphase nutzungsabhängig; die Alternative, wenn du kein Docker selbst betreiben willst.
- **stagehand (gehostet · kostenpflichtig)**: ⚠️ programmatischer Experimentalkanal — ein konfigurierter Key bestückt nur einen internen Kanal, **es gibt keinen MCP-Werkzeugeingang** (der REST-Vertrag ist unverifiziert; `lasso doctor` #39 `stagehand_rest_contract_probe` testet genau das).

---

## Installation

**Aktuelle Version v1.13.0** (Changelog im eingeklappten Block am Ende dieses Abschnitts).

Voraussetzungen: Node.js ≥ 20 + Claude Code (oder jeder MCP-fähige Client).

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Claude Code neu starten → `/mcp` → `lasso ✓ Connected`. **Genau diese eine Zeile, ganz ohne Key** — nach der Installation funktionieren Scrapen / Screenshots / PDF / Desktop-Steuerung sofort; nur die Suche braucht optional einen Key (siehe [Konfigurieren](#konfigurieren)).

**macOS-Nutzer, die den Desktop steuern wollen**: führ einmal `lasso doctor` aus und setze `lasso-rust-helper` nach Anweisung die Haken bei „Bedienungshilfen" und „Bildschirmaufnahme" — `doctor` führt dich Schritt für Schritt.

<details>
<summary>📋 Changelog (v1.8 → v1.13 — aufklappen, um zu sehen, was jede Version geändert hat)</summary>

- **v1.13**: konsistenter Sprach-Fingerabdruck des Headless-Browsers (HTTP-`Accept-Language` wird mit dem Profil mitgegeben; der Widerspruch „Header zh-CN ↔ Seite en-US" ist beseitigt); korrigierter VLM-Landepunkt bei Regions-Screenshots; `desktop find` lehnt reine ref-Abfragen ab; Freigeben von Steel-Sessions mit 3-Sekunden-Grenze (hängendes Steel blockiert den Exit nicht mehr 5 Minuten lang).
- **v1.12**: doppelt aktivierte Markdown-Extraktion (defuddle-Extraktoren für 20+ Sites + Tabellen-/Mathe-Treue); macOS-Standard-Fingerabdruck ans Host-System angeglichen; ehrliche Endkette am Desktop (VLM täuscht keinen Erfolg vor / expect braucht zwei aufeinanderfolgende Treffer / `truncated:true`-Signal); Electron-Eingabefelder lassen `type` automatisch zurückfallen; Drag-Interpolation wird nutzbar; sofortiges Aufräumen bei abnormalem Claude-Code-Exit.
- **v1.11**: Desktop geht von „zuschauen" zu „handeln" (click/type/scroll wirklich implementiert + Koordinaten-Maus + `skeleton`-Beschneidung); Treiberschicht auf chrome-devtools-mcp 1.7.0 aktualisiert (Anti-Erkennung auf Start-Ebene, Telemetrie standardmäßig aus); Suche bekommt den `freshness`-Zeitfilter; englischer Zero-Key-Fallback wechselt zu DuckDuckGo; neuer `LASSO_PROXY`-Egress-Proxy.
- **v1.10**: Browser standardmäßig still + fertig-zu (`launch-chrome`-Start ohne Fenster, ~60 s nach Nutzung automatisch zu, mit `--mode visible` zurückholbar).
- **v1.9**: Browser-Lebenszyklus-Nacharbeit (Headless wird nach 5 Minuten Leerlauf automatisch recycelt, `lasso chrome-stop`, `tab_restore` stellt die ursprüngliche Tab-Liste wieder her).
- **v1.8**: die 24 beim vollständigen Feldtest aufgedeckten Defekte behoben (Upstream-Vertragsanpassung, Screenshots landen wirklich auf der Festplatte, `read_text`-Fortsetzung usw.) — vollständige Liste im „v1.8-Fixprotokoll" von [doc/17-功能测试清单.md](doc/17-功能测试清单.md).

</details>

---

## Konfigurieren

**Nur die Suche braucht einen Key — alles andere funktioniert direkt nach der Installation.** Such in der Tabelle nach, was du brauchst:

| Was du tun willst | Was zu konfigurieren ist |
|---|---|
| Öffentliche Seiten scrapen / Screenshots / PDF / Drittanbieter-Ressourcen ansehen / rohe Bytes holen / Desktop steuern | **Gar nichts** |
| Suchen | Ein Zhipu-Key (kostenlos zu beantragen; hat die Maschine das Zhipu-MCP schon, nicht einmal das) |
| Suche fällt fast nie aus | Zusätzlich einen Brave-Key (bezahlter Plan mit \$5/Monat Guthaben; auch ohne ihn gibt es einen kostenlosen Live-Such-Fallback) |
| Eingeloggte Seiten scrapen | Einmal `lasso launch-chrome` ausführen |
| Den macOS-Desktop steuern | Einmal `lasso doctor` zur Autorisierung ausführen |
| Cloudflare-geschützte Seiten scrapen | Master-Schalter + Steel (kostenlos selbst gehostet) / browserbase (kostenpflichtig) |

Die folgenden vier Module geben jeweils die kürzeste Konfiguration zum „läuft einfach"; Details sind eingeklappt und lassen sich aufklappen.

### 1. Suche (✅ Kostenlos · das einzige Modul, das einen Key braucht)

**Prüf zuerst, ob du überhaupt konfigurieren musst**: Wenn auf deiner Maschine bereits Zhipus `web-search-prime` MCP konfiguriert ist, **erkennt und nutzt Lasso dessen Key automatisch** — nichts auszufüllen. Führ `lasso doctor` aus: Steht `#36 machine_search_mcp` auf `pass`, ist genau das der Fall.

**Zum Konfigurieren drei Schritte**:

```bash
lasso config init        # erstellt ~/.lasso/config.json
```

```json
{ "ZHIPU_API_KEY": "your_zhipu_key" }
```

Speichern genügt, dann greift es. **Stabiler gewollt**: füge zusätzlich Brave hinzu (bezahlter Plan mit \$5/Monat Guthaben ≈ 1.000 Anfragen, Kreditkarte erforderlich — das kostenlose Kontingent entfiel ab 2026-02; fällt eine konfigurierte Quelle aus, wird automatisch zur nächsten gewechselt; mehrere Keys kommagetrennt, jeder mit eigenem Kontingent):

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2",
  "BING_API_KEYS": "bingkey1"
}
```

> Degradationsreihenfolge: Maschinen-MCP-Wiederverwendung → Zhipu → Brave → (Bing eingestellt, wird automatisch übersprungen) → Live-Suche im Headless-Browser als Schluss-Fallback. Fällt der vordere aus, wird automatisch zum nächsten gewechselt.

Wie du Keys beantragst, wie hoch die kostenlosen Kontingente sind → [Key-Konfigurationsleitfaden · Suche](./doc/KEY-GUIDE.md#a-搜索). Häufige Befehle: `lasso --version` / `lasso --help` (seit v1.8 drucken unbekannte Befehle die Nutzung und beenden mit Nonzero-Code, statt stumm zu hängen).

### 2. Eingeloggte Seiten scrapen (✅ Kostenlos · ein Befehl, kein Key)

```bash
lasso launch-chrome
```

Melde dich beim ersten Mal in diesem Fenster bei deinen Konten an (2FA machst du selbst), **danach wird die Anmeldung dauerhaft wiederverwendet**. Später genügt „öffne mein eingeloggt Jira" zu Claude.

- Arbeitet standardmäßig **still und ohne Fenster**, klaut nie den Fokus und ist immer stummgeschaltet; mit `--mode visible` kannst du zusehen
- **Schließt sich ~60 s nach der letzten Nutzung selbst** — du musst dir das Aufräumen nicht merken; manuell schließen jederzeit mit `lasso chrome-stop`
- Tabs, die es in deinem Chrome öffnet, stellst du nach der Aufgabe mit `admin {action:"tab_restore", reason:"erledigt"}` wieder zur ursprünglichen Liste zurück (das Gleiche passiert automatisch beim Server-Exit)

> 🔴 **Rote Linie**: 2FA / Bestätigungscodes / CAPTCHA — Lasso löst sie nicht für dich; du gehst sie im Fenster einmal manuell durch.

<details>
<summary>Details: Profil-Wiederverwendung / belegter Port / Tuning / Grenzen der Stille</summary>

- Seit v1.8 wird standardmäßig Lassos eigenes, separates Profil verwendet (Chrome 136+ verbietet den Debug-Port beim Standardprofil — der alte Weg würde sofort abstürzen); ein bestehendes Profil nutzt du mit `lasso launch-chrome --profile <Verzeichnis>`.
- Nach dem Start wird der Debug-Port automatisch geprüft; kam Chrome nicht hoch oder ist der Port belegt, gibt es einen klaren Fehler statt vorgetäuschten Erfolgs.
- Auto-Schluss-Schwelle: `LASSO_LAUNCH_IDLE_MS` (Standard 60000; `300000` zurück auf 5 Minuten; `0` deaktiviert). Eine einzelne lange Aufgabe durchlassen: `--idle-ms 3600000`.
- Der Headless-Browser wird nach 5 Minuten Leerlauf automatisch recycelt (`LASSO_HEADLESS_IDLE_MS` einstellbar/abschaltbar).
- Ehrliche Grenze: Beim eigenständigen `lasso launch-chrome` (ohne Server) gibt es keinen Leerlauf-Autoschluss — der Ausgang bleibt `chrome-stop`; verbindet sich `browse_logged_in` mit **deinem eigenen sichtbaren Chrome**, ist das „geringe Störung, keine null Störung" (macOS-Plattformbeschränkung — einzelne Operationen können einmal den Fokus ziehen) — für absolute Stille nimm die Hidden-Stufe oder `browse_headless`; `desktop` simuliert echte menschliche Tastatur und Maus und belegt physische Tastatur/Maus by design — eine stille Form gibt es nicht.
- chrome-stop schließt nur die von Lasso selbst gestarteten Chromes, mit verifizierter Zugehörigkeit — nie deine manuell geöffneten Browser.

</details>

**Details** → [Key-Konfigurationsleitfaden · Eingeloggtes Browsen](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Den Desktop steuern (✅ Kostenlos · einmal autorisieren, kein Key)

- **macOS**: führ `lasso doctor` aus und setze `lasso-rust-helper` nach Anweisung die Haken bei „Bedienungshilfen" + „Bildschirmaufnahme"
- **Windows**: Bei der ersten Desktop-Aktion wirft das System ein Autorisierungsfenster auf — klick „Zulassen"
- **Linux**: Installiere die Accessibility-Schnittstelle (GNOME/MATE haben sie standardmäßig; falls nicht, `sudo apt install at-spi2-core`)

> Ehrliche Grenze: macOS ist in echter Umgebung verifiziert; Windows / Linux bestehen Compile- und Contract-Level-Selbstchecks, vollständiges manuelles Testen auf echten Maschinen läuft noch — kein Vortäuschen von „vollständig verifiziert".

**Details** → [Key-Konfigurationsleitfaden · Desktop-Steuerung](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Cloud-Browser (standardmäßig aus · nur bei schwerem Anti-Bot nötig)

Leichter Anti-Bot wird bereits von der eingebauten Anti-Erkennung von `browse_headless` geschafft — **brauchst du ihn nicht, lass es unkonfiguriert**. Einschalten nur für Anti-Bot vom Cloudflare-Niveau; nötig sind gleichzeitig Master-Schalter + ein Kanal:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

- **Steel selbst gehostet (empfohlen · kostenlos)**: ein Docker-Befehl — `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`; null Kosten pro Session, Cookies verlassen nie deine Maschine
- **browserbase gehostet (kostenpflichtig)**: stattdessen `"BROWSERBASE_API_KEY": "your_key"` setzen — die Alternative, wenn du kein Docker betreiben willst
- ⚠️ stagehand: programmatischer Experimentalkanal ohne MCP-Werkzeugeingang — verlass dich nicht darauf, damit Seiten zu scrapen

**Wie du Keys beantragst, komplette Steel-Einrichtungsschritte** → [Key-Konfigurationsleitfaden · Cloud-Browser](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Erweiterte Tuning-Optionen (optional — normale Nutzer können das überspringen)</b></summary>

Du kannst das Folgende für die tägliche Nutzung **komplett ignorieren**. Das hier ist nur für spezielle Szenarien, und das meiste lässt sich über `lasso config init` in `~/.lasso/config.json` setzen oder per Umgebungsvariable überschreiben (Umgebungsvariablen haben Vorrang vor der Config-Datei, praktisch für temporäre Wechsel):

- Den Debug-Port des eingeloggten Chrome ändern (wenn der Standard `9222` belegt ist)
- Die Cache- / Zustandsdateien an einen anderen Ort verschieben
- Auf kostenlose Suchquellen beschränken
- Firmen-Intranet / spezielle Proxy-Ranges zulassen
- Eigene Passphrase festlegen, um Login-Cookies zu verschlüsseln (falls nicht gesetzt, wird der macOS Keychain verwendet)
- Snapshots der Suchergebnisse auf die Festplatte speichern (für Regressionstests)
- Die Leerlauf-Autorecycling-Zeit des Headless-Browsers anpassen (`LASSO_HEADLESS_IDLE_MS`, Standard 5 Minuten; `0` deaktiviert)
- Die „fertig-genutzt"-Zeit des von launch-chrome gestarteten Chrome anpassen (`LASSO_LAUNCH_IDLE_MS`, Standard 60 s; `300000` stellt 5 Minuten wieder her, `0` deaktiviert) oder zurück auf sichtbaren Start schalten (`LASSO_LAUNCH_MODE=visible`)
- Ein Egress-Proxy für Browser (`LASSO_PROXY`, z. B. `http://127.0.0.1:7890`; **betrifft nur den Headless-Browser und den Steel-Cloud-Browser — der Egress deines eingeloggten Chrome bleibt immer unverändert** — v1.11)
- Den Endpoint des selbst gehosteten Steel-Cloud-Browsers setzen (`STEEL_ENDPOINT`, z. B. `http://localhost:3000`; zur Aktivierung zusätzlich `LASSO_ALLOW_CLOUD_BROWSER=true` nötig)

Vollständige Variablenliste und Defaults: [Key-Konfigurationsleitfaden · Erweitertes Tuning](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Surge-/Clash-TUN-Proxy-Netzwerke (fake-ip, `198.18.0.0/15`) und `127.0.0.1` (wird vom CDP-Debug-Port des lokalen Chrome genutzt) sind out-of-the-box bereits erlaubt** — keine zusätzliche Konfiguration nötig. Das ist Design, keine Fehlkonfiguration.

> **Abwärtskompatibel**: Falls du zuvor mit `claude mcp add -e KEY=VAL` installiert hast, funktionieren diese Env-Variablen **weiterhin** und **überschreiben** die Config-Datei. Die Config-Datei ist nur ein zusätzlicher, freundlicherer Weg — sie ersetzt Env nicht.

</details>

---

## Datenschutz & Sicherheit

Deine Daten gehören dir.

- **Login-Cookies werden nie exportiert**, es sei denn, du stimmst explizit zu und lässt sie verschlüsselt auf der Festplatte ablegen. Lasso schickt deinen Login-Zustand niemals heimlich irgendwohin.
- **Desktop-Aktionsprotokolle bleiben lokal** — null Remote-Reporting. Lasso telefoniert nicht nach Hause darüber, was du tust.
- **Cloud-Browser ist standardmäßig aus** — erfordert deine **explizite doppelte Bestätigung** (Master-Schalter + Key) zur Aktivierung. Ohne das existiert die Fähigkeit faktisch nicht.
- **Kein Lösen von 2FA / CAPTCHA / Bestätigungscodes** (rote Linie). Diese erfordern immer dich, in Person, einmal in deinem lokalen Browser.
- **Fremde können nicht an deinen internen Diensten stochern** — Zugriff auf das interne Netzwerk ist standardmäßig verweigert; Surge-/Clash-TUN-Proxy-Netzwerke sind out-of-the-box bereits erlaubt.
- **Suchergebnisse werden standardmäßig nicht auf die Festplatte geschrieben** — nur wenn du den Aufzeichnungsmodus explizit aktivierst (für Regressionstests).

---

## Fehlerbehebung

**Bei jedem Problem ist Schritt eins immer `lasso doctor`.** Es prüft sich selbst und sagt dir, was falsch konfiguriert ist.

| Symptom | Was zu tun |
|---|---|
| macOS-Desktop-Steuerung funktioniert nicht | Setze einen Haken bei `lasso-rust-helper` unter „Systemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen / Bildschirmaufnahme" (`lasso doctor` führt dich) |
| Scrapen der eingeloggten Seite schlägt fehl | Einmal manuell in deinem lokalen Chrome einloggen (auch 2FA machen), dann „öffne mein eingeloggt X" sagen |
| Als-PDF-speichern schlägt fehl | Sag stattdessen „mach einen Ganzseiten-Screenshot von dieser Seite" |
| Suche liefert immer wieder nichts | Prüfe, ob der Key abgelaufen / das Kontingent erschöpft ist; mehrere Anbieter hinzufügen (Zhipu + Brave) senkt die Fehlerrate drastisch |
| Ein Link lässt sich nicht öffnen | Sag „dieser Link ist tot, find ein Archiv", um das Internet Archive zu prüfen |
| Meldung, dass der Zugriff auf das interne Netzwerk blockiert wurde | URL doppelt prüfen; TUN-Proxy-Netzwerke sind standardmäßig erlaubt, andere interne Netzwerke brauchen explizite Erlaubnis |
| Die Wirkung der Anti-Erkennung verifizieren | `lasso doctor --stealth-check` ausführen — treibt die creepjs-Erkennungsseite an und vergleicht mit einer Baseline (optional, beeinflusst den Alltag nicht) |

Vollständige FAQ und Debugging-Tipps in [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

---

## Für wen / Nicht für wen

**Für**

- **Intensive Claude-Code-Nutzer** — jede Woche suchen, scrapen und den Desktop steuern, und nicht für jedes eine separate MCP installieren wollen
- **Forscher / Berichtschreiber / Datenleute** — suchen, sauberen Text holen, tote Links wiederbeleben, Ende-zu-Ende
- **Leute, die RAG / Wissensbasen bauen** — Webseiten zu sauberem Markdown, mit Zitatmarkern, spart Tokens und Geld
- **Automatisierungs-/DevOps-Leute** — macOS-native Apps steuern, eingeloggte interne Dashboards scrapen
- **Jeden, der oft eingeloggte Seiten scrapt** — die lokale Chrome-Sitzung wiederverwenden, keine Credentials in der Config neu ablegen

**Nicht für**

- **Leute, die Claude Code oder einen anderen MCP-Client nicht nutzen** — Lasso ist ein MCP-Service und braucht einen MCP-Client, der es ansteuert
- **Leute, die nur eine einzige Fähigkeit brauchen und bereits eine dedizierte Lösung haben** — das All-in-One kann überflüssig sein
- **Leute, die 2FA / CAPTCHA umgehen wollen** — rote Linie; das machen wir nicht, und werden es nicht tun.

---

## Den Autor unterstützen

Wenn Lasso dir hilft, kauf dem Autor einen Kaffee ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat sponsor QR"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay sponsor QR">

</div>

Oder ⭐ [das Repo markieren](../../stargazers), [ein Issue öffnen](../../issues) oder [einen PR schicken](../../pulls) — jede einzelne davon ermutigt den Autor.

---

## Weitere Dokumente

- Tiefe Architektur? Siehe [Funktionsarchitektur](doc/08-media-interact-功能架构.md)
- Version-Roadmap? Siehe [Umsetzungsplanung](doc/09-media-interact-实施排期.md)
- Keys beantragen? Siehe [Key-Konfigurationsleitfaden](doc/KEY-GUIDE.md)

## Lizenz

**MIT** © wangdong233. Der Desktop-Hilfsprozess und die Browser-Engine-Abhängigkeiten sind alle MIT / Apache-2.0 — sicher für den Unternehmenseinsatz.

> Du willst die interne Architektur, Designprinzipien, plattformübergreifende Grenzen und Dev-Befehle wissen? Sieh dir [ARCHITECTURE.md](./ARCHITECTURE.md) und [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md) an.

<p align="center">
  <sub>Für alle, die lieber <strong>sagen</strong> als <strong>skripten</strong>.</sub><br>
  <sub>Einmal installieren — suchen, scrapen, eingeloggt scrapen, Desktop steuern, alles in einem Satz.</sub>
</p>
