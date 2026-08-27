# Lasso v1.1 MarkdownExtractor 验收清单（parse12-acceptance）

> 上游：[parse12.md](parse12.md)（v1.1 文件/函数级执行计划）。
> 关联：[14 §4.1 借鉴分析 + §7.3 落地建议](../14-AI爬虫调研与借鉴分析.md)。
> 基线：v1.0 稳定（65 invariants + 103 src + v1.0.0-rc.1 tag）→ v1.1 增量（INV-66..69 + MarkdownExtractor）。
> **版本**：1.1.0（package.json + index.ts LASSO_SERVER_VERSION + doctor.ts LASSO_VERSION 三处对齐，INV-63 守）。

---

## 1. CI 自动验收（🔴 硬闸门，parse12 §6.1）

| # | 标准 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | `npm run check-invariants` 报 **69 条全绿**（v1.0 INV-1..65 零改 + INV-66..69） | ✅ CI 通过 | `npm run check-invariants` → `All 69 invariants passed.` |
| 2 | **raw 默认 byte-identical v1.0**（硬验收）：extract_mode 未传 / "raw" → BrowseChannel doExtract + fetch_url doFetchUrl 与 v1.0 完全一致 | ✅ CI 通过 | 集成测 `markdown-extract-flow.test.ts` §5.1 两组 byte-identical 断言（browse + fetch_url）|
| 3 | `npm test` 通过率 100%（v1.0 测试集零回归 + 12 新 markdown 集成测试全过） | ✅ CI 通过 | 80 test files / 1411 pass / 1 skip / 0 fail |
| 4 | `npm run build`（tsc）零错误（defuddle/turndown 类型兼容） | ✅ CI 通过 | `tsc` → exit 0 |
| 5 | INV-66：raw 路径代码本体不静态 import markdown-extractor（dynamic import 只在 markdown 分支） | ✅ CI INV | `BrowseChannel.ts` + `fetch-url.ts` 均用 `await import("../browse/markdown-extractor.js")` |
| 6 | INV-67：markdown-extractor.ts 不 extends BaseChannel/UiChannel，不注册 server.tool | ✅ CI INV | 纯函数模块在 `src/browse/`；src 全树无 `server.tool("markdown...")` |
| 7 | INV-68：markdown-extractor.ts 禁 spawn/exec/child_process/python（禁第三运行时） | ✅ CI INV | 只 `import { Defuddle } from "defuddle/node"` + `import TurndownService from "turndown"` |
| 8 | INV-69：markdown 路径输出必经 applyOutputEnvelope（BrowseChannel browse 入口隐式 / fetch_url 显式） | ✅ CI 通过 | fetch_url doFetchUrl 步骤 7 applyOutputEnvelope；BrowseChannel browseSingle 经 writeState（INV-34 同源）|
| 9 | markdown_cited applyCitations 是纯 TS reimplement（不 import crawl4ai） | ✅ CI INV | `content-filter-cite.ts` 无 crawl4ai import；package.json 无 crawl4ai dep |
| 10 | dependencies 只加 defuddle + turndown（license MIT；无 AGPL/无 Python） | ✅ CI 通过 | `package.json` dependencies: defuddle ^0.19.1 + turndown ^7.2.4（均 MIT）|
| 11 | doctor #33 markdown_extractor_engine + #34 markdown_smoke 报 pass | ✅ 通过 | `lasso doctor` → defuddle@0.19.1 + turndown@7.2.4 + smoke ok |

---

## 2. 手测清单（🔵 review / 真机，parse12 §6.2）

### M1 — browse_headless extract markdown 真实页面质量

**目标**：验证 defuddle+turndown 对真实网站的 markdown 抽取质量（去 nav/footer/广告，留正文 + 结构）。

**步骤**：
```bash
# 启动 lasso MCP server，然后通过 CC 调：
browse_headless({
  url: "https://github.com/wangdong233/lasso#readme",
  action: "extract",
  options: { extract_mode: "markdown" }
})
```

