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
| 搜索（智谱 + Brave） | ✅ 智谱免费起步 | 智谱按 token 计费（新用户有赠送额度），机器已配智谱 MCP 则零配置可用；Brave 现为付费计划含 $5/月额度（2026-02 起免费档取消）；Lasso 还自带免费实搜兜底，一家不配也有搜索 |
| 抓公开页 / 截图 / PDF / 网络审计 / 抓原始字节 | ✅ 免费 | 本地运行，无 key 无付费 |
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

> 💡 **搜索也可能零配置可用**：如果你机器的 `~/.claude.json` 已经配过智谱 `web-search-prime` MCP，Lasso 启动时自动检测复用，连 `ZHIPU_API_KEY` 都不用单独配——搜索直接能用。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是不是 `pass` 就知道。

第一份产出——直接对 Claude 说：

> 「抓一下 example.com 的文字，转成 markdown」

### 想要更多？（都在[配置详解](#配置详解)）

- **搜东西** → 填一个智谱 key（机器已配智谱 MCP 则不用）
- **抓登录态页** → 跑一次 `lasso launch-chrome`
- **控 macOS 桌面** → 跑一次 `lasso doctor` 授权

key 怎么申请、免费额度多少 → [**Key 配置指南**](./doc/KEY-GUIDE.md)。

---

## 能帮你做什么

按你**想干什么**分组，不按工具名。每组都是一句话进、一句话出。

### 搜一下

> 你：「搜一下 X」 → 结构化搜索结果

默认走智谱（中文主力），可再配 Brave 做多源（Bing 上游已关停，配置键保留自动跳过）。**任一家临时限流或挂掉，自动切下一家，你无感**。某家免费额度用完也不影响整体。

要查**新闻、版本动向**这类时效内容，直接说「搜最近一周 / 最近一个月的 X」——自动带时效过滤（day / week / month / year，v1.11），不用往查询词里手写日期。

### 抓公开页（不用登录）

> 你：「抓 example.com 的文字」 → 干净正文，三种粒度可选

自动剥掉导航条、广告、侧边栏等冗余，**省 30–70% 字数**（也更省钱）。GitHub / Reddit / Hacker News / Wikipedia / Substack / Medium 等 **20 多个高频站点走专用抽取器**，表格、数学公式这些结构也不丢（v1.12）——正文里的链接都是完整可点的绝对地址。要带引用角标（适合做调研、喂给 RAG）也能一句话切换。

> **v1.5 起，`browse_headless` 默认开启反检测**（伪装 UA / 抹除 `navigator.webdriver` / 伪造 webgl、plugins、codecs 等共十几路）。**无需配置，自动生效**——很多「检测 headless」的站点现在能直接抓（v1.8 修复了一个注入静默失效的缺陷，现在是真的生效，且注入失败会在日志里如实报错）。v1.11 起反检测在**浏览器启动层**就生效：UA、视口、语言随档案统一下发，网络层 HTTP 头和页面 JS 看到的是同一套值，不再自相矛盾；v1.12 起 macOS 上默认指纹**与你的系统对齐**（不再「UA 说 Windows、机器特征招供 macOS」）。只有 Cloudflare 级重度反爬才需要走云浏览器（见下方「反爬强攻」）。想验证反检测效果？跑 `lasso doctor --stealth-check` 看 creepjs 检测对比。

### 抓登录态页（有 2FA 的也行）

> 你：「看看我 Jira 的待办」 → 登录态页面快照

复用你**本机已经登录好的 Chrome**——你自己把 2FA 解了，Lasso 接管后续抓取。支持私有的 GitHub 仓库、公司内网、付费订阅内容等。

> 🔴 **红线**：Lasso **不替你解** 2FA / 短信验证码 / CAPTCHA / 邮件魔法链接。这些必须你在本机 Chrome 里手动过一次。

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

### 反爬强攻（默认关）

> 你：「这个站有 Cloudflare，抓不动」 → 云端 Chrome 反爬

默认**完全关闭**。只有你明确要开、并且配了云浏览器（自托管 Steel 或托管型 browserbase/stagehand），才会启用。轻度反爬 `browse_headless` 自带反检测就能过，**只有 Cloudflare 级重度反爬才需要走云浏览器**。

- **Steel 自托管（推荐 · 免费）**：本地 Docker 跑一个开源云浏览器，零 per-session 费、cookie 不出本地。一行命令开通，见 [Key 配置指南 · Steel](./doc/KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费)。
- **browserbase（托管型 · 付费）**：试用后按量付费，不想自己跑 Docker 时的备选。
- **stagehand（托管型 · 付费）**：⚠️ 程序化实验通道——配 key 只装配内部 channel，**没有 MCP 工具入口**（REST 契约未经验证；`lasso doctor` #39 `stagehand_rest_contract_probe` 专测此项）。

---

## 安装

**当前版本 v1.13.0**（更新日志见本节末尾折叠块）。

前提：Node.js ≥ 20 + Claude Code（或任何支持 MCP 的客户端）。

```bash
claude mcp add lasso -- npx -y lasso-mcp
```

