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
| „Hol mir den Text der github.com-Startseite" | Sauberer Artikeltext (Navigationsleisten / Werbung / Schnickschnack entfernt — spart 30–70 % Tokens) |
| „Öffne mein eingeloggt Jira und zeig meine To-dos" | Ein Snapshot der eingeloggten Seite (nutzt dein lokales Chrome; 2FA machst du selbst) |
| „Dieser Link ist tot, find ein Archiv" | Den aktuellsten Snapshot aus dem Internet Archive |
| „Liste die Dateien in meinem aktuellen Finder-Fenster auf" | Eine Liste der Desktop-Fenster und -Steuerelemente (ein semantischer Baum, kein Screenshot) |
| „Mach einen Ganzseiten-Screenshot von dieser Seite" / „Als PDF speichern" | Ein Dateipfad auf der Festplatte (kein riesiger Bild-Datenberg im Chat) |
| „Welche Drittanbieter-Tracker hat diese Seite geladen?" | Eine Ressourcenliste mit Zählungen pro Tracker-Domain |
| „Liste alles, was ich gerade steuern kann" | Eine einzige vereinheitlichte Liste (Webseiten und Desktop-Fenster zusammen drin) |
| „Mach den Dark Mode aus" | Automatischer Klick / Tippen / Hotkey (mit Ergebniserklärung — es bestätigt, dass es wirklich passiert ist) |
| „Hol einfach diesen JSON-Endpoint" | Rohe Bytes (am schnellsten, am günstigsten) |
| „Diese Seite hat Cloudflare, ich kann sie nicht scrapen" | Cloud-Chrome-Anti-Bot-Bypass (standardmäßig aus; du musst explizit zustimmen) |
| „Ist Lasso richtig eingerichtet?" | Ein Health-Check-Bericht (sagt dir, was fehlt) |

> Du musst dir keine Fähigkeitsnamen merken. Sag einfach, was du willst — Claude wählt den richtigen Weg, es zu erledigen.

---

## 💰 Kosten auf einen Blick

Lasso selbst ist **komplett kostenlos + MIT-Open-Source**. Hier ist, was jede Fähigkeit tatsächlich kostet:

| Fähigkeit | Kosten | Hinweise |
|---|---|---|
| Lasso selbst (MCP-Server + alle Kernfähigkeiten) | ✅ Kostenlos | MIT-Open-Source, für immer kostenlos |
| Suche (Zhipu + Brave + Bing) | ✅ Kostenlose Kontingente verfügbar | Zhipu wird pro Token abgerechnet; Brave **2.000 Anfragen/Mo. kostenlos**, Bing **1.000 Anfragen/Mo. kostenlos** — ohne Zahlung nutzbar |
| Öffentliche Seiten scrapen / Screenshots / PDF / Netzwerk-Audit / rohe Bytes | ✅ Kostenlos | Läuft lokal, kein Key, keine Zahlung |
| Eingeloggte Seiten scrapen (lokales Chrome wiederverwenden) | ✅ Kostenlos | Läuft lokal, kein Key, keine Zahlung |
| Desktop steuern (macOS / Windows / Linux) | ✅ Kostenlos | Lokal gebaut und ausgeführt, nur OS-Autorisierung nötig; **optionaler** Apple Developer Account 99 $/Jahr für signierte dauerhafte Autorisierung (funktioniert auch ohne Signierung — dann einfach jedes Mal neu autorisieren) |
| Cloud-Browser (browserbase / stagehand) | ⚠️ Kostenpflichtig, standardmäßig aus | Nach Testphase kostenpflichtig; **kostet nichts, wenn du ihn nicht konfigurierst** — Lassos einziger kostenpflichtiger Punkt |

> In einem Satz: **Solange du den Cloud-Browser nicht aktivierst, kostet Lasso null** — die Suche hat kostenlose Kontingente, die für die tägliche Nutzung reichen, und alles andere ist komplett kostenlos.

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

Standard ist Zhipu (stark für Chinesisch); du kannst Brave und Bing für Multiple-Quellen hinzufügen. **Wenn eine einzelne Quelle rate-limitiert oder down ist, wird automatisch zur nächsten gewechselt — du merkst nichts davon.** Das Ausschöpfen des kostenlosen Kontingents eines Anbieters bringt nicht das Ganze zum Absturz.

