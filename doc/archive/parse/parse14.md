# parse14 — Lasso v1.6 SteelChannel（自托管 cloud 通道）文件/函数级执行计划

> **作者**：Lasso 功能分析师（白盒源码审查 + Steel 真读，拒绝猜测）
> **基线**：v1.5（1552 TS 测试 + 73 invariants 全绿，doc/16 §1.1 校正后）；Lasso MIT
> **范围**：新增 SteelChannel——「自托管 Browserbase」。Steel（Apache-2.0，steel-dev/steel-browser）自托管 cloud 浏览器服务，与 Lasso BrowserbaseChannel 范式 1:1 同构，但自托管 = 零 per-session 费 + cookie 不出本地。
> **上游**：doc/16 §0 #3 + §5 P1 建议 2 / §3 对比表 Steel 行 / 架构想法/03 审查清单
> **立场红线**：v1.5 零回归（1552 TS + 73 INV 不退步）；白盒——每条引源码/repo 证据；Steel license Apache-2.0 兼容 Lasso MIT。

---

## 1. v1.6 目标与范围

### 1.1 Steel 定位（基于 doc/16 + 源码真读）

doc/16 §0 #3 原文：「**Steel（Apache-2.0，7458★）是当前最值得新增的通道**——『自托管 Browserbase』，与 Lasso BrowserbaseChannel 范式 1:1 同构（REST → wsUrl → chrome-devtools-mcp --browser-url），但自托管 = 零 per-session 费 + cookie 不出本地（对 INV-48..53 cookie=身份红线极友好）。」

doc/16 §3 对比表 Steel 行判定：「✅✅ 最值得新增的通道（自托管=零费+cookie不出本地）」「✅✅ 与 BrowserbaseChannel 1:1 同范式」「license 兼容 MIT ✅」。

### 1.2 Lasso 现状（已有 BrowserbaseChannel 但两个痛点）

Lasso 已有 `BrowserbaseChannel`（`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BrowserbaseChannel.ts:107-268`），走 Browserbase 云端 SaaS：
- `defaultBrowserbaseSessionProvider`（L71-93）：POST `https://api.browserbase.com/v1/sessions` + `Authorization: Bearer $BROWSERBASE_API_KEY` → 拼 `wss://connect.browserbase.com/?session=${sid}`
- chrome-devtools-mcp `--browser-url=${wsUrl}`（L161-169）连远端 Chrome

**痛点 1（per-session 费）**：Browserbase 是付费 SaaS（providers.ts L229 `free_quota_per_month: 0` + `free_tier_level: "L4"` 付费档），每次 session 消耗 credits。

**痛点 2（cookie 出本地）**：Browserbase 的 Chrome 在云端，cookie/localStorage 物理上离开用户机器。这与 INV-48..53「cookie=身份红线」（`src/logged-in/CookieStore.ts` AES-256-GCM 落盘 + INV-51 master key 从 OS keychain）的隐私定位有张力——云 Chrome 的 cookie 不在 Lasso 的加密保护域内。

### 1.3 Steel 解决这两个痛点（源码证据）

- **零 per-session 费**：Steel 自托管（README「Running Locally → Docker」`docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`），Chrome 跑在用户自己的 Docker 容器内，无 credits 计费（session.service.ts L24-31 `sessionStats` 的 `creditsUsed` 字段在自托管版永远 0）。
- **cookie 不出本地**：Steel Docker 容器在用户本机（或用户自选的私有云），cookie/localStorage 物理留在用户域内。配合 Steel 的 `userDataDir` / `persist` 选项（sessions.schema.ts L72-76 + session.service.ts L138-141），可持久化到用户控制的目录。
- **反检测内置**（强于 Browserbase）：Steel 服务端自带 `fingerprint-generator`（session.service.ts L9 import + L14 `fingerprint?: BrowserFingerprintWithHeaders`）+ README「Anti-Detection: Includes stealth plugins and fingerprint management」+ `skipFingerprintInjection` 选项（sessions.schema.ts L46-48，默认 false = 注入）。这比 Browserbase（纯 Chrome，依赖 Lasso StealthEngine 注入）更强。

### 1.4 v1.6 范围（M = 必须 / O = 可选）

| 子功能 | 优先级 | 落到模块 |
|---|---|---|
| SteelChannel extends BrowseChannel | M | `src/channels/SteelChannel.ts`（新文件） |
| STEEL ProviderConfig | M | `src/config/providers.ts`（加 `STEEL` + `STEEL_PROVIDERS` export） |
| steel tool 注册（schema 同 browse） | M | `src/tools/steel.ts`（新文件，仿 browserbase.ts） |
| index.ts 条件装配（LASSO_ALLOW_CLOUD_BROWSER 双重解锁） | M | `src/index.ts`（cloud 装配段扩 Steel 分支） |
| INV-74（Steel 专属 grep 守护） | M | `src/invariants/check-invariants.mjs` |
| doctor Steel endpoint 可达探测 | M | `src/doctor/`（加 `steel_endpoint_reachable` check） |
| annotations.ts + descriptions.ts 加 STEEL 常量 | M | `src/tools/annotations.ts` + `descriptions.ts` |
| ChannelToSpec / V5_TOOL_TO_CHANNEL 映射 | M | `src/index.ts`（runtime CapabilityBag 联动） |

---

## 2. 文件结构

### 2.1 新增文件（2 个）

```
src/channels/SteelChannel.ts      # SteelChannel extends BrowseChannel（~280 行，仿 BrowserbaseChannel 268 行）
src/tools/steel.ts                # registerSteelTool（~160 行，仿 browserbase.ts 159 行）
```

### 2.2 修改文件（5 个，全部增量、零回归）

