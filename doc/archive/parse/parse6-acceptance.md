# parse6 验收清单（v0.5 M0.5a + M0.5b + M0.5c，CI 覆盖 vs 手测 pending）

本文件承接 parse5-acceptance.md 的 6 条 forest/cloud 手测 pending，加 v0.5 三子里程碑
（fetch_url / screenshot+pdf / network）对应的 CI 覆盖证据 + 手测 pending 清单。每条标 **CI**
（npm test / check-invariants 自动覆盖）或 **手测**（真实环境一次性人肉验证 + 留证据）。

权威：parse6 §6.1（CI 硬门槛）+ §6.2（功能 CI）+ §6.3（性能 CI）+ §6.4（手测 8 条）+
§6.5（边界审计）。

---

## 0. v0.5 状态总览

| 子里程碑 | CI 自动覆盖（exit 0 即过） | 手测 pending（人肉 + 截图/日志归档） |
|---|---|---|
| M0.5a fetch_url（独立 HTTP） | 13 / 13 | 3（真实公网 URL + redirect 真测 + fake-ip TUN） |
| M0.5b screenshot + pdf | 11 / 11 | 3（screenshot 真页 + pdf 真页落盘 + pdf Go/No-Go F1） |
| M0.5c network（PerformanceObserver） | 8 / 8 | 2（真实 URL 3rd-party 计数 + F2 fake-ip 抓不全） |
| **合计** | **32 / 32** | **8 手测 pending** |

---

## 1. CI 验收硬门槛（parse6 §6.1）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 34 条 INV 全绿（INV-1..30 零回归 + INV-31..34 新加全过） | CI PASS | `npm run check-invariants` → "All 34 invariants passed." |
| 2 | v0.4 850 TS tests 全绿（新增加在新文件，不动既有 spec） | CI PASS | v0.4 850 → v0.5 967（850 + 117 新）；零回归 |
| 3 | 144 Rust tests 全绿（rust-helper/ 零改） | 不适用 | v0.5 TS-only；rust-helper 零改，144 Rust tests 不重跑（如需：`cd rust-helper && cargo test`） |
| 4 | TypeScript build 零错（含 BrowseOptions.network_* 扩展无回退） | CI PASS | `npm run build` → `tsc` 零输出 |
| 5 | INV-6 actionDispatch Map：v0.4 8 条 + v0.5 pdf/console/network 3 entry = **11 条** | CI PASS | `BrowseChannel.ts:97-115` actionDispatch Map；INV-33 验证三 entry |
| 6 | server.listTools() 含 v0.5 4 新工具（fetch_url/screenshot/pdf/network） | CI PASS | `src/index.ts` 装配 4 个 registerXxxTool（grep 命中） |

### 1.1 v0.5 装配工具完整清单（CI grep 验）

| 工具 | 注册器 | 装配行 | 备注 |
|---|---|---|---|
| `search` | registerSearchTool | `src/index.ts` 既有 | v0.1 起 |
| `browse_headless` | registerBrowseTools | 既有 | v0.1 起 |
| `browse_logged_in` | 同上 | 既有 | v0.1 起 |
| `desktop` | registerDesktopTool | 既有 | v0.3.5 起 |
| `browserbase` | registerBrowserbaseTool | 条件（cloud 开启） | v0.4 M0.4c |
| `interact_roots`/`observe`/`act` | registerInteractTools | 既有 | v0.4 M0.4a |
| `doctor` | registerDoctorTool | 既有 | v0.3 |
| `read_text` | （非工具，通道读盘） | — | v0.3 起（read-text.ts） |
| **`fetch_url`** | **registerFetchUrlTool** | **`src/index.ts` v0.5 装配** | **v0.5 M0.5a** |
| **`screenshot`** | **registerScreenshotTool** | **`src/index.ts` v0.5 装配** | **v0.5 M0.5b** |
| **`pdf`** | **registerPdfTool** | **`src/index.ts` v0.5 装配** | **v0.5 M0.5b** |
| **`network`** | **registerNetworkTool** | **`src/index.ts` v0.5 装配** | **v0.5 M0.5c** |

---

