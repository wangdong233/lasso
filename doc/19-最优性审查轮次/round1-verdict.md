# 第 1 轮最优性审查 —— 裁决书

> 裁决官：round1-verdict。日期：2026-08-17。
> 输入：round1-browser.md / round1-search.md / round1-desktop.md / round1-arch.md 四份调研全文。
> Lasso 基线：v1.10.0（1801 TS tests + 78 INV 全绿，npm latest）。

---

## 0. 抽验记录（裁决依据，非采信转述）

裁决官对四份报告的关键声称做了独立白盒/上游核实，**抽验 ~25 个锚点，全部属实，零发现虚报**：

| 抽验项 | 方法 | 结果 |
|---|---|---|
| `src/subprocess/SubprocessManager.ts:38` 锁 0.3.0 | 读源码 | ✅ `LOCKED_CDP_MCP_VERSION = "0.3.0"` |
| chrome-devtools-mcp latest=1.7.0（2026-08-10）/ 0.3.0=2025-09-25 / 60 版 | npm registry API | ✅ 11 个月 / 57 版差距坐实 |
| 1.7.0 有 `--chromeArg`/`--proxyServer`/`--wsEndpoint`/`--wsHeaders`/`--viewport`/`--allowedUrlPattern` | 下载 1.7.0 tarball 读 build+README | ✅ 全部存在 |
| 1.7.0 默认采集遥测、`--no-usage-statistics` 关闭 | 1.7.0 README L45 | ✅ "Data collection is **enabled by default**" |
| 1.7.0 工具名稳定（evaluate_script/new_page/navigate_page/take_snapshot/list_pages/close_page）+ 新增 list_network_requests/get_network_request/list_console_messages | tarball build grep | ✅（且 input 工具族 click/fill/hover 等新增） |
| `--headless`/`--isolated` 在 1.7.0 仍在 | README L594/L604 | ✅ 迁移面友好 |
| INV-76 三契约点（evaluate_script 函数表达式 / wait_for text string / take_screenshot filePath）在 1.7.0 兼容 | tarball build grep | ✅ 三点均保持（evaluate_script `function: zod.string()`） |
| HeadlessChannel 启动参数无 `--user-agent`；`--disable-blink-features` 自注「是否真到 Chromium = L3 未验证」 | 读源码 L40-79 | ✅ |
| stealth-profiles.ts:213 注释「UA/viewport/timezone 由启动 flag 控制」与实现脱节；profile 值 = Chrome 130（2024-10）且 key 名还叫 windows_chrome_120 | 读源码 | ✅ 注释与 spec 事实矛盾坐实 |
| BrowseChannel network=PerformanceObserver 注入 / console 占位（INV-33 Map） | 读源码 L115-175 | ✅ |
| SteelChannel release 用全量端点 `/v1/sessions/release`；session body={} 不传 proxyUrl | 读源码 | ✅ |
| 全 src 无 proxy 出口（所有 "proxy" 命中均为注释/webgl Proxy 模式） | grep | ✅ |
| search 链路零 freshness/tbs/recency；SearchChannel callTool 仅 3 参 | grep + 读源码 | ✅ |
| 智谱上游有 `search_recency_filter` 参数 | 裁决官自身同款 MCP 工具 schema | ✅ 闲置坐实 |
| extract.ts 硬编码 baidu.com/s；selectors.ts google selector 零生产调用方（死配置）；FreeTierRouter L1 注释自点名 DDG 未实现 | grep + 读源码 | ✅ |
| SearchCache._key = sha1(query\|engine\|region\|limit)，INV-11 | 读源码 | ✅ |
| `rust-helper/src/ax.rs:171-178` ax_act 返回 not_implemented（注释自记「Phase B M0.5b 落地」）；cgevent.rs 仅 key/hotkey/dispatch 三函数零鼠标引用 | 读源码 | ✅ 桌面「能看不能点」坐实 |
| tools/desktop.ts:66 声明 expect；DesktopChannel.ts 全文零 "expect" 消费 | grep | ✅ 死字段坐实 |
| tcc.rs 仅 Accessibility + Screen Recording 两维 | 读源码 | ✅ |
| config.ts L340 裸 parseInt vs L98/L119 有 NaN 守卫（同文件双范式） | 读源码 | ✅ |
| package.json `@modelcontextprotocol/sdk ^1.29.0`；npm v1 latest=1.30.0（2026-07-27）；`@modelcontextprotocol/server@2.0.0` 存在（2026-07-27） | package.json + npm API | ✅ |
| src 零 outputSchema 使用；tools/search.ts 6 处 catch | grep | ✅ |
| check-invariants.mjs L3684 假绿事故注释（「mutation 实测曾靠它假绿」） | 读源码 | ✅ 假绿风险有在案实证 |
| agent-desktop mouse.rs（CGEventCreateMouseEvent 鼠标合成全链）+ builder.rs（skeleton 边界/children_count/FxHashSet 防环/is_web_wrapper 深度中和） | zread 白盒读上游源码 | ✅ 与调研报告逐行吻合 |
| Peekaboo「Event Synthesizing」TCC 维度（macOS 15+ 合成输入新权限） | peekaboo.sh/permissions.html 官方文档 | ✅ C-6 前提成立 |

