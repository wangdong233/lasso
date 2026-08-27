# parse16 — Obscura + proxy-chain v1.8 可行性 spike 报告

> **作者**：Lasso v1.8 功能分析师（spike 决策报告）
> **日期**：2026-08-10
> **性质**：v1.8 = **可行性 spike**（doc/16 §5 P3 + §7 v1.8），非确定实施。本报告回答：Obscura 能否作为 Lasso 高级反检测后端？proxy-chain 能否加 IP 层旋转？若不可行或不值得，诚实说并建议 defer。
> **原料**：白盒源码审查（Obscura 8 crate workspace 全 + proxy-chain src/ + Lasso `SubprocessManager.ts`/`StealthEngine.ts`/`HeadlessChannel.ts`/`BrowseChannel.ts`）+ doc/16 全文 + 架构想法/03 审查清单
> **立场红线**：拒绝猜测（每条引源码/repo 证据）+ 诚实（不为「完成路线」强行实施）+ v1.7 零回归

---

## 0. TL;DR（3 句裁决）

1. **Obscura = NO-GO（当前）**。两个白盒证据决定性：(a) Obscura **不渲染像素**（`docs/Connect-Puppeteer-or-Playwright.md`「Not supported: `page.screenshot`: obscura doesn't render pixels」），而 Lasso `BrowseChannel.ts:102/623` 的 `screenshot` action 是 CC 视觉理解页面的核心能力；(b) **doc/16 §2.4 的「TLS 层补强」判断在 Lasso 架构下不成立**——Lasso `browse_headless` 跑真实 Chromium（`HeadlessChannel.ts:56-66` spec `npx chrome-devtools-mcp --headless`），TLS 握手由 Chromium 的 BoringSSL 提供，本来就是真 Chrome 指纹；Obscura 的 wreq+BoringSSL stealth 是为 reqwest/rustls **非浏览器**客户端补的，对 Lasso 无补强价值。叠加 CDP 子集实现（README CDP API 表 ~36 个 method vs Chrome 数百个）、自实现 DOM（非 Blink，MarkdownExtractor 保真度风险）、v0.1.x + 发布工程缺陷（stealth build `continue-on-error:true` 可能静默 ship 无 stealth 二进制），Obscura 不应进 Lasso fallback 链。

2. **proxy-chain = 技术可行，业务 DEFER**。`prepareRequestFunction` per-connection 动态返 `upstreamProxyUrl`（`README.md`）能做 IP 旋转，Apache-2.0 + v2.5.9 成熟（Apify/Crawlee 在用）+ Node/TS 同栈，接入代价低（HeadlessChannel spec 加 `--proxy-server`）。但当前**无「IP 被封」真实用户反馈**（doc/16 §1.3 gap 清单无 IP 层项），加它 = 鼓励反封禁军备竞赛（与 Lasso「全交互抓手，非反爬引擎」定位冲突）+ 依赖付费住宅代理池（用户成本 + 合规灰色）。**defer 到有真实 IP 被封反馈再做**。

3. **v1.8 范围裁决：跳过实施，标 doc/16 §7 路线在 v1.7 后完成**。spike 的合法结论之一就是「不可行/不值得」——这不是路线失败，是 spike 诚实履职。v1.5（stealth P0 修复）→ v1.6（SteelChannel）→ v1.7（creepjs 门禁 + Stagehand 对齐）已是完整增量路线；v1.8 Obscura/proxy-chain 据 spike 结果不做，避免把不稳定外部依赖塞进已守住 R-CI-02 的架构。

---

## 1. Obscura 可行性 spike 判定（NO-GO）

### 1.1 基本信息（白盒源码直读）

