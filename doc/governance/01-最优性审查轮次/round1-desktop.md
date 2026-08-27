# 第 1 轮最优性审查 · 桌面自动化域（desktop 通道 / Rust AXAPI 四档）

- 审查日期：2026-08-15（热度数据均为当日实取）
- 审查对象：lasso v1.10.0 desktop 通道（`src/channels/DesktopChannel.ts` + `src/desktop/*` + `rust-helper/src/*`）
- 方法：白盒读 Lasso 对应模块源码 → 逐项读对标项目源码（zread/官方仓库）→ 差距判定
- 数据源：GitHub stars 经 img.shields.io 实取；npm 月下载经 shields 实取；源码经 zread.com 白盒阅读

---

## 0. Lasso desktop 现状白盒基线（判定的事实前提）

先读自己，再对标。v1.10.0 desktop 通道真实能力（源码锚点）：

| 能力 | 实现现状 | 源码锚点 |
|---|---|---|
| observe(snapshot/find) | ✅ 真实可用：AX walk（role/title/enabled/focused/rect/children）+ 三平台统一 role 表 | `rust-helper/src/ax.rs:207` walk、`ax.rs:309` resolve_root、`ax_role_map.rs` |
| 剪枝 | max_depth 默认 8 / 上限 20；`interactive_only` opt-in 平面过滤（保祖先）；pictureOnly 三启发式 | `src/desktop/OutlineMapper.ts:40,123,170`；`tools/desktop.ts:44` |
| act 4 档 | 架构在、实现空壳见下 | `src/channels/DesktopChannel.ts:222-248` |
| ├ 档1 desktop.ax | ❌ **`ax_act` 返回 `not_implemented`（占位至今）** | `rust-helper/src/ax.rs:171-178` |
| ├ 档2 desktop.appleScript | ⚠️ 仅 9 个白名单动作（finder/mail/safari/notes/system 读写），3 层注入防御真实可用 | `src/desktop/apple-script-whitelist.ts:47-59`；`rust-helper/src/applescript.rs` |
| ├ 档3 desktop.cgEvent | ⚠️ **仅键盘**（press/hotkey；无鼠标 click/drag/scroll/move） | `src/desktop/CGEventProvider.ts:55`；`rust-helper/src/cgevent.rs`（只有 key/hotkey/dispatch 键盘合成） |
| └ 档4 desktop.screenshotVlm | ⚠️ 只截图+把动作描述发 VLM **推断**，返回的 `worked` 不代表执行了任何动作 | `src/desktop/ScreenshotVlmProvider.ts:150-219` |
| wait | ✅ poll find 100ms + tri-state（worked/preexisting/didnt） | `DesktopChannel.ts:263-331` |
| TCC | ✅ 不弹窗预检双维（Accessibility + Screen Recording）+ 诚实 error_kind + doctor #15-#20 | `rust-helper/src/tcc.rs:29,35`；`desktop-doctor-checks.ts` |
| 跨平台 | AxBackend 三平台契约 + 统一 role 表（INV-60/61）；**Win UIA / Linux AT-SPI 深读均 `not_implemented` 桩**（编译可达、诚实报 not_windows/not_linux） | `src/desktop/AxBackend.ts`；`rust-helper/src/uia.rs:122-144`、`atspi.rs:105-123` |
| ref 体系 | @eN 为**每次调用临时编号**（find 每次 re-walk 从 @e0 重新编号）；stateId 生成了但无消费者 | `ax.rs:133-168`（find 注释自认"state_id 仅协议占位"）；`src/desktop/AxProvider.ts:74-77` |
| 分发 | rust-helper 需用户本机 `cargo build`（env `LASSO_RUST_HELPER_PATH` 或默认 `./rust-helper/target/release/...`），npm 包不含预编译二进制 | `src/index.ts:164-166,540` |

