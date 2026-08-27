# Lasso v1.1 功能分析师 parse12 —— MarkdownExtractor（文件/函数级执行计划）

> 上游：[14 §0 TL;DR + §4.1 借鉴分析 + §7 落地建议](../14-AI爬虫调研与借鉴分析.md) + [08 §3.2 browse extract + §3.5 fetch_url](../08-media-interact-功能架构.md) + [架构想法/01 §3 抽象纪律 + 02 §5 R-CI-02 / §6.3 review 三问](../../架构想法/02_简单检查清单.md)。
> v1.0 基线：**65 invariants + 103 TS 源文件 + 33 Rust 文件 + package.json v1.0.0-rc.1**（零回归承诺；新 INV 编号 ≥66；v1.0 的 65 条 INV 一行不改）。
> **用户硬约束（最高优先级）**：MarkdownExtractor **必须是模式感知（mode-aware）**——raw 默认保 v1.0 行为 byte-identical，markdown / markdown_cited 是 opt-in。**用户明确纠正 doc/14「默认 markdown」建议为「默认 raw」**：保留网页元素原始结构有独立语义价值，不能强制对所有 extract 结果做 AI 适配优化，要留空间。
> 简单性守门：raw 默认最小 surprise（02 §6.3 review 三问 #1）；MarkdownExtractor 是 BrowseChannel/fetch_url 的内部子组件不是新通道（R-CI-02）；引擎禁引第三运行时（Node + Rust 已两套，Python 是第三套，守 01 §3.4 有害象限）。
> 引擎选型（smoke-test-first 已完成）：**JS 原生 defuddle + turndown**（非 doc/14 推荐的 Trafilatura Python 子进程）。理由见 §4 决策表。

---

## 1. v1.1 目标与范围（v1.0 增量）

### 1.1 能力跃升（14 §0 + §7.2）

**v1.0（已交付）**：稳定发布——四通道全量测试 + 跨平台 desktop 契约 + 录制回放回归 + README/ARCHITECTURE 文档完整化 + version 1.0.0。

**v1.1（本 parse）**：补 doc/14 §0 识别的「唯一硬缺口」——**LLM 友好抽取**。当前 `browse extract` / `fetch_url` 抓回原始 HTML / a11y 文本树直接喂下游，token 浪费 30-70%（14 §0 观察B）。v1.1 引入 **MarkdownExtractor**（mode-aware 子组件）：用户显式 opt-in `extract_mode="markdown"` 时把原始 HTML 精炼为干净 markdown（去导航/广告/样板，留正文 + 结构化标题/列表/链接）；`extract_mode="markdown_cited"` 时再追加 Crawl4AI ⟨N⟩ 引用角标（RAG 上下文预算优化）；**不传 = raw = v1.0 行为 byte-identical 零回归**。

### 1.2 范围矩阵（做 / 不做）

| 维度 | 做（v1.1） | 不做（推迟 / NO-GO） |
|---|---|---|
| **MarkdownExtractor 子组件** | 新 `src/browse/markdown-extractor.ts`（~180 行）；mode-aware 三档：raw passthrough / markdown 精炼 / markdown_cited 引用；纯函数 `extractMarkdown(html, mode, opts)` | ❌ 新增第三通道 / 新 server.tool（守 R-CI-02：是内部子组件）；❌ 经 FallbackDecider（不走 fallback 链） |
| **raw 默认零回归** | `extract_mode` 字段未传或 `"raw"` → BrowseChannel doExtract / fetch_url doFetchUrl 行为 byte-identical v1.0；**硬验收**：既有测试集零改 + INV-66 守 | ❌ 改变 v1.0 默认输出（用户硬约束：raw 保「保留网页元素」语义）；❌ 任何 fetch_url 默认走 markdown（doc/14 §7.3 说「默认 markdown」被用户推翻） |
| **markdown 档引擎** | **defuddle v0.19.1**（MIT，近零 dep）做内容抽取 → **turndown v7.2.4**（MIT，deps @mixmark-io/domino 轻量 DOM）做 HTML→markdown；smoke-test 验可用 | ❌ Trafilatura Python 子进程（守 R-CI-02：第三运行时）；❌ jsdom（~10MB 重，除非 defuddle smoke-test 失败才回退 Readability+jsdom）；❌ Firecrawl/Skyvern（AGPL-3.0 不可依赖） |
| **browse extract markdown 路径** | doExtract 在 `extract_mode=markdown` 时改走 `evaluate_script` 取 `document.documentElement.outerHTML`（渲染后 HTML）→ MarkdownExtractor；raw 档仍走 `take_snapshot`（a11y 文本树，v1.0 不动） | ❌ 改 take_snapshot 上游契约（raw 档 byte-identical）；❌ screenshot 走 markdown（screenshot 是 PNG 二进制，不经 extractor） |
| **fetch_url markdown 路径** | doFetchUrl 在 route.kind=html 且 extract_mode=markdown 时把 bodyText 过 MarkdownExtractor；非 html（json/text/binary）忽略 extract_mode（文档化） | ❌ 对 json/binary 强行走 markdown（语义错）；❌ 改 redirect/max_bytes/SSRF 路径（raw 档 byte-identical） |
| **markdown_cited 引用角标** | Crawl4AI `convert_links_to_citations` 算法 reimplement（~50 行 TS：URL 正则 + Map 去重 + 末尾 References 段）；默认 off；仅 markdown_cited 档触发 | ❌ 引 Crawl4AI 依赖（只借鉴算法，Apache-2.0 允许 reimplement）；❌ Pruning/BM25 内容过滤（推迟 v1.2，doc/14 §4.2c 标 1.2；~200 行 port 负担） |
| **bounded output 协同** | markdown 精炼后内容更短 → applyOutputEnvelope 48KiB 触发率下降（利好）；markdown_cited 的 References 段同过 envelope | ❌ 改 48KiB 上限（markdown 是压缩，不改 bounded output 契约） |
| **doctor 探测** | 加 #33 markdown_extractor_engine（defuddle/turndown 版本 + 是否 loadable）+ #34 markdown_smoke（最后一次 smoke-test 时间戳，可选） | ❌ Trafilatura 检测（不引 Trafilatura，14 §7.3 的 doctor Trafilatura 项作废） |
| **OutlineNode maxDepth / interactiveOnly** | ❌ 不做（doc/14 §4.2d 标 1.2，与 MarkdownExtractor 解耦） | 推迟 v1.2（Lightpanda-inspired，独立增量） |

### 1.3 三模式语义钉死（用户硬约束落地）

