# parse22 —— Phase B：serp_http 裸 HTTP 快探层

> 父文档：本目录（22-Bing清除与serp_http）。Phase A（Bing 死层清除）已完成，
> 测试基线 1967（-30 Bing 专属合法减），INV 79 条不变。
> Phase B 目标：在 `browse_headless` 实搜（冷启动 ~11s + Chromium 树）**之前**
> 插一层 ~1s 级裸 HTTP SERP 快探（serp_http）。
>
> 用户裁决依据：v1.14 重审实测（doc/governance/02-搜索方案重审）——裸 `curl` 打
> search.brave.com 返 200 + 22 条结果，而真 Chrome（browse_headless）反吃
> 验证码。即「无浏览器」对部分 SERP 反而**更不容易**被判 bot。
> 新降级链：machine_mcp → zhipu → brave → **serp_http** → browse_headless → recording_replay。

## 0. 架构红线（本设计的硬约束）

| 红线 | 落地方式 |
|---|---|
| 单 fallback 引擎不变（FallbackDecider 唯一，INV-4/55） | serp_http 只是 plan 里多一个 channel 档（executor 分支 + channelOrder 插项），仍由 `decider.runWithFallback` 串行调度；http-serp.ts 内**无** for/while 调 executor、无第二套 fallback 范式 |
| 禁第二套 selector | **零新增 selector 表**。抽取完全复用 `serp/extract.ts` 的 `extractResultsFromSnapshot`（URL 正则 + DDG 解包 + SELF_HOST_RE + 上下文 snippet）；URL 构造复用 `serpUrlFor`；引擎分流复用 `serpEngineForQuery`；改版检测/命中率复用 `SerpHealthMonitor.onResult`（内部 SelectorRegistry/HitRateStats/ChangeDetection 原链路） |
| tri-state 语义（被挡/空 → unknown 升浏览器，不伪造） | serp_http 一切失败路径（超时/非 200/验证码标记/抽取 0 条/SSRF 拒）→ `outcome=unknown`；且 error 字符串**刻意避开** `isFallbackWorthy` 排除集（404/403/forbidden/nxdomain/...）——保证 decider 判 fallback-worthy 继续升 browse_headless，而不是把 unknown 终止在快探层 |
| rust-helper/ 零改 | 本 Phase 不触碰 rust-helper/ 目录 |
| 连接池单一真源（INV-32 同精神） | http-serp.ts **不 new Agent**；fetch 经注入的 pooled fetch（index.ts 用 `subproc.acquireHttpClient(origin).fetch` 包装，per-origin 复用既有 httpAgents 池） |
| SERP 是债不是资产（10 §D.1） | serp_http 是 fallback 链内部层，**不是**新配置项、不注册新 server.tool、不进 doctor 检查项（内部层非用户配置面） |

## 1. 新文件：`src/serp/http-serp.ts`

### 1.1 主入口

```ts
rawSerpSearch(query, opts): Promise<InteractResult<SearchResult>>
opts: {
  region?: string;                      // "cn" | "us"（结果 data.region 标注）
  freshness?: "day"|"week"|"month"|"year"; // 复用 serpUrlFor 的 df= 逻辑（ddg 拼参，baidu/brave 诚实不拼）
  limit?: number;                       // 默认 10（baidu rn=）
  timeoutMs?: number;                   // 默认 5000（单次引擎尝试）
  fetchImpl?: typeof fetch;             // 注入 pooled fetch（缺省 global fetch，仅测试/兜底）
  serpHealth?: SerpHealthMonitor | null;
  ssrfConfig?: SsrfConfig;              // 注入；缺省 loadSsrfConfig()
}
```

### 1.2 流程（单引擎尝试 `httpEngineOnce`）

1. **URL**：`serpUrlFor(engine, query, limit, freshness)`（复用，byte-identical browse 层 URL 策略）。
2. **域名白名单**：解析 URL host，必须在 `SERP_HTTP_ALLOWED_HOSTS`
   （`www.baidu.com` / `html.duckduckgo.com` / `search.brave.com`）。
   不在 → unknown（`serp_http_host_not_allowed`）。搜索 URL 是固定引擎域名，不走用户输入 URL。
3. **SSRF 纵深**：仍过一遍 `ssrfGuard(url, ssrfConfig)`（fresh DNS + 私网/拒段判定，
   与 fetch_url/browse 同函数同 config）。拒 → unknown（`serp_http_ssrf_blocked`）。
4. **fetch**：`fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" })`。
   - headers 浏览器级，取自 `STEALTH_PROFILES`（stealth-profiles.ts 既有值，UA/sec-ch-ua/sec-fetch 全家桶）；
     profile 选择同 `defaultHeadlessProfileForHost` 规则（darwin→mac_chrome，否则 windows_chrome_120；
     规则在 http-serp 内联三元，不 import channels/ 防 serp→channels 缠绕——与 extract.ts BrowseExec 注入同立场）；
     baidu 引擎 Accept-Language 覆写 zh-CN（复用 mac_safari_17 的 acceptLanguage 值）。
   - AbortSignal.timeout 到期 → unknown（`serp_http_timeout`）。
