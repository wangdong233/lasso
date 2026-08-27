# 第 4 轮最优性复审 · 桌面自动化域（desktop 通道 / Rust AXAPI 四档）

- 复审日期：2026-08-17（release/星标数据当日实取）
- 复审对象：lasso **v1.13.0 工作树** desktop 通道（三轮共 14 项：round1 T3/T7/T8/T11/T15 + round2 T2-6/T2-7/T2-8/T2-9/T2-10/T2-11 + round3 T3-2/T3-3/T3-6 已全部落地并过 round3-review03 zero-issues-pass）
- 定位：round3-verdict 附则三明示 round4 = **验收轮**——本轮任务①白盒抽验最新实施（T3-2/T3-3/T3-6 直读源码，不采信文档）②watch/NO-GO 新证据核查（无新证据不翻）③新热项目扫描
- 本机门禁亲跑：`npm run build` ✅ / `npm test` **1961 总量（1959 passed + 1 timing-flaky + 1 skipped）**——flaky 为 expect-poll 配置优先级用例（timing-sensitive 标记在案），单文件复跑 **43/43 绿**，与 round2/round3 记录的偶发 timing-flaky 同族、非 desktop 改动引入 / `check-invariants` **79/79** ✅ / `cargo test`（rust-helper）**42+101+9+10+30+9+6 = 207 passed** ✅（与 round3-review03 基线 207 逐项一致）

---

## 0. 三轮 14 项落地的白盒抽验（本轮任务①；重点直读 round3 新码）

round1/round2 的 11 项 round3-desktop §0 已逐项复核达最优（含 F2 单一真源、T2-6 三分支闭环等），本轮不重复。本轮直读 round3 三项新码：

| 项 | 实现锚点（本轮直读确认） | 复审结论 |
|---|---|---|
| **T3-2** region 坐标补偿 | `ScreenshotVlmProvider.ts:205-208`（parse → **offset** → dispatch，接缝正确）+ `offsetVlmActionsByRegion`（:394-423 纯函数：click/move 的 x,y；drag 四值；scroll 仅 x,y 双在场才平移、dx/dy 不动；无 region 原数组原样返回） | **达最优**。三处超裁决书最低线的正确决策：① 平移字段名与 `parseOneVlmAction` 归一化输出（:455-496）逐字段吻合——scroll 单坐标在 parse 层就不产生，平移层守卫与 parse 不变量一致（不重复防御也不漏防）；② **审计标签 `vlm_click@(150,260)` 用平移后全局坐标**——报的是真执行位置而非 VLM 原始区域坐标；③ 负坐标不平移不裁剪（macOS 多屏全局坐标合法负，无人工钳位）。测试含裁决书指定用例「region(100,200) + vlm click(50,60) → wire 收到 (150,260)」+ drag 四值/scroll 可选/button 透传/无 region byte-identical 四边界。前提链复核：Rust `screenshot.rs:46,76-77` 确按 `screenshot_region` 裁剪；`buildVlmPrompt` 只发 app/actions/where/expect（无区域原点）——VLM 返区域相对坐标的前提成立，五环闭合 |
| **T3-3** where.ref 根治 | zod `tools/desktop.ts:108-117`（where 只声明 text/role + 成文注释：strip 后空 where → Rust 兜底拒绝）+ Rust `ax.rs:182-198`（where 存在但 text/role 均空（含空白串）→ `invalid_params` + 人话 error）+ TS `AxProvider.ts:190-196`（where 缺席 → `missing_where_clause` didnt，前置既有守卫） | **达最优**。三层无洞：zod 剥 ref（schema 不承诺未实现语义）→ 空对象到 Rust 被兜底拒（防绕过 zod 直发 wire）→ 缺席被 TS 拒（MCP 主路径）。**本轮补验两处无回归**：① verifyExpect（`DesktopChannel.ts:283-298`）text/role 双缺即 `expect_needs_text_or_role` 早退——内部路径永不构造空 where 打到新兜底；② act 路空 where = 全树编号（与 snapshot @eN 同序）是 ref 经 actions[].ref 消费的合法语义、与 find 的拒绝分立（review03 1.3 已裁定，本轮读码确认分立仍在）。Rust 侧 `t33_find_where_ref_only_rejected` / `t33_find_where_empty_object_rejected`（ax.rs:1093-1111）+ zod strip/schema 源码三测（desktop-tool-schema.spec.ts:164-201）双端钉住 |
| **T3-6** tcc → didnt 对齐 | `ScreenshotVlmProvider.ts:242-256`（dispatch 失败分支特判 `tcc_event_synthesis_denied` → **didnt** + System Settings 引导文案；其它 error_kind 维持 unknown） | **达最优**。与 CGEventProvider 同 producer 同映射同文案；测试含非回归用例（`cgevent_source_failed` 仍 unknown）。tri-state 分类学补完：权限=明确否（didnt），推断/执行不确定=unknown |