**核心事实**：zod schema 声明了 click/type/scroll（`tools/desktop.ts:46-65`），但四档链上没有任何一档能真正执行 click/type/scroll——档1 占位、档2 只认 9 个 app 动作、档3 只认键盘、档4 只推断不执行。desktop 通道当前是「强观察、弱行动」：**能看不能点**。这是本轮全部对标项目（无一例外）都已解决的问题。

---

## 1. 本域最新最热项目清单

按「与 Lasso desktop 能力的相关度 × 热度」排序。stars/npm 数据 2026-08-15 实取。

| # | 项目 | 热度 | 一句话机制 | 与 Lasso 的关系 |
|---|---|---|---|---|
| 1 | **openclaw/Peekaboo**（原 steipete） | 5.0k★ MIT，Swift 6.2，macOS 15+，v3.5.3 活跃 | macOS AX（自研 AXorcist 引擎）+ 截图 + CLI/MCP 双形态；`perform-action`/`set-value` 直调命名 AX 动作；**后台按进程定向投递输入（不抢焦点）**，`--foreground` 显式升级；warm daemon + 菜单栏/对话框/Dock/Spaces 全覆盖 | 同生态位（macOS AX + MCP）当前热度第一的参照系；Lasso 源码注释已引它的 OSAKit/CGEvent 思路 |
| 2 | **lahfir/agent-desktop** | 1.0k★ Apache-2.0，Rust 单二进制，npm `agent-desktop` 月下载 1.9k | 纯 AX 树驱动 CLI（无截图无浏览器）：54 命令 + C-ABI FFI cdylib；**skeleton 骨架遍历 + `--root` drill-down 宣称省 78-96% token**；snapshot_id + STALE_REF 错误码；动作链（Action/SetBool/ChildActions/CGClick）+ 写后读回验证 + InteractionPolicy 门禁物理输入 | **架构最接近 Lasso 的活跃 Rust 同类**（单人维护规模也相当）；其 act 链与剪枝是 Lasso 最直接的对标物 |
| 3 | **injaneity/pi-computer-use**（badlogic pi 生态演化） | 1.7k★（母仓 badlogic/pi-mono 91k★），npm 月下载 102 | Pi 扩展：多根 forest（desktop 窗口 + CDP 页同构 @rN/@eN ref）；**stateId 作用域不可变观察态 + epoch 拒绝陈旧写 + 资源泳道（按 pid 串行）**；act 事务含 pre-baseline/root-delta settle/后置条件把"事件送达"与"语义成功"分离；后继 diff | Lasso desktop 设计文档明示的灵感来源（tri-state）；其后续演化方向 = Lasso 未走的路 |
| 4 | **huseyinstif/oculos** | 126★ MIT，Rust 单二进制 | "If it's on the screen, it's an API"：读 OS a11y 树 → REST(Axum) + MCP(stdio)；**三平台全真实装**（Win UIA windows-rs Full / Linux AT-SPI atspi+zbus / macOS AXUIElement）；会话级 UUID 元素注册表；每元素 `actions` 数组；12 个 interact 端点 + batch + wait + dashboard 录制器 | 体量小但**是「纯 AXAPI 三平台 MCP」这个 Lasso 目标定位的最完整已实现样本** |
| 5 | **bytedance/UI-TARS-desktop** | 39k★（本域热度绝对第一） | 视觉原生 GUI agent：截图 → UI-TARS VLM → 动作空间（click/type/scroll/drag/hotkey/wait）经 **pyautogui / nut.js** 物理执行；无 AX | 与 Lasso 档4（screenshotVlm）同范式但闭环完整（推断→真执行）；证明视觉档的正确形态 |
| 6 | **nut-tree/nut.js** | 2.8k★；npm `@nut-tree-fork/nut-js` 月下载 **163k** | Node 原生桌面自动化（libnut C++ 核心）：mouse/keyboard/window/clipboard/模板匹配；三平台；**纯坐标物理层，不读 a11y 树** | Lasso 档3 想做的事（物理输入兜底）的事实标准库；也证明"纯键盘"只是它能力的 1/5 |
| 7 | **OpenAdaptAI/OpenAdapt** | 1.7k★（另拆 openadapt-capture / openadapt-desktop） | 录制→编译→确定性回放（回放零模型调用）：capture 记录鼠标/键盘/窗口/AX 树（macOS 经 MacPaw/macapptree）；策略认证 + drift/repair | 范式互补（录制回放 vs 即时驱动）；capture 的 AX 解析链路可参考 |
| 8 | **Wuzheng02/OS-Kairos** | 22★ ACL 2025 Findings | MLLM GUI agent 研究：自适应交互——agent 自报置信度，低置信时主动求助人类，避免错误操作 | 研究代码非基建；"置信度→降级/求助"思想与 tri-state/verify-after-act 同宗，仅作思想参照 |
| 9 | leexgone/uiautomation-rs | 197★ | windows-rs 之上的 UIA safe wrapper（TreeWalker/事件/属性） | Lasso `uia.rs` 将来真装时可评估直接采用，省 raw COM 手写 |
| 10 | MacPaw/macapptree（65★）/ steipete/macos-automator-mcp（869★）/ AccessKit（1.5k★） | — | Swift AX 树解析器 / Peekaboo 前身 AX-MCP / Rust UI 工具包的 a11y **提供方**基础设施 | 周边参照；AccessKit 是树的生产者侧与 Lasso（消费者侧）方向相反，列作全景 |