结论：四份调研可信度高，可作裁决依据。

---

## 1. 四维总评

### 1.1 技术选型 —— 已最优

所有 2025-2026 的选型判断被本轮生态复核**正向验证**：defuddle+turndown 是社区共识现代化路线（markitdown 属本地文件域且被 INV-68 正确排除）；chrome-devtools-mcp 作为四通道驱动层仍是官方唯一选项（agent-browser 的 CLI 范式是 CC 侧配置而非结构性优劣）；不跟进 Camoufox（上游自认维护断档+性能下降）、不依赖 puppeteer-extra 生态（弃维 3 年）两次「不选」均被上游演化证实正确；Brave 做英文艺主力有 aimultiple 基准背书。唯一选型层瑕疵是**版本滞后**（驱动层锁 11 个月前版本、SDK 差 1 个 minor），属货币性维护（T1/T16），不是选型错误。

### 1.2 架构 —— 已最优

白盒确认 Lasso 三大特色机制（CapabilityBag 带 audit trail + 熔断自动联动、doctor 内生自检、78 条 INV 静态守护）在业界**无更优可直接替换的实践**：FastMCP 的 Visibility/middleware 是更通用但更浅的框架化方案，且 TS SDK v1 无官方工具钩子，引入即违简单架构红线。fallback 单引擎（INV-55）、零依赖缓存（INV-11）、quota ledger（INV-10/54）、tri-state 诚实降级全部领先对标。**本轮 16 项调优中 0 项涉及架构改动**——全部是版本迁移、数据刷新、实现补齐与工程卫生，架构本身无需动。

### 1.3 范围 —— 已最优

四域调研的反向结论一致：所有「不做」决策（browserless 第五通道、Camoufox、SearXNG 自托管、search+scrape 融合、fetch 浏览器升级梯、agent 框架化、pi 的 epoch/泳道并发）均有上游证据或 INV/简单架构红线支撑，**无一需要推翻**。范围蔓延零发现。特别裁决：desktop act 实施不属于范围扩张——zod schema、四档 dispatch（INV-18/29）、ax.rs 占位（自记「Phase B M0.5b 落地」）均为 v1.10.0 已声明契约，补齐属「已声明未实施」的完成，非新特性。

### 1.4 实施 —— 有调优空间（本轮全部调优项所在维度）

三处实施层实质差距：① **desktop act 链空壳**（ax_act not_implemented + CGEvent 无鼠标 + 档4 只推断不执行 → click/type/scroll 全链不可达，且 expect 死字段构成 schema 承诺与实现的裂缝）——这是四域合审中唯一的量级差，也是 tri-state 诚实性在自家后院的欠账；② **驱动层 11 个月/57 版滞后**（--chromeArg/--proxy-server/--wsEndpoint 全部缺席，且 0.3.0 的 unknown-flag 哑弹使 `--disable-blink-features` 是否真到 Chromium 至今是 L3 未验证项）；③ 少量工程卫生债（profile 数据停在 Chrome 130、freshness 上游能力闲置、config 双范式、INV 假绿无制度化防线）。全部可在「单人+AI 一轮一项」粒度内收敛。

---

## 2. 本轮调优项清单（16 项，全部过五条门槛）

> 门槛：①白盒证据差距 ②愿景内既有能力优化 ③代价≤中（单人+AI 一轮）④收益可验证 ⑤不破 INV/tri-state/简单架构。
> 每项独立可验收；依赖关系已标注。P0×3 / P1×5 / P2×6 / P3×2。

### P0