```
extract_mode 字段（BrowseOptions + FetchUrlOptions 新增，optional，默认 undefined = "raw"）

┌─────────────────┬───────────────────────────────────┬──────────────────────────────┐
│ 模式            │ 行为                              │ 用户语义                     │
├─────────────────┼───────────────────────────────────┼──────────────────────────────┤
│ "raw" (默认)    │ BrowseChannel.doExtract:          │ "我要网页元素原始结构"       │
│ 未传 = raw      │   take_snapshot → a11y 文本树     │ （DOM/元素/结构化信息）       │
│                 │ fetch_url.doFetchUrl:             │ v1.0 行为 byte-identical     │
│                 │   原始 HTML/JSON/text 字节        │ （零回归硬验收）             │
├─────────────────┼───────────────────────────────────┼──────────────────────────────┤
│ "markdown"      │ 取渲染后 HTML → defundle 抽正文   │ "给 LLM 吃，省 token"        │
│ (opt-in)        │ → turndown 转 markdown            │ 去导航/广告/样板，留正文     │
│                 │ → applyOutputEnvelope             │ + 结构化标题/列表/链接       │
├─────────────────┼───────────────────────────────────┼──────────────────────────────┤
│ "markdown_cited"│ markdown + ⟨N⟩ 引用角标           │ "RAG 优化，省上下文预算"     │
│ (opt-in)        │ + 末尾去重 References 段          │ inline URL → ⟨1⟩⟨2⟩ 角标     │
│                 │ → applyOutputEnvelope             │ + [1] url / [2] url 汇总     │
└─────────────────┴───────────────────────────────────┴──────────────────────────────┘
```

**铁律**：`extract_mode` 未传 = `undefined` = `"raw"` = v1.0 行为。schema 用 `.optional()` 不 `.default("raw")`（防 zod 自动注入导致 byte-identical 断言失真；undefined vs "raw" 在代码里等价但测试能区分「字段不存在」vs「字段显式传 raw」）。

### 1.4 量化目标（验收锚点）

- v1.1 收尾 TS 行数 ≈ **v1.0 基线 + ~280 行**（markdown-extractor.ts ~180 + content-filter-cite.ts ~50 + doctor 扩 ~30 + INV 脚本 ~120 行 .mjs 不计 TS）
- 新增 npm dependencies：**defuddle ^0.19.1 + turndown ^7.2.4**（2 个，均 MIT；守 R-CI-02 不引 AGPL/Python；@mixmark-io/domino 是 turndown 传递依赖自动装入）
- INV 总数 **65 → 69**（加 INV-66..69 共 4 条，全部 v1.1 新加，不重写 v1.0 INV-1..65）
- CI 闸门：`npm run check-invariants` 报 **69 条全绿**；`npm test` v1.0 测试集零回归 + 新增 ~25 测试（markdown 质量 + citation + 三模式切换 + raw byte-identical）
- doctor 32 → 34 项（加 #33 markdown_extractor_engine / #34 markdown_smoke）
- npm 发布 `lasso-mcp@1.1.0`（v1.0 稳定后增量）

---

## 2. 文件结构（lasso/src/ 改动；零回归 v1.0；rust-helper 不动）

### 2.1 新增文件（lasso/src/，2 个；总 ~230 行 TS）

```
src/browse/
├── markdown-extractor.ts        ★ 新（~180 行）mode-aware 抽取器主模块（INV-66/67/68 守）
└── content-filter-cite.ts       ★ 新（~50 行）markdown_cited 档的 ⟨N⟩ 引用角标 reimplement
```

### 2.2 修改文件（lasso/src/，增量改动，v1.0 raw 路径零差异）

| 文件 | 改动要点 | 行数增量 |
|---|---|---|
| `src/types.ts` | `BrowseOptions` 加 `extract_mode?: "raw" \| "markdown" \| "markdown_cited"`（optional，无 default）；`FetchUrlOptions` 同字段；新增 `MarkdownExtractResult` interface（{ markdown, title?, byline?, citations? }）；**不改任何既有字段** | +~25 |
| `src/channels/BrowseChannel.ts` | `doExtract` handler 加 mode 分流：raw/undefined → 现有 take_snapshot 路径（零改）；markdown/markdown_cited → 改走 evaluate_script 取 outerHTML → markdown-extractor.ts extractMarkdown(html, mode)；**actionDispatch Map 不加新 entry**（extract 仍是同一 entry，mode 是 options 字段） | +~35 |
| `src/tools/fetch-url.ts` | `doFetchUrl` 在 route.kind=html 且 opts.extract_mode=markdown/markdown_cited 时把 bodyText 过 extractMarkdown；json/text/binary 路径忽略 extract_mode（文档化「非 html 不走 markdown」）；raw/undefined byte-identical v1.0 | +~20 |
| `src/tools/fetch-url.ts` schema | `fetchUrlSchema.options` 加 `extract_mode: z.enum(["raw","markdown","markdown_cited"]).optional()` | +~3 |
| `src/tools/browse.ts` | `browseHeadlessSchema` / `browseLoggedInSchema` 的 options 加同 extract_mode 字段（zod optional） | +~6 |
| `src/tools/descriptions.ts` | FETCH_URL_DESCRIPTION + BROWSE_HEADLESS_DESCRIPTION 加 1-2 行 extract_mode 说明（WHEN raw / WHEN markdown / WHEN markdown_cited） | +~12 |
| `src/doctor/doctor.ts` | 加 #33 markdown_extractor_engine（defuddle/turndown 版本 + require 尝试）+ #34 markdown_smoke（最后一次 smoke-test 时间戳，从 ~/.cache/lasso/markdown-smoke.json 读，可选 warn） | +~40 |
| `src/invariants/check-invariants.mjs` | 加 INV-66..69 共 4 条新 INV（不改 v1.0 INV-1..65） | +~120（.mjs 不计 TS 行数） |
| `package.json` | `version: "1.0.0-rc.1"` → `"1.1.0"`；dependencies 加 `defuddle: "^0.19.1"` + `turndown: "^7.2.4"` | +~4 |

**总增量**：新增 ~230 行 TS + 修改 ~145 行 TS + 120 行 INV 脚本 ≈ **~375 行 TS + 120 行 .mjs**（落 §1.4 估算窗口内）。

**rust-helper/ 零改动**（引擎选型是 JS 原生，Rust helper 不参与 markdown 抽取；这是 JS 原生方案的核心收益之一）。

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 MarkdownExtractor 主模块（`src/browse/markdown-extractor.ts`，~180 行）

