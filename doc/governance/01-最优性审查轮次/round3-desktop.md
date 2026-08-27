# 第 3 轮最优性复审 · 桌面自动化域（desktop 通道 / Rust AXAPI 四档）

- 复审日期：2026-08-17（release/星标/文档数据当日实取）
- 复审对象：lasso **v1.12.0** desktop 通道（round1 五项 T3/T7/T8/T11/T15 + round2 六项 T2-6/T2-7/T2-8/T2-9/T2-10/T2-11 已全部落地并过 round2-review03 zero-issues-pass）
- 方法：①白盒重读全部 11 项新实现（非抽验 claimed，直接读 v1.12 工作树源码）②三大对标项目 release 页当日抓取验新证据 ③新项目扫描。不重复 round1/round2 已裁决内容
- 本机门禁实测：`npm run build` ✅ / `npm test` **1940 passed + 1 skipped（1941）**（首次全量 1 failed 为 timing-flaky，JSON reporter 复跑 0 failed，与 round2 记录的 flaky 现象同族）/ `check-invariants` **79/79** ✅ / `cargo test`（rust-helper）**202 passed** ✅（基线全维持）

---

## 0. 两轮 11 项落地的白盒抽验（本轮任务①）

对 v1.12.0 工作树逐项重读（非采信文档声称）：

| 项 | 实现锚点（本轮重读确认） | 复审结论 |
|---|---|---|
| T3 ax_act | `ax.rs:222-384`：walk 单一真源 + `number_refs`/`collect_matches` 同源锁步（F2）+ cycle 占位拒执行（:345-352）+ 三元组 stale（role 精确/label 精确/rect 中心 ≤50px）+ 每元素 1.0s messaging timeout | **达最优**。构造性一致（同一 walk 产物）无法漂移；无改进空间 |
| T7 鼠标四路径 | `cgevent.rs:217-229` dispatch 分流 + `exec_mouse_action`（:371-501） | **达最优** |
| T8 walk 剪枝 v2 | `ax.rs:127-131` skeleton children_count + HashSet 防环 + wrapper 深度中和 | **达最优** |
| T11 Event Synthesizing | `cgevent.rs:192-198` dispatch 入口预检（denied → 诚实报因）+ tcc.rs 三态 | **达最优** |
| T15 expect 接线 | `DesktopChannel.ts:250-329`：worked+expect → find 轮询后置条件，失败翻 didnt；只有 ref/gone 无 text/role → `expect_needs_text_or_role` 诚实报因 | **达最优**（expect.ref 不可验证时诚实失败——与 C3-2 的 find.ref 静默忽略形成对照：同族问题 expect 侧已做对） |
| T2-6 VLM 闭环 | `ScreenshotVlmProvider.ts:186-326` 三分支（不可解析→unknown/执行失败→unknown/≥1 成功→worked）+ `parseVlmActions` 纯函数（只收鼠标四类，键盘注入拒绝——INV-28 纪律精神）+ results 逐项映射 | **结构达最优，留一处坐标偏移缝隙（本轮新发现，C3-1）** |
| T2-7 type 兜底 | `ax.rs:473-570`：AXValue 主路径 → `type_error_should_fallback`（只兜 unsupported/set_failed，**verify_failed 不兜**——重打是重试不是兜底，决策成文）→ AXFocus+50ms+cmd+a 整值替换+ASCII 逐键+读回验证；`ensure_ascii_typable`/`ascii_char_to_keymap_spec` 纯函数单测锚点 | **达最优**。cmd+a 保证与 AXSetValue 同为整值替换语义是超出裁决书要求的正确决策 |
| T2-8 鼠标质量 | `cgevent.rs:333-465`：clickState=1（field 1）+ 10ms down→up；drag 200ms 按住 + 12 点插值（16ms 步进）+ 100ms 沉淀；参数出处注释 + 纯函数单测（退化 drag 不 NaN 不发散） | **达最优** |
| T2-9 find actions | `ax.rs:765-800` collect_matches 命中项附 AXActionNames；**不进 snapshot 全树**（token 守护贯彻）；空省略 | **达最优** |
| T2-10 稳定性采样 | `DesktopChannel.ts:300-309`（verifyExpect consecutive≥2）+ `:367-389`（wait：`streakFromStart` 在 streak 第 1 次锁定 firstIteration——preexisting 语义在采样下仍正确） | **达最优** |
| T2-11 truncated | `ax.rs:161-170` apply_truncated_flag（仅截断时插根字段）+ `AxProvider.ts:165` 读 wire 根（绕开 OutlineMapper 裁剪风险） | **达最优** |

