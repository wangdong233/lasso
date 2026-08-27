# 第 1 轮最优性审查 —— 实施记录

> 实施工程师：round1-impl。日期：2026-08-17。
> 输入：round1-verdict.md §2 调优项清单（16 项）。
> 基线：v1.10.0（1801 tests + 78 INV）。产出：v1.11.0（1905 tests + 79 INV）。

---

## 逐项实施结果

### P0

#### T1 chrome-devtools-mcp 0.3.0 → 1.7.0 迁移 ✅
- **改动**：`SubprocessManager.ts` 版本锁 1.7.0（含逐条契约复核注释）；四通道 spec（Headless/LoggedIn/Steel/Browserbase）全加 `--no-usage-statistics`；Browserbase `--browser-url` → `--wsEndpoint`；**迁移面契约复核发现裁决官预检一处偏差**——1.7.0 `wait_for.text` 实为 `array(string).min(1)`（McpPage.waitForTextOnPage 对 text.flatMap），0.3.0 是 string：`BrowseChannel.doWait` + `creepjs-probe` 改传数组，INV-76 (b) 断言同步翻转。
- **不变量**：新增 **INV-79**（版本锁 / 全 spec 遥测关 / wsEndpoint / chromeArg UA / 零裸哑 flag 五组断言）。
- **测试**：`test/unit/cdp-mcp-170-migration.spec.ts`（10 测）+ helpers/spec-capture.ts；既有 wait_for 契约测翻转更新。
- **验收**：门禁全绿（1905+79）；四通道 mock smoke（headless navigate / logged_in attach / steel / browserbase 断言 spec 形状）；sannysoft 手测清单归档 `round1-manual-test-checklist.md`（⏳ 真机项诚实 pending）。

#### T2 headless launch 级 UA/viewport ✅
- **改动**：HeadlessChannel spec 加 `--chromeArg=--user-agent=<profile UA>` + `--viewport=WxH`（profile 构造期选定）；`--disable-blink-features=AutomationControlled` 改经 `--chromeArg` 包装（0.3.0 unknown-flag 哑弹时代结束，parse13 §8.4 L3 未验证项关闭）；stealth-profiles.ts:213 注释与实现对齐。
- **测试**：cdp-mcp-170-migration.spec.ts T2 段（UA 非 HeadlessChrome / viewport 同源 / 自定义 profile 跟随）。

#### T3 ax_act 落地（observe→act 闭环）✅
- **改动**：`rust-helper/src/ax.rs` ~200 行实装：重新 walk + 确定性同序重编号（where 在 = find 命中序；缺席 = snapshot 全节点前序）；三元组 stale 检测（role/label 精确 + rect 中心漂移>50px → `stale_ref`）；click→AXPress（AXActionNames 前置校验）；type→AXSetValue 写后读回比对（Secure 字段豁免）；scroll→AXScrollToVisible；press/hotkey 留档3（逐项 ax_unsupported_action）；每元素 AXSetMessagingTimeout(1.0)。
- **TS 侧**：AxBackend.act 签名 `(actions)` → `(app, maxDepth, where, actions)`（三平台同形 INV-61）；AxProvider.act 逐项结果 tri-state 映射（全项失败 + stale_ref → **didnt** 短路链；无 stale → unknown 链继续）。
- **测试**：rust `ax::platform::act_tests`（4 测）+ `test/integration/desktop-ax-act.spec.ts`（click/type/scroll 全链 worked / stale_ref → didnt / press 链走到 cgEvent 档）；手测清单 E1-E5 ⏳。

### P1

#### T4 stealth profile 值更新 ✅
- **改动**：STEALTH_PROFILES 值域 → Chrome 151（2026-08 stable）/ Safari 27 / Firefox 153（key 不动，稳定标识符）；UA↔secChUa↔brands 三方一致（ghost brand 151%4=3 → "Not_A Brand"，与 ua-client-hints.ts 运行时派生规则对齐）；doctor #25 加「UA 版本年龄」提示（hint 非 gate，INV-30 anti-gaming）。
- **不变量**：INV-73 (d) 修订（新值域 + 三方一致 + 旧时代值清零）。
- **测试**：stealth-profiles.spec.ts 重写 v1.11 段（10 测，含三方一致 + ghost brand 派生断言）。

