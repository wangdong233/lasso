# Wave1 桌面通道探测 执行记录（T-DESKTOP 面板）

## 执行时间与环境

- 执行时间：2026-08-14 17:58 – 2026-08-15 02:14（UTC+8）
- 机器：MacBookPro11,4，macOS 12.x（Darwin 21.6.0，注意：本机是 **System Preferences**，无 "System Settings" 应用名）
- Node v24.12.0；lasso v1.7.0（dist 已构建）；rust-helper Mach-O x86_64（2026-07-22 构建，**完全未签名**）
- MCP 客户端：`mcp.mjs`（多面板共用，执行期间被并行面板多次改写；本面板固定快照 `wave1-desktop-mcp.mjs`，spawn cwd=仓库根，env 全量透传）。自检：`tools/list` 14 工具含 desktop/interact_roots ✓
- TCC 状态：Accessibility 已授权 / Screen Recording 已授权（无系统弹窗出现）

## 先行裁决：T-DESKTOP-10 desktop doctor（#15-#20 结论）

**T-DESKTOP-10 verdict: pass**

| check | 实际 | 判定 |
|---|---|---|
| #15 rust_helper_signed | warn「binary 可能未构建：./rust-helper/target/release/lasso-rust-helper」 | 符合预期档位（warn） |
| #16 rust_helper_running | pass「ping ok; helper v0.1.0」 | pass |
| #17 tcc_accessibility | pass「已授权」 | pass |
| #18 tcc_screen_recording | pass「已授权」 | pass |
| #19 ax_read_rate | warn（当时仅 1 AX node） | 打开 Finder 后快照正常，非缺陷 |
| #20 vlm_endpoint_reachable | warn（未配 LASSO_VLM_ENDPOINT） | 符合 D3 预期语境 |

观察（不改产品，供产品组参考）：
- #15 的 warn detail 说「可能未构建」，但 binary 实际存在——`codesign -dvvv` 输出 "code object is not signed at all"，该输出既不含 `Authority=Developer ID` 也不含 checkRustHelperSigned 的 ad-hoc 检测正则（`CodeSignature|Identifier=`，desktop-doctor-checks.ts:162），落入第三分支「可能未构建」。**未签名 binary 与「未构建」文案混淆**，且与文档「未签/ad-hoc → fail」不符（实发 warn）。状态档位在用例预期（warn/fail）内，故不判 fail。
- **裁决**：#17 Accessibility=pass → 放行 T-DESKTOP-01/02/04/06/08/11/12/13/14；#18 Screen Recording=pass → 放行 T-DESKTOP-09。

## 逐条结果

### T-DESKTOP-17 helper JSON-lines 协议手测 — **pass**

单会话顺序注入 5 行（ping / 坏 JSON / 未知方法 / 空行 / ping）：

```
{"id":"t1","ok":true,"result":{"platform":"macos","pong":true,"tcc":{"accessibility":true,"screen_recording":true},"version":"0.1.0"}}
{"id":"","ok":false,"error":"invalid JSON: expected ident at line 1 column 2","error_kind":"parse_error"}
{"id":"t2","ok":false,"error":"method 'no_such_method' not recognized","error_kind":"unknown_method"}
{"id":"t3","ok":true,"result":{...pong...}}
EXIT=0
```

- ping 返 pong/version/platform/tcc ✓；坏 JSON → parse_error 不退出（后续行仍处理）✓；未知方法 → unknown_method ✓；空行无输出、跳过 ✓。

### T-DESKTOP-18 helper 启动与路径（LASSO_RUST_HELPER_PATH=/nonexistent） — **fail（轻，错误分类失真）**

- `desktop {action:"doctor"}`（env 已透传，server 日志确认 `rust_proc_error: spawn /nonexistent ENOENT`）：
  - #16 fail「Error: rust_call_timeout:ping」；#17/#18 warn「rust_call_timeout:tcc_status」；#19 fail「rust_call_timeout:ax_snapshot」