> 「axsect」在 GitHub/npm/Web 全量检索未命中（疑似记忆偏差）；其意图位（纯 AXAPI 树工具）由 #2 agent-desktop 与 #4 oculos 占据，本轮以这两个做白盒深读。

---

## 2. 白盒对标表

判定口径：**Lasso优 / 持平 / 落后**（对单人+AI 维护、简单架构铁律敏感——不为追平而堆复杂度）。

| 维度 | Lasso 现状（源码锚点） | 对标（源码锚点） | 判定 |
|---|---|---|---|
| **D1 AX 树剪枝范式** | max_depth(8/20) 截断 + `interactive_only` opt-in 平面过滤 + pictureOnly 启发式（`OutlineMapper.ts:40,123,170`；`ax.rs:224-234`）。无骨架/钻取/截断计数 | agent-desktop `crates/macos/src/tree/builder.rs`：skeleton 边界节点以 `children_count` 占位 + `--root` drill-down 合并 refmap；**web wrapper（AXGroup/AXGenericElement 无标题）深度中和**防 Electron 深度耗尽；`ancestors` FxHashSet 防环；secure 值脱敏；label 从 static-text 子代提升。pi-computer-use：首观察折叠 + `expand_ui`/`search_ui` 查缓存的完整树 | **落后**。Lasso interactive_only 是"全有或全无"：过滤后丢失文本上下文，不过滤则 dense app（Slack/Electron）token 爆炸；无截断计数即无 drill-down 语义 |
| **D2 act 实现档位** | 档1 `ax_act`=not_implemented（`ax.rs:171-178`）；档3 仅键盘（`cgevent.rs` 无 mouse 函数）；档4 只推断不执行 → **click/type/scroll 全链不可达** | agent-desktop `actions/dispatch.rs`+`chain.rs`：能力发现→动作链（`Action(AXPress)`/`SetBool(AXSelected…)`/`SetDynamic(AXValue)`/`FocusThenSetDynamic`/`ChildActions`/`AncestorActions`——处理 AXPress 挂在包装层子/祖先的 app）/`CGClick`(bounds 中心 CGEvent 合成) 兜底；链前 `AXScrollToVisible`；每元素 `AXSetMessagingTimeout 1.0s` 防挂。Peekaboo：`perform-action --action AXPress`/`set-value` 一等公民 + 后台进程定向投递 + `--foreground` 升级。pi `actions.ts`：ref→wireRef 语义动作 或 坐标兜底（按 canPress/canFocus/canSetValue/pictureOnly 路由）。oculos：12 interact 端点全实装 | **大幅落后（P0）**。这是本轮唯一"量级差"：四档架构（INV-18/29）本身是先进的，但档1/3 的实现使链实际只剩 9 个 appleScript 动作 + 键盘 |
| **D3 写后验证（verify-after-act）** | 无。zod 声明的 `expect` 字段 **DesktopChannel.act 从不消费**（死字段）；wait 是独立轮询 | agent-desktop `chain.rs`：`set_dynamic_verified`/`bool_write_had_effect` 写后读回比对（AXValue 不匹配=失败，secure 字段豁免）；`post_state.rs` 每动作后回读状态附于结果。pi `actions.ts`：`outcomeAfterCheck`(verified/preexisting/failed)+`outcomeAfterObservedValues`(setText 逐 ref 比对)；"event delivery ≠ semantic success" | **落后**。Lasso 的 tri-state 哲学与 pi 同源，但没延伸进 act 路径 |
| **D4 ref 稳定性 / 陈旧检测** | @eN 每次调用临时重编号；stateId 生成即弃（`AxProvider.ts:74-77` 自注释"v0.4+ 可加 LRU"） | agent-desktop：refs 绑定 snapshot_id + `STALE_REF` 错误码 + recovery hint（"snapshot → act → STALE_REF? → snapshot 重试"）；pi：refs 属于 stateId 不可变态，过期即 fail-clear；oculos：会话级 UUID 注册表；Peekaboo：snapshot_id 串 see/click/set-value | **落后**。Lasso 的 ref 目前是装饰性的（反正 act 也不认 ref）；补齐 D2 后此项立即变成安全问题（点错元素） |
| **D5 跨平台抽象** | AxBackend 接口 + Factory（INV-60）+ 三平台合并 role 表（INV-61）+ cfg-gate 桩诚实报 not_windows/not_linux；Win/Linux 深读 not_implemented | oculos：三平台**全真**（Win UIA Full / Linux AT-SPI / macOS AX）。agent-desktop：`PlatformAdapter` 28 方法 trait 依赖反转，Windows 适配器（uiautomation crate + windows-capture）进行中。pi：macOS+Windows 双平台原生 helper + `architectureVersion` 不变量集启动 fail-closed | **持平（契约）/ 落后（实现深度）**。Lasso 的契约先行 + INV 守护不输任何人（甚至更克制），但深度上已被 oculos 这一同体量项目反超。按项目红线（macOS 主力）这是可接受的落后，非本轮必改 |
| **D6 TCC 权限处理** | 双维不弹窗预检（`AXIsProcessTrustedWithOptions(NULL)` + `CGPreflightScreenCaptureAccess`）→ 诚实 `tcc_denied` → doctor #15-20 引导（`tcc.rs`） | Peekaboo：`permissions status/grant/request-screen-recording/**request-event-synthesizing**`——macOS 15+ 合成 HID 事件需 "Event Synthesizing" 新 TCC 维度；agent-desktop：`permissions --request` 主动触发 + 结构化 `{state, suggestion}` 对象 | **优（诚实哲学）/ 落后（两个点）**：① 无主动 request 路径（设计取舍，可保留）；② **不感知 macOS 15+ Event Synthesizing 维度**——档3 的 CGEvent 在 Sequoia+ 可能被静默拦截而 Lasso 报不出原因 |
| **D7 tri-state 诚实降级** | worked/didnt/unknown 全链 + wait 四态（preexisting）；observe 不 fallback（只读失败=通道不可用） | pi：同 tri-state + verified/preexisting/failed 后置条件语义（Lasso 思想的后代）；agent-desktop：错误码+recovery hint 全 JSON | **持平/略优**。Lasso 的 observe-不降级决策与 error_kind→Outcome 映射是本轮项目里最干净的诚实实现 |
| **D8 注入防御 / 安全** | appleScript 3 层白名单（TS 层 1 + Rust 层 2 + 编译期字面量层 3）+ INV-28 禁 raw keycode + 禁 `script` 字段 | agent-desktop/Peekaboo：`perform-action` 接受任意 AX 动作名字符串；oculos：绑定 localhost:7878 HTTP 端口（攻击面大） | **Lasso 优**。这是应当保持的差异化优势（代价是档2 表达力受限——取舍正确） |
| **D9 并发/资源模型** | 单 helper 进程、JSON-lines 串行 | pi：按 pid 资源泳道并行 + epoch 拒绝陈旧写 + 8 条不可变 look 记录 | **持平（不追是正确决策）**。单人 CC 场景串行足够；pi 的复杂度是为多 agent 并发付费 |
| **D10 分发/交付** | npm 包不含 Rust 产物；用户需 cargo build（`index.ts:164-166`） | agent-desktop：npm postinstall 拉平台预编译二进制 + FFI cdylib 全平台产物 + checksums/Sigstore；Peekaboo：Homebrew + npx MCP | **落后**（按愿景"npm 分发 / MIT"衡量是摩擦点；但属工程交付非域内能力，列 C-8 备注） |