**总判断：11 项中 10 项无返工意见；T2-6 的三分支语义/键盘拒绝/结果映射全部正确，但 region 截图与全局坐标的换算缺席（C3-1）——这是实施缝隙而非设计缺陷（T2-6 裁决书未预见 region 交互面）。**

---

## 1. 生态与对标（round2 后窗口：08-17 实取）

| 项目 | 热度（08-17 实取） | round2 后新变化 | 与 Lasso 关系 |
|---|---|---|---|
| openclaw/Peekaboo | 5.0k★ | **无新 release**（最新 v4.2.0 = 2026-08-16T13:56Z，round2 已覆盖）。repo 结构（zread 白盒）显示三个新方向：①`Tachikoma/` agent runtime + `docs/agent-chat.md`（从 CLI/MCP 工具向 agent 平台演化）②`docs/human-typing.md`/`human-mouse-move.md` 拟人输入节奏（wpm/log-normal jitter/思考停顿——「mimic humans」场景）③`Commander/` + poltergeist 测试基建 | **生态位分化记档**：Peekaboo 向「自带 agent 的平台」走，Lasso 是「CC 的抓手层」——竞争重心继续偏离；human-typing 对 Lasso 无场景（本地授权自动化无需拟人；type 主路径 AXSetValue 零事件合成，兜底路径 ASCII 逐键走可用性不走拟人）——**watch 记档不立项** |
| lahfir/agent-desktop | 1.0k★ | **无新 release**（最新 v0.8.1 = 08-14，round2 已覆盖） | 维持 round2 全部结论（complete:false/type 梯子/鼠标质量均已对齐） |
| injaneity/pi-computer-use | 1.7k★ | 无新版本（v0.5.0 = 07-26） | 维持 |
| bytedance/UI-TARS-desktop | 39k★ | 无架构变化 | 档4 闭环（T2-6）已对齐其「推断→真执行」形态 |
| nut-tree/nut.js | ~2.8k★（fork 月下载 14k 量级） | 上游停更不变 | Lasso 自持 CGEvent 路径价值不变 |
| **macos26/Agent**（新 surfaced） | 574★，2026-03 创建 | 本轮搜索 surfaced（非 round2 后新品）：macOS 26 原生 agent app，17 providers + 并行子 agent + AX 驱动 | **agent 层非抓手层**，与 Lasso 不对标；长尾记档 |
| CursorTouch/Windows-MCP | 长尾 | Windows computer use MCP（CursorTouch 系） | Windows 侧长尾，Lasso macOS 主力无关；记档 |

> 结论：**本域格局 round2 后零变化**——三大对标无一发版、无新量级对手。AXAPI-MCP 品类竞争重心（act 链可靠性/诚实信号）round2 已全部对齐，本轮无可翻案的新证据。

---

## 2. 上轮 watch/NO-GO 复核（本轮任务②；无新证据不翻案）