**验收**：
- [ ] outcome=worked + markdown_engine 含 "defuddle+turndown"
- [ ] preview 含 README 正文标题（`# Lasso` 等）
- [ ] preview 不含 GitHub nav（"Pull requests / Issues / Marketplace" 等导航文字）
- [ ] preview 不含 footer（"© 2026 GitHub, Inc." 等）

**对比 raw**：
- [ ] 同 URL `extract_mode: "raw"`（或不传）→ preview 是 a11y 文本树（含 nav/footer 噪音）
- [ ] markdown 档 preview 长度 < raw 档 preview 长度（去样板后更短）

### M2 — fetch_url markdown 真实 HTML

**目标**：验证 fetch_url html + markdown 档精炼质量（原始 HTML → markdown）。

**步骤**：
```bash
fetch_url({
  url: "https://example.com/",
  options: { extract_mode: "markdown" }
})
```

**验收**：
- [ ] outcome=worked + body_kind 含 "markdown:defuddle+turndown"
- [ ] envelope.preview 是 markdown 文本（含 # 标题），非原始 HTML 标签
- [ ] 对比 `extract_mode: "raw"` → body_kind=html + preview 含 `<html>` 标签

### M3 — markdown_cited 引用角标

**目标**：验证 markdown_cited 档的 ⟨N⟩ 角标 + References 段正确性。

**步骤**：
```bash
fetch_url({
  url: "https://some-blog-with-links.example.com/",
  options: { extract_mode: "markdown_cited" }
})
```

**验收**：
- [ ] data.citations 非空（Array<{n, url}>；角标 1-based）
- [ ] 同 URL 出现多次 → 只分配 1 个角标（URL 去重）
- [ ] envelope.preview 末尾含 `## References` 段 + `[1] url` / `[2] url` 列表
- [ ] inline 链接替换为 `text ⟨N⟩` 形式（URL 本体去除）

### M4 — defuddle 中文页面抽取质量（多语言回归）

**目标**：验证 defuddle 对中文页面（Lasso cn 场景）的正文抽取能力。

**步骤**：
```bash
browse_headless({
  url: "https://www.zhihu.com/question/<some-question>",
  action: "extract",
  options: { extract_mode: "markdown" }
})
```

**验收**：
- [ ] preview 含中文正文（非空 / 非乱码）
- [ ] defuddle 未误删中文正文段落
- [ ] 已知限制：知乎等 SPA 可能需 browse_headless（JS 渲染后 DOM）；fetch_url 原始 HTML 对 SPA 可能空（parse12 R24）

### M5 — doctor #33/#34 干净环境

**目标**：验证 `npm install` 后 doctor 正确报 defuddle/turndown 版本 + smoke pass。

**步骤**：
```bash
npm install && node dist/index.js doctor | grep markdown
```

**验收**：
- [ ] #33 markdown_extractor_engine: pass + "defuddle@0.19.1 + turndown@7.2.4"
- [ ] #34 markdown_smoke: pass + "smoke ok（engine=defuddle+turndown, <N>ms）"

---

## 3. 三模式语义钉死（parse12 §1.3 硬约束落地确认）

| 模式 | BrowseChannel.doExtract | fetch_url.doFetchUrl | CI 断言 |
|---|---|---|---|
| 未传 = raw | take_snapshot → a11y 文本树（byte-identical v1.0） | 原始 HTML 字节（byte-identical v1.0） | ✅ 集成测 byte-identical |
| `"raw"` 显式 | 同上（undefined ≡ "raw"） | 同上（undefined ≡ "raw"） | ✅ 集成测 byte-identical |
| `"markdown"` | evaluate_script → outerHTML → defuddle+turndown → markdown preview | html route → defuddle+turndown → markdown bodyText | ✅ 集成测 markdown 路径 |
| `"markdown_cited"` | markdown + ⟨N⟩ 角标 + citations 字段 | markdown + ⟨N⟩ + data.citations | ✅ 集成测 citations 非空 |

**关键确认**：
- schema 用 `.optional()` 无 `.default()`（防 zod 自动注入致 byte-identical 断言失真）✅
- raw 档 dynamic import 只在 markdown 分支触发（INV-66 守 raw 路径不加载引擎）✅
- json/text/binary route 忽略 extract_mode（文档化边界；集成测覆盖）✅

