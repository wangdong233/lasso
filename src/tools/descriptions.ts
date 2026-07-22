/**
 * MCP tool 描述常量（parse1 §3.12 + 附录 B）
 *
 * 4 段：SEARCH / BROWSE_HEADLESS / BROWSE_LOGGED_IN / DOCTOR。
 *
 * 设计原则（附录 B + mcp-chrome 风格）：
 *  - 每段都内嵌「[Prefer X over Y]」路由提示，让 LLM 在 tool-selection
 *    阶段就能挑对通道，减少一次错误调用 + fallback 往返。
 *  - 描述里显式声明「能做什么 / 不做什么 / 边界条件 / 安全考虑」，
 *    避免上游 LLM 把不该托付的任务塞进来（如 browse_logged_in 不解 2FA）。
 *  - 短句、动词开头、术语贴近 CC 既有习惯（snapshot / state_id / run_id）。
 *
 * 与 annotations.ts 配对：annotations 是结构化元数据（readOnlyHint / openWorldHint），
 * descriptions 是人类/LLM 可读说明。两者都在 registerXxxTool 里注册。
 */

// ============================================================
// SEARCH
// ============================================================
export const SEARCH_DESCRIPTION = [
  "Default structured web search via Zhipu web-search-prime (clean JSON, fast, cheap).",
  "",
  "AUTOMATIC FALLBACK: on rate-limit / timeout / 5xx / empty-result, transparently",
  "falls back to browse_headless real-search (baidu SERP scrape). The returned",
  "`outcome` + `fallback_used` + `served_by` fields tell you which path served you.",
  "",
  "Use for:",
  "  - keyword searches on public content",
  "  - fresh facts (news, docs, release notes)",
  "  - quick 'does X exist / what is Y' lookups",
  "",
  "[Prefer browse_headless for]:    scraping a specific known URL you already have.",
  "[Prefer browse_logged_in for]:  sites showing different content to logged-in users",
  "                                 (GitHub private repos, Jira, internal tools).",
  "[Prefer desktop for]:           native macOS apps (not browser pages).",
  "[Prefer wayback_lookup for]:    rescuing a dead search-result URL (404/timeout/5xx)",
  "                                 — does NOT auto-probe; call it explicitly.",
  "",
  "Args:  query (str, required)  — the search query",
  "       limit (int, 1-50, default 10)",
  "       engine (str, default 'auto')  — 'auto' | 'zhipu' | 'brave' | 'fallback_chain'",
  "       region (str, default 'cn')     — 'cn' or 'us'",
  "       no_cache (bool, default false)",
  "",
  "ENGINE CHOICE (v0.9):",
  "  - 'auto'           DEFAULT. Multi-source fanout (zhipu+brave concurrent)",
  "                     then browse_headless SERP scrape. Byte-identical v0.8.",
  "                     Use when you want maximum coverage and speed (default).",
  "  - 'fallback_chain' OPT-IN. Three-tier serial fallback: zhipu → brave → bing →",
  "                     browse_headless. Still reuses the single fallback engine",
  "                     (FallbackDecider; INV-55). Use for high-reliability scenarios",
  "                     ('search ≈ never fails') where you want maximum source",
  "                     redundancy at the cost of serial latency. When ALL sources",
  "                     trip and a RecordingStore is wired, returns the last recorded",
  "                     fixture for the same query (served_by='recording_replay');",
  "                     if no fixture, returns outcome=didnt (honest, no fabrication).",
  "                     Requires BING_API_KEYS env for the bing tier; without it the",
  "                     bing tier is silently skipped (behavior = v0.8 fallback chain).",
  "  - 'zhipu'          Single-source (Chinese主力). Quick when you know zhipu suffices.",
  "  - 'brave'          Single-source (English主力).",
  "",
  "Returns: InteractResult<SearchResult> as JSON text.",
].join("\n");

// ============================================================
// WAYBACK_LOOKUP（v0.9 Phase A/B —— parse10 §3.3 + §6 M3 手测）
// ============================================================
/**
 * wayback_lookup tool 描述（parse10 §3.3 + §1 决策 3 + INV-58）。
 *
 * 设计立场（守横切关注点边界 + 简单性 02 §5）：
 *  - **独立 tool**，不自动探测 search result 死链（INV-58）。
 *  - search 主路径 tools/search.ts / MultiSourceFanout.ts 都**不调**本 tool；
 *    CC 看到 search/browse 返回的 URL 404/timeout/5xx 时**显式调**本 tool。
 *  - SSRF 守门（INV-56 = INV-31 同源）：用户传入的 url 必经 ssrfGuard + doFetchUrl，
 *    即便只是传给 archive.org 当 query 参数，也拒私网 URL（防 archive.org 成 SSRF 探测代理）。
 *
 * 返回形状（WaybackLookupResult）：
 *   { url, archived:true|false, snapshot_url?, snapshot_timestamp?, snapshot_status?, availability_api_url }
 * archived=true 时 caller 二次调 fetch_url(snapshot_url) 取 archived 页面内容。
 *
 * 借鉴：fetch_url（doFetchUrl 范式）；browse.ts（payloadContent 包装）。
 */