| 处置 | 本轮结论 | 依据 |
|---|---|---|
| R3 stateId 句柄缓存（watch） | **维持 watch** | 无新证据；F2 单一真源的健壮性仍来自不缓存 |
| C-2 备忘 PostToPid / background-first（watch） | **维持 watch** | Peekaboo v4.2 后无新 release；触发条件（真实多任务干扰痛点）未出现 |
| R11 Windows/Linux 深度实装（NO-GO） | **维持 NO-GO** | pi v0.5.0 后无新证据；macOS 主力 + 诚实桩契约不变 |
| D10 npm 预编译二进制（记档） | **维持记档** | 无变化；属发布工程轮次 |
| agent-desktop `launch --cdp`（watch） | **维持 watch** | v0.8.1 后无新版；AX 内修复（wrapper 中和）够用 |
| 7 级 scroll 瀑布 / auto-wait 默认开 / 签名 receipts / 剪贴板 type 兜底（不做） | **维持不做** | 无新证据 |
| Peekaboo human-typing 拟人节奏（本轮新记） | **新增 watch（不立项）** | 无场景：本地授权自动化不需要「看起来像人」；引入 wpm/jitter 参数面违简单架构 |
| 手测清单 A-E（round2-review03 遗留 #2） | **维持 pending，催办** | 五项真机验证（stdin-EOF kill CC / OS 指纹 / Electron type / drag 滑条 / find actions+truncated）仍未执行——两轮实施的质量证据链最后一环，建议随 C3-1/C3-2 一并在下一真机窗口签核 |

---

## 3. 候选调优项（本轮任务③；五门槛：白盒证据差距/愿景内/单轮可完成/收益可验证/不破红线）

### C3-1（P1）T2-6 补缝：VLM 档截图 region 的坐标偏移补偿

- **白盒证据链（五环闭合，本轮新发现）**：
  1. `src/tools/desktop.ts:114-121`：act 的 options **接受 `screenshot_region`**（与 screenshot action 共用 schema）；
  2. `src/desktop/ScreenshotVlmProvider.ts:154`：`act()` 用 `opts.screenshot_region` 裁剪截图 → VLM 看到的是**区域图**，返回坐标是**相对区域**的；
  3. `buildVlmPrompt`（同文件 :546-555）只发 app/actions/where/expect——**VLM 不知道区域原点**；
  4. `parseVlmActions`（:348-431）解析坐标直传，**无偏移概念**；
  5. `rust-helper/src/cgevent.rs:405/:436`：CGPoint 直传 `CGEvent::new_mouse_event`——**CGEvent 坐标是全局显示坐标**。
  → 带 region 的 act 降档 VLM 且 VLM 可解析时，click/drag/scroll 落点系统性偏移 `(region.x, region.y)`，且逐项报 `ok:true`、总 `outcome:"worked"`——**假 worked 换了件衣服回来**（T2-6 消灭的是「不执行就报成功」，这条是「执行在错误位置还报成功」，同属 tri-state 在链尾的违背）。
- **具体改法**：`ScreenshotVlmProvider.act` 在 `parseVlmActions` 之后、dispatch 之前，对动作坐标加 region 原点平移（click/move 的 x,y；drag 的 from_x/from_y/to_x/to_y；scroll 的可选 x,y）；全屏（无 region）零变化。
- **预期收益**：消灭 T2-6 自己引入的坐标错位；`worked` 时落点真实正确。
- **代价**：XS（~15 行 + mock 单测「region(100,200) + vlm click(50,60) → wire 收到 (150,260)」）。
- **风险**：近零；TS 侧平移不依赖 VLM 数学能力。

### C3-2（P1）find 的 `where.ref` 静默忽略根治（round2-review03 遗留 #1，其已建议进 round3）

- **白盒证据链**：
  1. zod 接受 `where.ref`（`tools/desktop.ts:105-110`）；
  2. `ax_find` 只读 `where.text`/`where.role`（`ax.rs:171-176`）；
  3. 纯 ref 查询（无 text/role）→ 两谓词均 None → `collect_matches` 的 `take=true` 分支（`ax.rs:792-796` 同构逻辑）→ **全节点命中 + ok:true**：语义错位（调用方以为按 ref 定位，实得全树 dump）+ token 爆炸；
  4. R03-1 只修了描述文案（`descriptions.ts:231-234` 已诚实写明 "ax find ignores it"）——行为层未动。