#### T5 doNetwork/doConsole 原生化 ✅
- **改动**：doNetwork 删 PerformanceObserver 注入路径 → 直调 1.7.0 原生 `list_network_requests`（filter→resourceTypes 映射：xhr/fetch/img；conci se 行 `reqid=N METHOD url [status]` 解析）；doConsole 从占位变实装（`list_console_messages`；`msgid=N [type] text (N args)` 解析）；CDP_UPSTREAM_TOOL_NAMES 更新（network_log=list_network_requests / +network_get / console_log=list_console_messages）；network.ts ResourceEntry 扩 method/status/reqid（timing/bytes 转 optional——数据完整度移 get_network_request 详情）；F2（TUN 抓不全）限制随原生工具关闭（描述/doctor/annotations 同步）。
- **测试**：`test/unit/cdp-actions-native.spec.ts`（12 测：filter 映射 / 行解析 / F2 前缀保留 / 注入路径零残留 grep）。

#### T6 search freshness ✅
- **改动**：searchSchema + `freshness: enum(day/week/month/year).optional()`；三引擎透传——智谱 `search_recency_filter`（oneDay/oneWeek/oneMonth/oneYear）、Brave `freshness=pd/pw/pm/py`、Bing `freshness=Day/Week/Month`（year 档 Bing 无粒度诚实不传）；SearchCache key 纳入 freshness；INV-11 表述修订为「engine+region+limit+全部影响结果的 query 参数」。
- **零回归**：optional 无 default，不传 = key byte-identical 基线（有单测钉死）。
- **测试**：`test/unit/search-freshness.spec.ts`（8 测）。

#### T7 CGEvent 鼠标四路径 ✅
- **改动**：cgevent.rs dispatch 扩 click(x,y,button?)/move/drag(from→to)/scroll(dx,dy[,x,y])（CGEventCreateMouseEvent + CGEventCreateScrollWheelEvent2，Cargo.toml 开 highsierra feature）；button 逻辑名（left/right/center；INV-28 禁 raw button code，数字入参双端拒绝）；TS UiAction/zod 扩坐标形态（ref 形态保留——ax 档吃 ref，cgEvent 档吃坐标）；CGEventProvider ALLOWED_CGEVENT_KINDS 扩 4 类 + specRefLabel 可读 audit 标签。
- **测试**：rust `cgevent::tests` +8（含源码无 raw button code 字面量静态测）+ `test/unit/cg-event-mouse.spec.ts`（13 测）；手测清单 C1-C5 ⏳。

#### T8 walk 剪枝 v2 ✅
- **改动**：ax.rs walk 增 skeleton（max_depth 边界节点 children_count，serde skip 保 wire 兼容——与 window_id 同模式）+ visited 指针集合（防环，cycle 占位节点）+ web wrapper 深度中和（AXGroup/AXGenericElement 无 title/value 子代深度不 +1——Electron 内容可达修复，默认生效）；AxNode/OutlineNode 增可选 childrenCount；desktop options + skeleton（默认关 byte-identical，沿 INV-70 先例）；钻取不做（按裁决）。
- **测试**：rust `web_wrapper_detection` 单测 + `test/unit/desktop-skeleton.spec.ts`（7 测：默认 byte-identical / 开→childrenCount / 形状校验 / Rust 端机制源码级断言）。

### P2

#### T9 SERP 非 CJK DDG 兜底 + google 死 selector 清理 ✅
- **改动**：serpEngineForQuery（CJK 正则与 MultiSourceFanout 同款）分流——CJK→百度（现状）/ 非 CJK→html.duckduckgo.com/html；DDG 跳转壳 `/l/?uddg=` 解包还原真实 URL；duckduckgo 自家链接排除；GOOGLE_SELECTORS **删除**（零生产调用方死配置，R-INT 卫生）→ DDG_SELECTORS 接线；SerpEngine = "baidu"|"ddg"；registry/doctor 同步（BAIDU+DDG 计数）。历史 google fixture 保留（录制数据是 URL 正则抽取的有效回归基线）。INV-23 不动（全程 browse_headless）。
- **测试**：`test/unit/serp-ddg.spec.ts`（12 测：分流 / 解包 / health 计数 / 死配置零残留）。

#### T10 LASSO_PROXY 出口 ✅
- **改动**：config + `proxy`（LASSO_PROXY trim；CONFIG_TEMPLATE 加 key）；headless spec `--proxy-server=<v>`（1.7.0）；Steel session body `proxyUrl`（原生字段）；index.ts 装配；**browse_logged_in 永不读取**（源码级 + 行为级双负向测试钉死）；doctor + `proxy_config` 回显检查（只回显不探活）。
- **测试**：`test/unit/proxy-egress.spec.ts`（10 测）。

