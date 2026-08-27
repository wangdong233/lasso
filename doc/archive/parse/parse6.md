# Lasso v0.5 文件/函数级执行计划（parse6）—— 更多外部交互（fetch_url / screenshot / pdf / network）

> 增量于 v0.4（850 TS tests + 30 invariants + 144 Rust tests），落地 09 §2.6 + 08 §3.11（F3.12.4-7）+ 13 §0 的 v0.5 范围。本文档是开发者「照着干」手册：每个文件、函数、签名都钉死，开发者（一人 Rust/Tauri 背景中转 TS）无需再做架构决策。
>
> **核心立场（先读）**：v0.5 是"工具集扩展"版本（09 §1 阶段总览：v0.5 = 更多交互），不引入新 BaseChannel 实现、不引入新 Rust helper 档位、不动 forest 调度层。4 个新工具全部**复用 v0.1-v0.4 既有的 SSRF / undici 连接池 / BrowseChannel.actionDispatch / output-envelope**，不重造任何范式（守 R-CI-02 + 02 §5.5 R-ABS-02 共享比例 ≥50%）。
>
> 权威源（绝对路径）：
> - 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.6
> - 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §3.2（browse 工具范式 + F3.2.8/15-17）+ §3.11（F3.12.4-7 独立工具化）+ §5.1（SSRF）+ §5.2（性能：bounded output / 状态写磁盘）
> - 全交互重设计：`/Users/wangdong/Documents/Project/cc-control-all/doc/13-全交互抓手重设计.md` §1.4（v0.5 工具集扩展定位）
> - 简单性清单：`/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md` §3（R-DEP-03 穿堂式=0）+ §4（R-CHG-01 变更放大率 <5）+ §5（R-CI-02 第二套做法红线）
> - 现状代码：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/`（v0.4 = 850 TS + 30 INV + 144 Rust tests）

---

## 1. v0.5 目标与范围（v0.4 增量）

### 1.1 能力目标（一句话）

CC 通过 Lasso 这唯一一个 MCP，**不再为"抓原始字节 / 截一张图 / 存一份 PDF / 看网络请求"这 4 件事都被迫走 `browse_headless` 全链路**：fetch_url 直接 HTTP 不开浏览器（4× token 节省 + 数倍延迟改善）；screenshot/pdf/network 是 browse 通道的**专项出口**，schema 聚焦单一职责，opts 不再与 navigate/click/fill 共用 BrowseOptions 联合。

### 1.2 范围矩阵（做/不做）

| 维度 | v0.5 做 | v0.5 不做（推迟版本） |
|---|---|---|
| **fetch_url** | 直接 HTTP（undici + SubprocessManager 连接池）+ SSRF 复用 v0.1 ssrfGuard + content-type 分流（html/text/json/二进制 → base64）+ bounded output 复用 v0.3 applyOutputEnvelope | JS 渲染（要渲染走 browse_headless）；子资源 DNS 重绑定防护（v0.1 没做，v0.5 不增量；fetch 主机名只解析一次，复用 ssrfGuard 现状）；登录态请求（要 cookie 走 browse_logged_in） |
| **screenshot** | URL → navigate + take_screenshot 全链路；opts: `full_page / viewport / region / format(png/jpeg) / wait_until`；PNG 大于 48KiB 自动落盘 + 路径返回 | 元素级 ref 截图（先 navigate 再 `interact_observe(@pN, "snapshot")` 拿 ref，然后调用本工具传 pageRef，v0.6 forest 合并后再优化）；mobile emulation viewport（v0.6+） |
| **pdf** | URL → navigate + chrome-devtools-mcp `pdf` 工具（或 evaluate_script fallback 不可达时返 didnt + 明确 hint）；opts: `format / landscape / print_background / margin_*`；PDF 字节经 base64 编码过 applyOutputEnvelope，超 48KiB 落盘 `.pdf` mode 0o600 | 加水印 / 加密 / 表单填充（越界，永远 NO-GO）；分页合并多 URL（v0.6+ 若有需求再评估） |
| **network** | URL → navigate + JS 注入 PerformanceObserver 资源抓取（或 chrome-devtools-mcp 原生 tool 若暴露）；opts: `filter=xhr\|fetch\|img\|3rd-party / include_bodies / timeout_ms`；返回请求列表（url/method/status/type/timing/domain_third_party） | 全 HAR 导出（v0.7 F3.7.x 完整 perf trace）；CDP Network-level interception / mock（v1.0+ 评估）；WebSocket frame 抓取 |
| **新通道** | **无新 BaseChannel 实现**（不新增第 5 个 channel；4 工具全部复用 BrowseChannel + 一条独立 HTTP 路径） | 把 fetch_url 做成 FetchChannel（概念完整性：fetch 不是 UI 通道，是 utility 工具，更像 read_text 而非 browse） |
| **新 Rust 档位** | 无（不动 rust-helper/；不动 4-tier desktop fallback） | pdf 渲染走 Rust（wkhtmltopdf / weasyprint 类）—— 永远不走，chrome-devtools-mcp 已经够 |
| **跨 surface fallback** | 仍严格禁止（INV-23 守住）；fetch_url 失败不 fallback 到 browse_headless，反之亦然（fetch_url vs browse 是 caller-tier 决策，不是引擎决策） | fetch_url 超时自动升级 browse_headless（破坏边界；caller 据 outcome=unknown 自己决定） |

### 1.3 v0.5 内部子里程碑（不单独发版，参照 13 §2.2 分段范式）

- **M0.5a fetch_url 独立交付**（最小风险、最大收益）：ssrfGuard + undici 连接池 + bounded output + content-type 分流；4 工具里**唯一不经浏览器**的，可与 M0.5b/c 完全并行。**Go/No-Go 点**：若 fetch_url 的 SSRF 路径与 browse_headless 出现分歧（fetch 走 subresource DNS 缓存 / browse 走导航 fresh DNS）→ 暂停，回 08 §5.1 + 13 §0 重审"是否要让 fetch 复用 ssrfGuard 还是单独加 subresource DNS 重绑定防护"。预判：复用即可（fetch_url 是单次请求不是导航，不存在 subresource 级放大攻击面）。
- **M0.5b screenshot + pdf（共享 navigate 通路）**：HeadlessChannel.browse(url, "screenshot"\|"pdf", opts) + chrome-devtools-mcp 上游契约验证（take_screenshot 已知可用；pdf 工具存在性待 doctor 探测）。**Go/No-Go 点**：若 chrome-devtools-mcp@LOCKED 不暴露 `pdf` 工具 → 用 `evaluate_script` 注入 CDP 命令不可行（Page.printToPDF 是 CDP 协议命令不是 JS API）→ 砍 pdf 工具，只保留 screenshot，pdf 推 v0.5.1 或换实现路径（如本地 Chrome CLI `--headless --print-to-pdf`）。
- **M0.5c network（依赖 navigate 但实现路径独立）**：JS PerformanceObserver 注入 + 解析 + 3rd-party 过滤 + applyOutputEnvelope。**Go/No-Go 点**：若 PerformanceObserver 在 SSRF-allowlisted 的 fake-ip 环境下抓不到资源（如 Surge TUN 透明代理改 timing）→ 文档化为已知限制，不阻断 M0.5a/b。

### 1.4 fetch_url vs browse_headless 边界决策表（必读）

| 输入特征 | 用 fetch_url | 用 browse_headless |
|---|---|---|
| 想要**原始字节**（HTML 源码 / JSON API 响应 / 文本 / 二进制） | ✅ | ❌（browse 给的是渲染后 DOM + a11y tree） |
| 想要**渲染后页面**（JS-heavy SPA、需要 wait_for 加载完成） | ❌ | ✅ |
| 想要**结构化 a11y snapshot**（同 Playwright 的 accessibility tree） | ❌ | ✅ |
| 想要**截图 / PDF / 点击 / 填表** | ❌（fetch_url 拒绝任何 action） | ✅ |
| 目标是 **JSON API**（REST endpoint） | ✅（content-type=application/json → 直接返 JSON） | ❌（browse 会把 JSON 当页面渲染，浪费） |
| 目标是**反爬站点**（Cloudflare 类） | ❌（fetch 必被拦，没 JS 指纹） | ✅（无 JS 指纹被拦则升 browserbase，见 v0.4） |
| 资源预算 / 延迟敏感（10× 快 + 10× 省 token） | ✅ | ❌（chrome-devtools-mcp 启动开销 + DOM 抽取 token） |
| 需要**登录态 cookie** | ❌（fetch_url 不带 cookie；要登录态走 browse_logged_in + 私有 cookie store，永远不导出） | ✅（browse_logged_in） |

**铁律**：fetch_url 与 browse_headless 是**caller-tier 决策**，CC 根据 description 内嵌路由提示自选；FallbackDecider **永不**在两者间 fallback（守 INV-23 衍生：fetch ↔ browse 跨范式禁 fallback）。

### 1.5 守住的 v0.4 不变量（零回归承诺）

- v0.4 的 **850 TS tests + 144 Rust tests** 全绿（新增测试加在新文件，**不动**现有测试）
- 既有 **INV-1..30** 全部保持绿（INV-6 actionDispatch Map 只**追加 entry**，不改既有 8 条；INV-15 spill mode 0o600 由 pdf/network 自动继承；INV-21 平台字面量不增；INV-23 跨 surface 红线守住）
- 新增 **INV-31..34**（共 **34 条 invariants**）：
  - **INV-31**：fetch_url tool handler 必经 ssrfGuard（禁绕过；URL 进入 fetch 前必须 grep 到 `ssrfGuard(url,...)`）
  - **INV-32**：fetch_url 必经 SubprocessManager.acquireHttpClient（禁 `new Agent()` / 禁裸 `global.fetch` / 禁新造连接池；守 v0.2 连接池单一真源）
  - **INV-33**：pdf / network（含 console）三 action 必须以 entry 形式追加进 BrowseChannel.actionDispatch Map（INV-6 衍生：禁新造第二个 dispatch Map；独立工具经 `headless.browse(url, action, opts)` 入口，不绕过 channel）
  - **INV-34**：screenshot / pdf / network 三个独立 tool handler 的返回路径必经 `applyOutputEnvelope`（>48KiB 自动落盘 + mode 0o600；INV-15 同源延伸到二进制内容）

---

## 2. 文件结构（lasso/src/ TS 层 + lasso/rust-helper/ Rust 层零改）

### 2.1 新增/修改 TS 文件（lasso/src/）

```
src/
├── types.ts                              [修改] 加 FetchResult / ScreenshotResult / PdfResult / NetworkResult 类型 + FetchOptions/ScreenshotOptions/PdfOptions/NetworkOptions 子集
├── tools/
│   ├── fetch-url.ts                      [NEW] registerFetchUrlTool() —— SSRF + undici + bounded output + content-type 分流
│   ├── screenshot.ts                     [NEW] registerScreenshotTool() —— 经 headless.browse(url,"screenshot",opts)，opts 透传
│   ├── pdf.ts                            [NEW] registerPdfTool() —— 经 headless.browse(url,"pdf",opts)，PDF bytes 过 envelope
│   ├── network.ts                        [NEW] registerNetworkTool() —— 经 headless.browse(url,"network",opts)，resource list 过 envelope
│   ├── descriptions.ts                   [修改] 追加 4 段 FETCH_URL_DESCRIPTION / SCREENSHOT_DESCRIPTION / PDF_DESCRIPTION / NETWORK_DESCRIPTION（同 SEARCH/BROWSE 风格 + [Prefer X over Y] 路由提示）
│   └── annotations.ts                    [修改] 追加 4 套 ToolAnnotations（fetch_url/screenshot: readOnly=true, openWorld=true；pdf: readOnly=true, openWorld=true；network: readOnly=true, openWorld=true）
├── channels/
│   └── BrowseChannel.ts                  [修改] actionDispatch Map 追加 3 entry: ["pdf", doPdf] / ["network", doNetwork] / ["console", doConsole]（守 INV-6；screenshot 已存在不动）
├── browse/
│   ├── cdp-actions.ts                    [NEW] doPdf / doNetwork / doConsole 三个 ActionHandler 实装（与既有 doNavigate/doSnapshot 同档自由函数；paper-print/perf-trace/console-log 上游工具名集中此处，便于漂移单点改）
│   └── content-type-router.ts            [NEW] fetch_url 专用：HTTP response content-type → {kind: "html"|"text"|"json"|"binary", decoder}（4 路分流，禁 if-else 链用 Map）
├── invariants/
│   └── check-invariants.mjs              [修改] 追加 INV-31..34 四条断言（grep SRC，无运行时依赖）
└── index.ts                              [修改] 装配 4 个 registerXxxTool；其余装配零动（subproc/headless/logged_in/decider/ssrfConfig 已在）