```
src/config/providers.ts           # +STEEL ProviderConfig + STEEL_PROVIDERS export（~40 行，仿 BROWSERBASE L224-278 范式）
src/index.ts                      # cloud 装配段扩 Steel 分支 + CHANNEL_TO_SPEC/V5_TOOL_TO_CHANNEL 加映射（~30 行）
src/tools/annotations.ts          # +steelAnnotations（ToolAnnotations，仿 browserbaseAnnotations）
src/tools/descriptions.ts         # +STEEL_DESCRIPTION（一句话描述）
src/invariants/check-invariants.mjs  # +INV-74（Steel 专属 grep 守护）
src/doctor/doctor.ts + src/doctor/checks/  # +steel_endpoint_reachable check（仿既有 cloud 探测范式）
test/...                          # SteelChannel 单测 + 集成测（见 §5）
```

### 2.3 不动文件（零回归保证）

- `src/channels/BrowseChannel.ts` —— SteelChannel 复用 actionDispatch Map + StepEngine + runExpect，**零修改**（R-CI-02 守）
- `src/fallback/FallbackDecider.ts` —— 单一 fallback 引擎，SteelChannel 作为 plan 一跳接入，**零修改**（INV-18 守）
- `src/fallback/PolicyGate.ts` —— cloud 浏览器双重解锁逻辑，**零修改**（INV-25 守；Steel 走同一 cloud 前缀判定）
- `src/channels/BrowserbaseChannel.ts` —— 姐妹通道，**零修改**（SteelChannel 是平级兄弟子类）
- `src/subprocess/SubprocessManager.ts` —— registerSpec/ensureRunning 范式复用，**零修改**

---

## 3. 各模块实施细节

### 3.1 SteelChannel（`src/channels/SteelChannel.ts`，新文件）

**核心设计**：`extends BrowseChannel`（与 BrowserbaseChannel L107 同构），复用 actionDispatch Map + StepEngine + runExpect。唯一差异在 `getMcpClient()` 的连接来源。

**与 BrowserbaseChannel 的 3 个关键差异**（全部基于 Steel 源码，非猜测）：

| 维度 | BrowserbaseChannel（L71-93, L161-169） | SteelChannel（新） | 源码证据 |
|---|---|---|---|
| **连接端点** | `wsUrl = wss://connect.browserbase.com/?session=${sid}`（session REST 返回 id 后自拼） | `http://$STEEL_HOST:9223`（Chrome CDP nginx proxy，固定端口） | Steel `nginx.conf`：9223 listen → `proxy_pass http://127.0.0.1:9222`（Chrome 内部 CDP_REDIRECT_PORT）；docs「External client connects to port 9223 → Nginx upgrades HTTP to WebSocket → proxies to internal port 9222」|
| **Session 模型** | 多 session（每次 POST 新建独立 session，并发安全） | **单例 session**（`SessionService.activeSession` 单个）→ **需 mutex 防并发 reset** | Steel `session.service.ts` L73 `public activeSession: Session`（单个字段）+ `pastSessions: Session[]`；controller `handleGetSessions` 返 `[currentSession, ...pastSessions]` |
| **释放语义** | DELETE /v1/sessions/:id | POST /v1/sessions/release | Steel `sessions.routes.ts`：`server.post("/sessions/:sessionId/release", ...)` + `server.post("/sessions/release", ...)`（L113-141） |

**SteelChannel 类骨架**（伪代码，引 BrowserbaseChannel 行号对照）：

```typescript
// sessionProvider：POST Steel /v1/sessions → 激活 session（单例模型）
export interface SteelSessionProvider {
  (endpoint: string): Promise<{ sessionId: string; status: string }>;
}

export const defaultSteelSessionProvider: SteelSessionProvider = async (endpoint) => {
  // POST http://$endpoint/v1/sessions → SessionDetails{ id, status, ... }
  // body: {} 或 { blockAds: true, dimensions: {...} }（Lasso 默认空 body，让 Steel 用默认）
  // 不同于 Browserbase：Steel 不需 Authorization header（自托管无 auth）
  // 失败：endpoint 不可达 / Steel 未启动 → 抛错；caller catch → outcome=unknown
  const r = await fetch(`${endpoint}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),  // 默认配置；用户可在 Steel 侧预配 fingerprint/proxy
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`steel_session_failed:${r.status}:${body.slice(0, 200)}`);
  }
  const json = (await r.json()) as { id?: string; sessionId?: string; status?: string };
  const sid = json.id ?? json.sessionId;
  if (!sid) throw new Error("steel_session_no_id");
  return { sessionId: sid, status: json.status ?? "live" };
};

export class SteelChannel extends BrowseChannel {
  readonly name = "browse_cloud_steel";  // cloud 前缀触发 PolicyGate 判定（与 browserbase 同族）

