# 第 5 轮最优性复审 · 桌面自动化域（desktop 通道 / Rust AXAPI 四档）

- 复审日期：2026-08-17（release/星标数据当日实取）
- 复审对象：lasso **v1.13.0 工作树** desktop 通道（四轮共 14 项：round1 T3/T7/T8/T11/T15 + round2 T2-6/T2-7/T2-8/T2-9/T2-10/T2-11 + round3 T3-2/T3-3/T3-6 全部落地；round4 候选空集 + T4-1 注释清尾已实施）
- 定位：round4-verdict 附则三 designated **收尾轮（closure round）**——①白盒抽验最新实施（不采信文档）②watch/NO-GO 新证据核查（无新证据不翻）③新热项目扫描
- 本机门禁亲跑（2026-08-17 本轮窗口）：`npm run build` ✅ / `npm test` **1960 passed + 1 skipped（1961），零失败零 flake**（与 round4-verdict 裁决官独立跑逐字一致；round3/round4-desktop 曾记录的 expect-poll timing-flaky 本轮未复现）/ `check-invariants` **79/79** ✅ / `cargo test`（rust-helper，`~/.cargo/bin/cargo`）**8 套件 207 passed** ✅（= round3/round4 基线逐项一致）

---

## 0. 最新实施白盒抽验（本轮任务①）

### 0.1 T4-1（round4 唯一调优项，browser 域注释卫生族清尾）已落地

- `grep -rn "注入路径健在" src/` → **零命中**（裁决书机械化验收通过）；
- `doctor.ts` #27 清单头已为「v1.11 起走原生 list_network_requests 直调；旧 PerformanceObserver 注入路径已随 T5 删除」；`types.ts:152`（network_timeout_ms）与 `types.ts` NetworkResult 注释×2 均已与 producer 现值对齐——v1.13.0 发布前不随版本固化的目标达成。

### 0.2 desktop 域四轮 14 项独立直读复核（本轮新读的接缝，非引用前轮结论）

| 抽验点（本轮亲读锚点） | 结论 |
|---|---|
| `ax.rs:259-399` act 全路径：walk 单一真源 + number_refs 锁步编号 + cycle 占位拒执行（:355-362）+ 三元组 stale（verify_not_stale :460-494，role/label 精确 + rect 中心 ≤50px）+ 越界 stale_ref + 每元素 1.0s messaging timeout + press/hotkey 逐项诚实 ax_unsupported_action 留档3 | 达最优 |
| `ax.rs:525-663` type 兜底链：AXValue 主路径（写后读回 + secure 豁免）→ `type_error_should_fallback`（仅 unsupported/set_failed 兜底，verify_failed 不兜——决策成文）→ AXFocus+50ms+cmd+a 整值替换 + ASCII 逐键 + 读回（可读且 string 才比对；跳过条件注释成文） | 达最优 |
| `ax.rs:175-198` find where 兜底拒绝：where 在但 text/role 均空（含 trim 空白）→ `invalid_params` + 人话 error（"ref is act/expect domain"）——T3-3 三层防御的 Rust 层独立复核确认 | 达最优 |
| `ScreenshotVlmProvider.ts:156-347` VLM 闭环：截图失败透传 / vlm 未配 didnt / 三分支（不可解析→unknown / 执行失败→unknown / ≥1 成功→worked）+ T3-2 offset 接缝（parse→offset→dispatch）+ T3-6 tcc_event_synthesis_denied→didnt 特判 + 逐项 ref 标签用平移后全局坐标 | 达最优 |
| `cgevent.rs:192-198` dispatch 入口 Event Synthesizing 预检（denied→诚实报因）+ `:333-465` 鼠标物理质量（clickState=1 + 10ms down→up；drag 200ms 按住 + 12 点 16ms 插值 + 100ms 沉淀；INV-28 逻辑按钮名 raw code 拒收） | 达最优 |
| `DesktopChannel.ts:258-329` expect 接线（worked+expect→verifyExpect，失败翻 didnt；text/role 双缺→expect_needs_text_or_role 诚实早退）+ T2-10 稳定性采样（verifyExpect/wait 均 consecutive≥2；wait 的 streakFromStart 在第 1 次迭代锁定——preexisting 语义在采样下正确） | 达最优 |

**总判断：四轮 14 项 + T4-1 全部达最优，零返工意见；本轮独立直读未发现新缝隙。**

---

## 1. 生态与对标（round4 后窗口：08-17 当日 live 实取）

GitHub API 直连仍异常（301 劫持，round4 已记录），改经 web-reader live 页逐仓核（no_cache）+ shields.io 星标实取：

