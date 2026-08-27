# Lasso v0.2 — parse2 文件/函数级执行计划

> 产出目标：实施者照此可在 v0.1（172 tests + 8 invariants + MCP 握手 + doctor 真实通）之上**无歧义增量落代码**，不重写 v0.1。
> 上游：[08 §3.1/§3.6/§3.8 + 附录 A ProviderConfig](/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md) / [09 §2.2 v0.2 验收 6 条](/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md) / [10 §2-§4 Brave 选型 + ProviderConfig 扩展](/Users/wangdong/Documents/Project/cc-control-all/doc/10-搜索MCP调研对架构的启发.md) / [parse1 v0.1 现状](/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse1.md)。
> v0.1 已落实现：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/{types.ts, channels/SearchChannel.ts, config/{providers.ts,config.ts}, fallback/{FallbackDecider.ts,outcome.ts,CircuitBreaker.ts}, serp/{extract.ts,selectors.ts}, doctor/doctor.ts, invariants/check-invariants.mjs}`。

---

## 1. v0.2 目标与范围（在 v0.1 基础上的增量）

**能力目标（一句话）**：search 通道不再单依赖智谱——加结构化 API 第二源（Brave，**仅引「669ms + 14.89 Agent Score + 2000/月」三项数字，强制 in-house A/B 实测后锁定主力**，10 §4.3 否决"Brave 最优"因果延伸）+ 多源扇出 + 7 天结果 cache + provider 矩阵地基，且不破坏 v0.1 的 172 tests + 8 invariants。

**v0.2 含**：
- **统一 ProviderConfig 注册表**（08 §3.6 + 11 F3）：`provider_type` 三态（`api_key`/`broker`/`self_hosted`）+ 多 Key 池 + `free_quota_per_month` + `quota_model` + `policy_risk` + `licence` + `commercial_safe` + `fallback_order`。**加 provider = config 加一项**（开闭，≤2 处改动）。
- **Brave Search 第二源**（REST 直调，非 community MCP；与智谱 streamable-http 同抽象层）
- **search 多源扇出**（F3.1.6）+ **limit 跨源分配**（F3.1.7，按 `free_quota_per_month` 比例 + 语言启发式）+ **attributed 查询**（F3.1.8，每条结果带 `served_by` 来源）+ **free_only 四级**（F3.1.10，L1/L2/L3/L4）
- **结果 cache 7 天 TTL**（F3.1.4，attribution key）
- **SERP 改版检测**（F3.8.9，骨架 + 命中率统计 F3.8.10 + selector 集中管理 F3.8.13 + 录制回放 F3.8.14 v0.2 先落骨架）
- **partial_failures**（F3.9.7）+ **连接池**（F3.5.7，智谱 + Brave HTTP keep-alive）
- **HTTP 202 空响应识别**（v0.1 `outcomeFromHttp` 已实装，v0.2 补集成测试验证 fallback 链识别）
- **in-house A/B 实测工具**（5-10 真实中英文 query，p50/p95 + provider 矩阵打分表，**验收 #1 硬指标**）

**v0.2 不做（推迟）**：
- Tavily 接入（10 §4.4 watch-list，Nebius 收购后稳定 6 个月再考虑）
- mcp-searxng（10 §3.4 NO-GO，broker 需自建 SearXNG 实例）
- Exa（10 §4.3 不该进候选，高频 429 违反 `isFallbackWorthy`）
- One Search local（10 §4.3 同族 browse 型，不是"第二结构化 API 源"）
- Wayback（v0.9）、Bing（v0.9）、rerank（v0.3）、`caller-tier cap` 完整实现（v0.3，v0.2 用免费层天然额度做 MVP）
- 60min 长熔断完整实装（v0.7，v0.2 只在 outcome 层识别 `429+retry-after` 为"配额型"信号供 v0.7 接入）

**映射 F 编号**（08 §4）：F3.1.6-10 / F3.5.7 / F3.6.13 / F3.8.9-10,13-14 / F3.9.7。

---

## 2. 文件改动清单（增量，不重写 v0.1）

### 2.1 新增文件（13 个）

```
lasso/src/
├── config/
│   ├── provider-registry.ts        # ProviderConfig 注册表 + CapabilityBag 自动生成 (~180 行)
│   └── quota-ledger.ts             # 多 Key 池 + 配额账本（remaining/reset_at/exhausted）(~220 行)
├── channels/
│   └── BraveChannel.ts             # Brave Search REST 直调 + Key 池注入 + 429 感知 (~200 行)
├── search/
│   ├── MultiSourceFanout.ts        # 多源扇出 + limit 跨源分配 + 语言启发式 (~150 行)
│   ├── AttributedSearch.ts         # attributed 查询包装（合并多源结果 + served_by 标签）(~90 行)
│   ├── FreeTierRouter.ts           # free_only 四级分级路由 (L1/L2/L3/L4) (~110 行)
│   └── SearchCache.ts              # 7 天 TTL cache + attribution key + LRU 1000 (~140 行)
├── serp/
│   ├── ChangeDetection.ts          # SERP 改版检测骨架（selector hash + 命中率基线）(~120 行)
│   ├── HitRateStats.ts             # 命中率统计（每 selector / 每 engine）(~80 行)
│   ├── SelectorRegistry.ts         # selector 集中管理（versioned + last_known_good）(~100 行)
│   └── RecordingStore.ts           # 录制回放（v0.2 只存 fixture，回放 v1.0）(~70 行)
├── fallback/
│   └── PartialFailures.ts          # partial_failures 聚合（F3.9.7）(~90 行)
└── benchmark/
    └── run-ab-benchmark.ts         # in-house A/B 实测 CLI（5-10 query × zhipu vs brave）(~200 行)

lasso/scripts/
└── ab-queries.json                 # 50 中 + 50 英固定 query 集（A/B 输入）

lasso/test/
├── unit/
│   ├── quota-ledger.spec.ts
│   ├── brave-channel.spec.ts
│   ├── multi-source-fanout.spec.ts
│   ├── free-tier-router.spec.ts
│   ├── search-cache.spec.ts
│   ├── change-detection.spec.ts
│   └── partial-failures.spec.ts
└── integration/
    ├── provider-registry.spec.ts
    ├── attributed-search.spec.ts
    └── benchmark.spec.ts
```

### 2.2 修改文件（10 个，**增量改不破坏 v0.1 接口**）

| 文件 | 改动摘要 | 兼容性 |
|---|---|---|
| `src/types.ts` | `ProviderConfig` 扩 6 字段（`policy_risk`/`licence`/`commercial_safe`/`endpoint_url` 必填变可空等）；新增 `FreeTierLevel` enum + `AttributedResult` + `SearchCacheEntry` | **字段全可选** → v0.1 实例化不破 |
| `src/config/providers.ts` | `ZHIPU` 补 6 字段；新增 `BRAVE` provider；新增 `TAVILY_WATCH`（policy_risk=`watched`，仅占位不接入） | 加项不删 |
| `src/config/config.ts` | 解析 `BRAVE_API_KEYS`（CSV 多 Key）+ `LASSO_SEARCH_FREE_ONLY` env + 注入 QuotaLedger | v0.1 env 全保留 |
| `src/channels/SearchChannel.ts` | 改名 `ZhipuSearchChannel`（保留 `SearchChannel` 别名导出，v0.1 代码不破）；接受可选 `QuotaLedger` 参数；本类不再单例 | v0.1 import 仍可用 |
| `src/fallback/FallbackDecider.ts` | `InteractResult` 加 `partial_failures?: PartialFailure[]`（可选，v0.1 接口签名不变） | 字段可选 |
| `src/fallback/CircuitBreaker.ts` | 加 `recordQuotaExhaustion(resetAt)` 方法（v0.7 长熔断预备）；不改 `allow()`/`recordFailure()` 签名 | 纯加方法 |
| `src/fallback/outcome.ts` | `isFallbackWorthy` 增识别 `429+retry-after` → 返回 true 但附 `quota_signal: true` 元数据 | 加字段不改返回类型 |
| `src/subprocess/SubprocessManager.ts` | 加 `acquireHttpClient(name)`：返回共享 keep-alive client（智谱 + Brave 共用，每 host 一个 `undici.Agent`） | v0.1 spawn 路径不动 |
| `src/tools/search.ts` | `searchSchema` 增 `engine: enum ["zhipu","brave","auto"]`（默认 `auto`）+ `free_only?: L1\|L2\|L3\|L4` + `attributed?: bool`；plan 改多源（`auto` → 多源扇出） | v0.1 参数全兼容（全有默认） |
| `src/serp/selectors.ts` | 每条 selector 加 `version: string` + `last_known_good: ISO`；改升级到 SelectorRegistry 注册 | v0.1 常量保留导出 |
| `src/doctor/doctor.ts` | 加 4 项 check：`brave_keys` / `provider_registry_loadable` / `quota_ledger_initialized` / `search_cache_dir_writable` | ≥14 项（v0.1 10 项） |
| `src/invariants/check-invariants.mjs` | 加 3 条 v0.2 不变量：`INV-9-provider-registry-single-source` / `INV-10-brave-keys-via-ledger`（禁直接读 env） / `INV-11-cache-key-attributed` | v0.1 8 条不动，共 11 条 |
| `package.json` | `version: "0.2.0-dev"` + 加依赖 `undici`（HTTP keep-alive，无 native deps） | 不动既有依赖 |

**关键设计**：v0.1 的 `SearchChannel` 类改名 `ZhipuSearchChannel`，但同时 `export const SearchChannel = ZhipuSearchChannel` 别名，**v0.1 既有 import 零改动**。

---

## 3. 各模块实施细节

### 3.1 ProviderConfig 注册表实装（`src/config/provider-registry.ts` + `types.ts` 升级 + `providers.ts` 升级 + `config.ts` 加载）

#### 3.1.1 `src/types.ts`（扩 v0.1 `ProviderConfig`，全字段可选 → v0.1 实例化不破）

```typescript
// === 新增 enum（F3.1.10 四级分级）===
export type FreeTierLevel = "L1" | "L2" | "L3" | "L4";
// L1=完全免费零Key（DDG/SearXNG 自建）
// L2=免费层需Key（Brave 2000/月、智谱、Tavily 1000、Jina）
// L3=远程 URL 免Key（Exa、Jina read_url）
// L4=付费（Perplexity/Serper/Google CSE/Bing）

