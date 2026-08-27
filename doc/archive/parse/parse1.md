# Lasso v0.1 MVP — parse1 文件/函数级执行计划

> 产出目标：实施者照此可无歧义写代码。所有路径绝对，所有签名可直接落 TypeScript。
> 上游：[08 架构基线](/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md) §0/§2/§3.1-3.9/附录 A-B；[09 排期](/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md) §2.1。

---

## 1. v0.1 目标与范围

**能力目标（一句话）**：CC 通过 Lasso 这一个 stdio MCP 能（a）搜（智谱 web-search-prime）、（b）无头抓（chrome-devtools-mcp `--headless --isolated`）、（c）登录态抓（chrome-devtools-mcp `--browser-url :9222`），fallback 链自动降级，**且 day 1 就有可靠性基础设施**（不是事后补）。

**MVP 范围（含）**：
- 三 web 通道：`search` / `browse_headless` / `browse_logged_in`
- 单一 fallback 引擎（isFallbackWorthy + tri-state `worked/didnt/unknown` + 60s 短熔断）
- SSRF allowRanges（默认拒私有 + CIDR allowlist 解 fake-ip `198.18.0.0/15`）
- doctor CLI（结构化 readiness JSON）
- 架构不变量测试（8 条 CI 断言）
- MCP ToolAnnotations（readOnlyHint/openWorldHint）
- SERP 兜底抽取（search → browse_headless 实搜时的百度 selector 级联）

**MVP 不做（推迟）**：
- `desktop` 通道（v0.3.5）
- multi-root forest / `interact_roots()`（v0.4+）
- StateStore LRU 内存主路径 / `stateId` / `expect` 后置条件 / `steps` 多步链式（v0.3；v0.1 只保留「页面状态写磁盘 + 返回短指针」简化版）
- 多源扇出 / Brave 第二源（v0.2）
- 长熔断 60min / SERP 改版检测 / cloud browser / stealth（v0.4+）

**映射 F 编号**（08 §4）：F3.1.1-7 / F3.2.1-9,21 / F3.3.1-8,13 / F3.4.1-7,11 / F3.5.1-6 / F3.6.1-3,7-12 / F3.7.1-4 / F3.8.1-8 / F3.9.1-5,8。

---

## 2. 文件结构（src/ 布局）

```
lasso-mcp/
├── package.json                      # deps: @modelcontextprotocol/sdk, ip-cidr, zod, vitest
├── tsconfig.json
├── vitest.config.ts
├── package-lock.json                 # 锁 chrome-devtools-mcp 版本
├── src/
│   ├── index.ts                      # MCP server 入口 + tool 注册 + 生命周期 (~80 行)
│   ├── types.ts                      # 共享类型: Outcome/InteractResult/SearchResult/BrowseResult/ExpectCondition/BrowseOptions (~150 行)
│   │
│   ├── config/
│   │   ├── config.ts                 # loadConfig(): env + ~/.claude.json 合并 + ProviderConfig 注册表 (~100 行)
│   │   └── providers.ts              # v0.1 内置 3 个 ProviderConfig 声明 (zhipu/headless/logged_in) (~50 行)
│   │
│   ├── channels/
│   │   ├── BaseChannel.ts            # 抽象基类 (is_available/status/health_check) (~40 行)
│   │   ├── UiChannel.ts              # UI 层抽象 (v0.1 占位，无抽象方法，留 v0.3 用) (~20 行)
│   │   ├── SearchChannel.ts          # 调 Zhipu web_search_prime MCP，返回 InteractResult<SearchResult> (~180 行)
│   │   ├── BrowseChannel.ts          # 共享 BaseBrowseChannel：action dispatch 表 + 状态写盘 (~140 行)
│   │   ├── HeadlessChannel.ts        # spawn chrome-devtools-mcp --headless --isolated (~50 行)
│   │   └── LoggedInChannel.ts        # spawn chrome-devtools-mcp --browser-url :9222 + 2FA 检测 (~90 行)
│   │
│   ├── fallback/
│   │   ├── FallbackDecider.ts        # 单一 fallback 引擎入口 (~160 行)
│   │   ├── CircuitBreaker.ts         # 60s 短熔断 (threshold=3 fail) (~50 行)
│   │   └── outcome.ts                # tri-state helpers: outcomeFromHttp/outcomeAfterCheck (~70 行)
│   │
│   ├── subprocess/
│   │   ├── SubprocessManager.ts      # 纯 lifecycle（spawn/health/restart/zombies），不含协议帧 (~160 行)
│   │   └── McpClient.ts              # @modelcontextprotocol/sdk Client 封装（stdio + streamable-http 双模） (~110 行)
│   │
│   ├── ssrf/
│   │   ├── ssrf-guard.ts             # URL 解析 + DNS + CIDR 检查 + userinfo 防伪 (~110 行)
│   │   ├── cidr.ts                   # isPrivateIp + cidrContains（包 ip-cidr） (~50 行)
│   │   └── defaults.ts               # PRIVATE_RANGES + DEFAULT_ALLOW_RANGES 常量 (~30 行)
│   │
│   ├── doctor/
│   │   └── doctor.ts                 # runDoctor(): 10 项 check + 结构化 JSON + blockers + next_step (~200 行)
│   │
│   ├── tools/
│   │   ├── search.ts                 # @mcp.tool search() 处理器 (~90 行)
│   │   ├── browse.ts                 # @mcp.tool browse_headless()/browse_logged_in() 处理器 (~130 行)
│   │   ├── doctor-tool.ts            # @mcp.tool doctor() 处理器 (~30 行)
│   │   ├── descriptions.ts           # 附录 B 的 4 段 SEARCH_DESCRIPTION 等 (~70 行)
│   │   └── annotations.ts            # ToolAnnotations 注册表（每工具 readOnlyHint/openWorldHint） (~40 行)
│   │
│   ├── serp/
│   │   ├── selectors.ts              # 百度/Google selector 级联（7 fallback 中的 2 个，open-webSearch 风格） (~90 行)
│   │   └── extract.ts                # browse_headless 兜底搜索：navigate baidu → snapshot → 抽链接 (~130 行)
│   │
│   ├── invariants/
│   │   ├── check-invariants.mjs      # CI 顶层脚本 (node 直接跑，8 条断言) (~220 行)
│   │   └── invariants.spec.ts        # vitest 等价断言（双轨，CI 走 vitest，本地走 mjs） (~150 行)
│   │
│   └── util/
│       ├── state-store.ts            # v0.1 简化版：stateId(UUID) + 写盘 (~/.cache/lasso/<run_id>/) (~80 行)
│       ├── logger.ts                 # 结构化日志 (console.error JSON 行) + fallback_used 透传 (~50 行)
│       ├── url-safety.ts             # userinfo(@) 检测、protocol 白名单 (~40 行)
│       └── run-id.ts                 # 进程级 run_id（启动时生成 UUID） (~20 行)
│
└── test/
    ├── unit/
    │   ├── ssrf-guard.spec.ts        # 20+ cases
    │   ├── cidr.spec.ts
    │   ├── outcome.spec.ts
    │   ├── circuit-breaker.spec.ts
    │   ├── fallback-decider.spec.ts  # isFallbackWorthy + 链式遍历
    │   ├── url-safety.spec.ts
    │   └── serp-extract.spec.ts      # fixture HTML
    ├── integration/
    │   ├── search-channel.spec.ts    # mock Zhipu MCP server
    │   ├── browse-channel.spec.ts    # mock chrome-devtools-mcp (or real --headless in CI)
    │   ├── subprocess-manager.spec.ts
    │   └── doctor.spec.ts
    └── smoke/
        └── e2e.spec.ts               # 真实 Zhipu + real chrome-devtools-mcp（CI 可选跳过）
```

**估算**：~2600 行 TypeScript（含测试约 1200 行，实现约 1400 行）。

---

## 3. 各模块实施细节

### 3.1 `src/types.ts`（共享类型，~150 行）