5. **状态码分诊**（escalation-safe error 命名，见 §1.4）：
   - 202 → unknown `serp_http_challenge`（DDG anomaly 挑战页实测形态）
   - 429 → unknown `serp_http_rate_limited`
   - ≥500 → unknown `serp_http_upstream_error`
   - 其余非 200（含 401/403/404）→ unknown `serp_http_engine_blocked`
     （裸 HTTP 被挡恰是「真浏览器或许能过」的信号 → 必须升链，**不得**落 didnt）
6. **bot 探测（复用）**：body 命中 `CLOUDFLARE_DETECTION_REGEX`（stealth-profiles.ts 既有 marker 集）
   → unknown `serp_http_bot_detected`。（DDG/baidu 的挑战页由状态码 + 抽取 0 条兜住，不造第二套 marker。）
7. **HTML→文本**（**实施修订**：原设计走 `extractMarkdown` defuddle 管线；实施期
   白盒实测推翻——defuddle 正文抽取对 SERP 页有害：把结果标题 `<a>` 升格为 heading
   丢 href、丢摘要 div（百度 fixture 直接 0 结果）。SERP 需要保住**全部** `<a href>`
   的**全页**转换）。落地：markdown-extractor.ts 新导出 `createTurndownService()`
   工厂（与 extractMarkdown 内部同款配置，引擎与配置单一真源；INV-68 同精神），
   http-serp 直调 turndown 全页转 markdown，再 `serpHtmlToSnapshotText` 归一化：
   摊平 `[title](url)` → `title url` + 剥 ATX heading 记号（两条无状态正则，非 selector），
   使 a11y-快照抽取器可直接消费。
8. **抽取（复用）**：`extractResultsFromSnapshot(flattened, query)` —— URL 正则、
   DDG uddg 解包、SELF_HOST_RE（已含 baidu/duckduckgo/search.brave 自家链排除）、
   去重、snippet 上下文窗口，全部复用。
9. **字段诚实**：`data.engine = serp_http_<engine>`、`data.region` = baidu→cn / ddg、brave→us；
   `served_by = serp_http:<engine>`、`retrieval_method = serp_http_<engine>`。
10. **改版检测（复用）**：`serpHealth?.onResult(engine, "v1", query, html, count > 0)`
    （与 scrapeEngineOnce 同款调用形状）。
11. **tri-state 收口**：count === 0 → unknown `serp_http_empty`（空 ≠ 无结果判定，
    升浏览器复核，不伪造）；count > 0 → worked。

### 1.3 级联（与 serpScrapeFallback 同策略，v1.14 S-4）

- CJK query → baidu 单发（**不动**，同 S-4 红线）。
- 非 CJK → ddg 先发；`outcome !== worked || count === 0` → brave 一次 bail-out 级联；
  brave 有结果 → 返 brave；brave 也无 → 原样返 ddg 结果（失败语义与级联前一致）。
- 级联控制流镜像 extract.ts（约 10 行 if/else）；共享基座（URL/抽取/健康监测/引擎分流）
  全部单源复用。**总时长上界** ≈ 2 × timeoutMs + DNS（默认 5s+5s，远低于 11s 冷启动
  浏览器 + Chromium 树 + 页面渲染的慢路径）。

### 1.4 escalation-safe error 命名（关键正确性点）

`FallbackDecider` 对 `unknown` 会先问 `isFallbackWorthy(outcome, error)`；
error 含 `404/403/forbidden/nxdomain/...` 子串 → **不** fallback → 链终止在快探层，
browse_headless 永远不会被调——违背本层设计意图。故 serp_http 的 error 字符串
全部用语义桶命名（`serp_http_challenge` / `serp_http_engine_blocked` /
`serp_http_rate_limited` / `serp_http_upstream_error` / `serp_http_timeout` /
`serp_http_bot_detected` / `serp_http_empty` / `serp_http_ssrf_blocked` /
`serp_http_host_not_allowed` / `serp_http_fetch_failed`），
**不内嵌原始状态码/DNS 错误原文**（细节走 logger）。单测逐条断言
`isFallbackWorthy("unknown", err) === true`。

## 2. 接入 search.ts（browse_headless 之前）

### 2.1 注入式装配（零回归范式，同 machineMcp/INV-72 手法）

- `registerSearchTool` 新增末位可选参数 `httpSerp?: HttpSerpExec | null`：
  ```ts
  type HttpSerpExec = (query, opts: { region; freshness?; limit }) =>
    Promise<InteractResult<SearchResult>>;
  ```
- 未注入（null/undefined）→ 三处 plan 的 fallbacks 仍是 `["browse_headless"]`，
  行为 byte-identical 基线（既有全部测试不改一行）。
