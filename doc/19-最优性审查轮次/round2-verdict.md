# 第 2 轮最优性裁决书（round2-verdict）

> 裁决官：第 2 轮最优性裁决官。日期：2026-08-17。
> 输入：四域复审报告（round2-browser / round2-search / round2-desktop / round2-arch，均 2026-08-17）。
> 基线：v1.11.0 工作树（HEAD v1.10.0），门禁 1906 tests（1904 pass / 1 timing-flake / 1 skip）+ 79 INV 全绿 + 193 Rust tests。
> 方法：四份报告全文精读后，**对全部 16 条候选的源码声称逐一白盒抽验**（lasso 源码 + node_modules 已装依赖 + 本地 node 实测复现），拒采信无证据项。抽验记录见 §5。

---

## 0. 裁决速览

| 维度 | 结论 |
|---|---|
| 技术选型 | **已最优**（唯一量级差是「已选依赖 defuddle 的利用度」——实施层非选型层） |
| 架构 | **已最优**（进程生命周期一处上游缺陷收尾；档4/type 是「补全既有架构承诺」非改架构） |
| 范围 | **已最优**（全部 watch/NO-GO 复核零翻案；新诱惑全部正确停在 watch） |
| 实施 | **有调优空间**——本轮主战场。round1 十六项落地质量高于验收线，但留三类尾巴：装配接线遗漏 / 链尾诚实性 / 事件物理质量 |
| **裁决** | **ROUND-TUNE（14 项：P1×5 / P2×4 / P3×5）** |

抽验结论先行：四份报告的 16 条候选中，**16 条的源码声称全部坐实，零夸大零捏造**（其中 1 条机制表述经实测略有不精确但结论不变，见 §5-S1）。门槛过滤后 14 条独立编号过线（2 组同 PR 合并：B1+B2、B3+B4），2 条并入 rider。无一条因证据不足被拒——被拒项全部是四报告自行排除或维持 watch 的部分（§3）。

---

## 1. 四维总评

**技术选型：已最优。** 四份报告的新证据没有一条动摇选型：chrome-devtools-mcp 锁版 1.7.0 = npm latest（2026-08-17 实测无新版）且上游 headless 自动加 `--screen-info` 消灭 800x600 tell（免费红利）；SDK ^1.30.0 = v1 线拉满，驱动层 bundle 内恰是同版（同 era 零协商问题），v2 迁移成本因官方 codemod stable 而下调但时机不变（Q4）；DDG SERP 兜底端点与 selector 和社区标杆 open-webSearch 逐字一致；Rust AXAPI 自持 CGEvent 路径的价值因 nut.js 上游停更而反升。2026-07 独立基准的 automation-protocol fingerprinting 轴（一切 Playwright 系同轴同挂）反向验证了 Lasso「不承诺 DataDome/Kasada」的诚实定位，且其认定的最大杠杆（channel=chrome 真二进制）恰是 T1 迁移后 Lasso 已拥有的。唯一量级差是 defuddle 0.19.1 的利用度只有一半（正文抽取用了、站点 extractor + 高质量转换规则集全休眠）——那是实施问题（T2-3/T2-4），不是选型问题。

**架构：已最优。** 四通道 + FallbackChain + INV 体系在 round1 十六项落地后无结构性缺口：INV-79 把 1.7.0 迁移面固化成守护（超出 round1 验收要求）、INV-11 修订含 mutation 红测、F2 单一真源重构（review03）高于验收线。本轮发现的三处「架构层」问题全部是**补全既有架构承诺**而非改架构：①stdin-EOF 孤儿窗口是上游 SDK 缺陷（#2002，v2 同病）+ Lasso 停机三路径的结构盲区，修复两行且与上游修法同构（T2-12）；②档4 假 worked 是 tri-state 铁律在自家链尾的最后一块违背（T3 废除 M0.5b 后注释承诺永久落空，而执行桥 RustBridge 已注入却从未 dispatch）；③type 降级死胡同是降级链完整性缺口（ax 档错误信息自己说「走档2/3」，但档2 白名单无 type、档3 normalize 返 null）。W-B1（无 shim CDP 控制面）是 v2.0 架构议题，正确地停在 watch。

**范围：已最优。** 全部 watch/NO-GO 复核零翻案且多数被新证据加固：R6 Steel #245 仍 open → 全量 release 现状被上游状态背书；R7 camoufox 主维护者官宣离场 → NO-GO 加固；R8 firecrawl x402 融合深化反证 INV-58 边界正确；R1 patchright 增益实证边际化（+1 OK vs vanilla）→ roadmap 维持但证据降权；R11 Windows/Linux 维持 NO-GO（macOS 主力 + 契约就绪的既定取舍）。新诱惑全部正确处置：CloakBrowser 15k★ 但 darwin 管线停更 2 个月（NO-GO 采用 + watch）；nodriver 范式是架构级换血（watch v2.0）；MCP Tasks 扩展等 CC 客户端支持（watch）；UTCP 一句话否决。范围纪律没有膨胀——本轮 14 项调优全部是既有能力范畴内的优化，零新通道、零新依赖、零新机制。