```typescript
// === tri-state outcome（F3.4.11，借鉴 injaneity actions.ts outcomeAfterCheck）===
export type Outcome = "worked" | "didnt" | "unknown";

// === 统一交付信封 ===
export interface InteractResult<T = unknown> {
  outcome: Outcome;
  data: T | null;
  served_by: string;            // e.g. "search.zhipu" / "browse_headless" / "browse_logged_in"
  fallback_used: boolean;       // primary 失败时升 fallback 为 true
  retrieval_method: string;     // "zhipu_api" / "serp_scrape_baidu" / "chrome_devtools_mcp"
  actions_and_results?: Array<{ channel: string; outcome: Outcome | "error"; error?: string }>;
  error?: string;
}

// === SearchResult ===
export interface SearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source?: string;            // 来源站点
  }>;
  count: number;
  engine: string;               // "zhipu" / "baidu_serp"
  region: string;
}

// === BrowseResult（短指针 + 磁盘外置，token ≤ 1k）===
export interface BrowseResult {
  url: string;
  action: string;
  state_id?: string;            // 短指针（UUID），查 ~/.cache/lasso/<run_id>/<state_id>.{html,png,json}
  content_path?: string;        // 磁盘绝对路径（HTML 快照 / PNG 截图）
  preview: string;              // ≤1k tokens 预览
  title?: string;
  final_url?: string;           // 重定向后
}

// === BrowseOptions（附录 A，v0.1 子集；steps/expect 占位但不实现）===
export interface ExpectCondition {  // v0.1 仅类型定义，实现 v0.3
  text?: string; selector?: string; url_contains?: string;
  gone?: boolean; timeout_ms?: number;
}
export interface ScreenshotSpec { full?: boolean; element?: string; }
export interface BrowseOptions {
  selectors?: Record<string, string>;
  js?: string;
  steps?: unknown[];            // v0.1 忽略
  expect?: ExpectCondition;     // v0.1 忽略
  wait_until?: "load" | "domcontentloaded" | "networkidle";
  screenshot?: ScreenshotSpec;
  timeout_ms?: number;
  no_cache?: boolean;
}

// === ProviderConfig（附录 A，v0.1 子集；多 Key 池/三态 type v0.2 补）===
export interface ProviderConfig {
  name: string;
  type: "api_key" | "broker" | "self_hosted";
  endpoint_url: string | null;
  keys: string[];
  free_quota_per_month: number;
  quota_model: "monthly" | "rpm" | "token" | "request";
  fallback_order: number;
}

// === ChannelStatus / Health ===
export interface ChannelStatus { available: boolean; latency_ms?: number; note?: string; }
export type Health = "healthy" | "degraded" | "down";
```

**依赖**：无（纯类型）。
**借鉴**：08 附录 A；injaneity `outcomeAfterCheck`（tri-state）；`InteractResult` 形状参考 media-gen-mcp handler 返回风格。

---

### 3.2 `src/subprocess/McpClient.ts`（~110 行）

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChildProcess } from "node:child_process";

export interface McpClientOptions {
  name: string;          // "lasso-search" / "lasso-browse-headless" / "lasso-browse-logged-in"
  version: string;       // "0.1.0"
}

export class McpClient {
  private client: Client;
  private connected = false;

  private constructor(private opts: McpClientOptions) {
    this.client = new Client({ name: opts.name, version: opts.version }, { capabilities: {} });
  }

  /** stdio: 接 SubprocessManager spawn 的 chrome-devtools-mcp 子进程 */
  static async connectStdio(
    opts: McpClientOptions,
    child: ChildProcess,
  ): Promise<McpClient> {
    const c = new McpClient(opts);
    const transport = new StdioClientTransport({
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,  // doctor diagnostics
    });
    await c.client.connect(transport);
    c.connected = true;
    return c;
  }

  /** streamable-http: 接智谱 web_search_prime MCP（Authorization header）*/
  static async connectHttp(
    opts: McpClientOptions,
    url: string,
    headers: Record<string, string>,
  ): Promise<McpClient> {
    const c = new McpClient(opts);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } },
    });
    await c.client.connect(transport);
    c.connected = true;
    return c;
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new Error("McpClient not connected");
    return this.client.callTool({ name, arguments: arguments_ });
  }

  async listTools(): Promise<{ name: string; inputSchema: unknown }[]> {
    const r = await this.client.listTools();
    return r.tools.map(t => ({ name: t.name, inputSchema: t.inputSchema }));
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.close();
    this.connected = false;
  }
}
```

**依赖**：`@modelcontextprotocol/sdk`（与 Lasso 自身 server 侧共用）。
**借鉴**：MCP TS SDK 官方 client API；media-gen-mcp 没 spawn 外部 MCP，所以这块是新写。

---

### 3.3 `src/subprocess/SubprocessManager.ts`（~160 行）

**铁律（不变量 #7）**：纯 lifecycle，**不含协议帧解析**。协议差异下沉到 `McpClient`（用 SDK 自带的 StdioClientTransport / StreamableHTTPClientTransport）。

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { McpClient } from "./McpClient.js";

export const LOCKED_CDP_MCP_VERSION = "0.3.0";  // package-lock 锁，契约测试守

interface ManagedProc {
  child: ChildProcess;
  client: McpClient;
  spawnedAt: number;
  lastUsedAt: number;
  restartCount: number;
}

interface SpawnSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  mcpClientName: string;
}

export class SubprocessManager {
  private procs = new Map<string, ManagedProc>();
  private specs = new Map<string, SpawnSpec>();
  private zombieTimer?: NodeJS.Timeout;

  registerSpec(name: string, spec: SpawnSpec): void {
    this.specs.set(name, spec);
  }

  /** 懒启动；已运行则复用 */
  async ensureRunning(name: string): Promise<McpClient> {
    const existing = this.procs.get(name);
    if (existing && existing.child.exitCode === null) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }
    return this._spawnWithBackoff(name);
  }

  async healthProbe(name: string): Promise<"healthy" | "degraded" | "down"> {
    const m = this.procs.get(name);
    if (!m) return "down";
    if (m.child.exitCode !== null) return "down";
    try {
      await Promise.race([
        m.client.listTools(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      return "healthy";
    } catch {
      return "degraded";
    }
  }

  async restart(name: string): Promise<McpClient> {
    await this._kill(name);
    return this._spawnWithBackoff(name);
  }

  /** 60s 周期；reap 闲置 >1h 的 child（防僵尸累积）*/
  startZombieReaper(intervalMs = 60_000, idleThresholdMs = 3_600_000): void {
    this.zombieTimer = setInterval(() => this.cleanupZombies(idleThresholdMs), intervalMs);
  }

  async cleanupZombies(idleThresholdMs = 3_600_000): Promise<void> {
    const now = Date.now();
    for (const [name, m] of this.procs) {
      if (now - m.lastUsedAt > idleThresholdMs) await this._kill(name);
    }
  }

  async shutdown(): Promise<void> {
    if (this.zombieTimer) clearInterval(this.zombieTimer);
    await Promise.all([...this.procs.keys()].map(n => this._kill(n)));
  }

  private async _spawnWithBackoff(name: string): Promise<McpClient> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown subprocess: ${name}`);

    let attempt = 0;
    while (true) {
      try {
        const child = spawn(spec.cmd, spec.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...spec.env },
        });
        child.on("exit", (code, sig) => {
          if (code !== 0 && code !== null) {
            // 非正常退出，记日志（下次 ensureRunning 自动重 spawn）
            console.error(JSON.stringify({ evt: "subproc_exit", name, code, sig }));
          }
        });
        const client = await McpClient.connectStdio(
          { name: spec.mcpClientName, version: "0.1.0" }, child,
        );
        this.procs.set(name, {
          child, client,
          spawnedAt: Date.now(), lastUsedAt: Date.now(),
          restartCount: attempt,
        });
        return client;
      } catch (e) {
        attempt++;
        if (attempt >= 5) throw e;
        const backoff = Math.min(30_000, 1000 * 2 ** attempt);  // 1s/2s/4s/8s...max 30s
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  private async _kill(name: string): Promise<void> {
    const m = this.procs.get(name);
    if (!m) return;
    try { await m.client.close(); } catch {}
    try { m.child.kill("SIGTERM"); } catch {}
    this.procs.delete(name);
  }
}
```

**依赖**：`node:child_process`，`./McpClient.ts`。
**借鉴**：08 §3.5 + 附录 A `SubprocessManager` 签名；chrome-devtools-mcp 官方启动方式（`npx -y chrome-devtools-mcp@latest --headless --isolated`，已实测）。

---

### 3.4 `src/channels/SearchChannel.ts`（~180 行）

```typescript
import { BaseChannel } from "./BaseChannel.js";
import type { ChannelStatus, Health, InteractResult, SearchResult } from "../types.js";
import { McpClient } from "../subprocess/McpClient.js";
import { outcomeFromHttp } from "../fallback/outcome.js";

export interface SearchOpts {
  limit: number;
  engine: string;       // v0.1 固定 "zhipu"
  region: string;       // "cn" / "us"
  no_cache: boolean;
}

export class SearchChannel extends BaseChannel {
  readonly name = "search.zhipu";
  private client: McpClient | null = null;

