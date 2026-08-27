# 第 2 轮最优性复审 · 桌面自动化域（desktop 通道 / Rust AXAPI 四档）

- 复审日期：2026-08-17（热度/提交数据当日实取）
- 复审对象：lasso **v1.11.0** desktop 通道（round1 五项 T3/T7/T8/T11/T15 已全部落地 + review03 已修 F2/F4）
- 方法：先白盒读自家新实现 → 逐项读上游最新源码（agent-desktop v0.8.1 / Peekaboo v4.2.0 / pi v0.5.0）→ 差距判定
- 定位：第 2 轮复审——①上轮调整是否达最优 ②上轮 watch/NO-GO 是否有新证据翻案 ③全新热项目。**不重复 round1 已裁决内容**
- 本机门禁实测：`npm run build` ✅ / `npm test` 1904 pass（1 个无关 flaky：proxy-egress 超时，单独重跑绿）/ `check-invariants` **79/79** ✅ / `cargo test`（rust-helper）42+87+64=193 全绿 ✅

---

## 0. 上轮落地项快照（本轮判定的事实前提）

round1 五项 desktop 调优在 v1.11.0 全部落地，实现锚点复核：

| 上轮项 | 落地状态 | 源码锚点 | 复核结论 |
|---|---|---|---|
| T3 ax_act | ✅ click→AXPress（AXActions 前置校验）/ type→AXSetValue 写后读回（secure 豁免）/ scroll→AXScrollToVisible / 三元组 stale 检测 / 每元素 1.0s messaging timeout / 逐项 `{index, ref, ok, error_kind}` | `rust-helper/src/ax.rs:186-347`；review03 F2 后 act 复用 `walk()` 单一真源 + `live` 锁步编号（`ax.rs:371-404,569-574`），真机复测 find/act 编号 12==12 / 24==24 | 结构达最优；残留缝隙见 D2' |
| T7 CGEvent 鼠标 | ✅ click/move/drag/scroll 四路径 + INV-28 逻辑按钮名双端拒 raw code | `rust-helper/src/cgevent.rs:303-437`；`CGEventProvider.ts:56-230` ALLOWED 扩 5 kind | 路径全通；事件质量细节落后（见 D3'） |
| T8 walk 剪枝 v2 | ✅ skeleton 边界 `children_count`（默认关 byte-identical）+ HashSet 防环（review03 F4 O(n²)→O(1)）+ web wrapper 深度中和 | `ax.rs:72-77,127-131,550-558,575-661` | 达最优；截断诚实信号缺（见 D5'） |
| T11 Event Synthesizing | ✅ 第三维三态探测（≥15 版本门 / <15 not_required）+ doctor #21 | `rust-helper/src/tcc.rs:6-145`；`doctor.ts:58` | 达最优（保守三态） |
| T15 expect 接线 | ✅ act worked + expect → find 轮询后置条件，失败翻转 didnt | `DesktopChannel.ts:250-313` | 语义达最优；无 stability 采样（见 D6'） |

**总判断：五项实施质量高于 round1 裁决书的最低验收线（F2 单一真源重构、F4 复杂度修正均超预期）。本轮无一项需要返工。**

---

## 1. 本域最新最热项目清单（round1 后 2 天窗口 + 上轮遗漏补扫）

stars/推送 2026-08-17 经 GitHub API / shields.io 实取。

