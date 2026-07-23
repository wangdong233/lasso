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
| 「抓一下 github.com 首页文字」 | 干净正文（自动剥掉导航 / 广告 / 冗余，省 30–70% 字数） |
| 「打开我已登录的 Jira 看看待办」 | 登录态页面快照（复用你本机 Chrome，2FA 你自己解） |
| 「这个链接打不开了，找找存档」 | 互联网档案馆最近一份快照 |
| 「把 Finder 当前窗口的文件列出来」 | 桌面上的窗口和控件列表（语义树，非截图） |
| 「把这一页截个整页长图」「存成 PDF」 | 落盘的文件路径（不会把一大坨图片数据塞进对话） |
| 「这个页面加载了哪些第三方跟踪」 | 资源列表 + 跟踪域名计数 |
| 「列一下我现在能控的所有窗口和网页」 | 一个统一清单（网页和桌面窗口都在里面） |
| 「把系统深色模式关掉」 | 自动点按 / 输入 / 快捷键（带结果验证，做完了会确认） |
| 「直接取这个 JSON 接口的返回值」 | 原始字节（最快最省） |
| 「这个站有 Cloudflare 我抓不动」 | 云端 Chrome 反爬（默认关，你明确要开才开） |
| 「Lasso 现在配好了吗？」 | 一份健康自检报告（告诉你哪里没配好） |

> 你不用记任何能力名，直接说你想干什么，Claude 自己挑最合适的方式完成。

---

## 💰 费用一览

Lasso 本体**完全免费 + MIT 开源**。每一项能力到底要不要花钱，一张表说清：

| 能力 | 费用 | 说明 |
|---|---|---|
| Lasso 本体（MCP server + 全部核心能力） | ✅ 免费 | MIT 开源，永远免费 |
| 搜索（智谱 + Brave + Bing） | ✅ 有免费额度 | 智谱按 token 计费；Brave **2000 次/月免费**、Bing **1000 次/月免费**——不花钱就能用。**机器已配过 `web-search-prime` 智谱 MCP？Lasso 自动检测复用，连 ZHIPU_API_KEY 都不用单独配** |
| 抓公开页 / 截图 / PDF / 网络审计 / 抓原始字节 | ✅ 免费 | 本地运行，无 key 无付费 |
| 抓登录态页面（复用本机 Chrome） | ✅ 免费 | 本地运行，无 key 无付费 |
| 控桌面（macOS / Windows / Linux） | ✅ 免费 | 本地构建运行，仅需系统授权；**可选** Apple 开发者账号 \$99/年做签名持久授权（不签名也能用，只是每次重授权） |
| 云浏览器（browserbase / stagehand） | ⚠️ 付费，默认关 | 试用后付费；**不配不花钱**，是 Lasso 唯一付费项 |

> 一句话总结：**只要不开云浏览器，Lasso 全程 0 成本**——搜索有免费额度够日常用，其余能力完全免费。

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

第一份产出——直接对 Claude 说：

> 「抓一下 example.com 的文字，转成 markdown」

### 想要更多？在配置文件里加（第二档）

