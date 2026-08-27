# parse4 v0.3.5 验收清单（Phase D）

> 落地 parse4 §6（M0.5a 7 条 + M0.5b 6 条 = 13 条）+ §6.3 v0.3 零回归 3 条 + §7.4 关键决策 5 条。
> 本文是开发者**签名后**在 macOS 本地手测的清单。CI 不跑这些（无 TCC + 无 codesign）。

---

## CI 覆盖 vs 手测覆盖（先把分工讲清）

**CI 覆盖（不需要 macOS + TCC，自动跑）**：
- TS 单测/集成测（mock RustBridge）：33 文件 / 645 tests / 100% 绿
- Rust 协议/role-map 单测（平台无关）：`cargo test --test protocol --test ax_role_map` 共 19 tests / 100% 绿
- 23 条架构不变量（INV-1..23）：`npm run check-invariants` 23/23 绿

**手测覆盖（CI 无法验，必须真 macOS + TCC 授权 + Developer ID codesign 后由开发者在本地跑）**：
- parse4 §6.1 M0.5a #1 / #2 / #3 / #4 / #7
- parse4 §6.2 M0.5b #8 / #9 / #10 / #11
- #5（doctor 6 项）、#6（TCC 引导）、#12（短熔断）、#13（长熔断）部分可由 CI 验结构、需手测端到端确认

**前置准备（开发者本地一次性做）**：
1. Apple Developer 账号（$99/年）已激活；拿到 `Developer ID Application: Your Name (TEAMID)`
2. `cd lasso/rust-helper && LASSO_DEV_ID='...' ./build/sign.sh` 签名
3. 双击运行 `target/release/lasso-rust-helper` 一次（注册 binary 身份）
4. System Settings → Privacy & Security → **Accessibility** → 添加 `lasso-rust-helper`
5. System Settings → Privacy & Security → **Screen Recording** → 添加 `lasso-rust-helper`（screenshot/act 需要）
6. `export LASSO_RUST_HELPER_PATH=/Users/.../lasso/rust-helper/target/release/lasso-rust-helper`
7. `cd lasso && npm run build && node dist/index.js`（启动 MCP server）

---

## parse4 §6.1 M0.5a Observe-Only（7 条）

### #1 — desktop snapshot 返回 stateId + outline 树

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"snapshot", options:{app:"Finder"})` 返回 stateId + outline 树；maxDepth=3 时节点数 ≥20 |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a |
| **怎么手测** | (a) 启动 server 后用 MCP inspector 调 `desktop` tool，args `{"action":"snapshot","options":{"app":"Finder","max_depth":3}}`；(b) 校验返回 JSON 含 `state_id`（UUID）+ `outline.nodes`（数组）+ `nodes.length >= 20`；(c) 同法测 Mail + Notes 各一次（共 3 app） |
| **CI 是否覆盖** | 否（需真 Finder 进程 + AXAPI 授权） |
| **状态** | pending |

### #2 — desktop find 在快照中查询元素

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"find", options:{state_id, where:{text:"新建文件夹"}})` 在 Finder 快照中正确返回 @eN 或 [] |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a |
| **怎么手测** | (a) 先调 snapshot 取 state_id；(b) Finder 中右键 → 新建文件夹，使其在 AX 树里出现；(c) 用 state_id + `where:{text:"新建文件夹"}` 调 find；(d) 校验命中节点的 `label` 含"新建文件夹"，`ref` 形如 `@eN`；未命中时返回 `[]`（不允许 undefined/null） |
| **CI 是否覆盖** | 否（需真 Finder 文件夹上下文） |
| **状态** | pending |

### #3 — AX→OutlineNode 映射覆盖率 ≥80%

| 字段 | 值 |
|---|---|
| **验收项** | AX→OutlineNode 映射覆盖率 ≥80%（采样 10 个常见 native app） |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a |
| **怎么手测** | (a) 写或复用 `scripts/ax-coverage.mjs`（采样脚本）；(b) 依次对 Finder / Mail / Safari / Notes / System Settings / Xcode / Terminal / Messages / Calendar / Preview 各跑一次 snapshot；(c) 统计 `outline.nodes` 中 `role !== "unknown"` 的占比；(d) 占比 ≥80% → pass，否则记失败 app 清单回 08/13 重审（D1 Go/No-Go） |
| **CI 是否覆盖** | 否（需 10 个真 app） |
| **状态** | pending |

