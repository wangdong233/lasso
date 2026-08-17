<h1 align="center">Lasso</h1>

> Claude Code's "grab handle for everything outside" — search, scrape the web, scrape logged-in pages, drive the desktop, all in one sentence.
> Cowboy lasso — rope any interface.

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**Install Lasso once for Claude Code, and from then on searching, scraping, scraping logged-in pages, and driving the desktop are all a single sentence.** If you search, grab a page, or click around desktop apps every week — and don't want a separate tool for each — install this once and hand it all to Claude.

Twin star of [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (the image grab handle): "every image operation in one MCP" ↔ "every external interaction in one MCP".

<div align="center">

[简体中文](README.md) | **English** | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

## Table of Contents

- [What You Say, What You Get](#what-you-say-what-you-get)
- [💰 Cost at a Glance](#-cost-at-a-glance)
- [60-Second Start](#60-second-start)
- [What It Can Do for You](#what-it-can-do-for-you)
- [Install](#install)
- [Configure](#configure)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Who It's For / Not For](#who-its-for--not-for)
- [Support the Author](#support-the-author)
- [License](#license)

---

## What You Say, What You Get

| You say …… | You get |
|---|---|
| "Search for the latest on the rust async ecosystem" | Structured search results (auto-switches to the next engine if one is down — you don't feel a thing) |
| "Search Claude Code updates from the last week" (v1.11) | Time-filtered results via `freshness=week` — no hand-written dates in the query |
| "Grab the text of the github.com homepage" | Clean article text (nav bars / ads / clutter stripped, saving 30–70% on tokens; 20+ high-traffic sites get dedicated extractors and tables keep their structure — v1.12) |
| "Open my logged-in Jira and show my to-dos" | A snapshot of the logged-in page (reuses your local Chrome; you handle 2FA yourself) |
| "This link is dead, find an archive" | The most recent snapshot from the Internet Archive |
| "List the files in my current Finder window" | A list of desktop windows and controls (a semantic tree, not a screenshot; says `truncated:true` plainly if the tree gets cut off — v1.12) |
| "Click that New Folder button" / "Type XX into the search box" (v1.11) | Desktop actions really execute (AXAPI semantic click/type + result verification; automatic fallback to coordinate clicks on canvas/Electron) |
| "Take a full-page screenshot of this page" / "Save as PDF" | A file path on disk (no giant blob of image data dumped into the chat) |
| "What third-party trackers did this page load?" | A resource list with tracker-domain counts |
| "List everything I can control right now" | One unified list (web pages and desktop windows all in it) |
| "Turn off dark mode" | Auto click / type / hotkey (with result verification — it confirms it actually happened) |
| "Just fetch this JSON endpoint" | Raw bytes (fastest, cheapest) |
| "This site seems to have some anti-bot, let's try" | `browse_headless` has built-in anti-detection (passes basic bot checks) — many sites scrape directly, no config needed |
| "This site has Cloudflare, I can't scrape it" | Cloud Chrome anti-bot — **Steel self-hosted (free)** or browserbase/stagehand (paid, off by default) |
| "Is Lasso set up correctly?" | A health-check report (tells you what's missing) |

> You don't need to memorize any capability names. Just say what you want — Claude picks the right way to get it done.

---

## 💰 Cost at a Glance

Lasso itself is **completely free + MIT open source**. Here's what each capability actually costs:

| Capability | Cost | Notes |
|---|---|---|
| Lasso itself (MCP server + all core capabilities) | ✅ Free | MIT open source, free forever |
| Search (Zhipu + Brave) | ✅ Free to start with Zhipu | Zhipu is billed by token (new users get free credits), and if the Zhipu MCP is already configured on the machine it works with zero setup; Brave is now a paid plan that includes a \$5/month credit (the free tier was discontinued as of 2026-02); Lasso also ships a free live-search fallback, so you still have search even without configuring any provider |
| Scrape public pages / screenshots / PDF / network audit / raw bytes | ✅ Free | Runs locally, no key, no payment |
| Scrape logged-in pages (reuse local Chrome) | ✅ Free | Runs locally, no key, no payment |
| Drive desktop (macOS / Windows / Linux) | ✅ Free | Built and run locally, only OS authorization needed; **optional** Apple Developer account \$99/yr for signed persistent authorization (works without signing too — just re-authorize each time) |
| Cloud browser · self-hosted Steel (v1.6 new) | ✅ Free | Run Steel (Apache-2.0 open source) in local Docker — **zero per-session cost + cookies never leave your machine**; needs `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| Cloud browser · hosted (browserbase / stagehand) | ⚠️ Paid, off by default | browserbase is pay-as-you-go after trial; stagehand is a programmatic experimental channel (no MCP tool entry); **costs nothing if you don't configure it** |
| `browse_headless` anti-detection (v1.5 new) | ✅ Free | Injects 16 anti-detection layers by default (UA / webdriver / webgl, etc.) — passes many basic bot checks out of the box |

> In one sentence: **as long as you don't turn on the hosted cloud browser (browserbase/stagehand), Lasso costs zero** — search has free tiers enough for daily use, and the self-hosted Steel cloud browser is free too.

---

## 60-Second Start

### 30 seconds · One-line install (zero config)

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Restart Claude Code → type `/mcp` → see `lasso ✓ Connected`. Done. **No keys in the install command** — configuration is a separate step (next tier).

### 30 seconds · With nothing configured, you can already do all this

No keys needed right after install (this is **Tier 1: zero config**):

- Scrape the text of any **public web page**, converted to clean markdown
- **Full-page screenshots** and **save-as-PDF**, returning a file path
- See **what third-party trackers a page loads**
- Fetch raw bytes from a JSON API or file directly
- Control native macOS apps (Finder / Mail / System Settings, etc. — requires a one-time tick in System Settings)

> 💡 **Search may be zero-config too**: if your machine's `~/.claude.json` already has the Zhipu `web-search-prime` MCP configured, Lasso auto-detects and reuses it at startup — no need to set a separate `ZHIPU_API_KEY`, search just works. Run `lasso doctor` and check whether `#36 machine_search_mcp` is `pass`.

Your first output — just say to Claude:

> "Grab the text of example.com and turn it into markdown"

### Want more? Add it in the config file (Tier 2)

- **Search** → run `lasso config init` to create `~/.lasso/config.json`, then fill in a Zhipu key (see [Configure](#configure))
- **Scrape logged-in pages** (Jira / private GitHub / company intranet) → run `lasso launch-chrome` once
- **Control the macOS desktop** → run `lasso doctor` once to be guided through authorization

How to obtain each key, what free tiers exist — see the [**Key Configuration Guide**](./doc/KEY-GUIDE.md).

---

## What It Can Do for You

Grouped by **what you want to do**, not by tool name. Each is one sentence in, one sentence out.

### Search

> You: "Search for X" → structured search results

Defaults to Zhipu (strong for Chinese); you can add Brave as a second source (the Bing upstream has been shut down; the config key is kept and auto-skipped). **If any single source is rate-limited or down, it auto-switches to the next — you don't feel a thing.** Hitting one provider's free quota doesn't break the whole.

For time-sensitive content like **news and release tracking**, just say "search for X from the last week / last month" — a time filter is applied automatically (day / week / month / year, v1.11), no hand-written dates in your query.

### Scrape Public Pages (no login)

> You: "Grab the text of example.com" → clean article text, three granularities available

Auto-strips nav bars, ads, sidebars and other clutter — **saves 30–70% on tokens** (and money). GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium and other **high-traffic sites — 20+ in all — get dedicated extractors**, so tables and math formulas keep their structure too (v1.12), and every link in the body text is a fully clickable absolute URL. Need citation markers (great for research, feeding RAG)? One sentence switches modes.

> **As of v1.5, `browse_headless` has anti-detection on by default** (spoofed UA / `navigator.webdriver` removed / faked webgl, plugins, codecs, and a dozen more layers). **Zero config — automatic.** Many "detect headless" sites now scrape directly (v1.8 fixed a defect where the injection silently failed to apply — it really takes effect now, and injection failures are reported honestly in the logs). As of v1.11 anti-detection is applied **at browser-launch level**: UA, viewport and language are issued together from the profile, so the network-layer HTTP headers and the page's JS see the same values — no more self-contradiction. As of v1.12 the default fingerprint on macOS **matches your system** (no more "UA says Windows while machine traits give away macOS"). Only Cloudflare-grade heavy anti-bot needs the cloud browser (see "Anti-Bot Bypass" below). Want to verify the anti-detection effect? Run `lasso doctor --stealth-check` for a creepjs detection comparison.

### Scrape Logged-in Pages (even with 2FA)

> You: "Show me my Jira to-dos" → snapshot of the logged-in page

Reuses **your locally-logged-in Chrome** — you handle 2FA once; Lasso takes over the rest. Works for private GitHub repos, company intranets, paid-subscription content, etc.

> 🔴 **Red line**: Lasso **never solves 2FA / SMS codes / CAPTCHA / magic links for you**. You must manually pass these once in your local Chrome.

### Fetch Raw Bytes (fastest, cheapest)

> You: "GET this JSON endpoint" → raw bytes

When you don't need to render a full page, direct HTTP is **~4× faster and ~4× cheaper** than going through a browser. Auto-detects content type (JSON / text / binary).

### Screenshot / Archive

> You: "Take a full-page screenshot" / "Save as PDF" → file path on disk

All images and PDFs are **saved to disk and a path is returned** — no giant blob dumped into your chat to waste context. Oversized text output (fetch_url / network, etc.) beyond 48 KiB is also written to disk automatically, returning a preview plus an `@oN` continuation handle — page through it with the `read_text` tool (directly callable over MCP since v1.8).

### See What a Page Loads

> You: "What third-party trackers did this page load?" → resource list with tracker-domain counts

Auto-identifies every resource the page loads, grouped by third-party domain — handy for spotting privacy risk and performance bottlenecks. As of v1.11, resource capture goes through the browser engine's native network layer — **complete even under proxy / TUN networks** — and every resource carries its request method and status code.

### Drive Native Desktop Apps

> You: "Turn off dark mode" / "Read the first item in my Mail inbox" → automated action (with verification)

On macOS you can drive Finder / Mail / Safari / Notes / System Settings and any native app. **Windows and Linux work too** (see honest boundary below). Every action is verified — it confirms "it actually happened", never fakes success.

> **Honest boundary**: macOS is verified on real hardware; Windows / Linux pass compile-time and contract-level self-checks, but full real-machine manual testing is still in progress. **We don't fake "fully verified on Win/Linux".**

### Unified Scheduling Across Web and Desktop

> You: "List everything I can control right now" → one unified list

Web pages and desktop windows share one list — you don't have to distinguish "this is in the browser" vs "this is on the desktop". Claude picks what to act on, and everything flows from there.

### Revive Dead Links

> You: "This link 404s" → the most recent Internet Archive snapshot

Goes to the Internet Archive (Wayback Machine) to find the last archived copy of that URL. **It never treats a live link as dead** — only looks when you say "this is gone".

### Anti-Bot Bypass (off by default)

> You: "This site has Cloudflare, I can't scrape it" → cloud Chrome anti-bot

**Completely off by default.** Only activates when you explicitly turn it on AND have configured a cloud browser (self-hosted Steel or hosted browserbase/stagehand). Light anti-bot is already handled by `browse_headless`'s built-in anti-detection — **only Cloudflare-grade heavy protection needs the cloud browser**.

- **Steel self-hosted (recommended · free)**: run an open-source cloud browser in local Docker — zero per-session cost, cookies never leave your machine. One command to set up, see [Key Guide · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费).
- **browserbase (hosted · paid)**: pay-as-you-go after trial; the fallback when you don't want to run Docker yourself.
- **stagehand (hosted · paid)**: ⚠️ a programmatic experimental channel — configuring its key only assembles an internal channel, **there is no MCP tool entry** (the REST contract is unverified; `lasso doctor` #39 `stagehand_rest_contract_probe` tests exactly this).

---

## Install

**Current version v1.13.0** (changelog in the collapsed block at the end of this section).

Prerequisites: Node.js ≥ 20 + Claude Code (or any MCP-capable client).

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

Restart Claude Code → `/mcp` → `lasso ✓ Connected`. **That's the one line — no keys in it.** Scraping / screenshots / PDF / desktop control work right after install; only search takes an optional key (see [Configure](#configure)).

**macOS users wanting desktop control**: run `lasso doctor` once and tick `lasso-rust-helper` for "Accessibility" and "Screen Recording" as prompted — `doctor` walks you through it step by step.

<details>
<summary>📋 Changelog (v1.8 → v1.13 — click to see what each version changed)</summary>

- **v1.13**: consistent language fingerprint for the headless browser (HTTP `Accept-Language` issued with the profile, removing the "header zh-CN ↔ page en-US" contradiction); fixed the VLM landing point for region screenshots; `desktop find` rejects pure-ref queries; Steel session release capped at 3 seconds (a stalled Steel no longer hangs exit for 5 minutes).
- **v1.12**: dual-activation markdown extraction (defuddle dedicated extractors for 20+ sites + table/math fidelity); macOS default fingerprint aligned with the host system; honest desktop tail chain (VLM never fakes success / expect requires two consecutive hits / `truncated:true` signal); Electron input fields auto-degrade `type`; drag interpolation now usable; immediate wind-down on abnormal Claude Code exit.
- **v1.11**: desktop goes from "can watch" to "can click" (click/type/scroll really implemented + coordinate mouse + `skeleton` pruning); driver layer upgraded to chrome-devtools-mcp 1.7.0 (launch-level stealth, telemetry off by default); search gained the `freshness` time filter; zero-key English fallback switched to DuckDuckGo; new `LASSO_PROXY` egress proxy.
- **v1.10**: browsers silent by default + closed when done (`launch-chrome` zero-window launch, ~60 s auto-close, `--mode visible` to revert).
- **v1.9**: browser lifecycle wind-down (headless auto-recycled after 5 minutes idle, `lasso chrome-stop`, `tab_restore` restores the original tab list).
- **v1.8**: fixed the 24 defects exposed by the full field test (upstream contract adaptation, screenshots actually landing on disk, `read_text` pagination, etc.) — full list in the "v1.8 fix record" of [doc/17-功能测试清单.md](doc/17-功能测试清单.md).

</details>

---

## Configure

**Only search needs a key — everything else works right after install.** Look up what you need by task:

| What you want to do | What to configure |
|---|---|
| Scrape public pages / screenshots / PDF / see third-party resources / fetch raw bytes / drive the desktop | **Nothing at all** |
| Search | One Zhipu key (free to apply; not even that if the machine already has the Zhipu MCP) |
| Near-zero search failures | Add a Brave key (paid plan that includes a \$5/month credit; even without it there's a free live-search fallback) |
| Scrape logged-in pages | Run `lasso launch-chrome` once |
| Drive the macOS desktop | Run `lasso doctor` once to authorize |
| Scrape Cloudflare-protected sites | Master switch + Steel (free self-hosted) / browserbase (paid) |

The four modules below each give the shortest path to "it just runs"; details are collapsed and expandable.

### 1. Search (✅ Free · the only module that needs a key)

**First check whether you need to configure it**: if your machine already has the Zhipu `web-search-prime` MCP configured, Lasso **auto-detects and reuses its key** — nothing to fill in. Run `lasso doctor`: if `#36 machine_search_mcp` is `pass`, that's this case.

**To configure, three steps**:

```bash
lasso config init        # creates ~/.lasso/config.json
```

```json
{ "ZHIPU_API_KEY": "your_zhipu_key" }
```

Takes effect on save. **For more stability**, add Brave too (a paid plan that includes a \$5/month credit ≈ 1,000 queries, credit card required — the free tier was discontinued as of 2026-02; if any configured provider goes down it auto-switches to the next; multiple keys comma-separated, each with its own quota):

```json
{
  "ZHIPU_API_KEY": "your_zhipu_key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2",
  "BING_API_KEYS": "bingkey1"
}
```

> Fallback order: machine MCP reuse → Zhipu → Brave → (Bing shut down, auto-skipped) → live search in the headless browser as the last resort. If the one ahead fails, it auto-switches to the next.

How to apply for keys, how big the free tiers are → [Key Configuration Guide · Search](./doc/KEY-GUIDE.md#a-搜索). Common commands: `lasso --version` / `lasso --help` (since v1.8, unknown commands print usage and exit non-zero instead of silently hanging).

### 2. Scrape Logged-in Pages (✅ Free · one command, no key)

```bash
lasso launch-chrome
```

The first time, log in to your accounts in that window (handle 2FA yourself) — **the login state is reused from then on**. Afterwards, just say "open my logged-in Jira" to Claude.

- Works **silently with zero window** by default — never steals focus, always muted; add `--mode visible` to watch it work
- **Auto-closes ~60 s after its last use** — nothing to remember to clean up; `lasso chrome-stop` closes it manually at any time
- Tabs it opens in your Chrome are restored to the original list when you say `admin {action:"tab_restore", reason:"done"}` after a task (the same happens automatically on server exit)

> 🔴 **Red line**: 2FA / verification codes / CAPTCHA — Lasso doesn't solve these for you; pass them manually once in the window.

<details>
<summary>Details: profile reuse / port taken / tuning / silence boundaries</summary>

- Since v1.8, a dedicated Lasso profile is used by default (Chrome 136+ forbids opening a debug port on the default profile — the old way would exit instantly); to reuse an existing profile, use `lasso launch-chrome --profile <dir>`.
- After launch, the debug port is probed automatically; if Chrome didn't come up or the port is taken, it fails loudly instead of faking success.
- Auto-close threshold: `LASSO_LAUNCH_IDLE_MS` (default 60000; `300000` reverts to 5 minutes; `0` disables). To let a single long task through: `--idle-ms 3600000`.
- The headless browser auto-recycles after 5 minutes idle (`LASSO_HEADLESS_IDLE_MS` to tune or disable).
- Honest boundary: running `lasso launch-chrome` standalone (outside the server) has no idle auto-close — the exit is `chrome-stop`; `browse_logged_in` connecting to **your own visible Chrome** is "low-disturbance, not zero-disturbance" (a macOS platform-level limitation — occasional operations may steal focus once) — for pure silence use the hidden tier or `browse_headless`; `desktop` simulates a real human's keyboard and mouse, so it occupies the physical keyboard/mouse by design — there is no silent form.
- chrome-stop only closes the Chromes Lasso itself launched, with verified ownership — it never touches your manually-opened browsers.

</details>

**Details** → [Key Configuration Guide · Logged-in Browsing](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key).

### 3. Drive the Desktop (✅ Free · authorize once, no key)

- **macOS**: run `lasso doctor` and tick `lasso-rust-helper` for "Accessibility" + "Screen Recording" as prompted
- **Windows**: on the first desktop action, the system pops an authorization dialog — click "Allow"
- **Linux**: install the accessibility interface (GNOME/MATE have it by default; if not, `sudo apt install at-spi2-core`)

> Honest boundary: macOS is verified in real environments; Windows / Linux pass compile-time and contract-level self-checks, while full real-machine manual testing is still in progress — no faking "fully verified".

**Details** → [Key Configuration Guide · Desktop Control](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key).

### 4. Cloud Browser (off by default · only needed for heavy anti-bot)

Light anti-bot is already handled by `browse_headless`'s built-in anti-detection — **don't configure this if you don't need it**. Turn it on only for Cloudflare-grade anti-bot; it needs the master switch plus one channel at the same time:

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

- **Steel self-hosted (recommended · free)**: one Docker command — `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`; zero per-session cost, cookies never leave your machine
- **browserbase hosted (paid)**: swap in `"BROWSERBASE_API_KEY": "your_key"` — the fallback when you don't want to run Docker
- ⚠️ stagehand: a programmatic experimental channel with no MCP tool entry — don't count on it for scraping pages

**How to apply for keys, full Steel setup steps** → [Key Configuration Guide · Cloud Browser](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁).

<details>
<summary><b>Advanced tuning (optional — ordinary users can skip)</b></summary>

You can **completely ignore** the below for daily use. These are only for special scenarios, and most can be set via `lasso config init` into `~/.lasso/config.json` or overridden via environment variables (env vars take precedence over the config file, handy for temporary swaps):

- Change the logged-in Chrome's debug port (when the default `9222` is taken)
- Move the cache / state files to a different location
- Restrict to free search sources only
- Allow company intranet / special proxy ranges
- Set your own passphrase to encrypt login cookies (if unset, macOS Keychain is used)
- Save search-result snapshots to disk (for regression testing)
- Tune the headless browser's idle auto-recycle time (`LASSO_HEADLESS_IDLE_MS`, default 5 minutes; `0` disables)
- Tune the launched Chrome's "close when done" time (`LASSO_LAUNCH_IDLE_MS`, default 60 s; `300000` restores 5 minutes, `0` disables) or switch back to visible launch (`LASSO_LAUNCH_MODE=visible`)
- Set an egress proxy for browsers (`LASSO_PROXY`, e.g. `http://127.0.0.1:7890`; **affects the headless browser and the Steel cloud browser only — your logged-in Chrome's egress always stays as-is** — v1.11)
- Set the Steel self-hosted cloud browser endpoint (`STEEL_ENDPOINT`, e.g. `http://localhost:3000`; needs `LASSO_ALLOW_CLOUD_BROWSER=true` too in order to activate)

Full variable list and defaults: [Key Configuration Guide · Advanced Tuning](./doc/KEY-GUIDE.md#e-高级调优可选全不配). **Surge / Clash TUN proxy networks (fake-ip, `198.18.0.0/15`) and `127.0.0.1` (used by the local Chrome CDP debug port) are already allowed out of the box** — no extra configuration needed. That's by design, not a missing setting.

> **Backward compatible**: if you previously installed with `claude mcp add -e KEY=VAL`, those env variables **still work** and **override** the config file. The config file is just an additional, friendlier path — it does not replace env.

</details>

---

## Privacy & Security

Your data is yours.

- **Login cookies are never exported**, unless you explicitly opt in and have them encrypted to disk. Lasso never secretly ships your login state anywhere.
- **Desktop action logs stay local** — zero remote reporting. Lasso doesn't phone home about what you do.
- **Cloud browser is off by default** — requires your **explicit double confirmation** (master switch + key) to activate. Without it, the capability effectively doesn't exist.
- **No 2FA / CAPTCHA / verification-code solving** (red line). These always require you, in person, to pass once in your local browser.
- **Strangers can't poke at your internal services** — internal-network access is denied by default; Surge / Clash TUN proxy networks are already allowed out of the box.
- **Search results are not written to disk by default** — only if you explicitly enable recording mode (for regression testing).

---

## Troubleshooting

**For any problem, step one is always `lasso doctor`.** It self-checks and tells you what's misconfigured.

| Symptom | What to do |
|---|---|
| macOS desktop control doesn't work | Tick `lasso-rust-helper` under "System Settings → Privacy & Security → Accessibility / Screen Recording" (`lasso doctor` guides you) |
| Logged-in page scrape fails | Log in once manually in your local Chrome (handle 2FA too), then say "open my logged-in X" |
| Save-as-PDF fails | Say "take a full-page screenshot of this page" instead |
| Search keeps returning nothing | Check whether the key expired / quota is exhausted; adding multiple providers (Zhipu + Brave) dramatically lowers the failure rate |
| A link won't open | Say "this link is dead, find an archive" to check the Internet Archive |
| Prompted that internal-network access was blocked | Double-check the URL; TUN proxy networks are allowed by default, other internal networks need explicit permission |
| Want to verify the anti-detection effect | Run `lasso doctor --stealth-check` — it drives the creepjs detection page and compares against a baseline (optional, doesn't affect daily use) |

Full FAQ and debugging tips in [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

---

## Who It's For / Not For

**For**

- **Heavy Claude Code users** — search, scrape, and drive the desktop every week, and don't want to install a separate MCP for each
- **Researchers / report writers / data folks** — search, grab clean text, revive dead links, end to end
- **People building RAG / knowledge bases** — web pages to clean markdown, with citation markers, saving tokens and money
- **Automation / DevOps folks** — drive macOS native apps, scrape logged-in internal dashboards
- **Anyone who scrapes logged-in pages often** — reuse the local Chrome session, no need to re-store credentials in config

**Not for**

- **People not using Claude Code or another MCP client** — Lasso is an MCP service and needs an MCP client to drive it
- **People who need only a single capability and already have a dedicated solution** — the all-in-one may be redundant
- **People looking to bypass 2FA / CAPTCHA** — red line; we don't do it, and won't.

---

## Support the Author

If Lasso helps you, buy the author a coffee ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat sponsor QR"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay sponsor QR">

</div>

Or ⭐ [Star this repo](../../stargazers), [open an Issue](../../issues), or [send a PR](../../pulls) — every one of them encourages the author.

---

## More Docs

- Deep architecture? See [Feature Architecture](doc/08-media-interact-功能架构.md)
- Version roadmap? See [Implementation Roadmap](doc/09-media-interact-实施排期.md)
- Key setup? See [Key Configuration Guide](doc/KEY-GUIDE.md)

## License

**MIT** © wangdong233. The desktop helper process and browser-engine dependencies are all MIT / Apache-2.0 — safe for enterprise use.

> Want the internal architecture, design principles, cross-platform boundaries, and dev commands? See [ARCHITECTURE.md](./ARCHITECTURE.md) and [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md).

<p align="center">
  <sub>Built for everyone who'd rather <strong>say it</strong> than <strong>script it</strong>.</sub><br>
  <sub>Install once — search, scrape, scrape logged-in, drive desktop, all in one sentence.</sub>
</p>