| 字段 | 值 | 证据 |
|---|---|---|
| repo | `github.com/h4ckf0r0day/obscura` | — |
| license | **Apache-2.0** | `LICENSE` 全文 + `Cargo.toml` `workspace.package.license = "Apache-2.0"` 双重确认；与 Lasso MIT 兼容 |
| 版本 | **v0.1.0**（workspace）/ release **v0.1.11**（2026-07-26「Concurrency Release」） | `Cargo.toml` `version = "0.1.0"`；search_doc v0.1.11 |
| 语言 | **Rust**（8 crate workspace） | `Cargo.toml` members：obscura-dom/net/browser/cdp/js/mcp/cli/lib |
| 渲染栈 | **自实现 DOM**（`obscura-dom`）+ **V8 经 deno_core**（`obscura-js`）+ **Servo html5ever/cssparser** 解析；**非 Blink/WebKit**，**无像素渲染** | `Architecture-overview.md`「obscura-dom DOM tree implementation」+ `Cargo.toml` `html5ever="0.29"` `servo_arc="0.4"` |
| CDP | **子集实现**（~36 method） | `README.md`「CDP API」表：Target 5 / Page 4 / Runtime 4 / DOM 5 / Network 6 / Fetch 4 / IO 2 / Storage 3 / Input 2 / LP 1 |
| TLS stealth | `--stealth` flag 切 `wreq` + BoringSSL（默认 build 用 `reqwest 0.12` + `rustls-tls`，非浏览器指纹） | `Configure-stealth-and-proxies.md` + `Cargo.toml` `reqwest = { features = ["rustls-tls"] }` + Architecture「Stealth」段 |
| 商业导向 | README「Obscura Cloud hosted version」+ 6 个住宅代理 sponsor（SX/NodeMaven/ProxyEmpire/9Proxy/Rapidproxy/Thordata）带折扣码 | `README.md` Sponsors 段 |

### 1.2 决定性 NO-GO 证据 1：不渲染像素 → Lasso screenshot action 失效

Obscura `docs/Connect-Puppeteer-or-Playwright.md`「Not supported」原文：

> - `page.screenshot`: obscura doesn't render pixels.

Obscura README 的 CDP API 表**未列出** `Page.captureScreenshot`（Page 域只实现 navigate/getFrameTree/addScriptToEvaluateOnNewDocument/lifecycleEvents）。

Lasso 白盒现状（`src/channels/BrowseChannel.ts`）：

```
:102  ["screenshot", doScreenshot],          # actionDispatch Map 核心条目
:623  await c.callTool("take_screenshot", {  # chrome-devtools-mcp 的 take_screenshot 工具
:626    fullPage: opts.screenshot?.full ?? false,
:628  return { preview: `screenshot saved to ${filePath}` };
```

`take_screenshot` 是 chrome-devtools-mcp 的核心工具，底层调 CDP `Page.captureScreenshot`。CC 用它做页面视觉理解（03 §2.3 项 4「UI/user-facing 改动须附 screenshot 作为 smoke 证据」）。

**结论**：ObscuraChannel 不能提供 `screenshot` action——这是 Lasso「全交互抓手」的核心能力之一。CC 在 ObscuraChannel 上是「半盲」的（只有 a11y 文本 snapshot，无视觉）。

### 1.3 决定性 NO-GO 证据 2：doc/16 §2.4「TLS 层补强」判断在 Lasso 架构下不成立（实质修正）

**doc/16 §2.4 原判断**：

> Lasso 的 StealthEngine 只在 CDP JS 层抹 navigator.webdriver/UA。Obscura 的 stealth 在 TLS ClientHello 层——这是 Lasso 通过 CDP 注入永远够不到的一层……反检测站点先看 TLS JA3 再看 JS，**Lasso 当前完全裸奔**。Obscura 把这层补上。

**白盒核查发现此判断有误**。Lasso `browse_headless` 的真实数据路径（`src/channels/HeadlessChannel.ts:56-66`）：

```ts
subproc.registerSpec("headless", {
  command: "npx",
  args: ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
         "--headless", "--isolated",
         "--disable-blink-features=AutomationControlled"],
  ...
});
```

chrome-devtools-mcp `--headless --isolated` **spawn 真实 Chromium 进程**（headless 模式）。Chromium 的网络栈是完整的 BoringSSL + 真 Chrome HTTP 栈——**TLS 握手（ClientHello/ALPN/cipher order/JA3）本来就是真实 Chrome 指纹**。headless 只影响渲染（无 GUI 窗口），网络栈与 headed Chromium **完全一致**。

所以「Lasso TLS 完全裸奔」为假。Lasso `browse_headless` 的 TLS 层 = 真实 Chromium 的 TLS 层 = 真 Chrome JA3。

**Obscura 的 TLS stealth 补的是什么？** Obscura 默认 build 用 `reqwest 0.12 + rustls-tls`（`Cargo.toml`），rustls 的 TLS 指纹 ≠ 浏览器指纹。`--stealth` 切到 `wreq + BoringSSL` 才呈现 Chrome 指纹。即 **Obscura 的 TLS stealth 是为「用 reqwest/rustls 的非浏览器 HTTP 客户端」补浏览器指纹**——这恰恰是 Obscura 自己造的坑（它不跑真实 Chromium，所以 TLS 栈得自己伪装）。