### Öffentliche Seiten scrapen (ohne Login)

> Du: „Hol mir den Text von example.com" → sauberer Artikeltext, drei Granularitäten verfügbar

Entfernt automatisch Navigationsleisten, Werbung, Sidebars und anderen Schnickschnack — **spart 30–70 % Tokens** (und Geld). Brauchst du Zitatmarker (top für Recherche, zum Füttern von RAG)? Ein Satz schaltet den Modus um.

### Eingeloggte Seiten scrapen (auch mit 2FA)

> Du: „Zeig mir meine Jira-To-dos" → Snapshot der eingeloggten Seite

Nutzt **dein lokal eingeloggt Chrome** — du machst die 2FA einmal; Lasso übernimmt den Rest. Funktioniert für private GitHub-Repos, Firmen-Intranets, Content mit kostenpflichtigem Abo usw.

> 🔴 **Rote Linie**: Lasso **löst niemals 2FA / SMS-Codes / CAPTCHA / Magic Links für dich**. Du musst diese einmal manuell in deinem lokalen Chrome bestehen.

### Rohe Bytes holen (am schnellsten, am günstigsten)

> Du: „GET diesen JSON-Endpoint" → rohe Bytes

Wenn du keine vollständige Seite rendern musst, ist direktes HTTP **~4× schneller und ~4× günstiger** als der Weg über den Browser. Erkennt automatisch den Content-Type (JSON / Text / Binär).

### Screenshot / Archiv

> Du: „Mach einen Ganzseiten-Screenshot" / „Als PDF speichern" → Dateipfad auf der Festplatte

Alle Bilder und PDFs werden **auf der Festplatte gespeichert und ein Pfad zurückgegeben** — kein riesiger Datenberg im Chat, der den Kontext verbraucht.

### Sehen, was eine Seite lädt

> Du: „Welche Drittanbieter-Tracker hat diese Seite geladen?" → Ressourcenliste mit Zählungen pro Tracker-Domain

Erkennt automatisch jede Ressource, die die Seite lädt, gruppiert nach Drittanbieter-Domain — praktisch, um Privacy-Risiken und Performance-Engpässe zu erkennen.

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

**Standardmäßig komplett aus.** Aktiviert sich nur, wenn du es explizit anschaltest UND einen Cloud-Browser-Key konfiguriert hast. Für normale Seiten brauchst du es nicht.

---

## Installation

**Voraussetzungen**: Node.js ≥ 20; Claude Code (oder irgendein MCP-fähiger Client).

```bash
# Claude Code (empfohlen)
claude mcp add lasso -- npx -y lasso-mcp
```

Claude Code neu starten → `/mcp` → `lasso ✓ Connected`. **Das war's — keine Keys im Installationsbefehl.** Browsen / Screenshots / PDF / Desktop-Steuerung funktionieren sofort (Suche ist die einzige Ausnahme — siehe [Konfigurieren](#konfigurieren)).

**macOS-Nutzer, die Desktop-Steuerung wollen**: führ einmal `lasso doctor` aus und folge den Anweisungen, um `lasso-rust-helper` unter „Systemeinstellungen → Datenschutz & Sicherheit" sowohl für **Bedienungshilfen** als auch für **Bildschirmaufnahme** einen Haken zu setzen (`doctor` führt dich durch — du musst nicht selbst nach dem Pfad suchen).

---

## Konfigurieren

**Die Installation ist Zero-Config** — der obige Installationsbefehl aktiviert bereits Browsen / Holen / Screenshots / PDF / Drittanbieter-Ressourcen-Inspektion / Desktop-Steuerung. **Nur die Suche erfordert einen Key.**

### Nach dem gesucht, was du tun willst