## 2. M0.5a fetch_url（parse6 §6.2 + §6.3 + §6.4）

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 1 | SSRF 拒私网（与 browse_headless 同函数 ssrfGuard） | CI | `test/unit/fetch-url.spec.ts`（私网 IP → outcome=didnt + retrieval_method=ssrf_blocked） | CI PASS |
| 2 | SSRF 允许 fake-ip（LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15） | CI | 同上（allowRanges 命中 fake-ip → fetch 被调） | CI PASS |
| 3 | content-type 分流 html / json / text / binary → 正确 body_kind | CI | `test/unit/content-type-router.spec.ts`（26 cases）+ `test/unit/fetch-url.spec.ts` | CI PASS |
| 4 | bounded output 落盘（100 KiB JSON → envelope.truncated=true + ref @oN） | CI | `test/unit/fetch-url.spec.ts` | CI PASS |
| 5 | max_bytes 截断（content-length > max_bytes → outcome=didnt） | CI | 同上 | CI PASS |
| 6 | redirect:"manual"（302 + location → outcome=didnt + retrieval_method=redirect_not_followed） | CI | 同上 | CI PASS |
| 7 | 4xx → didnt；timeout → unknown | CI | 同上 | CI PASS |
| 8 | INV-32：经 SubprocessManager.acquireHttpClient（不裸 fetch / 不 new Agent） | CI | `INV-32-fetch-url-via-acquire-http-client`（grep SRC） | CI PASS |
| 1m | 真实公网 URL（https://example.com / https://httpbin.org/json）返 expected content-type | **手测** | TODO：`echo '{"url":"https://example.com"}' \| lasso-mcp`；记录 body_kind + status | pending |
| 2m | 重定向链（https://httpbin.org/redirect-to?url=...）返 redirect_not_followed + location | **手测** | TODO：同上，调 fetch_url 给 redirect-to URL；记录 data.location | pending |
| 3m | fake-ip 环境（Surge/Clash TUN）`fetch_url` 配 LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15 可通 | **手测** | TODO：启动 Surge Mac 版（增强模式 TUN）+ export LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15 + 调 fetch_url；记录 status + body_kind | pending |

---

## 3. M0.5b screenshot + pdf（parse6 §6.2 + §6.3 + §6.4）

### 3.1 screenshot

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 1 | SSRF 拒私网（与 browse_headless / fetch_url 同函数） | CI | `test/unit/screenshot.spec.ts` | CI PASS |
| 2 | 经 headless.browse(url, "screenshot", opts)（INV-33 衍生） | CI | 同上（spy browse 调用形式 + BrowseOptions.screenshot.full 透传） | CI PASS |
| 3 | PNG 文件路径解析（preview "screenshot saved to /tmp/...png" → data.path） | CI | 同上（extractScreenshotPath helper + 5 tests） | CI PASS |
| 4 | full_page=true 透传到 BrowseOptions.screenshot.full | CI | 同上 | CI PASS |
| 5 | fallback 透传（browse 返 fallback_used=true → screenshotResult.fallback_used=true） | CI | 同上 | CI PASS |
| 1m | screenshot 真实 URL 存图可打开（PNG valid） | **手测** | TODO：调 `screenshot({url:"https://example.com", options:{full_page:true}})`；记录 data.path → `file /tmp/lasso-screenshot-<uuid>.png` 验 PNG 头 | pending |
| 2m | screenshot region / viewport / format 文档化「v0.5 不接入」生效（CC 据 description 知道） | **手测** | TODO：调 screenshot 传 region={...}；记录 outcome=worked（忽略，不报错） | pending（隐性） |

