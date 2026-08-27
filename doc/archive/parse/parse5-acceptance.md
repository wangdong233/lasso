# parse5 验收清单（v0.4 M0.4a + M0.4b + M0.4c，CI 覆盖 vs 手测 pending）

本文件承接 parse4-acceptance.md 的 13 条 TCC/codesign 手测 pending，加 v0.4 三子里程碑
对应的 CI 覆盖证据 + 手测 pending 清单。每条标 **CI**（npm test / check-invariants 自动覆盖）
或 **手测**（真实环境一次性人肉验证 + 留证据）。

权威：parse5 §6.1（M0.4a 8 条）+ §6.2（M0.4b 7 条）+ §6.3（M0.4c 5 条）+ §6.4（v0.3.5 零回归）。

---

## 0. v0.4 状态总览

| 子里程碑 | CI 自动覆盖（exit 0 即过） | 手测 pending（人肉 + 截图/日志归档） |
|---|---|---|
| M0.4a Forest 调度层 + 政策 gate | 8 / 8 | 1（forest 真机双 surface） |
| M0.4b appleScript + cgEvent | 6 / 7 | 2（Finder typed action + VSCode cgEvent 降级） |
| M0.4c browse_cloud + stealth | 2 / 5 | 3（browserbase Cloudflare 通关 + bot.sannysoft + stagehand verify/extract） |
| **合计** | **16 / 20** | **6 手测 pending** |

---

## 1. M0.4a Forest 调度层 + 政策 gate（parse5 §6.1，8 条）

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 1 | `interact_roots()` 返回 browse CDP page + desktop AX window 统一列表 | CI: mock 双 channel；手测：真机 + Chrome + Finder | CI: `test/unit/forest-list-roots.spec.ts`（mock 2 channel，断言 @pN+@wN 列表） | CI PASS |
| 1m | 同上（真机 Chrome + Finder） | **手测** | TODO：启动 Chrome 指定 url + Finder 新窗口 → 调 `interact_roots` → 截图 listRoots 输出 | pending |
| 2 | RootRegistry 共享 nextRootRefIndex（@p0/@w1/@p2 ... 单计数器） | CI | `test/unit/forest-root-registry.spec.ts` + doctor #24 `forest_ref_counter_strategy` | CI PASS |
| 3 | identity 复用：同 url 二次 listRoots → 同 @pN；同 window 二次 → 同 @wN | CI | `test/unit/forest-root-registry.spec.ts` | CI PASS |
| 4 | InteractDispatcher 不 import BrowseChannel/DesktopChannel 的 internal 模块（仅 class） | CI | `INV-26-forest-no-channel-internal-import`（grep 禁 `from ../browse/` etc.） | CI PASS |
| 5 | PolicyGate：cloud 浏览器通道必经 `LASSO_ALLOW_CLOUD_BROWSER=true` | CI | `test/unit/policy-gate.spec.ts`（manual-switch 关 → blocked） | CI PASS |
| 6 | PolicyGate：provider `policy_risk="acquired"` → 禁用；`"watched"` → warn skip | CI | `test/unit/policy-gate.spec.ts`（三态分支覆盖） | CI PASS |
| 7 | FallbackDecider 前置 PolicyGate：policy_blocked 路径返 `outcome=didnt` + `retrieval_method="policy_blocked"` | CI | `test/unit/fallback-policy-gate.spec.ts`（14 tests） | CI PASS |
| 8 | INV-24/25/26 全部绿（forest 调度层 invariants） | CI | `npm run check-invariants` → `INV-24/25/26` 三条 PASS | CI PASS |

### M0.4a Go/No-Go 决策点（parse5 §7.2 #1）
- ✅ **未触发**：forest 调度层**没有**强迫 BrowseChannel/DesktopChannel 加 surface 字段。
  `interact_roots` 经 InteractDispatcher 拿 `BrowseChannel.listRoots()` + `DesktopChannel.listRoots()`
  平行调用，channel 内部不动（R-CI-02 兄弟分层守住）。