#### T11 TCC Event Synthesizing 预检 ✅
- **改动**：tcc.rs 第三维三态探测（granted/denied/not_required）：版本门（sysctl kern.osproductversion <15 → not_required）+ `IOHIDCheckAccess(kIOHIDRequestTypePostEvent)`（dlopen/dlsym 运行时符号解析——硬链接在 macOS 12 SDK link 失败，弱链接需 nightly，运行时解析是 stable 正解且 CI 可跑）；cgevent dispatch 预检 denied → `tcc_event_synthesis_denied`；CGEventProvider 映射 **didnt** + 引导文案；doctor #21 tcc_event_synthesizing（SKIP 列表同步 7 项）。
- **测试**：rust tcc::tests（本机 12 验 <15 路径）+ `test/unit/tcc-event-synthesizing.spec.ts`（7 测）；15+ 真机 N/A（手测清单 D1）。

#### T12 cdpPort NaN 守卫 ✅
- **改动**：`parseCdpPort`（NaN/≤0/>65535 → 9222 + logger.warn config_invalid_value）替换裸 parseInt；config 数值解析归一单范式。
- **测试**：config-file.spec.ts +4 用例（abc/越界/合法边界/纯函数）。

#### T13 INV mutation 自检制度化 ✅
- **改动**：`scripts/inv-selftest.mjs`（node:* only）——10 违规样本注册表（INV-2/3/4/7/11/17/21/28/33/63），逐样本 cpSync 临时副本 → 注入 → LASSO_INV_SRC_ROOT 复跑 checker → 断言目标 INV 转红；假绿 pin → exit 1；工作树零污染。check-invariants.mjs 头注释加「新增 INV 必须注册违规样本」纪律 + `--selftest` 委托 + SRC_ROOT env 覆盖；npm script `inv-selftest`。INV-63 样本锚点动态取 package.json 版本（bump 不失效）。
- **实测**：10/10 样本全部由绿转红。

#### T14 ToolManager wrapHandler ✅
- **改动**：register() 内单点横切——error（统一 isError envelope）/ log（结构化 evt/tool/channel/duration）/ timing（可选 MetricsCollector.record，setMetrics 注入）；**边界纪律**：只做三件事不演化成管道；v0.5 静态 17 工具不经 register（字节级等价承诺，源码级测试钉死）。
- **测试**：ToolManager.test.ts +5（透传 / isError envelope / metrics 入窗 / 双注入幂等 / v0.5 零迁移）。

### P3

#### T15 expect 死字段接线（方案①）✅
- **改动**：DesktopChannel.act 尾部——worked 且传 expect → 复用 axProvider.find 轮询验后置（gone 语义支持；text/role 缺失诚实报 expect_failed:expect_needs_text_or_role）；后置失败 → **outcome=didnt** + expect_verified=false；非 worked 不验（expect 零影响）。
- **测试**：desktop-ax-act.spec.ts T15 段（5 测）。

#### T16 SDK ^1.29.0 → ^1.30.0 ✅
- **改动**：package.json 一行 + 注释同步（3 处 SDK 版本提法）；v2 迁移不动（拒绝清单 R10）。

---

## 门禁输出（最终）

| 门禁 | 结果 |
|---|---|
| `npm run build` | 0 error |
| `npm test` | **1905 passed** / 1 skipped（基线 1801 → +104 新测） |
| `npm run check-invariants` | **79/79 PASS**（新增 INV-79；INV-11/73/76 语义修订） |
| `npm run inv-selftest` | **10/10 pin 由绿转红**（工作树零污染） |
| `cargo test`（rust-helper） | 193 passed（含 ax_act/cgevent 鼠标/tcc 三维新测） |

## 版本与三处同步

- package.json / src/index.ts LASSO_SERVER_VERSION / src/doctor.ts LASSO_VERSION = **1.11.0**（INV-63；行为/机制变化 → minor）。
- README.md / README.en.md / doc/usage/01-KEY-GUIDE.md 用户向同步（freshness / 桌面 act / LASSO_PROXY / 版本头）。

## 拒绝清单执行确认

R7/R8/R11 NO-GO 项零触碰；R1/R5/R6/R10 roadmap/watch 项未提前实施；R9 doctor.ts 拆分未动。

## 遗留（诚实 pending）

- 真机手测清单（doc/governance/01-最优性审查轮次/round1-manual-test-checklist.md）：sannysoft（T1/T2）、桌面 ax_act（T3）、CGEvent 鼠标（T7）、Event Synthesizing 15+（T11 N/A 本机 12）——全部 ⏳ 待真机回填，不伪造已验证。