---

## 3. 候选调优项

排序按 收益/代价。每条均给出对标源码证据。宁缺毋滥原则下每条都过筛：「不服务 CC 单人+AI 场景的复杂度」一概未列（故未列：pi 的 epoch/泳道、oculos 的 dashboard、Peekaboo 的多 provider LLM、Windows/Linux 真装）。

### C-1（P0）落地 `ax_act`：档1 从占位变真实现
- **对标证据**：`rust-helper/src/ax.rs:171-178` not_implemented；agent-desktop `chain.rs` 全链（AXPress/SetBool/SetDynamic + ChildActions/AncestorActions + 1.0s messaging timeout + pre AXScrollToVisible）；Peekaboo `perform-action`/`set-value`；oculos 12 端点。全部同类项目 AX 动作优先。
- **具体改法**：`ax.rs` act(actions)——按 `@eN` ref 解析：**重新 walk + 确定性重编号**（与 find 同序，零新状态，符合 R-INT 简单架构；无需 cache 即可先通）。click→`AXPress`；type→`AXSetValue(AXValue)`（写后读回比对，secure 字段豁免）；scroll→`AXScrollToVisible` + 方向映射；press/hotkey 留档3。每元素先 `AXSetMessagingTimeout(1.0s)`。返回逐项 `{ref, ok, error_kind}`（cgevent_dispatch 已有同形先例）。
- **预期收益**：desktop 通道从「能看不能点」变为 observe→act 闭环；四档链恢复设计语义（Electron 吞 AXSetValue 才降 appleScript/cgEvent）。
- **实施代价**：M（ax.rs ~200 行 + rust 单测 + AxProvider 映射已就绪）。
- **风险**：陈旧 ref 点错元素（无 cache 版靠同序重编号缓解 + label/role/rect 三元组比对，不符即 `stale_ref`→didnt）；需真机手测清单（CI 无 GUI，沿用 uia/atspi 的诚实 pending 模式）。

