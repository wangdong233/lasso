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
| Suche (Zhipu + Brave + Bing) | ✅ Kostenlose Kontingente verfügbar | Zhipu wird pro Token abgerechnet; Brave **2.000 Anfragen/Mo. kostenlos**, Bing **1.000 Anfragen/Mo. kostenlos** — ohne Zahlung nutzbar. **Auf deiner Maschine schon Zhipus `web-search-prime` MCP konfiguriert? Lasso erkennt und nutzt es automatisch — du musst nicht mal einen separaten ZHIPU_API_KEY anlegen** |
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

Standard ist Zhipu (stark für Chinesisch); du kannst Brave und Bing für Multiple-Quellen hinzufügen. **Wenn eine einzelne Quelle rate-limitiert oder down ist, wird automatisch zur nächsten gewechselt — du merkst nichts davon.** Das Ausschöpfen des kostenlosen Kontingents eines Anbieters bringt nicht das Ganze zum Absturz.

Für zeitkritisches Material wie **Nachrichten und Release-Tracking** sag einfach „suche nach X der letzten Woche / des letzten Monats" — der Zeitfilter (day / week / month / year, bei allen Engines — nur Bing kennt keine „Jahr“-Granularität und überspringt sie, v1.11) wird automatisch mitgegeben, ohne handgeschriebene Daten in der Anfrage.

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