| # | 项目 | 热度 | 2 天窗口内的新变化 | 与 Lasso 的关系 |
|---|---|---|---|---|
| 1 | **openclaw/Peekaboo** | 4996★，pushed 08-16 | **v3.5.3 → v4.2.0 三连发**（v4.0 08-10 / v4.1 08-14 / v4.2 08-16）：①CLI 瘦身 40→33 命令；②**`verify` 取代 sleep-polling——带 stability 采样，结果 satisfied/unsatisfied/unknown，「unknown never implies success」**；③v4.1/4.2 全押 **background-first**：进程定向投递保前台 app 与物理光标、精确 target/result 签名 receipts、fail-closed（模糊/陈旧/不完整证据一律拒绝执行） | 同生态位热度第一；v4 的 verify 语义与 background-first 方向对 Lasso 的 wait/expect 与 C-2 备忘均有直接对照价值 |
| 2 | **lahfir/agent-desktop** | 1014★，pushed 08-16 | **v0.8.1**（08-14）：①v0.5 auto-wait 默认开（5000ms 上界）；②v0.7.0 **breaking：预算耗尽的 snapshot 从 TIMEOUT 错误改 `complete:false`（ok:true）**——截断必须可见；③v0.8.0 delivery-by-observation；④**v0.8.1 `launch --cdp`：经 DevTools 驱动 Chromium/Electron app**（AX 之外的 Electron 路线） | 架构最接近的 Rust 同类；`complete:false`、type 兜底链、鼠标事件质量三处是本轮白盒重点 |
| 3 | **injaneity/pi-computer-use** | 1740★，pushed 08-16 | **v0.5.0（07-26）加 Linux 原生 helper**——至此 pi 三平台全真（macOS+Windows+Linux），与 oculos 持平 | Lasso 灵感源；三平台基准上移（见 §3 R11 复核） |
| 4 | bytedance/UI-TARS-desktop | 38606★，pushed 08-05 | 无架构变化 | 档4 正确形态的持续背书：截图→VLM 推断→**物理执行**闭环（Lasso 档4 仍是推断即止，见 D4'） |
| 5 | OpenAdaptAI/OpenAdapt | 1683★，pushed 08-15 | 常规迭代 | 录制回放范式，与本轮结论无关 |
| 6 | nut-tree/nut.js | 2848★ | **上游 2024-05 起停更**（fork 包月下载 163k 仍坚挺） | 物理层事实标准依赖一个停更核心——Lasso 自持 CGEvent 路径的价值反升 |
| 7 | CursorTouch/MacOS-MCP | 147★，pushed 今日 | 新 surfaced：Swift AX 树 MCP（Reddit r/ClaudeCode 热帖） | 长尾新品：AX-MCP 生态持续泡沫化，无单项对标价值 |
| 8 | tmc/axmcp（7★）/ entpnomad/mac-use（4★） | 长尾 | Go/Swift 小型 AX 工具 | 同上，记录在案不深读 |
| 9 | （文献）Medium "Eight teams built AXAPI agent tooling in 2026"（2026-07-31） | — | 视觉 token 经济学：4K 截图≈4784 视觉 token 上限，31 步截图循环=148k token/$0.74 | **生态论据正向验证 Lasso 的 AX 优先/截图兜底档序**；"8 家团队 2026 年做 AXAPI agent"= 品类共识 |
| 10 | huseyinstif/oculos | 126★ | 03-07 起停更 | 上轮样本退场，无需跟进 |

> 「axsect」round1 已证伪（检索不命中），本轮不再追。nut.js 停更 + AX-MCP 泡沫化 + Peekaboo/agent-desktop 双雄快速演化 = 本域格局：**纯 AXAPI MCP 是 2026 年品类共识，竞争重心转向 act 链可靠性与 background-first**。

---

## 2. 白盒对标表（仅列本轮有新证据的维度；D1-D10 旧维度结论不变的不再重复）