### #4 — desktop snapshot 中位延迟 ≤30ms

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"snapshot")` 中位延迟 ≤30ms（maxDepth=3） |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a |
| **怎么手测** | (a) 写 `scripts/bench-snapshot.mjs`（50 次 sample 取 p50）；(b) args `{"action":"snapshot","options":{"app":"Finder","max_depth":3}}`；(c) 连续 50 次记录 latency_ms；(d) `p50 ≤ 30ms` → pass；(e) 不达标 → 回 parse4 §3.1.4 加批读（`AXUIElementCopyMultipleAttributeValues`） |
| **CI 是否覆盖** | 否（需真 AXAPI） |
| **状态** | pending |

### #5 — desktop doctor 检查 ≥6 项

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"doctor")` 检查 ≥6 项（AX 授权 / Screen Recording / Rust helper / Developer ID / AX 可读率 / VLM 可达性），返回结构化 JSON + blockers + next_step |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a + 09 §2.4 |
| **怎么手测** | (a) 调 `desktop` tool，args `{"action":"doctor"}`；(b) 校验返回 JSON 含 `checks` 数组长度 ≥6 + 每项有 `{name, status, detail, next_step?}`；(c) 各 check 名应覆盖：rust_helper_signed / rust_helper_running / tcc_accessibility / tcc_screen_recording / ax_read_rate / vlm_endpoint_reachable（共 6 项）；(d) 已授权环境 6 项全 `status:"pass"` |
| **CI 是否覆盖** | 部分（结构层 — `doctor.spec.ts` mock RustBridge 验 JSON 形状；状态值 — 手测） |
| **状态** | pending |

### #6 — TCC 首次未授权引导

| 字段 | 值 |
|---|---|
| **验收项** | TCC 未授权时返回 `{readiness:"blocked", blockers:["tcc:accessibility"], next_step:"open x-apple.systempreferences:..."}` |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a |
| **怎么手测** | (a) `tccutil reset Accessibility com.wangdong.lasso-rust-helper`（或对应 bundle id）撤销授权；(b) 重启 helper 进程；(c) 调 `desktop(action:"doctor")`；(d) 校验返回 `readiness:"blocked"` + `blockers` 含 `"tcc:accessibility"` + `next_step` 以 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` 开头；(e) 重新授权后 readiness 转为 `"ready"` |
| **CI 是否覆盖** | 否（需可重置 TCC.db） |
| **状态** | pending |

### #7 — Rust helper 签名后 rebuild 不再重弹 TCC

| 字段 | 值 |
|---|---|
| **验收项** | Rust helper 用 Developer ID 签名后，rebuild 不再重弹 TCC 授权弹窗 |
| **来源** | parse4 §6.1 / 13 §3.4 M0.5a + 09 §2.4 |
| **怎么手测** | (a) 首次签名 + 授权（见前置准备）；(b) `cd rust-helper && LASSO_DEV_ID='...' ./build/sign.sh` 重新签名；(c) 再次启动 helper；(d) 观察 macOS **不再弹** Accessibility 授权框（cdhash 稳定 → TCC.db 记录仍命中）；(e) 对照未签 binary rebuild 后必弹框的行为 |
| **CI 是否覆盖** | 否（需 codesign + TCC 状态） |
| **状态** | pending |

### M0.5a 架构不变量（CI 自动跑，必须 5/5 绿才放 M0.5b）

| INV | 文本 | 守护点 |
|---|---|---|
| INV-16 | DesktopChannel 必须 `extends UiChannel` | `class DesktopChannel extends UiChannel` |
| INV-18 | desktop fallback 必须经 `FallbackDecider.runWithFallback` | grep `runWithFallback` 在 DesktopChannel.act |
| INV-19 | OutlineNode 类型定义无 `surface` 字段 | grep 无 `surface:` 在 desktop-types.ts |
| INV-20 | desktop provider 名形如 `desktop.*` | `desktop.ax` / `desktop.screenshotVlm` |
| INV-21 | src/**/*.ts 代码无 AXUIElement/CGEvent/AXPress 字面量 | 平台字面量隔离在 rust-helper |

→ 当前 23/23 invariants 全绿（含上面 5 条）。

---

## parse4 §6.2 M0.5b Act + screenshotVlm Fallback（6 条）

### #8 — desktop act 在 Mail 点击按钮

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"act", options:{state_id, actions:[{kind:"click", ref:"@e3"}], expect:{...}})` 在 Mail 点击"新邮件"按钮 → outcome="worked" + actions_and_results 链 |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b + 09 §2.4 |
| **怎么手测** | (a) 启动 Mail（前台）；(b) snapshot 拿 state_id；(c) find `where:{text:"新邮件"}` 拿 ref；(d) `desktop` tool args `{"action":"act","options":{"state_id":"<上一步>","actions":[{"kind":"click","ref":"<ref>"}],"expect":{"text":"新邮件"}}}`；(e) 校验 `outcome:"worked"` + `actions_and_results[0].worked===true` + `expect_result:"preexisting"\|"worked"` |
| **CI 是否覆盖** | 否（需真 Mail + 鼠标事件） |
| **状态** | pending |