| Was du willst | Was zu konfigurieren | Was es freischaltet |
|---|---|---|
| Öffentliche Seiten scrapen / Screenshots / PDF / Tracker sehen / rohe Bytes holen / Desktop steuern | **Nichts** | Funktioniert direkt nach der Installation |
| Suche | Ein Zhipu-Key (kostenlos zu beantragen) | Der Haupteinstieg für die Suche |
| Fast null Suchfehler (Multi-Quelle) | Brave-/Bing-Keys hinzufügen (beide haben kostenlose Kontingente) | Automatisches Failover, falls einer ausfällt — du merkst nichts |
| Eingeloggte Seiten scrapen | Einmal `lasso launch-chrome` ausführen | Nutzt deine lokale Chrome-Sitzung |
| Den macOS-Desktop steuern | Einmal `lasso doctor` ausführen | Native Apps steuern |
| Cloudflare-geschützte Seiten scrapen | Doppelte Bestätigung + ein Cloud-Key | Standardmäßig aus; braucht deine explizite Zustimmung |

Im Folgenden ist jedes der vier Module mit dem kürzesten Weg zu „es funktioniert einfach" aufgeschlüsselt.

### 1. Suche (✅ Kostenlos · kostenloses Kontingent; ein Key zum Starten, drei für fast null Fehler)

**Was es macht**: Sucht alles, gibt strukturierte Ergebnisse zurück (Titel, Snippet, Link).

**Braucht es einen Key**: Ja — ein Zhipu-Key (kostenlos zu beantragen) reicht.

**Wie zu konfigurieren**:

```bash
lasso config init        # erstellt die Vorlage ~/.lasso/config.json
```