// === ProviderConfig 扩展（v0.1 字段全保留 + 6 新字段全可选）===
export interface ProviderConfig {
  // --- v0.1 已有 ---
  name: string;
  type: "api_key" | "broker" | "self_hosted";
  endpoint_url: string | null;
  keys: string[];
  free_quota_per_month: number;
  quota_model: "monthly" | "rpm" | "token" | "request";
  fallback_order: number;
  // --- v0.2 新增（全可选，不破 v0.1 实例化）---
  free_tier_level?: FreeTierLevel;           // L1/L2/L3/L4，默认按 type 推断
  policy_risk?: "safe" | "acquired" | "watched";  // Tavily=acquired，默认 safe
  licence?: "mit" | "apache2" | "agpl" | "non_commercial";  // Jina=non_commercial，SearXNG=agpl
  commercial_safe?: boolean;                 // Jina false，其余默认 true
  tags?: string[];                            // ["search","browse","desktop"] 等
  enabled?: boolean;                          // false 时 CapabilityBag 不生成 channel，默认 true
}

// === AttributedResult（F3.1.8，多源扇出后单条结果带来源标签）===
export interface AttributedResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  served_by: string;            // "search.zhipu" / "search.brave" / "browse_headless"
  original_rank?: number;       // 原引擎内排名（rerank 用）
}

// === SearchCacheEntry（F3.1.4）===
export interface SearchCacheEntry<T = unknown> {
  key: string;                  // attribution key（sha1 of canonical query）
  query: string;
  engine: string;
  region: string;
  limit: number;
  result: T;                    // InteractResult<SearchResult>
  created_at: number;           // epoch ms
  hits: number;
}

// === PartialFailure（F3.9.7）===
export interface PartialFailure {
  channel: string;
  error: string;
  timestamp: number;
  // 部分成功：该 channel 返回了部分结果（< limit），但 outcome=worked
  partial_count?: number;
}
```

**不变量守卫**：INV-3「ProviderConfig 单一真源」继续生效——`interface ProviderConfig` 定义只在 `types.ts`。

#### 3.1.2 `src/config/providers.ts`（升级 v0.1 三条 + 新增 Brave）

```typescript
import type { ProviderConfig } from "../types.js";

// === v0.1 ZHIPU 补 v0.2 字段 ===
const ZHIPU: ProviderConfig = {
  name: "zhipu",
  type: "api_key",
  endpoint_url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  keys: [],                                    // config.ts 从 env 注入
  free_quota_per_month: 0,                     // 智谱未公开精确值（doctor warn）
  quota_model: "token",                        // 智谱按 token 计费
  fallback_order: 0,                           // 中文主力
  free_tier_level: "L2",
  policy_risk: "safe",
  licence: "mit",                              // 智谱 MCP 兼容
  commercial_safe: true,
  tags: ["search"],
  enabled: true,
};

// === v0.2 新增 BRAVE ===
// 仅引三项硬数据（10 §4.3）：669ms / 14.89 Agent Score / 2000/月
// 不写"最优"（05 否决因果延伸）
const BRAVE: ProviderConfig = {
  name: "brave",
  type: "api_key",
  endpoint_url: "https://api.search.brave.com/res/v1/web/search",
  keys: [],                                    // config.ts 从 BRAVE_API_KEYS CSV 注入
  free_quota_per_month: 2000,
  quota_model: "monthly",
  fallback_order: 1,                           // 英文/质量层
  free_tier_level: "L2",
  policy_risk: "safe",                         // 无收购风险（Tavily=Nebius 2026-02 对照）
  licence: "apache2",
  commercial_safe: true,
  tags: ["search"],
  enabled: true,
};

// === v0.2 占位 TAVILY（policy_risk=acquired，默认 enabled=false）===
// 10 §4.4：watch-list，Nebius 收购后稳定 6 个月再考虑
const TAVILY_WATCH: ProviderConfig = {
  name: "tavily",
  type: "api_key",
  endpoint_url: "https://api.tavily.com/search",
  keys: [],
  free_quota_per_month: 1000,
  quota_model: "request",
  fallback_order: 99,
  free_tier_level: "L2",
  policy_risk: "acquired",                     // 10 §5.1 Nebius 收购
  licence: "mit",
  commercial_safe: false,                      // 收购后条款未明
  tags: ["search"],
  enabled: false,                              // v0.2 不接入，仅 schema 占位
};

// v0.1 原 BROWSE_HEADLESS / BROWSE_LOGGED_IN 不动（补 enabled: true 等可选字段）
const BROWSE_HEADLESS: ProviderConfig = { /* v0.1 不变 */ enabled: true, tags: ["browse"] };
const BROWSE_LOGGED_IN: ProviderConfig = { /* v0.1 不变 */ enabled: true, tags: ["browse"] };

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  ZHIPU, BRAVE, TAVILY_WATCH, BROWSE_HEADLESS, BROWSE_LOGGED_IN,
];

// === v0.2 加 provider 入口（开闭）===
// 用户/未来版本加 provider：只需 push 到这个数组
export function registerBuiltinProvider(p: ProviderConfig): void {
  // immutable snapshot，运行时不加（v0.6 热更新才加）；CI 时静态注册
  BUILTIN_PROVIDERS_PUSHONLY.push(p);
}
export const BUILTIN_PROVIDERS_PUSHONLY: ProviderConfig[] = [];
```

**开闭验证（验收 #6）**：加新 provider 改动 ≤2 处——①在 `providers.ts` 加一个 `const XXX: ProviderConfig` + push 到 `BUILTIN_PROVIDERS`；**不需要改 channel/fallback/search/tool 任何代码**（CapabilityBag 据配置自动生成）。

#### 3.1.3 `src/config/provider-registry.ts`（注册表 + CapabilityBag 自动生成）

```typescript
import type { ProviderConfig, FreeTierLevel } from "../types.js";
import { QuotaLedger } from "./quota-ledger.js";

export interface RegisteredProvider {
  config: ProviderConfig;
  ledger: QuotaLedger | null;     // browse/self_hosted 无配额 → null
  capability: "search" | "browse" | "desktop";
}

export class ProviderRegistry {
  private byName = new Map<string, RegisteredProvider>();
  private byCapability = new Map<string, RegisteredProvider[]>();

  constructor(private readonly configs: readonly ProviderConfig[]) {
    for (const c of configs) {
      if (c.enabled === false) continue;
      const cap = (c.tags?.[0] ?? "search") as RegisteredProvider["capability"];
      const ledger = c.type === "api_key" && c.keys.length > 0
        ? new QuotaLedger(c.name, c.keys, c.free_quota_per_month, c.quota_model)
        : null;
      const entry: RegisteredProvider = { config: c, ledger, capability: cap };
      this.byName.set(c.name, entry);
      this.byCapability.has(cap) || this.byCapability.set(cap, []);
      this.byCapability.get(cap)!.push(entry);
    }
    // 按 fallback_order 排序
    for (const list of this.byCapability.values()) {
      list.sort((a, b) => a.config.fallback_order - b.config.fallback_order);
    }
  }

  get(name: string): RegisteredProvider | undefined { return this.byName.get(name); }
  byCap(cap: string): RegisteredProvider[] { return this.byCapability.get(cap) ?? []; }