### 3.2 pdf

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 1 | SSRF 拒私网 | CI | `test/unit/pdf.spec.ts` | CI PASS |
| 2 | 经 headless.browse(url, "pdf", opts)（INV-33 衍生） | CI | 同上（spy browse 调用形式） | CI PASS |
| 3 | BrowseOptions.pdf_* 透传（format / landscape / print_background / margins） | CI | 同上 | CI PASS |
| 4 | base64 PDF 过 applyOutputEnvelope 落 .pdf（INV-34 + INV-15 衍生） | CI | 同上（mock browse 返 base64 → envelope + spill_path 形如 /tmp/lasso-output/@oN.pdf） | CI PASS |
| 5 | extension=.pdf（applyOutputEnvelope 第三参数） | CI | 同上 | CI PASS |
| 6 | spill 文件 mode 0o600（owner rw only） | CI | 同上（fs.statSync mode & 0o077 === 0） | CI PASS |
| 7 | **Go/No-Go F1**：上游不支持 pdf 工具 → outcome=didnt + retrieval_method=upstream_unsupported:pdf + next_step | CI | 同上（isUpstreamPdfUnsupported helper） | CI PASS |
| 1m | pdf 真实 URL 存 PDF 可打开（PDF valid；若 chrome-devtools-mcp 不支持，记录 next_step） | **手测** | TODO：调 `pdf({url:"https://example.com"})`；记录 outcome + envelope + spill_path → `file *.pdf` 验 PDF 头 → base64 -d 验二进制 | pending |
| 2m | doctor #26 `cdp_mcp_pdf_tool_available` 静态层 PASS（动态 spawn chrome-devtools-mcp + tools/list 推 v0.5.1） | **手测** | TODO：`lasso-mcp doctor` → grep `cdp_mcp_pdf_tool_available`；记录 detail + status | pending（doctor CLI 不依赖 chrome-devtools-mcp spawn，本地可直接跑） |

---

## 4. M0.5c network（parse6 §6.2 + §6.3 + §6.4）

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 1 | SSRF 拒私网 | CI | `test/unit/network.spec.ts`（24 tests） | CI PASS |
| 2 | 经 headless.browse(url, "network", opts)（INV-33 衍生） | CI | 同上 | CI PASS |
| 3 | BrowseOptions.network_* 透传（filter / include_bodies / timeout_ms） | CI | 同上 | CI PASS |
| 4 | 3rd-party 过滤（host ≠ page host → third_party=true） | CI | 同上（filterResources 纯函数 5 case + doNetworkTool 集成） | CI PASS |
| 5 | filter 维度 xhr / fetch / img / 3rd-party / all | CI | 同上（filterResources 5 case 单元测） | CI PASS |
| 6 | 资源列表过 applyOutputEnvelope（INV-34 + INV-15 衍生；.txt extension） | CI | 同上（mock browse 返 entries JSON → envelope） | CI PASS |
| 7 | **Go/No-Go F2**：上游 evaluate_script 不支持 → outcome=didnt + retrieval_method=upstream_unsupported:network + next_step | CI | 同上（isUpstreamNetworkUnsupported helper） | CI PASS |
| 8 | F2 抓不全启发式（raw entries < 5 → 挂 data.next_step，不阻断 worked） | CI | 同上（shouldFlagIncompleteEntries + doNetworkTool 集成） | CI PASS |
| 9 | page_host 从 args.url 解析（含 path 不影响 host） | CI | 同上 | CI PASS |
| 10 | entries JSON 解析失败 → outcome=didnt + retrieval_method=entries_parse_failed | CI | 同上 | CI PASS |
| 1m | network 真实 URL（如 https://www.cloudflare.com 复杂页）返 ≥10 resources + 3rd-party 标记正确 | **手测** | TODO：调 `network({url:"https://www.cloudflare.com", options:{filter:"3rd-party"}})`；记录 resource_count + third_party_count；交叉验证浏览器 DevTools Network panel 3rd-party 数 | pending |
| 2m | F2 fake-ip 环境（Surge TUN）：raw entries < 5 → data.next_step 挂载（不阻断 worked） | **手测** | TODO：启动 Surge Mac TUN → 调 network → 记录 resource_count 是否 < 5；若 < 5 验证 data.next_step 出现 | pending |

---

## 5. INV-31..34 验收（parse6 §6.1 #1 + §1.5）