- 通道调用 `desktop {action:"snapshot",options:{app:"Finder"}}` → isError，text=`rust_call_timeout:ax_snapshot`（拒绝、不静默成功 ✓）
- 正常路径 ping：直连 helper 0.105s；doctor #16 pass ✓

用例判定：**用例意图正确，产品存在错误分类缺陷**。RustBridge 文档承诺 crash 检测走 `proc.on("exit") → rust_helper_crashed`（RustBridge.ts:27），但 ENOENT spawn 只触发 `error` 事件（不触发 exit），SubprocessManager 的 `proc.on("error")` 仅打日志（SubprocessManager.ts spawn 段），不 reject pending 也不标 closed → 每次调用烧满超时（ping 3s × 3 项 check）且错误归因为 timeout 而非 spawn 错误。坏路径被拒绝这一核心语义成立，故记轻微 fail（可观测性/延迟缺陷，非功能阻断）。修复建议：`error` 事件接入 pending reject + closed 标记。

### T-DESKTOP-19 TCC 双权限探测 — **pass**

- helper 直调 `{"method":"tcc_status"}` → `{"accessibility":true,"screen_recording":true}` 两独立布尔 ✓（main.rs:83 tcc::snapshot）
- doctor #17/#18 各自独立 pass ✓
- rust-helper `cargo test` 全绿（9 + 6 + doc 0）✓；全程无系统弹窗 ✓

### T-DESKTOP-20 zod schema 校验（含 D8 一次性采证） — **pass**

| 子项 | 实际 | 判定 |
|---|---|---|
| `action:"snap"` | MCP -32602 invalid_enum_value（列出 6 合法值） | ✓ 拒 |
| `max_depth:99` | MCP -32602 too_big maximum 20 | ✓ 拒 |
| `actions kind:"clk"` | MCP -32602 invalid_union（逐 literal 报） | ✓ 拒 |
| `appleScriptAction:"system_get_uptime"`（act） | **D8 命中**：strip 后整体 `didnt`，审计链 ax=unknown `no_actions_specified` → appleScript=unknown **`missing_applescript_action`**（retrieval_method `applescript_no_action`，AppleScriptProvider.ts:128-129）→ cgEvent=unknown → screenshotVlm=didnt `vlm_unavailable` | ✓ 预期缺陷行为命中即 pass |
| action 省略（options:{app:"Finder"}） | 默认 snapshot，worked，树从 @e0 起 | ✓ |

### T-DESKTOP-15 interact_roots kind:window — **pass**

- `interact_roots {kind:"window"}`（1 个 Finder 窗口）→ `[{"rootRef":"@w1","kind":"window","title":"访达: 最近使用","source":"desktop"}]`
- 新建第 2 个 Finder 窗口后 `interact_roots {}` → @p0（browse_logged_in 页，他面板 Chrome 会话）+ @w1「访达: 王棟的MacBook Pro」+ @w2「访达: 最近使用」，多窗口多条 entry ✓
- 本机已授 Screen Recording，title 非空（redact 分支未触发，无法在本机验证空串行为——记观察，不扣分）

### T-DESKTOP-01 AX snapshot — **pass**

- `snapshot {app:"Finder", max_depth:8(默认)}` → worked；data.root OutlineNode 树，ref 从 @e0 起，role=application「访达」→ window「最近使用」… ✓
- `app:"Notepad"` → didnt + `resolve_root(Some("Notepad")) failed`（ax.rs:124）
- `max_depth:99` → zod 拒（见 T-DESKTOP-20）✓
- 未授权 tcc_denied 分支：本机已授权，不可测（n/a）

观察（轻微可观测性缺陷）：error 字段用 `resp.error ?? resp.error_kind`（AxProvider.ts:137），rust 侧恒带 error message → error_kind `app_not_found` 永不出现在 MCP 面（与 AxProvider.ts:124 文档「error=error_kind」契约漂移）。outcome=didnt 语义正确，不判 fail。

### T-DESKTOP-02 AX find — **pass**