**对 Lasso 的含义**：Lasso 已经跑真实 Chromium，TLS 本来就是真的，Obscura 的 TLS stealth 对 Lasso **零边际价值**。doc/16 §2.4 把 Obscura 当成「Lasso 够不到的 TLS 层补强」是范畴误判——Lasso 够不到的不是 TLS 层（它有真 Chromium），而是「不开浏览器纯 HTTP 抓取时的 TLS 层」（Lasso 当前无此场景；search 通道是 SDK API 调用，TLS 指纹无关）。

这是 parse16 对 doc/16 §2.4 的**核心修正**，直接动摇「Obscura 对 Lasso 的核心价值」命题。

### 1.4 次级 NO-GO 证据：CDP 子集 + 自实现 DOM + v0.1.x 不稳定

| 风险 | 白盒证据 | 对 Lasso 影响 |
|---|---|---|
| **CDP 子集实现** | README CDP API 表 ~36 method；Chrome 完整 CDP 数百 method。chrome-devtools-mcp 工具表（navigate_page/take_snapshot/take_screenshot/click/fill/evaluate_script/press_key/wait_for/hover/drag/pdf...）对应多个 CDP method，逐工具兼容性未验 | ObscuraChannel 可能多个 action 报 method-not-found；逐工具测成本高 |
| **自实现 DOM** | Architecture「obscura-dom DOM tree implementation」+ Cargo.toml html5ever/servo_arc（Servo 组件，非 Blink）。Lasso MarkdownExtractor（defuddle 0.19.1 + turndown 7.2.4，doc/16 §1.2）依赖真实 DOM 结构 | 复杂 CSS/布局/重排页面 DOM 结构可能与 Chrome 有差异，defuddle 解析异常风险 |
| **v0.1.x + 发布工程缺陷** | release v0.1.11（2026-07-26）；search_doc「release workflow's `continue-on-error: true` on the stealth build step means a release can silently ship binaries without the stealth feature」 | 进生产 fallback 链 = 拿不稳定外部依赖赌稳定性；stealth build 可能静默缺失 = 用户以为开了 stealth 实际没有 |
| **单 V8 isolate 串行** | Architecture「Single V8 isolate」「All pages in a process share one V8 isolate. The isolate is single-threaded by design.」+ `OBSCURA_SCRIPT_DEADLINE_MS` 重 SPA 预算 | Lasso 单机低并发影响小，但是架构上限 |
| **作者信誉** | 仓库名 h4ckf0r0day（doc/16 §2.4 R-ECO-5 已标注）；代码本身读了无可疑行为 | 集成前需独立安全审查（已在 doc/16 标注） |

### 1.5 定位错配（根本性）

Obscura 的价值主张（README 性能表）：内存 30MB（Chrome 200+MB）、二进制 70MB、page load 85ms、startup 即时——**为「大规模 web scraping」省资源**。

Lasso `browse_headless` 的业务目标（doc/16 §0 立场红线）：「让 CC 能高效和浏览器交互」——**单次交互完整性 > 大规模并发省资源**。CC 需要：截图看页面、完整 CDP 交互（click/fill/hover/drag）、登录态复用（LoggedInChannel）。

Obscura 是 scraping 引擎（省内存/并发/TLS stealth/不渲染像素），Lasso 要的是交互抓手（截图+完整 CDP+登录态）。**正交甚至冲突**。

### 1.6 Obscura 唯一真实能力（诚实承认）及其对 Lasso 的有限价值

Obscura 的 TLS stealth（wreq+BoringSSL）是**真实能力**，文档诚实声明局限（`Configure-stealth-and-proxies.md`「What stealth does not handle: Cloudflare interactive / Datadome / Akamai / CAPTCHAs / IP-based rate limiting」）。但如 §1.3 所证，这层对 Lasso（跑真实 Chromium）无补强价值。

Obscura 的 tracker blocklist（3520 域）对 Lasso 有轻微价值（减少追踪请求），但 Lasso 可通过 chrome-devtools-mcp 的 `setExtraHTTPHeaders`/网络拦截实现等价能力，不值得为此引入整个 Obscura。