**实施：有调优空间（本轮主战场）。** round1 十六项全部落地且实施质量普遍高于最低验收线（proxy 双负向测试、INV-79 迁移守护、walk 单一真源），但留下三类清晰的实施尾巴：**①装配/接线遗漏**——`toolManager.setMetrics` 生产零调用（grep 全仓实证，T14 的 metrics 钩子仅测试可达）、INV-79 未注册违规样本（纪律诞生后第一条新 INV 即违反自定纪律）、defuddle 调用点 URL 与 options 双双未传（两调用点 URL 均在作用域）；**②链尾诚实性**——档4 推断即 worked、wait/expect 首命中即真、snapshot 截断与真叶子不可区分（agent-desktop v0.7 专门为此发 breaking change）；**③事件物理质量**——drag 单事件无插值、click 无 clickState、type 在吞 AXSetValue 的 Electron 控件上全链死。14 项全部零新依赖、单点可回滚、不破 INV/tri-state/简单架构。

---

## 2. 本轮调优项清单（14 项，T2-1..T2-14）

> 全部通过五门槛：①白盒证据差距（有对标锚点，且经裁决官抽验坐实）②愿景内既有能力优化 ③代价 ≤ 中等 ④收益可描述可验证 ⑤不破 INV/tri-state/简单架构。全部零新依赖。
> 实施顺序建议：P1 先行（T2-12 两行最高杠杆比 → T2-3/T2-4 同 PR → T2-6/T2-7/T2-1），P2/P3 随后。门禁基线：`npm run build && npm test && npm run check-invariants`，1906/79 不减（新增测试只增不减）。

### 浏览器域（2 项）

---

**T2-1（P1）：headless 默认 profile 对齐宿主 OS——新增 `mac_chrome`，darwin 装配默认切换**（含 rider：UA-skew hint）

- **证据**（抽验坐实）：round2-browser E1 本机 L3 实测——`--user-agent` 生效后 HTTP 层为 `User-Agent: ...Windows NT 10.0...Chrome/151...`，但 `sec-ch-ua-platform: "macOS"`、`sec-ch-ua: ...v="150"`（client hints 不受 flag 影响，发宿主真值）→ **UA 声称 Windows、client hints 招供 macOS 的 OS 级矛盾**，命中 camoufox doctrine 第 1 条与 2026-07 基准 shape-coherence 检测模式。装配点抽验：`src/index.ts:428` 硬编码 `"windows_chrome_120"`（`STEALTH_PROFILES` 现仅 windows_chrome_120 / mac_safari_17 / linux_firefox_121 三条，无 mac_chrome）；`StealthEngine.ts:53-57` 自记 chrome-devtools-mcp 不暴露 setExtraHTTPHeaders → 现架构内唯一修法 = profile 平台与宿主一致。T2 修好了 sannysoft 级（HeadlessChrome token）同时引入此深层矛盾，属「修浅层破深层」净损益反转点。
- **改法**：① `src/browse/stealth-profiles.ts` 新增顶级 const `mac_chrome`（UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36` + `platform:"MacIntel"` + secChUa brands 151 三方一致 + `secChUaPlatform:'"macOS"'`；`STEALTH_PROFILE_NAMES` 同步）；② `src/index.ts:428` 装配改 `process.platform === "darwin" ? "mac_chrome" : "windows_chrome_120"`（构造期确定性选择，非 env 可配，不触 INV-30 anti-gaming 面；doctor.ts:750 探测默认与 doctor-cli.ts:41 是否跟随默认切换由实施者按「探测当前平台默认 profile」语义决定，至少在 detail 里说明）；③ profile 遍历测试加 mac_chrome 三方一致断言 + 装配测试断言 darwin→mac_chrome / 非 darwin→windows_chrome_120；④ **rider（原候选 2）**：doctor `stealth_profile_self_check` 在探测到已装 Chrome major 时附 `skew = profile major − installed major` 提示（|skew|≥2 建议刷新；hint 非 gate，探测失败静默回退现有 age hint，INV-30 不动；launcher 已有系统 Chrome 探测路径可零成本拿版本）；⑤ 手测清单归档：echo server 回显「UA 平台 token ↔ sec-ch-ua-platform 同为 macOS」（沿 round1-smoke-headless.mjs 范式）。
- **收益**：消除 macOS 主力平台 HTTP 层 OS 级矛盾（shape coherence 对齐）；残余版本 skew（profile 151 vs 宿主 major）获得 doctor 观测面。Windows 宿主 windows profile 本就自洽不动；JS 层无需改（evasion 从 UA 推断平台自动跟随）。
- **代价**：S-M（一条 profile + 装配分支 + 测试 + 手测）。
- **验收**：mac_chrome 一致性断言绿；装配分支断言绿；手测清单归档；基线 1906/79 不减。已知残余（记档不扩面）：Linux 宿主仍 windows profile（矛盾在，Win/Linux 是适配非主力）；版本 skew 随宿主更新渐增（rider 只给观测不给消除）。

---

**T2-2（P3）：浏览器域档案与注释卫生——Stagehand R-ECO-6 档案更新 + BrowseChannel 两处陈旧注释**（原候选 3+4 合并，同 XS 文本 PR）

- **证据**（抽验坐实）：① stagehand-ruby（官方 Stainless 生成 SDK）实证托管 REST API 已上线：`sessions.start/navigate/act/extract/observe/execute/end` + SSE——但形状是 session 生命周期 API、无 `/verify` 路由、gem v0「APIs may change at any time」；`src/channels/StagehandChannel.ts:7-13` 注释仍称「Stagehand 实际是 Playwright-extension SDK……非 REST 客户端」——事实已漂移。② `src/channels/BrowseChannel.ts:19`（「network ──→ evaluate_script 注入 PerformanceObserver」）与 `:125-131`（「console 是 v0.5 M0.5b 占位」）均描述 v1.10 旧范式，实现（cdp-actions.ts v1.11 原生化直调）已变，grep 证实 src 无 PerformanceObserver 实现残留，纯注释债。
- **改法**：① StagehandChannel.ts 头注释 R-ECO-6 段更新为「上游托管 REST API 已上线（sessions.* 生命周期形状 + SSE，无 verify 路由，v0 unstable）；本通道 /verify|/extract 契约仍无佐证」；doctor #39 detail 文案同步；doc/16 R-ECO-6 条目补记本轮证据。② BrowseChannel 两处注释改为「network/console → 1.7.0 原生 list_network_requests / list_console_messages 直调（cdp-actions.ts）」。**代码行为零改动**（probe 语义与 observe-only 边界不变）。
- **收益**：档案诚实性（tri-state 精神在文档层）；为 v1.8「重写对齐真实契约 or 删除通道」决策留准确底账（真实面无 verify → 重写即功能缩水，此事实先入档）；防未来读者按旧注释误判 F2 状态。
- **代价**：XS（纯文本）。
- **验收**：注释与 doctor 文案与新事实一致；基线不变（零行为改动）；doc/16 补记。

### 搜索与内容抽取域（3 项）

---

**T2-3（P1）：defuddle URL 透传——激活 ~30 个站点专用 extractor + 相对链接绝对化**（与 T2-4 同 PR）

- **证据**（裁决官本地实测复现坐实）：`src/browse/markdown-extractor.ts:102` `Defuddle(html, "", {})`；已装 defuddle 0.19.1 `extractor-registry.js:209-232` findByPredicate 首行 `new URL(url).hostname`——空串抛 TypeError 被内部 catch 吞掉返回 null → **零 extractor 激活**（机制逐行核实）；实测传入真 URL 后相对链接 `/item?id=1` → `https://news.ycombinator.com/item?id=1`（绝对化生效）。extractors 目录实列 28 文件：github/reddit/hackernews/wikipedia/substack/medium/nytimes/discourse/mastodon/threads/bluesky/linkedin/chatgpt/claude/youtube/bilibili 等——**恰是 CC 调研最高频站点族**。两调用点 URL 均在作用域（抽验：`fetch-url.ts` 的 `rawUrl`、`BrowseChannel.ts:870` 的 `parsed.url`——543 行同对象已在用）。
- **改法**：`MarkdownExtractOptions` 加 `url?: string`；两调用点各传一行；`Defuddle(html, opts.url ?? "", {})`。不传 = 现行为（与 freshness 同款 optional 无 default byte-identical 守护手法）。
- **收益**：高频站族正文抽取直取上游最优实现；markdown 相对链接变绝对链接（对 CC 可直接 fetch）。
- **代价**：XS-S（参数三处 + 真实站点 fixture 测试各一，~半天）。
- **风险与红线**：低。全部 sync extractor 纯 DOM 操作零网络；**明确禁用 `useAsync`**（youtube InnerTube 等第三方 fetch 会绕过 Lasso httpClient/SSRF 面与超时预算——在 markdown-extractor.ts 注释钉死排除理由）。
- **验收**：HN/wikipedia 类 fixture 断言 extractor 路径激活（served_by 或内部路径可区分）+ 相对链接绝对化断言；不传 url 的既有测试 byte-identical；基线不减。