```typescript
/**
 * MarkdownExtractor（parse12 §3.1 v1.1 新增）
 *
 * mode-aware HTML→markdown 抽取器。BrowseChannel doExtract + fetch_url doFetchUrl
 * 的内部子组件（INV-67：不是新通道，不 extends BaseChannel，不经 FallbackDecider）。
 *
 * 三档（用户硬约束：raw 默认保 v1.0，markdown opt-in）：
 *  - "raw"            : passthrough（调用方根本不进本模块；本模块只处理 markdown*）
 *  - "markdown"       : defuddle 抽正文 HTML → turndown 转 markdown
 *  - "markdown_cited" : markdown + ⟨N⟩ 引用角标（content-filter-cite.ts）
 *
 * 引擎选型（parse12 §4 决策表）：JS 原生 defuddle + turndown，非 Trafilatura Python。
 * 守 R-CI-02：禁 spawn/exec python；引擎必须是 JS require/import 可加载（INV-68）。
 *
 * 借鉴源：
 *  - defuddle（MIT，FiveFilters）内容抽取 — 替代 Mozilla Readability（避 jsdom 重依赖）
 *  - turndown v7.2.4（MIT，@mixmark-io/domino 轻量 DOM）HTML→markdown
 *  - Crawl4AI markdown_generation_strategy.py L155-280（fit_markdown 思路，Apache-2.0 借鉴算法不 vendored）
 *  - 08 §3.2 BrowseOptions 对象化范式（extract_mode 是 options 字段，非新 action）
 */
import { extractContent } from "defuddle";
import TurndownService from "turndown";
import { applyCitations, type CitationResult } from "./content-filter-cite.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export type ExtractMode = "raw" | "markdown" | "markdown_cited";

export interface MarkdownExtractOptions {
  mode: ExtractMode;
  /** turndown 配置：heading style / bullet list marker / code block style */
  headingStyle?: "atx" | "setext";       // 默认 "atx"（# 风格，LLM 友好）
  bulletMarker?: "-" | "*" | "+";         // 默认 "-"
  /** markdown_cited 档：是否启用 ⟨N⟩ 角标（默认 true；false = 仅 markdown 不加角标） */
  enableCitations?: boolean;
}

export interface MarkdownExtractResult {
  markdown: string;
  title?: string;
  byline?: string;        // 作者（defuddle 抽出，若有）
  excerpt?: string;       // 摘要（defuddle 抽出）
  /** 仅 markdown_cited 档填：[{ n: 1, url: "..." }, ...] 去重引用表 */
  citations?: CitationResult[];
  /** 引擎实际服务的 extractor 名（"defuddle+turndown" / fallback "turndown-only"） */
  served_by: string;
}

// ============================================================
// 顶级 const（INV-68 衍生：引擎名集中，doctor 读）
// ============================================================
export const MARKDOWN_ENGINE = Object.freeze({
  extractor: "defuddle",       // 内容抽取器（替代 Readability，避 jsdom）
  converter: "turndown",       // HTML→markdown 转换器
  pipeline: "defuddle+turndown",
});

// ============================================================
// 主 API：extractMarkdown（纯函数，无副作用，可单测）
// ============================================================
/**
 * @param html    原始 HTML 字符串（fetch_url bodyText / browse evaluate_script outerHTML）
 * @param opts    模式 + 配置（mode 必传；调用方保证非 "raw"——raw 档调用方根本不调本函数）
 * @returns       MarkdownExtractResult（markdown + 元数据 + 可选 citations）
 *
 * 失败容忍（守 raw 默认零回归 + 不阻断主路径）：
 *  - defuddle 抽取失败 → 降级 turndown-only（served_by="turndown-only"，跳过正文抽取直接转全页 HTML）
 *  - turndown 失败 → 抛 Error("[markdown-extractor]") 前缀，调用方 catch 后 outcome=unknown
 *    （BrowseChannel.browse classifyBrowseError 不识别此前缀 → unknown；fetch_url 同）
 */
export async function extractMarkdown(
  html: string,
  opts: MarkdownExtractOptions,
): Promise<MarkdownExtractResult> {
  if (!html || html.length === 0) {
    return { markdown: "", served_by: MARKDOWN_ENGINE.pipeline };
  }

  // ---------- 1. defuddle 抽正文 HTML（去导航/广告/样板） ----------
  let articleHtml: string | null = null;
  let title: string | undefined;
  let byline: string | undefined;
  let excerpt: string | undefined;

  try {
    // defuddle extractContent 接 (html, url) 返 { content, title, author, description, ... }
    // url 传空串（defuddle 内部用于相对链接解析；空串容忍）
    const result = await extractContent(html, { url: "" });
    if (result && result.content) {
      articleHtml = result.content;
      title = result.title ?? undefined;
      byline = result.author ?? undefined;
      excerpt = result.description ?? undefined;
    }
  } catch (e) {
    // defuddle 失败 → 降级 turndown-only（served_by 标记降级；不阻断）
    logger.warn({ evt: "defuddle_failed", error: String(e).slice(0, 200) });
    articleHtml = null;
  }

  // ---------- 2. turndown HTML→markdown ----------
  const turndown = new TurndownService({
    headingStyle: opts.headingStyle ?? "atx",
    bulletListMarker: opts.bulletMarker ?? "-",
    codeBlockStyle: "fenced",
  });

  const inputHtml = articleHtml ?? html;  // defuddle 失败时降级转全页
  const servedBy = articleHtml
    ? MARKDOWN_ENGINE.pipeline
    : "turndown-only";

  let markdown: string;
  try {
    markdown = turndown.turndown(inputHtml);
  } catch (e) {
    // turndown 失败 = 引擎彻底挂，抛错让调用方走 outcome=unknown
    throw new Error(`[markdown-extractor] turndown failed: ${String(e).slice(0, 200)}`);
  }

  // ---------- 3. markdown_cited 档：⟨N⟩ 引用角标 ----------
  let citations: CitationResult[] | undefined;
  if (opts.mode === "markdown_cited" && opts.enableCitations !== false) {
    const cited = applyCitations(markdown);
    markdown = cited.markdown;
    citations = cited.citations;
  }

  return {
    markdown,
    title,
    byline,
    excerpt,
    ...(citations ? { citations } : {}),
    served_by: servedBy,
  };
}

// ============================================================
// helper：smoke-test 入口（doctor #34 + CI 可调）
// ============================================================
/**
 * 对固定 fixture HTML 跑一次 extractMarkdown，验引擎可用。
 * doctor #33/#34 调；CI 可选跑（不阻断，warn-only）。
 * @returns { ok: boolean, engine: string, elapsed_ms: number, markdown_preview: string }
 */
export async function smokeTestMarkdownEngine(): Promise<{
  ok: boolean;
  engine: string;
  elapsed_ms: number;
  markdown_preview: string;
}> {
  const fixture = `<html><head><title>Test</title></head><body>` +
    `<nav>nav junk</nav><article><h1>Hello</h1><p>World <a href="https://example.com">link</a></p></article>` +
    `<footer>footer junk</footer></body></html>`;
  const t0 = Date.now();
  try {
    const r = await extractMarkdown(fixture, { mode: "markdown" });
    return {
      ok: r.markdown.length > 0 && r.markdown.includes("Hello"),
      engine: r.served_by,
      elapsed_ms: Date.now() - t0,
      markdown_preview: r.markdown.slice(0, 200),
    };
  } catch {
    return { ok: false, engine: "failed", elapsed_ms: Date.now() - t0, markdown_preview: "" };
  }
}
```

**行数估算**：~180 行（含注释 + 类型 + smoke-test helper）。

### 3.2 引擎选型落地（JS 原生 defuddle + turndown，非 Trafilatura）

**决策已定**（见 §4 决策表），本节给落地伪码 + smoke-test 验证步骤。