| 项目 | 星标（08-17 实取） | 最新 release（live 页核实） | 与 Lasso 关系 |
|---|---|---|---|
| openclaw/Peekaboo | 5k | **v4.2.0（2026-08-16）——round3/round4 已覆盖版本，零新 release** | 维持全部结论（background-first=生态位分化记档；C-2 watch 不变） |
| lahfir/agent-desktop | 1k | **v0.8.1（2026-08-14）——零新 release** | 维持（complete:false/type 梯子/鼠标质量/actions 均已对齐） |
| injaneity/pi-computer-use | 1.7k | **v0.5.0（2026-07-26）——零新 release** | 维持（三平台真实现基准；R11 NO-GO 不变） |
| hyprcat/mac-cua | 23 | 无版本化 release | C-2 生态新样本（round4 已入档），无变化 |
| bytedance/UI-TARS-desktop | ~39k | 无架构变化 | 档4「推断→真执行」形态（T2-6）已对齐 |
| 检索面新 surfaced（LMCP / Macuse / mcp-server-macos-use / Safari TP 247 MCP / macos26-Agent） | 长尾 | — | **全部不立项**：前二为原生 Mac agent app（agent 层非抓手层）、mcp-server-macos-use 为长尾 AX-MCP 泡沫化延续、Safari TP 属 browser 域、macos26 round3 已记档。dev.to「You Do Not Need an MCP Server for Every Mac App」（AXAPI 通用接口论）与 round2 Medium「8 团队入局」同向——**AXAPI 品类共识继续正向验证，无新量级对手**（连续第三轮） |

**本轮新证据增量（来自本轮全文精读 Peekaboo v4.0.0/v3.10.0 完整 release notes——round2/3/4 仅覆盖 highlights，两处 Fixed/Added 明细此前未入档）：**

1. **v4.0.0 Fixed：「Non-US keyboard layouts preserve requested characters during background typing. Thanks @canvascoding for #330」**——上游实证 macOS keycode 合成输入在非 US 键盘布局下产出错误字符，真实到值得 Peekaboo 专门修复。
2. **v3.10.0 Added：「reference-bound image-pixel and normalized MCP click coordinates」**——上游实证 MCP 生态中视觉坐标存在 **normalized 归一化形态**（[0,1]/[0,1000] 刻度），Peekaboo 为此建了 capture-context 映射。

此两条与 Lasso 的潜在交集及处置见 §2 W1/W2（**均不构成候选**——见 §3 门槛分析）。

---

## 2. 上轮 watch/NO-GO 复核（本轮任务②；无新证据不翻案）

| 处置 | 本轮结论 | 依据 |
|---|---|---|
| C-2 备忘 PostToPid / background-first（watch） | **维持 watch** | Peekaboo v4.2.0 后零新 release；mac-cua 无变化；触发条件（真实多任务干扰痛点）未出现 |
| R3 stateId 句柄缓存（watch） | **维持 watch** | 零新证据；F2 单一真源健壮性来自不缓存（四轮一致） |
| R11 Windows/Linux 深度实装（NO-GO） | **维持 NO-GO** | pi v0.5.0 后零新版本；macOS 主力 + uia/atspi 诚实桩契约不变 |
| agent-desktop `launch --cdp`（watch） | **维持 watch** | v0.8.1 后零新版；AX 内修复够用 |
| Peekaboo human-typing 拟人节奏（watch） | **维持 watch** | 零新证据；无场景判断不变 |
| D10 npm 预编译二进制（记档） | **维持记档** | 属发布工程轮次——**本轮已进入收口执行窗口**（见 §4） |
| 手测清单 A-G（round3-review03 遗留 #1） | **维持 pending——desktop 域终态 ROUND-CLEAN 的唯一未闭合代码侧外条件** | 七节清单（stdin-EOF / OS 指纹 / Accept-Language echo / **Electron type** / drag / find actions+truncated / T3-2 真机 VLM / T3-6 权限场景）待用户真机签核 |
| **W1（本轮新记 watch）T2-7 键盘兜底的非 US 布局/IME 敏感性** | **新增 watch，不立项** | 证据链：①Lasso T2-7 兜底经 `ascii_char_to_keymap_spec`→CGEvent 裸 keycode（`ax.rs:625-639`）；②Peekaboo #330（§1 证据 1）上游实证该路径在非 US 布局产出错字符；③Lasso 读回验证在 **AXValue 可读**时能诚实拦截（ax_verify_failed），但在兜底自身的目标场景（Electron 自绘控件 AXValue 非 string）读回被跳过（`ax.rs:641-661` 注释成文）→ 理论上存在「错字符 + ok:true」交集。**不立项理由**：Lasso 侧零实测失败（主路径 AXSetValue 零事件合成，兜底触发面窄）；手测清单 E（Electron type）正是该路径的指定验证步骤未跑——违 round3「先拿事实再加参数」纪律。**触发条件**：E 在非 US 布局/中文 IME 激活态实测产出错字符且 ok:true → 实施 ASCII-capability 门（TIS 读当前 input source，非 ASCII-capable 则兜底诚实拒绝，XS 代价） |
| **W2（本轮新记 watch）VLM 档 normalized 坐标形态** | **新增 watch，不立项** | 证据链：①`parseVlmActions` 一切有限数均按绝对像素直传（`ScreenshotVlmProvider.ts:445-498`），无 bounds/归一化判定；②Peekaboo v3.10.0（§1 证据 2）实证生态中 normalized 坐标是真实产出形态。**不立项理由**：Lasso prompt 已传 width/height 且 shape 不锁（具体 VLM 是否产出 normalized 未观测）；零 Lasso 侧实测失败。**触发条件**：配置的 VLM 实际观测到 [0,1]/[0,1000] 刻度坐标导致落点错误 → parseVlmActions 加形态判定（值域全 ≤1（或 ≤1000）且截图尺寸远大于值域 → 按比例换算或拒绝，XS 代价） |