---

**T2-4（P1）：defuddle `separateMarkdown` 接管转换档——表格/数学结构保真**（与 T2-3 同 PR）

- **证据**（裁决官本地实测复现坐实）：同一 `<table>` fixture——defuddle `separateMarkdown:true` 产出 `"| a | b |\n| --- | --- |\n| 1 | 2 |"`（GFM 表格）；**Lasso 现管线裸 TurndownService（零自定义规则）产出 `"a\n\nb\n\n1\n\n2"`——表格结构全丢**。defuddle markdown.ts 另含 MathML→LaTeX（mathml-to-latex 已随装在 node_modules）、colspan/rowspan/布局表检测、脚注、callout、代码语言检测、srcset 最优图——全部是 Lasso markdown 档（文档站/表格密集页）的质量短板，正是 round1 R2 触发条件关注的版式。
- **改法**：`extractMarkdown` defuddle 成功路径改传 `{ url, separateMarkdown: true }` → markdown 取 `result.contentMarkdown`；defuddle 失败降级档（turndown-only）原样保留保底；`served_by` 字面 "defuddle+turndown" 不变（defuddle 内部即 turndown，语义仍准确）；`MARKDOWN_ENGINE` 常量不动；markdown_cited 的引用角标仍在其后应用（管线顺序不变）。
- **收益**：markdown 档对表格/数学密集页的 LLM 可用性数量级提升；删掉自造转换层与上游的重复（保留降级路径）。间接回应 R2（Pruning 维持 watch：先拿更基础的转换保真杠杆）。
- **代价**：S（fixture 基线对齐 + Obsidian 风格语法决策 ~1 天）。
- **风险**：中低。markdown 档输出形状变化（INV-66 只钉 raw 档字节，markdown 档无字节承诺——实施前核对 INV-66 适用范围）；defuddle 输出含 Obsidian 方言（`==高亮==`、`![](youtube链接)`、`[^N]`）——对 LLM 阅读无害，接受并在 README 注明。
- **验收**：表格 fixture 断言 GFM separator 行存在；现有 markdown 档测试基线更新并全绿；降级路径测试保留；基线不减。