| 维度 | Lasso v1.11 现状（源码锚点） | 对标（源码锚点） | 判定 |
|---|---|---|---|
| **D2' type 动作链完整性** | `ax.rs:466-506` do_type 单路径：AXValue settable 校验 → AXSetValue → 读回比对；不支持/失败即 `ax_action_unsupported` 出档。降级现实：档2 白名单 9 动作无 type（`apple-script-whitelist.ts:45-58`）→ 档3 `normalizeForCgevent` 无 type 分支返 null（`CGEventProvider.ts:176-229`）→ 档4。**吞 AXSetValue 的 Electron/自绘控件上 type 全链死** | agent-desktop `crates/macos/src/actions/type_text.rs` execute_type 梯子：AXValue 写+验证 → 失败且 policy 允许 → `AXFocused=true` + 50ms → ASCII 逐键合成 / 非 ASCII 剪贴板粘贴（前值保存/恢复 + before/after 验证）；每级独立错误码+recovery hint | **落后（P1）**。Lasso 的档1「不是我的能力就出档」哲学在 type 上有真实死角——下游三档无一能接（档3 键盘无焦点定位、档4 不执行），链尾还是假 worked（D4'） |
| **D3' 鼠标事件物理质量** | `cgevent.rs:344-431`：click = down+up 两事件**零间隔、零 clickState**；drag = 单个 LeftMouseDragged 事件后**立即 up**；scroll = 先 MouseMoved **移动真实光标**再 LINE 滚轮 | agent-desktop `input/mouse.rs`：click 设 `CGEventSetIntegerValueField(field 1, count)`（clickState）+ 10ms down→up 间隔 + 30ms 双击间隔；**drag 插值**：200ms 按住 → steps=max(4, duration/16ms) 逐点 LeftMouseDragged（16ms 步进）→ 500ms 沉淀再 up；scroll 用 `CGEventSetLocation` 定位**不动光标** | **落后（P2）**。单事件拖拽在滑条/文件拖放/列表排序场景高失败率（目标只认移动轨迹）；无 clickState 对挑剔 app 的单击判定不稳；移动光标是对用户的可见副作用 |
| **D4' 档4 screenshotVlm 诚实性** | `ScreenshotVlmProvider.ts:186-208`：VLM 调用成功即 `outcome:"worked"`，`actions_and_results:[]`（空），注释「具体动作执行由 Rust 端 M0.5b 落地」——**M0.5b 计划已被 T3 废除（ax.rs:186 自记），该承诺永久落空**；provider 已持有 `rust: RustBridge`（构造注入，`index.ts:561`）却从未 dispatch | UI-TARS-desktop（39k★）：截图→VLM→pyautogui **真执行**；pi：推断→wire 动作执行+settle 验证；Peekaboo v4.1/4.2：「refusing stale, ambiguous, or incomplete evidence **before dispatch**」——不执行就不许报成功 | **落后（P1）**。round1 D2 的「档4 只推断不执行」在 T3/T7 落地后从「能力缺」恶化为「诚实裂缝」：tiers 1-3 全败的动作（canvas）最终拿到假 worked——这正是 tri-state 铁律在自家链尾的违背，且执行路径（T7 鼠标）现已就绪，闭合只差一步 |
| **D5' snapshot 截断诚实信号** | 默认模式 max_depth 边界节点 `children:[]` 与真叶子**不可区分**（`ax.rs:637-647` else 分支静默空）；grep 全 ax.rs/AxProvider/OutlineMapper 零 truncated/complete 信号。skeleton 模式有 children_count 但默认关 | agent-desktop **v0.7.0 专门为这事发 breaking change**：预算耗尽从 TIMEOUT 错误改为 `ok:true + complete:false`——他们认定「调用方必须能分辨截断树与完整树」值得破坏 envelope | **落后（P3）**。LLM 无法知道该加深/skeleton/钻取；上轮 T8 只给了 opt-in 的 children_count，没给默认可见的截断事实 |
| **D6' wait/expect 稳定性采样** | `DesktopChannel.ts:285-313` verifyExpect 与 wait：100ms 轮询**首命中即真** | Peekaboo v4.0 `verify`：timeout + **stability sampling**（谓词需持续成立，非瞬时命中），结果三分 satisfied/unsatisfied/unknown | **落后（P3，XS 代价）**。瞬时命中（动画帧/加载闪现元素）会产出假 worked；Peekaboo 把「持续成立」写进了 v4 的核心语义 |
| D7'（维持）ref/stale 检测 | 三元组（role+label+rect 中心 ≤50px）+ 编号越界 + cycle 占位拒执行 | agent-desktop generation-proven PID/window receipts（v4.2 Peekaboo 同向更重） | **持平/优（按代价折算）**。Lasso 三元组在单用户场景够用；receipts 体系是 multi-session 安全基建，违 R-INT 不跟 |
| D8'（维持）TCC / 平台诚实 | 三维预检 + 保守三态 + doctor #15-21 | Peekaboo permissions 体系无新增维度 | **持平** |
| D9'（新证据）Electron 内容路线 | web wrapper 深度中和（T8）解决 AX 树可达性 | agent-desktop v0.8.1 新开 `launch --cdp` 路线：绕过 AX 直接 DevTools 驱动 Chromium/Electron | **watch**。两条路线对照记录：Lasso 的 AX 内修复已够用；CDP-for-desktop 是重基建（进程启动参数控制），暂无翻案必要 |