export const WAYBACK_DESCRIPTION = [
  "Wayback Machine dead-link rescue — STANDALONE tool; does NOT auto-probe search results.",
  "",
  "Use when a URL from search/browse/fetch_url returns 404, timeout, or 5xx:",
  "  fetches the most recent archived snapshot metadata from archive.org.",
  "  When archived=true, the returned snapshot_url can then be fetched via fetch_url",
  "  to retrieve the archived page content.",
  "",
  "DOES NOT:",
  "  - auto-probe search result URLs (call this explicitly when a link is dead)",
  "  - return archived page content directly (only metadata; use fetch_url on snapshot_url)",
  "  - bypass paywalls or login walls",
  "",
  "[Prefer search for]:        discovering URLs by keyword (this tool needs a URL).",
  "[Prefer fetch_url for]:     fetching a live URL you already trust.",
  "[Prefer browse_headless]:   when you need JS rendering of a live page.",
  "",
  "SECURITY: input URL is SSRF-guarded twice (input check + archive.org egress);",
  "private IPs are rejected so archive.org cannot become an SSRF probing proxy.",
  "",
  "Args:  url (str, required)  — http(s) URL that is dead/inaccessible",
  "",
  "Returns: InteractResult<WaybackLookupResult> as JSON text. archived=true means",
  "         a snapshot exists; archived=false means archive.org has no copy.",
].join("\n");

// ============================================================
// BROWSE_HEADLESS
// ============================================================
export const BROWSE_HEADLESS_DESCRIPTION = [
  "Clean, isolated headless Chromium via chrome-devtools-mcp --headless --isolated.",
  "No login state. No cookie persistence. Page state is written to disk",
  "(~/.cache/lasso/<run_id>/); only a short state_id pointer + ≤1k-token preview",
  "are returned to save your context budget.",
  "",
  "Actions (parse1 §3.5 dispatch Map):",
  "  navigate   — go to url",
  "  snapshot   — a11y-tree text snapshot (default)",
  "  screenshot — PNG to disk; preview holds the path",
  "  extract    — full-page text extraction",
  "  click      — click an a11y uid (opts.selectors.click = uid)",
  "  fill       — fill_form (opts.selectors = { uid: value, ... })",
  "  wait       — wait_for text (opts.expect.text)",
  "  evaluate   — eval JS (opts.js) — documented risk, use sparingly",
  "",
  "Use for:",
  "  - public pages / JS-heavy SPAs / SERP fallback / screenshots",
  "  - extracting text content from a known URL",
  "",
  "[Prefer browse_logged_in for]: sites requiring auth — headless cannot log in.",
  "[Prefer search for]:          keyword discovery when you don't have a URL.",
  "",
  "SECURITY: URL is SSRF-checked. Defaults deny private IPs; an allowlist lets",
  "198.18.0.0/15 (fake-ip TUN) and 127.0.0.1/32 (CDP :9222) through. Extend via",
  "env LASSO_SSRF_ALLOW_RANGES='cidr1,cidr2'.",
  "",
  "Args:  url (str, required)   — http(s) URL (userinfo @ forbidden)",
  "       action (str, default 'snapshot')",
  "       options (object, optional) — { selectors, js, expect, screenshot, ... }",
  "",
  "Returns: InteractResult<BrowseResult> as JSON text.",
].join("\n");