  /** free_only 四级过滤（F3.1.10）*/
  filterByFreeTier(level: FreeTierLevel): ProviderConfig[] {
    const order: Record<FreeTierLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
    const maxOrd = order[level];
    return this.byCapability.get("search")!
      .filter(p => order[p.config.free_tier_level ?? "L2"] <= maxOrd)
      .map(p => p.config);
  }
}
```

#### 3.1.4 `src/config/config.ts`（v0.1 升级：多 Key CSV + QuotaLedger 注入）

```typescript
// v0.1 loadConfig 基础上加 4 行：
export function loadConfig(opts: LoadConfigOptions): LassoConfig {
  // ... v0.1 全部保留 ...

  // v0.2 新增：Brave 多 Key CSV
  const braveKeysCsv = env.BRAVE_API_KEYS ?? env.BRAVE_API_KEY ?? "";
  const braveKeys = braveKeysCsv.split(",").map(s => s.trim()).filter(Boolean);
  if (braveKeys.length > 0) {
    const brave = providers.get("brave");
    if (brave) brave.keys = braveKeys;
  }

  // v0.2 新增：ProviderRegistry 装配
  const registry = new ProviderRegistry([...providers.values()]);

  // v0.2 新增：free_only 全局默认（env 覆盖）
  const searchFreeOnly = (env.LASSO_SEARCH_FREE_ONLY ?? "L4") as FreeTierLevel;

  return {
    runId: opts.runId,
    providers,
    registry,                       // 新
    zhipuApiKey, zhipuEndpoint, cdpPort, cacheDir,
    searchCacheDir: path.join(cacheDir, "search-cache"),  // 新
    searchFreeOnly,                 // 新
  };
}
```

**env 新增**：`BRAVE_API_KEYS`（CSV，支持多 Key 轮换）/ `LASSO_SEARCH_FREE_ONLY`（默认 `L4`=全部允许，设 `L2` 则禁付费）。

---

### 3.2 `BraveChannel.ts`（结构化 REST API + Key 池 + 配额追踪）

```typescript
import { BaseChannel } from "./BaseChannel.js";
import type { ChannelStatus, Health, InteractResult, Outcome, SearchResult } from "../types.js";
import type { QuotaLedger } from "../config/quota-ledger.js";
import { outcomeFromHttp } from "../fallback/outcome.js";
import { logger } from "../util/logger.js";

export interface BraveOpts {
  limit: number;
  region: string;       // "CN" / "US" / "ALL"（Brave 用 ISO 国家码）
  no_cache: boolean;
}

/**
 * BraveChannel：Brave Search REST API 直调。
 *
 * 为什么 REST 不 MCP：Brave 官方提供 REST（api.search.brave.com/res/v1/web/search），
 * community MCP 是 wrapper 额外层。与智谱 streamable-http 在 Lasso 内同抽象（HTTP），
 * 不增加 SubprocessManager 进程。
 *
 * Key 轮换：每次请求前 ledger.pickKey() 选余量最多 Key；429 时 ledger.markExhausted()。
 *
 * 引用 Brave 仅「669ms + 14.89 Agent Score + 2000/月」三项硬数据（10 §4.3）。
 * 是否真主力由 in-house A/B 实测决定（benchmark/run-ab-benchmark.ts）。
 *
 * 借鉴：Brave Search API 官方文档；parse1 §3.4 SearchChannel 范式（同样 BaseChannel + InteractResult）。
 */
export class BraveChannel extends BaseChannel {
  readonly name = "search.brave";

  constructor(
    private readonly endpoint: string,
    private readonly ledger: QuotaLedger,
    private readonly httpClient: { fetch: typeof fetch },  // 注入，便于测试 mock
  ) { super(); }

  async isAvailable(): Promise<boolean> {
    return this.ledger.hasAvailableKey();
  }

  async status(): Promise<ChannelStatus> {
    if (!await this.isAvailable()) {
      return { available: false, note: "Brave key exhausted or missing" };
    }
    // 触网只做 list（实际无 list 端点 → 用最小 query 探活）
    try {
      const t0 = Date.now();
      const r = await this._doRequest("ping", 1, "ALL", this.ledger.pickKey()!);
      return { available: r.outcome !== "unknown", latency_ms: Date.now() - t0 };
    } catch (e) { return { available: false, note: String(e) }; }
  }

  async healthCheck(): Promise<Health> {
    const s = await this.status();
    if (!s.available) return "down";
    if (s.latency_ms !== undefined && s.latency_ms > 2000) return "degraded";
    return "healthy";
  }

  async search(query: string, opts: BraveOpts): Promise<InteractResult<SearchResult>> {
    if (!await this.isAvailable()) {
      return { outcome: "unknown", data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "brave_api",
               error: "brave_keys_exhausted" };
    }
    const key = this.ledger.pickKey()!;
    try {
      const { outcome, data, status, retryAfter } = await this._doRequest(query, opts.limit, opts.region, key);
      if (status === 429) {
        this.ledger.markExhausted(key, retryAfter ?? Date.now() + 60_000);
        logger.warn({ evt: "brave_429", key_hash: hashKey(key), retry_after: retryAfter });
      } else if (outcome === "worked") {
        this.ledger.recordSuccess(key, 1);
      }
      return {
        outcome,
        data: outcome === "worked" ? {
          query, results: data ?? [], count: data?.length ?? 0,
          engine: "brave", region: opts.region,
        } : null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "brave_api",
      };
    } catch (e) {
      return { outcome: "unknown", data: null, served_by: this.name,
               fallback_used: false, retrieval_method: "brave_api", error: String(e) };
    }
  }

  private async _doRequest(query: string, count: number, country: string, key: string): Promise<{
    outcome: Outcome; data: SearchResult["results"] | null; status: number; retryAfter?: number;
  }> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(count, 20)));  // Brave 单次 max 20
    url.searchParams.set("country", country);
    const resp = await this.httpClient.fetch(url, {
      headers: { "X-Subscription-Token": key, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const retryAfter = resp.headers.get("retry-after");
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
    if (resp.status === 429) {
      return { outcome: "unknown", data: null, status: 429, retryAfter: retryAfterMs };
    }
    const body = await resp.json().catch(() => null);
    const outcome = outcomeFromHttp(resp.status, body);
    if (outcome !== "worked") return { outcome, data: null, status: resp.status };
    const results = parseBraveResults(body);
    return { outcome: results.length === 0 ? "unknown" : "worked", data: results, status: resp.status };
  }
}

// === Brave 响应解析 ===
// 形状：{ web: { results: [{ title, url, description, language, ... }] }, query: {...} }
function parseBraveResults(body: any): SearchResult["results"] {
  const arr = body?.web?.results ?? [];
  return arr.map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.description ?? r.snippet ?? ""),
    source: r.profile?.name ?? undefined,
  })).filter((r: SearchResult["results"][number]) => r.url);
}

function hashKey(key: string): string {
  // 不打日志全 key，只前 4 + 后 4
  return key.length > 8 ? `${key.slice(0,4)}...${key.slice(-4)}` : "short";
}
```

**依赖**：`BaseChannel`，`QuotaLedger`，`outcomeFromHttp`，`logger`。
**借鉴**：[Brave Search API 官方文档](https://api.search.brave.com/app/documentation)；parse1 §3.4 SearchChannel 范式。

---

### 3.2.1 `QuotaLedger.ts`（多 Key 池 + 配额账本）

```typescript
import { logger } from "../util/logger.js";

interface KeyState {
  key: string;
  remaining: number;          // 本月剩余
  resetAt: number;            // 下次重置 epoch ms（月初 UTC）
  exhaustedAt?: number;       // 429 时点 timestamp
  totalUsed: number;          // 累计成功调用数
}

/**
 * QuotaLedger：单 provider 多 Key 配额账本。
 *
 * 选 Key 策略（F3.1.7 limit 跨源分配前置）：
 *  - pickKey() 返回余量最多且未 exhausted 的 Key（贪心）
 *  - 余量 <50（验收 #2）时 logger.warn，外层可降级
 *  - 全部 exhausted → 返回 null → channel.isAvailable()=false → fallback
 *
 * 配额模型适配（10 §2.8）：
 *  - monthly   → resetAt 月初，余量 = quota_per_month - used
 *  - rpm       → resetAt = now + 60s，余量 = rate_limit - window_used
 *  - token     → v0.2 退化成 monthly（按请求计数，近似）；v0.3 升级 token 精确计
 *  - request   → 同 monthly（按请求计）
 *
 * 多 Key 配额合并（10 §4.2 / 验收 #2）：2 Key × 2000/月 = 4000/月
 *  - channel 内部按 Key 轮转
 *  - doctor 报告合并视图：search.brave 总余量 = Σ(key.remaining)
 *
 * 持久化：v0.2 内存态（进程重启清零，免费层配额足够）；v0.6+ 可选落盘 ~/.cache/lasso/quota/
 *
 * 借鉴：10 §2.8 provider schema 扩展；04 §4.2 Brave 多 Key 扩容路径。
 */
export class QuotaLedger {
  private states: KeyState[] = [];
  private currentMonthStart: number;

  constructor(
    public readonly providerName: string,
    keys: readonly string[],
    private readonly quotaPerMonth: number,
    private readonly model: "monthly" | "rpm" | "token" | "request" = "monthly",
  ) {
    this.currentMonthStart = startOfMonthUTC(Date.now());
    for (const k of keys) {
      this.states.push({ key: k, remaining: quotaPerMonth, resetAt: this.currentMonthStart, totalUsed: 0 });
    }
  }

  hasAvailableKey(): boolean {
    this._maybeRollover();
    return this.states.some(s => s.remaining > 0 && !this._isExhausted(s));
  }