---

**T2-5（P2）：freshness 补全——machine_mcp 透传 + DDG SERP `df=`（+ 两处顺手卫生）

- **证据**（抽验坐实）：① `src/channels/MachineMcpSearchChannel.ts:49-54` MachineMcpSearchOpts 无 freshness 字段（grep 零命中），而它是 FallbackChain 首位引擎（DEFAULT_FALLBACK_ORDER machine_mcp 第一）——`src/tools/search.ts:618-621` 调用点只传 limit/engine/region/no_cache，用户传 freshness 时首位引擎静默忽略；machine_mcp 与 SearchChannel 调同一 web_search_prime 上游（参数名 `search_recency_filter` 已被 SearchChannel.ts:151-154 证明）。② `src/serp/extract.ts:67-77` serpUrlFor 未拼 DDG `df=`（DDG html 端点原生 `df=d/w/m/y`，三方文档一致）——兜底路径 freshness 也丢。这是 tri-state 同构小违背：「高可靠 engine」静默丢显式参数。
- **改法**：① MachineMcpSearchOpts 加 freshness + callTool 透传（复用 ZHIPU_RECENCY_MAP，含 fallback_chain 调用点传参）；② serpScrapeFallback/serpUrlFor 加可选 freshness，ddg 分支拼 `&df=`（baidu 无对应参数不拼，诚实降级）；③ 顺手卫生：`SerpHealthMonitor.ts:66` stale 注释 `"baidu"|"google"` → ddg；defuddle lock 0.19.1→0.19.2 rider（^range 已含，纯 lockfile 刷新）。
- **收益**：freshness 从「主链 3 引擎」到「全部 5 路径」语义一致；消灭静默丢参数。
- **代价**：XS（~2 小时含单测：machine_mcp 透传断言 + df 拼接断言 + 不传 byte-identical 断言）。
- **风险**：低。machine_mcp 未探测到时零影响；不传 = 现行为。
- **验收**：三组断言绿；基线不减。附注（零代码随手）：`fetch_url` tool description 加一句「文档站常在 URL 后加 `.md` 或站点根 `/llms.txt` 直取 markdown（Mintlify/GitBook/Fern 惯例）」——提示级，不自动探测（守 fetch 无 fallback 设计）。

### 桌面自动化域（6 项）

---

**T2-6（P1）：档4 screenshotVlm 闭环——VLM 推断 → cgEvent 真执行（或诚实 unknown）**

- **证据**（抽验坐实）：`src/desktop/ScreenshotVlmProvider.ts:186-208`——VLM 调用成功即 `outcome:"worked"` + `actions_and_results:[{ref:"@vlm", ok:true, error:<推断原文>}]`，注释承诺「具体动作执行由 Rust 端 M0.5b 落地」——M0.5b 已被 T3 废除，承诺永久落空；provider 构造器已持 `private readonly rust: RustBridge`（`index.ts:563` 注入），act() 却从未 dispatch。tiers 1-3 全败的动作（canvas/Metal）最终拿到假 worked——**tri-state 铁律在自家链尾的违背**。对标：UI-TARS-desktop（39k★）推断→物理执行是档4 正确形态；Peekaboo v4.1「refusing ambiguous evidence before dispatch」。
- **改法**：VLM 返回对象容错解析为坐标动作（`{kind:"click"/"move"/"drag"/"scroll", x, y, …}` 宽化 record 提取，不锁 VLM shape）→ 命中则 `this.rust.call("cgevent_dispatch", …)` 真执行（T7 路径复用），`actions_and_results` 填真逐项结果；**解析失败或执行失败 → `outcome:"unknown"` + `error:"vlm_inference_only:…"`**，推断原文仍附 data（截图 token 已花不浪费）。
- **收益**：消灭链尾假 worked——canvas 场景从「谎报成功」变「真执行或诚实 unknown」；tri-state 铁律补上最后一块；四档架构声明与链尾现实的落差归零（与 T2-7 合计）。
- **代价**：M（VLM 输出容错解析 + mock 单测 + FallbackDecider 语义确认）。
- **风险**：低。解析失败路径本身就是交付物（诚实降级）；不动 tier 1-3。既有断言「VLM 成功即 worked」的测试需同步改语义（预期内）。
- **验收**：mock 单测三分支（可解析→真执行+真结果 / 不可解析→unknown+vlm_inference_only / 执行失败→unknown）；基线不减。

---

**T2-7（P1）：ax 档 type 兜底——AXFocus + 合成键盘（吞 AXSetValue 的 Electron/自绘控件）**