**依赖装入**（package.json）：
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ip-cidr": "^4.0.2",
    "undici": "^7.28.0",
    "uuid": "^11.0.0",
    "zod": "^3.25.0",
    "defuddle": "^0.19.1",
    "turndown": "^7.2.4"
  }
}
```

**smoke-test-first 验证清单**（实施前必跑，落 doctor #33）：
1. `npm install defuddle turndown` 成功，无 native 编译（纯 JS）
2. `node -e "const {extractContent}=require('defuddle'); extractContent('<html><body><article>hi</article></body></html>',{url:''}).then(r=>console.log(r.content))"` 输出非空 HTML
3. `node -e "const T=require('turndown'); console.log(new T().turndown('<h1>Hi</h1><p>there</p>'))"` 输出 `# Hi\n\nthere`
4. defuddle 对中文/日文页面（Lasso cn 场景）能抽正文（验多语言）
5. defuddle 抽取失败时 turndown 单独跑不炸（降级路径验）
6. 三者 license 核：defuddle MIT / turndown MIT / @mixmark-io/domino MIT（npm view 已验，见 parse12 §4）

**若 defuddle smoke-test 失败的回退路径**（文档化，不在 v1.1 MVP 实装）：
- 回退 1：Mozilla Readability（Apache-2.0）+ jsdom（MIT，~10MB 重）—— 仍 JS 原生，仍守 INV-68（禁 Python）
- 回退 2：@postlight/parser（MIT，all-in-one，含 metadata）
- **永不回退**：Trafilatura Python 子进程（守 R-CI-02 第三运行时红线）

### 3.3 接入点（BrowseChannel extract + fetch_url；extract_mode 字段穿线）

#### 3.3.1 BrowseChannel.doExtract 改造（raw 路径 byte-identical v1.0）

```typescript
// src/channels/BrowseChannel.ts —— doExtract 改造（parse12 §3.3.1）
//
// 铁律：extract_mode 未传 / "raw" → 完全走 v1.0 take_snapshot 路径（byte-identical）。
//       INV-66 守：raw 档不调 extractMarkdown / 不 import markdown-extractor。

async function doExtract(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // ---------- mode 分流（v1.1 新增；raw 档零改 v1.0） ----------
  const mode = opts.extract_mode;  // undefined | "raw" | "markdown" | "markdown_cited"
  if (mode === undefined || mode === "raw") {
    // v1.0 路径 byte-identical：take_snapshot → a11y 文本树
    const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
    const { title, text } = extractSnapshot(r);
    return { title, preview: text };
  }

  // ---------- markdown / markdown_cited 档（v1.1 新增） ----------
  // 取渲染后 HTML（evaluate_script 注入 document.documentElement.outerHTML）
  const expr = `(function(){
    try {
      return JSON.stringify({
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title || ""
      });
    } catch(e) { return JSON.stringify({ html: "", url: "", title: "" }); }
  })()`;
  const r = (await c.callTool("evaluate_script", { function: expr })) as EvaluateResult;
  const parsed = JSON.parse(extractEvalPreview(r) || "{}") as {
    html: string; url: string; title: string;
  };

  if (!parsed.html) {
    // 取 HTML 失败 → 抛错走 outcome=unknown（BrowseChannel.browse catch）
    throw new Error("[markdown-extractor] evaluate_script returned empty html");
  }

  // 调 MarkdownExtractor（dynamic import 防 raw 档也加载引擎；守 INV-66 raw 零回归）
  const { extractMarkdown } = await import("./markdown-extractor.js");
  const result = await extractMarkdown(parsed.html, {
    mode,
    headingStyle: "atx",
    bulletMarker: "-",
    enableCitations: mode === "markdown_cited",
  });

  return {
    title: result.title ?? parsed.title ?? undefined,
    preview: result.markdown,  // markdown 内容作 preview（后续 BrowseChannel.browse 过 truncatePreview）
    // markdown 专属元数据（v1.1 扩展；raw 档不填，v1.0 调用方不读）
    ...(result.byline ? { byline: result.byline } : {}),
    ...(result.citations ? { citations: result.citations } : {}),
    ...(result.served_by ? { markdown_engine: result.served_by } : {}),
  };
}
```

**关键设计**：`extractMarkdown` 用 **dynamic `import()`** 而非 top-level import。原因：raw 档（默认）调用 doExtract 时，Node 不会加载 defuddle/turndown 模块（lazy load），保 raw 路径零依赖开销 + INV-66 断言更干净（grep raw 路径代码本体无 markdown-extractor 引用）。

#### 3.3.2 fetch_url.doFetchUrl 改造（raw 路径 byte-identical v1.0）

```typescript
// src/tools/fetch-url.ts —— doFetchUrl markdown 分流（parse12 §3.3.2）
//
// 铁律：extract_mode 未传 / "raw" / route.kind 非 html → v1.0 路径 byte-identical。
//       仅 route.kind === "html" 且 mode === markdown/markdown_cited 才进 MarkdownExtractor。

// ...（v1.0 的步骤 1-5 SSRF + 连接池 + 请求 + content-type 分流不变）...

// ---------- 6. 按 route 解码 + applyOutputEnvelope ----------
let bodyText: string;
let bodyKind: string;
if (route.kind === "binary") {
  bodyText = Buffer.from(bodyBuf).toString("base64");
  bodyKind = `binary:${route.subtype ?? "octet-stream"}`;
} else if (route.kind === "json") {
  bodyText = new TextDecoder("utf-8").decode(bodyBuf);
  bodyKind = "json";
} else {
  bodyText = new TextDecoder("utf-8").decode(bodyBuf);
  bodyKind = route.kind;  // "html" | "text"
}

// ---------- 6b. v1.1 新增：html + markdown mode → MarkdownExtractor ----------
const mode = opts.extract_mode;
if (route.kind === "html" && (mode === "markdown" || mode === "markdown_cited")) {
  const { extractMarkdown } = await import("../browse/markdown-extractor.js");
  const md = await extractMarkdown(bodyText, {
    mode,
    headingStyle: "atx",
    bulletMarker: "-",
    enableCitations: mode === "markdown_cited",
  });
  bodyText = md.markdown;
  bodyKind = `markdown:${md.served_by}`;  // "markdown:defuddle+turndown" / "markdown:turndown-only"
  // markdown_cited 的 citations 进 FetchUrlResult（v1.1 扩展字段）
  // （result envelope 后续装配时挂 data.citations）
}

// ---------- 7. applyOutputEnvelope（v1.0 不变；markdown 更短利好） ----------
const envelope = applyOutputEnvelope(bodyText, /* v1.0 hint 不变 */);
```

**fetch_url schema 扩展**（`fetchUrlSchema.options`）：
```typescript
extract_mode: z.enum(["raw", "markdown", "markdown_cited"]).optional(),
// 不 .default("raw") —— 防 zod 自动注入；undefined 在 doFetchUrl 内等价 raw
```

### 3.4 citation ⟨N⟩ + Pruning（markdown_cited 档；reimplement ~50 行）

**v1.1 范围**：仅 ⟨N⟩ 引用角标（~50 行 TS reimplement）。**Pruning/BM25 内容过滤推迟 v1.2**（doc/14 §4.2c 标 1.2；~200 行 port 负担；v1.1 守简单性不扩范围）。