rust-helper/                              [零改] v0.5 不动 Rust（fetch/screenshot/pdf/network 都是 TS 层工具）
```

**总改动量估算**：6 个新文件 + 4 个修改文件 ≈ **+800 行 TS**（含测试）；既有 850 行测试零改动；既有 30 INV 断言零改动（只追加 4 条）。

### 2.2 不动的 v0.4 既有件（零回归承诺清单）

| 既有件 | v0.5 是否动 | 理由 |
|---|---|---|
| BaseChannel / UiChannel / BrowseChannel 继承层 | ❌ 不动 | 4 新工具不引入新 channel（守 13 §1.2 R-CI-02） |
| HeadlessChannel / LoggedInChannel / DesktopChannel / BrowserbaseChannel / StagehandChannel / BraveChannel / SearchChannel | ❌ 不动 | v0.5 复用 BrowseChannel 子类的 `browse()` 入口即可，无需特化 |
| SubprocessManager + McpClient + RustBridge | ❌ 不动 | fetch_url 复用 acquireHttpClient（已存在）；screenshot/pdf/network 复用 McpClient.callTool（已存在） |
| FallbackDecider + CircuitBreaker + PolicyGate | ❌ 不动 | 4 新工具**不挂 fallback 链**（fetch_url 是终端工具；screenshot/pdf/network 经 headless.browse() 已隐式享受 headless→logged_in fallback，不新加） |
| RootRegistry + InteractDispatcher（forest） | ❌ 不动 | v0.5 不暴露 pageRef 入参；forest 与 4 工具正交（pageRef 支持推 v0.6 forest 演进时合并） |
| ssrfGuard + cidr + defaults | ❌ 不动 | fetch_url 直接复用 v0.1 ssrfGuard，零修改 |
| output-envelope（applyOutputEnvelope / readOutputPage） | ❌ 不动 | pdf/network 透传 base64 字符串进 envelope 即可；screenshot 文件路径走 writeState（已存在） |
| 30 条 invariants（INV-1..30） | ❌ 不动 | 只追加 INV-31..34 |
| 144 条 Rust tests | ❌ 不动 | rust-helper/ 零改 |
| 850 条 TS tests | ❌ 不动 | 新增测试加在新文件（test/unit/fetch-url.spec.ts / screenshot.spec.ts / pdf.spec.ts / network.spec.ts / content-type-router.spec.ts / cdp-actions.spec.ts） |

### 2.3 依赖关系图（4 工具 → 复用层）

```
┌────────────────────────────────────────────────────────────────────┐
│  v0.5 新增 Tool Layer（4 个新 server.tool 注册）                     │
│  fetch_url  /  screenshot  /  pdf  /  network                       │
└──────┬───────────────┬──────────────────────┬──────────────────────┘
       │               │                      │
       │ SSRF          │ headless.browse(     │ headless.browse(
       │ +undici       │   url,"screenshot")  │   url,"pdf"|"network")
       ▼               ▼                      ▼
┌──────────────┐  ┌──────────────────────────────────────────────┐
│ ssrfGuard    │  │ BrowseChannel.browse(url, action, options)   │
│ (v0.1 复用)  │  │  └─ actionDispatch Map（v0.4 8 条 + v0.5 +3）│
│              │  │     ├─ navigate/snapshot/screenshot/extract/ │
│              │  │     │  click/fill/wait/evaluate（v0.1 不动）  │
│              │  │     ├─ pdf     → doPdf     [NEW]              │
│              │  │     ├─ network → doNetwork [NEW]              │
│              │  │     └─ console → doConsole [NEW]              │
└──────────────┘  └────────────────┬─────────────────────────────┘
       │                          │
       │ acquireHttpClient        │ c.callTool("pdf"\|"network_log"\|...)
       ▼                          ▼
┌──────────────────┐    ┌─────────────────────────┐
│ SubprocessManager│    │ McpClient (CDP bridge)  │
│ undici Agent pool│    │ chrome-devtools-mcp     │
│ (v0.2 复用)      │    │ @LOCKED_CDP_MCP_VERSION │
└──────────────────┘    └─────────────────────────┘
       │                          │
       ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│ applyOutputEnvelope + read_text (v0.3 复用，零改)        │