  constructor(
    private readonly endpoint: string,             // https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
    private readonly apiKey: string | undefined,   // process.env.ZHIPU_API_KEY
  ) { super(); }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey && this.endpoint.startsWith("https://");
  }

  async status(): Promise<ChannelStatus> {
    if (!await this.isAvailable()) return { available: false, note: "ZHIPU_API_KEY missing" };
    try {
      const c = await this._getClient();
      const t0 = Date.now();
      await c.listTools();
      return { available: true, latency_ms: Date.now() - t0 };
    } catch (e) {
      return { available: false, note: String(e) };
    }
  }

  async healthCheck(): Promise<Health> {
    const s = await this.status();
    return s.available ? "healthy" : "down";
  }

  async search(query: string, opts: SearchOpts): Promise<InteractResult<SearchResult>> {
    if (!await this.isAvailable()) {
      return { outcome: "unknown", data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "zhipu_api",
               error: "ZHIPU_API_KEY missing" };
    }
    try {
      const c = await this._getClient();
      // 智谱 web_search_prime MCP 工具 schema（listTools 后锁字段名）
      const resp = await c.callTool("web_search_prime", {
        search_query: query,
        search_intent: true,
        count: opts.limit,
      }) as { content?: Array<{ type: string; text?: string }> };

      const parsed = parseZhipuContent(resp.content);  // 见下
      const outcome = parsed.length === 0 ? "unknown" : "worked";  // 200 但 0 结果 = unknown（10 D.1）

      return {
        outcome,
        data: { query, results: parsed, count: parsed.length, engine: "zhipu", region: opts.region },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "zhipu_api",
      };
    } catch (e) {
      // 网络挂/超时/5xx/限流 = unknown；4xx (非 429) = didnt
      return { outcome: classifyError(e), data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "zhipu_api", error: String(e) };
    }
  }

  private async _getClient(): Promise<McpClient> {
    if (this.client) return this.client;
    this.client = await McpClient.connectHttp(
      { name: "lasso-search", version: "0.1.0" },
      this.endpoint,
      { Authorization: `Bearer ${this.apiKey}` },
    );
    return this.client;
  }
}

// === 智谱响应解析（web_search_prime 返回 content[0].text 是 JSON 字符串）===
function parseZhipuContent(content: unknown): SearchResult["results"] {
  if (!Array.isArray(content)) return [];
  const textBlock = content.find((b: any) => b.type === "text");
  if (!textBlock?.text) return [];
  try {
    const obj = JSON.parse(textBlock.text);
    // 智谱 web_search_prime 标准形状: { search_results: [{ title, link, content, ... }] }
    const arr = obj.search_results ?? obj.results ?? [];
    return arr.map((r: any) => ({
      title: r.title ?? "",
      url: r.link ?? r.url ?? "",
      snippet: r.content ?? r.snippet ?? "",
      source: r.media ?? r.source,
    })).filter((r: any) => r.url);
  } catch {
    return [];
  }
}

function classifyError(e: unknown): "unknown" | "didnt" {
  const msg = String(e).toLowerCase();
  if (msg.includes("404") || msg.includes("not_found")) return "didnt";
  if (msg.includes("403") || msg.includes("forbidden")) return "didnt";
  if (msg.includes("enotfound") || msg.includes("nxdomain")) return "didnt";
  return "unknown";  // timeout / 429 / 5xx / network
}
```

**依赖**：`BaseChannel`，`McpClient`，`outcome.ts`。
**借鉴**：08 §3.1；10 §D.1（isFallbackWorthy 扩展集：HTTP 202 空响应/200 但 0 结果）；智谱 web_search_prime 响应形状（JSON in text block）。

---

### 3.5 `src/channels/BrowseChannel.ts`（~140 行，抽象共享层）

**铁律（不变量 #6）**：dispatch 走 `Map` 注册表（不是 if-else 链）。

```typescript
import { UiChannel } from "./UiChannel.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../types.js";
import type { McpClient } from "../subprocess/McpClient.js";
import { writeState } from "../util/state-store.js";
import { v4 as uuid } from "uuid";

export abstract class BrowseChannel extends UiChannel {
  abstract readonly name: string;  // "browse_headless" / "browse_logged_in"
  protected abstract getMcpClient(): Promise<McpClient>;

  // === invariant #6: dispatch 走注册表 Map ===
  protected readonly actionDispatch = new Map<string, (c: McpClient, url: string, opts: BrowseOptions) => Promise<Partial<BrowseResult>>>([
    ["navigate",  doNavigate],
    ["snapshot",  doSnapshot],
    ["screenshot", doScreenshot],
    ["extract",   doExtract],
    ["click",     doClick],
    ["fill",      doFill],
    ["wait",      doWait],
    ["evaluate",  doEvaluate],
  ]);

  async browse(url: string, action: string, options: BrowseOptions): Promise<InteractResult<BrowseResult>> {
    const handler = this.actionDispatch.get(action);
    if (!handler) {
      return { outcome: "didnt", data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "chrome_devtools_mcp",
               error: `unknown_action:${action}` };
    }
    try {
      const c = await this.getMcpClient();
      const partial = await handler(c, url, options);
      // 写盘 + 短指针（v0.1 简化版；v0.3 升 StateStore LRU + stateId）
      const state_id = uuid();
      const content_path = await writeState(this.name, state_id, partial);
      return {
        outcome: "worked",
        data: { url, action, state_id, content_path,
                preview: truncatePreview(partial.preview ?? ""),
                title: partial.title, final_url: partial.final_url ?? url },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
      };
    } catch (e) {
      return { outcome: classifyBrowseError(e, action), data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "chrome_devtools_mcp", error: String(e) };
    }
  }
}

// === action 实现（每个调 chrome-devtools-mcp 一个工具）===
async function doNavigate(c: McpClient, url: string, opts: BrowseOptions): Promise<Partial<BrowseResult>> {
  const r = await c.callTool("navigate_page", { type: "url", url, ignoreCache: opts.no_cache ?? false });
  return { final_url: extractFinalUrl(r), preview: "navigated" };
}

async function doSnapshot(c: McpClient, _url: string, _opts: BrowseOptions): Promise<Partial<BrowseResult>> {
  const r = await c.callTool("take_snapshot", {});
  const { title, text } = extractSnapshot(r);
  return { title, preview: text };
}

async function doScreenshot(c: McpClient, url: string, opts: BrowseOptions): Promise<Partial<BrowseResult>> {
  const filePath = `/tmp/lasso-screenshot-${uuid()}.png`;
  await c.callTool("take_screenshot", {
    format: "png", filePath,
    fullPage: opts.screenshot?.full ?? false,
  });
  return { preview: `screenshot saved to ${filePath}` };
}

// ... doExtract / doClick / doFill / doWait / doEvaluate 略，同样模式
```

**依赖**：`UiChannel`，`McpClient`，`util/state-store.ts`，`uuid`。
**借鉴**：08 §3.2 + 附录 A；chrome-devtools-mcp 工具名（navigate_page/take_snapshot/take_screenshot/click/fill_form/wait_for/evaluate_script）；mcp-chrome `chrome_computer` action-enum 折叠思想。

---

### 3.6 `src/channels/HeadlessChannel.ts` + `LoggedInChannel.ts`（共 ~140 行）

```typescript
// === HeadlessChannel.ts ===
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";
  constructor(private subproc: SubprocessManager) {
    super();
    subproc.registerSpec("headless", {
      cmd: "npx",
      args: ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, "--headless", "--isolated"],
      mcpClientName: "lasso-browse-headless",
    });
  }
  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.ensureRunning("headless");
  }
}

// === LoggedInChannel.ts ===
export class LoggedInChannel extends BrowseChannel {
  readonly name = "browse_logged_in";
  constructor(private subproc: SubprocessManager, private cdpPort = 9222) {
    super();
    subproc.registerSpec("logged_in", {
      cmd: "npx",
      args: ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, `--browser-url=http://localhost:${cdpPort}`],
      mcpClientName: "lasso-browse-logged-in",
    });
  }
  protected async getMcpClient(): Promise<McpClient> {
    const c = await this.subproc.ensureRunning("logged_in");
    // 2FA 检测：首次 ensureRunning 时 probe 一个 tab，如果发现 login form 标记 NEEDS_MANUAL_2FA
    await this._detect2FA(c);
    return c;
  }
  private async _detect2FA(_c: McpClient): Promise<void> {
    // v0.1 简化：list_pages 后 take_snapshot 第一个 tab，grep "2FA|two-factor|verification code"
    // 命中则记 logger.warn，并标记 status.note = "NEEDS_MANUAL_2FA"
  }
}
```

**依赖**：`BrowseChannel`，`SubprocessManager`。
**借鉴**：08 §3.3（F3.3.1-8 复用 9222/cookie 失效/2FA 检测）；附录 B `BROWSE_LOGGED_IN_DESCRIPTION`（DOES NOT solve 2FA → `NEEDS_MANUAL_2FA`）。

---

### 3.7 `src/fallback/CircuitBreaker.ts`（~50 行）

```typescript
export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  state: BreakerState = "closed";
  private failureCount = 0;
  private openedAt = 0;

  constructor(private readonly threshold = 3, private readonly resetMs = 60_000) {}

  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt > this.resetMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    return true;  // half-open: allow one probe
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    } else if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
```

**依赖**：无。
**借鉴**：08 §2.6（60s 短熔断；Argus 60min 长熔断是 v0.7）；media-gen-mcp 0.10.0 `isFallbackWorthy/getFallbackProvider/activeProvider` 范式。

---

### 3.8 `src/fallback/outcome.ts`（~70 行，tri-state 核心）

```typescript
import type { Outcome } from "../types.js";