---

## 2. M0.4b appleScript + cgEvent（parse5 §6.2，7 条）

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 9 | desktop 4-tier fallback 链完整：ax → appleScript → cgEvent → screenshotVlm | CI | `test/unit/desktop-act-4-tier.spec.ts` + `INV-29-desktop-act-4-tier-all-desktop` | CI PASS |
| 10 | AppleScriptProvider 仅 typed action enum 入口（白名单 6 项：finder/mail/safari/notes/system_settings/...） | CI | `test/unit/apple-script-whitelist.spec.ts` + `INV-22-applescript-typed-action-whitelist` | CI PASS |
| 11 | appleScript raw 脚本串注入测试：尝试传 `{script: "do shell script ..."}` → 拒绝 | CI | `test/unit/apple-script-whitelist.spec.ts`（注入尝试用例） | CI PASS |
| 12 | CGEventProvider 仅 press/hotkey 支持，不暴露 raw keycode | CI | `test/unit/cg-event-provider.spec.ts` + `INV-28-cgevent-no-raw-keycode` | CI PASS |
| 13 | Electron app（VSCode）AXSetValue 失败时降级 cgEvent（press Return 等单键）→ outcome="worked" | **手测** | TODO：真机 VSCode 设置面板 → desktop act 设置 checkbox → 观察日志是否走到 `desktop.cgEvent` | pending |
| 14 | scriptable app（Finder）AX 表达不全时降级 appleScript（typed action: finder_new_folder）→ outcome="worked" | **手测** | TODO：真机 Finder → desktop act `finder_new_folder` typed action → 观察日志是否走到 `desktop.appleScript` | pending |
| 15 | INV-22 改写（解除占位）+ INV-27/28/29 全部绿 | CI | `npm run check-invariants` → `INV-22/27/28/29` 四条 PASS | CI PASS |

### M0.4b Go/No-Go 决策点（parse5 §7.2 #3）
- ✅ **未触发**：appleScript 注入测试 11/12 项在 CI 全绿（白名单绕过尝试 0 成功）。

---

## 3. M0.4c browse_cloud + stealth（parse5 §6.3，5 条）

| # | 验收项 | CI vs 手测 | 证据 / 测试文件 | 状态 |
|---|---|---|---|---|
| 16 | browserbase 云浏览器通道可用（反爬站点通关） | **手测** | TODO：真实 `BROWSERBASE_API_KEY` + `LASSO_ALLOW_CLOUD_BROWSER=true` → `browserbase` tool 调一个 Cloudflare 保护的公开站点（如 `nowsecure.nl` / 各种 jobs 板） → 断言 `outcome="worked"` + 非 `cloudflare_manual_switch` | pending |
| 17 | stealth 反检测：`navigator.webdriver=false` + user-agent 抖动（bot.sannysoft 过检） | **手测** | TODO：browserbase tool 调 `bot.sannysoft.com` → screenshot → 人工查看 "Chrome" 一列全绿（.webdriver / .languages / .chrome / .permissions 四点） | pending |
| 18 | stealth 失败时不自动尝试 captcha 求解，升 manual-switch（Argus 范式） | CI + 手测 | CI: `test/unit/stealth-engine.spec.ts`（escalateManualSwitch 17 tests）+ 手测：触发 Cloudflare managed challenge → 断言 `retrieval_method="cloudflare_manual_switch"` 而非自动绕过 | CI PASS / 手测 pending |
| 19 | stagehand `verify(prompt)` / `extract(prompt, schema)` 两个 AI 原语可用 | **手测** | TODO：真实 `STAGEHAND_API_KEY` → 直接调 `StagehandChannel.observe("verify", { prompt })` 与 `observe("extract", { prompt, schema })` → 断言 `outcome="worked"` | pending |
| 20 | INV-29/30 全部绿（stealth + cloud 浏览器 invariants） | CI | `npm run check-invariants` → `INV-29/30` 两条 PASS（30/30 全绿） | CI PASS |