#### T1【浏览器】升级 chrome-devtools-mcp 0.3.0 → 1.7.0 并适配
- **证据**：`SubprocessManager.ts:38` 锁 0.3.0（npm 2025-09-25）vs latest 1.7.0（2026-08-10，裁决官 registry 实证）；1.7.0 新增 `--chromeArg`/`--proxyServer`/`--wsEndpoint --wsHeaders`/`--viewport`/`--allowedUrlPattern`（tarball 实证）；**默认采集使用统计**（README L45）——不加 `--no-usage-statistics` 即隐私倒退。
- **改法**：① `LOCKED_CDP_MCP_VERSION` → "1.7.0"；② 所有 spec（headless / logged_in / steel / browserbase）追加 `--no-usage-statistics`；③ 逐条复核 INV-76 断言对 1.7.0 契约（裁决官已预检三点兼容：evaluate_script `function:string` / wait_for `text:string` / screenshot filePath 均在）；④ BrowserbaseChannel 从 `--browser-url` 改 `--wsEndpoint`（0.9.0+ 对 wss+自定义头才有语义保障）；⑤ 跑 parse13-acceptance sannysoft 手测清单。
- **文件**：`src/subprocess/SubprocessManager.ts`、`src/channels/HeadlessChannel.ts`、`src/channels/LoggedInChannel.ts`（spec 注册处）、`src/channels/SteelChannel.ts`、`src/channels/BrowserbaseChannel.ts`、`src/invariants/check-invariants.mjs`（INV-76 复核）。
- **收益**：11 个月 bug 修复红利；解锁 T2/T5/T10；`--disable-blink-features=AutomationControlled` 经 `--chromeArg` 真正到达 Chromium（消灭 unknown-flag 哑弹）；`--experimentalPageIdRouting` 为并发会话留门。
- **代价**：中（一次性迁移 + 全通道契约回归）。
- **风险**：跨 57 版；回滚 = 改一行版本常量（单点回滚能力本就内置）；必须全 spec 关遥测。
- **验收**：`npm run build && npm test && npm run check-invariants` 基线 1801+ / 78+ 不减；新增测试断言全部 spec 含 `--no-usage-statistics`；四通道 smoke（headless navigate / logged_in attach / steel mock / browserbase mock）；sannysoft 手测清单归档。

#### T2【浏览器】headless 通道 launch 级 UA/viewport（依赖 T1）
- **证据**：`HeadlessChannel.ts:56-64` 无 UA flag；HTTP 头 UA=HeadlessChrome（JS defineProperty 改不了 HTTP 头）；`stealth-profiles.ts:213` 注释声称「UA 由启动 flag 控制」与实现脱节。
- **改法**：headless spec 追加 `--chromeArg=--user-agent=<profile.userAgent>` 与 `--viewport=<w>x<h>`（经 T1 解锁）；profile 构造期已选定（HeadlessChannel.ts:38），无生命周期冲突；JS 侧 16 路 evasion 保留为双保险；顺手把 stealth-profiles.ts:213 注释改为与实现一致。
- **文件**：`src/channels/HeadlessChannel.ts`、`src/browse/stealth-profiles.ts`（注释）。
- **收益**：消除网络层头号检测点（UA 头↔navigator 不一致即标记，camoufox 官方 doctrine 第一条）；sannysoft UA 行转绿。
- **代价**：小（spec 数组加两项）。
- **风险**：低；云端通道（Steel/Browserbase 自带指纹）不动；logged_in 不动（真实 Chrome）。
- **验收**：新测试断言 headless spec args 含 `--user-agent=`；手测 httpbin 类端点回显 UA 非 HeadlessChrome；sannysoft UA 行绿。

#### T3【桌面】落地 ax_act：observe→act 闭环（档1 从占位变真实现）
- **证据**：`rust-helper/src/ax.rs:171-178` not_implemented（自记「Phase B M0.5b 落地」）；zod 已声明 click/type/scroll（`tools/desktop.ts:46-65`）但四档无一档可执行；档4 VLM 只推断不执行。对标：agent-desktop `actions/chain.rs`（AXPress/SetBool/SetDynamic + ChildActions/AncestorActions + AXSetMessagingTimeout 1.0s + 写后读回验证，裁决官 zread 实读其 mouse.rs/builder.rs 全吻合）；Peekaboo `perform-action`/`set-value`。
- **改法**：`ax.rs` act(params) 按 `@eN` ref 解析：**重新 walk + 确定性同序重编号**（与 find 同序，零新状态，守 R-INT 简单架构）；解析后先比对 role+label+rect 三元组，不符即 `stale_ref`→TS 映射 didnt；click→`AXPress`（调用前读 AXActions 校验支持，不支持直接 didnt，省注定失败的 FFI）；type→`AXSetValue` 写后读回比对（secure 字段豁免）；scroll→`AXScrollToVisible` + 方向映射；press/hotkey 留档3。每元素先 `AXSetMessagingTimeout(1.0)`。返回逐项 `{ref, ok, error_kind}`（cgevent_dispatch 已有同形先例）。
- **文件**：`rust-helper/src/ax.rs`（~200 行）、`src/desktop/AxProvider.ts`（映射）、`src/channels/DesktopChannel.ts`（错误映射）。
- **收益**：desktop 从「能看不能点」变 observe→act 闭环；四档 fallback 恢复设计语义（Electron 吞 AXSetValue 才降 appleScript/cgEvent）；最小版 stale 检测 + 写后验证 + actions 前置校验一并入链（吸收调研 C-3 最小集/C-5 最小集/D3）。
- **代价**：中。
- **风险**：真机手测依赖（CI 无 GUI，沿 uia/atspi 诚实 pending 先例）；Rust 单测覆盖映射逻辑。
- **验收**：rust 单测（动作映射/三元组不符/secure 豁免）；TS 集成测（mock helper 走通 click/type/scroll 全链 outcome=worked/didnt）；真机手测清单归档（macOS 12 本机可验）；`npm test`+`check-invariants` 基线不减。