### C-2（P0）CGEvent 档补鼠标：click/drag/scroll/move
- **对标证据**：`cgevent.rs` 仅 key/hotkey/dispatch（键盘）；agent-desktop `dispatch.rs:click_via_bounds`（bounds 中心 + `synthesize_mouse`）与 chain 内 `CGClick` 兜底；nut.js 163k 月下载证明物理层刚需；Peekaboo swipe/drag/move 全有。
- **具体改法**：cgevent.rs 增 `CGEventCreateMouseEvent` 路径（leftclick@x,y / drag from→to / scroll wheel / move），并入 `cgevent_dispatch` 动作枚举；CGEventProvider 的 `ALLOWED_CGEVENT_KINDS` 扩 click/scroll（继续 INV-28 风格：逻辑按钮名，禁 raw button code）。坐标来源：C-1 的 ref→rect 中心换算（TS 端 snapshot 已有 rect）。
- **预期收益**：档3 成为真兜底（canvas/Metal/吞 AX 动作的 Electron app 的坐标点击）；配合档4 截图定位形成完整降级链。
- **实施代价**：M。
- **风险**：全局投递抢用户光标（文档明示；Peekaboo 的进程定向投递 `CGEventPostToPid` 可作 v2 增强，先不做）；macOS 15+ Event Synthesizing TCC（见 C-6）。