Öffne `~/.lasso/config.json` und fülle:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key"
}
```

**Robuster gewollt** (sehr empfohlen): füge auch Brave und Bing hinzu — beide haben kostenlose Kontingente. Falls eine einzelne Quelle rate-limitiert oder down ist, wird automatisch zur nächsten gewechselt und du merkst nichts:

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

> Trenne mehrere Keys mit Kommas — N Keys geben dir das N-fache kostenlose Kontingent, automatisch rotiert.

Key-Namen entsprechen denen in der obigen Tabelle — fülle sie einfach ein. Speichere die Datei; Lasso liest sie beim nächsten Start.

**Wie du Keys beantragst, Kontingente der kostenlosen Stufen, Multi-Key-Rotationsdetails** → siehe den [Key-Konfigurationsleitfaden · Suche](./doc/KEY-GUIDE.md#a-搜索).

### 2. Eingeloggte Seiten scrapen (✅ Kostenlos · kein Key, ein Befehl ausführen)

**Was es macht**: Scrapt Seiten, in die du eingeloggt bist — Jira-To-dos, private GitHub-Repos, Firmen-Intranets, Content mit kostenpflichtigem Abo.

**Braucht es einen Key**: Nein.

**Wie zu konfigurieren**: Führe den folgenden Befehl einmal aus. Er erkennt automatisch dein lokales Chrome und nutzt jede Sitzung, in die du dich schon eingeloggt hast (inklusive derer, bei denen du die 2FA schon selbst bestanden hast):

```bash
lasso launch-chrome
```

Sag danach „öffne mein eingeloggt Jira" zu Claude und es verbindet sich automatisch.

> 🔴 **Rote Linie**: 2FA / SMS-Codes / CAPTCHA / Magic Links — Lasso löst diese niemals für dich. Du musst sie einmal manuell in deinem lokalen Chrome bestehen.

**Details** → [Key-Konfigurationsleitfaden · Eingeloggtes Browsen](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Den Desktop steuern (✅ Kostenlos · kein Key, einmal im OS autorisieren)

**Was es macht**: Steuert native Apps auf macOS / Windows / Linux (Klicken, Tippen, Fensterinhalte lesen, Hotkeys ausführen).

**Braucht es einen Key**: Nein.

**Wie zu konfigurieren** (wähle dein OS):

- **macOS**: Führe einmal `lasso doctor` aus und folge den Anweisungen, um `lasso-rust-helper` unter „Systemeinstellungen → Datenschutz & Sicherheit" sowohl für **Bedienungshilfen** als auch für **Bildschirmaufnahme** einen Haken zu setzen. `doctor` führt dich durch — du musst nicht selbst nach dem Pfad suchen.
- **Windows**: Wenn du Claude das erste Mal um eine Desktop-Aktion bittest, wirft das System eine Autorisierungsaufforderung auf — klick „Zulassen" (entspricht macOS Bedienungshilfen).
- **Linux**: Stell sicher, dass die Accessibility-Schnittstelle installiert ist (die meisten GNOME-/MATE-Desktops haben sie standardmäßig; falls nicht, `sudo apt install at-spi2-core`).

> **Ehrliche Grenze**: macOS ist auf echter Hardware verifiziert; Windows / Linux bestehen Compile-Zeit- und Contract-Level-Selbstchecks, aber vollständiges manuelles Testen auf echten Maschinen läuft noch. **Wir tun nicht so, als wäre Win/Linux „vollständig verifiziert".**

**Details** → [Key-Konfigurationsleitfaden · Desktop-Steuerung](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Cloud-Anti-Bot (⚠️ Kostenpflichtig, standardmäßig aus · braucht doppelte Bestätigung)

**Was es macht**: Scrapt Seiten, die durch Cloudflare oder schweren Anti-Bot-Schutz bewacht sind.

**Braucht es einen Key**: Ja — und es aktiviert sich nur, wenn **du es explizit einschaltest**.

**Wie zu konfigurieren**: Beide Bedingungen müssen gleichzeitig erfüllt sein:

1. Master-Schalter: setze `LASSO_ALLOW_CLOUD_BROWSER` auf `true`
2. Mindestens ein Cloud-Key (browserbase oder stagehand — wähle einen)

Schreib es in `~/.lasso/config.json`:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Standardmäßig aus — keine Config heißt keine solche Fähigkeit. Für normale Seiten brauchst du es nicht, **und es aktiviert sich nur, wenn du explizit zustimmst**.

**Wie du Cloud-Keys beantragst, Test-Kontingente** → siehe den [Key-Konfigurationsleitfaden · Cloud-Browser](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Erweiterte Tuning-Optionen (optional — normale Nutzer können das überspringen)</b></summary>

Du kannst das Folgende für die tägliche Nutzung **komplett ignorieren**. Das hier ist nur für spezielle Szenarien, und das meiste lässt sich über `lasso config init` in `~/.lasso/config.json` setzen oder per Umgebungsvariable überschreiben (Umgebungsvariablen haben Vorrang vor der Config-Datei, praktisch für temporäre Wechsel):

- Den Debug-Port des eingeloggten Chrome ändern (wenn der Standard `9222` belegt ist)
- Die Cache- / Zustandsdateien an einen anderen Ort verschieben
- Auf kostenlose Suchquellen beschränken
- Firmen-Intranet / spezielle Proxy-Ranges zulassen
- Eigene Passphrase festlegen, um Login-Cookies zu verschlüsseln (falls nicht gesetzt, wird der macOS Keychain verwendet)
- Snapshots der Suchergebnisse auf die Festplatte speichern (für Regressionstests)

Vollständige Variablenliste und Defaults: [Key-Konfigurationsleitfaden · Erweitertes Tuning](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Surge-/Clash-TUN-Proxy-Netzwerke (fake-ip) sind out-of-the-box bereits erlaubt.**

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
| Suche liefert immer wieder nichts | Prüfe, ob der Key abgelaufen / das Kontingent erschöpft ist; mehrere Anbieter hinzufügen (Zhipu + Brave + Bing) senkt die Fehlerrate drastisch |
| Ein Link lässt sich nicht öffnen | Sag „dieser Link ist tot, find ein Archiv", um das Internet Archive zu prüfen |
| Meldung, dass der Zugriff auf das interne Netzwerk blockiert wurde | URL doppelt prüfen; TUN-Proxy-Netzwerke sind standardmäßig erlaubt, andere interne Netzwerke brauchen explizite Erlaubnis |

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

## Lizenz

**MIT** © wangdong233. Der Desktop-Hilfsprozess und die Browser-Engine-Abhängigkeiten sind alle MIT / Apache-2.0 — sicher für den Unternehmenseinsatz.

> Du willst die interne Architektur, Designprinzipien, plattformübergreifende Grenzen und Dev-Befehle wissen? Sieh dir [ARCHITECTURE.md](./ARCHITECTURE.md) und [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md) an.

<p align="center">
  <sub>Für alle, die lieber <strong>sagen</strong> als <strong>skripten</strong>.</sub><br>
  <sub>Einmal installieren — suchen, scrapen, eingeloggt scrapen, Desktop steuern, alles in einem Satz.</sub>
</p>