- **具体改法（双端夹击，XS）**：① zod 的 `where` 删 `ref` 字段（schema 不承诺未实现的语义）；② Rust `ax_find` 兜底：`where` 存在但 text/role 均空 → `invalid_params`（"find requires text or role; ref is act/expect domain"）——防其它客户端绕过 zod 直发 wire。
- **预期收益**：消灭「静默参数丢弃」家族的最后一个行为层成员（T2-5 修 freshness 透传、R03-1 修文案、本项清行为）；LLM 误用 where.ref 时立即得到明确报错而非全树假成功。
- **代价**：XS（zod 一行 + Rust 一个前置校验 + 各一测）。
- **风险**：低；纯收紧无默认路径变化（不传 ref 的调用 byte-identical）。

### C3-3（P3）VLM 档 `tcc_event_synthesis_denied` → didnt 对齐（round2-review03 N-2 收尾）

- **白盒证据**：同 producer（`cgevent_dispatch`）双消费者映射不一致——`CGEventProvider.ts:329-339` 把该错误映射 **didnt**（附中文引导文案，注释成文「权限缺失不是暂时性故障」）；`ScreenshotVlmProvider.ts:235-254` 对 `resp.ok=false` 一律 **unknown**。
- **具体改法**：ScreenshotVlmProvider 的 dispatch 失败分支特判该 error_kind → didnt + 同款引导。
- **预期收益**：outcome 语义在 audit/metrics 侧一致（链尾无下一档，链行为无差——收益纯一致性）；tri-state 分类学完整（权限=明确否）。
- **代价**：XS（一个特判分支 + 一测）。
- **风险**：近零。

> **宁缺毋滥排除记录**（有证据看完但不立项）：①Peekaboo human-typing/human-mouse-move 拟人节奏——无场景（§2 watch 记档）；②VLM 档多动作间延时/动作间隔参数化——无实测失败证据，违「先拿事实再加参数」；③find actions 数组再瘦身（如映射 AXPress→press）——raw 名已够 LLM 读，加映射层=翻译债；④expect 支持 ref 后置条件——expect.ref 现状是「不可验证即诚实失败」，语义已闭环，加 ref 验证需 stateId 体系（R3 watch 域）；⑤Tachikoma 式 agent runtime——Lasso 是抓手层不是 agent 层，愿景红线。

---

## 4. 结论

- **两轮 11 项实施全部达验收线，10 项无返工意见**；T2-6 结构正确但留 region 坐标偏移缝（C3-1）——本轮唯一新发现的实施缺口，XS 代价可闭合；
- **watch/NO-GO 零翻案**：三大对标 round2 后无一发版（Peekaboo v4.2.0=08-16 / agent-desktop v0.8.1=08-14 / pi v0.5.0 均为 round2 已覆盖版本），R3/PostToPid/R11/D10/--cdp 全部维持原判；新增 watch 一条（Peekaboo 拟人输入，无场景不立项）；
- **生态格局零变化**：无新量级对手（macos26/Agent 574★ 是 agent 层非抓手层，长尾记档）；Peekaboo 向 agent 平台演化=生态位分化而非竞争加剧；
- **候选 3 项：P1×2（C3-1 VLM region 坐标补偿、C3-2 where.ref 静默忽略根治）+ P3×1（C3-3 tcc 映射对齐）**，全部 XS 代价、零新依赖、单点可回滚、不破 INV/tri-state/简单架构——收敛轨迹与 round2 裁决书预言一致（实施尾巴清偿中）：**desktop 域两轮主缺口（act 链可靠性/诚实信号）已清偿完毕，本轮候选全部是残留缝隙级**，若本轮三项落地且手测清单 A-E 签核，desktop 域可宣告 ROUND-CLEAN；
- 附注：门禁基线 1941（1940+1skip）/79 INV/202 rust 全绿维持；全量 suite 存在与 round2 同族的偶发 timing-flaky（复跑即绿），非 desktop 改动引入。