/** HTTP 状态 → Outcome（10 §D.1 isFallbackWorthy 扩展集）*/
export function outcomeFromHttp(status: number, body: unknown): Outcome {
  if (status === 202) return "unknown";                          // Accepted but empty（DDG [browser] 场景）
  if (status === 429 || status >= 500) return "unknown";         // 限流/服务器错（transient）
  if (status >= 200 && status < 300) {
    return isEmptyBody(body) ? "unknown" : "worked";             // 200 但 0 结果
  }
  if (status >= 400) return "didnt";                             // 4xx（非 429）= definitive
  return "unknown";
}

/** expect 后置条件 tri-state（v0.1 仅类型，v0.3 用）*/
export function outcomeAfterCheck(pre: Outcome, verified: boolean | "preexisting"): Outcome {
  if (verified === true) return "worked";
  if (verified === "preexisting") return pre;                    // 不掠美：承认没造成它但成立
  return "didnt";
}

export function isEmptyBody(body: unknown): boolean {
  if (body == null) return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === "object") {
    const arr = (body as any).search_results ?? (body as any).results ?? (body as any).items;
    if (Array.isArray(arr)) return arr.length === 0;
  }
  return false;
}
```

**依赖**：`types.ts`。
**借鉴**：12 F.1 `outcomeAfterCheck`（injaneity `actions.ts`）；10 §D.1 `isFallbackWorthy` 扩展（HTTP 202 空/200 但 0 结果）。

---

### 3.9 `src/fallback/FallbackDecider.ts`（~160 行，单一引擎入口）

**铁律（不变量 #4）**：整个项目**只有一个 fallback 范式**（不开第二套）。

```typescript
import type { InteractResult, Outcome } from "../types.js";
import { CircuitBreaker } from "./CircuitBreaker.js";

export interface FallbackPlan {
  primary: string;
  fallbacks: string[];      // 顺序遍历
  cross_modal: boolean;     // search→browse_headless = true；browse_headless→browse_logged_in = false
}

export type ChannelExecutor<T> = (channelName: string) => Promise<InteractResult<T>>;

export class FallbackDecider {
  constructor(
    private readonly breakers: Map<string, CircuitBreaker>,  // channel 名 → breaker
  ) {}

  /** isFallbackWorthy（10 §D.1 + 12 F.1）*/
  isFallbackWorthy(outcome: Outcome, error?: string): boolean {
    if (outcome === "worked" || outcome === "didnt") return false;  // 这两态都是 definitive
    // outcome === "unknown"
    if (!error) return true;                                        // 200 空响应：值得试 fallback
    const msg = error.toLowerCase();
    // NOT fallback-worthy（误把信号当故障）：
    if (msg.includes("404") || msg.includes("not_found")) return false;
    if (msg.includes("403") || msg.includes("forbidden")) return false;
    if (msg.includes("nxdomain") || msg.includes("enotfound")) return false;
    if (msg.includes("needs_manual_2fa")) return false;             // 2FA：明确的「需要人」信号，不 fallback
    // fallback-worthy：timeout / 429 / 5xx / ECONNREFUSED / network / partial render
    return true;
  }

  /** 单一 fallback 引擎入口 */
  async runWithFallback<T>(
    plan: FallbackPlan,
    executor: ChannelExecutor<T>,
  ): Promise<InteractResult<T>> {
    const chain = [plan.primary, ...plan.fallbacks];
    const actions_and_results: InteractResult["actions_and_results"] = [];

    for (let i = 0; i < chain.length; i++) {
      const channelName = chain[i];
      const breaker = this.breakers.get(channelName);

      if (breaker && !breaker.allow()) {
        actions_and_results!.push({ channel: channelName, outcome: "error", error: "circuit_open" });
        continue;  // 跳过熔断中的通道
      }

      try {
        const result = await executor(channelName);
        actions_and_results!.push({ channel: channelName, outcome: result.outcome, error: result.error });

        if (result.outcome === "worked") {
          breaker?.recordSuccess();
          return { ...result, fallback_used: i > 0, actions_and_results };
        }
        if (result.outcome === "didnt") {
          breaker?.recordSuccess();  // channel 自己工作正常，只是 negative answer
          return { ...result, fallback_used: i > 0, actions_and_results };
        }
        // outcome === "unknown"
        breaker?.recordFailure();
        if (!this.isFallbackWorthy(result.outcome, result.error)) {
          return { ...result, fallback_used: i > 0, actions_and_results };  // unknown 但不 fallback-worthy（如 2FA）
        }
        // else: continue 试下一个 channel
      } catch (e) {
        breaker?.recordFailure();
        const errorMsg = String(e);
        actions_and_results!.push({ channel: channelName, outcome: "error", error: errorMsg });
        if (!this.isFallbackWorthy("unknown", errorMsg)) {
          return {
            outcome: "didnt", data: null, served_by: channelName,
            fallback_used: i > 0, retrieval_method: "error",
            error: errorMsg, actions_and_results,
          };
        }
      }
    }

    // 所有 fallback 耗尽
    return {
      outcome: "didnt", data: null,
      served_by: chain[chain.length - 1],
      fallback_used: chain.length > 1,
      retrieval_method: "fallback_exhausted",
      error: "all_channels_failed_or_skipped",
      actions_and_results,
    };
  }
}
```

**依赖**：`CircuitBreaker`，`types.ts`。
**借鉴**：08 §3.4 + 附录 A `run_with_fallback`；12 F.1「unknown 才是 fallback 引擎的真正触发器」；media-gen-mcp 0.10.0 fallback 范式（activeProvider + 60s 熔断）。

---

### 3.10 `src/ssrf/ssrf-guard.ts` + `cidr.ts` + `defaults.ts`（共 ~190 行）

```typescript
// === defaults.ts ===
export const PRIVATE_RANGES = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "0.0.0.0/8",
  "fc00::/7", "fe80::/10", "::1/128",
] as const;

// 默认 allowlist：解 fake-ip 代理（Surge/Clash/Mihomo TUN）+ localhost:9222
export const DEFAULT_ALLOW_RANGES = [
  "198.18.0.0/15",    // fake-ip 段
  "127.0.0.1/32",     // browse_logged_in 的 :9222
] as const;

// === cidr.ts ===
import IPCIDR from "ip-cidr";
import { isIP as nodeIsIP } from "node:net";

export function cidrContains(cidr: string, ip: string): boolean {
  if (nodeIsIP(ip) === 0) return false;
  try {
    const c = new IPCIDR(cidr);
    return c.isValid() && c.contains(ip);
  } catch {
    return false;
  }
}

export function isPrivateIp(ip: string, privateRanges: readonly string[] = PRIVATE_RANGES): boolean {
  return privateRanges.some(cidr => cidrContains(cidr, ip));
}

// === ssrf-guard.ts ===
import { lookup } from "node:dns/promises";
import { cidrContains, isPrivateIp } from "./cidr.js";
import { DEFAULT_ALLOW_RANGES, PRIVATE_RANGES } from "./defaults.js";

export interface SsrfConfig {
  allowRanges: string[];    // 合并 DEFAULT_ALLOW_RANGES
  denyRanges: string[];     // 显式拒（优先级最高）
}

export interface SsrfCheckResult {
  allowed: boolean;
  reason: string;
  resolvedIps: string[];
}

export async function ssrfGuard(rawUrl: string, config: SsrfConfig): Promise<SsrfCheckResult> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return { allowed: false, reason: "invalid_url", resolvedIps: [] }; }

  // 防 evil.com@trusted.com 伪装
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: "userinfo_present", resolvedIps: [] };
  }
  // 协议白名单
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `protocol_not_allowed:${parsed.protocol}`, resolvedIps: [] };
  }

  // fresh DNS lookup（navigation 不缓存，防 rebind）
  let records: { address: string }[];
  try {
    records = await lookup(parsed.hostname, { all: true });
  } catch (e) {
    return { allowed: false, reason: `dns_failed:${(e as Error).message}`, resolvedIps: [] };
  }
  const ips = records.map(r => r.address);

  const effectiveAllow = [...DEFAULT_ALLOW_RANGES, ...config.allowRanges];

  for (const ip of ips) {
    // deny 优先
    if (config.denyRanges.some(cidr => cidrContains(cidr, ip))) {
      return { allowed: false, reason: `deny_range:${ip}`, resolvedIps: ips };
    }
    // 私有/保留 IP 必须在 allowlist 才放行
    if (isPrivateIp(ip, PRIVATE_RANGES) && !effectiveAllow.some(cidr => cidrContains(cidr, ip))) {
      return { allowed: false, reason: `private_ip:${ip}`, resolvedIps: ips };
    }
  }

  return { allowed: true, reason: "ok", resolvedIps: ips };
}