  /** 选余量最多且未 exhausted 的 Key（贪心） */
  pickKey(): string | null {
    this._maybeRolloover();
    const avail = this.states
      .filter(s => s.remaining > 0 && !this._isExhausted(s))
      .sort((a, b) => b.remaining - a.remaining);
    return avail[0]?.key ?? null;
  }

  recordSuccess(key: string, cost: number): void {
    const s = this.states.find(x => x.key === key);
    if (!s) return;
    s.remaining = Math.max(0, s.remaining - cost);
    s.totalUsed += cost;
    if (s.remaining < 50) {
      logger.warn({ evt: "quota_low", provider: this.providerName, remaining: s.remaining });
    }
  }

  markExhausted(key: string, resetAt: number): void {
    const s = this.states.find(x => x.key === key);
    if (!s) return;
    s.exhaustedAt = Date.now();
    s.resetAt = Math.max(s.resetAt, resetAt);
    s.remaining = 0;
  }

  /** 合并视图（doctor 用） */
  totalRemaining(): number {
    this._maybeRolloover();
    return this.states.reduce((sum, s) => sum + Math.max(0, s.remaining), 0);
  }

  private _isExhausted(s: KeyState): boolean {
    if (!s.exhaustedAt) return false;
    return Date.now() < s.resetAt;
  }

  private _maybeRollover(): void {
    const m = startOfMonthUTC(Date.now());
    if (m > this.currentMonthStart) {
      this.currentMonthStart = m;
      for (const s of this.states) {
        s.remaining = this.quotaPerMonth;
        s.exhaustedAt = undefined;
      }
      logger.info({ evt: "quota_monthly_rollover", provider: this.providerName });
    }
  }
}

function startOfMonthUTC(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
```

**注意**：`_maybeRolloover` 笔误（重复 o），实施时改 `_maybeRollover`。

---

### 3.3 search 多源扇出（`MultiSourceFanout.ts` + `AttributedSearch.ts` + `tools/search.ts` 升级）

#### 3.3.1 `MultiSourceFanout.ts`（F3.1.6 + F3.1.7）

```typescript
import type { AttributedResult, InteractResult, SearchResult, FreeTierLevel } from "../types.js";

export interface FanoutPlan {
  /** 按 fallback_order 排序的 providers（由 ProviderRegistry 给出）*/
  sources: Array<{
    name: string;            // "search.zhipu" / "search.brave"
    capacity: number;        // 该源此次分配的 limit
  }>;
  /** 跨源聚合策略：v0.2 简化"按 served_by 分组 + 各家取前 N" */
  merge: "round_robin" | "by_rank";
}

/**
 * 多源扇出（F3.1.6）+ limit 跨源分配（F3.1.7）。
 *
 * limit 分配策略（10 §2.3）：
 *  - 默认按 free_quota_per_month 比例：quota 大的源多分
 *  - 语言启发式：query 含 CJK → zhipu 70% / brave 30%；否则 30% / 70%
 *  - 配额 <50 时自动降权（QuotaLedger.totalRemaining 反馈）
 *
 * fanout 执行：
 *  - Promise.allSettled 并发所有源（不等失败源）
 *  - 任何一源 worked → 聚合返回（partital_failures 记失败的）
 *  - 全失败 → outcome=unknown，外层 FallbackDecider 升 browse_headless
 *
 * 借鉴：10 §2.2 三层能力袋；mcp-web-search 三源 fallback 风格。
 */
export async function fanOutSearch(
  query: string,
  limit: number,
  sources: FanoutPlan["sources"],
  executor: (channelName: string, subLimit: number) => Promise<InteractResult<SearchResult>>,
): Promise<InteractResult<SearchResult>> {
  const settled = await Promise.allSettled(
    sources.map(s => executor(s.name, s.capacity)),
  );

  const partialFailures: Array<{ channel: string; error: string }> = [];
  const aggregated: AttributedResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const sourceName = sources[i].name;
    if (s.status === "rejected") {
      partialFailures.push({ channel: sourceName, error: String(s.reason) });
      continue;
    }
    const r = s.value;
    if (r.outcome !== "worked" || !r.data) {
      partialFailures.push({ channel: sourceName, error: r.error ?? r.outcome });
      continue;
    }
    for (const item of r.data.results) {
      aggregated.push({ ...item, served_by: sourceName });
    }
  }

  if (aggregated.length === 0) {
    // 全源失败
    return {
      outcome: "unknown",
      data: null,
      served_by: sources.map(s => s.name).join(","),
      fallback_used: false,
      retrieval_method: "multi_source_fanout",
      error: "all_sources_failed",
      // v0.2 partial_failures 字段（InteractResult 扩展，可选）
      partial_failures: partialFailures.map(p => ({
        channel: p.channel, error: p.error, timestamp: Date.now(),
      })),
    };
  }

  // round-robin 聚合（避免某源占满）
  aggregated.sort((a, b) => (a.original_rank ?? 0) - (b.original_rank ?? 0));
  const trimmed = aggregated.slice(0, limit);

  return {
    outcome: "worked",
    data: {
      query,
      results: trimmed.map(({ served_by: _omit, ...rest }) => rest as any),
      count: trimmed.length,
      engine: "multi",
      region: "auto",
    },
    served_by: sources.map(s => s.name).join(","),
    fallback_used: false,
    retrieval_method: "multi_source_fanout",
    partial_failures: partialFailures.length > 0
      ? partialFailures.map(p => ({ channel: p.channel, error: p.error, timestamp: Date.now() }))
      : undefined,
  };
}