- **证据**（抽验坐实，死胡同链三环全核）：`rust-helper/src/ax.rs:466-506` do_type 单路径（AXValue settable 校验 → 不 settable 即 `ax_action_unsupported` 出档，错误信息自己说「走档2/3」）；档2 白名单 9 动作（apple-script-whitelist.ts:45-58，finder/mail/safari/notes/system 域）无 type；档3 `CGEventProvider.ts:176-229` normalizeForCgevent 六分支（press/hotkey/move/drag/click/scroll）无 type 返 null——**type 降级链三环全死，链尾接 T2-6 修复前的假 worked**。对标 agent-desktop `type_text.rs` execute_type 梯子：AXValue 写+验证 → 失败 → AXFocused=true + 50ms → 逐键合成 + 每级验证。
- **改法**：do_type 在 `ax_action_ununsupported`/`ax_set_failed` 后**档内兜底**：读 `AXFocused` settable → 置 true → 50ms sleep → 复用 `crate::cgevent` 既有键盘合成逐字符（**仅 ASCII；非 ASCII 保持失败诚实**——剪贴板路线不做，涉污染用户剪贴板面）。写后读回验证保留。顺手在 zod/tool 文案写明 **type = 整值替换语义**（agent-desktop type=追加/set-value=替换两分；Lasso 现状是替换但 schema 无说明——LLM 语义歧义点）。
- **收益**：Electron 吞 AXSetValue 场景 type 从「全链死」变「档1 内真输入」；档1 自洽性提升，跨档次数下降。
- **代价**：S-M（~60 行 + rust 单测；cgevent 键盘合成已存在）。
- **风险**：低-中。焦点置位是可见副作用（单用户场景可接受，agent-desktop 用 InteractionPolicy 门控——Lasso 文档明示即可，不引入策略框架）。
- **验收**：rust 单测覆盖兜底分支（mock settable=false → focus+keyboard 路径）；非 ASCII 拒绝路径断言；真机手测清单 desktop 段补 Electron 输入框用例；cargo test 基线 193 不减。

---

**T2-8（P2）：cgevent 鼠标事件物理质量——drag 插值 + clickState + down→up 间隔**

- **证据**（抽验坐实）：`rust-helper/src/cgevent.rs:344-431`——click = down+up 两事件零间隔零 clickState（grep 无 sleep/Duration/clickState）；drag = 单个 LeftMouseDragged 后立即 up；scroll 先 MouseMoved 移动真实光标再滚轮。对标 agent-desktop `input/mouse.rs`：click 设 clickState（CGEventSetIntegerValueField field 1）+ 10ms down→up + 30ms 双击间隔；drag 200ms 按住 + steps=max(4, duration/16ms) 逐点插值（16ms 步进）+ 500ms 沉淀。
- **改法**：drag 路径加固定节奏（~300ms 总时长：200ms 按住 + ≥4 个插值 dragged 点 @16ms + 100ms 沉淀后 up——数值照抄 agent-desktop 实测参数，不做参数化）；click 的 down/up 设 clickState=1 + 10ms 间隔。不加 double_click action（zod 未声明，宁缺毋滥，仅加固现有 click）。
- **收益**：滑条/拖拽排序/文件拖放从「大概率失败」（目标只认移动轨迹）变可用；挑剔 app 单击判定稳定。
- **代价**：S（~40 行）。
- **风险**：低；真机手测依赖（手测清单 C1 扩展：拖动滑条/拖拽排序）。
- **验收**：rust 单测断言事件序列（插值点数 ≥4、clickState 字段设置）；真机手测归档；cargo test 不减。

---

**T2-9（P3）：find 命中节点附 `actions` 数组（R4 最小形态，触发条件已满足）

- **证据**（抽验坐实）：R4 watch 条件「T8 落地后评估」已满足；`ax.rs:603` walk 已收集 `live: Vec<AXUIElement>`（抽验见 `live.push(el.clone())`），collect_matches 对命中节点调 `action_names_of()`（ax.rs 已有该函数，do_scroll 在用）零额外遍历；对标 oculos 每元素 actions / pi canPress·canFocus / agent-desktop platform_available_actions 三家同范式。
- **改法**：find 的 matches 每项加 `actions: ["AXPress","AXShowMenu",…]`（空省略——serde skip 同 children_count 模式）；**不进 snapshot 全树**（token 预算守护：全树每节点一次 AXActionNames FFI 既贵又胀）。
- **收益**：LLM observe→act 路由有据（哪些元素可按/可设值直接可见，配合 T2-7 的 settable 兜底）；act 前置校验信息前置到观察侧。
- **代价**：S。
- **风险**：低（opt 字段 + 空省略，默认路径 byte-identical）。
- **验收**：fixture 断言命中项含 actions、不命中路径不胀；基线不减。

---

**T2-10（P3）：wait/expect 稳定性采样——连续 2 次命中才算**

- **证据**（抽验坐实）：`src/channels/DesktopChannel.ts:285-313` verifyExpect——`else if (matched) return { ok: true }` 首命中即真，无 consecutive 计数（抽验原文）。对标 Peekaboo v4.0 verify：stability sampling（谓词需持续成立）+「unknown never implies success」写进核心语义。
- **改法**：verifyExpect 与 wait 的命中判定加 consecutive 计数（相邻两次 poll 均命中才成立；`gone` 语义反向同理）。~10 行。
- **收益**：瞬时命中（动画帧/加载闪现元素）不再产出假 worked；顺带把有效验证间隔拉到 ≥200ms，缓解 dense app 上 100ms 全量 re-walk 的 AX 压力（R3 附注的免费部分）。
- **代价**：XS。
- **风险**：近零（多等一个 poll 周期）。
- **验收**：单测「第一次命中后消失 → 不成立」分支绿；基线不减。

---

**T2-11（P3）：snapshot 截断诚实信号 `truncated`