```typescript
// src/browse/content-filter-cite.ts（parse12 §3.4 v1.1 新增，~50 行）
/**
 * ⟨N⟩ 引用角标（Crawl4AI convert_links_to_citations reimplement）。
 *
 * 借鉴源：Crawl4AI markdown_generation_strategy.py（Apache-2.0，算法借鉴不 vendored）。
 * 守 INV-69：不 import crawl4ai 依赖（Python 包不可作 JS 依赖）；纯 TS reimplement。
 *
 * 算法：
 *  1. 扫 markdown 中所有 [text](url) 形式的 inline 链接
 *  2. URL 去重（Map<url, n>），首次出现分配 ⟨N⟩ 角标
 *  3. 替换 inline 链接为 `text ⟨N⟩`（保留链接文字，去 URL）
 *  4. 末尾追加 `\n\n## References\n[1] url\n[2] url\n...`
 *
 * 不做（推迟 v1.2）：
 *  - PruningContentFilter（DOM 节点 text-density 评分，~200 行 port）
 *  - BM25ContentFilter（BM25 相似度过滤，~100 行 port）
 *  - LLMExtractionStrategy（结构化抽取，上层职责）
 */

export interface CitationResult {
  n: number;       // 角标编号（1-based）
  url: string;
}

// markdown inline link 正则：[text](url)  —— url 不含空格/括号
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

export function applyCitations(markdown: string): {
  markdown: string;
  citations: CitationResult[];
} {
  const urlToN = new Map<string, number>();
  const citations: CitationResult[] = [];
  let nextN = 1;

  const transformed = markdown.replace(MD_LINK_RE, (full, text: string, url: string) => {
    let n = urlToN.get(url);
    if (n === undefined) {
      n = nextN++;
      urlToN.set(url, n);
      citations.push({ n, url });
    }
    // 保留链接文字 + 追加 ⟨N⟩ 角标（去 URL 本体）
    return `${text} ⟨${n}⟩`;
  });

  // 末尾 References 段（仅当有 citation 时）
  if (citations.length === 0) {
    return { markdown: transformed, citations: [] };
  }

  const refs = citations
    .map((c) => `[${c.n}] ${c.url}`)
    .join("\n");
  return {
    markdown: `${transformed}\n\n## References\n${refs}\n`,
    citations,
  };
}
```

**行数估算**：~50 行（含注释 + 类型 + 正则 + 测试 helper）。

**不做 Pruning 的决策理由（satisficing，01 §4.5）**：
- doc/14 §4.2(c) 明确标 Pruning 为 1.2 档（「Pruning 算法本身复杂，TS port 有维护负担」）
- v1.1 markdown 档的 defuddle 已经做了 boilerplate 去除（导航/广告/样板），Pruning 是叠加的二次过滤，边际收益递减
- 守简单性（02 §6.3 review 三问 #3）：不在 v1.1 引入「是否过度过滤」的调参负担；用户若需更强过滤走 v1.2 opt-in

---

## 4. 不明确点调研结论

### 4.1 引擎选型决策表（Readability+turndown vs Trafilatura Python 子进程 vs defuddle）

| 维度 | (a) Trafilatura Python 子进程 | (b) Readability + turndown + jsdom | (c) **defuddle + turndown（选定）** |
|---|---|---|---|
| **抽取质量** | 🟢 最佳（doc/14「事实最优解」；CleanEval/L3S-GN1 benchmark 领先） | 🟢 良好（Firefox Reader View 引擎，千亿级用户验证；非文章页略弱） | 🟢 良好（defuddle 五件套算法，定位 Readability 升级替代；2025 活跃迭代） |
| **依赖体积** | 🔴 ~3MB Python runtime + lxml + trafilatura（重） | 🟡 jsdom ~10MB（重，含完整 DOM API）+ readability 0 dep + turndown domino 轻量 | 🟢 defuddle 近零 dep（仅 commander CLI 可 tree-shake）+ turndown domino 轻量（~200KB） |
| **运行时数** | 🔴 **+1 Python runtime**（Node + Rust + Python = 3 套；违 R-CI-02） | 🟢 纯 JS/Node（与既有 stack 一致） | 🟢 纯 JS/Node |
| **跨平台** | 🔴 Windows lxml 编译踩坑（14 §8.1 R13） | 🟢 纯 JS，零 native 编译 | 🟢 纯 JS，零 native 编译 |
| **维护活跃** | 🟡 作者呼吁赞助（14 §8.1 R15）；1.8+ Apache-2.0 商业友好 | 🟡 turndown 原 author 交接 mixmark-io，更新放缓；Readability Mozilla 维护稳定 | 🟢 defuddle 0.19.1（2025），FiveFilters 团队维护，活跃 |
| **license** | 🟢 Apache-2.0 | 🟢 Apache-2.0 (readability) + MIT (turndown/jsdom) | 🟢 MIT (defuddle) + MIT (turndown) |
| **子进程开销** | 🔴 spawn python + stdin/stdout JSON-lines（类比 Rust helper，但 Python 冷启动 ~200ms） | 🟢 同步函数调用，零 IPC | 🟢 同步函数调用，零 IPC |
| **与 Lasso 架构契合** | 🔴 违 R-CI-02（第三运行时）；违 01 §3.4 有害象限（高依赖×高变更） | 🟡 jsdom 重，但守 R-CI-02 | 🟢 完美契合：内部子组件，无新运行时，无新 IPC |
| **doc/14 推荐** | doc/14 §4.1(a) 推荐 | doc/14 §4.1(a) 提及「纯 TS 简化版」 | doc/14 未单独评估（defuddle 是 2024+ 新项目） |

**决策：(c) defuddle + turndown（JS 原生）**。

**核心理由**（按优先级）：
1. **R-CI-02 红线**（02 §5.5）：Lasso 已有 Node + Rust 两套运行时；加 Python 是第三套，直接撞「横切关注点变体 > 1 种」红线。doc/14 §4.1(a) 推荐 Trafilatura 时未充分权衡此点（doc/14 §8.3 open question #1 自己也建议「v1.1 MVP 先走 TS 简化版」）。
2. **简单性 satisficing**（01 §4.5）：defuddle 质量虽略低于 Trafilatura（非文章页差距），但对「喂 LLM 省 token」这个目标已足够——LLM 不需要完美抽取，需要的是去噪音后的干净文本。边际质量差距不抵第三运行时的架构成本。
3. **jsdom 规避**：选 defuddle 而非 Readability 的关键理由——defuddle 近零 dep，Readability 在 Node.js 需 jsdom（~10MB，重）。守 02 §3 R-DEP-02 模块深度（不引浅模块重依赖）。
4. **smoke-test-first 已验**（parse12 §3.2）：npm view 确认 defuddle v0.19.1 MIT + 近零 dep；turndown v7.2.4 MIT + domino 轻量。

**用户硬约束的兼容性**：raw 默认设计与此决策无关（无论引擎选什么，raw 档都 passthrough）；markdown opt-in 档的引擎选型不影响 raw 零回归承诺。

### 4.2 接入点确认

| 接入点 | raw 档（v1.0 兼容） | markdown / markdown_cited 档（v1.1 新增） |
|---|---|---|
| **BrowseChannel.doExtract** | take_snapshot → a11y 文本树（byte-identical v1.0） | evaluate_script 取 outerHTML → extractMarkdown → markdown preview |
| **fetch_url.doFetchUrl** | bodyText 原样（byte-identical v1.0） | route.kind=html 时 bodyText 过 extractMarkdown；非 html 忽略 mode |
| **screenshot / pdf / network / console** | 不接（非文本抽取 action） | 不接（二进制/结构化数据不走 markdown） |
| **search / desktop** | 不接（search 走 SERP API；desktop 走 AX tree） | 不接（语义不匹配；desktop AX 已是结构化 OutlineNode） |

**extract_mode 字段穿线路径**：
```
MCP client (CC)
  → server.tool("fetch_url", { url, options: { extract_mode: "markdown" } })
    → fetchUrlSchema.options.extract_mode（zod .optional()）
      → doFetchUrl(url, opts)  // opts.extract_mode 类型化
        → if route.kind==="html" && mode!=raw: await import("../browse/markdown-extractor.js")
          → extractMarkdown(bodyText, { mode, ... })
            → defuddle extractContent + turndown + (markdown_cited ? applyCitations)