  private cachedClient: McpClient | null = null;
  private cachedSessionId: string | null = null;
  private sessionLock: Promise<void> = Promise.resolve();  // 单例 session mutex（Steel 限制）
  private readonly cdpEndpoint: string;  // http://host:9223（Chrome CDP nginx proxy）

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly steelEndpoint: string,   // http://localhost:3000（Steel API）
    private readonly stealth: StealthEngine,
    opts: { profileName?: StealthProfileName; sessionProvider?: SteelSessionProvider; specName?: string } = {},
  ) {
    super();
    this.profileName = opts.profileName ?? "windows_chrome_120";
    this.sessionProvider = opts.sessionProvider ?? defaultSteelSessionProvider;
    this.specName = opts.specName ?? "steel";
    // CDP endpoint = Steel API host + :9223（nginx proxy port）
    // 从 STEEL_ENDPOINT=http://localhost:3000 推导 → http://localhost:9223
    // 或独立配 STEEL_CDP_ENDPOINT（默认 http://localhost:9223）
    this.cdpEndpoint = deriveCdpEndpoint(steelEndpoint);
  }

  protected async getMcpClient(): Promise<McpClient> {
    if (this.cachedClient) return this.cachedClient;
    if (!this.steelEndpoint) {
      throw new Error("cloud_no_key:STEEL_ENDPOINT missing");  // 复用 cloud_no_key 语义
    }

    // 单例 session mutex：Steel 只允许 1 个 activeSession，并发 POST 会互相 reset
    // （session.service.ts startSession 先 resetSessionInfo 再启动，第二次调用清掉第一次）
    const release = await this.acquireSessionLock();
    try {
      // 1. 激活 Steel session（配置 fingerprint/proxy/userDataDir）
      if (!this.cachedSessionId) {
        const { sessionId } = await this.sessionProvider(this.steelEndpoint);
        this.cachedSessionId = sessionId;
        logger.info({ evt: "steel_session_acquired", session_id: sessionId });
      }
      // 2. registerSpec：chrome-devtools-mcp --browser-url=http://host:9223（CDP nginx proxy）
      //    与 LoggedInChannel --browser-url=http://localhost:9222 范式 1:1 同构
      this.subproc.registerSpec(this.specName, {
        command: "npx",
        args: ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
               `--browser-url=${this.cdpEndpoint}`],  // 注意：用 cdpEndpoint（9223），非 steelEndpoint（3000）
        mcpClientName: "lasso-browse-steel",
      });
      // 3. ensureRunning → McpClient
      this.cachedClient = await this.subproc.ensureRunning(this.specName);
      return this.cachedClient;
    } finally {
      release();
    }
  }

  // browse() override：preflight endpoint 检查（仿 BrowserbaseChannel L185-202）
  override async browse(url, action, options): Promise<InteractResult<BrowseResult>> {
    if (!this.steelEndpoint) {
      return { outcome: "didnt", data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "steel_no_endpoint",
               error: "STEEL_ENDPOINT missing; cloud browser disabled" };
    }
    return super.browse(url, action, options);
  }

  // beforeNavigate override：StealthEngine 注入（Steel 自带 fingerprint，可叠加 Lasso stealth）
  protected override async beforeNavigate(client: McpClient): Promise<void> { /* 同 BrowserbaseChannel L211-221 */ }

  protected override retrievalMethod(): string { return "cloud_steel"; }

  // 释放：进程退出或 channel disable 时调 POST /v1/sessions/release
  async releaseSession(): Promise<void> {
    if (this.cachedSessionId && this.steelEndpoint) {
      try {
        await fetch(`${this.steelEndpoint}/v1/sessions/release`, { method: "POST" });
      } catch (e) { logger.warn({ evt: "steel_release_failed", error: String(e) }); }
      this.cachedSessionId = null;
      this.cachedClient = null;
    }
  }
}
```

**关键决策点（白盒引证）**：

1. **CDP endpoint 用 9223 而非 session.websocketUrl**：Steel `sessions.schema.ts` SessionDetails 的 `websocketUrl` 字段（L93）值是 `getBaseUrl("ws")` = `ws://host:3000/`（Steel server 自身的 ws，用于 UI live viewer）。**这不是 Chrome CDP 的连接点**。Chrome CDP 经 nginx 9223→9222 暴露（`nginx.conf` 确认）。chrome-devtools-mcp `--browser-url=http://localhost:9223` 与 LoggedInChannel `--browser-url=http://localhost:9222` 范式 1:1 同构。

2. **单例 session mutex**：Steel `SessionService` 只有 `activeSession: Session`（session.service.ts L73 单字段）。并发 `startSession` 会先 `resetSessionInfo`（L196-210）清掉前一个 session。SteelChannel 内部加 Promise 队列锁（`sessionLock`），确保同一时刻只有一个 POST /v1/sessions 在飞。这是 SteelChannel 相对 BrowserbaseChannel 的**唯一新增复杂度**（Browserbase 多 session 天然并发安全）。

3. **不需 API key header**：Steel 自托管默认无 auth（README Quickstart curl 示例无 Authorization header；session.controller.ts `handleLaunchBrowserSession` 不读 auth）。`steelEndpoint` 直接是 `http://host:3000`，无 Bearer token。

### 3.2 Steel API 客户端（`defaultSteelSessionProvider`）

**REST 契约**（全部基于源码）：

| 操作 | HTTP | 路径 | Body | Response | 源码证据 |
|---|---|---|---|---|---|
| 创建/激活 session | POST | `/v1/sessions` | `{}` 或可选配置 | `SessionDetails{ id, status, websocketUrl, ... }` | sessions.routes.ts L67-89 + sessions.schema.ts CreateSession/SessionDetails |
| 释放 session | POST | `/v1/sessions/release` | `{}` | `ReleaseSession = SessionDetails & { success }` | sessions.routes.ts L113-130 + sessions.schema.ts L114 |
| 健康检查 | GET | `/health` | — | `{ status: "ok" }` 或 503 `{ status: "service_unavailable" }` | sessions.routes.ts L27-40 |
| 查询 session | GET | `/v1/sessions/:sessionId` | — | `SessionDetails` | sessions.routes.ts L92-110 |

**CreateSession 可选配置**（sessions.schema.ts L25-77，Lasso 默认 `{}` 让 Steel 用默认，用户可在 Steel dashboard 预配）：
- `proxyUrl`（代理 IP 轮换）
- `blockAds`（广告拦截）
- `dimensions: { width, height }`（视口）
- `fingerprint` / `skipFingerprintInjection`（指纹注入控制）
- `sessionContext: { cookies, localStorage }`（会话上下文持久化）
- `userDataDir` / `persist`（Chrome profile 持久化）
- `headless`（无头模式，env `CHROME_HEADLESS` default true）
- `timezone`（时区）