- **证据**（抽验坐实）：默认模式 max_depth 边界节点 `children: Vec::new()` 静默空（`ax.rs:630-647`，抽验见非 skeleton 分支直接 Vec::new()）——与真叶子不可区分；grep 全 ax.rs/AxProvider/OutlineMapper 零 truncated/complete 信号。对标 agent-desktop **v0.7.0 专门为此发 breaking change**（预算耗尽从 TIMEOUT 错误改 `ok:true + complete:false`）——同类认定「截断必须可见」。
- **改法**：walk 遇 max_depth 边界且该节点有子节点时置 flag → snapshot 响应顶层 `truncated:true`（**仅截断时出现**——skip 形态，浅树 byte-identical；dense fixture 需基线更新并核对 INV-70 类 byte-identity 测试适用范围）。
- **收益**：LLM 知道何时该 skeleton/加深/换 root；观察诚实性与 agent-desktop v0.7 对齐。
- **代价**：S。
- **风险**：低-中（wire 新字段 + 测试基线更新；默认无截断路径零变化）。
- **验收**：dense fixture 断言 truncated:true、浅 fixture 断言字段缺席；基线不减。

### MCP 架构域（3 项）

---

**T2-12（P1）：stdin EOF → shutdown 钩子（进程生命周期补全，上游 #2002 同构修复）

- **证据**（抽验三方坐实）：① 已装 SDK 1.30.0 `dist/esm/server/stdio.js` 白盒——`start()` 只挂 `data`/`error`，无 `close`/`end` 监听（裁决官逐行核实）；② 上游 #2002（开放，v2 同病）：用户实测 Claude Code 关窗后 37 孤儿进程，官方定性「fix is two lines in start()」；③ Lasso `src/index.ts:1240-1260` 停机三路径（SIGTERM/SIGINT/exit 钩子）全部不覆盖「父进程死亡 → stdin EOF → 活跃 ChildProcess 句柄保活事件循环」场景（exit 注释自认 stdin-关闭路径依赖 exit 钩子，但 exit 只在进程真退出时触发）——CC 崩溃时正在 browse 则进程不退出，zombie reaper 1h 阈值（`SubprocessManager.ts:207` `idleThresholdMs = 3_600_000`，抽验坐实）前 Lasso+cdp-mcp 树孤儿。
- **改法**：`src/index.ts` 停机段加两行：
  ```ts
  process.stdin.on("end", () => void shutdown("stdin_eof"));
  process.stdin.on("close", () => void shutdown("stdin_eof"));
  ```
  复用现成幂等 shutdown（`shuttingDown` 防双触发）——正常 CC 退出先 SIGTERM，后到 stdin EOF 被幂等挡住，零竞态新增。SDK transport 已挂 data 监听（流 flowing 模式），EOF 后 end/close 必达。
- **收益**：CC 异常退出场景孤儿窗口 ≤1h → 即时全链收尾（走既有 Steel release / tab restore / 树杀全流程）；对齐 MCP stdio 语义共识（客户端关 stdin = 终止服务）；不等待上游 #2002（v1 线大概率不 backport）。
- **代价**：XS（2 行 + 1 用例：spawn dist/index.js、关写端、断言 N 秒内退出）。
- **风险**：近零。唯一理论顾虑「客户端故意关 stdin 但想让 server 活着」在 MCP stdio 语义不存在（上游 issue 即此定性）。
- **验收**：子进程退出用例绿；kill CC 进程真机手测归档；基线不减。

---

**T2-13（P2）：`toolManager.setMetrics(metrics)` 装配接线（T14 收尾一行）

- **证据**（抽验坐实）：`src/runtime/ToolManager.ts:77` 提供 setMetrics（注释明写「装配层 index.ts 用」），测试文件有用例；**grep 全仓生产代码零调用**（裁决官复核：仅 ToolManager.ts 定义 + ToolManager.test.ts）。对照同范式：`index.ts:999` `decider.attachMetrics(metrics)` 已接线。T14 的 wrapHandler metrics 钩子在生产装配下永远走 null 分支——admin/动态注册工具的时延/错误不入 INV-43 观测窗。
- **改法**：`src/index.ts:999` 后加一行 `toolManager.setMetrics(metrics);`（toolManager :861 已创建、metrics :998，顺序合法）。
- **收益**：T14 注入点从「仅测试可达」变真装配；admin channel 维度进 RingBuffer/doctor runtime_state 可见。
- **代价**：XS（1 行 + 断言 admin 调用后 metrics snapshot 含 admin channel 的单测，或并入现有装配用例）。
- **风险**：近零（record 签名与 wrapHandler 传参同形；「不覆盖已有」语义对单次装配无影响）。
- **验收**：装配用例断言 metrics 入窗；基线不减。

---

**T2-14（P2）：INV-79 注册违规样本 + selftest 覆盖率报告（T13 纪律闭环）

