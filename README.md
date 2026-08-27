<h1 align="center">Lasso</h1>

> Claude Code 的「全交互对外抓手」—— 搜、抓网页、抓登录态页、控桌面，一句话全包。
> 牛仔套索，套住任何界面。

<p align="center">
  <img src="https://img.shields.io/npm/v/lasso-mcp">
  <img src="https://img.shields.io/badge/license-MIT-green">
  <img src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

**给 Claude Code 装一次，以后搜东西、抓网页、抓登录态页、控桌面都是一句话。** 每周都要搜几次、抓几篇、点几下桌面 app，又不想为每件事单独装一个工具——这里只装一次，全交给 Claude。

与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：「所有图像操作归一个 MCP」↔「所有外部交互归一个 MCP」。

<div align="center">

**简体中文** | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

## 目录

- [你说一句话，得到什么](#你说一句话得到什么)
- [💰 费用一览](#-费用一览)
- [60 秒上手](#60-秒上手)
- [能帮你做什么](#能帮你做什么)
- [安装](#安装)
- [配置详解](#配置详解)
- [隐私与安全](#隐私与安全)
- [故障排查](#故障排查)
- [适合谁 / 不适合谁](#适合谁--不适合谁)
- [支持作者](#支持作者)
- [License](#license)

---

## 你说一句话，得到什么

| 你说 …… | 你得到 |
|---|---|
| 「搜一下 rust async 生态最新动态」 | 结构化搜索结果（某家临时挂掉自动换下一家，你无感） |
| 「搜最近一周 Claude Code 的更新」（v1.11） | 按 `freshness=week` 过滤的时效结果——不用往查询词里手写日期 |
| 「claude-code 最新版本号是多少」（v1.16） | 官方 feed 最新条目（发布即推送，不等搜索索引；给一个 RSS/Atom 地址即可） |
| 「抓一下 github.com 首页文字」 | 干净正文（自动剥掉导航 / 广告 / 冗余，省 30–70% 字数；20 多个高频站点走专用抽取器、表格不丢结构——v1.12） |
| 「打开我已登录的 Jira 看看待办」 | 登录态页面快照（复用你本机 Chrome，2FA 你自己解） |
| 「这个链接打不开了，找找存档」 | 互联网档案馆最近一份快照 |
| 「把 Finder 当前窗口的文件列出来」 | 桌面上的窗口和控件列表（语义树，非截图；树被截断会明说 `truncated:true`——v1.12） |
| 「点一下那个新建文件夹按钮」「在搜索框里输入 XX」（v1.11） | 桌面动作真实执行（AXAPI 语义点击/输入 + 结果验证；canvas/Electron 自动降级坐标点击） |
| 「把这一页截个整页长图」「存成 PDF」 | 落盘的文件路径（不会把一大坨图片数据塞进对话） |
| 「这个页面加载了哪些第三方跟踪」 | 资源列表 + 跟踪域名计数 |
| 「列一下我现在能控的所有窗口和网页」 | 一个统一清单（网页和桌面窗口都在里面） |
| 「把系统深色模式关掉」 | 自动点按 / 输入 / 快捷键（带结果验证，做完了会确认） |
| 「直接取这个 JSON 接口的返回值」 | 原始字节（最快最省） |
| 「这个站好像有点反爬，试试看」 | `browse_headless` 自带反检测（过基础 bot 检测），很多站点直接能抓，无需配置 |
| 「这个站有 Cloudflare 我抓不动」 | 云端 Chrome 反爬——**Steel 自托管（免费）** 或 browserbase/stagehand（付费，默认关） |
| 「Lasso 现在配好了吗？」 | 一份健康自检报告（告诉你哪里没配好） |

> 你不用记任何能力名，直接说你想干什么，Claude 自己挑最合适的方式完成。

---

## 💰 费用一览

Lasso 本体**完全免费 + MIT 开源**。每一项能力到底要不要花钱，一张表说清：

| 能力 | 费用 | 说明 |
|---|---|---|
| Lasso 本体（MCP server + 全部核心能力） | ✅ 免费 | MIT 开源，永远免费 |
| 搜索（机器智谱 MCP 复用 + Brave） | ✅ 通常零配置 | 机器已配智谱 web-search-prime MCP 即自动复用（主路径，无需任何搜索 key）；Brave 为可选付费计划含 $5/月额度（2026-02 起免费档取消）；Lasso 还自带免费实搜兜底，一家不配也有搜索。v1.17 起 Lasso 不再支持自有智谱直连 key（`ZHIPU_API_KEY` 已退役） |
| 抓公开页 / 截图 / PDF / 网络审计 / 抓原始字节 / 本地私有搜索（v1.17：历史+文件） | ✅ 免费 | 本地运行，无 key 无付费 |
| 抓登录态页面（复用本机 Chrome） | ✅ 免费 | 本地运行，无 key 无付费 |
| 控桌面（macOS / Windows / Linux） | ✅ 免费 | 本地构建运行，仅需系统授权；**可选** Apple 开发者账号 \$99/年做签名持久授权（不签名也能用，只是每次重授权） |
| 云浏览器 · 自托管 Steel（v1.6 新） | ✅ 免费 | 本地 Docker 跑 Steel（Apache-2.0 开源），**零 per-session 费 + cookie 不出本地**；需 `LASSO_ALLOW_CLOUD_BROWSER=true` + `STEEL_ENDPOINT=http://localhost:3000` |
| 云浏览器 · 托管型（browserbase / stagehand） | ⚠️ 付费，默认关 | browserbase 试用后按量付费；stagehand 是程序化实验通道（无 MCP 工具入口）；**不配不花钱** |
| `browse_headless` 反检测（v1.5 新） | ✅ 免费 | 默认注入 16 路反检测（UA / webdriver / webgl 等），很多基础 bot 检测直接过 |

> 一句话总结：**只要不开托管型云浏览器（browserbase/stagehand），Lasso 全程 0 成本**——搜索有免费额度够日常用，Steel 自托管也是免费的。

---

## 60 秒上手

### 30 秒｜一行接入（零配置）

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

重启 Claude Code → 输入 `/mcp` → 看到 `lasso ✓ Connected` 就装好了。**安装命令不带任何 key**——下一档再说配置。

### 30 秒｜不配任何东西，已经能干这些

装完就能用，一个 key 都不用配（这是**第一档：零配置**）：

- 抓任何**公开网页**的文字、转成干净正文
- **截整页长图**、**存 PDF**，返回文件路径
- 看**一个页面加载了哪些第三方跟踪**
- 直接取 JSON 接口或文件的**原始返回**
- 控制 macOS 原生 app（Finder / Mail / 系统设置等，需在系统设置里勾一下授权）

> 💡 **搜索默认零配置可用**：如果你机器的 `~/.claude.json` 已经配过智谱 `web-search-prime` MCP，Lasso 启动时自动检测复用——搜索直接能用，不需要配任何搜索 key（v1.17 起这是唯一受支持的智谱接入方式）。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是不是 `pass` 就知道。

第一份产出——直接对 Claude 说：

> 「抓一下 example.com 的文字，转成 markdown」

### 想要更多？（都在[配置详解](#配置详解)）

- **搜东西** → 通常零配置（机器已配智谱 MCP 即可）；想加第二源再配 Brave key
- **抓登录态页** → 跑一次 `lasso launch-chrome`
- **控 macOS 桌面** → 跑一次 `lasso doctor` 授权

key 怎么申请、免费额度多少 → [**Key 配置指南**](./doc/KEY-GUIDE.md)。

---

## 能帮你做什么

按你**想干什么**分组，不按工具名。每组都是一句话进、一句话出。

### 搜一下

> 你：「搜一下 X」 → 结构化搜索结果

默认优先复用机器的智谱 MCP（中文主力，零配置），可选再配 Brave 做多源（Bing 与智谱直连两个死层均已移除，历史配置键保留但会被静默忽略）。**任一家临时限流或挂掉，自动切下一家，你无感**。某家免费额度用完也不影响整体。

> 搜完想**顺手拿正文**：说「搜索并带 3 条正文」（`content_blocks: 1-5`，v1.17）——拿到蓝链后立刻并发抓 top N 页面正文，按你的查询词**裁剪到 ~6k 字符**（导语必留、关键词段优先），一步拿到「链接 + 能直接读的内容」。抓不到的条目**如实标注**（`fetch_failed` / `not_html`），蓝链照给，你或 AI 再决定要不要开浏览器补。零付费依赖，不起浏览器。

要查**新闻、版本动向**这类时效内容，直接说「搜最近一周 / 最近一个月的 X」——自动带时效过滤（day / week / month / year，v1.11），不用往查询词里手写日期。

### 搜你电脑里的东西（v1.17 新）

> 你：「我最近看过哪些关于 X 的页面」 / 「本地哪些文件提到 X」 → 本地私有搜索

`search_local` 直查你本机的 **Chrome 浏览历史**（多 Profile 都扫）和 **Spotlight 文件索引**（mdfind）——不出网、不碰云。隐私红线内置：**只返回标题 / 链接 / 时间 / 标题匹配片段，永不全量导出页面内容**，单次最多 50 条，对源库只读。Apple Notes 全文检索暂未开放（诚实返回「未实现」而不是装作查过了）。

### 抓公开页（不用登录）

> 你：「抓 example.com 的文字」 → 干净正文，三种粒度可选

自动剥掉导航条、广告、侧边栏等冗余，**省 30–70% 字数**（也更省钱）。GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium 等 **20 多个高频站点走专用抽取器**，表格、数学公式这些结构也不丢（v1.12）——正文里的链接都是完整可点的绝对地址。要带引用角标（适合做调研、喂给 RAG）也能一句话切换。

> 读完想**就地续操作**（点按钮 / 填表单）：说「抽取时带上交互句柄」（`include_refs`，v1.17）——markdown 末尾附一张 `[r1] button "提交"` 式句柄表（正文本身零标记），之后「点 r1」「往 r2 填 X」直接按句柄定位，不用再跑整页快照。页面变了句柄会**诚实失效**（返回 didnt + 提示重新抽取，不瞎猜不自动重试）。

> **v1.5 起，`browse_headless` 默认开启反检测**（伪装 UA / 抹除 `navigator.webdriver` / 伪造 webgl、plugins、codecs 等共十几路）。**无需配置，自动生效**——很多「检测 headless」的站点现在能直接抓（v1.8 修复了一个注入静默失效的缺陷，现在是真的生效，且注入失败会在日志里如实报错）。v1.11 起反检测在**浏览器启动层**就生效：UA、视口、语言随档案统一下发，网络层 HTTP 头和页面 JS 看到的是同一套值，不再自相矛盾；v1.12 起 macOS 上默认指纹**与你的系统对齐**（不再「UA 说 Windows、机器特征招供 macOS」）。只有 Cloudflare 级重度反爬才需要走云浏览器（见下方「反爬强攻」）。想验证反检测效果？跑 `lasso doctor --stealth-check` 看 creepjs 检测对比。

### 抓登录态页（有 2FA 的也行）

> 你：「看看我 Jira 的待办」 → 登录态页面快照

复用你**本机已经登录好的 Chrome**——你自己把 2FA 解了，Lasso 接管后续抓取。支持私有的 GitHub 仓库、公司内网、付费订阅内容等。

> 🔴 **红线**：Lasso **不替你解** 2FA / 短信验证码 / CAPTCHA / 邮件魔法链接。这些必须你在本机 Chrome 里手动过一次。

> 🛡️ **高风险操作回合内确认**（v1.17）：自动操作碰到富文本编辑器、拖拽、瞬态弹窗这类高风险 pattern 时，若你的客户端支持 elicitation（Claude Code ≥ 2.1.76），会在**同一回合内**弹确认让你选「继续 / 跳过 / 终止」——选了继续才执行，不再直接中断整轮重来。老客户端行为不变（照旧安全拦截）。**确认只对当次有效**：每次命中都会再问你，不会记住授权。

### 直接抓字节（最快最省）

> 你：「GET 这个 JSON 接口」 → 原始字节

不需要渲染整页的场景，直接走原始 HTTP，比走浏览器**快约 4 倍、便宜约 4 倍**。按内容类型自动识别（JSON / 文本 / 二进制）。

### 截图 / 存档

> 你：「截个整页长图」「存成 PDF」 → 落盘文件路径

所有图片和 PDF 都**存到本地、返回路径**，不会把一大坨图片数据塞进对话浪费上下文。超大文本输出（fetch_url / network 等）超过 48 KiB 也会自动落盘，返回预览 + `@oN` 续页句柄——用 `read_text` 工具按页续读（v1.8 起经 MCP 可直接调用）。

### 看一个页面加载了什么

> 你：「这页加载了哪些第三方跟踪？」 → 资源列表 + 跟踪域名计数

自动识别页面加载的全部资源，按第三方域名聚合，方便看隐私风险、性能瓶颈。v1.11 起资源采集直接走浏览器引擎的原生网络层——**代理 / TUN 网络环境下也完整**，每条资源还带请求方法和状态码。

### 控桌面原生 app

> 你：「把深色模式关掉」「读一下 Mail 收件箱第一条」 → 自动操作（带验证）

macOS 上能控 Finder / Mail / Safari / Notes / 系统设置等任何原生 app，**Windows / Linux 也能控**（见下方诚实边界）。操作带结果验证——做完了会确认「真的做完了」，不伪造成功。

> **诚实边界**：macOS 经真实环境验证；Windows / Linux 编译和契约层都通过自检，但真机完整手测仍在推进中。**不伪造「已在 Win/Linux 上完整验证」**。

### 跨网页和桌面统一调度

> 你：「列一下我现在能控的所有东西」 → 一个统一清单

网页和桌面窗口共用一套清单——你不用区分「这是浏览器里的」还是「这是桌面上的」，Claude 自己挑要操作哪个，后续都顺着这个清单走。

### 死链救活

> 你：「这个链接 404 了」 → 互联网档案馆最近快照

去互联网档案馆（Wayback Machine）查这个链接最后一次被存档是什么样。**不会主动把活链当死链处理**，只在你说「找不到了」时才查。

### 订阅官方博客 / 追最新版本（v1.16 新）

> 你：「claude-code 最新版本是多少」「官方博客最近说了什么」 → 结构化条目列表

给它一个 RSS / Atom / JSON Feed 地址，直接拉成带标题、链接、发布时间的条目列表（约 200-500ms，零 key）。搜索索引要滞后几小时到几天，feed 是**发布即推送**——追版本号、退役时间线、官方公告这类「要新」的问题，问 feed 比搜一遍更准。官方博客的 feed 地址通常藏在页面头部的 `<link rel="alternate">` 里，让 Claude 先 `fetch_url` 一下就能发现。

> **生态搭配（推荐但可选）**：常写代码的话，建议另装 [Grep by Vercel 的官方 MCP](https://grep.app)（免费，索引 100 万+ GitHub 仓库的真实代码用法）。「别人怎么写」类问题它比任何网页搜索都准——Lasso 不内置它，各干各的活，互不重复。

### 反爬强攻（默认关）

> 你：「这个站有 Cloudflare，抓不动」 → 云端 Chrome 反爬

默认**完全关闭**。只有你明确要开、并且配了云浏览器（自托管 Steel 或托管型 browserbase/stagehand），才会启用。轻度反爬 `browse_headless` 自带反检测就能过，**只有 Cloudflare 级重度反爬才需要走云浏览器**。

- **Steel 自托管（推荐 · 免费）**：本地 Docker 跑一个开源云浏览器，零 per-session 费、cookie 不出本地。一行命令开通，见 [Key 配置指南 · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费)。
- **browserbase（托管型 · 付费）**：试用后按量付费，不想自己跑 Docker 时的备选。
- **stagehand（托管型 · 付费）**：⚠️ 程序化实验通道——配 key 只装配内部 channel，**没有 MCP 工具入口**（REST 契约未经验证；`lasso doctor` #39 `stagehand_rest_contract_probe` 专测此项）。

---

## 安装

**当前版本 v1.18.5**（更新日志见本节末尾折叠块）。

前提：Node.js ≥ 20 + Claude Code（或任何支持 MCP 的客户端）。

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

重启 Claude Code → `/mcp` → `lasso ✓ Connected`。**就这一行，不带任何 key**——装完抓页 / 截图 / PDF / 控桌面立即可用，只有搜索可选配 key（见[配置详解](#配置详解)）。

**macOS 想控桌面**：跑一次 `lasso doctor`，按提示给 `lasso-rust-helper` 勾上「辅助功能」和「屏幕录制」权限即可，doctor 会一步步引导。

<details>
<summary>📋 更新日志（v1.8 → v1.18.3，点开看每版改了什么）</summary>

- **v1.18.5**：发布包清理——**v1.18.1 ~ v1.18.4 的 npm 包误含应用域文件**（某课程抓取工程的中间产物，与 lasso 本体功能无关，已弃用），这些版本请勿安装；本版起发布面收敛为 lasso 本体，体积从 ~28MB 降回正常。
- **v1.18.4**：desktop 通道修复——① 此前 server 不是从仓库根目录启动时（比如由 Claude Code 等宿主在任意目录拉起），desktop 工具会全部报错 `rust_helper_crashed`：现在 helper 路径按安装位置自动解析，**任意目录启动都可用**；② desktop 起不来时的报错从「裸错误码」变成一眼自诊断（附实际路径、当前目录、修复办法；缺文件/指到目录/缺执行权限/文件损坏各说各话，秒级失败不空等）；③ 二进制构建时自动 ad-hoc 签名（无签名环境的机器跳过不报错）；④ 新增 GitHub CI（每次推送自动跑全量测试）。
- **v1.18.3**：Chrome 后台静默三连——① **`chrome-hide` 转后台的窗口被任何来源掀出（含上游页面自己弹的），约 1.5 秒内自动压回后台**（server 运行期间一直守着，粘滞状态跨重启保留）；想看窗口用 `chrome-show`（明示解除，不再压回）；② `chrome-hide` / `chrome-show` 新增 `--pid N`：台账缺条目时（Chrome 由旧版启动、台账被清）按进程号直达——只认 lasso 自己的 profile，你手动开的日常 Chrome 一律拒绝；③ Chrome 正忙时不再拖慢并行的其它操作。
- **v1.18.2**：长任务被自己限流的错配修复——批量任务默认直接放行（单用户本地场景没有「滥用者」，配额自控改为可选配置）；瞬态 DNS 故障不再被误判成策略拦截、不再误开长熔断；链预算超限如实报可重试；大任务溢写落盘不再挤掉近期页面。
- **v1.18.1**：批量实战五修——页面内求值失败不再被静默吞掉（如实报错）；「没有选中的 tab」状态自动自愈不再卡死；可见档冷启动探活最长等 12 秒（启动慢的机器不再误报失败）；机器缺 PDF 上游工具时前置如实报「没做」，不再白跑一遍导航。
- **v1.18.0**：静默守则落地（把「能静默就静默；需要你时才弹、用完自动收回后台」明文为运行守则，见「隐私与安全」）——① 🔴 修复 **server 退出会杀掉你的登录窗口**：Claude 会话结束 / CC 重启时，visible 登录 Chrome 此前被无差别强杀（真机三次复现实锤），现在与「用户拥有的窗口永不自动关」同款豁免；② 新增可选的**登录完成自动收窗**：`"LASSO_AUTO_HIDE_AFTER_LOGIN": true`（默认关）后不用记 `chrome-hide`——观察到登录页消失 + 等 10 秒 + 确认没人正在用，自动把窗口收进后台（拿不准就不收，`chrome-show` 随时可逆）；③ 守则句写入文档（README / KEY-GUIDE / ARCHITECTURE），新增架构不变量 INV-82 守住以上红线。
- **v1.17.2**：静默性全面审计落地（真机六维实测：焦点/窗口/Dock/音频/通知/资源）——① 修复「连你自己开的可见 Chrome」时 lasso 会**改写你第一个 tab 内容**的缺陷：现在 lasso 在你的 Chrome 里自建一个后台 tab 干活（不抢焦点、不激活），会话结束自动关掉，你的 tab 一律不动；② 修复 tab 管理的契约错配（`close_page` 参数形态），且关 tab 现在只可能落在 lasso 自己开的 tab 上（登记制，类型层面保证）；③ 隐私文档新增**静默性矩阵**（每条通道×每维打扰的实测结论，见「隐私与安全」）。
- **v1.17**：五项升级——① 智谱直连 key 退役（`ZHIPU_API_KEY` 不再消费；智谱能力由机器 web-search-prime MCP 复用唯一承载，搜索默认零配置）② `search` 新增 `content_blocks` 第二跳（搜完并发抓 top N 正文、查询相关裁剪 ~6k 字符，失败条目如实标注，零付费依赖）③ 新工具 `search_local`（Chrome 浏览历史 + Spotlight 本地私有搜索，隐私红线：只返标题/链接/时间，禁全文导出）④ 高风险操作支持回合内 elicitation 确认（老客户端零影响）⑤ `browse extract` 新增 `include_refs` 交互句柄（`[r1]` 式附录 + 按句柄点击/填写，页面变了诚实失效）。搜索结果统一带 `quality` 质量轴标注（api / scrape / stale）。

- **v1.16**：新增 `fetch_feed` 工具（RSS / Atom / JSON Feed → 结构化条目；追版本号、退役时间线、官方公告这类「要新」的问题直接问源，不再等搜索索引）+ 修复搜索缓存新鲜度缺陷（`freshness=day` 的结果此前可能被缓存成最多 7 天的陈货，现在 day 档 24 小时即过期；全源熔断时的录制回放也会按 freshness 窗口拒掉过期 fixture，不再拿陈年录像充数）。
- **v1.15**：Bing 死层彻底清除（Bing Search APIs 2025-08-11 全量退役——删代码非标注；历史 `BING_API_KEYS` 静默忽略、`lasso doctor` 提示删除）+ 无头浏览器之前新增**裸 HTTP 快探层**（API 层全挂时先用无浏览器直连抓一次搜索结果页，约 1 秒，探不到再启动无头浏览器慢路径；真机实测英文命中 20 条结果仅 1.9 秒，而无头浏览器路径 5.3 秒且被验证码挡成 0 条；百度验证码/首页壳等软挡页不伪造成功，自动升级浏览器复核）。
- **v1.14**：搜索运营事实清偿（Brave 配额账本对齐 $5 赠送额度 ≈1000 次/月、`free_only=L2` 不再把计量计费的 Brave 当免费层；Bing 配额归零）+ 英文零 Key 兜底双引擎（DDG 失败/空结果自动级联 Brave 实搜）；`lasso doctor --deep`（Brave 计划级探测，消耗 1 次额度）+ Bing 退役静态提示；KEY-GUIDE 时效标注制度（每条 key 声明自带「最后核实」日期与 90 天重核触发）。
- **v1.13**：无头浏览器语言指纹一致（HTTP `Accept-Language` 随档案下发，消除「头 zh-CN ↔ 页面 en-US」矛盾）；VLM 截图区域坐标落点修复；`desktop find` 拒绝纯 ref 查询；Steel 会话释放加 3 秒上界（Steel 停摆不再卡退出 5 分钟）。
- **v1.12**：markdown 抽取双激活（defuddle 20 余站专用抽取器 + 表格/数学保真）；macOS 默认指纹与宿主系统对齐；桌面链尾诚实化（VLM 不谎报成功 / expect 需连续两次命中 / `truncated:true` 信号）；Electron 输入框 type 自动降级；拖拽插值变可用；CC 异常退出即时收尾。
- **v1.11**：桌面从「能看」变「能点」（click/type/scroll 真实现 + 坐标鼠标 + `skeleton` 剪枝）；驱动层升 chrome-devtools-mcp 1.7.0（反检测启动级生效、默认关遥测）；搜索新增 `freshness` 时效过滤；英文查询零 Key 兜底换 DuckDuckGo；新增 `LASSO_PROXY` 出口代理。
- **v1.10**：浏览器默认静默 + 用完即关（`launch-chrome` 零窗口启动、~60 秒自动关，`--mode visible` 可回退）。
- **v1.9**：浏览器生命周期收尾（无头空闲 5 分钟自动回收、`lasso chrome-stop`、`tab_restore` 恢复原 tab 列表）。
- **v1.8**：修复全量实测暴露的 24 条缺陷（上游契约适配、截图真实落盘、`read_text` 续页等）——完整清单见 [doc/17-功能测试清单.md](doc/17-功能测试清单.md) 的「v1.8 修复记录」。

</details>

---

## 配置详解

**只有搜索需要 key，其余全部装完即用。** 按需查表：

| 你想干什么 | 要配什么 |
|---|---|
| 抓公开页 / 截图 / PDF / 看第三方资源 / 抓原始字节 / 控桌面 | **什么都不用配** |
| 搜东西 | 通常零配置（机器智谱 MCP 复用）；可选 Brave key（付费计划） |
| 搜索几乎不挂 | 再加 Brave key（付费计划含每月 $5 额度；不配也有免费兜底实搜） |
| 抓登录态页面 | 跑一次 `lasso launch-chrome` |
| 控 macOS 桌面 | 跑一次 `lasso doctor` 授权 |
| 抓有 Cloudflare 的站 | 总开关 + Steel（免费自托管）/ browserbase（付费） |

下面四个模块各给「最短能跑通」的配法，细节折叠可展开。

### 一、搜索（✅ 免费 · 唯一要 key 的模块）

**先看要不要配**：如果你机器已经配过智谱 `web-search-prime` MCP，Lasso 会**自动检测复用它的 key**，什么都不用填。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是 `pass` 就是这种情况。

**要配就两步**（可选——机器 MCP 已覆盖时完全不用配）：

```bash
lasso config init        # 创建 ~/.lasso/config.json
```

想**更稳 / 要多源扇出**再加 Brave（付费计划含 $5/月额度 ≈1000 次，需信用卡——2026-02 起免费档取消；配了挂了自动切，多个 key 逗号隔开各带额度）：

```json
{ "BRAVE_API_KEYS": "bravekey1,bravekey2" }
```

> ⚠️ **`ZHIPU_API_KEY` 已于 v1.17 退役**：智谱直连 API channel 整层删除，历史配置里的该键**会被静默忽略**（`lasso doctor` 的 `zhipu_keys_retired` 项会提示你删掉它）。智谱搜索能力现在**只**通过机器 web-search-prime MCP 复用承载（上面第一段，零配置）。

> 降级顺序：机器 MCP 复用 → Brave（配了 key 时）→ 无头浏览器实搜兜底（v1.14 起英文兜底双引擎：DuckDuckGo 失败/空结果自动再试一次 Brave 实搜；v1.15 起无头浏览器之前先加一层**裸 HTTP 快探**（约 1 秒，无浏览器直接抓搜索结果页——实测部分搜索引擎对「无浏览器」反而更不设防），探不到再启动无头浏览器慢路径）。前一个挂了自动切下一个。（Bing 源已随上游 2025-08-11 退役整层移除、智谱直连档已于 v1.17 删除；历史配置里的 `BING_API_KEYS` / `ZHIPU_API_KEY` 会被静默忽略，`lasso doctor` 会提示删除。）

key 怎么申请、免费额度多少 → [Key 配置指南 · 搜索](./doc/KEY-GUIDE.md#a-搜索)。常用命令：`lasso --version` / `lasso --help`（v1.8 起未知命令打印用法非零退出，不再静默挂起）。

### 二、抓登录态页面（✅ 免费 · 一行命令，不用 key）

**首次使用（要登录一次，三步）**：

```bash
lasso launch-chrome --mode visible   # 1. 弹出窗口（默认 hidden 是零窗口，没法登录）
#    2. 在这个窗口里登录你的账号（2FA 自己解）
lasso chrome-hide                    # 3. 登录完转回后台静默（登录态留在 profile）
```

嫌第 3 步也要记？在 `~/.lasso/config.json` 配 `"LASSO_AUTO_HIDE_AFTER_LOGIN": true`（v1.18，默认关）：Claude 会话在跑的时候，它会自己观察到登录页消失、再等 10 秒确认你登录完，**自动把窗口收进后台**（拿不准就不收，只会漏收不会误收；想再看随时 `chrome-show`）。这个登录窗口现在也不会被 Claude 会话重启杀掉（v1.18 修复——之前 server 一退出窗口就没了）。

第 3 步报「找不到台账目标」时（Chrome 由旧版 lasso 启动、台账被清）：`lasso chrome-hide --pid <进程号>` 按进程号直达（`lasso chrome-show --pid <进程号>` 同）——只认 lasso 自己 profile 的 Chrome，你手动开的日常 Chrome 一律拒绝。

之后**一行命令**就行——默认零窗口静默档直接继承上次的登录态：

```bash
lasso launch-chrome
```

以后对 Claude 说「打开我已登录的 Jira」就行。想再看窗口随时 `lasso chrome-show`（可逆，登录态不动）。

- 默认**零窗口静默**干活、不抢焦点、永远静音；想看着它干加 `--mode visible`
- 用完**约 60 秒自动关**，不用记着收尾；手动关随时 `lasso chrome-stop`
- 它在你 Chrome 里开的 tab，任务后说 `admin {action:"tab_restore", reason:"完成"}` 恢复原列表（server 退出也会自动做）

> 🔴 **红线**：2FA / 验证码 / CAPTCHA——Lasso 不替你解，你在窗口里手动过一次。

<details>
<summary>细节：profile 复用 / 端口被占 / 调参 / 静默边界</summary>

- v1.8 起默认用 Lasso 独立 profile（Chrome 136+ 禁止对默认 profile 开调试端口，老办法会秒退）；复用已有 profile 用 `lasso launch-chrome --profile <目录>`。
- 启动后自动探活调试端口，Chrome 没起来 / 端口被占会明确报错，不假报成功。
- 自动关阈值：`LASSO_LAUNCH_IDLE_MS`（默认 60000；`300000` 回退 5 分钟；`0` 禁用）。单次长任务放行：`--idle-ms 3600000`。
- 登录后自动收窗：`LASSO_AUTO_HIDE_AFTER_LOGIN`（默认 false；开启后只在「见过登录页 → 登录页消失 → 等 10 秒 → Claude 没在用」四关全过时才收，收错方向保守——拿不准就不收）。等待时长 `LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS`（默认 10000）。只在 server 会话运行期间生效（CLI 单独 `launch-chrome` 没有调度器，仍走手动 `chrome-hide`）。
- 无头浏览器空闲 5 分钟自动回收（`LASSO_HEADLESS_IDLE_MS` 可调/禁用）。
- 诚实边界：单独跑 `lasso launch-chrome`（不经 server）没有 idle 自动关，出口是 `chrome-stop`；它起的 Chrome 在 Dock / 任务栏会多一个图标（浏览器有头进程的注册行为，lasso 控制不了），要零图标用 `browse_headless`；`browse_logged_in` 连**你自己开的可见 Chrome** 时会在你的 Chrome 里临时开一个后台 tab 干活（不抢焦点不发声，结束自动关，v1.17.2 起你的 tab 一律不被改写）——但你的 Chrome 本身不静音（lasso 不改写你的浏览器参数），浏览到自动播放页面会真出声；`desktop` 模拟真人键鼠，设计上就占用物理键鼠，没有静默形态。
- chrome-stop 只关 Lasso 自己起的、验证过归属的 Chrome，不会误伤你手动开的浏览器。
- `chrome-hide` / `chrome-show` 同样只动台账在案的 Chrome（按 pid 定向，永不碰你手动开的浏览器）；hide 只隐藏窗口，进程/登录态/CDP 全保留。台账缺条目时按 `--pid N` 直达（见上文；归属不满足会明确拒绝）。
- hide 是**粘滞**的（v1.18.3）：server 运行期间，已 hide 的窗口无论被什么来源掀出（上游页面自己弹的、系统焦点切换），约 1.5 秒内自动压回后台；想看窗口用 `chrome-show`（明示解除，不再压回）。粘滞状态跨重启保留，下次 server 启动继续接管。

</details>

**详见** → [Key 配置指南 · 登录态浏览](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key)。

### 三、控桌面（✅ 免费 · 授权一次，不用 key）

- **macOS**：跑 `lasso doctor`，按提示给 `lasso-rust-helper` 勾「辅助功能」+「屏幕录制」
- **Windows**：第一次桌面操作时系统弹授权窗，点「允许」
- **Linux**：装辅助功能接口（GNOME/MATE 默认有；没有就 `sudo apt install at-spi2-core`）

> 诚实边界：macOS 经真实环境验证；Windows / Linux 编译和契约层过自检，真机完整手测推进中，不伪造「已完整验证」。

**详见** → [Key 配置指南 · 桌面控制](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key)。

### 四、云浏览器（默认关 · 只有重度反爬才需要）

轻度反爬 `browse_headless` 自带反检测就能过——**用不上就别配**。要过 Cloudflare 级反爬才开，需同时满足总开关 + 一条通道：

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "STEEL_ENDPOINT": "http://localhost:3000"
}
```

- **Steel 自托管（推荐 · 免费）**：Docker 一行启动 `docker run -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser`，零 per-session 费、cookie 不出本地
- **browserbase 托管（付费）**：换配 `"BROWSERBASE_API_KEY": "你的key"`，不想跑 Docker 的备选
- ⚠️ stagehand：程序化实验通道，无 MCP 工具入口，别指望它抓页面

**怎么申请 key、Steel 完整开通步骤** → [Key 配置指南 · 云浏览器](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁)。

<details>
<summary><b>高级调优（可选，普通用户不用展开）</b></summary>

日常使用**完全不用管**下面这些。只在特殊场景才需要，且大多可以通过 `lasso config init` 写进 `~/.lasso/config.json` 或设环境变量来覆盖（环境变量优先级高于配置文件，方便临时替换）：

- 改登录态 Chrome 的调试端口（默认 `9222` 被占用时）
- 换缓存 / 状态文件的存放位置
- 限制只用免费搜索源
- 放行公司内网 / 特殊代理网段
- 给登录 cookie 加一个自己的加密口令（不设则走 macOS 钥匙串）
- 落盘搜索结果快照（做回归测试用）
- 调无头浏览器空闲自动回收时间（`LASSO_HEADLESS_IDLE_MS`，默认 5 分钟；配 `0` 禁用）
- 调 launch-chrome 起的 Chrome「用完即关」时间（`LASSO_LAUNCH_IDLE_MS`，默认 60 秒；配 `300000` 回退 5 分钟、`0` 禁用）或切回可见启动（`LASSO_LAUNCH_MODE=visible`）
- 给浏览器配出口代理（`LASSO_PROXY`，如 `http://127.0.0.1:7890`；**只影响无头浏览器和 Steel 云浏览器，登录态 Chrome 的出口永远保持原样**——v1.11）
- 设 Steel 自托管云浏览器端点（`STEEL_ENDPOINT`，如 `http://localhost:3000`；需同时开 `LASSO_ALLOW_CLOUD_BROWSER=true` 才启用）

完整变量清单和默认值见 [Key 配置指南 · 高级调优](./doc/KEY-GUIDE.md#e-高级调优可选全不配)。**Surge / Clash 等 TUN 代理网络（fake-ip，`198.18.0.0/15`）与 `127.0.0.1`（本机 Chrome CDP 调试端口用）都已内置放行**，无需额外配置——这是设计行为，不是漏配。

> **向后兼容**：如果你以前用 `claude mcp add -e KEY=VAL` 装过，那些环境变量**仍然生效**，且会**覆盖**配置文件。配置文件只是新增的一条更友好的途径，不废除老办法。

</details>

---

## 隐私与安全

你的数据是你的。

> 🤫 **运行守则**（v1.18 起明文）：能后台静默干的就静默干——零窗口、不抢焦点、永远静音；确实需要你时（登录、2FA、高风险确认）才弹一次，你处理完它自动转回后台静默，不需要你记着收尾。

- **登录 cookie 永不导出**，除非你显式同意并加密落盘。Lasso 不会把你的登录态偷偷传到任何地方。
- **桌面操作日志只在本地**，零远程上报。Lasso 不向任何第三方上报你的操作。
- **云浏览器默认关**，必须你**明确确认两次**（总开关 + key）才会启用。没配就等于没有这个能力。
- **不解 2FA / CAPTCHA / 验证码**（红线）。这些永远需要你本人在本机浏览器里手动过一次。
- **不让陌生人随便碰你的内网服务**——访问内网默认被拒，保护你的内部服务不被随意触达；Surge / Clash 等 TUN 代理网络已内置放行，无需额外配置。
- **搜索结果默认不落盘**，只有你主动开启录制模式才会存一份快照（用于回归测试）。

### 静默性矩阵（v1.17.2 真机实测）

「静默」= 干活时你不被打扰。下表是六维打扰面（抢焦点 / 弹窗口 / Dock 图标 / 出声 / 系统通知 / 资源占用）逐格真机实测的结论（macOS 12 + Chrome 150，2026-08）：

| 你用的能力 | 抢焦点 | 弹窗口 | Dock 图标 | 出声 | 通知 | 资源 |
|---|---|---|---|---|---|---|
| `search` / `fetch_url` / `fetch_feed` / `search_local` | 无 | 无 | 无 | 无 | 无 | 极低（纯网络/本地查询，CPU 峰 <3 秒即落） |
| `browse_headless`（无头浏览） | 无 | 无 | 无 | 无（恒静音） | 无 | 中（存活期约 400MB，闲置 5 分钟自动回收） |
| `launch-chrome`（默认 hidden 档） | 无 | 无 | **多一个 Chrome 图标**（清不掉，见下方边界） | 无（恒静音） | 无 | 中（server 里约 60 秒不用自动关） |
| `launch-chrome --mode visible` | **会**（弹出窗口，你主动选的） | 会 | 会 | 无（也恒静音） | 无 | 中 |
| `browse_logged_in` 连**你自己开的 Chrome** | 无（逐操作实测） | 无 | 无新增 | **你的 Chrome 不静音**（lasso 不改写你的浏览器） | 无 | 低 |
| `desktop` 控桌面 | **设计上占用键鼠** | — | — | — | 首次配置授权弹窗 | 极低 |

连你自己 Chrome 的三条边界（v1.17.2 起）：① lasso 在你的 Chrome 里自建**后台 tab** 干活，不抢焦点、不激活窗口，会话结束自动关——你的 tab 一律不被改写（旧版会改写第一个 tab 的内容，已修复）；② 你的 Chrome 不静音——lasso 浏览到自动播放页面会真出声（要静音自己启动 Chrome 时加 `--mute-audio`）；③ lasso 操作期间那个后台 tab 会「自认为有焦点」（浏览器调试协议的仿真，不影响你正在用的前台应用）。

---

## 故障排查

**遇到任何问题，第一步永远是 `lasso doctor`。** 它会自检并告诉你哪里没配好。

| 现象 | 你该怎么做 |
|---|---|
| macOS 桌面控制不工作 | 「系统设置 → 隐私与安全 → 辅助功能 / 屏幕录制」里勾上 `lasso-rust-helper`（`lasso doctor` 会引导你） |
| 抓登录态页面失败 | 在你本机 Chrome 里手动登录一次（2FA 也手动解），再说「打开我已登录的 X」 |
| 存 PDF 失败 | 改说「把这一页截个整页长图」即可 |
| 搜索一直没结果 | 跑 `lasso doctor` 看 `machine_search_mcp` / `brave_keys`；Brave key 是否过期或额度用完；机器 MCP 复用 + 免费实搜兜底本身零配置可用 |
| 链接打不开 | 改说「这个链接找不到了，找找存档」，去查互联网档案馆 |
| 提示要内网访问被拒 | 确认 URL 没写错；TUN 代理网络已默认放行，其他内网需手动允许 |
| 想验证反检测效果 | 跑 `lasso doctor --stealth-check`，会驱动 creepjs 检测页对比基线（可选，不影响日常使用） |

完整 FAQ 与调试技巧见 [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md)。

---

## 适合谁 / 不适合谁

**适合**

- **Claude Code 重度用户**——每周都要搜、抓、控桌面，不想为每件事单独装一个 MCP
- **做调研 / 写报告 / 搞数据的人**——搜一搜、抓干净正文、死链救活，一条龙
- **搭 RAG / 喂知识库的人**——网页转成干净正文、带引用角标、省字数省钱
- **做自动化 / DevOps 的人**——控 macOS 原生 app、抓登录态内部面板
- **经常抓登录态页面的人**——复用本机 Chrome 会话，不用在配置里重存一遍账号密码

**不太适合**

- **不用 Claude Code 或其他 MCP 客户端的人**——Lasso 是 MCP 服务，需要一个 MCP 客户端来驱动它
- **只要单一能力、而且已经搭好专方案的人**——全家桶对你可能冗余
- **想绕过 2FA / CAPTCHA 的人**——红线，做不到，也不会做

---

## 支持作者

如果 Lasso 帮到你，欢迎请作者喝杯咖啡 ☕

<div align="center">

微信 | 支付宝
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="微信赞赏"> | <img src="doc/support-alipay.jpg" height="200" alt="支付宝赞赏">

</div>

或 ⭐ [Star 这个仓库](../../stargazers)、[提 Issue](../../issues) / [发 PR](../../pulls) —— 都是对作者的鼓励与支持。

---

## 更多文档

- 想看深度架构？见 [功能架构](doc/08-media-interact-功能架构.md)
- 想看版本路线？见 [实施排期](doc/09-media-interact-实施排期.md)
- 想看 key 获取？见 [Key 配置指南](doc/KEY-GUIDE.md)

## License

**MIT** © wangdong233。桌面辅助进程与浏览器引擎依赖均选 MIT / Apache-2.0，企业可商用。

> 想看内部架构、设计原则、跨平台边界、开发命令？见 [ARCHITECTURE.md](./ARCHITECTURE.md) 与 [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md)。

<p align="center">
  <sub>Built for everyone who'd rather <strong>say it</strong> than <strong>script it</strong>.</sub><br>
  <sub>装一次，搜 / 抓 / 登录态抓 / 控桌面都是一句话。</sub>
</p>