### C-3（P1）snapshot 缓存 + stateId 绑定 ref + `stale_ref` 诚实语义
- **对标证据**：Lasso stateId 已生成未消费（`AxProvider.ts:74-77`）；agent-desktop STALE_REF + suggestion；pi refs 作用域 stateId、过期 fail-clear、有界存储（8 条）；oculos 会话 UUID 注册表。
- **具体改法**：Rust helper 端持最近 N(=4) 棵 walk 树（AXUIElement 强引用数组 + stateId），`ax_act` 优先按 (stateId, @eN) 直取元素（免 re-walk）；取不到/role+label+rect 不符 → `error_kind="stale_ref"` → TS 映射 didnt + recovery 文案"re-snapshot 后重试"。LRU 有界，遵循 R-INT-07（多消费者共享 mutable state 的教训：缓存只在 helper 单进程内，不跨层）。
- **预期收益**：ref 从装饰变真引用；act 免整树 re-walk（延迟↓）；陈旧检测防"点错元素"安全事故。
- **实施代价**：M。
- **风险**：AXUIElement 句柄失效崩溃面（agent-desktop 的 1s timeout + 错误映射是成熟解法，照抄）；缓存内存有界（N=4 × 树）。

### C-4（P1）skeleton 骨架剪枝 + `--root` 钻取 + children_count
- **对标证据**：agent-desktop `builder.rs` skeleton 边界 `children_count` 占位 + `--root @eN --snapshot id` 钻取合并 refmap，README 实测 Slack/VSCode 省 78-96% token；pi 折叠首图 + expand_ui。Lasso `interactive_only` 无计数、无钻取、过滤后丢文本上下文。
- **具体改法**：`ax.rs` walk 增 `skeleton` 参数（边界节点序列化 `children_count`，`skip_serializing_if=Option::is_none` 保 wire 兼容——与 window_id 同模式）；TS OutlineNode 增可选 `childrenCount`；desktop tool options 增 `skeleton` + `root_ref`+`state_id`（依赖 C-3）。默认关（沿 INV-70 byte-identical 先例）。
- **预期收益**：dense app（Slack/Electron/IDE）token 成本数量级下降；对齐本域当前最强卖点。
- **实施代价**：M。
- **风险**：wire shape 变更（opt-in + serde skip 兜底）；钻取语义需配套 INV 守护（默认路径 byte-identical）。

### C-5（P2）节点级 `actions`（AXActions affordance）暴露
- **对标证据**：oculos 每元素 `actions:["click","focus"]`（"API tells you exactly what you can do"）；agent-desktop `platform_available_actions` 进树 + 能力驱动动作链；pi 节点 `canPress/canFocus/canSetValue` 驱动 ref vs 坐标路由。
- **具体改法**：walk 时读 `AXActions` 字符串数组 → `AxNode.actions`（空则省略）；find/skeleton 模式透出。配合 C-1：act 前校验"该 ref 支持 AXPress"，不支持直接 didnt（省一次注定失败的 FFI）。
- **预期收益**：LLM 可见可操作性、act 路由有据、失败前置拦截。
- **实施代价**：S-M。
- **风险**：token 膨胀——仅非空输出，可先只在 find 与钻取响应中开。