- **证据**（抽验坐实）：`scripts/inv-selftest.mjs:18` 自定纪律「新增 INV 必须注册违规样本」；VIOLATION_SAMPLES 实测无 INV-79（grep 仅 INV-63 等既有 10 条）——**纪律写入与 INV-79 落地同版本（v1.11），第一条新 INV 即违反**。INV-79 五个子检查全部静态可证伪（如删 HeadlessChannel 的 `--no-usage-statistics` 验遥测子检查），非不可证伪问题。另：69 条 INV 从未被 mutation 验证（固定 10 样本）。
- **改法**：① VIOLATION_SAMPLES 追加 INV-79 一条（如 HeadlessChannel.ts 上 `replaceAll: ["--no-usage-statistics", "--usage-statistics-off"]` 验遥测子检查由绿转红，或版本锁 `replace: ['"1.7.0"', '"0.3.0"']` 验锁片子检查）；② selftest 汇总段加非门禁输出：checker 全量 INV id vs 样本覆盖，打印 `样本覆盖 11/79`（不设阈值不 fail，守单人可持续；覆盖数只增不减由 code review 把关）。
- **收益**：纪律自洽（新 INV 有样本红转一次）；69 条未验证 pin 的缺口显性化，为后续按需补样本（优先 INV-76/68/71 外部契约类）提供工作面清单。
- **代价**：XS-S（样本一条 + 覆盖统计 ~20 行）。
- **风险**：近零（注入走临时副本既有机制；覆盖率仅报告不门禁）。
- **验收**：selftest 11/11 红转全过（含新 INV-79 样本）；覆盖率行输出；门禁不受影响。

---

## 3. 拒绝清单（未过门槛/维持原判——记 roadmap/watch/NO-GO）

以下均为四报告已自行排除或维持处置的项，裁决官复核后**全部同意维持**（无一翻案）：

| 项 | 处置 | 理由 |
|---|---|---|
| 无 shim 直连 CDP 控制面（nodriver 范式，W-B1） | **watch（v2.0）** | 2026-07 基准唯一实证有效轴，但 = 架构级换驱动层（弃 chrome-devtools-mcp 全部工具面），与 38 条 R-INT/现 MVP 价值取向冲突；Python + AGPL 与 MIT/npm 分发冲突。触发：L1+T2-1 落地后实测仍高频拦截且用户刚需 |
| CloakBrowser（W-B2） | **watch** | 12 周 13.5k+★ 热度真实，但独立基准无 headroom（= curl_cffi 平手）、darwin-arm64 管线停更 ≥2 个月（与 macOS 主力直接冲突）、二进制自定义 license。触发：darwin 复活 + license 澄清 + 基准复测有增益 |
| camoufox / browserless 第五通道 / agent-browser CLI 范式 | **NO-GO 维持** | camoufox 主维护者官宣离场（加固 NO-GO）；browserless/agent-browser 无结构性变化 |
| patchright 现轮实施 | **roadmap v2.0 维持，证据降权** | 独立基准 +1 OK vs vanilla；其有效成分（真 Chrome 二进制）Lasso 经 T1+F1 已拥有；属 Playwright 系 = automation-protocol 轴同挂 |
| StagehandChannel 重写对齐真实 REST | **不做** | v0 unstable 移动靶 + verify 原语在真实面不存在（重写即功能缩水）+ session 生命周期语义与「验证我已开页面」用例不匹配。v1.8 决策点由 T2-2 准确档案支撑 |
| sec-ch-ua header 侧注入（Network.setExtraHTTPHeaders） | **不做（等上游）** | chrome-devtools-mcp 1.7.0 仍不暴露该工具；T2-1 用 profile 对齐绕开，零新机制 |
| PruningContentFilter port（R2） | **watch 维持** | 触发条件（≥3 真实案例）未满足；T2-4 已拿更基础的转换保真杠杆 |
| SearXNG / search+scrape 融合 / fetch 升级梯（R8） | **NO-GO 维持** | firecrawl x402 融合深化反证 INV-58 边界（云端按 token 计费与本地 MCP 相反） |
| markitdown / Mojeek+Startpage 第二兜底 / You.com L3 填充 / llms.txt 自动探测 / schema 抽取 tool | **排除/watch 维持** | markitdown 本地文件域 INV-68 不变；51★ 不足为据；machine_mcp 已覆盖零配置；CC 自己拼 `.md`（自动化=越权魔法违 INV-23 精神）；CC 即 schema 执行器（加层=过度设计） |
| 7 级 scroll 瀑布 / auto-wait 默认开 / 签名 receipts+background-first / launch --cdp / 剪贴板粘贴 type 兜底 | **不做/watch（D9'）** | 档3 坐标滚动已可兜且瀑布违 R-INT；隐藏 5s 延迟负收益；multi-session 安全基建无威胁模型不跟；CDP-for-desktop 重基建 watch；剪贴板污染用户数据面 |
| SDK v2 迁移（R10/O-1） | **roadmap 2026-Q4 维持** | codemod stable + 双 era 设计成本下调，但驱动层捆 v1 + CC 侧 era 未明；W-1 验收清单已具体化（conformance 基线 / #2622 listChanged 覆写验证 / codemod dry-run / 保持旧 era 协议） |
| FastMCP 4 / UTCP / MCP Tasks 扩展（W-2） | **NO-GO / watch** | 不 FastMCP 化裁决不变；UTCP 违简单架构一句话否决；Tasks 等 CC 客户端支持 |
| R5 outputSchema / R9 doctor 拆分 / R11 agent 框架 / R3 stateId 缓存 / C-2 PostToPid / D10 预编译分发 | **维持原判** | 无新证据；doctor +67 行/轮证实「自然触碰时顺带拆」处置正确 |
| T10 doctor proxy 用例 timing-flake（W-3） | **观察（test 卫生，随手修）** | 全量并发 5169ms 失败/单跑 1648ms 通过；建议移入 timing-sensitive 分桶（vitest.workspace.ts 有先例）。不单独立项，随本轮任一触及测试的 PR 顺手移桶 |