---

## 3. 上轮 watch/NO-GO 复核（本轮任务②）

| 上轮处置 | 复核结论 | 新证据 |
|---|---|---|
| **R4 节点级 actions 暴露（watch：等 T8 落地后评估）** | **触发条件已满足 → 建议升级为最小形态候选（本轮 C2-4）** | T8 已落地；且 F2 重构后 `walk()` 已同步收集 `live: Vec<AXUIElement>`（`ax.rs:603`）——`collect_matches` 对**命中节点**读 AXActionNames 零额外遍历成本；find 命中集合小，token 预算风险天然可控 |
| R3 stateId 句柄缓存（watch） | **维持 watch** | review03 F2 修复证明「re-walk + 同序编号」单一真源的健壮性正是来自不缓存；act 每次 re-walk 的延迟在单用户场景未构成实测痛点。附注：expect/wait 每 100ms 一次全量 re-walk 对 dense app 偏重（agent-desktop v0.7 把 walk 预算超时当头等问题）——C2-5 的稳定性采样顺带把有效验证间隔拉到 ≥200ms，先不单独工程化 |
| C-2 备忘：CGEventPostToPid 进程定向投递（v2 再议） | **维持 watch，方向证据增强但复杂度证据也增强** | Peekaboo v4.1/v4.2 全押 background-first（保前台+保光标）证明这是生态主方向；但同两版发布的签名 receipts/session/generation 体系说明做对它需要的安全基建极重（Lasso 无 multi-session 威胁模型）。触发条件维持「真实多任务干扰痛点出现」 |
| R11 Windows/Linux 深度实装（NO-GO） | **维持 NO-GO，基准漂移记录在案** | pi v0.5.0 补齐 Linux——pi/oculos 三平台全真成为同类基准线；Lasso 愿景明示 macOS 主力 + 契约就绪（uia/atspi 诚实桩），不翻案 |
| D10 npm 预编译二进制分发（记档） | **维持记档** | v1.11 仍要求用户 cargo build；agent-desktop postinstall 拉平台产物模式不变。属发布工程轮次 |
| 上轮 16 项中 desktop 五项 | **全部落地且过 review03** | §0 表；唯一残留：真机手测清单 desktop 段（E1/E2/C1/D1）仍 ⏳ 待验（`round1-manual-test-checklist.md`）——按诚实 pending 先例在案，非缺口 |

---

## 4. 候选调优项（本轮任务③；全部过五门槛：白盒证据差距/愿景内/代价≤中/收益可验证/不破 INV-tri-state-简单架构）

### C2-1（P1）档4 screenshotVlm 闭环：VLM 推断 → cgEvent 真执行（或诚实降级）
- **对标证据**：`ScreenshotVlmProvider.ts:186-208` 推断即 worked + 空结果数组 + 承诺「M0.5b 落地」的注释指向已被 T3 废除的计划；UI-TARS-desktop（39k★）推断→物理执行全链是档4 的正确形态；Peekaboo v4.1「refusing … evidence before dispatch」。provider 已持 `rust: RustBridge`（`index.ts:561` 注入）——执行桥就在手里，从未 dispatch。
- **具体改法**：VLM 返回对象尝试解析为坐标动作（`{kind:"click"/"move"/"drag"/"scroll", x, y, …}` 容错提取）→ 命中则 `this.rust.call("cgevent_dispatch", …)` 真执行，`actions_and_results` 填真逐项结果（T7 路径复用）；**解析失败或执行失败 → `outcome:"unknown"` + `error:"vlm_inference_only:…"`**，推断原文仍附 data 供 LLM 自行决策（截图 token 已花，推断不浪费）。zod 不加新承诺（VLM shape 仍不锁）。
- **预期收益**：消灭链尾假 worked——tiers 1-3 全败的 canvas/Metal 场景从「谎报成功」变为「真执行或诚实 unknown」；tri-state 铁律补上最后一块。
- **实施代价**：M（VLM 输出容错解析 + mock 单测 + FallbackDecider 语义确认）。
- **风险评估**：低。解析失败路径本身就是交付物（诚实降级）；不动 tier 1-3。