### C-6（P2）TCC 第三维：Event Synthesizing 预检（macOS 15+）
- **对标证据**：Peekaboo `permissions request-event-synthesizing` + 文档明示"keyboard input, coordinate clicks, and synthetic click fallback require Event Synthesizing for the sending process"；Lasso `tcc.rs` 只知 accessibility/screen_recording 两维。
- **具体改法**：`tcc.rs` 增第三维探测（cfg-gate macOS 15+ API；<15 返 `not_required`）；doctor #15-20 扩一项；新 `error_kind="tcc_event_synthesis_denied"` → TS 映射 didnt + 引导文案。
- **预期收益**：C-2 的 CGEvent 鼠标在 Sequoia+ 不至于静默失败报不出原因；tri-state 诚实性在最新 macOS 保持成立。
- **实施代价**：S。
- **风险**：本机 Darwin 21.6（macOS 12）无法验证——按 uia/atspi 先例标手测 pending，不伪造已验证。

### C-7（P3）walk 防环 + web wrapper 深度中和
- **对标证据**：agent-desktop `builder.rs`：`ancestors: FxHashSet<usize>` 指针防环；`is_web_wrapper`（AXGroup/AXGenericElement 无 title/value）子代深度不 +1——否则 Electron/WebView 内容在 max_depth=8 内到不了控件层。Lasso `ax.rs walk` 仅靠 max_depth，无环保护、无 wrapper 中和。
- **具体改法**：walk 增 visited 指针集合；wrapper 判定不增 depth（Rust 端完成，TS 零感知，不违 INV-21）。
- **预期收益**：Electron/WebKit 内容可达性提升；极端环树不耗尽预算。
- **实施代价**：S。
- **风险**：低；深度语义微变（仅对 wrapper 链，默认输出结构不变——wrapper 仍出现在树里）。

### C-8（P3）接线或删除 act 的 `expect` 死字段
- **对标证据**：`tools/desktop.ts:66-74` zod 声明 expect；`DesktopChannel.act` 全文无一处消费（grep 证实）。pi `act_ui` 的 expect 后置条件会把失败翻转为 didnt（"event delivery ≠ semantic success"）——正是该字段声明的语义。
- **具体改法**（二选一）：① 依赖 C-1：act 成功后若传 expect → 复用 wait 轮询逻辑做后置条件，failed 则 outcome=didnt；② 删字段保诚实（zod 契约不承诺未实现的东西）。
- **预期收益**：消除"schema 承诺了但没兑现"的契约裂缝（与 tri-state 铁律同构的小违背）。
- **实施代价**：① S-M / ② XS。
- **风险**：低。① 轮询复用现有 wait，无新状态。

> 备注（非本域调优项，记档）：D10 分发差距——agent-desktop 的 npm postinstall 预编译二进制模式值得在 lasso 的发布工程轮次评估（rust-helper 目前要求用户 cargo build），与 desktop 能力无直接关系，不占本轮候选。

---

## 4. 结论

- Lasso desktop 的**架构骨架（四档 fallback / tri-state / INV 守护 / 注入防御 / 平台字面量隔离）在本域仍属第一梯队**，D7/D8 领先、D5 契约持平；
- 但**实现深度已被同体量对手反超**：ax_act 占位 + CGEvent 无鼠标使「act」名不副实（D2 大幅落后），ref/stateId/expect 三个已声明的契约均无实现（D3/D4）；
- 候选调优 8 项：**P0×2（C-1 ax_act、C-2 鼠标 CGEvent）、P1×2（C-3 stateId/stale_ref、C-4 skeleton 钻取）、P2×2（C-5 actions 暴露、C-6 Event Synthesizing）、P3×2（C-7 防环/wrapper、C-8 expect 接线）**；其中 C-1+C-2 是恢复通道本义的必改项，其余按 manpower 排期。