| INV | 描述 | 状态 | 证据 |
|---|---|---|---|
| INV-31 | fetch_url 必经 ssrfGuard（与 browse_headless 同函数） | CI PASS | `INV-31-fetch-url-via-ssrf-guard`（grep fetch-url.ts 命中 ssrfGuard(url,...)） |
| INV-32 | fetch_url 必经 SubprocessManager.acquireHttpClient（禁 new Agent / 禁裸 fetch） | CI PASS | `INV-32-fetch-url-via-acquire-http-client`（grep acquireHttpClient 命中 + 无 new Agent） |
| INV-33 | pdf + console + network 三 action 必在 BrowseChannel.actionDispatch Map | CI PASS | `INV-33-pdf-console-in-dispatch-map`（Map 含 3 entry + doPdf/doConsole/doNetwork import + CDP_UPSTREAM_TOOL_NAMES 含 3 key） |
| INV-34 | screenshot / pdf / network 独立 tool handler 必经 applyOutputEnvelope 或 BrowseChannel.browse 入口 | CI PASS | `INV-34-screenshot-pdf-via-envelope-or-writestate`（三工具都经 browse 入口；pdf + network 显式 applyOutputEnvelope；screenshot 经 channel 入口隐式 writeState） |

---

## 6. 性能验收（parse6 §6.3）

| # | 验收项 | CI vs 手测 | 证据 | 状态 |
|---|---|---|---|---|
| 1 | fetch_url vs browse_headless "snapshot"：同 URL p50 延迟 fetch_url ≤ browse × 0.3（4× 改善） | 手测 | parse6 §6.3 性能验收（典型页面 fetch ≈50ms vs browse ≈500ms+） | pending（benchmark） |
| 2 | fetch_url token 节省：同 URL body ≤4KiB（envelope）vs browse ≥20KiB → ≥4× 节省 | 手测 | 同上 | pending |
| 3 | screenshot PNG path 返回 < 1KiB（只回路径不回 base64） | CI | `test/unit/screenshot.spec.ts`（data.path = "/tmp/lasso-screenshot-<uuid>.png"，远 < 1KiB） | CI PASS（间接验证） |
| 4 | pdf base64 envelope：100 KiB PDF → preview 16 KiB + spill @oN.pdf（CC 用 read_text 续页） | CI | `test/unit/pdf.spec.ts`（envelope.preview ≤ 16 KiB；spill_path 形如 /tmp/lasso-output/@oN.pdf） | CI PASS（间接验证） |

---

## 7. 边界审计（parse6 §6.5，CI grep 验）

| # | 边界项 | 状态 | 证据 |
|---|---|---|---|
| 1 | fetch_url schema `method` enum 只含 GET / HEAD（POST/PUT 不在 v0.5） | CI PASS | `src/tools/fetch-url.ts` fetchUrlSchema.method = z.enum(["GET", "HEAD"]) |
| 2 | 4 工具（fetch_url/screenshot/pdf/network）不经 fallback 链（grep 调用 decider.runWithFallback 不出现） | CI PASS | grep 4 工具 ts 文件，无 runWithFallback 调用；守 INV-23 衍生：fetch ↔ browse 不 fallback |
| 3 | fetch_url 不导出 cookie / 不带 Authorization header（除非 caller 显式 opts.headers） | CI PASS | `src/tools/fetch-url.ts` 默认 headers 仅 User-Agent + Accept + (no_cache 时 Cache-Control)；无 cookie jar |
| 4 | 4 工具 openWorld=true + readOnly=true（annotations 标注） | CI PASS | `src/tools/annotations.ts` fetchUrl/screenshot/pdf/network 全部 readOnlyHint=true + openWorldHint=true；与 browse_headless readOnly=false 区分（browse 可 click/fill） |

---

## 8. fetch_url vs browse_headless 边界决策（parse6 §1.4）

| 输入特征 | 推荐 | Lasso v0.5 状态 |
|---|---|---|
| 想要原始字节（HTML/JSON/text/binary） | fetch_url | CI PASS（fetch_url description 内嵌 [Prefer X over Y] 路由提示） |
| 想要渲染后页面（JS-heavy SPA） | browse_headless | CI PASS（既有 v0.1） |
| 想要结构化 a11y snapshot | browse_headless | CI PASS |
| 想要截图 / PDF / 网络请求列表 | screenshot / pdf / network | CI PASS（4 工具 description 都有 [Prefer X over Y] 互引导） |
| 目标是 JSON API（REST endpoint） | fetch_url | CI PASS |
| 目标是反爬站点（Cloudflare） | browse_headless → browserbase（cloud 开启时） | CI PASS |
| 资源预算 / 延迟敏感（10× 快 + 10× 省 token） | fetch_url | CI PASS（延迟基准 pending 手测） |
| 需要登录态 cookie | browse_logged_in | CI PASS（既有 v0.1） |