### 1.7 Obscura 判定：**NO-GO（当前）+ 有条件未来重评**

```
条件 NO-GO → 未来重评触发条件（全部满足才重评）：
  (a) Obscura 加上像素渲染（Page.captureScreenshot 实现）
  (b) CDP 实现完整度提升到覆盖 chrome-devtools-mcp 全工具表
  (c) 版本到 v1.0 稳定 + 修发布工程 stealth build 缺陷
  (d) doc/16 §2.4 TLS 价值命题在 Lasso 架构下重新成立（极不可能——Lasso 不会放弃真实 Chromium）
```

---

## 2. proxy-chain 可行性判定（技术 GO / 业务 DEFER）

### 2.1 基本信息（白盒源码直读）

| 字段 | 值 | 证据 |
|---|---|---|
| repo | `github.com/apify/proxy-chain` | — |
| license | **Apache-2.0** | `package.json` `"license": "Apache-2.0"`；与 Lasso MIT 兼容 |
| 版本 | **v2.5.9**（成熟） | `package.json` `"version": "2.5.9"` |
| 维护方 | **Apify**（Crawlee 在用） | `README.md`「developed by Apify... also used by Crawlee」 |
| 语言 | **TypeScript/Node.js**（与 Lasso 同栈） | `src/*.ts` + `tsconfig.json` |
| 核心能力 | `anonymizeProxy(url)` 起本地无密码代理转发带密码上游 + `prepareRequestFunction` **per-connection 动态选 upstreamProxyUrl** + HTTP/HTTPS/SOCKS4/5 + 流量统计 | `README.md` Helper functions + Server config |

### 2.2 IP 旋转机制（技术 GO 的证据）

`proxy-chain` 的 `prepareRequestFunction`（`README.md`）：

```js
prepareRequestFunction: ({ request, username, password, hostname, port, isHttp, connectionId }) => {
    return {
        requestAuthentication: ...,
        upstreamProxyUrl: `http://user:pass@proxy${rotationIndex++}.example.com:3128`,
    };
},
```

每个连接（HTTP request 或 HTTPS CONNECT tunnel）调一次 `prepareRequestFunction`，返回的 `upstreamProxyUrl` 可动态变化 = **per-connection IP 旋转**。HeadlessChannel 的 chrome-devtools-mcp 启动 args 加 `--proxy-server=http://127.0.0.1:LOCAL_PORT`（指向 proxy-chain 起的本地代理），Chrome 所有流量经本地代理 → 按 prepareRequestFunction 逻辑分散到不同上游代理出口 IP。

**接入路径**（doc/16 §4「落入 Lasso 模块：HeadlessChannel 启动 args 加 `--proxy-server`」已规划）：
1. 新增 `src/browse/ProxyManager.ts`：管 `anonymizeProxy` 生命周期 + `prepareRequestFunction` 旋转逻辑（代理池配置 + 轮转策略）
2. `HeadlessChannel.ts` spec args 加 `--proxy-server=http://127.0.0.1:${proxyManager.localPort}`
3. config 加 `proxyPool: string[]`（用户配住宅代理 URL 列表）

**诚实限制**：Chrome 对 HTTPS 复用 CONNECT tunnel（keep-alive），同一域名同 tunnel 走同一代理。所以实际是 **per-connection-per-host 旋转**，不是严格 per-request。对「分散请求到多 IP」够用，对「同一域名每次 request 不同 IP」不够。

### 2.3 业务 DEFER 理由（代价/收益/ToS）

