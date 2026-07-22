# Lasso

[简体中文](README.md) | **English**

> Claude Code's "grab handle for everything outside" — search, scrape the web, scrape logged-in pages, drive the desktop, all in one sentence.
> Cowboy lasso — rope any interface.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![npm version](https://img.shields.io/npm/v/lasso-mcp)](https://www.npmjs.com/package/lasso-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()

Twin star of [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp) (the image grab handle): "every image operation in one MCP" ↔ "every external interaction in one MCP".

---

## Table of Contents

- [What You Say, What You Get](#what-you-say-what-you-get)
- [60-Second Start](#60-second-start)
- [What It Can Do for You](#what-it-can-do-for-you)
- [Install](#install)
- [Configure](#configure)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Who It's For / Not For](#who-its-for--not-for)
- [License](#license)

---

## What You Say, What You Get

| You say …… | You get |
|---|---|
| "Search for the latest on the rust async ecosystem" | Structured search results (auto-switches to the next engine if one is down — you don't feel a thing) |
| "Grab the text of the github.com homepage" | Clean article text (nav bars / ads / clutter stripped — saves 30–70% on tokens) |
| "Open my logged-in Jira and show my to-dos" | A snapshot of the logged-in page (reuses your local Chrome; you handle 2FA yourself) |
| "This link is dead, find an archive" | The most recent snapshot from the Internet Archive |
| "List the files in my current Finder window" | A list of desktop windows and controls (a semantic tree, not a screenshot) |
| "Take a full-page screenshot of this page" / "Save as PDF" | A file path on disk (no giant blob of image data dumped into the chat) |
| "What third-party trackers did this page load?" | A resource list with tracker-domain counts |
| "List everything I can control right now" | One unified list (web pages and desktop windows all in it) |
| "Turn off dark mode" | Auto click / type / hotkey (with result verification — it confirms it actually happened) |
| "Just fetch this JSON endpoint" | Raw bytes (fastest, cheapest) |
| "This site has Cloudflare, I can't scrape it" | Cloud Chrome anti-bot bypass (off by default; you explicitly opt in) |
| "Is Lasso set up correctly?" | A health-check report (tells you what's missing) |

> You don't need to memorize any capability names. Just say what you want — Claude picks the right way to get it done.

---

## 60-Second Start

### 30 seconds · One-line install (zero config)

```bash
claude mcp add lasso --scope user -- npx -y lasso-mcp@1.2.0
```

Restart Claude Code → type `/mcp` → see `lasso ✓ Connected`. Done.

### 30 seconds · With nothing configured, you can already do all this

No keys needed right after install:

- Scrape the text of any **public web page**, converted to clean markdown
- **Full-page screenshots** and **save-as-PDF**, returning a file path
- See **what third-party trackers a page loads**
- Fetch raw bytes from a JSON API or file directly
- Control native macOS apps (Finder / Mail / System Settings, etc. — requires a one-time tick in System Settings)

Your first output — just say to Claude:

> "Grab the text of example.com and turn it into markdown"

### Want more? Add one line

- **Search** → add a Zhipu key (see [Configure](#configure))
- **Scrape logged-in pages** (Jira / private GitHub / company intranet) → run `lasso launch-chrome` once
- **Control the macOS desktop** → run `lasso doctor` once to be guided through authorization

How to obtain each key, what free tiers exist — see the [**Key Configuration Guide**](./doc/KEY-GUIDE.md).

---

## What It Can Do for You

Grouped by **what you want to do**, not by tool name. Each is one sentence in, one sentence out.

### Search

> You: "Search for X" → structured search results

Defaults to Zhipu (strong for Chinese); you can add Brave and Bing for multi-source. **If any single source is rate-limited or down, it auto-switches to the next — you don't feel a thing.** Hitting one provider's free quota doesn't break the whole.

### Scrape Public Pages (no login)

> You: "Grab the text of example.com" → clean article text, three granularities available

Auto-strips nav bars, ads, sidebars and other clutter — **saves 30–70% on tokens** (and money). Need citation markers (great for research, feeding RAG)? One sentence switches modes.

### Scrape Logged-in Pages (even with 2FA)

> You: "Show me my Jira to-dos" → snapshot of the logged-in page

Reuses **your locally-logged-in Chrome** — you handle 2FA once; Lasso takes over the rest. Works for private GitHub repos, company intranets, paid-subscription content, etc.

> 🔴 **Red line**: Lasso **never solves 2FA / SMS codes / CAPTCHA / magic links for you**. You must manually pass these once in your local Chrome.

### Fetch Raw Bytes (fastest, cheapest)

> You: "GET this JSON endpoint" → raw bytes

When you don't need to render a full page, direct HTTP is **~4× faster and ~4× cheaper** than going through a browser. Auto-detects content type (JSON / text / binary).

### Screenshot / Archive

> You: "Take a full-page screenshot" / "Save as PDF" → file path on disk

All images and PDFs are **saved to disk and a path is returned** — no giant blob dumped into your chat to waste context.

### See What a Page Loads

> You: "What third-party trackers did this page load?" → resource list with tracker-domain counts

Auto-identifies every resource the page loads, grouped by third-party domain — handy for spotting privacy risk and performance bottlenecks.

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

**Completely off by default.** Only activates when you explicitly turn it on AND have configured a cloud-browser key. You don't need it for normal pages.

---

## Install

**Prerequisites**: Node.js ≥ 20; Claude Code (or any MCP-capable client).

```bash
# Claude Code (recommended)
claude mcp add lasso --scope user -- npx -y lasso-mcp@1.2.0
```

Restart Claude Code → `/mcp` → `lasso ✓ Connected`.

**macOS users wanting desktop control**: run `lasso doctor` once and follow the prompts to tick `lasso-rust-helper` under "System Settings → Privacy & Security" for both Accessibility and Screen Recording (`doctor` guides you — no need to hunt for the path yourself).

---

## Configure

Look up by **what you want to do** — the right column tells you what to set; for how to obtain keys, see the [Key Configuration Guide](./doc/KEY-GUIDE.md).

| What you want | What to configure | What it unlocks |
|---|---|---|
| Scrape public pages / screenshots / PDF / see trackers / fetch raw bytes / drive desktop | **Nothing** | Works right after install |
| Search (default: Zhipu) | `ZHIPU_API_KEY` | The main search entry |
| Near-zero search failures (multi-source) | Add `BRAVE_API_KEYS` / `BING_API_KEYS` | Auto-fails-over if one is down — you don't feel a thing |
| Scrape logged-in pages | Run `lasso launch-chrome` once | Reuses your local Chrome session |
| Drive the macOS desktop | Run `lasso doctor` once | Drive native apps |
| Drive the Windows desktop | Click "allow" on the system prompt on first use | Drive native apps |
| Drive the Linux desktop | Make sure AT-SPI2 is installed (usually default) | Drive native apps |
| Scrape Cloudflare-protected sites | `LASSO_ALLOW_CLOUD_BROWSER=true` + a cloud key | Off by default; needs your double confirmation |
| fake-ip proxy networks (Surge / Clash TUN) | **Nothing** | Already allowed out of the box |

**How to obtain each key, free quotas, multi-key rotation, and full JSON config examples**: see [**doc/KEY-GUIDE.md**](./doc/KEY-GUIDE.md).

Minimum viable config (search only):

```bash
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=your_key \
  -- npx -y lasso-mcp@1.2.0
```

---

## Privacy & Security

Your data is yours.

- **Login cookies are never exported**, unless you explicitly opt in and have them encrypted to disk. Lasso never secretly ships your login state anywhere.
- **Desktop action logs stay local** — zero remote reporting. Lasso doesn't phone home about what you do.
- **Cloud browser is off by default** — requires your **explicit double confirmation** (master switch + key) to activate. Without it, the capability effectively doesn't exist.
- **No 2FA / CAPTCHA / verification-code solving** (red line). These always require you, in person, to pass once in your local browser.
- **Internal-network access is denied by default** (SSRF protection), guarding your internal services from being poked at random; fake-ip proxy networks (Surge / Clash TUN) are already allowed out of the box.
- **Search results are not written to disk by default** — only if you explicitly enable recording mode (for regression testing).

---

## Troubleshooting

**For any problem, step one is always `lasso doctor`.** It self-checks and tells you what's misconfigured.

| Symptom | What to do |
|---|---|
| macOS desktop control doesn't work | Tick `lasso-rust-helper` under "System Settings → Privacy & Security → Accessibility / Screen Recording" (`lasso doctor` guides you) |
| Logged-in page scrape fails | Log in once manually in your local Chrome (handle 2FA too), then say "open my logged-in X" |
| Save-as-PDF fails | Say "take a full-page screenshot of this page" instead |
| Search keeps returning nothing | Check whether the key expired / quota is exhausted; adding multiple providers (Zhipu + Brave + Bing) dramatically lowers the failure rate |
| A link won't open | Say "this link is dead, find an archive" to check the Internet Archive |
| Prompted that internal-network access was blocked | Double-check the URL; fake-ip proxy networks are allowed by default, other internal networks need explicit permission |

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

## License

MIT © wangdong233. The desktop helper process and browser-engine dependencies are all MIT / Apache-2.0 — safe for enterprise use.

> Want the internal architecture, design principles, cross-platform boundaries, and dev commands? See [ARCHITECTURE.md](./ARCHITECTURE.md) and [doc/TROUBLESHOOTING.md](./doc/TROUBLESHOOTING.md).

---

> Built for everyone who'd rather say it than script it.
> Install once — search, scrape, scrape logged-in, drive desktop, all in one sentence.