### P1

#### T4【浏览器】stealth profile 值更新：Chrome 130 → 当前 stable 时代值
- **证据**：`stealth-profiles.ts:107-127` UA/secChUa/brands 均 Chrome 130（2024-10 时代，落后 ~14 个大版本；key 名 windows_chrome_120 更陈旧）；UA 版本过旧本身即启发式弱信号。
- **改法**：只改 `STEALTH_PROFILES` 顶级 const 值域（UA、secChUa、brands 版本**三方一致**），key 不动（parse13 §2 稳定标识符承诺）；profile 遍历测试加「UA 版本↔secChUa↔brands 一致」断言；doctor 加「UA 版本年龄」提示项（非自动化生成，守 INV-30 anti-gaming）。
- **文件**：`src/browse/stealth-profiles.ts` + 对应 spec 测试 + `src/doctor/`。
- **收益**：降低指纹年龄信号；无架构改动。
- **代价**：小。
- **风险**：无（顶级 const 性质不变）。
- **验收**：一致性断言测试绿；creepjs-baseline fixture 同步；门禁全绿。

#### T5【浏览器】doNetwork/doConsole 换上游原生工具（依赖 T1）
- **证据**：`BrowseChannel.ts:125-132` network=evaluate_script 注 PerformanceObserver（自注 F2 已知限制）、console 占位；1.7.0 有 `list_network_requests`/`get_network_request`/`list_console_messages`（tarball 实证）。
- **改法**：dispatch Map 两条 entry 的 handler 换 callTool 直调（INV-6/33 不动，仍是 Map entry）；删除 PerformanceObserver 注入路径；console action 从占位变实装；返回形状按 `upstream-response.ts` 围栏提取范式适配（W1-DEF-1b 经验）。
- **文件**：`src/channels/BrowseChannel.ts`、`src/browse/cdp-actions.ts`、`src/tools/network.ts`。
- **收益**：数据完整度（响应体/头/时序）；删自造轮子；console 实装。
- **代价**：小-中。
- **风险**：低（上游形状围栏已有范式）。
- **验收**：network action 返回真请求列表（mock 断言）；console action 返回真消息；INV-33 检查仍绿；旧 PerformanceObserver 代码路径删除无残留引用。

#### T6【搜索】search 增加 freshness 参数透传三引擎 + INV-11 cache key 修订
- **证据**：search 链路零 freshness 字段（grep 实证）；Brave API 原生 `freshness`、Bing v7 原生 `freshness`、智谱上游原生 `search_recency_filter`（裁决官自身同款 MCP schema 实证）——三引擎上游能力全部闲置；本轮调研任务本身即「查最新」型需求，现状只能 query 里手写日期词。
- **改法**：`searchSchema` 加 `freshness: z.enum(["day","week","month","year"]).optional()`；BraveChannel 映射 `freshness=pd/pw/pm/py` query 参数；BingChannel 映射 `freshness=Day/Week/Month`；SearchChannel callTool 加 `search_recency_filter`；**SearchCache._key 纳入 freshness** 并把 INV-11 表述从「engine+region+limit」修订为「engine+region+limit+全部影响结果的 query 参数」（属不变量语义维护，非违反）。
- **文件**：`src/tools/search.ts`、`src/channels/BraveChannel.ts`、`src/channels/BingChannel.ts`、`src/channels/SearchChannel.ts`、`src/search/SearchCache.ts`、`src/invariants/check-invariants.mjs`（INV-11 表述）。
- **收益**：时效性查询结果质量直接提升（调研/新闻/版本动向场景）。
- **代价**：小（~1 天含测试）。
- **风险**：低。optional 无 default，不传 = byte-identical 现行为（与 extract_mode 同款守护手法）。
- **验收**：cache-key 单测（同 query 不同 freshness → 不同 key）；不传 freshness 的响应与基线 byte-identical；INV-11 修订后 check-invariants 绿；三 channel 透传各有单测。