// ============================================================
// BROWSE_LOGGED_IN
// ============================================================
export const BROWSE_LOGGED_IN_DESCRIPTION = [
  "Reuses your already-logged-in local Chrome via CDP port 9222",
  "(chrome-devtools-mcp --browser-url=http://localhost:9222).",
  "",
  "REQUIREMENTS:",
  "  1. Chrome started with --remote-debugging-port=9222",
  "  2. You have completed login (including any 2FA) in that Chrome",
  "",
  "DOES NOT:",
  "  - auto-login (no credential entry)",
  "  - solve 2FA / CAPTCHA / magic-link confirmation",
  "  - export or persist cookies",
  "If a login or 2FA page is detected, returns outcome=didnt +",
  "error='NEEDS_MANUAL_2FA' — you must complete login in Chrome yourself.",
  "",
  "Same action set + options as browse_headless (navigate / snapshot / click / ...).",
  "",
  "Use for:",
  "  - authenticated sites (GitHub private, Jira, Notion, internal tools)",
  "  - pages that gate content behind a login wall",
  "",
  "[Prefer browse_headless for]: public pages — headless is faster + cleaner.",
  "[Prefer search for]:         keyword discovery when you don't have a URL.",
  "",
  "SECURITY: same SSRF guard as browse_headless. 127.0.0.1:9222 is in the",
  "default allowlist so the CDP connect itself is permitted.",
  "",
  "Args:  url (str, required)   — http(s) URL",
  "       action (str, default 'snapshot')",
  "       options (object, optional)",
  "",
  "Returns: InteractResult<BrowseResult> as JSON text.",
].join("\n");

// ============================================================
// DOCTOR
// ============================================================
export const DOCTOR_DESCRIPTION = [
  "Returns a structured JSON readiness report — same shape as `lasso doctor` CLI.",
  "",
  "Checks (≥10):",
  "  node_version / zhipu_api_key / zhipu_endpoint_reachable /",
  "  cdp_mcp_installable / chrome_binary / cdp_9222_logged_in /",
  "  cache_writable / ssrf_config / serp_selectors / invariants.",
  "",
  "Each check: { name, status: 'pass'|'fail'|'warn', detail, next_step? }.",
  "Top level: { ready: bool, blockers: string[], checks: [...] }.",
  "",
  "Use for:",
  "  - first-time setup verification",
  "  - debugging 'why is Lasso returning unknown for everything'",
  "  - health probe before a long agent run",
  "",
  "No args. Returns the report as JSON text.",
].join("\n");

// ============================================================
// DESKTOP（v0.3.5 新增，parse4 §3.3.3）
// ============================================================
export const DESKTOP_DESCRIPTION = [
  "Control macOS native apps (Finder/Mail/Safari/Notes/System Settings/Xcode) via",
  "AXAPI semantics. Uses a Rust helper subprocess (stdin/stdout JSON-lines);",
  "prefers the AX tree over screenshots for speed + structure.",
  "",
  "Actions (action-enum collapsed, 13 #1):",
  "  snapshot   — AX tree → OutlineNode (default; ≤30ms for maxDepth=3)",
  "  find       — query cached snapshot by text/role/ref (no re-walk)",
  "  act        — click/type/press/scroll/hotkey with optional expect postcondition",
  "  wait       — poll for window/element/appFrontmost (tri-state)",
  "  screenshot — fallback for pictureOnly nodes (canvas/Metal)",
  "  doctor     — TCC / AX read-rate / signature / Rust helper health",
  "",
  "Use for: native macOS app control (NOT browser pages).",
  "[Prefer browse_headless for]:   public web pages (DOM-based, faster, no TCC).",
  "[Prefer browse_logged_in for]:  logged-in web sites (cookies preserved).",
  "[Prefer search for]:            keyword discovery when you don't have an app.",
  "",
  "REQUIREMENTS:",
  "  1. Rust helper signed with Developer ID (./rust-helper/build/sign.sh)",
  "  2. System Settings → Privacy → Accessibility granted to helper",
  "  3. (for screenshot) Screen Recording granted",
  "",
  "DOES NOT:",
  "  - read macOS Keychain credentials (F3.10.11)",
  "  - solve native auth prompts (boundary)",
  "  - run on Windows/Linux (v0.9.5+)",
  "  - fallback to browse_* when desktop fails (INV-23: no cross-surface)",
  "",
  "Args:  action (str, default 'snapshot')",
  "       options (object, optional) — { app, state_id, max_depth, actions, expect,",
  "                                       where, screenshot_region, timeout_ms, ... }",
  "",
  "Returns: InteractResult<OutlineSnapshot | DesktopResult> as JSON text.",
].join("\n");