**Steel 自带反检测能力**（session.service.ts L9 import `BrowserFingerprintWithHeaders` + L14 session 级 fingerprint 参数 + README「stealth plugins and fingerprint management」）：
- 默认注入 fingerprint（`skipFingerprintInjection` default false）
- fingerprint 来自 `fingerprint-generator`（与 doc/16 §5 建议 1 的 Apify header-generator 同源思路）
- Steel 的反检测比 Lasso 现有 StealthEngine（4 路 JS 注入）更强——这是 SteelChannel 相对 BrowserbaseChannel 的额外收益（Browserbase 依赖 Lasso 注入，Steel 服务端自带）

### 3.3 配置 + PolicyGate（`src/config/providers.ts` + `src/index.ts`）

**STEEL ProviderConfig**（仿 BROWSERBASE L224-238 范式，关键差异 policy_risk=safe + licence=apache2）：

```typescript
const STEEL: ProviderConfig = {
  name: "steel",                    // channel 名 browse_cloud_steel
  type: "self_hosted",              // 自托管 Docker（非 api_key 型）
  endpoint_url: null,               // 运行时从 STEEL_ENDPOINT 读（http://localhost:3000）
  keys: [],                         // 无 API key（自托管无 auth）
  free_quota_per_month: 0,          // 零成本（用户自己的 Docker）
  quota_model: "request",
  fallback_order: 12,               // 在 stagehand(11) 之后（cloud 链尾）
  free_tier_level: "L1",            // self_hosted 等价零成本
  policy_risk: "safe",              // 自托管无收购/商用风险（doc/16 §5 建议 2）
  licence: "apache2",               // Steel Apache-2.0（LICENSE 确认）
  commercial_safe: true,            // 用户自己跑 Docker，无 ToS 风险
  tags: ["browse", "cloud", "self_hosted"],
  enabled: false,                   // 默认禁用；LASSO_ALLOW_CLOUD_BROWSER + STEEL_ENDPOINT 双重解锁
};

export const STEEL_PROVIDERS: readonly ProviderConfig[] = [STEEL];
export { STEEL };
```

**双重解锁**（`src/index.ts` `readCloudBrowserEnv()` 扩展，L176-200）：

```typescript
function readCloudBrowserEnv() {
  const manualSwitchOn = process.env.LASSO_ALLOW_CLOUD_BROWSER === "true";
  const browserbaseKey = process.env.BROWSERBASE_API_KEY ?? "";
  const stagehandKey = process.env.STAGEHAND_API_KEY ?? "";
  const steelEndpoint = process.env.STEEL_ENDPOINT ?? "";  // 新增：http://localhost:3000
  const cloudBrowserKeys = new Set<string>();
  if (browserbaseKey) cloudBrowserKeys.add("browserbase");
  if (stagehandKey) cloudBrowserKeys.add("stagehand");
  if (steelEndpoint) cloudBrowserKeys.add("steel");        // Steel 解锁条件 = endpoint（非 key）
  const enabled = manualSwitchOn && cloudBrowserKeys.size > 0;
  return { enabled, browserbaseKey, stagehandKey, steelEndpoint, cloudBrowserKeys, manualSwitchOn };
}
```

**PolicyGate**（零修改）：Steel channel 名 `browse_cloud_steel` 带 `cloud` 前缀，自动命中 PolicyGate 既有 cloud 浏览器判定逻辑（`src/fallback/PolicyGate.ts` 不动）。`policy_risk="safe"` 意味着 PolicyGate 三态过滤（safe/watched/acquired）不会 block 它——但 manual-switch 仍生效（INV-25 守）。

**index.ts 装配段**（L469-512 cloud 装配段扩 Steel 分支）：

```typescript
if (cloudEnv.enabled) {
  const stealth = new StealthEngine();
  if (cloudEnv.browserbaseKey) { /* 既有 BrowserbaseChannel 装配，不动 */ }
  if (cloudEnv.stagehandKey) { /* 既有 StagehandChannel 装配，不动 */ }
  if (cloudEnv.steelEndpoint) {                                       // 新增
    const steelChannel = new SteelChannel(subproc, cloudEnv.steelEndpoint, stealth);
    breakers.set("browse_cloud_steel", new CircuitBreaker());         // 短熔断
    logger.info({ evt: "cloud_browser_channel_wired", channel: "browse_cloud_steel", endpoint: cloudEnv.steelEndpoint });
  }
}
```

**runtime CapabilityBag 联动**（index.ts L677-707 + L822-854）：
- `CHANNEL_TO_SPEC` 加 `browse_cloud_steel: "steel"`
- `V5_TOOL_TO_CHANNEL` 加 `steel: "browse_cloud_steel"`
- `initialCapabilities` 加 `"browse_cloud_steel"`（条件：cloudEnv.enabled && steelEndpoint）
- `longBreakers` Map 加 `"browse_cloud_steel"`

### 3.4 steel tool 注册（`src/tools/steel.ts`，新文件）

**1:1 仿 browserbase.ts**（L1-159），唯一差异 channel 名 + retrieval_method：

```typescript
export function registerSteelTool(
  server: McpServer,
  steel: SteelChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
): void {
  server.tool("steel", STEEL_DESCRIPTION, steelSchema, steelAnnotations, async (args) => {
    const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
    if (!ssrfResult.allowed) return ssrfBlocked(ssrfResult.reason);
    // 单 channel terminal plan（cloud 浏览器是 fallback 链尾，INV-23 守）
    const plan = { primary: "browse_cloud_steel", fallbacks: [], cross_modal: false };
    const result = await decider.runWithFallback(plan, async (name) => {
      if (name === "browse_cloud_steel") return steel.browse(args.url, args.action, args.options ?? {});
      throw new Error(`unknown_channel:${name}`);
    });
    return browseResultContent(result);
  });
}
```

**schema**（`steelSchema`）：与 `browserbaseSchema`（browserbase.ts L36-77）完全同构——同 action 集 + 同 options 字段（selectors/js/wait_until/screenshot/timeout_ms/expect/stealth_profile）。