### M0.4c Go/No-Go 决策点（parse5 §7.2 #4/#5）
- ✅ **未触发 #4**（跨 surface fallback）：browserbase tool plan = `{ primary: "browse_cloud_browserbase", fallbacks: [], cross_modal: false }`
  （terminal channel，cloud 失败由 model 显式处理；不 fallback 到 browse_*）。
  - `INV-8-fallback-no-cross-surface` + `INV-23-desktop-never-fallback-browse` + PolicyGate 三重守
- ⏳ **#5 待手测**：browserbase 连续 3 次 2FA 失败 → 边界确认（08 §7.3 不解 2FA）。
  - 真实手测后才可关闭此项；当前 Lasso 不主动测 2FA（边界铁律已守）。

---

## 4. v0.3.5 零回归（parse5 §6.4，强制）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| R1 | v0.3.5 的 TS tests + Rust tests 100% 绿 | CI PASS | `npm test` 45 files / **850 tests** 全绿（基线 759 → v0.4 增长至 850）；`cargo test` **144 tests** 全绿（rust-helper） |
| R2 | 既有 INV-1..23 全部保持绿（INV-22 改写语义但编号不挪） | CI PASS | `npm run check-invariants` → 30 / 30 全绿 |
| R3 | `npm test` + `npm run check-invariants` + `cd rust-helper && cargo test` 三命令都 exit 0 | CI PASS | 本次 M0.4c 实施全部 exit 0 |
| R4 | parse4-acceptance.md 的 13 条 TCC/codesign 手测 pending 全部承接（v0.4 不砍） | 承接 | 见 parse4-acceptance.md（不在本文件复述；v0.4 不影响 macOS TCC/codesign 路径） |

### 默认 OFF 零回归专项验证（v0.4 M0.4c）
- ✅ 无 `LASSO_ALLOW_CLOUD_BROWSER` env → log `cloud_browser_channels_skipped reason=manual_switch_off_default`；server `lasso_ready` 正常
- ✅ `LASSO_ALLOW_CLOUD_BROWSER=true` 但无 key → log `cloud_browser_channels_skipped reason=manual_switch_on_but_no_api_key`；server `lasso_ready` 正常
- ✅ PolicyGate 未注入（FallbackDecider 第 2 参 policyGate=null）→ `runWithFallback` 行为等价 M0.4b
- ✅ browserbase tool 未注册（`server.listTools()` 不含）—— model 看不到该工具

---

## 5. 手测执行 Checklist（操作步骤）

### M0.4a #1m：forest 真机 Chrome + Finder 双 surface
1. 启 Chrome 指定 url（如 `https://example.com`）：`open -na "Google Chrome" --args --remote-debugging-port=9222 "https://example.com"`
2. 打开 Finder 新窗口（Command+N）
3. 在 CC 里调 `interact_roots`
4. 期望：返回至少 2 条 root：`@p0`（browse_headless 或 browse_logged_in，subtitle=example.com）+ `@w1`（Finder）
5. 截图 + 复制 JSON 输出归档

### M0.4b #13：VSCode AXSetValue 失败 → cgEvent 降级
1. 启 VSCode，打开 Settings UI
2. CC 调 `desktop act`：toggle 某设置 checkbox
3. 期望日志：`fallback_used=true` + `actions_and_results` 含 `desktop.ax` (error) → `desktop.cgEvent` (worked)
4. 截图 + 复制日志归档

### M0.4b #14：Finder AX 表达不全 → appleScript 降级
1. Finder 焦点
2. CC 调 `desktop act`：`appleScriptAction="finder_new_folder"`（typed action，不是 raw script）
3. 期望日志：`fallback_used=true` + `actions_and_results` 含 `desktop.ax` (error) → `desktop.appleScript` (worked)
4. 截图（Finder 新文件夹已创建）+ 复制日志归档