| 维度 | 分析 |
|---|---|
| **代价** | 低。~2-3 天（ProxyManager + HeadlessChannel spec + config + 测试）。Apache-2.0 兼容，Node/TS 同栈，对四通道零侵入（只 HeadlessChannel spec 加 flag） |
| **收益前提** | **用户必须有住宅代理池**。proxy-chain 只是代理转发器，不带 IP 池。住宅代理付费（Obscura sponsors 那些服务：SX/NodeMaven/ProxyEmpire... $0.65-0.68/GB 起）或自建（极复杂）。无代理池 = proxy-chain 无意义 |
| **真实痛点** | **当前无「IP 被封」用户反馈**。doc/16 §1.3 gap 清单（13 条）无一条 IP 层；P0 是 stealth 缺失（v1.5 已修规划），P1 是 viewport/header/cookie，P2 是 UA/指纹/QuotaLedger。加 proxy-chain 是**预防性能力，非修复已知痛点** |
| **ToS/合规** | 住宅代理有合规灰色地带（终端用户分享带宽，部分代理来源不透明）；绕 IP 封禁可能违反目标站点 ToS；Lasso 定位「全交互抓手」非「反爬引擎」，IP 旋转是「反封禁」能力，与定位有张力 |
| **定位冲突** | doc/16 §4 关键认知：「企业级反爬通过率不是 Lasso 的业务目标……强反爬站点走 `browse_logged_in` 复用真实 Chrome」。IP 旋转服务于「大规模抓取不被封」，这正是 Lasso **明确不做的非目标** |
| **doc/16 自己的结论** | §8.2 开放问题 5：「proxy-chain 是正交能力。**v1.9+ 按需扩展——若用户实测试到 IP 被封场景，再引入**」——本 spike 确认此判断，不改 |

### 2.4 proxy-chain 判定：**技术 GO / 业务 DEFER 到 v1.9+ 或真实 IP 被封反馈**

defer 触发条件（满足任一即重评）：
- (a) 用户实测报告 `browse_headless`/`browse_logged_in` 因 IP 被封（非 JS/UA/header 指纹问题）
- (b) Lasso 明确新增「大规模抓取」业务线（当前无，doc/16 §6.4 已否决 Firecrawl 深度集成的同类理由）

---

## 3. 如果 GO：文件结构 + 实施计划

**Obscura = NO-GO，不实施。** 以下仅 proxy-chain 的未来 defer 触发后的实施设计（轻量，供未来重评参考）。

### 3.1 proxy-chain 实施计划（defer 触发后，~2-3 天）

```
src/browse/ProxyManager.ts          [新] 管 anonymizeProxy 生命周期 + prepareRequestFunction 旋转
src/browse/proxy-pool.ts            [新] 代理池配置（从 config/invariants 读，INV 守 top-level const）
src/channels/HeadlessChannel.ts     [改] spec args 条件加 --proxy-server（当 ProxyManager 启用）
src/config/proxy-config.ts          [新] 用户代理池配置 schema
src/invariants/check-invariants.mjs [改] 加 INV-73：proxy 池配置只从顶级 const 读（仿 INV-30 stealth profile）
```

**关键不变量**（守 R-CI-02 / 03 §1.6）：
- ProxyManager 是 HeadlessChannel 内部增强，不新增 channel、不新增 fallback 范式
- 代理池配置是顶级 const（INV-73，仿 INV-30 anti-gaming），不从 env 动态读
- proxy-chain 作为 npm 依赖（Apache-2.0 兼容），不 vendored 源码

### 3.2 03 审查要点（proxy-chain 未来实施时）

- **§1.2 项 1 producer 契约**：`prepareRequestFunction` 的 `upstreamProxyUrl` 返回值形状（proxy-chain v2.5.9 README 契约）必须钉 fixture，断言 proxy-chain 升级时形状不变
- **§1.2 项 8 宿主执行环境**：Chrome `--proxy-server` 对 CONNECT tunnel 的复用行为须 L3 真机验证（per-host 旋转 vs per-request 旋转的实际边界）
- **§1.6 项 3 过工程化拒绝**：ProxyManager 不为「假想未来代理策略」加抽象（如 weighted/failover/health-check）——只做 round-robin，未来需要再加

---

## 4. NO-GO / DEFER 的诚实理由 + 替代方案

### 4.1 Obscura NO-GO 理由汇总（按严重度）

1. **[致命] 不渲染像素** → Lasso screenshot action 失效（§1.2）
2. **[致命] TLS stealth 价值命题不成立** → Lasso 跑真实 Chromium，TLS 本来就是真的；doc/16 §2.4 判断需修正（§1.3）
3. **[高] CDP 子集 + 自实现 DOM** → chrome-devtools-mcp 工具表逐工具兼容风险 + MarkdownExtractor 保真度风险（§1.4）
4. **[高] v0.1.x + 发布工程缺陷** → 不该进生产 fallback 链（§1.4）
5. **[中] 定位错配** → scraping 引擎 vs 交互抓手（§1.5）
6. **[中] Cloudflare 仍是天花板** → Obscura 文档诚实声明；TLS stealth 只对看 TLS 指纹的站点有效，对 Lasso 真实场景边际收益有限（§1.6）