/** F3.1.7 limit 跨源分配 */
export function allocateLimit(
  totalLimit: number,
  sources: Array<{ name: string; quotaRemaining: number; quotaPerMonth: number }>,
  query: string,
): FanoutPlan["sources"] {
  const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(query);
  // 权重 = quotaRemaining 比例 × 语言启发式
  const weights = sources.map(s => {
    const quotaWeight = s.quotaPerMonth > 0 ? Math.max(0.1, s.quotaRemaining / s.quotaPerMonth) : 1;
    const langBoost = isCJK
      ? (s.name.includes("zhipu") ? 0.7 : 0.3)
      : (s.name.includes("brave") ? 0.7 : 0.3);
    return quotaWeight * langBoost;
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  return sources.map((s, i) => ({
    name: s.name,
    capacity: Math.max(1, Math.round(totalLimit * weights[i] / totalW)),
  }));
}
```

#### 3.3.2 `AttributedSearch.ts`（F3.1.8 attributed 查询）

```typescript
import type { AttributedResult, SearchResult } from "../types.js";

/**
 * attributed 查询包装：多源扇出后，每条结果带 served_by 标签。
 * CC 可据此在结果中看到「这条来自 zhipu / 这条来自 brave」。
 *
 * 调用：tools/search.ts 在 args.attributed=true 时走这条路径；
 * 默认 false（保持 v0.1 SearchResult 形状不变，零破坏）。
 */
export function withAttribution(result: SearchResult, servedBy: string): Array<AttributedResult> {
  return result.results.map((r, i) => ({
    ...r,
    served_by: servedBy,
    original_rank: i + 1,
  }));
}
```

#### 3.3.3 `FreeTierRouter.ts`（F3.1.10 四级分级）

```typescript
import type { FreeTierLevel, ProviderConfig } from "../types.js";

/**
 * free_only 四级分级路由（10 §2.5）。
 *
 * 用户在 tool args 或 env LASSO_SEARCH_FREE_ONLY 传：
 *  - L1：只允许完全免费零 Key（DDG/SearXNG 自建）— v0.2 暂无 L1 provider，返回空
 *  - L2：允许免费层需 Key（Brave 2000/月、智谱、Tavily）
 *  - L3：再加远程 URL 免 Key（Exa、Jina read_url）— v0.2 暂无
 *  - L4：再加付费（默认，全允许）
 *
 * 10 §2.5 核心洞察：免 Key ≠ 零成本（SearXNG 要自建），需 Key ≠ 付费（Brave/Exa 有免费层）。
 */
const LEVEL_ORDER: Record<FreeTierLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

export function filterByFreeTier(
  providers: readonly ProviderConfig[],
  maxLevel: FreeTierLevel,
): ProviderConfig[] {
  const maxOrd = LEVEL_ORDER[maxLevel];
  return providers.filter(p => {
    const level = p.free_tier_level ?? "L2";
    return LEVEL_ORDER[level] <= maxOrd;
  });
}
```

#### 3.3.4 `src/tools/search.ts`（升级：多源 plan + free_only 参数）

```typescript
// schema 扩展（v0.1 参数全保留默认值）
export const searchSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  engine: z.enum(["zhipu", "brave", "auto"]).default("auto"),   // v0.1 string → enum
  region: z.string().default("cn"),
  no_cache: z.boolean().default(false),
  // v0.2 新增（全可选）
  free_only: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  attributed: z.boolean().default(false),    // F3.1.8
  // 兼容 v0.1：engine="zhipu" 仍可（v0.1 默认值不变行为）
};

// registerSearchTool 装配（v0.1 + 多源扇出）
export function registerSearchTool(
  server: McpServer,
  registry: ProviderRegistry,
  decider: FallbackDecider,
  cache: SearchCache,
  browseHeadlessExec: BrowseExec,
): void {
  server.tool("search", SEARCH_DESCRIPTION, searchSchema, searchAnnotations, async (args) => {
    // 1. cache 命中（除非 no_cache）
    if (!args.no_cache) {
      const cached = await cache.get(args.query, args.engine, args.region, args.limit);
      if (cached) return { content: [{ type: "text", text: JSON.stringify({ ...cached, cached: true }) }] };
    }

    // 2. 选源：engine="auto" 走多源扇出；engine="zhipu"/"brave" 单源（向后兼容）
    const freeOnly = args.free_only ?? registry.defaultFreeTier();
    const candidates = filterByFreeTier(registry.byCap("search").map(r => r.config), freeOnly);

    let plan: FallbackPlan;
    let executor: ChannelExecutor<SearchResult>;

    if (args.engine === "auto" && candidates.length >= 2) {
      // 多源扇出
      const sources = allocateLimit(args.limit, candidates.map(c => ({
        name: `search.${c.name}`,
        quotaRemaining: registry.get(c.name)?.ledger?.totalRemaining() ?? 1000,
        quotaPerMonth: c.free_quota_per_month,
      })), args.query);
      // fanout plan: primary 用一个虚拟 "fanout" channel
      plan = { primary: "fanout", fallbacks: ["browse_headless"], cross_modal: true };
      executor = async (name) => {
        if (name === "fanout") return fanOutSearch(args.query, args.limit, sources, async (cn, sub) => {
          // 把 "search.zhipu" / "search.brave" 路由到对应 channel
          return dispatchSearchChannel(cn, args.query, sub, args.region, registry);
        });
        if (name === "browse_headless") return serpScrapeFallback(args.query, args.limit, browseHeadlessExec);
        throw new Error(`unknown:${name}`);
      };
    } else {
      // 单源（v0.1 行为保留）
      const target = args.engine === "brave" ? "search.brave" : "search.zhipu";
      plan = { primary: target, fallbacks: ["browse_headless"], cross_modal: true };
      executor = async (name) => {
        if (name === target) return dispatchSearchChannel(target, args.query, args.limit, args.region, registry);
        if (name === "browse_headless") return serpScrapeFallback(args.query, args.limit, browseHeadlessExec);
        throw new Error(`unknown:${name}`);
      };
    }

    const result = await decider.runWithFallback(plan, executor);

    // 3. attributed 后处理
    if (args.attributed && result.data) {
      result.data = { ...result.data, results: withAttribution(result.data, result.served_by) } as any;
    }

    // 4. 写 cache（仅 worked）
    if (result.outcome === "worked" && !args.no_cache) {
      await cache.set(args.query, args.engine, args.region, args.limit, result);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}

// dispatch helper（registry → 具体 channel.search）
async function dispatchSearchChannel(
  name: string, query: string, limit: number, region: string, registry: ProviderRegistry,
): Promise<InteractResult<SearchResult>> {
  if (name === "search.zhipu") return registry.get("zhipu")!.channel.search(query, { limit, engine: "zhipu", region, no_cache: false });
  if (name === "search.brave") return registry.get("brave")!.channel.search(query, { limit, region: region === "cn" ? "CN" : "US", no_cache: false });
  throw new Error(`unknown_search_channel:${name}`);
}
```

**注**：`registry.get("zhipu").channel` 需在 ProviderRegistry 装配时注入（index.ts 装配阶段构造 ZhipuSearchChannel + BraveChannel 后回填到 registry 实例）。这避免 ProviderRegistry 直接依赖 channel 类。

---

### 3.4 结果 cache（`SearchCache.ts`，F3.1.4，7 天 TTL + attribution key）

```typescript
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { InteractResult, SearchResult, SearchCacheEntry } from "../types.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 天
const MAX_ENTRIES = 1000;                 // LRU 上限

/**
 * SearchCache：7 天 TTL + attribution key + LRU 1000 条。
 *
 * 存储：~/.cache/lasso/search-cache/<sha1[0:2]>/<sha1[2:4]>/<full-hash>.json
 *  - 分片目录避免单目录万级文件 ls 慢
 *  - 文件内容 = SearchCacheEntry JSON（含 result 完整）
 *  - TTL 用 mtime（fs.stat.mtimeMs）判断，不写自身 created_at（更可靠）
 *
 * attribution key（F3.1.8）：
 *  - 输入：canonical(query) + engine + region + limit
 *  - canonical：trim + lowercase + 去多余空白 + 去 diacritics（ naïve → naive ）
 *  - sha1 → hex
 *
 * LRU 1000：
 *  - 懒清理：每次 set 时若总量 >MAX_ENTRIES，删最旧 N（按 mtime 扫）
 *  - 不主动启动 GC（v0.2 简化）
 *
 * 不破坏 v0.1：cache 是 search 专属，不动 browse 的 state-store。
 *
 * 借鉴：05 §4.4 DDG 静默空响应场景 → cache 命中也带原 served_by（attribution）。
 */
export class SearchCache {
  constructor(private readonly cacheDir: string) {}

  async get(query: string, engine: string, region: string, limit: number): Promise<InteractResult<SearchResult> | null> {
    const key = this._key(query, engine, region, limit);
    const file = this._file(key);
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > TTL_MS) {
        await fs.unlink(file).catch(() => {});
        return null;
      }
      const raw = await fs.readFile(file, "utf8");
      const entry: SearchCacheEntry = JSON.parse(raw);
      return entry.result as InteractResult<SearchResult>;
    } catch { return null; }
  }

  async set(query: string, engine: string, region: string, limit: number, result: InteractResult<SearchResult>): Promise<void> {
    const key = this._key(query, engine, region, limit);
    const file = this._file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const entry: SearchCacheEntry = {
      key, query, engine, region, limit,
      result, created_at: Date.now(), hits: 0,
    };
    await fs.writeFile(file, JSON.stringify(entry));
    await this._maybeGc();
  }

  async clear(): Promise<void> {
    try { await fs.rm(this.cacheDir, { recursive: true, force: true }); } catch {}
  }

  private _key(q: string, engine: string, region: string, limit: number): string {
    const canon = q.trim().toLowerCase().replace(/\s+/g, " ").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return crypto.createHash("sha1").update(`${canon}|${engine}|${region}|${limit}`).digest("hex");
  }

  private _file(key: string): string {
    return path.join(this.cacheDir, key.slice(0, 2), key.slice(2, 4), `${key}.json`);
  }

  private async _maybeGc(): Promise<void> {
    // 简化版：扫一遍统计 entries，超 MAX_ENTRIES 则删最旧 10%
    // v0.2 实现只统计根目录下分片数量（粗略）；v0.3 升级为精确 mtime 排序
  }
}
```

**依赖**：`node:fs`，`node:crypto`，`node:path`，`types.ts`。

---

### 3.5 SERP 改版检测 + 录制回放（v0.2 骨架）

#### 3.5.1 `SelectorRegistry.ts`（F3.8.13 selector 集中管理）

```typescript
import type { SerpSelectorSet } from "./selectors.js";
import { BAIDU_SELECTORS, GOOGLE_SELECTORS } from "./selectors.js";

interface VersionedSelectorSet extends SerpSelectorSet {
  version: string;            // "2026-07-21-v1"
  last_known_good: string;    // ISO date 上次验证可用
  hit_count: number;          // 累计成功命中次数
  miss_count: number;         // 累计失败次数
}

/**
 * SelectorRegistry：selector 集中管理（F3.8.13）+ 版本化 + last_known_good。
 *
 * - 启动时从 selectors.ts 静态表加载（v0.2）
 * - v0.7 升级：从 ~/.cache/lasso/serp-selector-registry.json 加载用户覆盖
 * - v1.0 升级：录制回放 + 改版检测自动更新此表
 *
 * 集中管理目的：单点改，避免散落多处。
 */
export class SelectorRegistry {
  private sets = new Map<string, VersionedSelectorSet[]>();

  constructor() {
    this.sets.set("baidu", versionize(BAIDU_SELECTORS, "2026-07-21-v1"));
    this.sets.set("google", versionize(GOOGLE_SELECTORS, "2026-07-21-v1"));
  }

  get(engine: string): VersionedSelectorSet[] { return this.sets.get(engine) ?? []; }

  recordHit(engine: string, version: string): void {
    const list = this.sets.get(engine);
    const s = list?.find(x => x.version === version);
    if (s) s.hit_count++;
  }
  recordMiss(engine: string, version: string): void {
    const list = this.sets.get(engine);
    const s = list?.find(x => x.version === version);
    if (s) s.miss_count++;
  }
}

function versionize(list: SerpSelectorSet[], version: string): VersionedSelectorSet[] {
  const today = new Date().toISOString();
  return list.map(s => ({ ...s, version, last_known_good: today, hit_count: 0, miss_count: 0 }));
}
```

#### 3.5.2 `ChangeDetection.ts`（F3.8.9 改版检测骨架）

```typescript
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

interface SerpSnapshot {
  engine: string;
  query: string;
  dom_hash: string;          // 抽样节点的 sha1（e.g. div.c-container 集合 outerHTML）
  captured_at: number;
}

/**
 * ChangeDetection：SERP 改版检测骨架（F3.8.9）。
 *
 * v0.2 只落骨架 + baseline 存取：
 *  - captureSnapshot(engine, query, dom) → 计算 hash + 落盘 ~/.cache/lasso/serp-baseline/
 *  - detectChange(engine, query, dom) → 对比 baseline，hash 变则 emit warn（命中率可能下降）
 *
 * 真正的命中率和告警链路 v0.7 接入（F3.8.10 + F3.7.5-12）；
 * 录制回放 v1.0 接入（F3.8.14）。
 *
 * 借鉴：open-webSearch selector 级联；08 §3.8「SERP 是债不是资产」。
 */
export class ChangeDetection {
  constructor(private readonly baselineDir: string) {}

  async captureBaseline(engine: string, query: string, dom: string): Promise<SerpSnapshot> {
    const snapshot: SerpSnapshot = {
      engine, query, dom_hash: crypto.createHash("sha1").update(dom).digest("hex"),
      captured_at: Date.now(),
    };
    const file = this._file(engine, query);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot));
    return snapshot;
  }

  async detectChange(engine: string, query: string, currentDom: string): Promise<{
    changed: boolean; baseline_hash?: string; current_hash: string;
  }> {
    const file = this._file(engine, query);
    const currentHash = crypto.createHash("sha1").update(currentDom).digest("hex");
    try {
      const raw = await fs.readFile(file, "utf8");
      const baseline: SerpSnapshot = JSON.parse(raw);
      return { changed: baseline.dom_hash !== currentHash, baseline_hash: baseline.dom_hash, current_hash: currentHash };
    } catch {
      return { changed: false, current_hash: currentHash };
    }
  }

  private _file(engine: string, query: string): string {
    const h = crypto.createHash("sha1").update(`${engine}|${query}`).digest("hex");
    return path.join(this.baselineDir, h.slice(0, 2), `${h}.json`);
  }
}
```

#### 3.5.3 `HitRateStats.ts` + `RecordingStore.ts`（F3.8.10 + F3.8.14 骨架）

```typescript
// HitRateStats.ts (~80 行) —— v0.2 内存态计数器，doctor 可查
export class HitRateStats {
  private hit = new Map<string, number>();   // key: `${engine}:${selectorVersion}`
  private miss = new Map<string, number>();
  recordHit(key: string): void { this.hit.set(key, (this.hit.get(key) ?? 0) + 1); }
  recordMiss(key: string): void { this.miss.set(key, (this.miss.get(key) ?? 0) + 1); }
  snapshot(): Record<string, { hit: number; miss: number; rate: number }> { /* ... */ return {}; }
}