#### T7【桌面】CGEvent 档补鼠标：click/drag/scroll/move（依赖 T3 坐标换算）
- **证据**：`cgevent.rs` 仅 key/hotkey/dispatch（grep 零鼠标引用）；agent-desktop `input/mouse.rs` 全链实证（CGEventCreateMouseEvent/CGEventCreateScrollWheelEvent + HID tap post，裁决官逐行实读）；nut.js 163k 月下载证明物理层刚需。
- **改法**：cgevent.rs 增 mouse 路径（leftclick@x,y / drag from→to / scroll wheel / move），并入 `cgevent_dispatch` 动作枚举；`ALLOWED_CGEVENT_KINDS` 扩 click/scroll（继续 INV-28 风格：逻辑按钮名，禁 raw button code）；坐标来源 = T3 的 ref→rect 中心换算（TS 端 snapshot 已有 rect）。
- **文件**：`rust-helper/src/cgevent.rs`、`src/desktop/CGEventProvider.ts`。
- **收益**：档3 成为真兜底（canvas/Metal/吞 AX 动作的 Electron app 坐标点击）；配合档4 截图定位形成完整降级链。
- **代价**：中。
- **风险**：全局投递抢用户光标（文档明示）；macOS 15+ 需 Event Synthesizing（见 T11）；macOS 12 本机可验（CGEvent 鼠标 API 无版本门槛）。
- **验收**：rust 单测（按钮映射/坐标换算/枚举校验）；本机手测清单（记事本/计算器点击）；INV-28 风格检查（无 raw button code 字面量）；门禁全绿。

#### T8【桌面】walk 剪枝 v2：skeleton 边界 + childrenCount + 防环 + web wrapper 深度中和
- **证据**：Lasso `interactive_only` 全有或全无（过滤丢文本上下文，不过滤 dense app token 爆炸）、无截断计数即无钻取语义；agent-desktop `tree/builder.rs`（裁决官实读）：skeleton 边界 `children_count` 占位、`ancestors: FxHashSet` 指针防环、`is_web_wrapper`（AXGroup/AXGenericElement 无 title/value）子代深度不 +1、secure 值脱敏、label 从 static-text 子代提升。
- **改法**：`ax.rs` walk 增 `skeleton` 参数（边界节点序列化 `children_count`，`skip_serializing_if` 保 wire 兼容——与 window_id 同模式）；TS OutlineNode 增可选 `childrenCount`；desktop tool options 增 `skeleton`（默认关，沿 INV-70 byte-identical 先例）；walk 增 visited 指针集合（防环）；web wrapper 链深度不 +1（Electron/WebView 内容可达性修复，Rust 端完成 TS 零感知）。钻取（root_ref drill-down）暂不做——待 T3 ref 语义稳定后按需加。
- **文件**：`rust-helper/src/ax.rs`、`src/desktop/OutlineMapper.ts`、`src/tools/desktop.ts`。
- **收益**：dense app（Slack/Electron/IDE）token 成本数量级下降（agent-desktop 实测 78-96%）；Electron 内容可达；环树不耗尽预算。
- **代价**：中。
- **风险**：wire shape 变更（opt-in + serde skip 兜底）；wrapper 中和默认生效会改变 Electron app 默认输出（属可达性缺陷修复，需 fixture 测试固化新基线）。
- **验收**：skeleton 默认关 → 默认路径 byte-identical 测试绿；skeleton 开 → 边界节点含 childrenCount 且子树省略（fixture 断言）；合成环 fixture 不死循环；wrapper 链 fixture 深度语义正确；门禁全绿。

### P2