### 4.2 proxy-chain DEFER 理由汇总

1. **无真实 IP 被封痛点** → doc/16 §1.3 gap 清单无 IP 层项（§2.3）
2. **依赖付费住宅代理池** → 用户成本 + 合规灰色（§2.3）
3. **与 Lasso 定位冲突** → IP 旋转服务反封禁，Lasso 明确不做反爬引擎（§2.3）
4. **doc/16 自己已规划 defer** → §8.2 开放问题 5「v1.9+ 按需」（§2.3）

### 4.3 替代方案（既然 Obscura/proxy-chain 不做，反检测能力够不够？）

**doc/16 §4 关键认知已回答此问题**（本 spike 确认，不修改）：

> 「企业级反爬通过率」不是 Lasso 的业务目标……JS 层 16 路 + header 一致性 + patchright flags 已经覆盖了绝大多数真实站点的**基础 bot 检测**（sannysoft / 公开页 / 一般 SERP）。Cloudflare Enterprise / Datadome / Kasada 这类硬目标不是 Lasso 的主战场（那些场景走 `browse_logged_in` 复用真实 Chrome）。

即 v1.5（stealth P0 修复：header-generator + 16 路 evasions + patchright flags）+ `browse_logged_in`（真实 Chrome + 真实指纹/扩展/历史，反检测最强）已经是 Lasso 业务目标的充分覆盖。Obscura/proxy-chain 是「边际增强」而非「能力解锁」。

**真正需要的反检测增强（已在 v1.5/v1.7 规划，非 v1.8）**：
- v1.5：JS 16 路 + header 一致性 + patchright flags（修 P0 业务功能缺失）
- v1.7：creepjs 作为 doctor stealth-check 回归门禁（隐身有效性度量衡）
- 持续：`browse_logged_in` 复用真实 Chrome 是最强反检测通道（天然带完整指纹）

---

## 5. v1.8 范围裁决：跳过实施，标 doc/16 §7 路线在 v1.7 后完成

### 5.1 裁决：跳过 v1.8 实施

据 spike 结果：
- Obscura NO-GO（§1）→ 不做 ObscuraChannel
- proxy-chain DEFER（§2）→ 不做 IP 层旋转

**v1.8 不产出代码**。doc/16 §7 路线图调整为：

```
v1.5  修 stealth P0 短板（header-generator + 16 路 evasions + patchright flags）   ← P0
v1.6  新增 SteelChannel（自托管 cloud 通道）                                       ← 最有价值新通道
v1.7  doctor 集成 creepjs 回归门禁 + 对齐 StagehandChannel                         ← 可观测性 + 修正
───── doc/16 §7 路线在此完成 ─────
v1.8  [跳过] Obscura NO-GO + proxy-chain DEFER（据 parse16 spike）                 ← spike 诚实履职
v1.9+ [按需] proxy-chain 待真实 IP 被封反馈；Obscura/Lightpanda 待成熟              ← 条件触发
```

### 5.2 这不是路线失败

spike 的合法结论之一就是「不可行/不值得」。doc/16 §0 立场红线明确：

> **诚实**：不为推荐而推荐，也不为「保持简单」而否决业务需要的能力。

本 spike 据白盒证据判定 Obscura 不兼容（不渲染像素 + TLS 价值不成立）+ proxy-chain 不值得当前做（无真实痛点）——这是诚实履职，不是路线失败。**强行实施 Obscura（明知不渲染像素会让 screenshot 失效）或 proxy-chain（明知无 IP 被封痛点）才是失败**——那会破坏 v1.7 零回归，把不稳定外部依赖塞进已守住 R-CI-02 的架构。

### 5.3 v1.7 零回归保证

v1.8 不产出代码 → 对 v1.5/v1.6/v1.7 已交付功能零回归风险。72 个 INV 仍全绿，R-CI-02 守住。

---

## 6. 03 审查预设

### 6.1 本 spike 无代码改动 → 03 审查 = 空审

parse16 是可行性 spike，产出的是**判定报告**非代码。Obscura NO-GO + proxy-chain DEFER → 零代码改动 → 03 §1 六维度 / §2 五阶段不触发。

### 6.2 但本 spike 自身据 03 标准做了「审查」（对 doc/16 §2.4 的修正）