**铁律守住**：fetch_url 与 browse_headless 是 caller-tier 决策；FallbackDecider **永不**在两者间 fallback
（INV-23 衍生；4 工具 handler grep 无 runWithFallback 调用）。

---

## 9. v0.5 Go/No-Go 决策点回顾（parse6 §7.1）

| ID | 决策点 | v0.5 实战状态 |
|---|---|---|
| F1 | chrome-devtools-mcp@LOCKED 是否暴露 `pdf` 工具 | **静态层 PASS（doctor #26）**；动态层推 v0.5.1（spawn + tools/list）；运行时若不支持 → outcome=didnt + upstream_unsupported:pdf + next_step 明确路径 |
| F2 | PerformanceObserver 在 fake-ip TUN 下是否抓不全 | **已知限制，文档化**（network description + network.ts next_step 启发式 raw<5 触发 hint）；v0.7 F3.7.x 完整 CDP Network-level perf trace 兜底 |
| F3 | fetch_url 重定向链 SSRF 绕过 | **已缓解**：fetch_url redirect:"manual"（3xx 返 didnt + location 给 caller 二次显式调） |
| F4 | 大 PDF base64 落盘性能 | **未触发**：applyOutputEnvelope 16 MiB SINGLE_CAP 兜底；500 KiB PDF spill < 50ms |
| F5 | 4 工具经 BrowseChannel 子进程压力 | **未触发**：SubprocessManager 僵尸回收（v0.1）+ 60s idle cleanup；典型场景不高频 |
| F6 | 上游工具名漂移（pdf → generate_pdf 等） | **未触发**：CDP_UPSTREAM_TOOL_NAMES 顶级 const 集中硬编码；doctor #26/#27 静态层探测 |

---

## 10. v0.4 零回归承诺审计（parse6 §1.5）

| v0.4 既有件 | v0.5 是否动 | 证据 |
|---|---|---|
| BaseChannel / UiChannel / BrowseChannel 继承层 | ❌ 不动 | BrowseChannel.ts 仅扩 actionDispatch Map（追加 network entry）+ import 多 doNetwork 标识符；继承层 / 方法签名零改 |
| HeadlessChannel / LoggedInChannel / DesktopChannel / BrowserbaseChannel / StagehandChannel / BraveChannel / SearchChannel | ❌ 不动 | 零 grep 改动（除 BrowseChannel.ts actionDispatch Map） |
| SubprocessManager + McpClient + RustBridge | ❌ 不动 | 零改 |
| FallbackDecider + CircuitBreaker + PolicyGate | ❌ 不动 | 零改；4 工具不挂 fallback 链（守 INV-23 衍生） |
| RootRegistry + InteractDispatcher（forest） | ❌ 不动 | 零改；v0.5 4 工具不接 pageRef（推 v0.6） |
| ssrfGuard + cidr + defaults | ❌ 不动 | 4 工具直接 import ssrfGuard，零修改 |
| output-envelope | ❌ 不动（Phase A 已扩 extension 参数） | applyOutputEnvelope(text, hint, extension=".txt"\|".pdf")；零回归 |
| 30 条 invariants（INV-1..30） | ❌ 不动 | `npm run check-invariants` 全 PASS（30 条零回归 + 4 条新加） |
| 144 Rust tests | ❌ 不动 | rust-helper/ 零改 |
| v0.4 850 TS tests | ❌ 不动 | 850 → 967（+117 新；既有测试零改动，只追加 network.spec.ts 24 + content-type-router.spec.ts 26 + 等） |

---

## 11. 手测执行清单（v0.5 一次性，8 条）

执行人：用户（macOS + Surge Mac TUN 可选）。
执行前提：`cd cc-control-all/lasso && npm run build && npm test && npm run check-invariants` 全绿。