---

## 4. 裁决

**ROUND-TUNE（14 项待调：P1×5 / P2×4 / P3×5）**

- P1：T2-1（mac_chrome 宿主对齐）/ T2-3+T2-4（defuddle 双激活，同 PR）/ T2-6（档4 闭环）/ T2-7（type 兜底）/ T2-12（stdin EOF）
- P2：T2-5（freshness 补全）/ T2-8（鼠标事件质量）/ T2-13（setMetrics 接线）/ T2-14（INV-79 样本）
- P3：T2-2（档案注释卫生）/ T2-9（find actions）/ T2-10（稳定性采样）/ T2-11（truncated 信号）

轮次特征：本轮 14 项全部是**实施层尾巴**（装配接线遗漏 / 链尾诚实性 / 事件物理质量 / 已装依赖利用度），零架构项、零范围项、零新依赖——与 §1 四维总评一致（选型/架构/范围三轮域审后已稳定收敛，实施是唯一活跃维度）。这符合最优性循环的健康收敛轨迹：若下一轮实施尾巴清偿后无新量级发现，循环应自然终止于 ROUND-CLEAN。

---

## 附 5：裁决官抽验记录（拒采信无证据项的执行记录）

| 声称 | 抽验方法 | 结果 |
|---|---|---|
| SDK 1.30.0 不监听 stdin close/end | 读 node_modules dist/esm/server/stdio.js 源码 | **坐实**：start() 仅 `this._stdin.on('data')` + `on('error')` |
| Lasso 停机无 stdin 路径 | 读 src/index.ts:1180-1260 | **坐实**：仅 SIGTERM/SIGINT/exit 三钩子；exit 注释自认盲区 |
| zombie 1h 阈值 | grep SubprocessManager.ts | **坐实**：`idleThresholdMs = 3_600_000`（:207） |
| defuddle 空 URL 零 extractor | 本地 node 实测（项目内 .mjs probe，defuddle/node 入口） | **坐实**（报告表述精确校正：`new URL('')` 在 registry:211 抛、内部 catch:228 吞掉返 null——「必抛→catch→零激活」与源码一致；顶层调用不崩，Lasso 现状是静默休眠而非报错） |
| separateMarkdown GFM 表格 / 裸 turndown 丢表格 / 相对链接绝对化 | 同上 probe 三 fixture 实测 | **坐实**：`"\| a \| b \|\n\| --- \| --- \|..."` vs `"a\n\nb\n\n1\n\n2"`；`[x](https://news.ycombinator.com/item?id=1)` |
| machine_mcp 无 freshness / 调用点四字段 / DDG 无 df= | grep + 读 MachineMcpSearchChannel.ts / search.ts:610-625 / extract.ts:55-80 | **坐实**（三处全核） |
| 档4 推断即 worked + rust 未 dispatch | 读 ScreenshotVlmProvider.ts:150-215 + index.ts:555-570 | **坐实**：worked + 空 actions + M0.5b 注释 + `private readonly rust: RustBridge` 构造注入 |
| type 死胡同三环 | 读 ax.rs:460-510 / apple-script-whitelist.ts:45-58 / CGEventProvider.ts:170-235 | **坐实**：单路径 AXSetValue；白名单 9 动作无 type；normalize 六分支无 type 返 null |
| wait 首命中即真 | 读 DesktopChannel.ts:280-315 | **坐实**：`else if (matched) return { ok: true }` |
| snapshot 截断不可区分 | 读 ax.rs:595-650 | **坐实**：非 skeleton 边界 `Vec::new()` 静默；live 收集在案（C2-4 前提） |
| cgevent 无 clickState/插值 | grep cgevent.rs:344-435 | **坐实**：零 sleep/Duration/clickState；drag 单事件 |
| setMetrics 生产零调用 | grep 全仓 src/ | **坐实**：仅定义（ToolManager.ts:77）+ 测试调用 |
| INV-79 无样本 | grep inv-selftest.mjs | **坐实**：VIOLATION_SAMPLES 10 条无 INV-79；纪律注释 :18 在案 |
| windows profile 硬编码装配 | grep windows_chrome_120 | **坐实**：index.ts:428 主装配（:610 是日志串、tools/*.ts 是用户可选 schema 默认——改动面以 :428 为主） |
| defuddle 调用点 URL 在作用域 | 读 fetch-url.ts / BrowseChannel.ts:865-875 | **坐实**：rawUrl 与 parsed.url 均在作用域 |
| BrowseChannel 陈旧注释 / Stagehand 注释漂移 | 读 BrowseChannel.ts:15-22,123-133 / StagehandChannel.ts:5-15 | **坐实**：PerformanceObserver/「非 REST 客户端」表述与 v1.11 现实脱节 |
| browser E1（UA↔client hints OS 矛盾） | 未在本环境复现（需真跑 Chrome）；机制论证采信 | **机制成立**：`--user-agent` 不影响低熵 client hints 是 Chrome 已知行为（hints 由浏览器实际状态生成，仅 CDP Network 层可改）；E1 数据与机制自洽，且 StealthEngine.ts:53-57 自记无 header 注入机制佐证「profile 对齐是唯一现架构修法」。采信（唯一非本官亲测的 P1 证据，但三方互证） |