// ============================================================
// INTERACT_ROOTS / OBSERVE / ACT（v0.4 forest 调度层，parse5 §3.1.5）
// ============================================================
export const INTERACT_ROOTS_DESCRIPTION = [
  "List all controllable UI roots as a unified @pN + @wN list, then dispatch",
  "observe/act on the chosen root via interact_observe / interact_act.",
  "",
  "Roots returned:",
  "  @pN  — browse page (from browse_headless + browse_logged_in CDP pages)",
  "  @wN  — desktop window (from macOS AX application main windows)",
  "",
  "Each root: { rootRef, kind, title, subtitle?, source }.",
  "  - browser_page.subtitle is the URL (interact_act dispatches navigate via it)",
  "  - window.title is \"{app}: {window title}\"",
  "",
  "Use interact_roots when you DON'T know which surface owns the target:",
  "  - user said 'the open Safari window' / 'my inbox' → list @wN + @pN to find it",
  "  - post-search: many tabs / windows opened, need to pick the right one",
  "",
  "[Prefer browse_headless for]:      public URL you already know (skip interact_roots).",
  "[Prefer browse_logged_in for]:     authenticated URL you already know.",
  "[Prefer desktop for]:              a specific native app name you already know.",
  "",
  "Identity reuse: calling interact_roots again returns the SAME @pN / @wN for",
  "the same URL/window (stable within session); no ref churn.",
  "",
  "Args:  kind (str, optional) — 'browser_page' | 'window' filter; omit for both",
  "",
  "Returns: { roots: RootInfo[], count: int } as JSON text.",
].join("\n");

export const INTERACT_OBSERVE_DESCRIPTION = [
  "Read-only observe on a root returned by interact_roots.",
  "",
  "Routes by rootRef prefix:",
  "  @pN → BrowseChannel.browse(url, action, options)",
  "        actions: snapshot | find (extract=snapshot alias; navigate/screenshot",
  "        are act-shape — use interact_act for those)",
  "  @wN → DesktopChannel.observe(action, options)",
  "        actions: snapshot | find",
  "",
  "Use interact_observe when you want a unified snapshot/find API across browse",
  "and desktop — model picks rootRef once, then observe without re-routing.",
  "",
  "[Prefer browse_headless directly for]: known public URL snapshot (1 less hop).",
  "[Prefer desktop directly for]:          known app name snapshot.",
  "",
  "Args:  root_ref (str, required)  — @pN or @wN from interact_roots",
  "       action (str, default 'snapshot')  — 'snapshot' | 'find'",
  "       options (object, optional) — { selectors?, js?, where?, max_depth?, ... }",
  "",
  "Returns: InteractResult<BrowseResult | OutlineSnapshot | {matches,count}> JSON.",
].join("\n");

export const INTERACT_ACT_DESCRIPTION = [
  "Side-effecting action on a root returned by interact_roots.",
  "",
  "Routes by rootRef prefix:",
  "  @pN → BrowseChannel.browse(url, action, options)",
  "        actions: navigate | snapshot | screenshot | extract | click | fill |",
  "                 wait | evaluate (default 'act' = passthrough to desktop)",
  "  @wN → DesktopChannel.act / .wait (action='act' or 'wait')",
  "        pass options.actions = [{kind:'click'|'type'|'press'|'scroll'|'hotkey', ...}]",
  "        + optional options.expect for postcondition tri-state",
  "",
  "Stale / unknown rootRef → outcome='didnt' + retrieval_method='stale_root_ref'",
  "(call interact_roots again to refresh the registry).",
  "",
  "Cross-surface safety: dispatcher NEVER falls back browse → desktop or vice",
  "versa (INV-23 honored at the channel layer; forest dispatcher just routes).",
  "",
  "[Prefer browse_headless directly for]: known public URL click/fill.",
  "[Prefer desktop directly for]:          known app name click/type.",
  "",
  "Args:  root_ref (str, required)  — @pN or @wN from interact_roots",
  "       action (str, default 'act')  — browse vocab | 'act' | 'wait'",
  "       options (object, optional) — { selectors?, actions?, expect?, ... }",
  "",
  "Returns: InteractResult<BrowseResult | DesktopResult> as JSON text.",
].join("\n");

