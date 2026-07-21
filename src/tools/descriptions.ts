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
  "",
  "Args:  query (str, required)  — the search query",
  "       limit (int, 1-50, default 10)",
  "       engine (str, default 'zhipu')  — v0.1 only 'zhipu' wired",
  "       region (str, default 'cn')     — 'cn' or 'us'",
  "       no_cache (bool, default false)",
  "",
  "Returns: InteractResult<SearchResult> as JSON text.",
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