│   • fetch 大 JSON / html → text → 48KiB envelope → @oN    │
│   • pdf base64 字符串 → 48KiB envelope → @oN.pdf 0o600    │
│   • network resource list JSON → 48KiB envelope → @oN     │
│   • screenshot PNG >48KiB → 写盘 + 路径（writeState 复用）│
└──────────────────────────────────────────────────────────┘
```

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 fetch_url（fetch-url.ts，约 200 行）

#### 3.1.1 设计要点

- **不经浏览器**：直接走 SubprocessManager.acquireHttpClient 拿 undici Agent（守 INV-32，禁 new Agent / 禁裸 fetch）
- **SSRF 必经**：入口第一步 `ssrfGuard(url, ssrfConfig)`，与 browse_headless 同路径同函数（守 INV-31）
- **bounded output**：响应 body 经 content-type-router 分流后，统一转 string → applyOutputEnvelope（html/text/json 原样；二进制 base64 编码后当 string）
- **零 fallback**：fetch_url 不挂 FallbackDecider 链（caller-tier 工具，失败返 outcome + error，由 CC 决定下一步）

#### 3.1.2 接口签名

```typescript
// src/tools/fetch-url.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SsrfConfig } from "../ssrf/ssrf-guard.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { FETCH_URL_DESCRIPTION } from "./descriptions.js";
import { fetchUrlAnnotations } from "./annotations.js";
import { ssrfGuard } from "../ssrf/ssrf-guard.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";
import { routeContentType } from "../browse/content-type-router.js";
import type { FetchOptions, FetchResult, InteractResult } from "../types.js";

// Schema
const fetchUrlSchema = {
  url: z.string().url(),
  options: z
    .object({
      method: z.enum(["GET", "HEAD"]).default("GET"), // v0.5 只支持 GET/HEAD（POST/PUT 推 v0.6 评估）
      headers: z.record(z.string()).optional(),       // 用户自定义 header（User-Agent / Accept 等）
      timeout_ms: z.number().int().positive().max(60_000).default(30_000),
      max_bytes: z.number().int().positive().max(16 * 1024 * 1024).default(2 * 1024 * 1024), // 单条上限 16 MiB（与 output-envelope SINGLE_CAP 对齐）
      no_cache: z.boolean().default(false),           // HTTP 层 Cache-Control: no-cache
    })
    .default({}),
};

/**
 * @param server       MCP server
 * @param subproc      SubprocessManager（acquireHttpClient 拿 undici Agent）
 * @param ssrfConfig   SSRF allowRanges / denyRanges（从 env 加载，与 browse_headless 共用）
 */
export function registerFetchUrlTool(
  server: McpServer,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): void { /* 见 3.1.3 伪码 */ }