### C2-2（P1）ax 档 type 兜底：AXFocus + 合成键盘（吞 AXSetValue 的 Electron/自绘控件）
- **对标证据**：`ax.rs:466-506` 单路径 AXSetValue；档2 白名单无 type（`apple-script-whitelist.ts:45-58`）、档3 `normalizeForCgevent` 无 type 分支（`CGEventProvider.ts:176-229`）→ 降级链对 type 是死胡同。agent-desktop `type_text.rs` execute_type 梯子：AXValue → focus(50ms) → 逐键合成（ASCII）/剪贴板粘贴（非 ASCII）+ 每级验证。
- **具体改法**：do_type 在 `ax_action_unsupported`（not settable）/`ax_set_failed` 后**档内兜底**：读 `AXFocused` settable → 置 true → 50ms sleep → 复用 `crate::cgevent` 既有键盘合成逐字符（仅 ASCII；非 ASCII 保持失败诚实，剪贴板路线不做——涉剪贴板污染用户数据面）。写后读回验证保留。顺手在 zod/tool 文案写明 **type = 整值替换语义**（agent-desktop type=追加/set-value=替换两分；Lasso 现状是替换，schema 无说明——LLM 语义歧义点）。
- **预期收益**：Electron 吞 AXSetValue 场景 type 从「全链死→档4 假 worked」变「档1 内真输入」；档1 自洽性提升，跨档次数下降。
- **实施代价**：S-M（~60 行 + rust 单测；cgevent 键盘合成已存在）。
- **风险评估**：低-中。焦点置位是可见副作用（单用户场景可接受，agent-desktop 用 InteractionPolicy 门控该步——Lasso 文档明示即可，不引入策略框架）。

### C2-3（P2）cgevent 鼠标事件质量：drag 插值 + clickState + down→up 间隔
- **对标证据**：`cgevent.rs:344-431` 全无 sleep/clickState（grep 实证）；agent-desktop `mouse.rs`：drag 200ms 按住 + steps=max(4,duration/16ms) 插值 + 500ms 沉淀；click 设 clickState（CGEventSetIntegerValueField field 1）+ 10ms down→up。Peekaboo drag 同为插值形态。
- **具体改法**：drag 路径加固定节奏（~300ms 总时长：200ms 按住 + ≥4 个插值 dragged 点 @16ms + 100ms 沉淀后 up——数值照抄 agent-desktop 实测参数，不做参数化）；click 的 down/up 事件设 clickState=1 + 10ms 间隔。不加 double_click action（zod 未声明，宁缺毋滥，仅加固现有 click）。
- **预期收益**：滑条/拖拽排序/文件拖放从「大概率失败」变可用；挑剔 app 单击判定稳定。
- **实施代价**：S（~40 行）。
- **风险评估**：低；真机手测依赖（手测清单 C1 扩展：拖拽一条 Slack 消息/拖动滑条）。

### C2-4（P3）find 命中节点附 `actions` 数组（R4 最小形态，触发条件已满足）
- **对标证据**：R4 watch 条件「T8 落地后评估」已满足；`ax.rs:603` walk 已收集 live 元素序列，`collect_matches`（`ax.rs:524-548`）对命中节点读 `action_names_of()`（`ax.rs:445-449` 已有该函数）零额外遍历；oculos 每元素 actions / pi canPress·canFocus·canSetValue / agent-desktop platform_available_actions 三家同范式。
- **具体改法**：find 的 matches 每项加 `actions: ["AXPress","AXShowMenu",…]`（空省略——serde skip 同 children_count 模式）；**不进 snapshot 全树**（token 预算守护：全树每节点一次 AXActionNames FFI 既贵又胀）。
- **预期收益**：LLM observe→act 路由有据（哪些元素可按/可设值直接可见，配合 C2-2 的 settable 兜底）；act 前置校验信息前置到观察侧。
- **实施代价**：S。
- **风险评估**：低（opt 字段 + 空省略，默认路径 byte-identical）。

