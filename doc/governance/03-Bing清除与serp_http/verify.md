# verify —— v1.15 Phase A（Bing 死层清除）+ Phase B（serp_http 快探层）真机验证报告

> 验证员独立执行（2026-08-17）。验证 = L3 真机证据优先（03 §0.3 证据阶梯）：
> MCP stdio 驱动真实 `dist/index.js` server（`/tmp/lasso-verify/verify-driver.mjs`），
> 空 config / 假 key / SSRF deny 强制场景，真实网络（本机 ClashX TUN 环境）。
> **验证期间发现并修复 2 个真机缺陷**（hermetic 单测全测不出来），见 §3。

---

## 1. 验证总表（六项裁决）

| # | 验证项 | 裁决 | 真机证据 |
|---|---|---|---|
| 1 | Bing 清零（grep + 假 key 静默 + doctor retire 提示） | ✅ PASS | grep `BingChannel`/`"search.bing"` 零活代码命中（仅墓碑注释 + INV-54 守卫代码 + selftest pin，均 intentional）；`BING_API_KEYS=FAKE-…` 跑 search：`worked`、链中无 bing 档、不炸（fakebing 场景）；`lasso doctor` #11c `bing_keys_retired` = **warn** + detail「1 个 BING_API_KEYS 已配置，但 Bing Search APIs 已于 2025-08-11 全量退役…」+ next_step 建议删除（35 项检查全跑完，退出码与无 key 时一致） |
| 2 | serp_http 真机（空 config 中英各一 + actions_and_results + 时序） | ✅ PASS（修复后） | **EN**：`served_by=serp_http:brave`、count=20、top1 = "Tutorial \| Tokio - An asynchronous Rust runtime"（tokio.rs 真实结果）、整链 **1908ms**；actions_and_results = `[{zhipu,unknown,key missing},{serp_http,worked}]`，browse_headless **未被调**。**CN**：`served_by=serp_http:baidu`、count=17、1134–2283ms（百度软挡/壳页问题见 §3/§4） |
| 3 | 挡住才升浏览器（unknown → browse_headless 接管，链完整） | ✅ PASS（双路证据） | **真机制强制**（`LASSO_SSRF_DENY_RANGES=0.0.0.0/0,::/0`——serp_http 过 ssrfGuard 而内部 HeadlessChannel.browse 不经）：actions_and_results = `[{zhipu,unknown},{serp_http,unknown,serp_http_ssrf_blocked(10–13ms)},{browse_headless,worked}]`，EN/CN 各一次。**自然发生**（brave 429 限流）：`{serp_http,unknown}` → browse_headless 接管，链序正确 |
| 4 | 零回归（machine_mcp→zhipu 主路径 + 03 六维审查） | ✅ PASS | 真机 machine 场景（真实 `~/.claude.json`）：`machine_search_mcp_detected=true`、链序 `search.machine_mcp(2793ms,unknown) → search.zhipu(key missing) → serp_http → browse_headless` 与设计一致；httpSerp 未注入 = byte-identical（集成测试 3 条钉死）；npm test 2008 全绿（详见 §6 六维） |
| 5 | 门禁终跑 + version 1.15.0 三处（INV-63）+ 测试断言同步 + README 更新日志 | ✅ PASS（验证员补齐） | 实施报告遗留版本未动——验证员补：package.json / src/index.ts `LASSO_SERVER_VERSION` / src/doctor/doctor.ts `LASSO_VERSION` 三处 → **1.15.0**；4 处版本断言测试同步（doctor-v17 ×2、doctor-v10 ×1、doctor-cli ×1，改后全绿）；`node dist/index.js --version` → `1.15.0`；README.md 更新日志加 v1.15 条目 + 「当前版本 v1.15.0」 |
| 6 | 七语言 README 降级链同步（8 文件） | ✅ PASS（验证员补齐） | 实施报告只改了中文 README 链行——验证员补齐 en/ja/de/es/fr/pt/ru 七语言：各自 fallback 链行加 v1.15 裸 HTTP 快探句 + Bing 退役句、版本行 v1.15.0、changelog v1.15 条目（每语言 4 处 v1.15 命中）。8 文件 = README.md + 7 语言 |

---

## 2. 时序对比（真机量化，2026-08-17 本机）

| 场景 | 链路径 | 整链墙钟（tools/call 往返） | count | 结果质量 |
|---|---|---|---|---|
| EN `rust tokio tutorial`，空 key | zhipu(skip) → **serp_http:brave 命中**（ddg 202 挑战 → brave 级联 200） | **1908 ms** | 20 | 真实结果（top1 tokio.rs 官方教程） |
| EN `typescript async best practices`，空 key（首跑） | 同上命中 | 2249 ms | 20 | 真实结果 |
| CN `Rust 异步编程 入门教程`，空 key | **serp_http:baidu 命中**（完整 header 集下百度 200 直供 SERP） | 1134–2283 ms | 17 | 页面链接（见 §4 已知限制 L1） |
| EN，强制 serp_http 失效（SSRF deny） | serp_http 13ms 双引擎全拒 → **browse_headless** | **5304 ms** | **0** | brave 对真 Chrome 上验证码，0 可抽结果 |
| CN，强制同上 | serp_http 10ms 拒 → **browse_headless** | **5650 ms** | **0** | 0 可抽结果 |
| EN（brave 429 自然挡） | serp_http unknown → browse_headless | 5856 ms | 0 | 同上 |