---

## 3. 候选调优项（本轮任务③；五门槛：白盒证据差距/既有能力范畴/单轮可完成/收益可验证/不破红线）

**空集（连续第二轮）。**

依据（逐门槛）：
- **白盒证据差距**：本轮独立直读四轮 14 项全部关键接缝（§0.2）+ T4-1 落地验收，**未发现新的 Lasso 侧证据差距**。候选轨迹 5→6→3→0→0，desktop 域代码层面差距维持清零；
- **W1/W2 五门槛逐一未过**：两者均有上游新证据（本轮新入档），但均缺 **Lasso 侧实测失败**——「上游修过同类问题」证明失败类真实存在，不证明它在 Lasso 的具体配置面（主路径占比、VLM 产出形态）上发生；按 round3 拒绝「VLM 多动作间延时参数化」的同一纪律（无实测失败不加机制），记 watch 挂到手测清单 E / 首次真机 VLM 观测，触发即修（修法已写明、均 XS）；
- **既有能力范畴**：检索面新 surfaced 项目全部为 agent 层/browser 层/长尾（§1），无一进入抓手层范畴；
- **宁缺毋滥复核**（本轮看过但不立项）：①VLM 坐标 bounds 硬校验（如拒绝超出截图区域的坐标）——无实测误派发证据，且 macOS 多屏负坐标合法，误拒风险反向存在；②keyboard 兜底前布局预检（=W1 提前实施，触发条件未到）；③expect 支持 ref 后置条件——现状「不可验证即诚实失败」语义闭环（R3 stateId 域，四轮一致）；④T3-6 didnt 分支不附截图——intentional 镜像（round3 已裁）。

---

## 4. 结论

- **四轮 14 项 + round4 T4-1 全部达最优、零返工**：本轮对 act/type 兜底/find 拒绝/VLM 闭环/鼠标物理质量/wait-expect 采样/Event Synthesizing 预检七个接缝全部独立直读（非采信文档），接缝与注释成文质量与前四轮验收一致；
- **watch/NO-GO 零翻案 + 新增 2 条 watch（W1 键盘兜底布局敏感 / W2 VLM normalized 坐标）**：三大对标（Peekaboo v4.2.0 / agent-desktop v0.8.1 / pi v0.5.0）当日 live 页核实零新 release；两条新 watch 均来自本轮全文精读上游 release notes 明细（此前轮次只覆盖 highlights），有上游实证、无 Lasso 侧实测失败——按纪律挂触发条件不立项，触发即修且修法已预写（均 XS）；
- **候选调优项空集（连续第二轮）**：desktop 域代码层面 ROUND-CLEAN 维持；与 round4-verdict「收尾轮」定位一致——本轮复审未发现任何需要重启 surveillance 的版本级变动；
- **desktop 域终态 CLEAN 仅剩两个非代码条件**（均非复审员可代行，与 round4 结论一致）：
  1. **手测清单 A-G 用户真机签核**——含 W1 触发判定所依的 E 节（Electron type，建议在中文 IME 激活态跑一次以顺带裁决 W1）；
  2. **发布收口**——HEAD 仍=0b07536（v1.11.0），工作树 v1.13.0 含四轮 ≈41 项用户可感知修复未 commit/publish（T4-1 已完成，v1.13.0 注释面已可随版本固化，无再拖延的技术理由）；
- 附注：门禁基线 1961（1960+1skip，本轮零 flake）/ 79 INV / 207 rust（8 套件）全绿维持；cargo 需 `~/.cargo/bin/cargo` 全路径调用（后台 shell PATH 无 cargo，非项目缺陷）。