- `find {app:"Finder", where:{text:"文件"}}` → worked，matches 含 ref/role/label/rect（命中 menubaritem「文件」、button「新建文件夹」等）✓
- 缺 where → didnt + `missing_where_clause` ✓
- 0 命中（text:"zzz_no_such_zzz"）→ worked + matches:[] + count:0 ✓
- ref 编号错位风险观察：find 的 @e0 与 snapshot 的 @e0 指向不同节点（两棵树独立计数），已在用例注记范围内，如实记录

### T-DESKTOP-04 档1 ax（D4 占位） — **pass（预期缺陷命中）**

`act {actions:[{kind:"click",ref:"@e0"}]}` → 整体 didnt，审计链：ax=unknown「ax_act lands in Phase B (M0.5b); Phase A is observe-only」（ax.rs:172-178 error_kind=not_implemented，D4 锚点逐字命中）→ appleScript=unknown → cgEvent=unknown `only_press_or_hotkey_supported` → screenshotVlm=didnt `vlm_unavailable`。链完整性探针成立 ✓

### T-DESKTOP-06 档3 cgEvent — **pass（1 子项为用例笔误，如实记录）**

| 子项 | 实际 | 判定 |
|---|---|---|
| press Return | worked，served_by=desktop.cgEvent，retrieval=cgevent_ffi，per-action ok:true | ✓ |
| 未知键名 key:"36" | cgEvent 档 unknown `all_cgevent_actions_failed`（无按键发出，链落档 4） | ✓ 语义达成；字面 token `cgevent_unknown_key` 仅存在于 rust 层（cgevent_keymap.rs:161），MCP 聚合面只露 all_cgevent_actions_failed，per-action 细节在档内 data 但被链级 envelope 丢弃——记观察 |
| raw keycode key:36（number） | **MCP -32602 zod invalid_union 拒**（schema key:z.string()） | **用例笔误**：MCP 入口下 number key 被 zod 先拒，INV-28 的 `cgevent_raw_keycode_forbidden`（CGEventProvider.ts:179）经 MCP 不可达，属程序化纵深防御层。zod 拒绝本身是正确防御行为，非产品缺陷 |
| click | unknown + `only_press_or_hotkey_supported`（= cgevent_no_supported_action 分支），链继续 | ✓ |

### T-DESKTOP-08 wait 四态 — **pass**

- `wait {app:"Finder", where:{text:"最近使用"}, timeout_ms:3000}` → worked + `verdict:"preexisting"`（首 poll 命中）✓
- 缺 where → didnt + `missing_where_clause` ✓
- 超时/出现两态与「ax didnt 时不再 poll」未逐一构造（用例主断言已覆盖）

### T-DESKTOP-09 screenshot — **fail（产品缺陷：裁剪参数全链路失效）**

- 全屏：worked，served_by=desktop.screenshotVlm，retrieval=screenshot；base64 5,134,096 字符，解码 3,850,570B 合法 PNG（magic `\x89PNG\r\n\x1a\n`），IHDR 2880x1800 ✓
- **`screenshot_region:{x:0,y:0,w:800,h:600}` → 仍返回 2880x1800 全屏（3,850,450B PNG）**，裁剪完全未生效

用例判定：**用例写对了，是产品缺陷（wire 键名漂移）**。TS 侧 `rust.call("screenshot", region ? { region } : {})`（ScreenshotVlmProvider.ts:92，包裹在 `region` 键下）；Rust 侧 `params.get("screenshot_region")`（screenshot.rs:77，读 `screenshot_region` 键）→ 永远解析不到 → 恒全屏。修复：二选一对齐键名（建议 Rust 侧兼容读 `region`，或 TS 侧改传 `screenshot_region`）。
另注（用例小笔误）：data 只含 `actions_and_results/screenshot_base64/screenshot_format/fallback_used`，**无 width/height 字段**（DesktopChannel.screenshot 构造时丢弃了 captureScreenshot 返回的 width/height）——「width/height>0」子断言在当前实现上不可满足，尺寸改由 PNG IHDR 验证；建议产品侧顺手把 width/height 透出到 data。