#### T9【搜索】SERP 非 CJK 兜底补 DuckDuckGo + google 死 selector 清理
- **证据**：`serp/extract.ts` 硬编码 baidu.com/s（英文 query 落百度=免费层英文兜底缺位）；`selectors.ts` google selector 零生产调用方（死配置，grep 实证）；`FreeTierRouter.ts` L1 注释自点名 DDG 至今未实现；firecrawl/open-webSearch 社区共识 DDG 为零 Key 兜底。
- **改法**：`serpScrapeFallback` 按 query 是否 CJK（复用 MultiSourceFanout 同款正则）分流：CJK→baidu（现状），非 CJK→duckduckgo.com/html/?q=（纯 HTML 端点，browse_headless 渲染后同款快照正则抽取）；SerpHealthMonitor engine 名扩 "ddg"；`selectorsFor` 死配置要么接线要么删除（消灭死配置，R-INT 卫生）。**不动 INV-23**（仍全程走 browse_headless）。
- **文件**：`src/serp/extract.ts`、`src/serp/selectors.ts`、`src/serp/SerpHealthMonitor.ts`（如名）。
- **收益**：零 Key 英文兜底从「百度凑合」变社区共识引擎；selector 多引擎骨架第一次真正用上第二引擎。
- **代价**：小-中。
- **风险**：中低（DDG 限频；但该路径本就是最后兜底，SerpHealthMonitor 可观测现成）。
- **验收**：CJK/非 CJK 分流单测；ddg 抽取 fixture 单测；SerpHealthMonitor 记 ddg hit/miss；门禁全绿。

#### T10【浏览器】LASSO_PROXY 出口支持（headless 部分依赖 T1；Steel 部分独立）
- **证据**：全 src 无 proxy 面（grep 实证）；上游 `--proxyServer`（1.7.0 实证）；Steel session schema 原生 `proxyUrl`（SteelChannel 自己的注释 L66 都列了）；用户实际网络环境（ClashX/TUN）下出口一致性是 browse 可靠性问题。
- **改法**：新增 `LASSO_PROXY` env（config 默认层，PolicyGate 可见），非空时 headless spec 追加 `--proxy-server=<v>`、SteelChannel session body 加 `proxyUrl`；**logged_in 通道永不读取该 env**（用户真实 Chrome 出口必须原样，加测试钉死）；doctor 加「proxy 配置回显」检查项。
- **文件**：`src/config/config.ts`、`src/channels/HeadlessChannel.ts`、`src/channels/SteelChannel.ts`、`src/doctor/`。
- **收益**：反封锁基本面 + 代理环境用户通道可用性。
- **代价**：小。
- **风险**：低（env 属用户显式配置，不触碰 INV-30 stealth anti-gaming 面）。
- **验收**：logged_in 不读 LASSO_PROXY 的负向测试；doctor 回显检查；headless spec 含 proxy-server（设 env 时）；门禁全绿。

#### T11【桌面】TCC 第三维：Event Synthesizing 预检（macOS 15+）
- **证据**：Peekaboo 官方文档（peekaboo.sh/permissions.html，裁决官核实）：macOS 15+ 合成键盘/指针输入需 "Event Synthesizing" 新 TCC 维度；Lasso `tcc.rs` 只探测 Accessibility + Screen Recording 两维——档3 在 Sequoia+ 可能被静默拦截而报不出原因（今天仅键盘已受影响，T7 鼠标后更甚）。
- **改法**：`tcc.rs` 增第三维探测（cfg-gate macOS 15+ API；<15 返 `not_required`）；doctor #15-20 扩一项；新 `error_kind="tcc_event_synthesis_denied"` → TS 映射 didnt + 引导文案。
- **文件**：`rust-helper/src/tcc.rs`、`src/desktop/`、`src/doctor/desktop-doctor-checks.ts`。
- **收益**：CGEvent 合成在 Sequoia+ 失败时诚实报因，tri-state 在最新 macOS 保持成立。
- **代价**：小。
- **风险**：本机 macOS 12 无法验证——按 uia/atspi 先例标手测 pending，不伪造已验证。
- **验收**：cfg-gate 编译通过（15+ 路径 + <15 not_required 路径）；doctor 检查项渲染；错误映射单测；手测 pending 归档。

#### T12【架构】cdpPort 补 NaN 守卫，统一 config 数值解析范式
- **证据**：`config.ts` L340 裸 `parseInt`（用户配 "abc" → NaN 静默下渗 CDP 连接层）vs L98/L119 同文件 `Number.isNaN` 守卫双范式。
- **改法**：新增 `parseCdpPort(raw)`（NaN/越界 → 9222 + logger.warn `config_invalid_value`）替换 L340；顺手核对 config.ts 其余 parseInt 裸调；config-file spec 补「非法 LASSO_CDP_PORT → 默认 9222」用例。
- **文件**：`src/config/config.ts` + 对应 spec。
- **收益**：消灭静默 NaN 下渗面；数值解析归一单范式（R-CI-02 精神）。
- **代价**：XS（<30 分钟）。
- **风险**：近零（NaN 只会制造更晚更怪的错，无人依赖）。
- **验收**：非法值回退默认 + warn 日志的单测；门禁全绿。