```

### 4.3 raw 默认零回归保证机制

**三层守卫**：
1. **schema 层**：`extract_mode: z.enum([...]).optional()`（无 `.default()`）→ zod 不自动注入 → CC 不传时 args 里根本没有这个字段 → `opts.extract_mode === undefined`
2. **代码层**：doExtract / doFetchUrl 用 `if (mode === undefined || mode === "raw")` 早返 v1.0 路径（§3.3.1/3.3.2 伪码）
3. **INV 层**：INV-66 断言 raw 路径代码本体不 import markdown-extractor（dynamic import 只在 markdown 分支）+ 既有 v1.0 测试集零改运行通过（byte-identical）

**测试断言**（§5 详）：用 v1.0 录制的 fixture（browse extract / fetch_url 的既有 snapshot 测试），在 v1.1 代码上重跑，断言输出 byte-identical。

### 4.4 bounded output 协同

markdown 精炼后内容典型缩短 30-70%（去导航/广告/样板后只剩正文）→ `applyOutputEnvelope` 的 48KiB 触发率下降 → 落盘 spill 减少 → CC 上下文更省。这是 markdown 档的天然利好，**不改 bounded output 契约**（48KiB 上限 / 2000 行 / 16KiB preview / @oN ref 全不变）。

markdown_cited 档的 References 段同过 envelope（如果正文+引用超 48KiB 仍落盘，正常行为）。

---

## 5. 测试计划

### 5.1 raw 默认 byte-identical v1.0 断言（硬验收）

| 测试 | 断言 | 类型 |
|---|---|---|
| `raw-fetch-url-no-extract-mode.test.ts` | CC 不传 extract_mode → fetch_url 输出与 v1.0 fixture byte-identical（bodyText / bodyKind / envelope 全同） | 单测（既有 v1.0 fixture 重跑） |
| `raw-fetch-url-explicit-raw.test.ts` | CC 显式传 `extract_mode:"raw"` → 输出与不传 byte-identical（undefined ≡ "raw"） | 单测 |
| `raw-browse-extract-no-extract-mode.test.ts` | CC 不传 extract_mode → doExtract 走 take_snapshot 路径，输出与 v1.0 byte-identical | 单测 |
| `raw-browse-extract-explicit-raw.test.ts` | CC 传 `extract_mode:"raw"` → 同上 byte-identical | 单测 |
| `INV-66-raw-path-no-extractor-import.mjs` | check-invariants 断言：doExtract / doFetchUrl 代码本体在 raw 分支不出现 `import.*markdown-extractor`（dynamic import 只在 markdown 分支） | CI INV |

### 5.2 markdown 精炼质量

| 测试 | 断言 | 类型 |
|---|---|---|
| `markdown-extractor-basic.test.ts` | 固定 fixture HTML（含 nav/article/footer）→ extractMarkdown(mode:"markdown") 返回 markdown 含 `<h1>Hello</h1>` 转的 `# Hello`，不含 `nav junk` / `footer junk` | 单测 |
| `markdown-fetch-url-html.test.ts` | fetch_url 抓 text/html 页面 + extract_mode:"markdown" → bodyKind 含 `markdown:` 前缀 + preview 是 markdown 文本 | 集成 |
| `markdown-browse-extract.test.ts` | browse extract + extract_mode:"markdown" → preview 是 markdown（含 # 标题）而非 a11y 文本树 | 集成 |
| `markdown-defuddle-fallback.test.ts` | defuddle 抛错 → extractMarkdown 降级 turndown-only（served_by="turndown-only"，不抛错） | 单测（mock defuddle 抛错） |
| `markdown-turndown-fail.test.ts` | turndown 抛错 → extractMarkdown 抛 `[markdown-extractor]` 前缀错误 → BrowseChannel.browse catch → outcome=unknown | 单测（mock turndown 抛错） |
| `markdown-non-html-ignored.test.ts` | fetch_url 抓 application/json + extract_mode:"markdown" → bodyKind="json"（mode 被忽略，文档化行为） | 单测 |
| `markdown-chinese-content.test.ts` | 中文页面 fixture → defundle 能抽中文正文（多语言验证） | 单测 |

### 5.3 citation ⟨N⟩（markdown_cited 档）

| 测试 | 断言 | 类型 |
|---|---|---|
| `citation-basic.test.ts` | markdown 含 2 个不同 URL 的链接 → applyCitations 替换为 `text ⟨1⟩` / `text ⟨2⟩` + 末尾 References 段含 [1] url / [2] url | 单测 |
| `citation-dedupe.test.ts` | markdown 含同一 URL 出现 2 次 → 只分配 1 个角标 ⟨1⟩，References 段只 1 条 | 单测 |
| `citation-no-link.test.ts` | markdown 无任何链接 → applyCitations 返回原文不变，citations=[]，不加 References 段 | 单测 |
| `markdown-cited-e2e.test.ts` | fetch_url + extract_mode:"markdown_cited" → result.citations 非空 + preview 含 ⟨N⟩ 角标 + References 段 | 集成 |

### 5.4 三模式切换 + 边界

| 测试 | 断言 | 类型 |
|---|---|---|
| `mode-switch-raw-markdown.test.ts` | 同一 fixture，raw 档输出 ≠ markdown 档输出（raw 含 nav/footer，markdown 不含） | 单测 |
| `mode-switch-markdown-cited.test.ts` | markdown 档输出 ⊂ markdown_cited 档输出（cited 多了 ⟨N⟩ + References） | 单测 |
| `mode-invalid-value.test.ts` | extract_mode:"loud" → zod 校验拒绝（schema enum 限定） | 单测 |
| `mode-empty-html.test.ts` | extractMarkdown("") → 返 { markdown: "", served_by } 不抛错 | 单测 |

### 5.5 冒烟 + doctor

| 测试 | 断言 | 类型 |
|---|---|---|
| `doctor-33-markdown-engine.test.ts` | doctor #33 markdown_extractor_engine 返 defuddle/turndown 版本 + loadable=true | 集成 |
| `smoke-test-markdown.test.ts` | smokeTestMarkdownEngine() 返 ok=true + engine 非 "failed" + markdown_preview 含 "Hello" | 单测（doctor #34 可调） |