### T-DESKTOP-11 interactive_only 剪枝 — **pass**

同 app 两次 snapshot：interactive_only=true → 368 节点；false → 675 节点（剪掉 45%）。root（application）恒保留 ✓；剪枝树叶子 role ∈ {button, menubutton, menuitem, radio, select, textfield} 全部为交互角色 ✓。

### T-DESKTOP-12 OutlineMapper 标准化 — **pass**

- 全树 675 节点，ref @e0..@e674 连续无跳号（refCounter 与节点数一致）✓；剪枝树保留原 ref（有跳号，属后处理剪枝的稳定 ref 设计，非缺陷）
- pictureOnly 5 个节点：全部无 children、无 label、role=unknown、w/h 均 >100（如 135x685、364x384）✓

### T-DESKTOP-13 AXRole 映射 — **pass**

全树 20 种 mapped role：application/window/button/textfield/menu/menuitem/menubar/menubaritem/menubutton/radio/row/scrollarea/select/toolbar/tree/group/img/list/text/unknown。button/textfield/window 等 mapped role 出现 ✓；未收录角色落 unknown（78 个）✓。

### T-DESKTOP-14 app 名→bundle 表 — **pass**

- 本机为 macOS 12（System Preferences）；已打开 System Preferences 后测：
- "Finder" → worked；"com.apple.finder" → worked（等价）✓；"系统设置" → worked（app_bundle_map.rs:22-26 映射 com.apple.systempreferences，本机等价命中）✓
- "Safari"（未运行）→ didnt（resolve_root failed；app_not_found kind 被 error 文案遮蔽，同 T-DESKTOP-01 观察）✓
- "不存在App" → didnt ✓
- 中文名等价英文名 ✓

## 统计

执行条目共 16：T-DESKTOP-01/02/04/06/08/09/10/11/12/13/14/15/17/18/19/20。

| verdict | 计数 | 条目 |
|---|---|---|
| pass | 14 | T-DESKTOP-01/02/04/06/08/10/11/12/13/14/15/17/19/20 |
| fail | 2 | T-DESKTOP-09、T-DESKTOP-18 |
| blocked | 0 | （无 tcc 未授权项；tcc_denied 分支本机已授权不可测，记 n/a 不扣分） |
| waived | 0 |

## fail 与异常项清单

1. **T-DESKTOP-09 fail（产品缺陷）**：screenshot_region 裁剪不生效，恒全屏。根因 = TS `{region}` 包裹键（ScreenshotVlmProvider.ts:92）vs Rust `params.screenshot_region` 读取键（screenshot.rs:77）wire 键名漂移。附带：data 无 width/height 字段（channel 层丢弃）。
2. **T-DESKTOP-18 fail（轻，产品可观测性缺陷）**：LASSO_RUST_HELPER_PATH 坏路径时调用被拒（语义正确），但 spawn ENOENT 的 `error` 事件未接入 pending reject（SubprocessManager 只打日志），错误归因为 `rust_call_timeout:*` 且每次烧满 3s 超时，`rust_helper_crashed`/spawn 错误分类不可达。
3. 观察（不判 fail，供产品组）：
   - #15 doctor 把「完全未签名」误报为「可能未构建」warn（正则未覆盖 "code object is not signed at all"），且与文档「未签 → fail」不符；
   - AxProvider `resp.error ?? resp.error_kind` 使 `app_not_found`/`tcc_denied` 等 error_kind 永不出现在 MCP 面；
   - cgEvent 未知键名的 `cgevent_unknown_key` token 在 MCP 聚合面被 `all_cgevent_actions_failed` 吞掉；
   - T-DESKTOP-06 的 `key:36`（number）子项为用例笔误：zod 先拒，INV-28 层经 MCP 不可达（防御仍在，程序化可达）；
   - 多面板共用 mcp.mjs 执行期间被并行改写（含一版丢失 env 透传，曾致一次假 pass），本面板改用私有快照 wave1-desktop-mcp.mjs 后复测——后续面板建议固定各自快照。