#### T13【架构】INV mutation 自检制度化——「pin 必须红过一次」
- **证据**：check-invariants.mjs L3684 在案注释「mutation 实测曾靠它假绿」（screenshot_region regex 被字段读取形态骗过）——假绿事故真实发生过；TS SDK behavior-surface-pins 纪律（landing 前必须 mutation-check 一次；永不为过 CI 放宽 pin）是直接业界对照。
- **改法**：新增 `scripts/inv-selftest.mjs`（node:* only，守 INV-64 精神）：从 78 条 assertion 抽样（如 10 条/轮，确定性轮转），对 src 树**临时副本**注入已知违规样本（如插 `new Agent(` 验 INV-32 红、插 `class FooChannel {` 验 INV-2 红），断言对应 check 由绿转红；任一 pin 违规下仍绿 → exit 1 报「假绿 pin」。挂 `npm run check-invariants -- --selftest` 或 CI 周任务；check-invariants.mjs 头注释写明「新增 INV 必须注册违规样本」守则。
- **文件**：`scripts/inv-selftest.mjs`（新增）、`src/invariants/check-invariants.mjs`（头注释 + npm script）。
- **收益**：把「78 条守护真的在守护」从假设变成周期性事实；对症已发生过的假绿模式；若某 INV 写不出违规样本，本身就是发现（不可证伪 → 应重写）。
- **代价**：中（~1 天）。
- **风险**：低（只读临时副本不碰工作树）。
- **验收**：selftest 对首批 10 样本全部由绿转红；注入后原树零污染；npm script 可独立运行。

#### T14【架构】ToolManager.register 收拢统一 handler 包装（单点横切，非通用 middleware）
- **证据**：FastMCP 单一 Middleware 管道统一 error/log/timing（middleware.py 白盒）vs Lasso 横切 6 处分散（search.ts 单文件 6 处 catch 实证）；TS SDK v1 无官方钩子 → 手搓是必然，但收拢到 ToolManager.register 单点是最小形态。
- **改法**：`ToolManager.register()` 内包 `wrapHandler`：try/catch → 统一 `isError:true` envelope + 既有 logger 结构化字段（evt/tool/duration）→ 可选 MetricsCollector.record；**v0.5 静态 17 工具不动**（字节级等价承诺），仅 admin/动态注册路径先走；守住「只做 error/log/timing 三件，不演化成可插拔管道」边界。
- **文件**：`src/runtime/ToolManager.ts` + admin 路径测试。
- **收益**：动态工具横切归一单点；后续新工具免写 catch 模板；与 INV-37「必经 toolManager」耦合不增守护成本。
- **代价**：中（半天）。
- **风险**：低（只影响新增注册路径，v0.5 零改动）。
- **验收**：admin 工具错误 envelope 格式不变（现有测试绿）；wrapHandler 计时/日志单测；v0.5 工具行为零变化。

### P3

#### T15【桌面】act 的 expect 死字段：接线（依赖 T3）或删除
- **证据**：`tools/desktop.ts:66` 声明 expect（与 BrowseChannel ExpectCondition 同形）；DesktopChannel.ts 全文零消费（grep 实证）；pi 的后置条件范式（「事件送达 ≠ 语义成功」）正是该字段声明语义。
- **改法**（二选一，倾向①）：① T3 落地后，act 成功且传 expect → 复用 wait 轮询逻辑做后置条件，failed 则 outcome=didnt；② 删字段（zod 契约不承诺未实现的东西）。
- **文件**：`src/channels/DesktopChannel.ts`、`src/tools/desktop.ts`。
- **收益**：消除「schema 承诺了但没兑现」的契约裂缝（tri-state 同构小违背）。
- **代价**：① 小-中 / ② XS。
- **风险**：低（轮询复用现有 wait，无新状态）。
- **验收**：① 传 expect 且后置失败 → didnt 的单测；或 ② zod 与实现完全一致（grep 零死字段）。

#### T16【架构】SDK ^1.29.0 → ^1.30.0（XS rider）
- **证据**：package.json `^1.29.0` vs v1 线 latest 1.30.0（2026-07-27，registry 实证）；v2（`@modelcontextprotocol/server@2.0.0`）已 stable，v1 维护死线 ≈2027-01。
- **改法**：改 package.json 一行，跑全门禁。v2 迁移本身**不动**（见拒绝清单 R10）。
- **收益**：v1 线 bugfix 红利；为 2026-Q4 v2 评估减少一个版本差变量。
- **代价**：XS。
- **风险**：近零（semver minor）。
- **验收**：build + 1801 测试 + 78 INV 全绿。

---

## 3. 拒绝清单（未过门槛 / 记 roadmap / watch / NO-GO）