// ============================================================
// BROWSERBASE（v0.4 M0.4c 新增，parse5 §3.2 + §6.3 #16）
// ============================================================
export const BROWSERBASE_DESCRIPTION = [
  "Cloud Chrome via browserbase.com — anti-bot circumvention for sites that",
  "block browse_headless / browse_logged_in (Cloudflare challenges, bot detection).",
  "",
  "REQUIREMENTS (manual-switch, INV-25 double unlock):",
  "  1. LASSO_ALLOW_CLOUD_BROWSER=true (explicit opt-in)",
  "  2. BROWSERBASE_API_KEY set (paid service — ~$0.10/h metered)",
  "Both must be set or this tool is NOT registered (default OFF, zero regression).",
  "",
  "DOES NOT:",
  "  - act as the default browser path (prefer browse_headless / browse_logged_in)",
  "  - solve 2FA / CAPTCHA (cloud_browser_requires_manual_switch on challenge)",
  "  - auto-bypass stealth failures — escalates to manual-switch (Argus pattern)",
  "  - share login state with browse_logged_in (separate cloud Chrome profile)",
  "",
  "policy_risk=watched: commercial ToS in observation period. doctor warns;",
  "                      manual-switch opt-in required to use at all.",
  "",
  "Same action set + options as browse_headless (navigate / snapshot / click /",
  "fill / ...). Stealth profile (navigator.webdriver=false, user-agent spoof,",
  "window.chrome) injected before every navigate via CDP evaluate.",
  "",
  "Use for:",
  "  - Cloudflare-protected public pages where browse_headless is blocked",
  "  - bot.sannysoft-style anti-bot checkpoints",
  "  - scraping公开 data on sites that fingerprint headless Chromium",
  "",
  "[Prefer browse_headless for]:    public pages without anti-bot (faster, free).",
  "[Prefer browse_logged_in for]:   authenticated sites (cloud Chrome has no cookies).",
  "[Prefer search for]:             keyword discovery when you don't have a URL.",
  "",
  "SECURITY: same SSRF guard as browse_headless. Cloud Chrome runs in",
  "browserbase's datacenter — your IP is not exposed to the target site.",
  "",
  "STEALTH ESCALATION: if Cloudflare challenge is detected post-navigate,",
  "returns outcome=didnt + retrieval_method='cloudflare_manual_switch' — you",
  "(the model) should ask the user before retrying; never auto-solve CAPTCHA.",
  "",
  "Args:  url (str, required)   — http(s) URL",
  "       action (str, default 'snapshot')",
  "       options (object, optional) — { selectors?, js?, expect?, ... }",
  "",
  "Returns: InteractResult<BrowseResult> as JSON text.",
].join("\n");

// ============================================================
// FETCH_URL（v0.5 M0.5a 新增，parse6 §3.1 + §1.4 路由决策表）
// ============================================================
export const FETCH_URL_DESCRIPTION = [
  "Direct HTTP fetch — raw bytes only, no JS rendering, no browser. Uses the",
  "shared undici keep-alive pool (SubprocessManager.acquireHttpClient) and the",
  "same SSRF guard as browse_headless.",
  "",
  "Use for:",
  "  - raw HTML source (unlike browse_headless which gives rendered DOM)",
  "  - JSON REST API responses (returns JSON verbatim)",
  "  - plain text / CSV / XML / static assets",
  "  - latency- or token-sensitive fetches (4x faster + 4x cheaper than browse)",
  "",
  "[Prefer browse_headless for]:   JS-heavy SPAs (fetch won't run scripts).",
  "[Prefer browse_headless for]:   structured a11y snapshot (Playwright-style).",
  "[Prefer browse_headless for]:   anti-bot sites (Cloudflare blocks raw fetch).",
  "[Prefer browse_logged_in for]:  authenticated endpoints (fetch_url sends no cookies).",
  "[Prefer screenshot for]:        a rendered image of the page.",
  "[Prefer pdf for]:               a paginated PDF of the page.",
  "[Prefer network for]:           the page's resource load trace.",
  "",
  "DOES NOT:",
  "  - follow redirects (3xx → outcome=didnt + data.location; re-call fetch_url",
  "    on the new URL yourself — keeps SSRF caller-explicit per hop)",
  "  - execute JavaScript or render pages",
  "  - send cookies / Authorization (set options.headers explicitly if needed)",
  "  - retry on failure (caller-tier decision, not engine decision)",
  "  - fall back to browse_headless (INV-23 honored: fetch vs browse never fall back)",
  "",
  "BODY ROUTING by Content-Type (parse6 §3.5):",
  "  text/html, application/xhtml+xml         → body_kind=html (raw text)",
  "  application/json, */+json                → body_kind=json (raw text)",
  "  text/plain, text/css, text/csv, text/xml → body_kind=text (raw text)",
  "  image/*, video/*, application/pdf, etc.  → body_kind=binary:<subtype>",
  "                                            (base64-encoded text)",
  "",
  "SECURITY: URL is SSRF-checked. Private IPs (10.x / 127.x / 169.254.169.254",
  "metadata / 192.168.x) blocked; default allowlist passes 198.18.0.0/15 (fake-ip",
  "TUN) + 127.0.0.1/32 (CDP). Extend via LASSO_SSRF_ALLOW_RANGES='cidr1,cidr2'.",
  "redirect:'manual' ensures redirects cannot be used to bypass SSRF.",
  "",
  "BOUND: response > 48 KiB auto-spills to /tmp/lasso-output/@oN.txt (mode 0o600)",
  "and the response carries a 16 KiB preview + ref — read_text({ref:@oN, offset}).",
  "",
  "Args:  url (str, required)               — http(s) URL (userinfo @ forbidden)",
  "       options.method (str, default 'GET')  — 'GET' | 'HEAD' (POST/PUT not in v0.5)",
  "       options.headers (object, optional)   — custom request headers",
  "       options.timeout_ms (int, default 30000, max 60000)",
  "       options.max_bytes (int, default 2097152, max 16777216)  — 2 MiB default, 16 MiB cap",
  "       options.no_cache (bool, default false)  — adds Cache-Control: no-cache",
  "",
  "Returns: InteractResult<FetchUrlResult> as JSON text.",
].join("\n");