**总测试增量**：~25 新测试（落 §1.4 估算窗口）。

---

## 6. 验收标准（引用 doc/14 §7 + 细化；标 CI vs 手测）

### 6.1 CI 自动验收（🔴 硬闸门）

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | `npm run check-invariants` 报 **69 条全绿**（v1.0 INV-1..65 零改 + 新 INV-66..69） | CI 必跑 |
| 2 | **raw 默认 byte-identical v1.0**（硬验收）：v1.0 既有 fetch_url / browse extract 测试集零改运行通过 | CI 必跑（§5.1） |
| 3 | `npm test` 通过率 100%（v1.0 测试集零回归 + 新 ~25 markdown 测试全过） | CI 必跑 |
| 4 | `npm run build`（tsc）零错误（defuddle/turndown 类型兼容） | CI 必跑 |
| 5 | INV-66 断言：raw 路径代码本体不 import markdown-extractor（dynamic import 只在 markdown 分支） | CI INV |
| 6 | INV-67 断言：markdown-extractor.ts 不 extends BaseChannel/UiChannel，不注册 server.tool | CI INV |
| 7 | INV-68 断言：markdown-extractor.ts 代码本体禁 `spawn`/`exec`/`child_process`/`python`（禁第三运行时） | CI INV |
| 8 | INV-69 断言：markdown 路径输出必经 applyOutputEnvelope（BrowseChannel browse 入口隐式 或 fetch_url 显式） | CI INV |
| 9 | markdown_cited applyCitations 是纯 TS reimplement（INV-69 衍生：不 import crawl4ai） | CI INV |
| 10 | dependencies 只加 defuddle + turndown（license MIT；无 AGPL/无 Python） | CI 核 package.json |

### 6.2 手测（🔵 review / 真机）

| # | 标准 | 类型 |
|---|---|---|
| M1 | 真实网站（如 GitHub README 页 / 博客文章 / 新闻页）browse extract + markdown 档 → markdown 可读、去 nav/footer、保留正文结构 | 手测（需 chrome-devtools-mcp） |
| M2 | fetch_url 抓真实 HTML + markdown 档 → 同上质量 | 手测 |
| M3 | markdown_cited 档 → ⟨N⟩ 角标正确、References 段 URL 可点 | 手测 |
| M4 | defuddle 在中文页面（如知乎/博客园）的抽取质量（多语言回归） | 手测（cn 场景） |
| M5 | doctor #33 在干净环境（npm install 后）正确报 defuddle/turndown 版本 | 手测 |

### 6.3 doc/14 §7 验收对照

| doc/14 §7.3 子功能 | v1.1 落地 | 验收 |
|---|---|---|
| MarkdownExtractor 子组件 | ✅ `src/browse/markdown-extractor.ts`（~180 行） | CI #1-10 |
| fetch_url 默认输出 markdown | ❌ **用户推翻**：默认 raw，markdown opt-in（用户硬约束） | CI #2 raw byte-identical |
| browse extract 默认走 markdown | ❌ **用户推翻**：默认 raw，markdown opt-in | CI #2 raw byte-identical |
| opt-in citations:"footnote" | ✅ markdown_cited 档（applyCitations ~50 行） | CI #9 + 手测 M3 |
| opt-in content_filter:"pruning" | ❌ 推迟 v1.2（doc/14 §4.2c 标 1.2；~200 行 port） | v1.2 |
| OutlineNode maxDepth/interactiveOnly | ❌ 推迟 v1.2（doc/14 §4.2d；与 MarkdownExtractor 解耦） | v1.2 |
| lasso doctor 加 Trafilatura 检测 | ❌ 改为 doctor #33 markdown_engine（defuddle/turndown，非 Trafilatura） | CI #10 |
| 文档「How to use Lasso with Crawl4AI」 | ❌ 推迟 v1.2（doc/14 §7.3 标 1.2；避免基座定位漂移） | v1.2 |

---

## 7. 风险 + 实施顺序

### 7.1 风险登记（v1.1 增量）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R18 | defuddle 抽取质量不达预期（非文章页 / 特定站点） | 中 | 中 | smoke-test-first 验（§3.2）；降级 turndown-only；极端情况回退 Readability+jsdom（仍 JS 原生） |
| R19 | defundle 维护停滞（FiveFilters 团队小） | 低 | 低 | MIT 可 vendor；turndown 是独立stable 兜底；defuddle 失败时 turndown-only 降级 |
| R20 | turndown 对复杂 HTML（表格/嵌套列表）转换质量 | 低 | 低 | turndown v7.2.4 成熟；turndown-plugin-gfm 可选装（v1.2 评估） |
| R21 | markdown_cited ⟨N⟩ 角标与既有 @oN 续页 ref 混淆 | 低 | 低 | ⟨N⟩ 是 unicode 角标（非 @oN 前缀）；正则不重叠；INV-69 衍生命名隔离 |
| R22 | raw 默认零回归被未来 PR 误改 | 中 | 高 | INV-66 + §5.1 byte-identical 测试集；CI 硬闸门 |
| R23 | dynamic import 在 Node 20 ESM 下冷启动延迟 | 低 | 低 | markdown 是 opt-in，用户接受 ~50ms 首次加载；后续 cached |
| R24 | defuddle 对 SPA（JS 渲染后 DOM）抽取依赖 outerHTML 时机 | 中 | 中 | browse extract markdown 走 evaluate_script 取 outerHTML（已渲染后）；fetch_url 是原始 HTML（SPA 可能空，文档化限制） |

### 7.2 实施顺序（分 phase；引擎选型是前置调研已完成）

```
Phase 0 · 引擎 smoke-test（前置，~0.5 天）
  - npm install defuddle turndown
  - 跑 §3.2 smoke-test 6 步清单
  - 验中文页面抽取质量
  - 若 defuddle 失败 → 切 Readability+jsdom 回退（仍 JS 原生）
  - 产出：引擎选定确认 + doctor #33 fixture

Phase 1 · MarkdownExtractor 主模块（~1 天）
  - 新 src/browse/markdown-extractor.ts（~180 行）
  - 新 src/browse/content-filter-cite.ts（~50 行）
  - 单测：§5.2 markdown 质量 + §5.3 citation + §5.4 模式切换
  - 验：extractMarkdown 纯函数可独立测

Phase 2 · 接入 fetch_url（~0.5 天）
  - 改 src/tools/fetch-url.ts（doFetchUrl markdown 分流 + schema 加 extract_mode）
  - 改 src/types.ts（FetchUrlOptions 加 extract_mode + MarkdownExtractResult）
  - 集成测：§5.2 markdown-fetch-url-html + §5.1 raw byte-identical
  - 验：raw 档 byte-identical v1.0（硬验收 CI #2）

Phase 3 · 接入 BrowseChannel extract（~0.5 天）
  - 改 src/channels/BrowseChannel.ts（doExtract mode 分流）
  - 改 src/types.ts（BrowseOptions 加 extract_mode）
  - 改 src/tools/browse.ts（schema 加 extract_mode）+ descriptions.ts
  - 集成测：§5.2 markdown-browse-extract + §5.1 raw byte-identical
  - 验：raw 档 byte-identical v1.0（硬验收 CI #2）

Phase 4 · INV + doctor + 文档（~1 天）
  - 改 src/invariants/check-invariants.mjs（加 INV-66..69 共 4 条）
  - 改 src/doctor/doctor.ts（加 #33/#34）
  - 改 package.json（version 1.1.0 + dependencies）
  - 跑 npm run check-invariants 报 69 条全绿
  - 跑 npm test 全过（v1.0 零回归 + 新 ~25 测试）

Phase 5 · 手测 + 发布（~0.5 天）
  - 手测 M1-M5（真实网站抽取质量）
  - npm 发布 lasso-mcp@1.1.0
  - README badge 更新（v1.0 stable → v1.1 +markdown extraction）
```