### #9 — canvas/Metal app 降级 screenshotVlm

| 字段 | 值 |
|---|---|
| **验收项** | canvas/Metal app AX 完全无 element 时降级 screenshotVlm（若 `LASSO_VLM_ENDPOINT` 配）→ outcome="worked", fallback_used:"screenshotVlm"，节点标 `pictureOnly:true` |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b |
| **怎么手测** | (a) 启动一个 canvas-heavy app（如 Sketch / Pixelmator 画布 / Photoshop）；(b) snapshot；(c) 校验 outline 树中节点带 `pictureOnly:true`（AXUnknown 大尺寸无 children）；(d) `export LASSO_VLM_ENDPOINT=http://localhost:...`（指向 media-gen-mcp vlm）；(e) `desktop(action:"act",...)` 命中 pictureOnly ref；(f) 校验 `fallback_used:"screenshotVlm"` + `outcome:"worked"`；(g) 未配 LASSO_VLM_ENDPOINT 时校验 `outcome:"didnt"` + `error:"vlm_unavailable"`（不阻断 ax 路径） |
| **CI 是否覆盖** | 否（需真 canvas app + VLM endpoint） |
| **状态** | pending |

### #10 — desktop wait tri-state 诚实报告

| 字段 | 值 |
|---|---|
| **验收项** | `desktop(action:"wait", options:{condition:{appFrontmost:"Mail"}, timeout_ms:3000})` 在 Mail 已前台时返 `"preexisting"`（tri-state 诚实报告） |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b |
| **怎么手测** | (a) 启动 Mail 并切到前台；(b) `desktop` tool args `{"action":"wait","options":{"condition":{"appFrontmost":"Mail"},"timeout_ms":3000}}`；(c) 校验返回值为 `"preexisting"`（Mail 已经是前台 → 不是 wait "worked"，也不是 "didnt"）；(d) 切到 Safari 后重测，3000ms 内手动切回 Mail → `"worked"`；(e) 切到 Safari 后 3000ms 内不切回 → `"didnt"` |
| **CI 是否覆盖** | 否（需真 app 切换） |
| **状态** | pending |

### #11 — 5 类原生 app 操作成功率 ≥85%

| 字段 | 值 |
|---|---|
| **验收项** | 典型原生 app 操作成功率 ≥85%（采样 5 类各 10 次） |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b + 09 §2.4 |
| **怎么手测** | 每类 10 次：(a) Finder 新建文件夹；(b) Mail 发邮件；(c) Safari 打开书签；(d) 系统设置切换 WiFi；(e) Notes 新建便签。统计 `outcome==="worked"` 次数 / 10。5 类各 ≥8.5 次（取整：≥9 次）→ 总体 ≥85%。失败案例记 error_kind + app 名 |
| **CI 是否覆盖** | 否（需 5 个 app 真交互） |
| **状态** | pending |

### #12 — 60s 短熔断

| 字段 | 值 |
|---|---|
| **验收项** | 60s 短熔断：模拟 axProvider 连续失败 5 次，60s 内不再尝试 ax 档（复用 v0.3 CircuitBreaker） |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b + 09 §2.4 |
| **怎么手测** | (a) 撤销 helper 的 Accessibility 授权（让 axProvider 必失败）；(b) 连续调 `desktop(action:"act",...)` 5 次，观察 5 次都 outcome=didnt + error_kind=tcc_denied；(c) 第 6 次调用，校验**立即返回**（不重试 ax）+ error 含 `circuit_open:desktop.ax`；(d) 等 60s 后第 7 次调用，校验 ax 被重试（half-open） |
| **CI 是否覆盖** | 部分（熔断状态机由 `circuit-breaker.spec.ts` 单测覆盖；desktop 档位接线由手测验） |
| **状态** | pending |

### #13 — Argus 60min 长熔断 + INV-23 红线