// ============================================================
// SCREENSHOT（v0.5 M0.5b 新增，parse6 §3.2 + §1.4 路由决策表）
// ============================================================
export const SCREENSHOT_DESCRIPTION = [
  "Capture a PNG screenshot of a URL via chrome-devtools-mcp --headless.",
  "Navigates to the URL, takes a full-page or viewport screenshot, saves PNG",
  "to disk, and returns the file path (not base64) to keep your context budget",
  "small — read the file with read_text or open it directly.",
  "",
  "Use for:",
  "  - visual verification (does the page look right?)",
  "  - charts / maps / canvas content that text snapshots can't capture",
  "  - recording a page state at a point in time (debugging)",
  "  - feeding a screenshot to a downstream VLM (vision-language model)",
  "",
  "[Prefer browse_headless for]:   text content / a11y tree (much smaller, faster).",
  "[Prefer fetch_url for]:         raw HTML / JSON bytes (10x cheaper than screenshot).",
  "[Prefer pdf for]:               a paginated, printable document of the page.",
  "[Prefer browse_logged_in for]:  pages that require authentication.",
  "[Prefer desktop for]:           native macOS apps (not browser pages).",
  "",
  "DOES NOT:",
  "  - accept pageRef @pN in v0.5 (only URL; pageRef arrives in v0.6 forest merge)",
  "  - honor options.region / options.viewport / options.format in v0.5 (accepted",
  "    for forward-compat but chrome-devtools-mcp take_screenshot is wired to",
  "    format=png + fullPage only; region / mobile-emulation viewport推 v0.6+)",
  "  - return base64 PNG (only the file path; use read_text or shell to view)",
  "  - fall back across surfaces (INV-23 honored)",
  "",
  "Args:  url (str, required)             — http(s) URL (userinfo @ forbidden)",
  "       options.full_page (bool, default false)  — true captures entire scroll height",
  "       options.format (str, default 'png')       — 'png' | 'jpeg' (v0.5: png only)",
  "       options.viewport (object, optional)       — {width, height} (v0.5: accepted, not mapped)",
  "       options.region (object, optional)         — {x, y, width, height} (v0.5: accepted, not mapped)",
  "       options.wait_until (str, default 'load')  — 'load' | 'domcontentloaded' | 'networkidle'",
  "       options.timeout_ms (int, default 30000)",
  "",
  "Returns: InteractResult<ScreenshotResult> as JSON text.",
  "        data.path is the PNG absolute path (e.g. /tmp/lasso-screenshot-<uuid>.png).",
].join("\n");

// ============================================================
// PDF（v0.5 M0.5b 新增，parse6 §3.3 + §4.4 Go/No-Go F1）
// ============================================================
export const PDF_DESCRIPTION = [
  "Generate a PDF of a URL via chrome-devtools-mcp's `pdf` tool (CDP",
  "Page.printToPDF). Returns the PDF as base64 text, auto-spilling to",
  "/tmp/lasso-output/@oN.pdf (mode 0o600) when it exceeds 48 KiB; read the",
  "spill file with read_text({ref:@oN, offset}) and base64-decode locally.",
  "",
  "Use for:",
  "  - archiving a page as a printable document",
  "  - generating reports / invoices from web pages",
  "  - capturing a multi-page snapshot (PDF pagination handles long content)",
  "",
  "[Prefer browse_headless for]:  text content / a11y tree (PDF is overkill).",
  "[Prefer screenshot for]:       a single image (PDF is heavier + paginated).",
  "[Prefer fetch_url for]:        raw HTML / JSON bytes (10x cheaper than PDF).",
  "",
  "GO/NO-GO F1 (parse6 §4.4 + §7.1): chrome-devtools-mcp@LOCKED may not expose",
  "the `pdf` tool. If unsupported, returns outcome=didnt +",
  "retrieval_method='upstream_unsupported:pdf' + data.next_step (never crashes).",
  "Fallback: run Chrome locally with `--headless --print-to-pdf=url out.pdf`,",
  "or use browse_headless screenshot + a vision model. doctor CLI probes this",
  "as cdp_mcp_pdf_tool_available.",
  "",
  "DOES NOT:",
  "  - accept pageRef @pN in v0.5 (only URL; pageRef arrives in v0.6 forest merge)",
  "  - add watermarks / encrypt / fill forms (永远 NO-GO, parse6 §1.2)",
  "  - merge multiple URLs into one PDF (v0.6+ if needed)",
  "  - write binary PDF to disk (spill file contains base64 text; CC decodes)",
  "  - fall back across surfaces (INV-23 honored)",
  "",
  "SECURITY: URL is SSRF-checked (same guard as browse_headless).",
  "",
  "BOUND: PDF > 48 KiB auto-spills to /tmp/lasso-output/@oN.pdf (mode 0o600).",
  "Spill file content is base64 text (≈ 33% larger than binary PDF); read with",
  "read_text({ref:@oN, offset}) and base64-decode locally to recover binary.",
  "",
  "Args:  url (str, required)             — http(s) URL (userinfo @ forbidden)",
  "       options.format (str, default 'A4')        — 'A4' | 'Letter' | 'Legal' | 'Tabloid'",
  "       options.landscape (bool, default false)",
  "       options.print_background (bool, default true)  — include CSS backgrounds",
  "       options.margin_top/bottom/left/right (float, inches, optional, 0-5)",
  "       options.wait_until (str, default 'load')",
  "       options.timeout_ms (int, default 30000)",
  "",
  "Returns: InteractResult<PdfResult> as JSON text.",
  "        data.envelope carries preview (first 16 KiB of base64) + ref when spilled.",
].join("\n");