**装配**（index.ts L598-600 既有 browserbase 注册旁加 steel）：
```typescript
if (browserbaseChannel) { registerBrowserbaseTool(server, browserbaseChannel, decider, ssrfConfig); }
if (steelChannel) { registerSteelTool(server, steelChannel, decider, ssrfConfig); }  // 新增
```

---

## 4. 不明确点调研结论（全部源码证据，非猜测）

### 4.1 Steel repo 正确 URL

**`github.com/steel-dev/steel-browser`**（WebSearch + zread get_repo_structure 双重确认）。doc/16 §3 表「steel-dev/steel-browser」一致。注：任务描述提到的 `lfeobel/steel` 不存在（zread 返「repo not found」）——可能是任务作者笔误或混淆。

### 4.2 Steel API 契约细节（核心契约全部源码确认）

| 契约项 | 值 | 源码位置 |
|---|---|---|
| API 端口 | 3000 | env.ts L11 `PORT: default "3000"` + README docker run |
| CDP nginx proxy 端口 | 9223 → 内部 9222 | nginx.conf + env.ts L13 `CDP_REDIRECT_PORT: default "9222"` + docker-compose.yml `CDP_DOMAIN=localhost:9223` + ports 9223:9223 |
| Session 创建 | POST /v1/sessions → SessionDetails{ id, websocketUrl, status, ... } | sessions.routes.ts L67-89 + sessions.schema.ts SessionDetails L82-110 |
| Session 释放 | POST /v1/sessions/release → ReleaseSession | sessions.routes.ts L113-141 |
| 健康检查 | GET /health → { status: "ok"\|503 "service_unavailable" } | sessions.routes.ts L27-40 |
| websocketUrl 字段语义 | `ws://host:3000/`（Steel server ws，**非 Chrome CDP**） | session.service.ts L26 `websocketUrl: getBaseUrl("ws")` + url.ts getBaseUrl |
| Chrome CDP 连接点 | `http://host:9223`（nginx proxy 到 Chrome 9222） | nginx.conf + docs「Docker Deployment」 |

**关键澄清**：Steel `SessionDetails.websocketUrl`（ws://host:3000/）是 Steel server 自身的 ws（用于 UI live viewer / session streamer），**不是** Chrome CDP 的连接点。Chrome CDP 经 nginx 9223 暴露。chrome-devtools-mcp `--browser-url=http://host:9223` 才是正确连接方式。这与 BrowserbaseChannel 有本质差异（Browserbase 的 wsUrl 就是 CDP 连接点）。

### 4.3 Docker 部署方式

**一行启动**（README + docker-compose.yml）：
```bash
docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser
```
- 端口 3000 = Steel REST API（POST /v1/sessions）
- 端口 9223 = Chrome CDP nginx proxy（chrome-devtools-mcp --browser-url 连此）
- 镜像 = `ghcr.io/steel-dev/steel-browser`（预构建，API + UI 合一）
- 替代：`docker compose up`（api + ui 分离）；1-click Railway/Render（cloud 部署）

**Lasso 用户配置**（doctor 指导）：
```bash
export LASSO_ALLOW_CLOUD_BROWSER=true
export STEEL_ENDPOINT=http://localhost:3000
# 可选：STEEL_CDP_ENDPOINT=http://localhost:9223（默认从 STEEL_ENDPOINT 推导）
```

### 4.4 反检测内置能力（Steel 自带，强于 Browserbase）

- **fingerprint-generator**（session.service.ts L9 import）：贝叶斯网络驱动真实流量分布指纹 + header 生成。与 doc/16 §5 建议 1 的 Apify `fingerprint-suite/header-generator`（Apache-2.0）**同源思路**（Apify 的 fingerprint-suite 也是 fingerprint-generator 的上游）。
- **默认注入**（sessions.schema.ts L46-48 `skipFingerprintInjection` default false = 默认注入指纹）
- **stealth plugins**（README「Anti-Detection: Includes stealth plugins and fingerprint management」+ api/src/services/cdp/plugins/ 目录确认）
- **proxy IP 轮换**（session.service.ts L131-134 proxyUrl → ProxyServer.listen）
- **局限**（诚实标注）：Steel 不处理 Cloudflare interactive / CAPTCHA（与 Lasso + Browserbase 同 ceiling，doc/16 §2.4 Obscura 段已论证 JS 路线天花板）

### 4.5 与 BrowserbaseChannel 的完整差异表

| 维度 | BrowserbaseChannel | SteelChannel | 源码证据 |
|---|---|---|---|
| 部署模式 | 云 SaaS | 自托管 Docker | README + docker-compose.yml |
| 费用 | per-session credits（L4 付费） | 零（用户自己的 Docker） | providers.ts BROWSERBASE vs STEEL |
| 认证 | `Authorization: Bearer $KEY` | 无 auth（本地 HTTP） | session.controller.ts 不读 auth |
| Session 模型 | 多 session 并发 | **单例 activeSession**（需 mutex） | session.service.ts L73 |
| wsUrl 来源 | 拼 `wss://connect.browserbase.com/?session=id` | CDP nginx proxy `http://host:9223` | nginx.conf + url.ts |
| 释放 | DELETE /v1/sessions/:id | POST /v1/sessions/release | sessions.routes.ts |
| Cookie 位置 | 出本地（云端 Chrome） | 不出本地（本地 Docker） | 物理位置 |
| 反检测 | 依赖 Lasso StealthEngine（4 路 JS） | Steel 自带 fingerprint-generator | session.service.ts L9 |
| License | commercial ToS | Apache-2.0 | LICENSE 全文 |
| policy_risk | watched | safe | providers.ts |

---

## 5. 测试计划（参照 03 §2 五阶段）

### 5.1 单元测试（unit，SMALL，03 §2.1）

**SteelChannel 单测**（`test/channels/SteelChannel.test.ts`，仿 BrowserbaseChannel 测试范式）：

