# Selector 债维护手册

> Lasso 的 SERP selector 是**债**，不是资产。本文档说明 selector 的生命周期 + 改版检测 + 升级流程。
>
> 设计原则见 [08 §3.8 F3.8.1-8](../../doc/08-media-interact-功能架构.md)；实施排期见 [09 §2.7 v0.7 SerpHealthMonitor](../../doc/09-media-interact-实施排期.md)。

## 1. 为什么说 selector 是债

主路径走结构化 API（智谱 / Brave / Bing）；selector 只是 search → browse_headless 跨模态 fallback 时的**兜底抽链**。上游搜索引擎改 HTML 结构时，selector 就会失效——这是**必然会发生的债**（10 §D.1）。

Lasso 不把 selector 当核心竞争力，而是**显式承认它是债 + 自动检测改版 + CI 守门**。

## 2. selector 的三层防护

### 2.1 主备级联（运行时，v0.1+）

`src/serp/selectors.ts` 每引擎导出 `SerpSelectorSet[]`，主 → 备级联。命中失败时按顺序降级到下一条：

```ts
export const BAIDU_SELECTORS: SerpSelectorSet[] = [
  { /* 主：div.c-container */ },
  { /* 备 1：div.result */ },
  { /* 备 2：宽松正则 */ },
];
```

### 2.2 运行时命中率告警（v0.7+）

`SerpHealthMonitor`（`src/serp/SerpHealthMonitor.ts`）监控每引擎命中率：
- `SelectorRegistry`：版本化 selector 集 + `last_known_good` 日期
- `HitRateStats`：运行时命中率（key = `${engine}:${selectorVersion}`）
- `ChangeDetection`：dom hash 对比（detectChange）

命中率 <50% 且样本 ≥5 → 异步触发 `ChangeDetection.detectChange`（dom_hash 比对，降误报）→ 告警。

### 2.3 CI 录制回放回归（v1.0+）

`npm run replay-baseline`（`src/serp/replay-baseline.ts`）：跑 `fixtures/serp-baseline/` 下历史录制 → 用当前 selectors.ts 抽 → 比对录制时的 expected count。

- 命中率 ≥80% → `pass`
- 50-80% → `warn`（selector 可能开始退化）
- <50% → `fail`（strict 模式 CI 红）

## 3. CI 基线 fixtures 结构

```
fixtures/serp-baseline/
├── README.md                       —— 录制说明
├── baidu/
│   ├── claude-code-mcp.html        —— 录制的原始 SERP HTML
│   ├── claude-code-mcp.json        —— expected 抽取结果（含 source_channel 字段）
│   ├── rust-async-runtime.html
│   └── rust-async-runtime.json
├── bing/
│   └── ...
└── google/
    └── ...
```

**INV-62 守**：每条 fixture 的 `source_channel` 字段禁为 `logged_in`（必须 `search` / `browse_headless` / undefined；cookie=身份红线，CI 基线禁录 logged_in 场景）。

## 4. 加新 selector（流程）

### 4.1 发现命中率下跌

`SerpHealthMonitor` 告警 / `replay-baseline --strict` 失败 / 用户报 issue。优先级：
1. `replay-baseline` fail（CI 红）→ 立即修
2. 运行时命中率 <50% → 24h 内修
3. 命中率 50-80% warn → 排入下个迭代

### 4.2 调研新 selector

```bash
# 本机开 Chrome，访问目标 SERP，F12 看新 HTML 结构
# 例如百度改版把 div.c-container 换成 div.result-card
```

记下新结构 → 写候选 selector。

### 4.3 修 selectors.ts

```ts
// src/serp/selectors.ts
export const BAIDU_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "baidu",
    result_container: "div.result-card",   // ★ 新主 selector
    title: "h3",
    link: "h3 a",
    snippet: "div.c-abstract",
  },
  {
    engine: "baidu",
    result_container: "div.c-container",   // ★ 旧主降为备（保后向兼容）
    title: "h3",
    link: "h3 a",
    snippet: "div.c-abstract",
  },
  // ... 其他备
];
```

**保后向兼容**：旧主 selector 不要删，降为备。某些用户/区域可能仍看到旧版页面。

### 4.4 重新录制基线（可选，推荐）

```bash
# 1. 设录制 env
export LASSO_RECORD_SEARCH=true

# 2. 跑 search（会落盘新基线到 ~/.cache/lasso/recordings/）
# 用 Lasso 跑几个真实 query

# 3. 手动把新录制拷到 fixtures/serp-baseline/<engine>/
# （或写脚本批量转；保持脱敏：用 "rust async" 等通用 query，不用用户真 query）

# 4. 关录制
unset LASSO_RECORD_SEARCH
```