**Aktuelle Version v1.13.0** (v1.13 — 7 Verfeinerungen auf Implementierungsebene (3. Runde des Optimalitäts-Reviews): **konsistenter Sprach-Fingerabdruck des Headless-Browsers** — der HTTP-`Accept-Language`-Header folgt jetzt dem Stealth-Profil (zuvor wurde der echte Host-Wert gesendet, sodass ein englisches Profil auf einer chinesischen Maschine den Widerspruch „Header zh-CN ↔ Seite en-US" offenbarte); auch `navigator.languages` ist jetzt profilbewusst; **VLM-Landepunkt-Fix bei Regions-Screenshots** — im `screenshot_region`-Szenario werden VLM-abgeleitete Koordinaten automatisch zurück in Vollbild-Koordinaten umgerechnet (zuvor systematisch um den Ursprung der Region verschoben — bei gleichzeitiger Erfolgsmeldung); **`desktop find` lehnt reine ref-Abfragen ab** — `where` akzeptiert nur text/role; eine reine ref-Abfrage meldet ehrlich `invalid_params` (zuvor degenerierte sie stumm zu einem Treffer auf den gesamten Baum — Token-Explosion als Erfolg getarnt); **schnellerer, stabilerer Exit** — das Freigeben von Steel-Sessions hat jetzt eine 3-Sekunden-Grenze (wenn selbst gehostetes Steel hängt, blockiert der Claude-Code-Exit nicht mehr bis zu 5 Minuten); fehlt der VLM-Stufe die macOS-Berechtigung zur Eingabesynthese, meldet sie jetzt klar „Autorisierung nötig" statt vage zu scheitern. v1.12 — 14 Verfeinerungen auf Implementierungsebene (2. Runde des Optimalitäts-Reviews): **doppelt aktivierte Markdown-Extraktion** — defuddle-Seitenextraktoren (HN/Reddit/GitHub/Wikipedia/Substack/Medium, insgesamt 20+ Sites) + strukturtreue Tabellen-/Mathe-Konvertierung (GFM-Tabellen verlieren keine Struktur mehr; relative Links werden automatisch absolutiert; der Output kann Obsidian-Dialekte wie `==Highlight==` und `[^N]`-Fußnoten enthalten); **Standard-Fingerabdruck des Headless-Browsers passt zum Host-System** — unter macOS ist der Standard ein macOS-Chrome-Fingerabdruck (beseitigt den Widerspruch „UA sagt Windows, Client Hints verraten macOS"; `doctor` weist auf Versionsabweichungen zu deinem installierten Chrome hin); **ehrliche Endkette am Desktop** — die VLM-Screenshot-Ableitung täuscht keinen Erfolg mehr vor (führt aus, wenn möglich, meldet sonst ehrlich unknown), `wait/expect` brauchen zwei aufeinanderfolgende Treffer (beim Laden aufblitzende Elemente zählen nicht mehr als Erfolg), `snapshot` meldet beim Abschneiden auf oberster Ebene `truncated:true`, `find` hängt an Trefferknoten eine Liste ausführbarer Aktionen an; **Electron-Eingabefeld-Fix** — Steuerelemente, die AXSetValue verschlucken (Slack/VSCode usw.), lassen `type` automatisch auf „Fokus + synthetische Tastatur" zurückfallen (ASCII); **Drag-and-Drop wird nutzbar** — 200 ms Drücken + 12-Punkt-interpolierte Bahn + 100 ms Absetzen (Slider und Drag-Sortierung gingen von meist-Fehlschlag zu nutzbar); **freshness durchgehend konsistent** — machine_mcp und der DuckDuckGo-Fallback verwerfen den Zeitfilter nicht mehr stumm; bei abnormalen Claude-Code-Exit wird der Lasso-Prozess sofort abgeschlossen (zuvor konnte er bis zu eine Stunde hängen). v1.11 — die Lücke des „Griffs für alles" geschlossen: **Desktop geht von Zuschauen zu Handeln** — `desktop` click/type/scroll wird jetzt wirklich ausgeführt (AXAPI-semantische Klicks + Schreiben-dann-Zurücklesen-Verifikation + ehrliche Fehler bei veralteten Referenzen), plus Koordinaten-Mausaktionen (Drag/Scroll/Bewegen als Canvas-/Electron-Fallback) und `skeleton`-Baumbeschneidung (deutlich weniger Tokens bei dichten Apps); **Treiberschicht aktualisiert: chrome-devtools-mcp 0.3.0 → 1.7.0** (11 Monate / 57 Releases; Start-Level-Stealth UA/Viewport; Upstream-Telemetrie standardmäßig deaktiviert); **Suche bekam einen `freshness`-Zeitfilter** (day/week/month/year durchgereicht an alle Engines — keine handgeschriebenen Daten mehr in Anfragen für News/Release-Tracking); der englische Zero-Key-Fallback wechselte von Baidu zu DuckDuckGo; neuer `LASSO_PROXY`-Browser-Egress-Proxy (betrifft nur Headless-/Cloud-Browser — der Egress deines eingeloggten Chrome bleibt unangetastet). v1.10 — Browser standardmäßig still und fertig-zu: `launch-chrome` startet standardmäßig mit null Fenster und null Störung (an macOS/Windows angepasst, `--mode visible` stellt das alte Verhalten wieder her), läuft stets mit Hintergrund-Anti-Throttling und Stummschaltung und schließt sich während der Server-Laufzeit ~60 s nach der letzten Nutzung selbst (einstellbar über `LASSO_LAUNCH_IDLE_MS`; das 5-Minuten-Verhalten bleibt als `300000` verfügbar). v1.9 — Browser-Lebenszyklus-Nacharbeit: der Headless-Browser wird nach 5 Minuten Leerlauf automatisch recycelt, `lasso chrome-stop` schließt die von Lasso gestarteten Chromes (abgleichbar über das Konto), `tab_restore` stellt deine ursprüngliche Tab-Liste wieder her — siehe „Aufräumen nach getaner Arbeit" oben. v1.8 — die 24 beim Gesamttest aufgedeckten Defekte behoben: Anpassung an den Upstream-Vertrag chrome-devtools-mcp@0.3.0, Screenshots landen wirklich auf der Festplatte, Lebendprüfung von launch-chrome, Anbindung der Caller-Tier-Kontingente, das `read_text`-Fortsetzungs-Werkzeug und mehr — die vollständige Liste im „v1.8-Fixprotokoll" von [doc/17-功能测试清单.md](doc/17-功能测试清单.md).)

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
| Cloudflare-geschützte Seiten scrapen | Doppelte Bestätigung + ein Cloud-Browser-Kanal (selbst gehostetes Steel kostenlos / gehostet kostenpflichtig) | Standardmäßig aus; braucht deine explizite Zustimmung |

Im Folgenden ist jedes der vier Module mit dem kürzesten Weg zu „es funktioniert einfach" aufgeschlüsselt.

### 1. Suche (✅ Kostenlos · kostenloses Kontingent; ein Key zum Starten, drei für fast null Fehler)

**Was es macht**: Sucht alles, gibt strukturierte Ergebnisse zurück (Titel, Snippet, Link).

**Braucht es einen Key**: Ja — aber wenn auf deiner Maschine bereits Zhipus `web-search-prime` MCP konfiguriert ist (in deinem lokalen `~/.claude.json` unter `mcpServers`, type=http + Authorization), **erkennt Lasso diesen Key beim Start automatisch und nutzt ihn als erste Suchquelle — ein separater ZHIPU_API_KEY ist dann gar nicht nötig**. Ist das Maschinen-MCP rate-limitiert oder fällt aus, greift automatisch der selbst konfigurierte Key von Lasso (siehe unten). Führ `lasso doctor` aus und schau, ob `#36 machine_search_mcp` auf `pass` steht (host=open.bigmodel.cn) oder auf `warn` (nicht erkannt).

> Zero-Config-Priorität: Wiederverwendung des Maschinen-MCP → Lassos eigener `ZHIPU_API_KEY` → Brave → Bing → `browse_headless`-Fallback. Fällt der vordere aus, wird automatisch zum nächsten gewechselt — du merkst nichts.

**Wie zu konfigurieren** (nötig, wenn das Maschinen-MCP fehlt / du einen unabhängigen Key willst):

```bash
lasso config init        # erstellt die Vorlage ~/.lasso/config.json
lasso --version          # Versionsnummer ausgeben (seit v1.8)
lasso --help             # Nutzung aller Unterbefehle
```

> Seit v1.8 folgt die Kommandozeile den üblichen Konventionen: unbekannte Unterbefehle / unbekannte Argumente drucken die Nutzung und beenden sich mit Nonzero-Code — kein stummes Abrutschen in den MCP-Server-Modus, der auf Eingaben wartet.

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

**Wie zu konfigurieren**: Führe den folgenden Befehl einmal aus. Er findet dein lokales Chrome automatisch und startet es mit Debug-Port. Seit v1.8 wird standardmäßig Lassos **eigenes, separates Profil** verwendet (Chrome 136+ verbietet den Debug-Port beim Standardprofil — der alte Weg wäre sofort gescheitert); melde dich in diesem Fenster einmal in deinen Konten an (2FA selbst), danach **wird die Anmeldung dieses Profils dauerhaft wiederverwendet**:

```bash
lasso launch-chrome
```

Nach dem Start prüft Lasso den Debug-Port aktiv (eine Prüfung auf `curl /json/version`-Niveau): Kommt Chrome nicht hoch oder ist der Port belegt, gibt es einen **klaren Fehler** statt „Erfolg gemeldet, aber keine Verbindung". Ein bestehendes Profilverzeichnis kannst du mit `lasso launch-chrome --profile <Verzeichnis>` wiederverwenden.

**Seit v1.10 arbeitet dieses Chrome standardmäßig „still"**: Start mit **null Fenster, ohne dir Tastatur-/Fensterfokus zu klauen, immer stummgeschaltet** — du schreibst im Vordergrund Code, es scrapt im Hintergrund (die einzig sichtbare Spur ist ein zusätzliches Chrome-Symbol im Dock / in der Taskleiste, das sich auf OS-Ebene nicht entfernen lässt). Willst du ihm bei der Arbeit zusehen: `lasso launch-chrome --mode visible` (oder `"LASSO_LAUNCH_MODE": "visible"` in `~/.lasso/config.json`).

Sag danach „öffne mein eingeloggt Jira" zu Claude und es verbindet sich automatisch.

> 🔴 **Rote Linie**: 2FA / SMS-Codes / CAPTCHA / Magic Links — Lasso löst diese niemals für dich. Du musst sie einmal manuell in deinem lokalen Chrome bestehen.

**Aufräumen nach getaner Arbeit (seit v1.10 fast automatisch)**: Während der Server läuft, **schließt sich dieses Chrome ~60 s nach der letzten Nutzung selbst** (fertig-genutzt — nichts anzuwarten, nichts zu merken). Schwellen anpassen: `LASSO_LAUNCH_IDLE_MS=300000` stellt das 5-Minuten-Verhalten wieder her, `=1000` kommt quasi-instant (preist eine ~11 s erneute Kaltstartphase bei etwas längeren Operationspausen ein), `=0` deaktiviert das Auto-Schließen. Für eine einzelne lange Aufgabe: `lasso launch-chrome --idle-ms 3600000`. Manuell schließen geht jederzeit (nur die von Lasso selbst gestarteten, mit verifizierter Zugehörigkeit — niemals deine manuell geöffneten Browser):

```bash
lasso chrome-stop          # schließt alle Chromes, die Lasso gestartet hat (laut Konto)
lasso chrome-stop --port 9222   # schließt nur den am angegebenen Port
```

> Ehrliche Grenze: Beim eigenständigen `lasso launch-chrome` (ohne Server) gibt es keinen Leerlauf-Autoschluss — der Ausgang bleibt `chrome-stop`. Wenn `browse_logged_in` dein **eigenes sichtbares Chrome** anbindet, ist das „geringe Störung, keine null Störung" (eine macOS-Plattformbeschränkung; einzelne Operationen können einmal den Fokus ziehen) — für absolute Stille nimm Lassos eigene Hidden-Stufe oder `browse_headless`; der `desktop`-Kanal simuliert eine echte menschliche Tastatur und Maus und **belegt physische Tastatur/Maus by design** — eine stille Form gibt es nicht.

Tabs, die `browse_logged_in` in deinem Chrome öffnet, werden am Ende einer Aufgabe mit einem `admin {action:"tab_restore", reason:"Aufgabe erledigt"}` geschlossen und deine ursprüngliche Tab-Liste wiederhergestellt (das Gleiche passiert automatisch beim Server-Exit). Der Headless-Browser wiederum wird standardmäßig **nach 5 Minuten ohne Nutzung automatisch recycelt**, statt dauerhaft Speicher zu belegen — für häufige Folgenutzungen: `LASSO_HEADLESS_IDLE_MS=3600000` (1 Stunde) spart Kaltstarts; `0` deaktiviert es komplett.

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

### 4. Cloud-Browser: selbst gehostet oder gehostet (selbst gehostet kostenlos / gehostet kostenpflichtig, standardmäßig aus · braucht doppelte Bestätigung)

**Was es macht**: Scrapt Seiten, die durch Cloudflare oder schweren Anti-Bot-Schutz bewacht sind (leichter Anti-Bot wird bereits von `browse_headless`' eingebauter Anti-Erkennung handled — dieser Abschnitt ist nur für die harten Fälle).

**Braucht es einen Key**: Kommt auf den Weg an. Einer von drei Cloud-Kanälen — **nur der gehostete Weg braucht einen Key**:

- **(a) Steel selbst gehostet (empfohlen · kostenlos)**: einen Open-Source-Cloud-Browser im lokalen Docker betreiben — **null Kosten pro Session + Cookies verlassen nie deine Maschine**. Kein Key zu beantragen; einfach selbst Docker betreiben.
- **(b) browserbase gehostet (kostenpflichtig)**: 100 Testminuten, danach nutzungsabhängig.
- **(c) stagehand gehostet (kostenpflichtig)**: KI-freundliche Seitenbeobachtung, eher zum Ausprobieren. ⚠️ **Programmatischer Experimentalkanal** — selbst mit konfiguriertem Key gibt es **keinen MCP-Werkzeugeingang** (der REST-Vertrag ist zur Laufzeit unverifiziert; `lasso doctor` #39 testet genau das); um wirklich an Anti-Bot vorbeizukommen, nimm Steel oder browserbase.

**Wie zu konfigurieren**: Beide Bedingungen müssen gleichzeitig erfüllt sein:

1. Master-Schalter: setze `LASSO_ALLOW_CLOUD_BROWSER` auf `true`
2. Mindestens ein Cloud-Kanal — Steel (setze `STEEL_ENDPOINT`) oder browserbase (setze den entsprechenden Key); ein stagehand-Key bestückt nur den internen Experimentalkanal und legt keine Werkzeuge frei

**Kürzeste Konfiguration · Steel selbst gehostet (kostenlos, empfohlen)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

Steel startet mit einem Docker-Befehl: `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`. Vollständige Einrichtungsschritte im [Key-Leitfaden · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).

**Kürzeste Konfiguration · browserbase gehostet (kostenpflichtig)**:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "your_browserbase_key"
}
```

> Standardmäßig aus — keine Config heißt keine solche Fähigkeit. Für normale Seiten brauchst du es nicht, **und es aktiviert sich nur, wenn du explizit zustimmst**. Leichter Anti-Bot braucht überhaupt keinen Cloud-Browser — `browse_headless`' eingebaute Anti-Erkennung schafft das.

**Wie du Cloud-Keys beantragst, wie du Steel-Docker einrichtest** → siehe den [Key-Konfigurationsleitfaden · Cloud-Browser](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

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
| Suche liefert immer wieder nichts | Prüfe, ob der Key abgelaufen / das Kontingent erschöpft ist; mehrere Anbieter hinzufügen (Zhipu + Brave + Bing) senkt die Fehlerrate drastisch |
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