重启 Claude Code → `/mcp` → `lasso ✓ Connected`。**就这一行，不带任何 key**——装完抓页 / 截图 / PDF / 控桌面立即可用，只有搜索可选配 key（见[配置详解](#配置详解)）。

**macOS 想控桌面**：跑一次 `lasso doctor`，按提示给 `lasso-rust-helper` 勾上「辅助功能」和「屏幕录制」权限即可，doctor 会一步步引导。

<details>
<summary>📋 更新日志（v1.8 → v1.13，点开看每版改了什么）</summary>

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
| 搜东西 | 一个智谱 key（免费申请；机器已配智谱 MCP 则连这都不用） |
| 搜索几乎不挂 | 再加 Brave key（付费计划含每月 $5 额度；不配也有免费兜底实搜） |
| 抓登录态页面 | 跑一次 `lasso launch-chrome` |
| 控 macOS 桌面 | 跑一次 `lasso doctor` 授权 |
| 抓有 Cloudflare 的站 | 总开关 + Steel（免费自托管）/ browserbase（付费） |

下面四个模块各给「最短能跑通」的配法，细节折叠可展开。

### 一、搜索（✅ 免费 · 唯一要 key 的模块）

**先看要不要配**：如果你机器已经配过智谱 `web-search-prime` MCP，Lasso 会**自动检测复用它的 key**，什么都不用填。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是 `pass` 就是这种情况。

**要配就三步**：

```bash
lasso config init        # 创建 ~/.lasso/config.json
```

```json
{ "ZHIPU_API_KEY": "你的智谱key" }
```

存盘即生效。**想更稳**再加 Brave（付费计划含 $5/月额度 ≈1000 次，需信用卡——2026-02 起免费档取消；配了任一家挂了自动切，多个 key 逗号隔开各带额度）：

```json
{
  "ZHIPU_API_KEY": "你的智谱key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2",
  "BING_API_KEYS": "bingkey1"
}
```

> 降级顺序：机器 MCP 复用 → 智谱 → Brave →（Bing 已关停自动跳过）→ 无头浏览器实搜兜底。前一个挂了自动切下一个。

key 怎么申请、免费额度多少 → [Key 配置指南 · 搜索](./doc/KEY-GUIDE.md#a-搜索)。常用命令：`lasso --version` / `lasso --help`（v1.8 起未知命令打印用法非零退出，不再静默挂起）。

### 二、抓登录态页面（✅ 免费 · 一行命令，不用 key）

```bash
lasso launch-chrome
```

第一次在这个窗口登录你的账号（2FA 自己解），**登录态之后一直复用**。以后对 Claude说「打开我已登录的 Jira」就行。

- 默认**零窗口静默**干活、不抢焦点、永远静音；想看着它干加 `--mode visible`
- 用完**约 60 秒自动关**，不用记着收尾；手动关随时 `lasso chrome-stop`
- 它在你 Chrome 里开的 tab，任务后说 `admin {action:"tab_restore", reason:"完成"}` 恢复原列表（server 退出也会自动做）

> 🔴 **红线**：2FA / 验证码 / CAPTCHA——Lasso 不替你解，你在窗口里手动过一次。

<details>
<summary>细节：profile 复用 / 端口被占 / 调参 / 静默边界</summary>

- v1.8 起默认用 Lasso 独立 profile（Chrome 136+ 禁止对默认 profile 开调试端口，老办法会秒退）；复用已有 profile 用 `lasso launch-chrome --profile <目录>`。
- 启动后自动探活调试端口，Chrome 没起来 / 端口被占会明确报错，不假报成功。
- 自动关阈值：`LASSO_LAUNCH_IDLE_MS`（默认 60000；`300000` 回退 5 分钟；`0` 禁用）。单次长任务放行：`--idle-ms 3600000`。
- 无头浏览器空闲 5 分钟自动回收（`LASSO_HEADLESS_IDLE_MS` 可调/禁用）。
- 诚实边界：单独跑 `lasso launch-chrome`（不经 server）没有 idle 自动关，出口是 `chrome-stop`；`browse_logged_in` 连**你自己开的可见 Chrome** 是「低打扰非零打扰」（macOS 平台级限制，个别操作可能抢一次焦点）——要纯静默用 hidden 档或 `browse_headless`；`desktop` 模拟真人键鼠，设计上就占用物理键鼠，没有静默形态。
- chrome-stop 只关 Lasso 自己起的、验证过归属的 Chrome，不会误伤你手动开的浏览器。

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

- **登录 cookie 永不导出**，除非你显式同意并加密落盘。Lasso 不会把你的登录态偷偷传到任何地方。
- **桌面操作日志只在本地**，零远程上报。Lasso 不向任何第三方上报你的操作。
- **云浏览器默认关**，必须你**明确确认两次**（总开关 + key）才会启用。没配就等于没有这个能力。
- **不解 2FA / CAPTCHA / 验证码**（红线）。这些永远需要你本人在本机浏览器里手动过一次。
- **不让陌生人随便碰你的内网服务**——访问内网默认被拒，保护你的内部服务不被随意触达；Surge / Clash 等 TUN 代理网络已内置放行，无需额外配置。
- **搜索结果默认不落盘**，只有你主动开启录制模式才会存一份快照（用于回归测试）。

---

## 故障排查

**遇到任何问题，第一步永远是 `lasso doctor`。** 它会自检并告诉你哪里没配好。

| 现象 | 你该怎么做 |
|---|---|
| macOS 桌面控制不工作 | 「系统设置 → 隐私与安全 → 辅助功能 / 屏幕录制」里勾上 `lasso-rust-helper`（`lasso doctor` 会引导你） |
| 抓登录态页面失败 | 在你本机 Chrome 里手动登录一次（2FA 也手动解），再说「打开我已登录的 X」 |
| 存 PDF 失败 | 改说「把这一页截个整页长图」即可 |
| 搜索一直没结果 | 检查 key 是否过期 / 额度用完；配多家（智谱 + Brave）可大幅降低失败率 |
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