**结论**：serp_http 命中时 **1.9s vs 浏览器路径 5.3–5.9s（2.8–3.1× 提速）**，且在本机网络下快探层是**唯一能产出真实结果的零 Key 路径**（真 Chrome 反吃 brave 验证码 → count 0，与 doc/governance/02 实测一致）。上表 browse 计时为 npx 缓存已预热口径（冷启动更慢）。

---

## 3. 验证期间发现并修复的真机缺陷（2 个，均已修复 + 回归测试钉死）

两个缺陷都是 hermetic 单测测不出的（fixture 未镜像真实 SERP 页形状）——03 §1.2「producer 契约须 L1/L2/L迹证据」的典型违例被真机抓出。

### DEF-1：brave 内联 `<style>` @font-face CSS 被抽取器当结果（伪造成功）
- **真机证据**：search.brave.com 实抓 246KB HTML，SvelteKit 内联 style 含十余条 `@font-face{src:url(https://cdn.search.brave.com/…woff2)}`；turndown 把 style 文本当正文 → a11y 抽取器按「带 URL 行」收割 → **20/20 全是字体 CSS 垃圾、0 条真实结果**，`outcome=worked`。
- **修复**（`src/serp/http-serp.ts`）：`stripNonContentBlocks`（style/script/noscript 整块剥，转换前）+ `dropMarkdownImages`（`![alt](url)` 图片语法删除，转换后）→ `serpHtmlToSnapshotText` 管线 = 剥块 → turndown → 删图片 → 摊平链接 → 剥 heading。修后真机：top1 = tokio.rs 官方教程，字体/缩略图 URL 零收割。归一化是无状态正则，非第二 selector（红线不破）。
- **回归测试**：`test/unit/serp-http.spec.ts` describe 12b（3 测：真机形态 fixture 含 @font-face + 图片 + 真实链接）。

### DEF-2：百度软挡（302 → wappass 验证码 / 首页壳）200 伪成功
- **真机证据**：裸 HTTP 打 `www.baidu.com/s`：简 header 集 → 302 → `wappass.baidu.com/static/captcha/tuxing_v2.html`（图形验证码，1438B）；完整 header 集（sec-ch-ua 全家桶 + zh-CN）→ 200 直供真实 SERP（818KB）。两种状态三道既有闸门全漏（状态 200、无 Cloudflare marker——百度不用 CF、count>0——导航链接被抽成 17 条 hao123/登录/帮助垃圾）。
- **修复**（`src/serp/http-serp.ts`）：**传输层形状校验**——fetch 终态 URL 的 host/path 与请求 SERP URL 不一致 → `unknown serp_http_redirect_blocked`（escalation-safe 命名，已入 §1.4 表驱动断言）。对三引擎通用（ddg anomaly 跳主页同理可拦）；mock Response 无 url 字段时防御性跳过。真机验证：redirect 场景正确升 browse_headless。
- **回归测试**：describe 12c（4 测：wappass 域拦 / 首页壳拦 / 同 host 同 path 合法重定向不误拦 / 无 url 字段不炸）。

修复后测试账目：serp-http.spec 30 → **38**（+8）；全仓 2000 → **2008**（零删除）。

---

## 4. 已知限制（如实记录，不在本次范围）

- **L1 百度自然结果不可直达**：百度自然结果链接是 `www.baidu.com/link?url=<opaque token>` 跳转壳（目标 URL 不在 href 里，与 ddg `uddg` 可解包不同），被共享抽取器 `SELF_HOST_RE` 排除 → serp_http:baidu 与 browse_headless:baidu **同样**只能抽到页面非跳转链接。解开需跟随跳转（N+1 请求），属 extract.ts 单一真源的后续演进，非 Phase B 缺陷（本机 browse 层 baidu 抽取为 0 条，serp_http:baidu 17 条页面链接严格更优）。
- **L2 browse_headless `worked` + count 0**：`scrapeEngineOnce` 对 preview 非空即返 worked（v1.14 既有语义，Phase B 未触碰）。真机 brave/浏览器验证码页即此形态。建议后续版本把「worked 但 0 抽取」改 unknown 升 replay/诚实返空（涉及 v1.14 行为变更，需单独裁决）。
- **L3 同步 turndown 转换阻塞事件循环**：818KB 百度页转换+抽取实测 ~70ms/246KB（≈250ms/818KB，有 2MB 上界）——与既有 markdown-extractor 同款行为，Node 服务面可接受，非新引入类别。