// ============================================================
// NETWORK（v0.5 M0.5c 新增，parse6 §3.4 + §1.4 路由决策表）
// ============================================================
export const NETWORK_DESCRIPTION = [
  "Capture the network resource list of a URL via JS-level PerformanceObserver",
  "injection (navigates first, then injects an observer for options.timeout_ms ms,",
  "then resolves the resource entries). Returns a JSON list of resources + a",
  "third-party count, auto-spilling to /tmp/lasso-output/@oN (mode 0o600) when it",
  "exceeds 48 KiB; read the spill file with read_text({ref:@oN, offset}).",
  "",
  "Use for:",
  "  - auditing third-party trackers / analytics / ad networks on a page",
  "  - debugging slow page loads (TTFB / duration per resource)",
  "  - seeing what XHR/fetch the page makes (filter: 'xhr' or 'fetch')",
  "  - estimating page weight (sum of transferSize across resources)",
  "",
  "[Prefer browse_headless for]:  full DOM + a11y tree (network is one slice).",
  "[Prefer fetch_url for]:        raw HTML/JSON bytes of the main document only.",
  "[Prefer screenshot for]:       a visual snapshot (not a network list).",
  "[Prefer pdf for]:              a printable archive (not a network list).",
  "",
  "GO/NO-GO F2 (parse6 §4.4 + §7.1): PerformanceObserver is a JS-level API, so it",
  "captures only resources the browser fetched after JS started. Under SSRF-",
  "allowlisted fake-ip / TUN proxies (Surge, Clash) the proxy may rewrite DNS or",
  "timing, so some entries can be missed or have skewed metrics. When this is",
  "detected the response includes data.next_step recommending CDP Network-level",
  "capture (planned for v0.7 F3.7.x).",
  "",
  "DOES NOT:",
  "  - capture CDP Network-level requests (JS-level only; v0.7+ for full HAR)",
  "  - capture WebSocket frames (v1.0+)",
  "  - capture response bodies in v0.5 (options.include_bodies accepted for",
  "    forward-compat but not wired; POST v0.6)",
  "  - mock / intercept / replay requests (永远 NO-GO; v1.0+)",
  "  - export a HAR file (v0.7 F3.7.x)",
  "  - accept pageRef @pN in v0.5 (only URL; pageRef arrives in v0.6 forest merge)",
  "  - fall back across surfaces (INV-23 honored)",
  "",
  "HINT: performance entries may be incomplete under proxy/TUN — if the count",
  "looks low for a heavy page, retry with options.timeout_ms=10000 or use the",
  "data.next_step hint.",
  "",
  "Args:  url (str, required)             — http(s) URL (userinfo @ forbidden)",
  "       options.filter (str, default 'all') — 'xhr' | 'fetch' | 'img' | '3rd-party' | 'all'",
  "       options.include_bodies (bool, default false) — v0.5: accepted, not wired (v0.6)",
  "       options.timeout_ms (int, default 3000) — PerformanceObserver采集窗口 (max 30000)",
  "       options.wait_until (str, default 'load') — 'load' | 'domcontentloaded' | 'networkidle'",
  "",
  "Returns: InteractResult<NetworkResult> as JSON text.",
  "        data.envelope carries preview (first 16 KiB of resource list JSON) + ref when spilled.",
  "        data.resource_count + data.third_party_count are always present on outcome=worked.",
].join("\n");