| 用例 | 断言 | 03 对应 |
|---|---|---|
| 构造永不抛（steelEndpoint="" 也不抛） | new SteelChannel(...) 不 throw | 03 §2.1 项 6 producer 契约 |
| browse() preflight：endpoint 缺 → outcome=didnt + retrieval_method="steel_no_endpoint" | 不触网、不抛 | 03 §2.1 项 3 测试必须能失败 |
| getMcpClient()：首次调 sessionProvider → registerSpec(--browser-url=http://host:9223) → ensureRunning | specName="steel"，args 含 9223 | 03 §2.1 项 6 |
| getMcpClient()：cachedClient 在 → 复用（不二次 POST /v1/sessions） | sessionProvider 调用次数=1 | 03 §2.1 项 2 纯函数性 |
| **单例 session mutex**：并发 2 个 getMcpClient() → sessionProvider 只调 1 次（不互相 reset） | sessionProvider 调用次数=1 | 03 §1.6 项 6 多写者竞态 |
| beforeNavigate：StealthEngine.injectProfile 失败 → 仅 warn 不抛 | browse 不阻断 | 03 §1.2 项 7 错误处理 |
| isAvailable()：endpoint 缺 → false | 短路 | 03 §2.1 |
| releaseSession()：POST /v1/sessions/release → cachedClient 清空 | fetch 调用 1 次 | 03 §2.1 项 6 |

**mock 策略**（03 §2.1 项 8 doubles 政策）：
- `sessionProvider` 注入 mock（返回固定 `{ sessionId: "test-uuid", status: "live" }`）
- `subproc` 注入 fake（ensureRunning 返 stub McpClient）
- `stealth` 注入 fake（injectProfile no-op）
- **不触真网**（不 fetch 真 Steel endpoint）—— SMALL 约束（03 §2 测试大小）

**mutation testing**（03 §2.1 项 4）：在 SteelChannel.ts 上注入 mutants（mutex 锁去掉 / endpoint 检查反转 / 9223→3000 端口错），准出门槛 mutation score ≥80%。

### 5.2 集成测试（integration，MEDIUM，03 §2.2）

**SteelChannel + SubprocessManager + McpClient 集成**（`test/integration/steel-channel.integration.test.ts`）：

| 用例 | 断言 | 03 对应 |
|---|---|---|
| registerSteelTool 注册后 server.listTools() 含 "steel" | tool 存在 | 03 §2.2 项 4 契约同步 |
| steel tool 调用 → SSRF guard 拦私网 | ssrf_blocked outcome | 03 §2.2 项 3 |
| decider.runWithFallback plan 含 browse_cloud_steel → 路由正确 | channel 名匹配 | 03 §2.2 |
| **双重解锁**：LASSO_ALLOW_CLOUD_BROWSER=false → SteelChannel 不实例化（index.ts 装配段） | channel 不存在 | 03 §2.2 项 4 |
| STEEL_ENDPOINT 未配 → SteelChannel 不实例化 | channel 不存在 | 03 §2.2 项 4 |
| CapabilityBag 含 browse_cloud_steel（条件装配） | bag.snapshot() 含 | 03 §2.2 |

### 5.3 端到端冒烟（smoke，LARGE，03 §2.3）—— **条件执行**

**前置条件**（doctor 探测 + 用户手动启 Steel Docker）：
1. `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser` 在本机跑起来
2. `curl http://localhost:3000/health` 返 `{ status: "ok" }`
3. `LASSO_ALLOW_CLOUD_BROWSER=true STEEL_ENDPOINT=http://localhost:3000 lasso-mcp`

**冒烟用例**（03 §2.3 项 3 真实场景值级断言）：
| 用例 | 值级断言 |
|---|---|
| steel tool navigate https://example.com → snapshot | outcome=worked, served_by="browse_cloud_steel", data.preview 含 "Example Domain" |
| steel tool extract https://example.com → markdown | outcome=worked, retrieval_method="cloud_steel" |
| steel tool screenshot https://example.com | outcome=worked, data.screenshot 非空 |
| **cookie 不出本地**验证 | 在 Steel Docker 容器内 `docker exec` 查 cookie 落盘路径在容器内（用户机器上），非外部云 |
| **单例 session 并发** | 连续 2 个 steel tool 调用（不 await 第一个）→ 都成功（mutex 保护）|

**03 §2.3 项 4**：smoke 附 screenshot 证据（Steel session viewer 截图）。

### 5.4 性能测试（perf，03 §2.4）—— 轻量

SteelChannel 本身是薄壳（REST + subprocess），性能瓶颈在 Chrome 本身（Steel 容器内）。Lasso 侧不单独做 perf——SteelChannel 的 overhead = 1 次 POST /v1/sessions（首次）+ npx chrome-devtools-mcp 启动（与 LoggedInChannel 同范式）。

### 5.5 用户测试（user，03 §2.5）

doctor `steel_endpoint_reachable` check 作为用户可执行的「验收」——用户跑 `lasso doctor` 看到 steel check 绿即证明 Steel 可用。

---

## 6. 验收标准 + 03 §1 六维度预设

### 6.1 功能验收（必须全过）

1. **Steel Docker + Lasso SteelChannel 跑通 navigate/snapshot/extract**（smoke §5.3）
2. **cookie 不出本地**：Steel session 在本地 Docker 内，cookie 落盘路径在容器内（docker exec 验证）
3. **单例 session 并发安全**：mutex 保护下连续调用不互相 reset
4. **双重解锁生效**：无 LASSO_ALLOW_CLOUD_BROWSER 时 steel tool 不注册（server.listTools() 不含）
5. **零回归**：1552 TS 测试 + 73 INV 仍全绿（INV-74 新增后变 74 INV 全绿）
6. **Steel 自带反检测可见**：steel tool 访问 bot.sannysoft.com 过基础检测（Steel fingerprint-generator 注入）

### 6.2 03 §1 六维度预设（本 parse 预判后续怎么过）

| 03 维度 | 本 parse 的预设应对 |
|---|---|
| **§1.1 代码规范** | SteelChannel.ts / steel.ts 命名 + 风格 1:1 仿 BrowserbaseChannel.ts / browserbase.ts（零风格漂移）；lint CI PRE-REVIEW 闸门 |
| **§1.2 数据逻辑** | Steel REST 契约每条引源码（sessions.schema.ts SessionDetails 字段集）；`sessionProvider` 返回 `{ sessionId, status }` 字段缺失语义明确（sessionId 缺 → 抛 `steel_session_no_id`）；写前校验（cachedSessionId 写入前 POST 成功才写）；**producer 契约验证**（03 §1.2 项 1）：每个读 Steel response 字段处引 sessions.schema.ts 行号 |
| **§1.3 业务逻辑** | 单例 session mutex 是核心业务规则（Steel 限制）；edge case：endpoint 不可达 / session create 失败 / release 失败 / 并发竞争——每个显式处理（try-catch + outcome=unknown） |
| **§1.4 端到端接通** | 值级 trace：`STEEL_ENDPOINT` → POST /v1/sessions → `{ id: "uuid" }` → registerSpec(--browser-url=http://host:9223) → ensureRunning → McpClient → chrome-devtools-mcp → Chrome 9222（经 nginx 9223）。**每一跳的具体值** + 「字段缺失→undefined」行（websocketUrl 字段不用，避免误连 Steel server ws）|
| **§1.5 性能 + 生产就绪** | feature flag = LASSO_ALLOW_CLOUD_BROWSER（disable switch ✅）；rollback = 删 STEEL_ENDPOINT env（channel 不实例化，行为等价 v1.5 ✅）；metrics = logger JSON 行（steel_session_acquired/failed）；无主线程同步阻塞（全 async）|
| **§1.6 简单架构** | SteelChannel 是 BrowseChannel **平级兄弟子类**（与 BrowserbaseChannel 同构，R-CI-02 守）；不嵌套、不动 actionDispatch Map、单一 FallbackDecider 复用；mutex 是 Steel 单例约束的**必要复杂度**（非过工程化）|
| **§1.7 冗余废弃** | SteelChannel / BrowserbaseChannel 有结构相似（~70%），但**不是冗余**——连接端点 / session 模型 / 释放语义本质不同（§4.5 差异表）。评估合并：若合并到 BrowserbaseChannel 需加 if-steel/if-browserbase 分支，反而增加复杂度（02 R-CI-08 DRY-as-decisions：这里是 intentional 分叉）|

---

## 7. 风险 + 实施顺序

### 7.1 风险登记

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-V16-1 | Steel 单例 session 在 Lasso 多 channel 并发下互相 reset | 中 | 高 | SteelChannel 内部 mutex（Promise 队列锁）；单测验证并发（§5.1）|
| R-V16-2 | 用户误把 `SessionDetails.websocketUrl`（ws://host:3000）当 CDP 连接点 → 连不上 | 高 | 中 | 本 parse §4.2 明确澄清 + 代码注释 + doctor 探测 9223 可达性 |
| R-V16-3 | Steel Docker 镜像 ~1GB+，用户环境门槛 | 中 | 中 | doctor 检测 Docker 可达性 + README 一键命令；R-ECO-3（doc/16 §8.1）已有登记 |
| R-V16-4 | Steel 版本升级改 API 契约（session 单例→多 session / 端口变更） | 低 | 中 | sessionProvider 抽象（可注入 mock + 替换实装）；doctor 探测契约漂移 |
| R-V16-5 | chrome-devtools-mcp `--browser-url=http://host:9223` 经 nginx 代理时 WS upgrade 失败 | 低 | 高 | smoke §5.3 真机验证；nginx.conf 已配 `proxy_set_header Upgrade/Connection upgrade`（源码确认）|
| R-V16-6 | Steel 自带 fingerprint 与 Lasso StealthEngine 注入冲突（双重注入反而露馅） | 中 | 中 | SteelChannel beforeNavigate 注入前查 Steel session 是否已注入；或 skipFingerprintInjection=true 让 Lasso 接管。**v1.6 MVP 默认依赖 Steel 自带**（skipFingerprintInjection=false），Lasso StealthEngine 作为可选叠加 |

### 7.2 实施顺序（~3-5 天，对齐 doc/16 §5 建议 2 估算）

```
Day 1: STEEL ProviderConfig（providers.ts）+ INV-74（check-invariants.mjs）+ annotations/descriptions
Day 2: SteelChannel.ts（getMcpClient + mutex + browse preflight + beforeNavigate）+ 单测
Day 3: steel.ts tool 注册 + index.ts 装配段（CHANNEL_TO_SPEC/V5_TOOL_TO_CHANNEL/initialCapabilities/longBreakers）+ 集成测
Day 4: doctor steel_endpoint_reachable check + 文档（README steel 配置段）
Day 5: smoke 测试（真机 Steel Docker）+ 零回归验证（1552 TS + 74 INV 全绿）
```

---

## 8. INV-74 + 03 审查预设

### 8.1 INV-74 定义（Steel 专属 grep 守护，仿 INV-72 范式）

**INV-74**（Lasso v1.6 新增）：「SteelChannel（browse_cloud_steel）必经 LASSO_ALLOW_CLOUD_BROWSER + STEEL_ENDPOINT 双重解锁；STEEL ProviderConfig 单独导出不进 BUILTIN_PROVIDERS（保 v1.5 零回归）；SteelChannel extends BrowseChannel（平级兄弟子类，禁嵌套 / 禁自造 fallback）。」

**机械化检查**（`src/invariants/check-invariants.mjs`）：
```javascript
// INV-74: Steel cloud 通道零回归守护
assertFileContains("src/config/providers.ts", "STEEL_PROVIDERS", "INV-74: STEEL_PROVIDERS export 存在");
assertFileContains("src/config/providers.ts", /export\s*\{\s*STEEL\s*\}/, "INV-74: STEEL 单独 export");
assertNotContains("src/config/providers.ts", /BUILTIN_PROVIDERS.*STEEL/s, "INV-74: STEEL 不进 BUILTIN_PROVIDERS");
assertFileContains("src/index.ts", "LASSO_ALLOW_CLOUD_BROWSER", "INV-74: Steel 走 cloud 双重解锁");
assertFileContains("src/index.ts", "STEEL_ENDPOINT", "INV-74: STEEL_ENDPOINT env 解锁条件");
assertFileContains("src/channels/SteelChannel.ts", "extends BrowseChannel", "INV-74: SteelChannel extends BrowseChannel");
assertNotContains("src/channels/SteelChannel.ts", "class FallbackDecider", "INV-74: 禁自造 fallback（INV-18 守）");
```

### 8.2 03 审查预设（本 parse 已预判 §1.1-§1.7 + §2.1-§2.3）

**审查期重点核查项**（review agent 在实施后跑）：

| 03 项 | 核查内容 | 通过标准 |
|---|---|---|
| §1.2 项 1 🔴 producer 契约 | Steel REST response 每个读取字段引 sessions.schema.ts 行号 | L1 证据（源码位置）|
| §1.2 项 2 🔴 字段缺失语义 | sessionId 缺 / status≠"live" 时行为 | 抛 `steel_session_no_id` / warn 但继续 |
| §1.4 项 1 🔴 值级 trace | STEEL_ENDPOINT → POST → {id} → registerSpec → 9223 → Chrome | 每跳具体值 |
| §1.6 项 1 🔴 代码健康 | SteelChannel 是否让代码库更简单 | 平级兄弟子类，R-CI-02 守，零嵌套 |
| §1.6 项 6 🟡 多写者竞态 | 单例 session mutex 是否守住 | 并发单测 sessionProvider 调用次数=1 |
| §2.1 项 3 🔴 测试必须能失败 | mutant 注入后单测 fail | mutation score ≥80% |
| §2.2 项 4 🔴 producer 契约同步 | Steel SessionDetails 字段集钉 fixture | fixture 字段 = sessions.schema.ts |
| §1.7 项 7 🟡 跨边界同步对 | STEEL_ENDPOINT env ↔ deriveCdpEndpoint(9223) ↔ chrome-devtools-mcp --browser-url | grep 配对一致 |

### 8.3 license 兼容性最终确认

Steel **Apache License 2.0**（LICENSE 全文逐字读，zread `api/LICENSE` 确认）。Lasso **MIT**。Apache-2.0 与 MIT **双向兼容**（doc/16 §2.4 Obscura 段已论证）：Lasso 可链接、调用、改写 Steel，Lasso 仍保持 MIT（只需保留 Apache NOTICE）。**无传染风险**。Lasso SteelChannel 是 HTTP 客户端调用 Steel REST API（非代码 link/import Steel 源码），法律上更干净——独立进程、无衍生作品。

---

## 附录：关键源码引用索引（白盒证据）

| 证据 | 文件 | 行号/位置 |
|---|---|---|
| Steel LICENSE Apache-2.0 | `steel-dev/steel-browser/LICENSE` | 全文 |
| Steel REST POST /v1/sessions | `api/src/modules/sessions/sessions.routes.ts` | L67-89 |
| Steel SessionDetails schema | `api/src/modules/sessions/sessions.schema.ts` | L82-110（websocketUrl L93）|
| Steel 单例 session 模型 | `api/src/services/session.service.ts` | L73 `activeSession: Session` |
| Steel CDP nginx 9223→9222 | `nginx.conf` | 全文（listen 9223 → proxy_pass 127.0.0.1:9222）|
| Steel CDP_REDIRECT_PORT | `api/src/env.ts` | L13 `default "9222"` |
| Steel fingerprint-generator | `api/src/services/session.service.ts` | L9 import + L14 fingerprint 参数 |
| Steel Docker 一行启动 | `README.md` | 「Running Locally → Docker」 |
| Lasso BrowserbaseChannel 范式 | `src/channels/BrowserbaseChannel.ts` | L71-93 sessionProvider / L107-268 class / L146-172 getMcpClient / L185-202 browse preflight / L211-221 beforeNavigate |
| Lasso BROWSERBASE ProviderConfig | `src/config/providers.ts` | L224-278（CLOUD_BROWSER_PROVIDERS 范式）|
| Lasso registerBrowserbaseTool | `src/tools/browserbase.ts` | L118-159 |
| Lasso cloud 双重解锁 | `src/index.ts` | L176-200 readCloudBrowserEnv / L469-512 装配段 / L598-600 tool 注册 / L677-707 CHANNEL_TO_SPEC |
| doc/16 Steel 建议 | `doc/16-开源生态白盒审查与借鉴分析.md` | §0 #3 / §3 对比表 Steel 行 / §5 建议 2 / §7.3 v1.6 MVP |
| 03 审查清单 | `架构想法/03_审查测试清单.md` | §1 六维度 / §2 五阶段 / §1.7.7 跨边界同步对 |

---

**parse14 结束**。本计划基于 Steel 真读（zread 7 文件：LICENSE / README / routes.ts / sessions.schema.ts / sessions.controller.ts / sessions.routes.ts / session.service.ts / env.ts / nginx.conf / docker-compose.yml / url.ts / docs）+ Lasso BrowserbaseChannel 全套白盒审查 + doc/16 §5 P1 + 03 §1-§2。每条结论引源码/repo 证据，拒绝猜测。实施后守 v1.5 零回归（1552 TS + 73 INV → 74 INV 全绿），R-CI-02 不破，license Apache-2.0 兼容 MIT。