```

#### 3.1.3 伪码（核心 handler）

```typescript
server.tool("fetch_url", FETCH_URL_DESCRIPTION, fetchUrlSchema, fetchUrlAnnotations,
  async (args) => {
    const url: string = args.url;
    const opts: FetchOptions = args.options;

    // 1. SSRF 守门（INV-31；与 browse_headless 同函数同 config）
    const ssrfResult = await ssrfGuard(url, ssrfConfig);
    if (!ssrfResult.allowed) {
      return ssrfBlockedPayload(ssrfResult.reason); // 复用 browse.ts 的 ssrfBlocked 风格
    }

    // 2. 取 host 专属 keep-alive client（INV-32；origin 分流，连接复用 30s keepAliveTimeout）
    const origin = new URL(url).origin;
    const httpClient = subproc.acquireHttpClient(origin);

    // 3. 发请求（method + headers + timeout；no_cache 注入 Cache-Control）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout_ms);
    const reqHeaders: Record<string, string> = {
      "User-Agent": "lasso-mcp/0.5 (fetch_url)", // 自报身份，不伪装浏览器（与 browse_headless 默认 UA 不同，避免反爬误判）
      "Accept": "*/*",
      ...(opts.no_cache ? { "Cache-Control": "no-cache" } : {}),
      ...opts.headers,
    };

    let resp;
    try {
      resp = await httpClient.fetch(url, {
        method: opts.method,
        headers: reqHeaders,
        signal: controller.signal,
        redirect: "follow", // undici 默认；重定向链 SSRF 由 ssrfGuard 在每跳前后？(见 §4.1 决策)
      });
    } catch (e) {
      clearTimeout(timer);
      return payload(outcomeFromFetchError(e), null, String(e));
    }
    clearTimeout(timer);

    // 4. 响应大小硬上限（max_bytes；超限截断 + 标记 truncated_by_byte_limit）
    const contentLength = parseInt(resp.headers.get("content-length") ?? "0", 10);
    if (contentLength > opts.max_bytes) {
      return payload("didnt", null, `content_length_exceeds_max:${contentLength}>${opts.max_bytes}`);
    }

    // 5. content-type 分流（content-type-router.ts）
    const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
    const route = routeContentType(contentType);
    const bodyBuf = await resp.arrayBuffer();
    if (bodyBuf.byteLength > opts.max_bytes) {
      return payload("didnt", null, `body_exceeds_max:${bodyBuf.byteLength}>${opts.max_bytes}`);
    }

    // 6. 按 route 解码 + 走 applyOutputEnvelope（48KiB / 2000 行自动落盘）
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
      bodyKind = route.kind; // "html" | "text"
    }
    const envelope = applyOutputEnvelope(bodyText, `fetch_url: narrow by URL path or use Range header to reduce size`);

    // 7. 返回 InteractResult<FetchResult>
    const result: InteractResult<FetchResult> = {
      outcome: resp.ok ? "worked" : "didnt", // 4xx = didnt（明确语义）；5xx/超时/网络挂 = unknown（已在 catch）
      data: {
        url,
        final_url: resp.url, // undici 跟随重定向后的最终 URL
        status: resp.status,
        content_type: contentType,
        body_kind: bodyKind,
        body_bytes: bodyBuf.byteLength,
        envelope,
      },
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "undici_keepalive",
      ...(resp.ok ? {} : { error: `http_${resp.status}` }),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

function outcomeFromFetchError(e: unknown): "unknown" | "didnt" {
  const m = String(e).toLowerCase();
  if (m.includes("enotfound") || m.includes("nxdomain")) return "didnt";
  if (m.includes("abort") || m.includes("timeout")) return "unknown";
  return "unknown"; // 网络挂 / 5xx / 连接重置 → unknown（caller 据 fallback 规则自决）
}
```

#### 3.1.4 借鉴源 + 行数估算

- **SSRF + ssrfBlocked 风格**：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/tools/browse.ts` 第 75-87 行
- **acquireHttpClient 注入式 fetch**：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BraveChannel.ts` 第 56-79 行（BraveChannel 的 httpClient.fetch 范式直接照搬）
- **applyOutputEnvelope 复用**：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/util/output-envelope.ts` 第 84-116 行（fetch_url 把 body 当 text 处理即可，零侵入）
- **outcome 分类范式**：BrowseChannel.ts 第 726-733 行 `classifyBrowseError`（同构：4xx → didnt，网络/超时 → unknown）
- **行数估算**：`fetch-url.ts` ≈ **150 行**（schema 30 + handler 80 + helper 20 + 注释 20）

---

### 3.2 screenshot（screenshot.ts，约 130 行）

#### 3.2.1 设计要点

- **经 HeadlessChannel.browse(url, "screenshot", opts) 入口**：不绕过 BrowseChannel（守 INV-33 衍生：独立工具经 channel.browse 入口）
- **screenshot action 已存在**（BrowseChannel.actionDispatch.get("screenshot") = doScreenshot，第 92 行），v0.5 **不动**；独立工具只是**重新暴露**这个 action 为顶层工具 + 细化 opts schema
- **PNG 落盘**：复用 doScreenshot 现有逻辑（写 `/tmp/lasso-screenshot-<uuid>.png`）；超大 PNG（>48KiB）走 writeState（state-store）拿 content_path，preview 给路径
- **pageRef 支持 v0.5 不做**：仅 URL 入参（pageRef 推 v0.6 forest 合并后）

#### 3.2.2 接口签名

```typescript
// src/tools/screenshot.ts
const screenshotSchema = {
  url: z.string().url(),
  options: z
    .object({
      full_page: z.boolean().default(false),
      viewport: z
        .object({ width: z.number().int().min(320).max(4096).default(1280),
                  height: z.number().int().min(240).max(4096).default(800) })
        .optional(),
      region: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(), // v0.5 接受但 chrome-devtools-mcp 可能不实现 → 上游不支持时返 didnt + hint
      format: z.enum(["png", "jpeg"]).default("png"),
      quality: z.number().int().min(1).max(100).optional(), // 仅 jpeg
      wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
      timeout_ms: z.number().int().positive().default(30_000),
    })
    .default({}),
};

export function registerScreenshotTool(
  server: McpServer,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig, // 入口 SSRF 与 browse_headless 同 guard；穿透到 channel 内部前拦
): void { /* 见 3.2.3 */ }
```

#### 3.2.3 伪码（核心 handler）

```typescript
server.tool("screenshot", SCREENSHOT_DESCRIPTION, screenshotSchema, screenshotAnnotations,
  async (args) => {
    // 1. SSRF（与 browse_headless 同函数同 config）
    const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
    if (!ssrfResult.allowed) return ssrfBlockedPayload(ssrfResult.reason);

    // 2. 透传 BrowseOptions 形状（与 browse.ts 第 40-70 行 schema 对齐）
    const browseOpts: BrowseOptions = {
      screenshot: { full: args.options.full_page },
      wait_until: args.options.wait_until,
      timeout_ms: args.options.timeout_ms,
      // region / format / viewport v0.5 暂不映射（doScreenshot 现不支持；上游 chrome-devtools-mcp
      // take_screenshot 接 fullPage + format + filePath；region 在 v0.5 不接入，文档明确）
    };

    // 3. 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6 dispatch Map）
    const result = await headless.browse(args.url, "screenshot", browseOpts);
    // doScreenshot 写盘后 preview = "screenshot saved to /tmp/lasso-screenshot-<uuid>.png"
    // 把 preview 提升为 data.path 字段（FetchResult 风格，便于 CC 直接读路径）

    const screenshotResult: InteractResult<ScreenshotResult> = {
      outcome: result.outcome,
      data: result.data ? {
        url: args.url,
        path: extractScreenshotPath(result.data.preview), // 解析 preview 抽 path
        preview: result.data.preview,
        state_id: result.data.state_id,
      } : null,
      served_by: result.served_by,
      fallback_used: result.fallback_used,
      retrieval_method: result.retrieval_method,
      error: result.error,
    };
    return { content: [{ type: "text", text: JSON.stringify(screenshotResult, null, 2) }] };
  }
);

// helper: 从 "screenshot saved to /tmp/...png" 抽 /tmp/...png
function extractScreenshotPath(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const m = preview.match(/\/[^\s]+\.(png|jpg|jpeg)/i);
  return m ? m[0] : undefined;
}
```

#### 3.2.4 借鉴源 + 行数估算

- **doScreenshot 实装**：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BrowseChannel.ts` 第 593-606 行（直接复用）
- **server.tool 注册范式 + ssrfBlocked**：`browse.ts` 第 75-87 行 + 第 114-148 行
- **行数估算**：`screenshot.ts` ≈ **100 行**

---

### 3.3 pdf（pdf.ts + cdp-actions.ts，约 220 行）

#### 3.3.1 设计要点

- **actionDispatch Map 追加 "pdf" entry**（守 INV-33；与既有 8 条并列，禁新造第二个 dispatch）
- **chrome-devtools-mcp 上游契约**：doctor CLI 需扩一项探测 `cdp_mcp_pdf_tool_available`（v0.4 既有 doctor 框架加一条 check）；若上游不暴露 `pdf` 工具 → outcome=didnt + retrieval_method="upstream_unsupported:pdf"，并标 `next_step: "use `chrome --headless --print-to-pdf` directly or wait for chrome-devtools-mcp upstream"`
- **PDF 字节 base64 编码 → 过 applyOutputEnvelope**：典型 PDF 50-500 KiB，必超 48KiB 上限；envelope 自动落盘 `.pdf` 文件（mode 0o600，守 INV-34 + INV-15 衍生）
- **落盘文件扩展名**：output-envelope 当前只写 `.txt`；v0.5 扩展为接受 `extension` 参数（向后兼容默认 `.txt`），pdf 传 `.pdf`

#### 3.3.2 output-envelope 微扩（最小改动，向后兼容）

```typescript
// src/util/output-envelope.ts 修改（+3 行，零回归）：
export function applyOutputEnvelope(
  text: string,
  refineHint?: string,
  extension: ".txt" | ".pdf" = ".txt", // v0.5 新增，默认 .txt 守 backward-compat
): BoundedOutput {
  // ... 内部 spillToDisk(ref, text, extension)
}

function spillToDisk(ref: string, text: string, extension: ".txt" | ".pdf" = ".txt"): string {
  // ...
  const file = path.join(SPILL_ROOT, `${ref}${extension}`); // 替换原来的 `${ref}.txt`
  writeFileSync(file, text, { mode: 0o600 }); // INV-15 + INV-34
  // ...
}
```

**注意**：PDF 是 base64 字符串（不是 Buffer），落盘后是文本文件名 `.pdf` 但内容是 base64；CC 用 read_text({ref:"@oN"}) 续页读 base64，自行解码。这个 trade-off 换最小改动；v0.6 若有需求再扩 read_text 支持 binary。

#### 3.3.3 doPdf 实装（cdp-actions.ts）

```typescript
// src/browse/cdp-actions.ts
import type { McpClient } from "../subprocess/McpClient.js";
import type { BrowseOptions, BrowseResult } from "../types.js";
import { randomUUID } from "node:crypto";

/**
 * pdf action handler —— 追加进 BrowseChannel.actionDispatch Map（INV-33）
 *
 * 上游契约：chrome-devtools-mcp@LOCKED_CDP_MCP_VERSION 暴露 `pdf` 工具（doctor CLI 探测）。
 * opts:
 *   - pdf_format: "A4" | "Letter" | "Legal" | "Tabloid"（chrome-devtools-mcp 透传 CDP paperSize）
 *   - pdf_landscape: boolean
 *   - pdf_print_background: boolean
 *   - pdf_margin_top/_bottom/_left/_right: number（inches）
 */
export async function doPdf(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  const args = {
    format: opts.pdf_format ?? "A4",
    landscape: opts.pdf_landscape ?? false,
    printBackground: opts.pdf_print_background ?? true,
    marginTop: opts.pdf_margin_top ?? 0.4,
    marginBottom: opts.pdf_margin_bottom ?? 0.4,
    marginLeft: opts.pdf_margin_left ?? 0.4,
    marginRight: opts.pdf_margin_right ?? 0.4,
  };
  // chrome-devtools-mcp `pdf` 工具返 base64 PDF string（CDP Page.printToPDF）
  const r = (await c.callTool("pdf", args)) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (r.isError) {
    throw new Error(`upstream_pdf_error:${firstText(r) ?? "unknown"}`);
  }
  const base64 = firstText(r) ?? "";
  if (!base64) {
    throw new Error("upstream_pdf_empty_response");
  }
  // base64 PDF 作为 preview 返回；pdf.ts 工具层会把它过 applyOutputEnvelope 落盘
  return { preview: base64 };
}

function firstText(r: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  for (const b of r.content ?? []) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}
```

#### 3.3.4 pdf.ts 工具层（envelope 落盘）

```typescript
// src/tools/pdf.ts —— registerPdfTool()
server.tool("pdf", PDF_DESCRIPTION, pdfSchema, pdfAnnotations, async (args) => {
  const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
  if (!ssrfResult.allowed) return ssrfBlockedPayload(ssrfResult.reason);

  const browseOpts: BrowseOptions = {
    pdf_format: args.options.format,
    pdf_landscape: args.options.landscape,
    pdf_print_background: args.options.print_background,
    pdf_margin_top: args.options.margin_top,
    pdf_margin_bottom: args.options.margin_bottom,
    pdf_margin_left: args.options.margin_left,
    pdf_margin_right: args.options.margin_right,
    wait_until: args.options.wait_until,
    timeout_ms: args.options.timeout_ms,
  };

  const result = await headless.browse(args.url, "pdf", browseOpts);
  // result.data.preview 是 base64 PDF（来自 doPdf）→ 过 envelope 落 .pdf
  let envelope;
  if (result.outcome === "worked" && result.data?.preview) {
    envelope = applyOutputEnvelope(
      result.data.preview,
      "pdf too large: narrow by selecting specific pages or reduce content",
      ".pdf", // v0.5 新增 extension 参数
    );
  }

  const pdfResult: InteractResult<PdfResult> = {
    outcome: result.outcome,
    data: result.data ? {
      url: args.url,
      envelope,
      state_id: result.data.state_id,
      ...(envelope?.ref ? { spill_path: `/tmp/lasso-output/${envelope.ref}.pdf` } : {}),
    } : null,
    served_by: result.served_by,
    fallback_used: result.fallback_used,
    retrieval_method: result.outcome === "worked" ? "chrome_devtools_mcp_pdf" : (result.retrieval_method ?? "pdf_failed"),
    error: result.error,
  };
  return { content: [{ type: "text", text: JSON.stringify(pdfResult, null, 2) }] };
});
```

#### 3.3.5 BrowseOptions 类型扩展（types.ts）

```typescript
// types.ts 修改：BrowseOptions 追加 7 个 pdf_* 字段 + 5 个 network_* 字段（v0.5）
@dataclass-equivalent
interface BrowseOptions {
  // ... 既有字段
  // v0.5 pdf action 参数
  pdf_format?: "A4" | "Letter" | "Legal" | "Tabloid";
  pdf_landscape?: boolean;
  pdf_print_background?: boolean;
  pdf_margin_top?: number;
  pdf_margin_bottom?: number;
  pdf_margin_left?: number;
  pdf_margin_right?: number;
  // v0.5 network action 参数
  network_filter?: "xhr" | "fetch" | "img" | "3rd-party" | "all";
  network_include_bodies?: boolean;
  network_timeout_ms?: number;
}
```

#### 3.3.6 借鉴源 + 行数估算

- **actionDispatch Map 追加范式**：BrowseChannel.ts 第 90-99 行（只加 3 entry，不改既有 8 条）
- **doScreenshot 写盘范式**：BrowseChannel.ts 第 593-606 行（doPdf 同结构：callTool → 抽 preview）
- **applyOutputEnvelope extension 参数**：output-envelope.ts 第 84-116 行（最小扩 +3 行）
- **行数估算**：`cdp-actions.ts` ≈ **120 行**（doPdf 60 + doNetwork 30 + doConsole 30）；`pdf.ts` ≈ **100 行**

---

### 3.4 network（network.ts，约 180 行）

#### 3.4.1 设计要点

- **actionDispatch Map 追加 "network" entry**（守 INV-33）
- **实现路径**：JS PerformanceObserver 注入（v0.5 MVP）。chrome-devtools-mcp@LOCKED 是否暴露 `network_log` 工具待 doctor 探测；若暴露优先用上游工具（更准、含 status code），否则用 evaluate_script 注入 PerformanceObserver 兜底
- **3rd-party 过滤**：URL host ≠ page host 的 eTLD+1 → third_party=true；用 tldts 库（轻量）或简化为 host 精确匹配（v0.5 简化版，eTLD+1 推 v0.6）
- **资源列表过 applyOutputEnvelope**（典型页面 50-500 资源 × 200 字节/条 = 10-100 KiB，常超 48KiB）

#### 3.4.2 doNetwork 实装（cdp-actions.ts）

```typescript
/**
 * network action handler —— PerformanceObserver 注入式（M0.5c MVP）
 *
 * 上游契约：doctor 探测 chrome-devtools-mcp 是否有 `network_log` 工具；
 * 有则优先用，无则走 evaluate_script 注入 JS 抓 performance.getEntriesByType("resource")。
 *
 * opts:
 *   - network_filter: "xhr" | "fetch" | "img" | "3rd-party" | "all"
 *   - network_include_bodies: boolean（v0.5 不实装 bodies，文档化推迟 v0.6）
 *   - network_timeout_ms: number（observer 采集窗口，默认 3000ms）
 */
export async function doNetwork(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // 走 evaluate_script 注入：等 network_timeout_ms 后读 performance entries
  const expr = `(function(){
    return new Promise((resolve) => {
      const entries = [];
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) entries.push({
          name: e.name, type: e.initiatorType, duration: e.duration,
          ttfb: e.responseStart - e.requestStart, bytes: e.transferSize,
          workerStart: e.workerStart
        });
      });
      obs.observe({ type: "resource", buffered: true });
      setTimeout(() => { obs.disconnect(); resolve(JSON.stringify(entries)); },
                 ${opts.network_timeout_ms ?? 3000});
    });
  })()`;
  const r = (await c.callTool("evaluate_script", { function: expr })) as EvaluateResult;
  const text = firstText(r) ?? "[]";
  return { preview: text }; // JSON 字符串，过 envelope
}
```

#### 3.4.3 network.ts 工具层（3rd-party 过滤 + envelope）

```typescript
// src/tools/network.ts
server.tool("network", NETWORK_DESCRIPTION, networkSchema, networkAnnotations, async (args) => {
  const ssrfResult = await ssrfGuard(args.url, ssrfConfig);
  if (!ssrfResult.allowed) return ssrfBlockedPayload(ssrfResult.reason);

  const pageHost = new URL(args.url).hostname;
  const browseOpts: BrowseOptions = {
    network_filter: args.options.filter,
    network_include_bodies: args.options.include_bodies,
    network_timeout_ms: args.options.timeout_ms,
    wait_until: args.options.wait_until,
  };

  const result = await headless.browse(args.url, "network", browseOpts);
  let envelope;
  let resourceCount = 0;
  let thirdPartyCount = 0;
  if (result.outcome === "worked" && result.data?.preview) {
    // 解析 + 过滤
    const raw = JSON.parse(result.data.preview) as ResourceEntry[];
    const filtered = filterResources(raw, args.options.filter ?? "all", pageHost);
    resourceCount = filtered.length;
    thirdPartyCount = filtered.filter(r => r.third_party).length;
    envelope = applyOutputEnvelope(
      JSON.stringify(filtered, null, 2),
      "network log too large: narrow by filter (xhr/fetch/img) or 3rd-party-only",
    );
  }

  const networkResult: InteractResult<NetworkResult> = {
    outcome: result.outcome,
    data: result.data ? {
      url: args.url,
      page_host: pageHost,
      resource_count: resourceCount,
      third_party_count: thirdPartyCount,
      envelope,
      state_id: result.data.state_id,
    } : null,
    served_by: result.served_by,
    fallback_used: result.fallback_used,
    retrieval_method: "performance_observer",
    error: result.error,
  };
  return { content: [{ type: "text", text: JSON.stringify(networkResult, null, 2) }] };
});

interface ResourceEntry {
  name: string; type: string; duration: number; ttfb: number;
  bytes: number; third_party?: boolean;
}

function filterResources(
  entries: ResourceEntry[],
  filter: "xhr" | "fetch" | "img" | "3rd-party" | "all",
  pageHost: string,
): ResourceEntry[] {
  // 先标 third_party（host 精确匹配 v0.5；eTLD+1 推 v0.6）
  const tagged = entries.map(e => {
    let host = "";
    try { host = new URL(e.name).hostname; } catch { /* invalid url, skip */ }
    return { ...e, third_party: host !== pageHost && host !== "" };
  });
  switch (filter) {
    case "xhr": return tagged.filter(e => e.type === "xmlhttprequest");
    case "fetch": return tagged.filter(e => e.type === "fetch");
    case "img": return tagged.filter(e => e.type === "img" || e.type === "cssimage");
    case "3rd-party": return tagged.filter(e => e.third_party);
    case "all": default: return tagged;
  }
}
```

#### 3.4.4 借鉴源 + 行数估算

- **evaluate_script 注入范式**：BrowseChannel.ts 第 428-458 行（quickSnapshot 同结构）
- **filter switch**：content-type-router.ts 同 if-else→Map 范式（v0.5 简化为 switch 是合理，5 case 单维度）
- **行数估算**：`network.ts` ≈ **140 行**（含 filter helper）；cdp-actions.ts 的 doNetwork ≈ **40 行**

---

### 3.5 共享 helper：content-type-router.ts（约 80 行）

```typescript
// src/browse/content-type-router.ts
/**
 * HTTP response content-type → 解码策略（fetch_url 专用）
 *
 * 守 R-CI-02：禁新造第二套 HTTP 解析范式；本 router 仅服务 fetch_url（browse 通道
 * 走 chrome-devtools-mcp 自带 DOM 解析，不经此 router）。
 *
 * 借鉴：08 §5.2 + 13 §0；mime类型分类参考 Apache mime.types 主流分组。
 */

export type ContentKind = "html" | "text" | "json" | "binary";

export interface ContentRoute {
  kind: ContentKind;
  subtype?: string; // binary 时给 octet-stream/pdf/png 等
}

const ROUTING_TABLE: Array<{ pattern: RegExp; kind: ContentKind }> = [
  { pattern: /^text\/html\b/, kind: "html" },
  { pattern: /^application\/xhtml\+xml\b/, kind: "html" },
  { pattern: /^application\/json\b/, kind: "json" },
  { pattern: /^text\/(plain|css|javascript|csv|markdown|xml)\b/, kind: "text" },
  { pattern: /^application\/xml\b/, kind: "text" },
  { pattern: /^application\/(javascript|ecmascript)\b/, kind: "text" },
];

export function routeContentType(contentType: string): ContentRoute {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  for (const r of ROUTING_TABLE) {
    if (r.pattern.test(ct)) return { kind: r.kind };
  }
  // 其余一律 binary（image/* / video/* / font/* / application/octet-stream / 等）
  const subtype = ct.split("/")[1]?.split("+")[0];
  return { kind: "binary", subtype };
}
```

**行数估算**：≈ **80 行**（routing table 30 + routeContentType 20 + 注释 30）

---

## 4. 不明确点调研结论

### 4.1 fetch_url 走 SSRF 哪条路径？

**结论**：直接复用 `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/ssrf/ssrf-guard.ts` 第 53-118 行的 `ssrfGuard(rawUrl, ssrfConfig)`，与 browse_headless 完全同函数同 config 对象。**不新造、不特化、不开子资源 DNS 重绑定防护**（fetch_url 是单次请求不是导航，攻击面不放大；与 v0.1 现状对齐）。

**重定向链 SSRF**（一个真实不明确点）：undici 默认 `redirect: "follow"` 会在 fetch 内部跟 3-5 跳重定向，每跳的 host 不会回到 ssrfGuard。v0.5 的处理：
- **接受风险**：典型重定向（http→https 同 host、CDN 短链）不会跨 SSRF 边界；恶意重定向（200 OK → 302 → 169.254.169.254 元数据服务）理论存在
- **缓解**：fetch_url 默认 `max_redirects = 0`（**不跟随重定向**），把 3xx 当 didtn + 返回 Location header 给 caller，让 CC 显式二次调用 fetch_url（caller-tier SSRF 决策）。这比在 fetch 层重做 SSRF 守卫更简单（守 R-CI-02：不新造范式）+ 更安全（caller 显式 opt-in 每跳）
- **伪码修订（§3.1.3 第 4 步前）**：`redirect: "manual"` 替换 `redirect: "follow"`；resp.status 在 300-399 之间时 outcome=didnt + retrieval_method="redirect_not_followed" + data.location = resp.headers.get("location")

### 4.2 screenshot + pdf + network 复用 BrowseChannel 还是新 channel？

**结论**：**全部复用 BrowseChannel**（具体是 HeadlessChannel 子类），不新造 channel。变更放大率 ≤3（守 R-CHG-01 <5）：
- **加新工具**：1 处 registerXxxTool（screenshot/pdf/network 各 1） + 1 处 index.ts 装配 + 1 处 invariants 断言 = **3 处**
- **加新 action**（仅 pdf/network）：1 处 actionDispatch Map entry（INV-6 衍生） + 1 处 BrowseOptions 字段（types.ts） + 1 处 doXxx 函数（cdp-actions.ts） = **3 处**

**为什么不新 channel**：
- screenshot/pdf/network **是 BrowseChannel 的"出口变形"**（同走 navigate → CDP），只是输出格式不同（PNG / PDF / resource list）；包装成新 channel 等于"为了 3 个 action 复制整套 BaseChannel 契约 + 子进程管理 + fallback"，违反 R-ABS-02 内联差异率过低
- BrowseChannel.actionDispatch Map **设计本就是为这类 action 提供扩展点**（08 §3.2 + INV-6）；新加 entry 是该抽象的**预期用法**，不是绕过

**pageRef 支持（v0.5 不做）**：4 工具只接受 url，不接受 `@pN` / `@wN` rootRef。理由：
- v0.4 forest 的 RootRegistry 主要服务 `interact_observe` / `interact_act`，那是**有状态多步交互**的入口
- screenshot/pdf/network 是**无状态单次抓取**，每次都新开 navigate（chrome-devtools-mcp 默认每次 browse 调用都 lazy-spawn 一个新 page）
- 若 CC 已有 `@pN` 想复用 page：v0.6 forest 合并时再评估（推 v0.6 的 `interact_act(@pN, "screenshot")` 已可覆盖该用例）

### 4.3 大 PDF 落盘策略

**结论**：复用 `applyOutputEnvelope(text, refineHint, extension)` 落 base64 PDF 字符串到 `/tmp/lasso-output/@oN.pdf`，**mode 0o600**（INV-15 衍生 INV-34）。read_text 续页读 base64 字符串（CC 自行解码）。

**为什么不直接落二进制 PDF**：
- output-envelope 当前基于"字符串 spill"模型（v0.3 INV-15 锚定）；改 binary 落盘需扩 `read_text` → `read_resource(ref)` 支持二进制，触及 4 个文件（output-envelope / read-text / types / invariants），变更放大率 = 4 ≥ 阈值
- base64 编码损失 33% 空间但换最小改动；典型 PDF 100 KiB → base64 134 KiB → 仍远小于 STORE_CAP 64 MiB
- v0.6 若用户反馈"base64 PDF 不便用"，再评估 binary 路径（届时已有 4 工具实战数据）

** INV-34 衍生**：screenshot（PNG 走 writeState，已是二进制路径，**不经 envelope**）/ pdf（base64 经 envelope，落 .pdf）/ network（JSON 经 envelope，落 .txt）—— 三者**一致必经 applyOutputEnvelope 或 writeState**，INV-34 grep `applyOutputEnvelope\|writeState` 在 screenshot.ts / pdf.ts / network.ts 命中即合规。

### 4.4 chrome-devtools-mcp 上游工具名漂移（pdf / network_log / console）

**结论**：单点集中 + doctor 探测。
- 所有上游工具名（`pdf` / `network_log` / `console_log`）集中硬编码在 `src/browse/cdp-actions.ts`（与 doNavigate 等同档），漂移只改一处（守 INV-6 风格延伸）
- doctor CLI 扩一项 `cdp_mcp_pdf_tool_available`（v0.4 doctor 框架加一条 check），doctor 报告 `{status: "pass"|"warn", detail: "pdf tool available at chrome-devtools-mcp@<VER>"}` 给 caller 明确预期
- doPdf / doNetwork 在上游工具缺失时**不抛异常**，返回 `outcome=didnt + retrieval_method="upstream_unsupported:<action>" + next_step`，CC 据此降级（如 pdf 改用 browse_headless screenshot + 自己 OCR，或推后处理）

### 4.5 undici 版本与 redirect: "manual" 兼容性

**结论**：undici 7.x（v0.4 锁定 `^7.28.0`）已支持 `redirect: "manual"`（标准 Web API），返 `response.status = 30x` + `response.headers.get("location")`。零新增依赖。

---

## 5. 测试计划（vitest，新增 6 个 spec 文件，约 +400 行测试）

### 5.1 fetch-url.spec.ts（约 120 行，10 cases）

- **SSRF 拒私网**：mock ssrfGuard 返 `{allowed:false, reason:"private_ip:10.0.0.1"}` → fetch 不被调，返 outcome=didnt + retrieval_method=ssrf_blocked
- **SSRF 允许 fake-ip**：env `LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15` → 198.18.x.x 通过 → fetch 被调
- **content-type 分流 html**：mock resp headers `text/html; charset=utf-8` → body_kind=html，body_text 原样
- **content-type 分流 json**：`application/json` → body_kind=json
- **content-type 分流 binary**：`image/png` → body_kind=binary:png，body_text 是 base64
- **bounded output 落盘**：mock resp body 100 KiB → envelope.truncated=true + ref 形如 @oN
- **max_bytes 截断**：mock content-length > max_bytes → outcome=didnt + error content_length_exceeds_max
- **redirect 不跟随**：mock resp status=302 + location → outcome=didnt + retrieval_method=redirect_not_followed + data.location
- **4xx → didnt**：mock resp status=404 → outcome=didnt + error=http_404
- **timeout → unknown**：mock fetch reject AbortError → outcome=unknown + error 含 "abort"
- **INV-32 断言**：spec 里 `expect(subproc.acquireHttpClient).toHaveBeenCalledWith(origin)` 验证经连接池（不裸 fetch）

### 5.2 screenshot.spec.ts（约 60 行，5 cases）

- **SSRF 拒私网**：与 fetch_url 同路径同函数
- **经 headless.browse**：spy HeadlessChannel.browse → 验证调 `(url, "screenshot", {screenshot:{full:...}, wait_until:...})`
- **path 解析**：mock browse 返 `preview: "screenshot saved to /tmp/lasso-screenshot-<uuid>.png"` → data.path = `/tmp/lasso-screenshot-<uuid>.png`
- **full_page=true 透传**：args.options.full_page=true → browseOpts.screenshot.full=true
- **fallback 透传**：mock browse 返 fallback_used=true → screenshotResult.fallback_used=true（语义保留）

### 5.3 pdf.spec.ts（约 80 行，6 cases）

- **SSRF 拒私网**
- **经 headless.browse(url, "pdf", opts)**：spy HeadlessChannel.browse
- **base64 PDF 过 envelope**：mock browse 返 preview=<100KiB base64 str> → envelope.truncated=true + spill_path 形如 `/tmp/lasso-output/@oN.pdf`
- **extension=.pdf**：spec 验证 applyOutputEnvelope 第三参数被传 `.pdf`
- **mode 0o600**：spec 读 spill 文件 mode（fs.statSync），断言 `(mode & 0o077) === 0`（owner rw only）
- **上游 unsupported**：mock browse 抛 `upstream_pdf_error:tool_not_found` → outcome=didnt + retrieval_method=upstream_unsupported:pdf

### 5.4 network.spec.ts（约 80 行，6 cases）

- **SSRF 拒私网**
- **经 headless.browse(url, "network", opts)**
- **3rd-party 过滤**：构造 mock entries 含同 host + 跨 host → filter="3rd-party" → 只返跨 host
- **xhr 过滤**：filter="xhr" → 只返 initiatorType=xmlhttprequest
- **resource list 过 envelope**：500 条 entry → envelope.truncated=true
- **page_host 解析**：args.url=`https://example.com/a/b` → data.page_host=example.com

### 5.5 content-type-router.spec.ts（约 40 行，10 cases）

- text/html → html
- application/xhtml+xml → html
- application/json → json
- application/json; charset=utf-8 → json（charset 不影响）
- text/plain → text
- text/css → text
- text/csv → text
- image/png → binary:png
- application/octet-stream → binary:octet-stream
- application/pdf → binary:pdf

### 5.6 cdp-actions.spec.ts（约 60 行，4 cases）

- doPdf：mock McpClient.callTool("pdf",...) → preview=base64
- doPdf 上游 isError → throw
- doNetwork：mock McpClient.callTool("evaluate_script",...) → preview=JSON
- doConsole（v0.5 MVP 占位）：类似 doNetwork（如果有 console_log 上游工具用上游，否则 evaluate 注入）

### 5.7 集成测（test/integration/，约 +100 行，可选）

- **mock CDP 端到端**：fake McpClient + fake ssrfGuard + fake subproc → 4 工具完整路径走通
- **真实 chrome-devtools-mcp 跑**（手测，CI 不跑）：标记 `[integration]` skip in CI；手测清单见 parse6-acceptance.md（v0.5 新增，5-8 条）

### 5.8 INV-31..34 单测（在 check-invariants.spec.ts 追加，约 +60 行）

- INV-31：fetch-url.ts grep `ssrfGuard(url` 命中
- INV-32：fetch-url.ts grep `subproc.acquireHttpClient\|acquireHttpClient(` 命中 + grep `new Agent\(` 不命中
- INV-33：BrowseChannel.ts grep `actionDispatch\s*=\s*new Map` 块内含 `"pdf"` / `"network"` / `"console"` 三 entry
- INV-34：screenshot.ts / pdf.ts / network.ts 各 grep `applyOutputEnvelope\|writeState` 命中

---

## 6. 验收标准（引用 09 §2.6 + 细化；标 CI vs 手测）

> 09 §2.6 原文：「**v0.5 — 更多外部交互**：能力目标 = fetch/screenshot/pdf/network 等独立交互工具；交付 = F3.2.8（pdf）+ F3.2.15-17（fetch_url/console/perf trace）+ F3.12.4-7（fetch/screenshot/pdf/network 独立工具化）；验收标志 = 4 个新交互工具。」

### 6.1 CI 验收（全绿硬门槛）

- [ ] **30 + 4 = 34 条 INV 全绿**（INV-1..30 零回归 + INV-31..34 新增全过；`npm run check-invariants`）
- [ ] **850 + 30 = 880 TS tests 全绿**（v0.4 既有 850 零回归 + 新增 ~30 unit cases × 6 spec ≈ 180；保守估 +130；`npm test`）
- [ ] **144 Rust tests 全绿**（rust-helper/ 零改，cargo test 原样跑）
- [ ] **TypeScript build 零错**（`npm run build`；含 BrowseOptions 类型扩展无回退）
- [ ] **INV-6 actionDispatch Map 9 entry**（v0.4 8 条 + v0.5 新加 pdf/network/console 共 11 条，但 v0.5 实装时 pdf/network 算 2 个 + console 是否算 entry 视上游工具暴露而定；M0.5b/c 落地后断言至少 +2）
- [ ] **server.listTools() 含 9 个工具**（v0.4 既有 5 个 browse/desktop/interact_roots/observe/act + browserbase 条件 + read_text + doctor + search + v0.5 新加 fetch_url/screenshot/pdf/network 共 4 个；具体计数视 browserbase 条件开关）

### 6.2 功能验收（CI 集成测）

- [ ] `fetch_url(url:"https://example.com")` 返 InteractResult<FetchResult> + outcome=worked + body_kind=html
- [ ] `fetch_url` 私网 IP 拒（ssrfBlocked 路径与 browse_headless 同函数）
- [ ] `fetch_url` 100 KiB JSON 自动落盘 + envelope.truncated=true + ref 形如 @oN
- [ ] `screenshot(url:"https://example.com")` 返 path + outcome=worked
- [ ] `pdf(url:"https://example.com")` 返 envelope（base64 PDF 落 .pdf）+ outcome=worked（**前提：chrome-devtools-mcp@LOCKED 暴露 pdf 工具**；否则 outcome=didnt + retrieval_method=upstream_unsupported:pdf，标记 M0.5b Go/No-Go）
- [ ] `network(url:"https://example.com", options:{filter:"3rd-party"})` 返 resource_count + third_party_count + outcome=worked

### 6.3 性能验收（CI 跑 benchmark）

- [ ] **fetch_url vs browse_headless "snapshot"**：同 URL（如 https://example.com）p50 延迟 fetch_url ≤ browse_headless × 0.3（4× 改善目标，09 §2.6 + 13 §2.1 隐含）
- [ ] **fetch_url token 节省**：同 URL body bytes 返回 preview ≤4KiB（envelope）vs browse_headless snapshot ≥20KiB → ≥4× 节省（09 §1 验收）
- [ ] **screenshot PNG path 返回 < 1KiB**（只回路径不回 base64，与 v0.4 doScreenshot 行为一致）
- [ ] **pdf base64 envelope**：100 KiB PDF → preview 16 KiB + spill @oN.pdf（CC 用 read_text 续页）

### 6.4 手测验收（macOS + 真实 chrome-devtools-mcp，CI 跳过）

写入 `/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse6-acceptance.md`（约 8 条）：
- [ ] `fetch_url` 真实公网 URL（https://example.com / https://httpbin.org/json）返 expected content-type
- [ ] `fetch_url` 重定向链（https://httpbin.org/redirect-to?url=...）返 redirect_not_followed + location
- [ ] `screenshot` 真实 URL 存图可打开（PNG valid）
- [ ] `pdf` 真实 URL 存 PDF 可打开（PDF valid；若 chrome-devtools-mcp 不支持，记录 next_step）
- [ ] `network` 真实 URL（如 https://cdn.cloudflare.com 复杂页）返 ≥10 resources + 3rd-party 标记正确
- [ ] fake-ip 环境（Surge/Clash TUN）`fetch_url` 配 `LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15` 可通
- [ ] CC 端到端：CC 自选 fetch_url vs browse_headless（用 description 内嵌路由提示）—— 100 query 抽样，正确率 ≥80%
- [ ] CC 端到端：CC 用 read_text 续页 fetch_url 大响应（base64 PDF / 长 JSON）

### 6.5 边界守住（不做项审计）

- [ ] fetch_url schema `method` enum 只含 `GET` / `HEAD`（POST/PUT 不在 v0.5；防越界）
- [ ] screenshot/pdf/network **不经 fallback 链**（grep 调用 `decider.runWithFallback` 在 4 tool handler 中不出现；守 INV-23 衍生：fetch ↔ browse 不 fallback）
- [ ] fetch_url 不导出 cookie / 不带 Authorization header（除非 caller 显式 `opts.headers`）
- [ ] 4 工具 `openWorld=true`（fetch/screenshot/pdf/network 都触外网）+ `readOnly=true`（不发副作用，只抓）；annotations 与 browse_headless readOnly=false 区分（browse 可 click/fill）

---

## 7. 风险 + 实施顺序

### 7.1 风险 Register（v0.5 新增 6 项，与 09 §6 R1-R12 + 13 §5 D1-D10 叠加）

| ID | 风险 | 影响 | 概率 | 缓解 | 触发预警 |
|---|---|---|---|---|---|
| **🆕 F1** | chrome-devtools-mcp@LOCKED 不暴露 `pdf` 工具 | 中（M0.5b 砍 pdf） | 中 | doctor CLI 探测 + outcome=didnt + retrieval_method=upstream_unsupported 明确路径；M0.5b Go/No-Go | doctor 报 `cdp_mcp_pdf_tool_available=fail` |
| **🆕 F2** | PerformanceObserver 抓不全资源（如 SSRF-allowlisted fake-ip 透明代理改 timing） | 低（M0.5c 已知限制） | 中 | 文档化：network tool 是 JS-level 抓取，非 CDP Network-level；3rd-party 计数偏低时 hint "performance entries may be incomplete under proxy/TUN" | network tool 测试资源数 < 页面真实资源数 × 0.5 |
| **🆕 F3** | fetch_url 重定向链 SSRF 绕过（200 OK → 302 → 169.254.169.254） | 中（元数据服务泄露） | 低 | fetch 默认 `redirect: "manual"`（§4.1 决策）+ 3xx 返 didnt；caller 二次显式调 fetch_url 时再过 SSRF | security review |
| **🆕 F4** | 大 PDF base64 落盘性能（500 KiB PDF → 670 KiB base64 字符串 spill） | 低（一次性，<50ms） | 低 | applyOutputEnvelope 已有 16 MiB SINGLE_CAP + 64 MiB STORE_CAP 兜底；超限直接抛 + outcome=didnt | spill > 16 MiB 触发 SINGLE_CAP 异常 |
| **🆕 F5** | 4 工具经 BrowseChannel 导致 HeadlessChannel 子进程压力（每次 navigate lazy-spawn 一个新 page） | 低（chrome-devtools-mcp 已设计为此） | 已知 | SubprocessManager 僵尸回收（v0.1 已实装）+ 60s idle cleanup；4 工具典型场景不是高频 | 子进程数 > 10 |
| **🆕 F6** | 上游工具名漂移（pdf → generate_pdf / print_to_pdf 等） | 低（单点改 cdp-actions.ts） | 低 | doctor CLI 探测 + INV-6 dispatch Map 范式延伸；漂移只改 cdp-actions.ts 一处 | doctor 报工具名不匹配 |

### 7.2 实施顺序（4 工具**部分并行**，单人推荐串行 M0.5a → M0.5b → M0.5c）

```
M0.5a fetch_url（独立交付，最大收益 + 最小风险）
  ↓ 验收：fetch_url 真实公网可用 + SSRF 拒私网 + bounded output 落盘
M0.5b screenshot + pdf（共享 navigate 通路 + 共享 cdp-actions.ts）
  ↓ 验收：screenshot 真实 URL 存图 + pdf（若上游支持）存 PDF
M0.5c network（依赖 navigate 但实现路径独立：PerformanceObserver 注入）
  ↓ 验收：network 真实 URL 返 resource list + 3rd-party 过滤
收尾：INV-31..34 上线 + doctor 加 cdp_mcp_pdf_tool_available check + parse6-acceptance.md 手测清单
```

**并行性分析**：
- **M0.5a（fetch_url）与 M0.5b/c 完全独立**（不经浏览器、不经 BrowseChannel.actionDispatch Map），可并行开发（若有第二开发者）
- **M0.5b（screenshot/pdf）与 M0.5c（network）共享 BrowseChannel.ts 修改（同 actionDispatch Map）+ cdp-actions.ts（同文件新增函数）**，**强烈建议串行**（避免 merge conflict；02 §5.5 R-ABS-02 共享比例高，合并修改风险大）
- **单人推荐顺序**：M0.5a → M0.5b → M0.5c。理由：① M0.5a 独立交付给用户最快收益（CC 立即可用 fetch_url）；② M0.5b 把 BrowseChannel.actionDispatch Map 扩展模板跑通，M0.5c 是同模板的复制（最简）

### 7.3 与 v0.6+ 的衔接（不实现但预留扩展点）

- **pageRef 支持**（v0.6 forest 合并）：4 工具 schema 加可选 `page_ref?: string` 字段（v0.5 不实现，传则忽略 + warn）；v0.6 forest 合并后，screenshot/pdf/network 经 `interact_act(@pN, action)` 走统一入口，4 工具退化为 thin wrapper
- **fetch_url POST / PUT**（v0.6）：schema method enum 加 `POST`，加 `body` 字段；SSRF 不变；守 INV-31 衍生（POST 也必经 ssrfGuard）
- **network HAR 导出**（v0.7 F3.7.x 完整 perf trace）：v0.5 的 PerformanceObserver 路径作为兜底；CDP Network-level 抓取走新 `chrome-devtools-mcp` 上游工具（若暴露）或 evaluate + CDP overlay（v0.7 评估）
- **read_text binary 支持**（v0.6 若用户反馈强烈）：output-envelope 扩 binary spill；read_text 加 `format` 参数；INV-15 / INV-34 同时收紧

### 7.4 简单性自检（02 §0 + §6.3 review 三问）

| 刻度 | 评分 | 证据 |
|---|---|---|
| 交织度（Hickey） | 🟢 守住 | 4 工具不引入新 InteractResult 形状（复用 v0.1 类型）；不引入新 fallback 范式（4 工具不挂 fallback 链）；OutlineNode 不涉及；fetch_url 的 content-type-router 是单维度 Map 不缠绕 |
| 模块深度（Ousterhout） | 🟢 守住 | 4 工具 register 各 ≤150 行（<7 public API 上限）；cdp-actions.ts 3 函数各 ≤60 行；content-type-router 1 函数 ≤20 行；穿堂式方法 = 0（pdf/network 经 channel.browse() 是真实入口不是 pass-through） |
| 变更放大率（Ousterhout） | 🟢 守住 | 加新 tool = 3 处（registerXxx + index 装配 + INV 断言）；加新 action = 3 处（Map entry + types 字段 + doXxx）；均 <5 阈值 |
| 概念完整性（Brooks） | 🟢 守住 | 4 工具复用同一 InteractResult<T> 形状 + 同一 SSRF guard + 同一 applyOutputEnvelope + 同一 ToolAnnotations 范式 + 同一 description 风格（[Prefer X over Y] 路由提示）；不开第二套 HTTP 范式（fetch_url 走 SubprocessManager.acquireHttpClient，与 BraveChannel 同源） |

**R-CI-02 红线逐项核验**：

| 维度 | v0.4 既有 | v0.5 新增 | 是否第二套？ |
|---|---|---|---|
| SSRF 守卫 | ssrfGuard(url, config) | **同一函数**（fetch_url 入口直调） | 🟢 否 |
| HTTP 连接池 | SubprocessManager.acquireHttpClient(origin) | **同一函数**（fetch_url 复用） | 🟢 否 |
| Bounded output | applyOutputEnvelope | **同一函数**（pdf/network 复用；screenshot 复用 writeState） | 🟢 否 |
| Action dispatch | BrowseChannel.actionDispatch Map（INV-6） | **同一 Map**（追加 pdf/network/console 3 entry，不新造） | 🟢 否 |
| InteractResult 类型 | v0.1 定型 | **同一类型**（data 字段扩 4 个 result 形状） | 🟢 否 |
| 工具描述风格 | SEARCH/BROWSE_*_DESCRIPTION + [Prefer X] | **同风格**（4 段新描述同范式） | 🟢 否 |
| ToolAnnotations | readOnly/openWorld 四象限 | **同范式**（4 工具标 readOnly=true, openWorld=true） | 🟢 否 |

**review 三问自答（§6.3）**：
1. **是否引入第二套做法？** 否。4 工具全部复用既有范式（SSRF / 连接池 / envelope / dispatch Map）。
2. **新抽象暴露 what 还是 how？** what。`fetch_url(url, opts)` 暴露"取原始字节"不暴露"undici Agent + redirect manual"；`pdf(url, opts)` 暴露"PDF 字节"不暴露"CDP Page.printToPDF"。
3. **共享函数新增参数蔓延？** 否。applyOutputEnvelope 加 1 个 `extension` 参数（默认 .txt 向后兼容），不是按 caller 分流的 flag；cdp-actions.ts 的 doXxx 与既有 doNavigate 同档，不是被 caller 拉扯的共享函数。

---

## 文档结束

**本文档是 Lasso v0.5 文件/函数级执行计划**（parse6），是开发者「照着干」手册。落地 09 §2.6 + 08 §3.11 F3.12.4-7 的 v0.5 范围（4 个新交互工具：fetch_url / screenshot / pdf / network），守住 v0.4 零回归（850 TS + 30 INV + 144 Rust），新增 INV-31..34 共 4 条（总 34 条），新增 ~180 unit tests + 6 spec 文件。

**核心立场**：4 工具全部**复用**既有 SSRF / undici 连接池 / BrowseChannel.actionDispatch Map / output-envelope 范式，不引入新 BaseChannel、不动 Rust helper、不开第二套做法（守 R-CI-02 + 02 §5.5 R-ABS-02 + §6.3 review 三问）。fetch_url 是 caller-tier 决策工具（与 browse_headless 平行，不 fallback），screenshot/pdf/network 是 BrowseChannel 的专项出口（经 channel.browse 入口，隐式享受 fallback 链）。

**下游文档**（v0.5 启动后新建）：
- `/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse6-acceptance.md` —— v0.5 手测清单（8 条 macOS + 真实 chrome-devtools-mcp）
- `/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.6 —— v0.5 验收打勾（4 工具可调 + token 节省 ≥4×）

**相关文档路径**（绝对路径）：
- 主排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md`
- 主架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md`
- 全交互重设计：`/Users/wangdong/Documents/Project/cc-control-all/doc/13-全交互抓手重设计.md`
- 简单性清单：`/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md`
- v0.4 parse（本文档基线）：`/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse5.md`
- v0.5 实施目标代码：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/`