**总判断：三轮 14 项全部达最优，零返工意见，本轮白盒未发现新缝隙。** round1 五项修「能力」，round2 六项修「链尾诚实与物理质量」，round3 三项修「实施自己引入的残留缝隙」——收敛轨迹与三轮裁决书预言逐轮吻合。

---

## 1. 生态与对标（round3 后窗口：08-17 当日 live 实取）

GitHub API 直连经本网络环境异常（301 劫持），改经 web-reader live 页逐仓核（no_cache）+ shields.io 星标实取：

| 项目 | 星标（08-17） | 最新 release（live 页核实） | 与 Lasso 关系 |
|---|---|---|---|
| openclaw/Peekaboo | 5.0k | **v4.2.0（2026-08-16）——round3 已覆盖版本，零新 release** | 维持全部结论；Tachikoma/agent 平台化=生态位分化记档不变 |
| lahfir/agent-desktop | 1.0k | **v0.8.1（2026-08-14）——零新 release** | 维持（complete:false/type 梯子/鼠标质量/T2-9 actions 已对齐） |
| injaneity/pi-computer-use | 1.7k | **v0.5.0（2026-07-26）——零新 release** | 维持（三平台真实现基准；R11 不变） |
| bytedance/UI-TARS-desktop | ~39k | 无架构变化 | 档4「推断→真执行」形态（T2-6）已对齐 |
| **hyprcat/mac-cua**（本轮新 surfaced） | **23★**（repo 极新；Apache-2.0；Python 3.13/PyObjC；216-270 tests 自报） | 无版本化 release（release / confirmed-delivery-pipeline 双分支） | **长尾记档，不立项**——详见 §2 C-2 条 |
| macos26/Agent / CursorTouch/MacOS-MCP / macos-use（Reddit surfaced） | 长尾 | — | AX-MCP 泡沫化延续（round2 §1 判断再验证）；agent 层/chrome 层不对标抓手层 |

**mac-cua 白盒要点**（对 C-2 watch 项有方向证据价值，故记档详于普通长尾）：
- 卖点即「CGEventPostToPid, never CGEventPost」——进程定向投递、不动用户光标/焦点；是 background-first 方向**第三个独立佐证**（Peekaboo v4.1/4.2 全押、agent-desktop、mac-cua），且它证明**不需要 receipts/session 基建也能做简版**（与 Peekaboo 重基建路线对照）。
- 但其自记已知限制恰是反向证据：background 复杂快捷键不触发、scroll 需瞬时 focus、**Electron set_value 被拒**（→ 正向验证 Lasso T2-7 兜底链的必要性）、Electron 双击失败、自动纠正吃字；其实验分支为确认投递引入 CGEventTap/SkyLight SPI——**显示做对 background-first 的深水区**，与 round2 C-2「方向证据增强但复杂度证据也增强」判断一致。
- 结论：C-2 触发条件（Lasso 用户真实多任务干扰痛点）依旧未出现，**不翻案**；mac-cua 记为 C-2 的生态新样本（含「简版可行」与「深水区限制」双向证据）。

> 结论：**三大对标 round3 后零发版、无新量级对手、格局零变化**——与 round3 判断一致，本轮无可翻案的新证据。

---

## 2. 上轮 watch/NO-GO 复核（本轮任务②；无新证据不翻案）