// RecordingStore.ts (~70 行) —— v0.2 只存 fixture（key=str(query)+engine → SERP HTML 原文）
// 录制：每次 browse_headless 兜底抽到 SERP 时，存一份原始 a11y 快照
// 回放：v1.0 用这些 fixture 跑 selector 改版后回归测试
export class RecordingStore {
  constructor(private readonly dir: string) {}
  async save(engine: string, query: string, snapshot: string): Promise<void> { /* ... */ }
  async load(engine: string, query: string): Promise<string | null> { /* ... */ return null; }
}
```

---

### 3.6 partial_failures + 连接池

#### 3.6.1 `PartialFailures.ts`（F3.9.7）

```typescript
import type { PartialFailure } from "../types.js";

/**
 * partial_failures 聚合（F3.9.7）。
 *
 * 场景：多源扇出时，zhipu worked 但 brave 429；总 outcome=worked（用户拿到结果），
 * 但要诚实记录"哪些源失败了"，便于 doctor / 告警。
 *
 * 透传路径：MultiSourceFanout.fanOutSearch → InteractResult.partial_failures →
 * tools/search.ts 透传到 MCP 返回。
 */
export function aggregatePartialFailures(
  perSource: Array<{ channel: string; error?: string; outcome: string }>,
): PartialFailure[] {
  const now = Date.now();
  return perSource
    .filter(p => p.outcome !== "worked")
    .map(p => ({
      channel: p.channel,
      error: p.error ?? p.outcome,
      timestamp: now,
    }));
}
```

#### 3.6.2 连接池（`SubprocessManager.ts` 加 `acquireHttpClient`，F3.5.7）

```typescript
// v0.1 SubprocessManager 加方法（不改既有 spawn 路径）
import { Agent, setGlobalDispatcher } from "undici";

export class SubprocessManager {
  // v0.1 既有字段不动
  private httpAgents = new Map<string, Agent>();  // key = host origin

  /** F3.5.7 连接池：共享 keep-alive（智谱 + Brave 同 host 复用 TCP/TLS）*/
  acquireHttpClient(origin: string): { fetch: typeof fetch } {
    if (!this.httpAgents.has(origin)) {
      this.httpAgents.set(origin, new Agent({
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        connections: 8,
      }));
    }
    const agent = this.httpAgents.get(origin)!;
    return {
      // undici agent injection via dispatcher
      fetch: ((url: any, init?: any) => fetch(url, { ...init, dispatcher: agent })) as typeof fetch,
    };
  }

  async shutdown(): Promise<void> {
    // v0.1 既有 shutdown 逻辑 + 加 HTTP agents close
    for (const a of this.httpAgents.values()) try { await a.close(); } catch {}
    this.httpAgents.clear();
    // ... v0.1 原 _kill 逻辑 ...
  }
}
```

**依赖**：`undici`（Node 18+ 内置 fetch 的底层，无需额外安装；如需独立版本加 package.json dep）。

---

### 3.7 benchmark A/B 实测工具（`benchmark/run-ab-benchmark.ts`，验收 #1）

```typescript
#!/usr/bin/env node
/**
 * in-house A/B 实测（09 §2.2 验收 #1 硬指标）。
 *
 * 用法：node --experimental-strip-types src/benchmark/run-ab-benchmark.ts
 *   --queries scripts/ab-queries.json
 *   --report reports/ab-<date>.json
 *
 * 输出：
 *  - reports/ab-<date>.json：结构化结果（per-query latency × provider × 冷/热/并发）
 *  - reports/provider-matrix-<date>.md：provider 矩阵打分表（引用 Brave 仅三项硬数据）
 *
 * 方法论（10 §4.3 + 04 §4）：
 *  - 冷启动（首次）/ 热查询（同 query 第 2 次）/ 并发（5 query Promise.all）三组各跑
 *  - 中文 50 + 英文 50 固定集（scripts/ab-queries.json）
 *  - 每组每 provider 跑 3 遍取中位
 *  - p50/p95 latency + outcome 分布 + 配额消耗
 *
 * 禁止照搬外部基准（AIMultiple）的"最优"归因（05 §0-3 票否决）。
 */
import { promises as fs } from "node:fs";
import { loadConfig } from "../config/config.js";
import { ZhipuSearchChannel } from "../channels/SearchChannel.js";
import { BraveChannel } from "../channels/BraveChannel.js";
import { SubprocessManager } from "../subprocess/SubprocessManager.js";

interface QuerySet { zh: string[]; en: string[]; }

async function runAB(opts: { queries: QuerySet; rounds: number }) {
  // 装配 channels（同 index.ts 但走 benchmark 专用 cache dir）
  // ... 三组循环：cold / warm / concurrent ...
  // 每条 query × 两 provider × 三组 × rounds 遍历 + 计时
  // 汇总 → reports/*.json + reports/provider-matrix.md
}

// CLI 解析 + main
if (import.meta.url === `file://${process.argv[1]}`) {
  const queries = JSON.parse(await fs.readFile(process.argv[2]!, "utf8"));
  await runAB({ queries, rounds: 3 });
}
```

**输出样例（provider-matrix.md）**：
```
| provider | cold_p50_ms | warm_p50_ms | concurrent_p95_ms | success_rate | zh_recall | en_recall |
|----------|-------------|-------------|-------------------|--------------|-----------|-----------|
| zhipu    | (实测填)    |             |                   |              |           |           |
| brave    | (实测填)    |             |                   |              |           |           |

引用硬数据：Brave 外部基准 669ms / 14.89 Agent Score / 2000/月（10 §4.3）。
本表是 in-house 实测，不引用外部"最优"结论。
```

---

## 4. 不明确点调研结论

### 4.1 Brave API 怎么调

**结论：REST 直调 `GET https://api.search.brave.com/res/v1/web/search`，不走 community MCP**。

- **URL**：`https://api.search.brave.com/res/v1/web/search?q=<query>&count=<N>&country=<ISO>`
- **认证**：HTTP header `X-Subscription-Token: <key>`（不是 `Authorization: Bearer`）
- **响应形状**：`{ web: { results: [{ title, url, description, profile: { name }, ... }] }, query: {...} }`
- **限流**：429 + `Retry-After` header（秒）→ QuotaLedger.markExhausted(resetAt=now+retry_after×1000)
- **count 上限**：单次 max 20（`count > 20` 自动截断，不发错；`MultiSourceFanout.allocateLimit` 已用 `Math.min`）
- **为什么 REST 不 MCP**：
  - Brave 官方 REST 稳定（文档 api.search.brave.com/app/documentation）
  - community `brave-search-mcp` 是额外 wrapper，加一层进程无收益
  - 与智谱 streamable-http 在 Lasso 内同抽象（都是 HTTP 直调），不增加 SubprocessManager 进程