| 字段 | 值 |
|---|---|
| **验收项** | Argus 60min 长熔断：模拟 desktop 通道 1h 内 10 次失败，60min 内整个 desktop 通道熔断（**不 fallback 到 browse**，INV-23） |
| **来源** | parse4 §6.2 / 13 §3.4 M0.5b + 09 §2.4 |
| **怎么手测** | (a) 制造 desktop 通道连续失败（撤销 TCC）；(b) 1h 内调 10 次；(c) 第 11 次调用，校验**整个 desktop 通道返回 channel_unavailable**；(d) **关键红线**：手动检查 fallback plan 不含 `browse_headless` / `browse_logged_in`（INV-23 — desktop 永不跨 surface） |
| **CI 是否覆盖** | INV-23 grep 断言在 CI 自动跑（23/23 绿）；端到端熔断时序由手测验 |
| **状态** | pending |

### M0.5b 架构不变量（CI 自动跑，必须 8/8 全绿）

INV-16..23 共 8 条全部绿（已含 M0.5a 5 条 + INV-17 单 tool / INV-22 不接 appleScript/cgEvent / INV-23 永不跨 surface）。

---

## parse4 §6.3 v0.3 零回归（3 条 — 强制）

| # | 验收项 | 守住证据 |
|---|---|---|
| R1 | v0.3 的 545 tests 100% 绿 | ✅ 当前 28 个 v0.3 baseline test files 共 545 tests 全绿（npm test 总 645 = 545 v0.3 baseline + 100 v0.3.5 新增） |
| R2 | INV-1..7, 9..15 全部保持绿（INV-8 改写为 INV-23） | ✅ check-invariants 23/23 全绿；INV-8 旧 ID 不复用，新 INV-8 槽位写为「fallback 链不跨 surface」语义收紧 |
| R3 | `npm test` + `npm run check-invariants` 都 exit 0 | ✅ 两条命令都 exit 0（详见顶部「CI 覆盖」数字） |

---

## parse4 §7.4 关键决策回顾（5 条 — 守住核对）

| # | 决策 | 守住证据 |
|---|---|---|
| K1 | **单工具 action-enum 折叠**（6 action 一工具，不铺开 6 个 server.tool） | ✅ `tools/desktop.ts` 单 `server.tool("desktop", ...)` 注册；INV-17 grep 守护：「desktop」恰好注册 1 次，禁 desktop_snapshot/desktop_act/desktop_find 拆分 |
| K2 | **DesktopChannel extends UiChannel**（不是 extends BrowseChannel） | ✅ `DesktopChannel extends UiChannel`；INV-16 grep 守护；BaseChannel 不被 AXAPI 污染（INV-21：src/**/*.ts 无平台字面量） |
| K3 | **Rust helper 用 JSON-lines 而非 MCP JSON-RPC** | ✅ `rust-helper/src/protocol.rs` newline-delimited JSON，无 Content-Length framing；Rust 不引 MCP SDK；INV-7 守护：SubprocessManager 仍纯 lifecycle，两种协议各自走 RustBridge / McpClient 适配 |
| K4 | **v0.3.5 只 axProvider + screenshotVlm 两档**（appleScript/cgEvent 推迟 v0.4+） | ✅ DesktopChannel 注入 2 providers；INV-22 grep 守护：desktop/ 下无 appleScript/cgEvent 实装类（仅注释占位） |
| K5 | **TCC 用 Developer ID 签名而非 ad-hoc 签名** | ✅ `rust-helper/build/sign.sh` 用 `codesign --force --options runtime --timestamp --sign "$LASSO_DEV_ID"`；README §「为什么必须 $99/年」+ §「TCC 持久化原理」明示跨 rebuild 持久化 |

---

## 退出标准

**M0.5a Go/No-Go**（必须全绿才进 M0.5b）：
- ✅ CI 自动部分：545 v0.3 tests + 100 v0.3.5 tests + 23 invariants + 37 cargo tests
- ⏳ 手测部分：#1-#7 共 7 条全部 status:pass（其中 #3 AX 覆盖率 <80% 或 #4 延迟 >30ms → 触发 parse4 §7.2 Go/No-Go #1，暂停回 08/13 重审）

**M0.5b Go/No-Go**（v0.3.5 发版闸门）：
- ⏳ 手测部分：#8-#13 共 6 条全部 status:pass（其中 #11 成功率 <85% → 触发 parse4 §7.2 Go/No-Go #1，回审）

**v0.3 零回归**（任何时候不能破）：
- ✅ R1/R2/R3 全部守住（见上表）

---

## 维护说明

- 本文档每条手测在状态变更后更新（pending → pass / fail + 原因）
- CI 覆盖的 INV-16..23 在任何代码变更后由 `npm run check-invariants` 自动验；若 INV 红了，**本文档所有手测条目自动作废**（架构破 → 手测结果不再有意义）
- 新增 desktop action 时，本文档需新增对应手测条目（变更放大率 ≤3 — parse4 §3.2.2）