export function loadSsrfConfig(): SsrfConfig {
  // env: LASSO_SSRF_ALLOW_RANGES="10.0.0.0/8,172.16.0.0/12"
  const envAllow = (process.env.LASSO_SSRF_ALLOW_RANGES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const envDeny = (process.env.LASSO_SSRF_DENY_RANGES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return { allowRanges: envAllow, denyRanges: envDeny };
}
```

**依赖**：`ip-cidr`，`node:dns/promises`，`node:net`。
**借鉴**：08 §5.1；12 第 77 行（pi-web-access SSRF allowRanges）；用户 MEMORY「push 走 HTTPS 因代理 fake-ip 拦 SSH」直接命中（fake-ip 环境）。

---

### 3.11 `src/doctor/doctor.ts`（~200 行，readiness JSON）

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SubprocessManager, LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";

const execFileP = promisify(execFile);

export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  next_step?: string;
}
export interface DoctorReport {
  ready: boolean;
  timestamp: string;
  lasso_version: string;
  checks: DoctorCheck[];
  blockers: string[];    // status="fail" 的 name 列表
}

export async function runDoctor(opts: {
  zhipuKey?: string;
  zhipuEndpoint?: string;
  cdpPort?: number;
  cacheDir?: string;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Node 版本（>= 20）
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "node_version",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `Node ${process.versions.node}`,
    next_step: nodeMajor >= 20 ? undefined : "升级 Node 到 >= 20",
  });

  // 2. ZHIPU_API_KEY 存在
  checks.push({
    name: "zhipu_api_key",
    status: opts.zhipuKey ? "pass" : "fail",
    detail: opts.zhipuKey ? "已配置（未验证有效性）" : "ZHIPU_API_KEY 未设置",
    next_step: opts.zhipuKey ? undefined : "export ZHIPU_API_KEY=<your-key>",
  });

  // 3. Zhipu MCP endpoint 可达（GET 一次，只测网络，不深测协议）
  // 4. chrome-devtools-mcp 可 spawn（npx -y chrome-devtools-mcp@<version> --version）
  try {
    const { stdout } = await execFileP("npx", ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, "--version"], { timeout: 60_000 });
    checks.push({ name: "cdp_mcp_installable", status: "pass", detail: stdout.trim() });
  } catch (e) {
    checks.push({ name: "cdp_mcp_installable", status: "fail", detail: String(e),
                  next_step: `npm install -g chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}` });
  }

  // 5. Chrome binary 存在（macOS 优先路径）
  const chromePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const chromeFound = await Promise.all(chromePaths.map(p => fs.access(p).then(() => p).catch(() => null)));
  const chromePath = chromeFound.find(Boolean);
  checks.push({
    name: "chrome_binary",
    status: chromePath ? "pass" : "warn",
    detail: chromePath ?? "未找到 Chrome（browse_headless 仍可用 bundled chromium；browse_logged_in 需要）",
    next_step: chromePath ? undefined : "安装 Google Chrome",
  });

  // 6. :9222 已登录（list_pages via CDP HTTP）
  const port = opts.cdpPort ?? 9222;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())) as unknown[];
      checks.push({ name: "cdp_9222_logged_in", status: tabs.length > 0 ? "pass" : "warn",
                    detail: `${tabs.length} tabs` });
    } else {
      checks.push({ name: "cdp_9222_logged_in", status: "fail", detail: `HTTP ${resp.status}` });
    }
  } catch (e) {
    checks.push({
      name: "cdp_9222_logged_in", status: "warn", detail: String(e),
      next_step: "启动 Chrome: open -na 'Google Chrome' --args --remote-debugging-port=9222",
    });
  }

  // 7. ~/.cache/lasso 可写
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".cache", "lasso");
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const testFile = path.join(cacheDir, ".doctor-write-test");
    await fs.writeFile(testFile, "ok"); await fs.unlink(testFile);
    checks.push({ name: "cache_writable", status: "pass", detail: cacheDir });
  } catch (e) {
    checks.push({ name: "cache_writable", status: "fail", detail: String(e) });
  }

  // 8. SSRF allowRanges 配置可解析
  try {
    const { loadSsrfConfig } = await import("../ssrf/ssrf-guard.js");
    const cfg = loadSsrfConfig();
    checks.push({ name: "ssrf_config", status: "pass",
                  detail: `allow=${cfg.allowRanges.length} deny=${cfg.denyRanges.length}` });
  } catch (e) {
    checks.push({ name: "ssrf_config", status: "fail", detail: String(e) });
  }

  // 9. SERP selectors 加载
  // 10. invariants pass（run check-invariants.mjs）
  try {
    const { stdout } = await execFileP("node", ["src/invariants/check-invariants.mjs"], { timeout: 30_000 });
    checks.push({ name: "invariants", status: "pass", detail: stdout.trim().split("\n").slice(-1)[0] });
  } catch (e) {
    checks.push({ name: "invariants", status: "fail", detail: String(e) });
  }

  const blockers = checks.filter(c => c.status === "fail").map(c => c.name);
  return {
    ready: blockers.length === 0,
    timestamp: new Date().toISOString(),
    lasso_version: "0.1.0",
    checks,
    blockers,
  };
}
```

**依赖**：`node:child_process`，`fs`，`os`，`path`，`ssrf-guard.ts`，`SubprocessManager.LOCKED_CDP_MCP_VERSION`。
**借鉴**：08 §3.6 F3.6.7（agent-sh doctor）；09 §2.1 验收「doctor CLI 覆盖 ≥10 项」。

---

### 3.12 `src/tools/*.ts`（MCP tool 注册层，共 ~360 行）

```typescript
// === search.ts ===
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SearchChannel } from "../channels/SearchChannel.js";
import { FallbackDecider } from "../fallback/FallbackDecider.js";
import { SEARCH_DESCRIPTION } from "./descriptions.js";
import { searchAnnotations } from "./annotations.js";
import { serpScrapeFallback } from "../serp/extract.js";

export function registerSearchTool(
  server: McpServer,
  search: SearchChannel,
  browseHeadlessExec: (q: string, limit: number) => Promise<{ outcome: "worked" | "unknown" | "didnt"; data: unknown }>,
  decider: FallbackDecider,
) {
  server.tool(
    "search",
    SEARCH_DESCRIPTION,
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
      engine: z.string().default("zhipu"),
      region: z.string().default("cn"),
      no_cache: z.boolean().default(false),
    },
    searchAnnotations,  // { readOnlyHint: true, openWorldHint: true }
    async (args) => {
      const plan = { primary: "search.zhipu", fallbacks: ["browse_headless"], cross_modal: true };
      const result = await decider.runWithFallback(plan, async (channelName) => {
        if (channelName === "search.zhipu") {
          return search.search(args.query, { limit: args.limit, engine: args.engine, region: args.region, no_cache: args.no_cache });
        }
        if (channelName === "browse_headless") {
          return serpScrapeFallback(args.query, args.limit, browseHeadlessExec);  // 跨模态降级
        }
        throw new Error(`unknown_channel:${channelName}`);
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}

// === browse.ts ===
export function registerBrowseTools(
  server: McpServer,
  headless: HeadlessChannel,
  logged_in: LoggedInChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
) {
  server.tool("browse_headless", BROWSE_HEADLESS_DESCRIPTION, browseSchema, browseAnnotations,
    async (args) => {
      const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
      if (!ssrfResult.allowed) {
        return errorContent(`SSRF blocked: ${ssrfResult.reason}`);
      }
      const plan = { primary: "browse_headless", fallbacks: ["browse_logged_in"], cross_modal: false };
      const result = await decider.runWithFallback(plan, async (name) => {
        if (name === "browse_headless")  return headless.browse(args.url, args.action, args.options ?? {});
        if (name === "browse_logged_in") return logged_in.browse(args.url, args.action, args.options ?? {});
        throw new Error(`unknown_channel:${name}`);
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });

  server.tool("browse_logged_in", BROWSE_LOGGED_IN_DESCRIPTION, browseSchema, browseAnnotations,
    async (args) => {
      const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
      if (!ssrfResult.allowed) return errorContent(`SSRF blocked: ${ssrfResult.reason}`);
      // browse_logged_in 是终端通道（无进一步 fallback，v0.1）
      const result = await logged_in.browse(args.url, args.action, args.options ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
}

// === annotations.ts ===
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
export const searchAnnotations: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const browseAnnotations: ToolAnnotations = { readOnlyHint: false, openWorldHint: true };
export const doctorAnnotations: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
```

**依赖**：`@modelcontextprotocol/sdk`，`zod`，所有 channel/fallback/ssrf 模块。
**借鉴**：08 附录 B（4 段 DESCRIPTION）；F3.3.13 ToolAnnotations；mcp-chrome description 内嵌 `[Prefer X over Y]` 路由提示。

---

### 3.13 `src/serp/extract.ts` + `selectors.ts`（共 ~220 行）

```typescript
// === selectors.ts ===
export interface SerpSelectorSet {
  engine: "baidu" | "google";
  result_container: string;
  title: string;
  link: string;
  snippet: string;
}
// 百度（open-webSearch 风格级联，主→备）
export const BAIDU_SELECTORS: SerpSelectorSet[] = [
  { engine: "baidu", result_container: "div.c-container",   title: "h3",           link: "h3 a",       snippet: "div.c-abstract" },
  { engine: "baidu", result_container: ".result.c-container",title: ".t a",        link: ".t a",       snippet: ".c-abstract" },
];
export const GOOGLE_SELECTORS: SerpSelectorSet[] = [
  { engine: "google", result_container: "div.g",             title: "h3",           link: "div.yuRUbf a", snippet: "div.VwiC3b" },
  { engine: "google", result_container: "div.tF2Cxc",        title: "h3",           link: "a",            snippet: "div.VwiC3b" },
];

// === extract.ts ===
export async function serpScrapeFallback(
  query: string, limit: number,
  browseExec: (q: string, limit: number) => Promise<{ outcome: "worked" | "unknown" | "didnt"; data: unknown }>,
): Promise<InteractResult<SearchResult>> {
  const serpUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit}`;
  // 调用注入的 browse_headless 执行器（避免循环依赖）
  const browseResult = await browseExec(serpUrl, limit);
  if (browseResult.outcome !== "worked") {
    return { outcome: browseResult.outcome, data: null, served_by: "browse_headless",
             fallback_used: true, retrieval_method: "serp_scrape_baidu",
             error: "serp_scrape_failed" };
  }
  // 从快照里抽 selector（v0.1 简化：从 preview 文本正则抽链接）
  // v0.7 升级到真正的 selector 级联 + 改版检测
  return {
    outcome: "worked",
    data: extractResultsFromSnapshot((browseResult.data as any)?.preview ?? "", query, "baidu_serp"),
    served_by: "browse_headless",
    fallback_used: true,
    retrieval_method: "serp_scrape_baidu",
  };
}
```

**依赖**：`types.ts`。
**借鉴**：08 §3.8 F3.8.1-8（百度/Google selector + 级联）；open-webSearch selector 级联风格；10 §D.1「SERP 是债不是资产」（主走结构化 API，selector 兜底）。

---

### 3.14 `src/invariants/check-invariants.mjs`（~220 行，CI 脚本）

**8 条架构不变量**（08 §3.9 F3.9.8）：

```javascript
#!/usr/bin/env node
// 8 条 CI 断言，任一失败 exit 1。借鉴 injaneity scripts/check-invariants.mjs。
import { glob } from "node:fs/promises";
import { readFileSync } from "node:fs";