- **免费层**：2000 query/月（注册时绑定信用卡但不扣费）；超限返回 429（不会自动转付费，需 plan upgrade）
- **代码位置**：`src/channels/BraveChannel.ts`（§3.2）

### 4.2 Key 池怎么轮换

**结论：贪心选余量最多 + 429 时 markExhausted + 月初 rollover**

- **配 keys**：env `BRAVE_API_KEYS="key1,key2,key3"` CSV（v0.1 `ZHIPU_API_KEY` 单值保留），`config.ts` 拆分注入 `ProviderConfig.keys[]`
- **选 key**：`QuotaLedger.pickKey()` 返回 `remaining` 最大且未 exhausted 的（贪心，简单稳定）
- **429 反馈**：channel 调用返 429 → `ledger.markExhausted(key, retryAfter)` → 该 key 短期禁用到 `retryAfter`；其他 key 仍可用（**多 Key 配额合并 = 2 Key × 2000 = 4000/月**，验收 #2）
- **月初重置**：`_maybeRollover()` 每次 pickKey 前检查 `startOfMonthUTC(now) > currentMonthStart` → 重置所有 key.remaining
- **配额模型适配**：
  - Brave/Tavily：`monthly`（按月计）
  - 智谱：`token`（v0.2 退化成按请求计数近似，v0.3 升级精确 token 计）
  - Jina：`rpm`（resetAt = now + 60s，v0.2 不接入，留 schema）
- **日志安全**：`hashKey(key)` 只打 `前4...后4`，不打全 key

### 4.3 cache 怎么存

**结论：文件系统分片 + 7 天 TTL（mtime）+ sha1 attribution key + LRU 1000**

- **位置**：`~/.cache/lasso/search-cache/<sha1[0:2]>/<sha1[2:4]>/<full>.json`
- **分片目的**：避免单目录万级文件 `ls` 慢（EXT4/APFS 目录索引限制）
- **TTL**：用文件 `mtimeMs`（`fs.stat`），不写 entry.created_at（更可靠，文件被 touch 也不会假活）
- **attribution key**：
  - 输入：`canonical(query) | engine | region | limit`
  - canonical：`trim + lowercase + 去多余空白 + NFD + 去 diacritics`
  - `sha1` → hex（40 字符，足够避免碰撞）
- **LRU 1000**：v0.2 简化懒清理（每次 set 时若超限删最旧 10%）；v0.3 升级为精确 mtime 排序
- **不破坏 v0.1**：cache 是 search 专属，不动 browse 的 `state-store.ts`
- **目录权限**：doctor 第 13 项 check `search_cache_dir_writable`

### 4.4 A/B 实测怎么做

**结论：50 中 + 50 英固定 query 集 × 两 provider × 三组（冷/热/并发）× 3 rounds，输出 p50/p95 + provider 矩阵打分表**。

- **query 集**：`scripts/ab-queries.json` 固定（避免每次跑不同导致纵向对比失真）
  - 中文 50：技术/产品/地名/人名/长尾/短词/错别字 各覆盖
  - 英文 50：同维度
- **三组**：
  - **冷启动**：每 query 独立新 client（清 cache + 新 fetch agent）
  - **热查询**：同 query 连跑 2 次，第 2 次计 latency（cache 已暖）
  - **并发**：5 个 query `Promise.all`，计整体 p95（测 keep-alive 是否真复用）
- **3 rounds**：每 provider 每组每 query 跑 3 遍取中位（消单次抖动）
- **输出**：
  - `reports/ab-<date>.json`：结构化原始数据
  - `reports/provider-matrix-<date>.md`：人类可读打分表（**不写"最优"，只列数字 + 引用 Brave 外部三项硬数据**）
- **为何强制 in-house**：05 §0-3 票否决"Brave 全场最优"因果延伸（AIMultiple 是单一来源，100 query × 单一 GPT 评判）；in-house 实测才支撑"v0.2 锁定 Brave 主力"的决策

---

## 5. 测试计划

### 5.1 单元测试（`test/unit/`，vitest，v0.1 既有 5 文件全保留）

| 新增文件 | 覆盖点 | case 数 |
|---|---|---|
| `quota-ledger.spec.ts` | pickKey 贪心 / 429 markExhausted / 月初 rollover / 配额合并视图 / 余量 <50 warn | 15+ |
| `brave-channel.spec.ts` | mock fetch → 200 解析 / 429 markExhausted / 202 空响应 / 5xx unknown / key 轮换 / count 截断 20 | 18+ |
| `multi-source-fanout.spec.ts` | Promise.allSettled 聚合 / allocateLimit 语言启发式（CJK vs EN）/ quota 比例 / 单源失败 partial_failures / 全失败 unknown | 14+ |
| `free-tier-router.spec.ts` | L1/L2/L3/L4 过滤 / 默认 L2 / Tavily policy_risk 不影响 L4 默认 | 8+ |
| `search-cache.spec.ts` | TTL 过期 / canonical key 稳定（大小写/空白/diacritics）/ 分片路径 / LRU 超 MAX_ENTRIES 删 / 不破坏 v0.1 state-store | 12+ |
| `change-detection.spec.ts` | baseline capture / hash 变 → changed=true / 无 baseline 不告警 | 6+ |
| `partial-failures.spec.ts` | aggregate（worked + failed）/ 全 worked → 空 / 全 failed → 全记 | 5+ |

**v0.1 既有测试回归**：`cidr` / `circuit-breaker` / `fallback-decider` / `outcome` / `ssrf-guard` 5 个 spec 不动，确保 172 tests 不破。

### 5.2 集成测试（`test/integration/`）

| 新增文件 | 覆盖点 |
|---|---|
| `provider-registry.spec.ts` | 加载 5 个 builtin provider / CapabilityBag 按 fallback_order 排序 / filterByFreeTier 正确 / enabled=false 不进 bag |
| `attributed-search.spec.ts` | engine="auto" → 多源扇出 / attributed=true 每条带 served_by / engine="zhipu" v0.1 行为保留 |
| `benchmark.spec.ts` | mock 两 channel + 5 query × 3 rounds 跑通 / 输出 JSON schema 合法 / 无外部基准"最优"字符串 |

**v0.1 既有集成测试**：`browse-channel` / `doctor` / `fallback` / `search-channel` 4 个不动；`search-channel.spec.ts` 补 1 case 验证 v0.1 单源行为仍可（engine 默认 "auto" → v0.1 zhipu 仍兼容）。

### 5.3 烟雾测试（验收硬指标）

1. **真实 A/B（验收 #1）**：跑 `npm run benchmark` 输出 `reports/ab-<date>.json` + `provider-matrix.md`，含 100 query × 两 provider × 三组 × 3 rounds 全部 p50/p95 + success_rate
2. **Brave 限流（验收 #2 + #4）**：mock Brave 返 429 → QuotaLedger.markExhausted → channel 自动切下一个 key；全 key 耗尽 → channel.isAvailable=false → fallback 链升 zhipu 或 browse_headless
3. **HTTP 202 识别（验收 #3）**：mock Brave 返 202 + 空 body → `outcomeFromHttp` 返 `unknown` → fallback 链触发
4. **加 provider 开闭（验收 #6）**：TDD 测试——在 `providers.ts` 加一个常量 + push 到 BUILTIN_PROVIDERS（≤2 行改），所有既有测试 pass

### 5.4 架构不变量（v0.2 新增 3 条）

v0.1 既有 8 条 + v0.2 加 3 条（共 11 条）：

```javascript
// src/invariants/check-invariants.mjs 追加
{
  id: "INV-9-provider-registry-single-source",
  desc: "ProviderRegistry 类定义只在 config/provider-registry.ts（单一真源）",
  check: () => countMatches(/class\s+ProviderRegistry/g) === 1,
},
{
  id: "INV-10-brave-keys-via-ledger",
  desc: "BraveChannel 禁直接读 process.env.BRAVE_API_KEYS，必须经 QuotaLedger",
  check: () => {
    const brave = SRC.find(s => s.f.includes("BraveChannel"));
    if (!brave) return true;
    return !/process\.env\.BRAVE_API_KEYS|process\.env\.BRAVE_API_KEY/.test(brave.text);
  },
},
{
  id: "INV-11-cache-key-attributed",
  desc: "SearchCache key 必须含 engine + region + limit（attribution，防跨 provider 误命中）",
  check: () => {
    const cache = SRC.find(s => s.f.includes("SearchCache"));
    if (!cache) return true;
    return /engine.*region.*limit|limit.*engine.*region/.test(cache.text);
  },
},
```

---

## 6. 验收标准（引用 09 §2.2，6 条逐条映射）