// ============================================================
// ADMIN（v0.6 M0.6 新增，parse7 §3.5 —— 单 admin tool + action-enum 折叠 9 action）
// ============================================================
/**
 * 设计（parse7 §3.5 + 13 §3.1 #1 必改原则）：
 *  - 单 admin tool + action-enum，禁注册 admin_capability_disable 等拆分 tool
 *    （与 INV-17 desktop action-enum 同范式；防 8+ 工具名污染 CC tool palette）
 *  - destructiveHint=true：与 desktop_act / browse_logged_in 同级风险
 *  - 所有 mutation 必须传 reason 字段（强制思考；R-RT-8 风险缓解）
 *  - description 明确标「ONLY when user explicitly asks to ...」
 *
 * 安全约束（parse7 §3.5）：
 *  - provider_add 时 keys 必须从 process.env.<PROVIDER>_API_KEYS 读，禁直接传 key 字面量
 *    （INV-10 衍生：anti-gaming；admin input schema 不接受 keys 字段）
 *  - provider_remove / capability_disable 必须传 reason + callerId（audit log 必填）
 *  - 所有 mutation 写 audit log（callerId + reason + timestamp + capability_name）
 *
 * 与 CC 的协议契约（parse7 §3.3 caller-tier）：
 *  - CC 当前不传 _meta.callerId → fallback "anonymous"（共享 defaultCap=100/min）
 *  - v0.7+ 若 CC 主动传 callerId 再启用真正 per-caller 隔离（不依赖 CC 行为变化）
 */
export const ADMIN_DESCRIPTION = [
  "Admin operations for runtime capability management (v0.6).",
  "Single tool with action-enum folding 9 actions. DO NOT call unless the user",
  "explicitly asks to change the running MCP server's capability set.",
  "",
  "Actions (capability_* / tool_list / provider_* / caller_cap_*):",
  "  - capability_list      : list all channel/provider names + enabled state",
  "  - capability_disable   : {name} temporarily disable (tool list refresh + subproc stop)",
  "  - capability_enable    : {name} re-enable",
  "  - tool_list            : list all registered tools + owning channel",
  "  - provider_add         : {config} hot-plug a new ProviderConfig (keys from env, not body)",
  "  - provider_remove      : {name} hot-unplug (channel tools unregistered)",
  "  - provider_set_tos     : {name, tos_ack} mark ToS state (pending|acknowledged|violated)",
  "  - caller_cap_set       : {callerId, cap} per-caller 60s cap override (0 = block)",
  "  - caller_cap_list      : list all caller budgets + current usage",
  "",
  "USE ONLY WHEN the user explicitly says one of:",
  "  - \"disable/enable the <channel> channel\" (e.g. browse_headless / desktop)",
  "  - \"add/remove a provider\" (e.g. a new Brave key pool)",
  "  - \"rate-limit caller X\" or \"what's caller X's usage\"",
  "  - \"what's the runtime state\" (capability_list + caller_cap_list)",
  "",
  "DO NOT USE FOR:",
  "  - searching / browsing / desktop automation (use the dedicated tools)",
  "  - normal fallback / retry (handled internally by FallbackDecider)",
  "  - persistent config edits (use $LASSO_PROVIDERS_FILE + SIGHUP for that)",
  "",
  "SECURITY:",
  "  - Every mutation writes an audit log line with callerId + reason + timestamp.",
  "  - capability_disable / provider_remove REQUIRE the `reason` field (forced thinking).",
  "  - provider_add reads API keys from process.env.<NAME>_API_KEYS, NOT from request body",
  "    (anti-gaming: keys never flow through the LLM tool-call surface).",
  "",
  "Args:  action (enum, required) — one of the 9 actions above",
  "       name (str, optional)    — channel/provider name (required for *_disable/_enable/_remove)",
  "       config (object, opt.)   — ProviderConfig for provider_add (keys field IGNORED, read from env)",
  "       tos_ack (enum, opt.)    — 'pending' | 'acknowledged' | 'violated' for provider_set_tos",
  "       callerId (str, opt.)    — caller identifier for caller_cap_set",
  "       cap (int, opt.)         — non-negative per-caller cap for caller_cap_set (0 = block)",
  "       reason (str, opt.)      — REQUIRED for capability_disable / provider_remove (audit)",
  "",
  "Returns: structured JSON per action (capability_list → CapabilityState[], etc.).",
].join("\n");