**总工期**：~4 天（落 doc/14 §6 「~2-3 周」估算的下限——因引擎选型 JS 原生避了 Python 子进程的跨平台/打包负担）。

---

## 8. 简单性自检（架构想法/01 + 02）

### 8.1 R-CI-02 横切关注点变体（02 §5）

- ❌ MarkdownExtractor 是否引第二套 fallback 范式？**否**——extractMarkdown 是纯函数，不经 FallbackDecider，不注册 server.tool，不持 StateStore。失败时抛错走 BrowseChannel.browse / doFetchUrl 既有 catch 路径（outcome=unknown）。
- ❌ 是否引第二套状态模型？**否**——无 stateId / 无 InteractTask / 无 ALS。markdown 结果直接进 BrowseResult.preview / FetchUrlResult.envelope（既有字段）。
- ❌ 是否引第二套 bounded output？**否**——markdown 输出复用 applyOutputEnvelope（INV-34 同源）。
- ✅ MarkdownExtractor 是 BrowseChannel/fetch_url 的**内部子组件**（INV-67 守），类比 cdp-actions.ts 的 doPdf/doNetwork（也是内部 handler，非新通道）。

### 8.2 R-ABS-01 参数蔓延 / 按 caller 分流（02 §5.5）

- `extract_mode` 是否在共享函数里按 caller 分流？**否**——extractMarkdown(opts.mode) 是纯函数，mode 是枚举入参，不是 caller 标识。所有调用方（fetch_url / browse extract）传同一 mode 语义一致。
- MarkdownExtractOptions 是否参数蔓延？**检查**：当前 4 字段（mode / headingStyle / bulletMarker / enableCitations），均非 caller 标识。若未来加第 5 个 caller 专属参数 → 触发 R-ABS-01 审视。v1.1 守住。

### 8.3 02 §6.3 review 三问

1. **是否引入第二套做同一件事的方式？** — **边缘是**。raw 档（take_snapshot / 原始 bodyText）与 markdown 档（evaluate_script outerHTML / defuddle 抽取）是「同一件事（extract）的两种做法」。**但这是用户硬约束要求的双模设计**（保留元素语义 vs LLM 友好），不是架构退化。守卫：mode 字段是显式 opt-in，raw 默认零回归，两档语义清晰隔离（§1.3 钉死）。类比既有 `screenshot.full: true/false`（同一 action 两种行为）——是合法的 options 分流，非第二套范式。
2. **新增抽象暴露 what 还是 how？** — **what**。extractMarkdown(html, mode) 暴露「抽什么 / 抽成什么模式」，隐藏 defuddle/turndown 的 HTML 解析细节。调用方不感知 DOM 解析顺序。
3. **共享函数是否在新增参数按 caller 分流？** — **否**（见 8.2）。

### 8.4 raw 默认是否最小 surprise

- ✅ raw 默认 = v1.0 行为 = 用户既有心智模型不变。新用户不传 extract_mode → 得到 v1.0 输出（a11y 文本树 / 原始 HTML），无 surprise。
- ✅ markdown 是显式 opt-in = 用户主动选择「我要 LLM 友好」= 预期之内。
- ✅ doc/14「默认 markdown」被用户推翻为「默认 raw」——守「保留网页元素」语义（用户硬约束：不能强制对所有 extract 做 AI 适配优化，要留空间）。

### 8.5 引擎禁第三运行时（01 §3.4 有害象限）

- Trafilatura Python 子进程 = 「被依赖（markdown 抽取唯一路径）+ 变更频率高（Python runtime/lxml 版本漂移）」= **有害象限**（01 §3.4）。JS 原生 defuddle+turndown 避此象限。
- INV-68 守：markdown-extractor.ts 代码本体禁 spawn/exec/python（CI grep 断言）。

### 8.6 概念完整性（Brooks，01 §2.5 刻度四）

- 「extract」一词在 Lasso 语义 = 「从页面取内容」。raw 档取 a11y 文本树，markdown 档取精炼 markdown —— 都是「extract」，概念一致。
- 「markdown」一词 = LLM 友好的文本格式（业界事实标准，doc/14 §2 观察B）。不发明新术语。
- 「citation ⟨N⟩」= Crawl4AI 业界术语（doc/14 §4.1b），不重命名。

---

## 附录 A：v1.1 决策摘要（一页纸）

| 问题 | 决策 | 版本 |
|---|---|---|
| MarkdownExtractor 默认模式？ | **raw（默认）**——保 v1.0 byte-identical；用户硬约束纠正 doc/14「默认 markdown」 | v1.1 |
| markdown 档是否 opt-in？ | **是**——extract_mode:"markdown" 显式 opt-in | v1.1 |
| 引擎选型？ | **defuddle + turndown（JS 原生）**——非 Trafilatura Python（守 R-CI-02 第三运行时红线） | v1.1 |
| markdown_cited 是否含 Pruning？ | **否**——v1.1 仅 ⟨N⟩ 引用角标；Pruning/BM25 推迟 v1.2（~200 行 port 负担） | v1.2 |
| OutlineNode maxDepth 是否进？ | **否**——推迟 v1.2（doc/14 §4.2d；与 MarkdownExtractor 解耦） | v1.2 |
| 是否做 LLM 抽取（schema-driven）？ | **否**——上层职责；Lasso 提供干净 markdown，结构化让 CC 用 tool calling | 永不做 |
| 是否做爬虫基座？ | **否**——守 doc/14 §5.4 保守立场；Lasso = 原语层 | 永不做 |
| raw 零回归怎么守？ | **INV-66 + byte-identical 测试集 + dynamic import 隔离** | v1.1 硬验收 |
| 新 INV 编号？ | **INV-66..69**（v1.0 INV-1..65 零改） | v1.1 |

---

**文档结束**

本 parse12 是 Lasso v1.1 MarkdownExtractor 的文件/函数级执行计划。核心决策：**raw 默认 + markdown opt-in 双模**（用户硬约束，纠正 doc/14）；**JS 原生 defuddle+turndown 引擎**（守 R-CI-02 禁第三运行时）；**4 条新 INV（66-69）守零回归 + 子组件定位 + 引擎约束 + bounded output 同源**。v1.0 的 65 invariants + 既有测试集零改，markdown 是纯增量 opt-in 路径。