### C2-5（P3）wait/expect 稳定性采样：连续 2 次命中才算
- **对标证据**：`DesktopChannel.ts:285-313` 首命中即真；Peekaboo v4.0 `verify`「timeout and stability sampling … unknown never implies success」把持续成立写进核心语义。
- **具体改法**：verifyExpect 与 wait 的命中判定加 consecutive 计数（相邻两次 poll 均命中才成立；`gone` 语义反向同理）。~10 行。
- **预期收益**：瞬时命中（动画/加载闪现）不再产出假 worked；顺带把有效验证间隔拉到 ≥200ms，缓解 dense app 上 100ms 全量 re-walk 的 AX 压力（R3 附注的免费部分）。
- **实施代价**：XS。
- **风险评估**：近零（多等一个 poll 周期）。

### C2-6（P3）snapshot 截断诚实信号 `truncated`
- **对标证据**：默认模式边界节点 `children:[]` 与真叶子不可区分（`ax.rs:637-647`）；agent-desktop **v0.7.0 为此专门发 breaking change**（TIMEOUT 错误 → `ok:true + complete:false`）——同类认定「截断必须可见」。
- **具体改法**：walk 遇 max_depth 边界且该节点有子节点时置 flag → snapshot 响应顶层 `truncated:true`（**仅截断时出现**——skip 形态，浅树 byte-identical；dense fixture 需基线更新并核对 INV-70 类 byte-identity 测试的适用范围）。
- **预期收益**：LLM 知道何时该 skeleton/加深/换 root；观察诚实性与 agent-desktop v0.7 对齐。
- **实施代价**：S。
- **风险评估**：低-中（wire 新字段 + 测试基线更新；默认无截断路径零变化）。

> **宁缺毋滥排除记录**（有证据看完但不立项）：① agent-desktop 的 7 级 scroll 瀑布（scrollbar AXIncrement/AXValue 平移/AXSelectedRows/焦点+方向键）——Lasso 档3 坐标滚动（LLM 可带 x,y 重试）已可兜，且该瀑布违 R-INT 简单架构；② auto-wait 默认开（agent-desktop v0.5）——Lasso expect 是 opt-in，隐藏 5s 延迟是负收益；③ delivery-by-observation / 签名 receipts / background-first 投递——multi-session 安全基建，无威胁模型不跟（§3）；④ `launch --cdp` Electron DevTools 路线——重基建，watch 记录（D9'）；⑤ clipboard 粘贴 type 兜底（非 ASCII）——污染用户剪贴板面，不做。

---

## 5. 结论

- **上轮调整全部达最优**：T3/T7/T8/T11/T15 五项落地质量高于验收线（review03 的 F2 单一真源重构是关键加固），本轮对任何一项均无返工意见；
- **上轮 watch/NO-GO 无翻案、一处升级**：R4 触发条件（T8 落地）已满足 → 升级为最小形态候选 C2-4；其余维持（R3/R11/PostToPid/D10 均记录新证据但不改判）；
- **新证据揭示三个实施层残留缺口**，全部集中在「链的末端与事件物理层」：档4 假 worked（D4'，最重——tri-state 在自家链尾的违背）、type 降级死胡同（D2'）、鼠标事件物理质量（D3'）；外加三个诚实性小项（D5'/D6'）；
- **候选 6 项**：P1×2（C2-1 档4 闭环、C2-2 type 兜底）/ P2×1（C2-3 鼠标事件质量）/ P3×3（C2-4 find actions、C2-5 稳定性采样、C2-6 截断信号）。全部零新依赖、档内或单文件可回滚、不破 INV/tri-state/简单架构；C2-1+C2-2 合计消灭「四档架构声明与链尾现实」的最后落差。
- 生态面：AXAPI-MCP 品类共识固化（2026 年 ≥8 团队入局 + 长尾泡沫化），竞争重心已转向 **act 链可靠性、诚实信号（verify/complete）、background-first**——与本轮候选清单的方向完全同频。