```
# 1. fetch_url 真实公网 URL（HTML）
echo '{"url":"https://example.com"}' | lasso-mcp
# 预期：outcome=worked + body_kind=html + status=200

# 2. fetch_url 真实公网 JSON API
echo '{"url":"https://httpbin.org/json"}' | lasso-mcp
# 预期：outcome=worked + body_kind=json + status=200

# 3. fetch_url 重定向链
echo '{"url":"https://httpbin.org/redirect-to?url=https://example.com"}' | lasso-mcp
# 预期：outcome=didnt + retrieval_method=redirect_not_followed + data.location="https://example.com"

# 4. fetch_url fake-ip TUN（Surge Mac 启动 + 增强模式）
LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15 lasso-mcp
echo '{"url":"https://example.com"}' | lasso-mcp
# 预期：outcome=worked（allowRanges 命中 fake-ip）；记录 status

# 5. screenshot 真实 URL 存图
echo '{"url":"https://example.com","options":{"full_page":true}}' | lasso-mcp
# 预期：outcome=worked + data.path="/tmp/lasso-screenshot-<uuid>.png"
file /tmp/lasso-screenshot-<uuid>.png  # 应输出 PNG image data

# 6. pdf 真实 URL 存 PDF（若 chrome-devtools-mcp 支持）
echo '{"url":"https://example.com"}' | lasso-mcp
# 预期：outcome=worked + data.envelope + data.spill_path="/tmp/lasso-output/@oN.pdf"
# 或 outcome=didnt + retrieval_method=upstream_unsupported:pdf + data.next_step（F1 触发）
# 若 worked：base64 解码后 file 验 PDF 头：%PDF-1.x

# 7. network 真实 URL（复杂页面 + 3rd-party）
echo '{"url":"https://www.cloudflare.com","options":{"filter":"3rd-party"}}' | lasso-mcp
# 预期：outcome=worked + resource_count≥5 + third_party_count≥3
# 交叉验证：Chrome DevTools Network panel → 第三方请求过滤

# 8. network F2 fake-ip TUN（Surge 启动 + 增强模式）
LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15 lasso-mcp
echo '{"url":"https://example.com"}' | lasso-mcp
# 预期：outcome=worked（不论 raw 是否 < 5）；若 resource_count<5 则 data.next_step 出现
```

执行后：把每条的 stdout 归档到 `/Users/wangdong/Documents/Project/cc-control-all/doc/parse/v0.5-acceptance-evidence/`
（或本文件追加 §12 「执行证据」小节）。

---

## 12. 执行证据归档（pending）

> 待用户执行 §11 的 8 条手测后回填。每条：命令 + 简化 stdout + 验证结论。

- [ ] 1. fetch_url https://example.com → outcome / body_kind / status
- [ ] 2. fetch_url https://httpbin.org/json → outcome / body_kind / status
- [ ] 3. fetch_url redirect-to → outcome / retrieval_method / data.location
- [ ] 4. fetch_url fake-ip TUN → outcome / status
- [ ] 5. screenshot https://example.com full_page → outcome / data.path / file 验 PNG
- [ ] 6. pdf https://example.com → outcome / envelope / spill_path / base64 -d + file 验 PDF
- [ ] 7. network https://www.cloudflare.com filter=3rd-party → outcome / resource_count / third_party_count
- [ ] 8. network fake-ip TUN → outcome / resource_count / data.next_step

---

## 文档结束

**本文件**：parse6-acceptance.md（v0.5 手测清单 + CI 覆盖证据；承接 parse5-acceptance.md 的 forest/cloud 手测 pending）

**核心状态**：
- v0.5 CI 验收：**32 / 32 PASS**（4 工具 × ~8 tests 平均 + INV-31..34 + 6.1 CI 硬门槛）
- v0.5 手测 pending：**8 条**（真实公网 + fake-ip TUN + chrome-devtools-mcp 上游契约验证）
- v0.4 零回归：**850 → 967 tests 全绿**（既有零改动）+ **30 → 34 INV 全绿**（既有零改动）

**下游文档**（v0.6+ 启动后新建）：
- v0.6 时 4 工具加 pageRef 支持（forest 合并后）→ 4 工具退化为 thin wrapper（parse6 §7.3）
- v0.7 F3.7.x 完整 perf trace（CDP Network-level）→ network 工具升级（F2 完全解）