| # | 候选 | 处置 | 理由 |
|---|---|---|---|
| R1 | patchright L2 stealth 备选通道（browser G） | **roadmap v2.0** | 门槛②失败：新通道 = 全新大特性；Playwright 级依赖 + 全套测试与 38 条 R-INT 张力大；上游部分测试不过/教育用途免责。与诚实定位相容并行，等 L1 路线真实不够用再议 |
| R2 | PruningContentFilter 纯 TS port（search 候选 3） | **watch（触发条件写死）** | 调参敏感 + 无真实 case 驱动即过度设计。触发条件：doctor/实测出现 ≥3 个「defuddle 抽取失败或 markdown 档超 envelope 上限高频落盘」真实站点案例 |
| R3 | stateId 句柄缓存 + LRU（desktop C-3 完整版） | **watch** | T3 的「同序重编号 + 三元组比对」已覆盖安全语义；句柄缓存是延迟优化，带来 invalidation/崩溃面第二机制（R-INT-07 教训）。若 T3 后 act 延迟被实测证明是问题再议 |
| R4 | 树级 actions 数组全量暴露（desktop C-5 完整版） | **watch** | token 膨胀风险；最小价值版（act 前 AXActions 校验）已并入 T3。全量暴露等 skeleton（T8）落地后按 token 预算评估 |
| R5 | admin/doctor/wayback 补 outputSchema（arch 调优项 4） | **watch（捆绑 SDK v2 迁移）** | 单 CC 客户端读 text envelope 现状无痛点；「对齐 spec 方向」本身非用户价值；SDK 校验 envelope 一致性是额外工作量。v2 迁移时一并做，摊薄成本 |
| R6 | Steel per-session release + 钉镜像 tag（browser E） | **watch** | 上游 #245（per-session release 回归）未修，主路径可能恒失败 → fallback 恒兜底 = 复杂度无收益；Lasso 单 session mutex 下全量 release 的实际误杀面窄。待 #245 确认修复或 Steel 下次被触及时顺手做（README 钉 tag 属文档项随做） |
| R7 | browserless 第五通道 / 跟进 Camoufox / 换 agent-browser CLI 范式 | **NO-GO（确认调研员否决）** | 面积扩张违 R-INT；Camoufox 上游自认断档反证不跟进正确；CLI vs MCP 是产品形态选择非结构差距 |
| R8 | SearXNG 自托管通道 / search+scrape 融合 / fetch 内置浏览器升级梯 | **NO-GO（确认）** | 运维成本违单人可持续；融合违 INV-58 族边界 + token 经济性劣；升级梯违 INV-23 |
| R9 | doctor.ts 2707 行拆分（arch O-2） | **observation** | 功能是差异化资产，单独搬家 refactor 收益不抵扰动；下次自然加 check 项时按 section 顺带拆 |
| R10 | SDK v2 迁移 / FastMCP 化 / 通用 middleware 管道 | **roadmap 2026-Q4** | v1 死线 ≈2027-01，非紧急；v2 换包名 + stateless core 是破坏性迁移且需先评估 chrome-devtools-mcp 子进程兼容矩阵；通用管道违简单架构红线 |
| R11 | Windows/Linux 深度实装 / pi 的 epoch/泳道并发 / oculos dashboard | **NO-GO（确认）** | 愿景明示 macOS 主力 + Win/Linux 适配（契约已就绪）；单 CC 场景串行足够 |

---

## 4. 裁决

# ROUND-TUNE（16 项待调）

- **P0×3**：T1 驱动层升级 / T2 launch 级 UA / T3 ax_act 落地
- **P1×5**：T4 profile 值更新 / T5 原生 network+console / T6 search freshness / T7 CGEvent 鼠标 / T8 walk 剪枝 v2
- **P2×6**：T9 DDG 兜底 / T10 proxy 出口 / T11 Event Synthesizing 预检 / T12 cdpPort 守卫 / T13 INV selftest / T14 wrapHandler
- **P3×2**：T15 expect 接线或删 / T16 SDK 1.30 rider

**总评**：技术选型/架构/范围三维**已最优**（零架构改动、零范围扩张、所有历史「不做」决策被上游演化验证）；差距集中在**实施维度**——desktop act 声明未实施（量级差）、驱动层 11 个月滞后、少量卫生债。16 项全部零新依赖、单点可回滚、不破 INV/tri-state/简单架构红线。

**实施建议次序**：T1 → T2（同 PR 紧随）→ T3 → T4/T5/T6（可并行）→ T7/T8 → T9-T14 → T15/T16。每项独立过门禁（build + 1801 测试 + 78 INV 基线不减）。