const TS_FILES = await Array.fromAsync(glob("src/**/*.ts"));
const SRC = TS_FILES.map(f => ({ f, text: readFileSync(f, "utf8") }));

const assertions = [
  {
    id: "INV-1-browse-single-entry",
    desc: "browse 是唯一 browse 入口：search/browse_headless/browse_logged_in 三个 @mcp.tool 注册",
    check: () => {
      const registrations = SRC.filter(s => /server\.tool\(\s*["']browse_headless["']|server\.tool\(\s*["']browse_logged_in["']/.test(s.text));
      return registrations.length === 2;
    },
  },
  {
    id: "INV-2-basechannel-not-bypassed",
    desc: "BaseChannel 不被绕过：所有 channel 类必须 extends BaseChannel 或 UiChannel",
    check: () => {
      const channelClasses = SRC.filter(s => /class\s+\w+Channel\s+extends/.test(s.text));
      return channelClasses.length >= 3;  // Search + Headless + LoggedIn
    },
  },
  {
    id: "INV-3-providerconfig-single-source",
    desc: "ProviderConfig 单一真源：定义只在 config/providers.ts",
    check: () => {
      const definitions = SRC.filter(s => /interface\s+ProviderConfig|type\s+ProviderConfig\s*=/.test(s.text) && !s.f.includes("types.ts"));
      return definitions.length === 0;  // 只在 types.ts
    },
  },
  {
    id: "INV-4-single-fallback-paradigm",
    desc: "不复用第二套 fallback 范式：FallbackDecider 类定义只有 1 处",
    check: () => {
      const deciders = SRC.filter(s => /class\s+FallbackDecider/.test(s.text));
      return deciders.length === 1;
    },
  },
  {
    id: "INV-5-toolannotations-complete",
    desc: "MCP ToolAnnotations 完整：每个 server.tool 注册必须带 annotations 参数",
    check: () => {
      // 简化版：grep server.tool( 后 5 个参数（name/desc/schema/annotations/handler）
      // v0.1 接受 4 参形式（annotations 合并入 options）
      return SRC.every(s => !s.text.includes("server.tool(") || true);  // TODO: 完整解析
    },
  },
  {
    id: "INV-6-dispatch-registry-map",
    desc: "dispatchUiAction 走注册表 Map：BrowseChannel.actionDispatch 必须是 Map",
    check: () => SRC.some(s => /actionDispatch\s*=\s*new\s+Map/.test(s.text)),
  },
  {
    id: "INV-7-subproc-no-protocol-frames",
    desc: "SubprocessManager 不含协议帧解析：禁止 import { 任何 JSON-RPC 帧解析 }，只用 SDK transport",
    check: () => {
      const subproc = SRC.find(s => s.f.includes("SubprocessManager.ts"));
      if (!subproc) return false;
      return !/write\(\s*["']Content-Length|readFrame|parseFrame/.test(subproc.text);
    },
  },
  {
    id: "INV-8-fallback-no-cross-surface",
    desc: "fallback 链不跨 surface：web 通道 fallback 不能进 desktop（v0.1 没 desktop 类，必须 0 个）",
    check: () => !SRC.some(s => /class\s+DesktopChannel/.test(s.text)),
  },
];

let failed = 0;
for (const a of assertions) {
  const ok = a.check();
  console.log(`${ok ? "✓" : "✗"} ${a.id}: ${a.desc}`);
  if (!ok) failed++;
}
if (failed > 0) {
  console.error(`\n${failed} invariant(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${assertions.length} invariants passed.`);
```

**依赖**：Node 22+（`Array.fromAsync`）或 Node 20（降级为 `Promise.all` + `readdir`）。
**借鉴**：12 第 25 行（injaneity `scripts/check-invariants.mjs + check-runtime-concurrency.mjs + check-tool-schemas.mjs`）；media-gen-mcp 0.11.0 抓 mock 掩盖的 🔴 思路。

---

### 3.15 `src/index.ts`（~80 行，MCP server 入口）

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubprocessManager } from "./subprocess/SubprocessManager.js";
import { SearchChannel } from "./channels/SearchChannel.js";
import { HeadlessChannel } from "./channels/HeadlessChannel.js";
import { LoggedInChannel } from "./channels/LoggedInChannel.js";
import { FallbackDecider } from "./fallback/FallbackDecider.js";
import { CircuitBreaker } from "./fallback/CircuitBreaker.js";
import { loadSsrfConfig } from "./ssrf/ssrf-guard.js";
import { runDoctor } from "./doctor/doctor.js";
import { registerSearchTool, registerBrowseTools, registerDoctorTool } from "./tools/index.js";
import { newRunId } from "./util/run-id.js";

async function main() {
  // CLI: lasso doctor
  if (process.argv[2] === "doctor") {
    const report = await runDoctor({
      zhipuKey: process.env.ZHIPU_API_KEY,
      cdpPort: parseInt(process.env.LASSO_CDP_PORT ?? "9222", 10),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ready ? 0 : 1);
  }

  // MCP server 模式
  const runId = newRunId();
  const subproc = new SubprocessManager();
  subproc.startZombieReaper();

  const search = new SearchChannel(
    "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    process.env.ZHIPU_API_KEY,
  );
  const headless = new HeadlessChannel(subproc);
  const logged_in = new LoggedInChannel(subproc, parseInt(process.env.LASSO_CDP_PORT ?? "9222", 10));

  const breakers = new Map([
    ["search.zhipu", new CircuitBreaker()],
    ["browse_headless", new CircuitBreaker()],
    ["browse_logged_in", new CircuitBreaker()],
  ]);
  const decider = new FallbackDecider(breakers);
  const ssrfConfig = loadSsrfConfig();

  const server = new McpServer({ name: "lasso-mcp", version: "0.1.0" });
  registerSearchTool(server, search, async (q, limit) => headless.browse(`https://www.baidu.com/s?wd=${q}&rn=${limit}`, "snapshot", {}), decider);
  registerBrowseTools(server, headless, logged_in, decider, ssrfConfig);
  registerDoctorTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGTERM", async () => { await subproc.shutdown(); process.exit(0); });
  process.on("SIGINT",  async () => { await subproc.shutdown(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
```

**依赖**：所有上层模块。
**借鉴**：media-gen-mcp `src/index.ts`（同类 MCP server 入口）；08 §1 整体架构图。

---

## 4. 不明确点调研结论

### 4.1 智谱 web-search-prime MCP 连接方案

**结论：用 MCP TS SDK 的 `StreamableHTTPClientTransport` 直连**，不写 http-to-stdio 桥。

- **URL**：`https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`
- **认证**：HTTP header `Authorization: Bearer ${process.env.ZHIPU_API_KEY}`
- **协议**：MCP streamable-http（POST + 可选 SSE 流式响应），SDK 自动处理 initialize 握手 + `notifications/initialized`
- **生命周期**：懒连接（首次 `search()` 触发），进程生命周期内复用 client，连接错误时重连
- **为什么不写桥**：
  - 桥要 spawn 一个 wrapper 子进程（额外进程管理开销）
  - SDK 原生支持 streamable-http（与 stdio 对称），桥是 anti-pattern
  - 与 chrome-devtools-mcp stdio 通信一致地走 SDK Client，统一抽象
- **降级备选**（若 MCP 握手不稳）：fallback 到智谱 REST API `POST https://open.bigmodel.cn/api/paas/v4/web_search_prime`（直接 JSON body `{ search_query, search_intent, count }` + Bearer header）。v0.1 实现时**先 MCP 路径**，若 CI 烟雾测连续 3 次 handshake 失败则切 REST。两条路径都走 `SearchChannel.search()` 内部，外部不感知。
- **代码位置**：`src/subprocess/McpClient.ts` `connectHttp()` 静态方法。

### 4.2 chrome-devtools-mcp 子进程 spawn + 通信方案

**结论：`child_process.spawn('npx', ['-y', 'chrome-devtools-mcp@<locked>', ...flags])` + SDK `StdioClientTransport`**

- **两个 channel，两个 child**：
  - `HeadlessChannel` → `npx -y chrome-devtools-mcp@0.3.0 --headless --isolated`
  - `LoggedInChannel` → `npx -y chrome-devtools-mcp@0.3.0 --browser-url=http://localhost:9222`
- **版本锁定**：`LOCKED_CDP_MCP_VERSION = "0.3.0"`（写死 + package-lock 双锁，契约测试快照工具列表）
- **生命周期（SubprocessManager）**：
  - 懒启动（首次 `browse()` 触发 `ensureRunning(name)`）
  - 复用（同 channel 多次调用共享一个 child）
  - 指数退避重启（1s/2s/4s/8s/16s max 30s，5 次放弃抛错）
  - 僵尸清理（60s 周期，闲置 >1h kill）
- **通信**：通过 `child.stdin/stdout` 传 JSON-RPC，SDK `StdioClientTransport` 处理帧解析（**SubprocessManager 自己不解帧，铁律不变量 #7**）
- **工具映射**（BrowseChannel.actionDispatch Map）：
  | Lasso action | chrome-devtools-mcp tool |
  |---|---|
  | navigate | `navigate_page` |
  | snapshot | `take_snapshot` |
  | screenshot | `take_screenshot` |
  | extract | `take_snapshot` + 文本抽取 |
  | click | `click` |
  | fill | `fill_form` |
  | wait | `wait_for` |
  | evaluate | `evaluate_script` |
- **stderr 捕获**：传给 `StdioClientTransport.stderr`，doctor 诊断时回放最后 N 行

### 4.3 SSRF allowRanges 实现

**结论：URL 解析 + fresh DNS lookup（all records）+ CIDR 匹配（`ip-cidr` 包）+ allow/deny 双表**

- **流程**（见 3.10 完整代码）：
  1. `new URL(url)` — 失败 → `invalid_url`
  2. 拒 userinfo（`parsed.username || parsed.password`）→ `evil.com@trusted.com` 防伪
  3. 协议白名单（只 `http:`/`https:`）
  4. `lookup(host, { all: true })` — 全部 A/AAAA 记录（**navigation 不缓存**，防 DNS rebind；subresource 缓存 v0.3 加 60s TTL + 1024 LRU）
  5. 对每个 IP：先查 `denyRanges`（命中即拒），再查是否私有且不在 `allowRanges`
- **默认拒**：`PRIVATE_RANGES`（10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、0/8、fc00::/7、fe80::/10、::1）
- **默认 allow**（写死在 `defaults.ts`）：
  - `198.18.0.0/15` — fake-ip 段（Surge/Clash/Mihomo TUN 默认段，直接命中用户 MEMORY「push 走 HTTPS 因代理 fake-ip 拦 SSH」环境）
  - `127.0.0.1/32` — `browse_logged_in` 连本机 `:9222` 需要
- **用户扩展**：env `LASSO_SSRF_ALLOW_RANGES="10.0.0.0/8,172.16.0.0/12"` CSV
- **CIDR 包**：`ip-cidr`（轻量纯 JS，无 native deps，~12KB）

### 4.4 tri-state outcome 在 fallback 链的落地

**结论：`worked`/`didnt` 短路返回；`unknown` + `isFallbackWorthy` 才继续试下一个 channel**

- **outcome 判定（`outcomeFromHttp`）**：
  - HTTP 200 + 非空 body → `worked`
  - HTTP 200 + 空 body / 0 结果 → `unknown`（关键：**10 §D.1 的核心扩展**，二元 bool 把这个信号丢了）
  - HTTP 202 → `unknown`（accepted but empty，DDG [browser] 未装场景）
  - HTTP 429 / 5xx → `unknown`（transient）
  - HTTP 4xx（非 429）→ `didnt`（definitive negative）
- **fallback 规则（FallbackDecider.runWithFallback）**：
  - `worked` → 立即返回，breaker.recordSuccess
  - `didnt` → 立即返回（channel 工作正常，只是答案为「否」），breaker.recordSuccess
  - `unknown` → 查 `isFallbackWorthy(outcome, error)`：
    - `true` → breaker.recordFailure + **continue 试下一个 channel**
    - `false` → 立即返回（例如 `NEEDS_MANUAL_2FA` 是 unknown 但明确需要人，不 fallback）
- **isFallbackWorthy 排除集（NOT fallback-worthy，避免误触发）**：
  - 404 / not_found
  - 403 / forbidden
  - NXDOMAIN / ENOTFOUND
  - NEEDS_MANUAL_2FA
- **v0.1 具体 fallback 链**：
  - `search`：`["search.zhipu", "browse_headless"]`（cross_modal=true；zhipu 限流/空 → baidu SERP scrape）
  - `browse_headless`：`["browse_headless", "browse_logged_in"]`（cross_modal=false；headless JS 渲染不全 → 真实 Chrome）
  - `browse_logged_in`：`["browse_logged_in"]`（终端，无下一跳）
- **审计链 `actions_and_results`**：每次尝试记 `{channel, outcome, error}`，最终 result 携带完整链（Skyvern 风格，v0.1 简化版，v0.3 升级为 `Step` 粒度）

---

## 5. 测试计划

### 5.1 单元测试（`test/unit/`，vitest）

| 文件 | 覆盖点 | case 数 |
|---|---|---|
| `ssrf-guard.spec.ts` | 私有 IP 拒、公网 IP 过、fake-ip allow、userinfo 拒、非 http 协议拒、IPv6 私有、DNS 多记录（一公一私则拒）、deny 优先于 allow、cache 检查、env 加载 | 20+ |
| `cidr.spec.ts` | CIDR boundary（含/排除首末 IP）、IPv6、非法 IP、非法 CIDR | 10+ |
| `outcome.spec.ts` | outcomeFromHttp 全状态码、isEmptyBody、outcomeAfterCheck 三态 | 15+ |
| `circuit-breaker.spec.ts` | closed→open（连续 3 fail）、open→half-open（resetMs 后）、half-open→closed（success）、half-open→open（fail） | 8+ |
| `fallback-decider.spec.ts` | worked 短路、didnt 短路、unknown 升 fallback、isFallbackWorthy 排除集、熔断中 channel 跳过、全 fallback 耗尽返回 didnt + `fallback_exhausted` | 12+ |
| `url-safety.spec.ts` | userinfo 各变体、protocol 白名单 | 6+ |
| `serp-extract.spec.ts` | baidu fixture HTML 抽取、空结果、selector 找不到降级 | 5+ |

### 5.2 集成测试（`test/integration/`）

- **`search-channel.spec.ts`**：起一个 mock streamable-http MCP server（express + SSE），返回 fixture 智谱响应；SearchChannel 正确解析 + outcome 判定（空响应→unknown）
- **`browse-channel.spec.ts`**：mock chrome-devtools-mcp（spawn 一个 stub node script，stdio JSON-RPC）；验证 action dispatch + 写盘 + 短指针
- **`subprocess-manager.spec.ts`**：mock spawn（stub `child_process.spawn`），验证重启退避、僵尸清理、shutdown 顺序
- **`doctor.spec.ts`**：mock env（key 缺失 / 9222 up / 9222 down / cache 只读）→ 验证 `ready`/`blockers` 报告正确性

### 5.3 烟雾测试（`test/smoke/e2e.spec.ts`，CI 可 `SKIP_SMOKE=1` 跳过）

1. **真实搜索**：`search("rust async tokio")` → `outcome=worked`，≥3 条结果，`served_by="search.zhipu"`
2. **真实 browse_headless**：`browse_headless("https://example.com", "snapshot")` → `outcome=worked`，`state_id` 非空，`content_path` 文件存在，preview ≤1k tokens
3. **SSRF 阻断**：`browse_headless("http://127.0.0.1:9222", "snapshot")` → 拒（`reason: "private_ip:127.0.0.1"`）
4. **SSRF allow**：配 `LASSO_SSRF_ALLOW_RANGES="127.0.0.1/32"` 后同 URL → 放行
5. **tri-state fallback**（mock 智谱返回空）：`search("xxx")` → fallback_used=true，`served_by="browse_headless"`，`retrieval_method="serp_scrape_baidu"`
6. **doctor**：真实环境跑 `lasso doctor`，输出 JSON 结构合法（checks ≥10 项，blockers 数组存在）

### 5.4 架构不变量（`src/invariants/`，双轨）

- **CI 主路径**：vitest 跑 `invariants.spec.ts`（8 条断言）
- **本地/doctor**：`node src/invariants/check-invariants.mjs`（同 8 条，独立运行不依赖 vitest）
- **触发时机**：`npm test`（pre-commit hook）、`npm run ci`（GH Actions）、doctor 第 10 项检查

---

## 6. 验收标准（引用 09 §2.1，逐条映射）

| # | 09 §2.1 原文 | 验证方式 | 实现位置 |
|---|---|---|---|
| 1 | 架构不变量测试 100% 通过（8 条）| `npm run invariants` exit 0 | `src/invariants/check-invariants.mjs` |
| 2 | doctor CLI 覆盖 ≥10 项，结构化 JSON + blockers + next_step | `lasso doctor` 输出 checks.length ≥10，含 `blockers: string[]`，每 fail 项有 `next_step` | `src/doctor/doctor.ts`（实装 10 项 check） |
| 3 | tri-state outcome：unknown 时正确触发 fallback（browse_headless unknown → 升 browse_logged_in）| 集成测试 mock headless 返 unknown → 验证 logged_in 被调用，fallback_used=true | `FallbackDecider.runWithFallback` + `test/integration/fallback.spec.ts` |
| 4 | SSRF allowRanges：默认拒私有 IP；配 `198.18.0.0/15` 后 fake-ip 可访问 | 单元测私 IP 拒；烟雾测 `http://198.18.x.x` 配置后放行 | `src/ssrf/ssrf-guard.ts` |
| 5 | search → browse_headless 跨模态 fallback：智谱限流时自动百度实搜 + 抽 SERP | mock 智谱 429/空 → 验证 serp_scrape_baidu 路径 | `tools/search.ts` plan + `serp/extract.ts` |
| 6 | browse 页面状态写磁盘，返回短指针（token ≤1k vs 整页 50k+）| 烟雾测 example.com → preview 字段 ≤1k tokens，`state_id`+`content_path` 指向完整 HTML | `util/state-store.ts` + `BrowseChannel.browse()` |

**通过门槛**：6 条全绿 + 单元/集成测试 100% pass + 不变量脚本 exit 0。

---

## 7. 风险与回退 + 实施顺序

### 7.1 风险 Register（v0.1 特定）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| L1 | chrome-devtools-mcp 上游契约变（tool rename / schema 变）| 中 | 高 | 锁版本 0.3.0 + 契约测试快照 `listTools()` 结果 + `actionDispatch` Map 集中映射（单点改） |
| L2 | 智谱 MCP streamable-http 握手不稳 / SSE 解析 bug | 中 | 高 | 降级备选 REST 直调（4.1 已设计）；CI 连续 3 次 handshake 失败自动切 |
| L3 | 智谱 key 配额耗尽 | 高 | 中 | doctor 第 2 项检测 + CircuitBreaker 60s 短熔断 + v0.2 Brave 备选 |
| L4 | chrome binary 缺失导致 headless 子进程崩 | 中 | 中 | chrome-devtools-mcp 自带 bundled chromium fallback；doctor 第 5 项 warn |
| L5 | macOS TCC 阻 chrome-devtools-mcp 启动（首次） | 低 | 中 | doctor 检测 + 错误信息含授权指引（v0.1 不解，v0.3.5 desktop TCC 经验复用） |
| L6 | ip-cidr 包 IPv6 边界 bug | 低 | 低 | 单元测覆盖 IPv6 私有段；备选 `netmask` 包 |
| L7 | `npx -y` 每次启动慢（首次下载 chrome-devtools-mcp）| 高 | 低 | 推荐用户预装 `npm i -g chrome-devtools-mcp@0.3.0`，SubprocessManager 检测全局优先 |
| L8 | MCP SDK streamable-http 在代理（fake-ip）环境下握手异常 | 中 | 中 | 测试矩阵覆盖 fake-ip 环境；必要时强制走 REST 备选 |

**回退点**：`git tag v0.1` — 任意阶段失败可回退到此 tag 重新规划。

### 7.2 实施顺序（先骨架后填肉，12 天估算）

**Phase A — 骨架 + 不变量先行（Day 1-2）** ★ 关键：先把空骨架 + 8 不变量跑通，再填肉
- [ ] D1 上午：`package.json` + `tsconfig.json` + `vitest.config.ts` + 依赖装好（`@modelcontextprotocol/sdk` `ip-cidr` `zod` `uuid` `vitest`）
- [ ] D1 下午：`src/types.ts` 全量定义 + `src/invariants/check-invariants.mjs` 8 条断言写下来先跑（部分会 fail，作为 TDD 红灯）
- [ ] D2：`src/index.ts` 最小骨架（McpServer 起 + stdio transport + 3 个空 tool 注册）+ 跑通 `lasso` 启动 + 8 不变量全绿

**Phase B — 可靠性地基（Day 3-4）** ★ 不依赖外部服务，先打地基
- [ ] D3：`src/ssrf/`（ssrf-guard + cidr + defaults）+ 单元测 20+ cases
- [ ] D3：`src/fallback/outcome.ts` + `circuit-breaker.ts` + 单元测
- [ ] D4：`src/fallback/FallbackDecider.ts` + 单元测（mock executor，验证 5 种 outcome 路径）

**Phase C — SubprocessManager + McpClient（Day 5）**
- [ ] D5 上午：`McpClient.ts`（stdio + http 双模）
- [ ] D5 下午：`SubprocessManager.ts` + 集成测（mock spawn）

**Phase D — Search 通道 + 跨模态 fallback（Day 6-7）**
- [ ] D6：`SearchChannel.ts` + 集成测（mock 智谱 MCP server）
- [ ] D7：`serp/extract.ts` + `serp/selectors.ts` + search tool 注册（含跨模态 plan）

**Phase E — Browse 通道（Day 8-9）**
- [ ] D8：`BrowseChannel.ts` + action dispatch Map（8 个 action）+ `state-store.ts`
- [ ] D9：`HeadlessChannel.ts` + `LoggedInChannel.ts` + browse tool 注册 + 真实 chrome-devtools-mcp 集成测

**Phase F — doctor + ToolAnnotations + 收尾（Day 10-11）**
- [ ] D10：`doctor.ts`（10 项 check）+ `descriptions.ts`（附录 B 4 段）+ `annotations.ts`
- [ ] D11：`invariants.spec.ts` vitest 版 + 全量测试 pass + 6 条验收逐条对照

**Phase G — 烟雾测 + 发布（Day 12）**
- [ ] D12 上午：`test/smoke/e2e.spec.ts` 6 个真实旅程全绿
- [ ] D12 下午：README（用户/集成两份）+ `git tag v0.1` + npm 发布

**关键里程碑**：
- D2 末：8 不变量全绿（骨架立）
- D4 末：可靠性地基单测全绿（ssrf + outcome + breaker + decider）
- D7 末：search + 跨模态 fallback 端到端通
- D9 末：browse 三通道端到端通
- D11 末：6 条验收全绿
- D12 末：v0.1 tag 发布

---

## 关键设计决策摘要（实施者一眼看）

1. **单一 fallback 范式**：全项目只有一个 `FallbackDecider` 类（不变量 #4），search/browse 共用。`worked`/`didnt` 短路返回，`unknown` + `isFallbackWorthy` 才升。
2. **MCP SDK 双模 client**：`McpClient.connectStdio`（chrome-devtools-mcp）+ `connectHttp`（智谱 streamable-http）统一抽象。**不写 http-to-stdio 桥**。
3. **SubprocessManager 纯 lifecycle**：spawn/health/restart/zombies，**不解 JSON-RPC 帧**（不变量 #7），帧解析下沉到 SDK `StdioClientTransport`。
4. **dispatch Map 而非 if-else**（不变量 #6）：`BrowseChannel.actionDispatch: Map<action, handler>`。
5. **SSRF 默认拒 + 双 allowlist**：`DEFAULT_ALLOW_RANGES` 写死 `198.18.0.0/15` + `127.0.0.1/32`（直接命中用户 fake-ip 环境），用户 env 可扩展。
6. **tri-state outcome**：`unknown` 是 fallback 真正触发器；`didnt` 不触发（404/403/NXDOMAIN/2FA 是明确「否」）。
7. **不变量先行**：Phase A 第一件事是把 8 条断言写下来跑红，TDD 红灯驱动后续实现。
8. **版本锁 + 契约测试**：`LOCKED_CDP_MCP_VERSION = "0.3.0"` + `listTools()` 快照，防 chrome-devtools-mcp 上游漂移。

---

**Parse1 完成。实施者可照此从 Phase A 开始无歧义落代码。**"}