| 处置 | 本轮结论 | 依据 |
|---|---|---|
| C-2 备忘 PostToPid / background-first（watch） | **维持 watch** | Peekaboo 零新 release；新样本 mac-cua（§1）双向证据入档：简版可行 + 深水区限制自认；触发条件（真实多任务干扰痛点）未出现，且 Lasso 单用户主力场景下 CGEvent 全局投递是已声明的可见副作用（诚实语义），非缺陷 |
| R3 stateId 句柄缓存（watch） | **维持 watch** | 零新证据；F2 单一真源健壮性来自不缓存（三轮一致） |
| R11 Windows/Linux 深度实装（NO-GO） | **维持 NO-GO** | pi v0.5.0 后零新版本；macOS 主力 + uia/atspi 诚实桩契约不变 |
| D10 npm 预编译二进制（记档） | **维持记档** | 属发布工程轮次（见 §4 发布收口） |
| agent-desktop `launch --cdp`（watch） | **维持 watch** | v0.8.1 后零新版；AX 内修复够用 |
| Peekaboo human-typing 拟人节奏（watch，round3 新记） | **维持 watch** | 零新证据；无场景判断不变 |
| 手测清单 A-G（round3-review03 遗留 #1） | **维持 pending，是本域 ROUND-CLEAN 的唯一未闭合条件** | 七节清单（stdin-EOF / OS 指纹 / Accept-Language echo / Electron type / drag / find actions+truncated / T3-2 真机 VLM / T3-6 权限场景）待用户真机签核——非代码项，不能由调优项替代 |

---

## 3. 候选调优项（本轮任务③；五门槛：白盒证据差距/既有能力范畴/单轮可完成/收益可验证/不破红线）

**空集。**

依据（逐门槛）：
- **白盒证据差距**：本轮直读 T3-2/T3-3/T3-6 三项新码（§0）+ 复验 verifyExpect/act-find 分立/AxProvider 前置守卫，**未发现新的证据差距**。round1 修能力、round2 修链尾、round3 修实施缝隙——三轮候选轨迹 5→6→3→0，desktop 域差距清零；
- **既有能力范畴**：mac-cua 的 background-first 属 C-2 watch 域（非既有能力、单轮不可诚实完成——其深水区自证）；
- **宁缺毋滥复核**：本轮看过但不立项——① mac-cua 式 CGEventPostToPid 简版（C-2 触发未到 + 双向证据 §2）；② VLM 档多动作间延时参数化（无实测失败证据，违「先拿事实再加参数」，round3 已拒）；③ expect 支持 ref 后置条件（现状「不可验证即诚实失败」语义闭环，R3 stateId 域）；④ T3-6 didnt 分支不附截图（与 CGEventProvider 同款镜像，N-R3-1 已记 intentional）。

这是 desktop 域四轮以来**首次候选空集**——与 search 域 round3 率先归零的收敛形态一致。

---

## 4. 结论

- **三轮 14 项全部达最优、零返工**：round3 三项（T3-2/T3-3/T3-6）经本轮独立直读源码复核（非采信 review03），接缝/字段映射/三层防御/边界用例全部正确；round1/round2 的 11 项在 round3-desktop 已复核，本轮无翻案证据；
- **watch/NO-GO 零翻案**：三大对标（Peekaboo v4.2.0 / agent-desktop v0.8.1 / pi v0.5.0）当日 live 页核实零新 release；新增 mac-cua（23★）作为 C-2 的生态新样本入档（简版可行 + 深水区限制双向证据，不触发立项）；
- **候选调优项空集**：desktop 域四轮首次——**代码层面 ROUND-CLEAN 达成**；
- **两个非代码条件未闭合**（均非本轮复审员可代行）：
  1. **手测清单 A-G 签核**（round3-review03 遗留 #1）——三轮质量证据链最后一环，desktop 域终态 CLEAN 的充要条件；
  2. **发布收口**（round3-verdict 附则一）——工作树含 round2+round3 全部改动仍未 commit（HEAD=0b07536 v1.11.0，npm latest=1.10.0），三轮用户可感知修复（孤儿进程/假 worked/T3-2 假 worked 换装/where.ref 等）积压未达 `npx lasso-mcp` 用户，建议按附则一一次性 commit + publish v1.13.0；
- 附注：门禁基线 1961（含 1 复跑即绿的 timing-flaky）/ 79 INV / 207 rust 全绿维持；expect-poll flaky 与 round2/round3 同族，与本域改动无关（desktop 域无 timing-sensitive 新增用例）。