- 注入 → fallbacks 变 `["serp_http", "browse_headless"]`。

### 2.2 三个接入点

1. **fanout 路径**（engine="auto" 多源扇出）：`plan.fallbacks = [...serpHttp, "browse_headless"]`，
   executor 加 `"serp_http"` 分支调 `httpSerp(query, { region, freshness, limit })`。
2. **单源路径**（engine="zhipu"/"brave"）：同上。
3. **`runFallbackChainEngine`**（engine="fallback_chain"）：channelOrder 在
   `browse_headless` 之前 `push("serp_http")`（仅注入时），executor 加同名分支。
   函数签名追加可选参 `httpSerp: HttpSerpExec | null = null`（末位，既有调用零改动）。

`actions_and_results` 的 serp_http 条目由 decider 主循环自动记录
（`{channel: "serp_http", outcome, error}`）；metrics 由 decider
`metrics?.record("serp_http", outcome, latency)` 自动按 channel=serp_http 入窗
——**零新 metrics 代码**。

## 3. index.ts 装配

- `breakers` 加 `["serp_http", new CircuitBreaker()]`（60s 短熔断，与 browse_headless 同档；
  runtime_state/doctor 自动可见，无需新 check）。
- 构造 pooled fetch 包装：
  ```ts
  const serpHttpFetch = ((url, init) =>
    subproc.acquireHttpClient(new URL(String(url)).origin).fetch(url, init)) as typeof fetch;
  ```
  （复用既有 httpAgents 池——per-origin 懒建 Agent，单一真源不破。）
- `registerSearchTool(..., searchRpmLimiter, serpHttpExec)`，其中
  `serpHttpExec = (q, o) => rawSerpSearch(q, { ...o, fetchImpl: serpHttpFetch, ssrfConfig, serpHealth })`。

## 4. 不做的事（防越界）

- 不加 doctor 检查项（serp_http 是内部层非配置项；deepprobe 不新增）。
- 不注册新 server.tool（INV-67 同精神：内部子组件不进 tool 面）。
- 不动 rust-helper/、不动 CJK 百度路径、不动 zhipu/brave/machine_mcp 主路径。
- 不做多源并发（串行快探一层，保持链语义可审计）。
- README/KEY-GUIDE 仅中文先行更新降级链描述（8 语言 README 由 Phase C 统一）。

## 5. 测试计划

### 5.1 单测 `test/unit/serp-http.spec.ts`（mock fetchImpl + mock DNS，hermetic）

1. ddg 成功：200 + 含 `<a href>` 结果的 HTML → worked / served_by `serp_http:ddg` /
   engine `serp_http_ddg` / count>0 / 请求头含 Chrome UA。
2. 202 挑战 → 级联 brave 200 → served_by `serp_http:brave`（ddg→brave 级联）。
3. 403 → unknown + error `serp_http_engine_blocked`（且 `isFallbackWorthy` 为 true）。
4. 超时（fetchImpl reject AbortError）→ unknown `serp_http_timeout`。
5. CJK query → baidu URL（wd= / rn=）、zh Accept-Language、单次调用零级联。
6. 200 但抽取 0 条 → unknown `serp_http_empty`。
7. ddg 与 brave 双双失败 → 返 ddg 形状结果（级联前语义一致）。
8. ssrfConfig deny-all → unknown `serp_http_ssrf_blocked` 且 fetch 不被调。
9. body 含 Cloudflare marker（"Just a moment"）→ unknown `serp_http_bot_detected`。
10. 白名单：三引擎 `serpUrlFor` 输出 host ⊆ `SERP_HTTP_ALLOWED_HOSTS`。
11. escalation-safe：全部 error 字符串过 `isFallbackWorthy("unknown", err) === true` 表驱动断言。
12. markdown 管线：`[title](url)` 摊平后标题正确抽取（title 不带 `[`/`(` 残骸）。

### 5.2 集成 `test/integration/search-fallback-chain.test.ts`（扩展 describe）

1. 链序：zhipu unknown → brave unknown → **serp_http worked** → browse_headless 不被调；
   actions_and_results = [zhipu, brave, serp_http]。
2. 升级：serp_http 返回 unknown（挑战）→ browse_headless 被调且终态 served_by browse_headless；
   actions_and_results 中 serp_http 在 browse_headless 之前。
3. 零回归：httpSerp=null（缺省）→ channelOrder 不含 serp_http（zhipu unknown → brave unknown
   → browse_headless 直达，行为 byte-identical）。

## 6. 验收门禁

```
npm run build && npm test && npm run check-invariants
```
- 测试数相对 Phase A 基线 1967 **只增不减**（预计 +25 左右）。
- INV 79 条全绿（INV-4/54/55/66/68 均不受影响：无第二 fallback 引擎、无 bing 回潮、
  无第二 selector、无新 Agent、无 markdown 静态 import 违例）。