### M0.4c #16：browserbase Cloudflare 通关
1. export `LASSO_ALLOW_CLOUD_BROWSER=true` + `BROWSERBASE_API_KEY=<real-key>`
2. 重启 Lasso MCP server
3. CC 调 `browserbase` tool，url 选一个 Cloudflare 保护的公开站点（建议 `nowsecure.nl` 或各种 jobs 板）
4. 期望：`outcome="worked"` + `served_by="browse_cloud_browserbase"` + 非 `retrieval_method="cloudflare_manual_switch"`
5. 截图 + 复制 JSON 输出归档

### M0.4c #17：stealth bot.sannysoft 过检
1. 同 #16 配置
2. CC 调 `browserbase` tool，url = `https://bot.sannysoft.com`
3. screenshot action
4. 期望：返回的 PNG 中 "Chrome" 一列指标全绿（WebDriver / Chrome / Plugins / Languages 等核心几项）
5. 截图归档

### M0.4c #18：stealth 失败升 manual-switch（不自动 captcha）
1. 同 #16 配置
2. CC 调 `browserbase` tool，url 选一个**有 managed challenge** 的 Cloudflare 站点（建议手动找或用历史反爬严的）
3. 期望：`outcome="didnt"` + `retrieval_method="cloudflare_manual_switch"` + `error="cloudflare_challenge_detected_stealth_escalated"`
4. **不应**看到 Lasso 自动尝试 2FA / captcha 求解
5. 截图 + 复制 JSON 输出归档

### M0.4c #19：stagehand verify/extract
1. export `LASSO_ALLOW_CLOUD_BROWSER=true` + `STAGEHAND_API_KEY=<real-key>`
2. 因 v0.4 未注册 stagehand 独立 tool，**用脚本直调**：
   ```ts
   import { StagehandChannel } from "./dist/channels/StagehandChannel.js";
   const sh = new StagehandChannel(process.env.STAGEHAND_API_KEY!);
   const v = await sh.observe("verify", { prompt: "is there a login form?" });
   const e = await sh.observe("extract", { prompt: "extract all headings", schema: {...} });
   ```
3. 期望：`v.outcome="worked"` + `v.data.verified=true/false`；`e.outcome="worked"` + `e.data.data=<structured>`
4. 截图 + 复制 JSON 输出归档

---

## 6. 偏离 parse5 的决策记录

本次 M0.4c 实施对 parse5 §3.4 doctor 计划有一处偏离，记录如下：

| 偏离 | parse5 §3.4 原计划 | 本次实施 | 理由 |
|---|---|---|---|
| doctor 检查项编号 | #21 browserbase key 可达 / #22 stagehand key 可达 / #23 manual-switch 状态 / #24 stealth profile 自检 | 实际保留 M0.4a 的 #21-#24（cloud_manual_switch / forest_root_registry / forest_dispatcher / forest_ref_counter），**升级** #21 含 browserbase HEAD 探测，**新增** #25 stealth_profile_self_check | M0.4a 已占用 #21-#24 槽位验 forest + 政策 gate；不改既有编号保兼容。新增 #25 累加即可，zero regression。HEAD 探测放进升级版 #21 而非新编号，避免 doctor 输出顺序错乱。 |

其他全部对齐 parse5 §3.2 / §3.3 / §3.4 / §6.3 描述。

---

## 7. v0.4 → v0.5+ 推迟项（parse5 §总结「v0.4 之后」）

- ResourceScheduler + epoch 串行（12 §3.4 + 13 §3.4.6 推迟）
- compact diff（v0.6+ 若 SPA 分页真需要）
- browserbase 2FA 自动解（**永远不做**，08 §7.3 边界；本文件手测 #18 验证此边界守住）
- agent loop（**永远不下沉到 MCP**，12 §5.2 越界）
- stagehand 独立 tool（v0.5+ 若用户反馈 verify/extract 高频；当前仅 channel 装配 + 手测脚本调）