本 spike 的核心贡献之一是据 03 §0.3 证据阶梯**修正 doc/16 §2.4 的 TLS 判断**：

| doc/16 §2.4 命题 | 证据阶梯 | parse16 修正 |
|---|---|---|
| 「Lasso 当前完全裸奔（TLS 层）」 | L0（断言，未引 Lasso 源码路径） | **证伪**：Lasso `HeadlessChannel.ts:56-66` 跑真实 Chromium（L1 源码证据），TLS 由 Chromium BoringSSL 提供 = 真 Chrome JA3 |
| 「Obscura 把 TLS 层补上」 | L0（假设 Obscura 补的是 Lasso 缺的层） | **范畴误判**：Obscura stealth 补的是「reqwest/rustls 非浏览器客户端」的 TLS 指纹（`Configure-stealth-and-proxies.md` L1），Lasso 跑真 Chromium 不缺这层 |

这印证 03 §0.3「注释/旧断言不是运行时证据」——doc/16 §2.4 的 TLS 判断是「想当然」断言（假设 Lasso TLS 裸奔），未回到 Lasso 源码验证 Lasso 跑的是什么。parse16 用 L1 源码证据（HeadlessChannel spec）修正之。

### 6.3 未来 proxy-chain 实施时的 03 审查预设（defer 触发后）

见 §3.2（producer 契约 + 宿主环境 + 过工程化拒绝三要点）。

---

## 附录 A：parse16 对 doc/16 的修正清单

| doc/16 位置 | 原判断 | parse16 修正 | 依据 |
|---|---|---|---|
| §2.4「TLS 层补强」 | 「Lasso 当前完全裸奔（TLS），Obscura 把这层补上」 | **证伪**：Lasso 跑真实 Chromium，TLS = 真 Chrome JA3；Obscura stealth 补的是非浏览器客户端的 TLS，对 Lasso 无价值 | `HeadlessChannel.ts:56-66`（L1）+ `Configure-stealth-and-proxies.md`（L1） |
| §5 建议５（P3 ObscuraChannel spike） | 「TLS 层 stealth fallback channel」前置验证 3 项 | **NO-GO**：再加第 0 项前置——「screenshot action 是否可用」（Obscura 不渲染像素，已证伪）；且 TLS 价值命题本身不成立 | `Connect-Puppeteer-or-Playwright.md`「Not supported: page.screenshot」+ §1.3 本报告 |
| §7 v1.8 | 「ObscuraChannel spike（TLS 层 stealth fallback），前置验证 3-5 天，通过则正式集成 1-2 周」 | **跳过 v1.8 实施**：spike 结果 NO-GO，路线在 v1.7 后完成 | §1 + §5 本报告 |
| §8.1 R-ECO-4「Obscura 渲染保真度未验证」 | 标「高风险」待 spike | **升级为 NO-GO 决定性证据**：不止保真度，是**根本不渲染像素** | `Connect-Puppeteer-or-Playwright.md` 原文 |

## 附录 B：未修改的 doc/16 判断（parse16 确认仍成立）

- §0 TL;DR 第 5 句路线图 v1.5→v1.6→v1.7（parse16 只把 v1.8 标跳过，前三段不动）
- §4 反检测对比表 + 「JS 路线对 Lasso 业务目标够用」关键认知
- §6 真正否决项（nodriver AGPL / undetected-chromedriver GPL / Botright GPL / Firecrawl AGPL / 自动 captcha / 签名纯算）
- §8.2 开放问题 5「proxy-chain v1.9+ 按需」（parse16 确认 defer，不改）
- §8.3 红线重申（license 硬约束 + 业务政策红线 + 诚实定位）

---

**报告结束**。parse16 据 8 份 Obscura 源码/文档 + 2 份 proxy-chain 源码 + 4 份 Lasso 源码 + doc/16 全文 + 架构想法/03 全文白盒审查，裁决：**Obscura NO-GO（不渲染像素 + TLS 价值命题在 Lasso 真实 Chromium 架构下不成立），proxy-chain 技术可行但业务 DEFER（无真实 IP 被封痛点），v1.8 跳过实施，doc/16 §7 路线在 v1.7 后完成**。核心新发现：修正 doc/16 §2.4「Lasso TLS 完全裸奔」的误判——Lasso 跑真实 Chromium，TLS 本来就是真的。v1.7 零回归保证（v1.8 无代码改动）。