---

## 5. 03 审查测试清单 §1 六维度结论

| 维度 | 结论 | 要点 |
|---|---|---|
| 1.1 代码规范 | ✅ | tsc 零错；error 桶命名一致（`serp_http_*`）；注释全部 WHY + 证据引注（doc/governance/02、真机日期） |
| 1.2 数据逻辑 | ✅（修复后） | **项 9（外部服务运营契约 L-OP）**：Bing 退役声明可溯源（微软 lifecycle 公告，核实 2026-08-17）；serp_http 对 SERP 响应的每个假设（status/url/body）都有运行时分诊 + 真机验证。**DEF-1/DEF-2 正是本维度缺 L1/L2 证据的违例**——fixture 假设了「无 style 的 SERP 页」「重定向终态=请求态」，真机推翻，已修 + 钉测。字段缺失语义明确（response.url 缺失 → 跳过该检查，有测试） |
| 1.3 业务逻辑 | ✅ | 降级链状态机（zhipu→brave→serp_http→browse_headless→replay）真机全转移覆盖（含 429/202/ssrf/redirect/empty 五种 unknown 出口）；无第二套 fallback 范式；design artifact parse22.md 在实施前批准 |
| 1.4 端到端接通 | ✅ | 值级 trace = actions_and_results 真机审计链（每跳 channel/outcome/error 实录，见 §1/§2）；文档面清点：README×8 + KEY-GUIDE + TROUBLESHOOTING + ARCHITECTURE + SELECTOR-MAINTENANCE 均已更新 |
| 1.5 性能 + PRR | ✅（带 L2/L3 备注） | 性能四问有时序数据（§2）；无插桩引入的 Heisenbug；disable switch = httpSerp 不注入（byte-identical，集成测试钉死）+ serp_http 60s 熔断器运行时闸；metrics 经 decider 按 channel=serp_http 自动入窗。L3（同步转换阻塞）如实记录 |
| 1.6 简单架构 | ✅ | 零第二 selector（新增均为无状态归一化/传输层检查，有测试语义边界）；http-serp.ts 单文件镜像 extract.ts 控制流；注入式装配（末位可选参，INV-72 同手法）；不 new Agent（pooled fetch 单一真源） |
| 1.7 冗余与废弃 | ✅ | BingChannel.ts / bing-channel.spec.ts **删除**（-30 Bing 专属测试 = 合法减，Phase A 已在基线列明）；无注释掉的代码（墓碑注释是 INV-54 守卫对象，非备用代码）；版本引用无 >3 版落后（本次统一 1.15.0） |

**sign-off**：PASS（附 DEF-1/DEF-2 修复 + L1–L3 已知限制如上，均不阻断）。

---

## 6. 门禁终跑（验证员本地，全绿）

```
npm run build            → tsc 零错误，dist 产物正常（--version → 1.15.0）
npm test                 → Test Files 125 passed (125)；Tests 2007 passed | 1 skipped (2008)
npm run check-invariants → All 79 invariants passed.（79 条基线不变；INV-4/54/55/63/66/68 全绿）
npm run inv-selftest     → All 15 sampled pins flipped red under violation. 工作树零污染。
```

测试账目：v1.14 基线 1997（1967 + 30 Phase A 补）→ 实施报告 2000 → **验证后 2008**（+8 全部新增，零删除；Bing 相关 -30 删于 Phase A 基线前，合法减已列明）。

---

## 7. 验证员改动清单（本次 verify 期间）

| 文件 | 改动 |
|---|---|
| `src/serp/http-serp.ts` | DEF-1 修复（stripNonContentBlocks/dropMarkdownImages/管线重排）+ DEF-2 修复（redirect 软挡检测 `serp_http_redirect_blocked`）+ 文件头修订记录 |
| `test/unit/serp-http.spec.ts` | +8 回归测试（12b 噪声剥除 ×3、12c 软挡检测 ×4、escalation-safe 表 +1） |
| `package.json` / `src/index.ts` / `src/doctor/doctor.ts` | version → 1.15.0（INV-63 三处） |
| `test/unit/doctor-v17-integration.spec.ts` / `test/unit/doctor-v10-phase-cd.spec.ts` / `test/integration/doctor-cli-config-file.spec.ts` | 版本断言 1.14.0 → 1.15.0（4 处） |
| `README.md` | 当前版本 v1.15.0 + 更新日志 v1.15 条目（链行 v1.15 句实施报告已加） |
| `README.{en,ja,de,es,fr,pt,ru}.md` | 各 3 处：版本行 / fallback 链行（v1.15 裸 HTTP 快探 + Bing 退役句）/ changelog v1.15 条目 |
