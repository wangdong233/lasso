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