**INV-57 守**：录制必须显式 opt-in（`LASSO_RECORD_SEARCH=true`）；默认 OFF。

### 4.5 跑 replay-baseline 验证

```bash
npm run replay-baseline -- --strict
```

期望：所有 fixture 命中率 ≥80%（pass）。如仍有 fail → 检查 selector 是否覆盖足够变体。

### 4.6 跑全量测试

```bash
npm run build
npm test
npm run check-invariants   # 65/65
```

零回归才能合 PR。

## 5. selector 改版检测流程（CI 化）

### 5.1 当前 CI 流程

GitHub Actions workflow 跑：
1. `npm run build`
2. `npm test`
3. `npm run check-invariants`（65 条）
4. `npm run replay-baseline`（非 strict，warn 不阻塞）

**为何不 strict**：selector 是债不是 bug。命中率 50-80% 时 CI 黄灯（warn），不阻塞合并；但 <50% 时 strict 模式会 fail。

### 5.2 升级到 strict（推荐）

如果团队希望 selector 改版**强阻塞**：

```bash
# CI yaml
- run: npm run replay-baseline -- --strict
```

strict 模式下任一 fixture fail（<50%）→ CI 红 → 阻塞合并。

## 6. 加新引擎 selector（如 DuckDuckGo）

### 6.1 扩 selectors.ts

```ts
// src/serp/selectors.ts
export type SerpEngine = "baidu" | "google" | "duckduckgo";   // ★ 加

export const DUCKDUCKGO_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "duckduckgo",
    result_container: "div.result",
    title: "h2",
    link: "h2 a",
    snippet: "div.snippet",
  },
];
```

### 6.2 加 extract.ts 分支

`src/serp/extract.ts` 的 `extractSerp(html, engine)` switch 加 `case "duckduckgo"`。

### 6.3 录制基线

```bash
export LASSO_RECORD_SEARCH=true
# 跑 duckduckgo search × 10 query
# 拷到 fixtures/serp-baseline/duckduckgo/
unset LASSO_RECORD_SEARCH
```

### 6.4 更新 INV-62 sidecar schema

新 fixture 的 `source_channel` 字段必须为 `search` / `browse_headless` / undefined（INV-62 grep 守；不能为 `logged_in`）。

### 6.5 跑测试

```bash
npm run replay-baseline -- --strict
npm run check-invariants   # 确认 INV-62 仍绿
```

## 7. selector 维护原则

1. **SERP 是债不是资产**：不把 selector 当核心竞争力；主路径走结构化 API。
2. **保后向兼容**：旧主 selector 降为备，不删（某些用户/区域仍看旧版）。
3. **脱敏 query**：fixtures 录制用通用 query（如 "rust async"），不用用户真 query（PII 风险）。
4. **禁录 logged_in**：INV-62 守；CI 基线只录 search + browse_headless。
5. **改版检测 CI 化**：`replay-baseline` 在 CI 跑；strict 模式可选（强阻塞）。
6. **selector 版本化**：`SelectorRegistry` 记 `last_known_good`；改版时升版本号。

## 8. 调试技巧

### 8.1 看某 fixture 抽出啥

```bash
# 直接用 extract.ts API
node -e '
  import("./dist/serp/extract.js").then(({ extractSerp }) => {
    const fs = require("fs");
    const html = fs.readFileSync("fixtures/serp-baseline/baidu/rust-async-runtime.html", "utf8");
    const json = JSON.parse(fs.readFileSync("fixtures/serp-baseline/baidu/rust-async-runtime.json", "utf8"));
    const actual = extractSerp(html, "baidu");
    console.log("expected:", json.expected_count);
    console.log("actual:", actual.entries.length);
    console.log("hit_rate:", actual.entries.length / json.expected_count);
  });
'
```

### 8.2 看运行时命中率

```bash
# Lasso 运行时
admin({ action: "channel_health" })
# 返回各引擎 SelectorRegistry.last_known_good + HitRateStats 命中率
```

### 8.3 故意改坏 selector 验 CI

```bash
# 临时把 BAIDU_SELECTORS 主 selector 改成 "div.not-exist"
# 跑 npm run replay-baseline -- --strict
# 期望：fail（命中率 <50%）
```

这是验证 CI 真的能抓到 selector 改版的标准操作。

## 9. 相关文档

- [README.md](../README.md) — 用户手册（故障排查节）
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — error_kind 释义（含 `recording_replay_miss`）
- [ARCHITECTURE.md](../ARCHITECTURE.md) — 架构概览（含 fallback 链）
- [doc/08 功能架构 §3.8](../../doc/08-media-interact-功能架构.md) — SERP 抽取设计（F3.8.1-8）
- [doc/09 实施排期 §2.7](../../doc/09-media-interact-实施排期.md) — v0.7 SerpHealthMonitor 设计决策