---

## 4. doc/14 §7.3 落地对照

| doc/14 §7.3 子功能 | v1.1 落地 | 状态 |
|---|---|---|
| MarkdownExtractor 子组件 | ✅ `src/browse/markdown-extractor.ts` + `content-filter-cite.ts`（Phase A）| CI #1-10 |
| fetch_url 默认输出 markdown | ❌ **用户推翻**：默认 raw，markdown opt-in | CI #2 raw byte-identical |
| browse extract 默认走 markdown | ❌ **用户推翻**：默认 raw，markdown opt-in | CI #2 raw byte-identical |
| opt-in citations:"footnote" | ✅ markdown_cited 档（applyCitations ~50 行 reimplement） | CI #9 + 手测 M3 |
| opt-in content_filter:"pruning" | ❌ 推迟 v1.2（~200 行 port 负担） | v1.2 |
| OutlineNode maxDepth/interactiveOnly | ❌ 推迟 v1.2（与 MarkdownExtractor 解耦） | v1.2 |
| lasso doctor 加 Trafilatura 检测 | ❌ 改为 doctor #33 markdown_engine（defuddle/turndown） | CI #10 + 手测 M5 |

---

## 5. 偏离 parse12 的决策记录

### D1 — 未在 types.ts 重复定义 MarkdownExtractResult interface

**parse12 §2.2 建议**：types.ts 新增 MarkdownExtractResult interface（{ markdown, title?, byline?, citations? }）。

**实际决策**：**未添加**。Phase A 已在 `src/browse/markdown-extractor.ts` 导出 `MarkdownExtractResult`（含 served_by / excerpt 等更完整字段）。在 types.ts 重复定义同义 interface 会违反单一真源（DRY）+ 造成 import 歧义（两个同名 interface）。markdown-extractor.ts 的 MarkdownExtractResult 是 browse/ 内部类型（类比 OutlineNode 在 desktop-types.ts 而非 types.ts），集成消费方（doExtract / doFetchUrl）直接解构使用，无需 types.ts 公开。

**影响**：零（集成测验证 markdown 元数据正确流经 BrowseResult.byline/citations/markdown_engine + FetchUrlResult.citations）。

### D2 — doctor #34 markdown_smoke 实际跑引擎（而非仅读时间戳）

**parse12 §2.2 建议**：#34 是「可选，最后一次 smoke 时间戳」（从 ~/.cache/lasso/markdown-smoke.json 读）。

**实际决策**：#34 **实际运行** `smokeTestMarkdownEngine()`（固定 fixture HTML 跑一次 extractMarkdown），验引擎端到端可用，同时把结果（ok + engine + elapsed_ms + timestamp）写入 cache。这比仅读时间戳更有诊断价值（验引擎真的跑得通，不只是上次跑过）。

**影响**：doctor #34 多 ~170ms（defuddle+turndown 加载 + fixture 抽取），可接受（doctor 是诊断命令）。dynamic import 保证 MCP server 启动不加载引擎（仅 doctor 运行 #34 时触发）。

### D3 — doctor #33 用 walk-up 解析版本（非 require("<pkg>/package.json")）

**parse12 §2.2 建议**：#33 用 require 尝试 loadable。

**实际决策**：defuddle 有 ESM `exports` 字段限制 subpath，`require("defuddle/package.json")` 失败。改用 `require.resolve("defuddle")`（主入口）+ walk-up 找 package.json（name 匹配）读 version。turndown 同范式。不实际加载引擎本体（只读 package.json JSON）。

**影响**：零（版本正确解析 defuddle@0.19.1 + turndown@7.2.4）。

---

**文档结束**

v1.1 Phase B 接入完成。raw 默认 byte-identical v1.0 硬验收通过（集成测端到端断言）；markdown / markdown_cited opt-in 路径经 defuddle+turndown JS 原生引擎实装；4 条新 INV（66-69）守零回归 + 子组件定位 + 引擎约束 + citation reimplement；doctor #33/#34 探测落地。手测 M1-M5 待真机执行。