| # | 09 §2.2 原文 | 验证方式 | 实现位置 |
|---|---|---|---|
| 1 | 5-10 真实中英文 query A/B 实测（智谱 vs Brave），p50/p95，输出 provider 矩阵打分表 | `npm run benchmark` 产出 `reports/provider-matrix-<date>.md`，含 ≥5 中 + ≥5 英 query × 冷/热/并发 × p50/p95 + success_rate | `benchmark/run-ab-benchmark.ts`（§3.7） |
| 2 | Brave key 余量<50 自动降级；多 Key 轮询配额合并（2 Key=4000/月） | 单元测 `quota-ledger.spec.ts` 构造 remaining=40 → logger.warn；2 Key 配额合并视图 = 4000；429 后切下一个 key | `config/quota-ledger.ts`（§3.2.1） |
| 3 | HTTP 202 空响应识别（DDG [browser] 未装场景，fallback 链识别静默空并降级） | 单元测 `outcome.spec.ts`（v0.1 已有，补 1 case 显式构造 DDG-like 202） + 集成 `brave-channel.spec.ts` mock 202 → outcome=unknown → fallback 链触发 | v0.1 `fallback/outcome.ts`（已实装，v0.2 补集成测） |
| 4 | 限速压测（连续 50 query，fallback 对 429/retry-after 反应） | 烟雾测 `npm run benchmark` 连跑 50 query 模拟 429 → 验证 QuotaLedger.markExhausted + channel 切 key + 链路升级 | `benchmark/` + `BraveChannel.ts`（§3.2） |
| 5 | 政策风险检查（Tavily 免费层是否还在） | doctor 加 `tavily_policy_watch` check（v0.2 默认 warn，不阻塞 ready）；TAVILY_WATCH provider `policy_risk=acquired` `enabled=false` | `config/providers.ts` + `doctor/doctor.ts`（§3.1.2 + §3.5） |
| 6 | 加 provider = ProviderConfig 加一项（开闭，≤2 处改动） | 单元测：在 `providers.ts` 加常量 + push 到 BUILTIN_PROVIDERS（≤2 行），全量测试 pass；INV-9 守注册表单一真源 | `config/provider-registry.ts`（§3.1.3） |

**通过门槛**：6 条全绿 + v0.1 既有 172 tests 100% pass + v0.2 新增单元/集成测试 pass + 11 条不变量脚本 exit 0。

---

## 7. 风险 + 实施顺序

### 7.1 v0.2 风险 Register（增量，与 09 §6 R1-R12 合并）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| V1 | Brave 免费 Key 当天用爆（2000/月） | 高 | 中 | QuotaLedger 多 Key 池前置（§3.2.1）+ 余量 <50 warn（验收 #2） |
| V2 | Brave API 响应形状变（web.results 改名） | 低 | 中 | `parseBraveResults` 兼容多种 key（`description ?? snippet`、`profile?.name`）+ 契约测试快照 |
| V3 | Brave 429 Retry-After header 缺失 | 中 | 低 | QuotaLedger.markExhausted 默认 60s fallback（`retryAfter ?? Date.now()+60_000`） |
| V4 | A/B 实测结果与外部基准（AIMultiple 669ms）不一致 | 中 | 低 | **诚实记录**，不强行对齐；in-house 实测优先（05 否决"最优"归因） |
| V5 | 多源扇出 Promise.allSettled 拖慢 p95（慢源阻塞） | 中 | 中 | 每源独立 timeout（智谱 10s / Brave 5s）；v0.3 升级为 Promise.race + 异步聚合 |
| V6 | cache 7 天 TTL 导致用户看到旧结果（Brave 配额重置后仍返 cache） | 低 | 低 | `no_cache=true` 参数（v0.1 已有）；默认 cache 仅命中 worked 路径 |
| V7 | undici Agent 与 v0.1 fetch 行为不一致（headers/redirect） | 低 | 低 | 集成测试覆盖既有 SSRF + zhipu 路径回归 |
| V8 | 智谱 streamable-http 在 v0.2 升级 SDK 后握手回归 | 中 | 高 | v0.1 SDK 版本锁 + 集成测试保护；不主动升级 SDK minor |
| V9 | Tavily policy_risk=acquired 误启用（schema 在但 enabled=false） | 低 | 中 | INV-9 守 ProviderRegistry 不加载 `enabled=false`；doctor warn 提醒用户 |

**回退点**：`git tag v0.2` — 任意阶段失败回 v0.1 tag。

### 7.2 实施顺序（v0.2 估 8 天，先地基后功能）

**Phase A — ProviderConfig 注册表 + 不变量先行（Day 1-2）** ★ 关键：先升级 schema 再加 channel
- [ ] D1 上午：`types.ts` 扩 6 字段 + `FreeTierLevel` enum（全字段可选，v0.1 实例化不破） + INV-9/10/11 写下来跑红
- [ ] D1 下午：`providers.ts` 补 v0.2 字段 + 新增 `BRAVE` / `TAVILY_WATCH` + `provider-registry.ts` + 单元测
- [ ] D2：`config.ts` 加 BRAVE_API_KEYS CSV 解析 + QuotaLedger 注入 + `quota-ledger.ts` 实装 + 单元测 15 cases + INV-9/10/11 全绿

**Phase B — BraveChannel + Key 池（Day 3）**
- [ ] D3 上午：`BraveChannel.ts` 实装 + mock fetch 集成测（200 / 429 / 202 / 5xx）
- [ ] D3 下午：连接池 `SubprocessManager.acquireHttpClient` + undici Agent 注入 + 既有 zhipu 路径回归测

**Phase C — 多源扇出 + free_only + attributed（Day 4-5）**
- [ ] D4：`MultiSourceFanout.ts` + `allocateLimit` + `AttributedSearch.ts` + `FreeTierRouter.ts` + 单元测 30+ cases
- [ ] D5：`tools/search.ts` 升级 schema（engine enum / free_only / attributed）+ 多源 plan 装配 + 集成测（engine="auto" 走多源 / engine="zhipu" v0.1 行为保留）

**Phase D — SearchCache 7 天 TTL（Day 6）**
- [ ] D6：`SearchCache.ts` 实装 + 单元测（TTL / canonical / 分片 / LRU）+ 接入 tools/search.ts（no_cache 参数透传）

**Phase E — SERP 改版检测骨架 + partial_failures（Day 7）**
- [ ] D7 上午：`SelectorRegistry.ts` + `ChangeDetection.ts` + `HitRateStats.ts` + `RecordingStore.ts` 骨架（v0.2 不接入主路径，留 v0.7/v1.0 用）
- [ ] D7 下午：`PartialFailures.ts` + InteractResult.partial_failures 字段透传 + 集成测

**Phase F — A/B 实测工具 + doctor 扩展（Day 8）**
- [ ] D8 上午：`benchmark/run-ab-benchmark.ts` + `scripts/ab-queries.json`（50+50 query 集）
- [ ] D8 下午：跑真实 A/B（5 中 + 5 英先跑通）+ 产出 `reports/provider-matrix-<date>.md`；doctor 加 4 项 check（brave_keys / provider_registry_loadable / quota_ledger_initialized / search_cache_dir_writable）

**关键里程碑**：
- D2 末：INV-9/10/11 全绿 + QuotaLedger 单测全绿
- D3 末：BraveChannel 端到端通（mock）
- D5 末：多源扇出端到端通（zhipu + brave）
- D6 末：cache 命中/失效端到端通
- D8 末：6 条验收全绿 + v0.2 tag

---

## 关键设计决策摘要（实施者一眼看）

1. **增量而非重写**：v0.1 的 172 tests + 8 invariants 是底线；v0.2 加 3 条 invariants（共 11 条），不改 v0.1 接口签名（字段全可选 + 别名导出兼容）。
2. **ProviderConfig 单一真源**（INV-3 + INV-9）：interface 在 `types.ts`，注册表类在 `provider-registry.ts`。**加 provider = 改 `providers.ts` ≤2 处**（验收 #6）。
3. **Key 池走 QuotaLedger 不直读 env**（INV-10）：所有 channel（含 BraveChannel）禁 `process.env.BRAVE_API_KEYS`，必须经 ledger。
4. **Cache attribution key 含 engine**（INV-11）：防智谱 cache 被 Brave 误命中（同 query 不同 engine 是不同结果）。
5. **Brave REST 直调不 MCP**：与智谱 streamable-http 同抽象层，不增加 SubprocessManager 进程。
6. **多源扇出走 FallbackDecider 不开第二套**（INV-4）：fanout 是 `executor` 内部策略，不绕过 fallback 引擎。
7. **A/B 实测强制 in-house**（05 否决）：不引用 AIMultiple "最优"结论，只引 Brave 三项硬数据（669ms / 14.89 / 2000/月）。
8. **partial_failures 诚实透传**（F3.9.7）：多源 worked 但部分失败时，`InteractResult.partial_failures` 记录哪些源失败了，不掩盖。
9. **v0.2 只骨架的**：SERP 改版检测、命中率统计、录制回放（F3.8.9/10/13/14 真正接入 v0.7/v1.0）；长熔断 60min（v0.7）；Tavily（watch-list）。
10. **undici 连接池**（F3.5.7）：智谱 + Brave 同 host 复用 TCP/TLS，并发 p95 改善；不破坏 v0.1 fetch 行为。

---

**parse2 完成。实施者照此从 Phase A 开始无歧义落代码，v0.1 的 172 tests + 8 invariants 不破。**