- **搜东西** → 跑 `lasso config init` 创建 `~/.lasso/config.json`，填一个智谱 key（见 [配置详解](#配置详解)）
- **抓登录态页面**（Jira / GitHub 私有 / 公司内网）→ 跑一次 `lasso launch-chrome`
- **控制 macOS 桌面** → 跑一次 `lasso doctor` 引导授权

每个 key 怎么申请、有哪些免费额度，看 [**Key 配置指南**](./doc/KEY-GUIDE.md)。

---

## 能帮你做什么

按你**想干什么**分组，不按工具名。每组都是一句话进、一句话出。

### 搜一下

> 你：「搜一下 X」 → 结构化搜索结果

默认走智谱（中文主力），可再配 Brave、Bing 做多源。**任一家临时限流或挂掉，自动切下一家，你无感**。某家免费额度用完也不影响整体。

### 抓公开页（不用登录）

> 你：「抓 example.com 的文字」 → 干净正文，三种粒度可选

自动剥掉导航条、广告、侧边栏等冗余，**省 30–70% 字数**（也更省钱）。要带引用角标（适合做调研、喂给 RAG）也能一句话切换。

### 抓登录态页（有 2FA 的也行）

> 你：「看看我 Jira 的待办」 → 登录态页面快照

复用你**本机已经登录好的 Chrome**——你自己把 2FA 解了，Lasso 接管后续抓取。支持私有的 GitHub 仓库、公司内网、付费订阅内容等。

> 🔴 **红线**：Lasso **不替你解** 2FA / 短信验证码 / CAPTCHA / 邮件魔法链接。这些必须你在本机 Chrome 里手动过一次。

### 直接抓字节（最快最省）

> 你：「GET 这个 JSON 接口」 → 原始字节

不需要渲染整页的场景，直接走原始 HTTP，比走浏览器**快约 4 倍、便宜约 4 倍**。按内容类型自动识别（JSON / 文本 / 二进制）。

### 截图 / 存档

> 你：「截个整页长图」「存成 PDF」 → 落盘文件路径

所有图片和 PDF 都**存到本地、返回路径**，不会把一大坨图片数据塞进对话浪费上下文。

### 看一个页面加载了什么

> 你：「这页加载了哪些第三方跟踪？」 → 资源列表 + 跟踪域名计数

自动识别页面加载的全部资源，按第三方域名聚合，方便看隐私风险、性能瓶颈。

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

默认**完全关闭**。只有你明确要开、并且配了云端浏览器的 key，才会启用。普通页面用不上。

---

## 安装

**前提**：Node.js ≥ 20；Claude Code（或任何支持 MCP 的客户端）。

```bash
# Claude Code（推荐）
claude mcp add lasso -- npx -y lasso-mcp
```

重启 Claude Code → `/mcp` → `lasso ✓ Connected`。**就这一行——安装命令不带任何 key**，装完 browse / 截图 / PDF / 控桌面立即可用（搜索除外，见 [配置详解](#配置详解)）。

**macOS 用户想控桌面**：跑一次 `lasso doctor`，按提示在「系统设置 → 隐私与安全」里给 `lasso-rust-helper` 勾上辅助功能和屏幕录制权限即可（`doctor` 会引导你，不用自己找路径）。

---

## 配置详解

**安装零配置**——上面的安装命令已经能让 browse / fetch / 截图 / PDF / 看第三方资源 / 控桌面全部跑起来。**只有搜索需要 key。**

### 按「我想干什么」查配置

| 你想干什么 | 要配什么 | 配了立刻能用 |
|---|---|---|
| 抓公开页 / 截图 / PDF / 看第三方资源 / 抓原始字节 / 控桌面 | **什么都不用配** | 装完即用 |
| 搜东西 | 一个智谱 key（免费申请） | 搜索主入口 |
| 搜索几乎不挂 | 再加 Brave / Bing key（都有免费额度） | 任一家挂了自动切，你无感 |
| 抓登录态页面 | 跑一次 `lasso launch-chrome` | 复用本机 Chrome 登录态 |
| 控 macOS 桌面 | 跑一次 `lasso doctor` | 控原生 app |
| 抓有 Cloudflare 的站 | 双重确认 + 云端 key | 默认关，要你明确要开才开 |

下面按四个模块拆开讲，每个都给「最短能跑通」的配法。

### 一、搜索（✅ 免费 · 有免费额度，一个 key 起步，配三家几乎永不挂）

**能干什么**：搜任何东西，返回结构化结果（标题、摘要、链接）。

**要不要 key**：要——但如果你机器已经配过智谱 `web-search-prime` MCP（写在本机 `~/.claude.json` 的 `mcpServers` 里，type=http + Authorization），**Lasso 启动时自动检测复用它的 key 作搜索首选源，连 ZHIPU_API_KEY 都不用单独配**。机器 MCP 临时限流或失败，自动降级到 Lasso 自己配的 key（按下面填）。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是 `pass`（host=open.bigmodel.cn）还是 `warn`（未检测到）就知道。

> 零配置优先顺序：机器 MCP 复用 → Lasso `ZHIPU_API_KEY` → Brave → Bing → `browse_headless` 兜底。前一个挂了自动切下一个，你无感。

**怎么配**（只在机器没配智谱 MCP / 想要独立 key 时需要）：

```bash
lasso config init        # 创建 ~/.lasso/config.json 模板
```

打开 `~/.lasso/config.json`，照着填：

```json
{
  "ZHIPU_API_KEY": "你的智谱key"
}
```

**想更稳**（强烈推荐）：再加 Brave、Bing 两家，都有免费额度。任一家临时限流或挂掉，自动切下一家，你无感：

```json
{
  "ZHIPU_API_KEY": "你的智谱key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

> 多个 key 之间用逗号隔开就行——N 个 key 拼成 N 倍免费额度，自动轮流用。

key 名和上面表格里写的一样，照着填即可，存盘后下次启动 Lasso 自动读。

**怎么申请 key、免费额度多少、多 key 轮询细节** → 见 [Key 配置指南 · 搜索](./doc/KEY-GUIDE.md#a-搜索)。

### 二、抓登录态页面（✅ 免费 · 不用 key，跑一行命令）

**能干什么**：抓你已登录的页面——Jira 待办、GitHub 私有仓库、公司内网、付费订阅内容。

**要不要 key**：不用。

**怎么配**：跑一次下面的命令，它会自动找你本机的 Chrome，复用你已经登录好的全部会话（2FA 你自己解过的也算）：

```bash
lasso launch-chrome
```

之后对 Claude 说「打开我已登录的 Jira」就会自动连上。

> 🔴 **红线**：2FA / 短信验证码 / CAPTCHA / 邮件魔法链接——Lasso 不替你解，必须你在本机 Chrome 里手动过一次。

**详见** → [Key 配置指南 · 登录态浏览](./doc/KEY-GUIDE.md#b-登录态浏览命令行配置无-key)。

### 三、控桌面（✅ 免费 · 不用 key，系统授权一次）

**能干什么**：在 macOS / Windows / Linux 上控制 Finder、Mail、Safari、系统设置等原生 app（点击、输入、读窗口内容、跑快捷键）。

**要不要 key**：不用。

**怎么配**（按系统选一个）：

- **macOS**：跑一次 `lasso doctor`，按提示在「系统设置 → 隐私与安全」里给 `lasso-rust-helper` 勾上「辅助功能」和「屏幕录制」即可。`doctor` 会一步步引导，不用自己找路径。
- **Windows**：第一次对 Claude说一个桌面操作时，系统会弹一个授权窗，点「允许」就行（和 macOS 的辅助功能等效）。
- **Linux**：确保系统装了辅助功能接口（大多数 GNOME / MATE 桌面默认就有，没有的话 `sudo apt install at-spi2-core` 装一下）。

> **诚实边界**：macOS 经真实环境验证；Windows / Linux 编译和契约层都通过自检，但真机完整手测仍在推进中。**不伪造「已在 Win/Linux 上完整验证」**。

**详见** → [Key 配置指南 · 桌面控制](./doc/KEY-GUIDE.md#c-桌面控制系统授权无-key)。

### 四、云端反爬（⚠️ 付费，默认关 · 双重确认才开）

**能干什么**：抓被 Cloudflare、重度反爬挡住的站。

**要不要 key**：要，并且**必须你明确要开**才会启用。

**怎么配**：需要两个条件同时满足——

1. 总开关：`LASSO_ALLOW_CLOUD_BROWSER` 设为 `true`
2. 至少一个云端 key（browserbase 或 stagehand，二选一）

写进 `~/.lasso/config.json`：

```json
{
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "你的browserbasekey"
}
```

> 默认完全关闭——没配就等于没这个能力。普通页面用不上，**只有你明确要开才会启用**。

**怎么申请云端 key、有哪些试用额度** → 见 [Key 配置指南 · 云浏览器](./doc/KEY-GUIDE.md#d-云浏览器反爬默认关双重解锁)。

<details>
<summary><b>高级调优（可选，普通用户不用展开）</b></summary>

日常使用**完全不用管**下面这些。只在特殊场景才需要，且大多可以通过 `lasso config init` 写进 `~/.lasso/config.json` 或设环境变量来覆盖（环境变量优先级高于配置文件，方便临时替换）：

- 改登录态 Chrome 的调试端口（默认 `9222` 被占用时）
- 换缓存 / 状态文件的存放位置
- 限制只用免费搜索源
- 放行公司内网 / 特殊代理网段
- 给登录 cookie 加一个自己的加密口令（不设则走 macOS 钥匙串）
- 落盘搜索结果快照（做回归测试用）

完整变量清单和默认值见 [Key 配置指南 · 高级调优](./doc/KEY-GUIDE.md#e-高级调优可选全不配)。**Surge / Clash 等 TUN 代理网络（fake-ip）已内置放行，无需额外配置。**

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
| 搜索一直没结果 | 检查 key 是否过期 / 额度用完；配多家（智谱 + Brave + Bing）可大幅降低失败率 |
| 链接打不开 | 改说「这个链接找不到了，找找存档」，去查互联网档案馆 |
| 提示要内网访问被拒 | 确认 URL 没写错；TUN 代理网络已默认放行，其他内网需手动允许 |

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
