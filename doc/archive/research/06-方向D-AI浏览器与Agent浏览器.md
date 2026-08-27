# 方向 D：AI 浏览器 vs Agent 浏览器（06）

> 本文档是「CC 控制浏览器与计算机」系列调研的第 6 篇，承接 00 总览、01 浏览器、02 桌面、03 性能洞察、04 集成手册、05 对比矩阵，专门厘清「AI 浏览器」与「Agent 浏览器」这两个常被混淆的品类。调研用智谱 MCP 工具（zread/web-search-prime/web-reader）完成。

## 0. 核心纠偏（一句话）

**「AI 浏览器」(面向**人**的浏览器,如 Dia/Comet/Arc/夸克/360, AI 能力服务于浏览器里的人)和「Agent 浏览器」(面向 **agent** 的基础设施,如 Steel/Hyperbrowser/Browserless/Browserbase,把浏览器作为 agent 的执行器)是两个完全不同的品类——CC(外部 coding agent)用户该找的是后者,而不是前者。**

## 1. 品类对照表

| 品类 | 面向谁 | 代表项目 | 给 CC 能用吗 |
|---|---|---|---|
| **Agent-native 浏览器基础设施** | Agent | Steel、Hyperbrowser、Browserless、Browserbase | ✅ 强烈推荐,专为 agent 准备 |
| **浏览器内 agent 扩展** | 人(扩展内 AI 替人操作) | Nanobrowser、MultiOn | ⚠️ 不适合,CC 拿不到任何接口 |
| **面向人的 AI 浏览器** | 人 | Dia、Comet、Arc、夸克、360 | ❌ 不适合 CC,别往这找 |

---

## 2. Agent-native 浏览器基础设施(Steel / Hyperbrowser / Browserless / Browserbase)

这是最接近「专为 agent 准备的浏览器」的品类,所有产品都暴露 REST/CDP/MCP,设计目标就是让外部 agent 程序化驱动。**详写。**

### 2.1 Steel

- **定位**:开源的面向 AI agent 的浏览器 API/云基础设施——通过 REST API + CDP 暴露可控的 Chrome 会话(含 session 管理、代理轮换、反检测 stealth 插件、CAPTCHA 求解、cookie/localStorage 持久化、Session Viewer 可观测),自托管或用 Steel Cloud 托管。
- **能否无头**:✅ yes
- **MCP 支持**:✅ yes(官方 `steel-dev/steel-mcp-server`)
- **license**:Apache 2.0(`steel-browser` 主仓)
- **stars**:约 5k+(第三方比较 issue 中标为 5k+;调研时 GitHub API 触发 rate limit,未能直连核验精确数字)
- **最近活跃**:Launch Week v3 已发——Stealth Browser(Chromium fork)、Dedicated IPs、原生 Rust/Go SDK、Atlas 深度研究 harness、Steel Skills、Agent Traces、Projects。最新 release v0.5.3-beta;博客更新到 2026-07。
- **价格**:三档——**Launch** $30 一次性额度(入门);**Scale** $100/月额度(含生产容量+稳定身份+专属支持);**Enterprise** 自定义额度+1000+ 并发会话+SLA。按 browser-hour 计量,未使用不计费;`inactivityTimeout` 让空闲 session 自动释放停止计费。学校/研究邮箱可申请 grants(research@steel.dev)。**开源版自托管免费**。
- **主要坑**:
  1. **云 vs 自-host 差异**:开源 docker 镜像只是「batteries-included sandbox」,反检测的高级特性(Stealth Browser fork、Dedicated IP、CAPTCHA 求解、Session Viewer)主要落在 Steel Cloud 付费产品,自托管版能力有限——很多人误以为 `docker run` 就拿到全部。
  2. **官方 MCP server 仓库定位不稳**:`steel-dev/steel-mcp-server` zread 读取时返回 not found(可能改名/迁移),社区有第三方替代(mcp.so 上的 `rdvo_mcp-server`)。安装以 [docs.steel.dev/integrations](https://docs.steel.dev/integrations) 为准。
  3. **反检测非银弹**:2026 第三方基准(ianlpaterson、scrapfly)显示在严苛 Cloudflare 关卡下,nodriver/patchright 等纯驱动层方案通过率更高;Steel stealth plugin 适合「中等强度」反检测。
  4. **计费模型**:按 browser-hour 计费,长跑 agent 容易堆积账单;`inactivityTimeout` 默认行为要主动配置。
  5. **未提供面向终端用户的「AI 浏览器」UI**——你要的是 Dia/Comet/夸克那种「人坐在浏览器前用 AI」,Steel 不是这个品类。
- **CC 场景**:**推荐,但要分场景**。
  - **适合**:(a) 跨站自动化(登录态保留、表单、抓取、文件下载)且本机 Chrome 不够用时——本地 `docker run ghcr.io/steel-dev/steel-browser` 暴露 CDP 9223 端口,配 chrome-devtools-mcp 或 Steel 官方 MCP server,比纯 Playwright Skill 多了 session 持久化/cookie 注入/请求日志 UI;(b) 反检测或代理轮换的爬取类任务(Stealth Browser + Dedicated IP);(c) 要把浏览器跑成可复现 fleet(每个 CC 子任务一个 session)。
  - **不适合**:纯本地单浏览器调试(chrome-devtools-mcp 复用系统 Chrome 更轻);需要 100% 规避 Cloudflare(基准测试显示 nodriver 干净通关,Steel 不一定全过)。
  - **和 chrome-devtools-mcp 的取舍**:前者是「单浏览器控制层」,Steel 是「浏览器 fleet + 会话/代理/反检测/可观测层」——前者更省 token、后者更省工程化时间。
- **源**:[steel.dev](https://steel.dev/) · [github.com/steel-dev/steel-browser](https://github.com/steel-dev/steel-browser) · [steel.dev/blog](https://steel.dev/blog) · [steel.dev/launch-week](https://steel.dev/launch-week) · [docs.steel.dev/integrations](https://docs.steel.dev/integrations) · [github.com/steel-dev/steel-mcp-server](https://github.com/steel-dev/steel-mcp-server) · [steel-dev/steel-cookbook](https://github.com/steel-dev/steel-cookbook) · [pkgpulse Cloud Browsers 2026 对比](https://www.pkgpulse.com/guides/browserbase-vs-hyperbrowser-vs-steel-cloud-browsers-ai-2026) · [scrapfly stealth browsers 基准](https://scrapfly.io/blog/posts/best-stealth-browsers) · [ianlpaterson 反检测基准](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/) · [fly.io 客户案例](https://fly.io/customers/steel/)

### 2.2 Hyperbrowser

- **定位**:面向 AI agent 的云端浏览器基础设施——通过 API/SDK/MCP 按需启动可规模化(数百并发)的云 Chrome 会话,内置 CAPTCHA 解决、代理管理、反爬 stealth、session 录制和 Live View,并提供一键托管 Browser-Use / Claude Computer Use / OpenAI CUA / Gemini Computer Use / HyperAgent 等 AI 浏览器代理。
- **能否无头**:✅ yes
- **MCP 支持**:✅ yes(`hyperbrowser-mcp`,MIT license,10 个工具:scrape_webpage / crawl_webpages / extract_structured_data / search_with_bing / browser_use_agent / openai_computer_use_agent / claude_computer_use_agent / create_profile 等)
- **license**:MCP Server 为 MIT;HyperAgent 等 SDK 框架多为开源(逐仓核对)
- **stars**:HyperAgent ~1.4K-1.5K(多仓库组织,主仓库非单一 monorepo;MCP 仓库为 `hyperbrowserai/mcp`)
- **最近活跃**:活跃维护中。YC 公司页 2026-05 仍在更新;SDK/MCP 持续迭代,支持 2025/2026 最新模型。
- **价格**:Credit 制,1 credit = $0.001。浏览器会话 $0.10/浏览器小时(100 credits);代理流量 $10/GB;单页 scrape 1 credit($0.001)。Free 档 $0 含 5,000 credits(约 50 浏览器小时)。Enterprise 定制另议。
- **主要坑**:
  1. 核心是云浏览器,所有流量过它服务器——隐私敏感/内网站点不合适;
  2. 免费 5000 credits 只够小试,规模化纯付费;
  3. 官方推荐 agent 屏幕分辨率 1280x720,更大尺寸模型行为会变差;
  4. Stagehand 等外部框架走 CDP attach 时仍要熟悉 Hyperbrowser 的 session 模型;
  5. 和 Browserbase、Browserless、VibeBrowser 同质化竞争,选型需横向比价;
  6. 团队仅 4 人(2026-05 数据),早期 YC 创业公司,长期可用性和 SLA 自行评估。
- **CC 场景**:**强烈推荐**「需要大规模/反爬/验证码/多并发浏览器」场景。
  - (1) 最省事——CC 配置里挂 `hyperbrowser-mcp`,直接得到 scrape/crawl/extract/search/claude_computer_use_agent 等工具,省去自己起 Playwright 和维护代理池;
  - (2) 重度任务——脚本里用 `@hyperbrowser/sdk` 调它的 cloud agent,适合批量数据采集、自动化表单、绕过 Cloudflare;
  - (3) 反爬硬骨头站点——Ultra Stealth Mode + 内置 CAPTCHA 解决比本地 Playwright + 自购代理便宜省心。
  - **不必用的场景**:单机小规模、不要反爬的简单抓取——本地 Playwright/chrome-devtools-mcp 足够。定价透明($0.10/浏览器小时 + $10/GB),是 Browserbase 的便宜替代。
- **源**:[hyperbrowser.ai](https://hyperbrowser.ai) · [docs](https://hyperbrowser.ai/docs/introduction) · [pricing](https://hyperbrowser.ai/pricing) · [github.com/hyperbrowserai/mcp](https://github.com/hyperbrowserai/mcp) · [github.com/hyperbrowserai/HyperAgent](https://github.com/hyperbrowserai/HyperAgent) · [github.com/hyperbrowserai](https://github.com/hyperbrowserai) · [YC 公司页](https://www.ycombinator.com/companies/hyperbrowser) · [MCP 集成文档](https://hyperbrowser.ai/docs/integrations/model-context-protocol) · [devtune 评测](https://devtune.ai/verticals/ai-browser-infrastructure/hyperbrowser)

### 2.3 Browserless (v2)

- **定位**:把无头浏览器(Chrome/Firefox/WebKit)做成可弹性扩展的「浏览器池」服务——本地 Docker 自部署或用其云,Puppeteer/Playwright/CDP/REST/MCP 多种方式连接,专门解决「在云/CI 里跑 Chrome 很痛苦」(字体缺失、随机崩溃、依赖地狱、Lambda 限制)。
- **能否无头**:✅ yes
- **MCP 支持**:✅ yes([docs.browserless.io/mcp/browserless-mcp-server](https://docs.browserless.io/mcp/browserless-mcp-server),支持 Claude Desktop/Cursor/VS Code/Windsurf;2026-06-10 发布的「Browserless Agent」是 single-agent-tool MCP server)
- **license**:SPPL-1.0 OR Browserless Commercial License(v2 从 GPLv3 改为 SSPL;**自部署仅「非商业用途」免费,商业/CI/闭源须购商业 license**,见 issue #3850 社区争议)
- **stars**:未找到(GitHub API 限流;README 内嵌 star badge 为动态图)
- **最近活跃**:非常活跃。Docker 镜像 multi tag 约 9 小时前发布;近期版本 v2.49.0;2026-06 changelog(Authenticated Profiles 扩展到 AI agents + /crawl);2026-06-10 发布 Browserless Agent MCP。
- **价格**:未在首页 markdown 暴露。四档:开源自部署(非商业免费)/ 企业 Docker 自部署 / 云端 Self-Serve(pay-as-you-go,自带住宅代理与计费 dashboard)/ 私有部署(Contact Sales)。具体单价见 [browserless.io/pricing](https://www.browserless.io/pricing)。
- **主要坑**:
  1. **License 陷阱**:v2 改为 SSPL-1.0(非 OSI 认可的开源),自部署只对「非商业」免费,任何商业/CI/闭源产品内嵌都需购 Commercial License,否则有法律风险(社区不满见 [issue #3850](https://github.com/browserless/browserless/issues/3850));
  2. 云端按量计费容易失控(unit-based),建议设 quota/告警;
  3. Debugger/Persistent Sessions/Session Replay/住宅代理/BrowserQL/captcha 解决等「高价值特性」都在付费层,开源版只是核心 automation;
  4. 对 CC 而言,若只是本地一次性的登录后操作,Browserless 比 chrome-devtools-mcp 重——后者直接复用本机已登录 Chrome 更省事,Browserless 优势在规模化和反爬而非单机交互;
  5. Firefox/WebKit 需换镜像(`ghcr.io/browserless/firefox` 或 multi),Chrome 仍是主力;
  6. ARM64(Apple Silicon)对 Chrome/Edge 兼容有限。
- **CC 场景**:**推荐**,是 CC 做「规模化抓取/自动化/AI 浏览」任务时的主力基础设施之一。
  - 场景:批量抓取生成训练数据、绕过反爬(/unblock + 住宅代理 + BrowserQL 解验证码)、站点级 /crawl、需要登录态持久化的多步浏览。
  - CC 接入首选官方 MCP server(一条配置即可,复用 Authenticated Profiles 解决 2FA/登录);或 Bash 调 puppeteer-core 连 `ws://` 端点写脚本。
  - 避坑:本地单机/交互式任务用 chrome-devtools-mcp 复用本机浏览器更轻;Browserless 的价值在「规模化、隔离、反爬、云端弹性」。商业闭源项目需买商业 license;纯开源/个人非商用可免费自部署。
- **源**:[github.com/browserless/browserless](https://github.com/browserless/browserless) · [browserless.io](https://browserless.io) · [MCP server 文档](https://docs.browserless.io/mcp/browserless-mcp-server) · [Agent Browser 文档](https://docs.browserless.io/ai-integrations/agent-browser) · [2026-06 changelog](https://www.browserless.io/changelog/2026-06) · [multi 容器包](https://github.com/orgs/browserless/packages/container/package/multi) · [issue #3850 SSPL 争议](https://github.com/browserless/browserless/issues/3850) · [apiscout 2026 综述](https://apiscout.dev/guides/best-browser-automation-apis-2026)

### 2.4 Browserbase(交叉引用 01 文档,简要带过)

- **定位**:Stagehand 的母公司,云浏览器基础设施,提供反爬、代理、CAPTCHA 解决、session 管理。和 Steel/Hyperbrowser/Browserless 同属「agent-native 云浏览器」一档。
- **CC 状态**:详见 **01 浏览器文档 Browserbase 段**。
- **最大坑**:2FA 失败率约 60%(Stagehand 自家基准披露),登录态稳定性差。
- **源**:[browserbase.com](https://www.browserbase.com/) · 详见 01 浏览器文档。

---

## 3. 浏览器内 agent 扩展(Nanobrowser / MultiOn)

**这一类的设计意图是「agent 跑在浏览器扩展里替人操作」,而不是「给外部 agent 调用的浏览器基础设施」——对 CC 来说几乎拿不到接口,除非退化到 UI 自动化硬戳。**

### 3.1 Nanobrowser

- **定位**:开源 Chrome/Edge 扩展,内置 Planner→Navigator→Validator 多 agent 系统,让用户在浏览器侧边栏用自然语言下达指令,AI 自动完成网页数据抓取、表单填写、研究类任务;定位为 OpenAI Operator ($200/月) 的免费替代。
- **能否无头**:❌ no(扩展必须在有界面的 Chrome 里运行)
- **MCP 支持**:❌ no
- **license**:Apache-2.0
- **stars**:~13.5k(13,482,2026-07-20 实测)
- **最近活跃**:最近 release 2025-11-22(2025 全年活跃,4-11 月均有发布,11 月后节奏放缓)
- **价格**:扩展本身 100% 免费;用户自带 LLM API key(OpenAI/Anthropic/Gemini/Groq/Cerebras/Ollama),成本自付;Ollama 等本地模型可零 API 成本、全离线。对标 OpenAI Operator 的 $200/月。
- **主要坑**:
  1. **无 MCP/API/CDP/CLI**,外部 agent 完全无法程序化驱动,只能人戳侧边栏;
  2. **仅支持 Chrome/Edge**,明确不支持 Firefox/Safari/Arc/Opera/其他 Chromium 变体;
  3. Chrome Web Store 版本滞后于 GitHub release,要最新功能得手动 load unpacked;
  4. 扩展免费但 LLM API key 成本自付,Navigator 推荐 Claude Haiku 3.5、Planner 推荐 Claude Sonnet 4,多轮任务成本敏感;
  5. 本地模型(Ollama/Qwen3-30B 等)需更精细 prompt,否则多轮迭代不稳;
  6. 官方明确声明不背书任何基于此代码库的加密货币/Token/NFT 衍生项目(社区已出现仿冒盘);
  7. 2025-11 后 release 放缓,维护节奏需观察。
- **CC 场景**:**跳过它做程序化浏览器控制**。它的定位是「给人用的浏览器内 AI agent」,不是「给外部 agent 调用的浏览器基础设施」。CC 想做无人值守浏览器自动化,走 chrome-devtools-mcp(--headless 或 --browser-url 复用登录态)或 browser-use skill install(Odysseys 87.4% #1 方案),那些才是带 API/CDP 的。
  - **唯一适合的场景**:你(人)自己装来用,把「去 TechCrunch 抓 10 条标题」「Amazon 找个 <$50 防水蓝牙音箱」这类浏览器任务甩给侧边栏 AI,你在旁边看着——这是 human-in-the-loop,不是 agent-to-agent。
- **源**:[github.com/nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) · [nanobrowser.ai](https://nanobrowser.ai) · [Chrome Web Store](https://chromewebstore.google.com/detail/nanobrowser-ai-web-agent/imbddededgmcgfhfpcjmijokokekbkal) · [文档](https://nanobrowser.ai/docs) · [r/LocalLLaMA 介绍帖](https://www.reddit.com/r/LocalLLaMA/comments/1j5d38r/nanobrowser_an_opensource_ai_web_agent_chrome/) · [releases](https://github.com/nanobrowser/nanobrowser/releases)

### 3.2 MultiOn(已重组为 AGI, Inc. / The AGI Company)

- **定位**:最早是「浏览器内 AI agent」——通过 Chrome 扩展 + Agent API,用自然语言让 agent 在真实浏览器里点击/填表/下单/抓数据;自称「AI 的 Motor Cortex」。**现已 pivot 为 AGI, Inc.,旗舰产品变成 AGI-0**:跑在手机端、本地、proactive 的个人 AI 助手,控制手机 App/浏览器/桌面软件。
- **能否无头**:⚠️ partial
- **MCP 支持**:❌ no(全网及 MCP 官方 servers registry 均未找到)
- **license**:未找到(官方 SDK repo 限流无法确认;社区 cookbook 多为 MIT)
- **stars**:未找到(API 限流;官方 SDK 仓库当前公开可达性存疑)
- **最近活跃**:**legacy 产品线已停摆**。PyPI multion 包最后版本 1.3.8(2024-10-08,>1.5 年未更新);docs.multion.ai 仍在线但内容陈旧。公司主体 AGI, Inc. 持续活跃(2025-08 Visa 合作、2025-10 AGI-0 AndroidWorld 97.4% 公布、2026-03 Qualcomm/Snapdragon 合作、2026-01「Apps Are Dead」博客)。
- **价格**:无公开标价。Legacy MultiOn Agent API 历史 Pro 档约 $19-20/mo(已过期);现旗舰 AGI-0 为 early access/waitlist;AGI Agent SDK 企业定制。融资:截至 2025-11 在洽谈 $50M @ $500M 估值(Forbes),累计已募约 $30M。
- **主要坑**:
  1. **公司已 pivot**:从浏览器 agent SaaS + Agent API 转向 on-device 移动 AGI-0,旧 MultiOn 产品线实际状态不明、疑似 legacy/弃保;
  2. **拿不到 API key**:DeepLearning.AI 社区确认新 key 无法生成,老用户反馈 docs 与平台不一致;
  3. **SDK 早已停更**:PyPI multion 最后更新 2024-10,LangChain 集成示例要求 `langchain>=0.0.265`(远古版本),跑新链路大概率不兼容;
  4. **价格/状态信息全陈旧**:网上 $19-20/mo Pro、Pro $9.99、Ultra $45 等数字都是不同时期的历史价,AGI-0 无公开定价、waitlist only;
  5. **Agent Q / Agent 2.0 是 vapor**:docs 挂了一年多「即将发布」仍未落地;
  6. **不是 MCP**:网上偶有把 MultiOn 当 MCP 替代品的提及,实为混淆「agent API」与「MCP server」——它没有实现 MCP 协议;
  7. **官网 multion.ai 已重定向**到 theagi.company / AGI-0 落地页,研究文档要进 docs.multion.ai 子域。
- **CC 场景**:**不建议**。CC 用户需要 web 自动化请走 chrome-devtools-mcp(--headless + --browser-url 复用登录态)、browser-use(skill install,Odysseys 87.4% #1)、或 Playwright CLI 打包成 Skill(比 MCP 省 ~4× token)。MultiOn 现状是 pivoting 中的 legacy 产品:legacy Agent API 拿不到 key、无 MCP、SDK 已 1.5+ 年不更新;Chrome 扩展只给人用;新旗舰 AGI-0 是 waitlist 里的移动端助手。仅当研究「browser-agent 自愈/规划」历史方案时,可读其 Agent Q 论文与 docs。
- **源**:[multion.ai(已重定向)](https://multion.ai) · [docs.multion.ai/welcome](https://docs.multion.ai/welcome) · [docs.multion.ai/quick-start](https://docs.multion.ai/quick-start) · [aiagentstore 介绍](https://aiagentstore.ai/ai-agent/multion) · [agenticindex 现状标注](https://agenticindex.io/vendors/multionai) · [github.com/tmc/multion-api 社区 fork](https://github.com/tmc/multion-api) · [PyPI multion](https://pypi.org/pypi/multion/json) · [Forbes 2025-11 融资报道](https://www.forbes.com/sites/annatong/2025/11/19/ai-startup-agi-inc-in-talks-to-raise-money-at-500-million-valuation/) · [DeepLearning.AI 社区反馈](https://community.deeplearning.ai/t/multion-api-key-page-doesnt-work/803217)

---

## 4. 面向人的 AI 浏览器(Dia / Comet / Arc / 夸克 / 360)

**这一类的共同特征:AI 能力是给浏览器里的人用的(chat、总结、搜索、写作、agent 助手),不对外部 agent 开放 MCP/API/CDP。CC 用户基本别往这里找。**

### 4.1 Dia (The Browser Company / Atlassian)

- **定位**:The Browser Company(2025-09 被 Atlassian 以 $610M 收购)出品的 AI 原生 Chromium 浏览器,把 AI 助手(chat/morning brief/skills/reports)内嵌进浏览器,帮知识工作者处理日常 Slack/Notion/邮件/日历。
- **能否无头**:❌ no
- **MCP 支持**:❌ no(无公开 MCP/CDP/REST API/SDK)
- **license**:专有/闭源(Chromium 基础,Dia 本身不开源)
- **stars**:未找到(Dia 本身闭源无 repo)
- **最近活跃**:2026-07-16(官方 release notes 最新一期;App v1.37.0 ~2026-06-25)
- **价格**:Dia Pro $20/月(约 $240/年),含无限 AI chat 和 Skills;Dia for Work 企业版含 SSO/管理工具(询价);基础版免费(加入 waitlist)。
- **主要坑**:
  1. **强烈误用风险**:社区第三方「OpenDia」(github.com/aaronjmars/opendia)名字相近,但它是 Chrome 扩展+本地 MCP server,**控制的是 Chrome 不是 Dia 本身**,且明确声明无安全保障、需广权限+localhost WebSocket,与官方无关;
  2. **平台锁死** macOS 14+ M1+,Windows 版本仍在开发中(2026-07 仍未发布);
  3. $20/月 Pro 的「unlimited」实际受 Terms 约束有隐性上限;
  4. 2025-09 被 Atlassian 收购后方向可能转向企业,独立用户长期路线不明;
  5. **Arc 已被官方边缘化**(考虑出售/开源),Dia 是唯一重点;
  6. **无 CDP/MCP/API**,任何「自动化」只能走视觉/AXAPI,慢且易碎。
- **CC 场景**:**不推荐** CC 用户把 Dia 当作被控浏览器。Dia 的 AI 是给浏览器内的人用的,对外不开放。CC 驱动浏览器请用 chrome-devtools-mcp(--headless/--browser-url 复用登录态)或 browser-use(skill install)另开 Chrome。但**如果你本人是 Dia 日常用户,Dia 作为你「人用」浏览器没问题,CC 只驱动一个独立的 Chrome 实例做自动化即可,两者不冲突。**
- **源**:[diabrowser.com](https://diabrowser.com) · [release notes](https://www.diabrowser.com/release-notes/latest) · [TechCrunch 2025-06 Dia beta 发布](https://techcrunch.com/2025/06/11/the-browser-company-launches-its-ai-first-browser-dia-in-beta/) · [TechCrunch 2025-08 $20/月订阅](https://techcrunch.com/2025/08/06/the-browser-company-launches-a-20-monthly-subscription-for-its-ai-powered-browser/) · [TechCrunch 2025-09 Atlassian $610M 收购](https://techcrunch.com/2025/09/04/atlassian-to-buy-arc-developer-the-browser-company-for-610m/) · [The Verge Dia Pro 定价](https://www.theverge.com/news/756427/browser-company-dia-pro-ai-pricing) · [lobehub OpenDia 第三方](https://lobehub.com/mcp/aaronjmars-opendia)

### 4.2 Perplexity Comet

- **定位**:Perplexity 出品的基于 Chromium 的 AI 浏览器,内置 agentic 助手可代用户执行任务(总结页面/视频、发邮件、买商品、深研、整理 tab、生成网站等),把 Perplexity 答案引擎嵌进浏览器核心交互层。
- **能否无头**:⚠️ partial
- **MCP 支持**:❌ no(官方未提供;**有第三方反向工程 MCP 桥**:hanzili/comet-mcp 仅 macOS 6 工具、RapierCraft/Perplexity-Comet-MCP 跨平台 8 工具)
- **license**:专有(Proprietary,基于开源 Chromium/Blink)
- **stars**:未找到(GitHub API 限流;社区 MCP 仓库均为活跃小型项目)
- **最近活跃**:2026-03-18(iOS 版发布);桌面/Android 持续更新中
- **价格**:2025-07 首发 Max 专属 $200/月;**2025-10-02 起全球免费**(需 Perplexity 账号);重度 agentic 功能可能受 Pro 订阅($20/月)用量上限约束。
- **主要坑**:
  1. **安全**:LayerX 披露「CometJacking」攻击向量(2025-08),一键可让 Comet 把用户敏感数据外传到攻击者服务器;Perplexity 回复「无安全影响」未修复;
  2. **自动化非官方**:社区 CDP/MCP 桥属反向工程,任何 Comet 更新可能破坏端口/协议兼容;
  3. **CDP 控制细节坑**:WSL2 默认网络命名空间连不到 Windows localhost:9223,需开启 mirrored networking;不能关闭最后一个浏览 tab(否则 Comet 崩溃);带登录态内容需先人工在 Comet 里登录一次;
  4. **价格历史尴尬**:首发 $200/月 Max-only,现免费但重度 agentic 使用可能触及 Pro 用量上限。
- **CC 场景**:**分两种场景**:
  - (1) **作为给人用的 AI 浏览器——可推荐**,免费、agentic 助手能力强(自动研究/填表/购物/总结);
  - (2) **作为 CC 驱动目标——非首选**:无官方 API,只能靠社区 MCP(RapierCraft/Perplexity-Comet-MCP)经 CDP 反向工程驱动,稳定性脆弱、随官方更新易碎。仅当你明确需要 Comet 内置的 agentic 助手代为执行多步研究/带登录态抓取时才值得接 Comet+社区 MCP;**常规自动化首选 chrome-devtools-mcp + 普通 Chrome**(更干净、更稳定)。
- **源**:[perplexity.ai/comet](https://www.perplexity.ai/comet) · [Wikipedia Comet](https://en.wikipedia.org/wiki/Comet_(browser)) · [CNBC 2025-10 Comet 免费](https://www.cnbc.com/amp/2025/10/02/perplexity-ai-comet-browser-free-.html) · [PCMag $200/月 首发](https://www.pcmag.com/news/perplexitys-ai-browser-comet-is-here-but-early-access-will-costs-200-per) · [siliconangle 介绍](https://siliconangle.com/2025/07/09/perplexity-introduces-comet-browser-ai-powered-automation-tools/) · [HUMAN Security Comet 分析](https://www.humansecurity.com/ai-agent/perplexity-comet/) · [RapierCraft/Perplexity-Comet-MCP](https://github.com/RapierCraft/Perplexity-Comet-MCP) · [mcpservers hanzili/comet-mcp](https://mcpservers.org/servers/hanzili/comet-mcp) · [Reddit 用户求 Comet API](https://www.reddit.com/r/perplexity_ai/comments/1m6nm8e/can_we_have_comet_api_available_for_developers_i/)

### 4.3 Arc (The Browser Company / 现已属 Atlassian)

- **定位**:基于 Chromium 的桌面端「重塑 UI」型消费浏览器(Mac/Windows),主打 Spaces/Profiles/Split View/Command Bar 等空间化标签管理,内置面向人的 AI 套件 Arc Max(ChatGPT 侧栏、智能搜索、5 秒预览摘要等)。**已进入维护模式**(仅 Chromium 安全更新,无新功能),公司工程重心已转向 Dia;2025-09 Atlassian 以约 $6.1 亿美元收购 The Browser Company。
- **能否无头**:⚠️ partial(未官方支持)
- **MCP 支持**:❌ no
- **license**:专有/闭源。官方明确:基于自研 ADK 框架,因 ADK 同时是 Dia 的底座,**Arc 不会开源**。
- **stars**:未找到(闭源,无官方仓库)
- **最近活跃**:**2025-05 正式宣布冻结**(仅 Chromium 安全/bug 修补,无新功能);截至 2026-05 仍可下载运行;无明确下线日期。公司活跃开发已转向 Dia。
- **价格**:免费(Free)。
- **主要坑**:
  1. **已冻结进入维护模式,永无新功能**,公司明牌推用户迁 Dia——选型即「上沉船」;
  2. 闭源 + ADK 共享给 Dia,**官方明确不会开源**;
  3. 无 MCP/无 API/无 headless,自动化只能降级为「通用 Chromium + CDP」,Arc 独有 UI(Spaces/Split View/Command Bar)完全不可编程;
  4. Atlassian $610M 收购后产品方向未明;
  5. Arc Max 的 AI 能力闭环在浏览器内,外部 agent 拿不到;
  6. 非 Chrome 官方版,部分企业策略/扩展兼容性可能有差异。
- **CC 场景**:**不推荐 CC 用户使用**。理由:(1) 维护模式、永无新功能、公司已转向 Dia+Atlassian;(2) AI 只服务浏览器里的人,不对外开放;(3) 没有任何 MCP/官方自动化 API,CC 只能退化为「普通 Chromium + CDP」模式驱动,收益低于 chrome-devtools-mcp 或 Dia。CC 用户若要面向人的 AI 浏览器,直接看 Dia;若要 agent 控浏览器,走 chrome-devtools-mcp 或 browser-use skill。唯一值得提及的是 Arc 的 Spaces/Profiles/Split View 设计思想可作为「人机协作浏览」的产品参考。
- **源**:[arc.net](https://arc.net) · [The Verge 2025-05 Arc 停止开发](https://www.theverge.com/news/674603/arc-browser-development-stopped-dia-browser-company) · [Atlassian 收购公告](https://www.atlassian.com/blog/announcements/atlassian-acquires-the-browser-company) · [siliconangle $610M 收购](https://siliconangle.com/2025/09/04/atlassian-acquires-ai-browser-developer-browser-company-610m/) · [Browser Company 致 Arc 用户信](https://browsercompany.substack.com/p/letter-to-arc-members-2025) · [supasidebar Arc 死了吗](https://supasidebar.com/blog/is-arc-browser-dead) · [ghacks Arc 已停更](https://www.ghacks.net/2025/05/27/arc-browser-has-been-discontinued-but-the-companys-building-a-new-browser-dia/)

### 4.4 夸克 AI 浏览器(Quark AI Browser)

- **定位**:阿里旗下深度融合通义千问的消费级 AI 浏览器,把 AI 作为系统级全局入口(千问悬浮球/快捷框/截屏/划词/侧边栏/读屏六大套件)供用户在浏览时随时唤起,对标 Chrome 与 ChatGPT Atlas。
- **能否无头**:❌ no
- **MCP 支持**:❌ no
- **license**:闭源专有(阿里商业产品)
- **stars**:未找到(闭源商业产品)
- **最近活跃**:2025-11 全面升级为「新一代 AI 浏览器」(六大千问 AI 套件发布),持续迭代(桌面端+移动端+Chrome 扩展)
- **价格**:免费(C 端消费者产品,含网盘/扫描王/文档等增值服务)
- **主要坑**:
  1. **纯消费者产品,零开放接口**——任何 agent 自动化都是 hack 而非受支持;
  2. 移动端为主战场(`com.quark.browser`),桌面端虽基于 Chromium 但官方未暴露 debug 端口,CDP 连接需要特殊启动参数且可能违反 ToS;
  3. 中国大陆封闭生态,AI 能力强绑定阿里千问账号体系,无法被外部程序复用;
  4. 它的「Agent」指的是产品内部为用户调度的任务模块(AI 超级框),与「外部 agent 可调用」完全不同——**容易因术语造成误判**;
  5. 无法 headless 运行,无人值守场景不可用。
- **CC 场景**:**不推荐**作为 CC 直接驱动的目标。理由:(1) 没有暴露 MCP 或开放 API,CC 拿不到任何原生接口;(2) C 端封闭商业产品,AI 能力服务于「人在浏览器里用」而非「外部 agent 调用」。CC 若要做浏览器自动化,应优先 chrome-devtools-mcp 控制 Chromium/Chrome、或 Playwright MCP / Browser-use。若场景必须在中国大陆站点+已登录态,可用 `--browser-url` 复用已打开的夸克桌面端会话(因夸克基于 Chromium,CDP 可连),但这属于 hack 而非受支持用法。**移动端夸克完全无法被 CC 驱动**。
- **源**:[quark.sm.cn](https://quark.sm.cn) · [BAAI Hub 介绍](https://hub.baai.ac.cn/view/50751) · [夸克 AI 视频](https://b.quark.cn/apps/quark_ai_video/routes/home) · [Chrome 扩展](https://chromewebstore.google.com/detail/%E5%A4%B8%E5%85%8B%EF%BC%8C%E6%B5%8F%E8%A7%88%E5%99%A8-ai-%E5%8A%A9%E6%89%8B/nmaekpmealpjglikpijiegglabclhefp) · [webquark.com.cn](https://webquark.com.cn/) · [小米应用商店](https://m.app.mi.com/details?id=com.quark.browser)

### 4.5 360 AI 浏览器(360 安全浏览器 AI 升级版 / 360 企业安全浏览器)

- **定位**:360 公司旗下消费级浏览器全系 AI 升级(2025-05-26 覆盖 4 亿用户),将「纳米 AI 助手」深度融合到浏览场景:AI 搜索(超级搜索系统,支持语音/图片/自然语言模糊查询)、AI 阅读(网页/PDF/视频/音频一键总结、双语脑图)、AI 写作(场景化模板)、右上角常驻「问问纳米」入口;整合国内 10+ 主流大模型。企业版面向政企办公门户、SSO、国密、信创替代。
- **能否无头**:❌ no
- **MCP 支持**:❌ no(**注意**:360 旗下「纳米 AI 助手」2025-04-23 发布「MCP 万能工具箱」,但方向是 **360 作为客户端消费别人 MCP 工具**,与「CC 控制 360 浏览器」是**反向**的,不能混淆)
- **license**:闭源专有(免费软件)
- **stars**:未找到(闭源商业产品)
- **最近活跃**:持续更新。2025-05-26 全系浏览器全面 AI 升级;2025-04-23 纳米 AI MCP 万能工具箱发布;App Store 360 AI 浏览器持续迭代。
- **价格**:消费级免费下载;「纳米 AI 助手」部分高级模型能力可能需登录 360 账号;企业安全浏览器按政企授权方案报价(未公开)。
- **主要坑**:
  1. **最大坑**:把「360 纳米 AI 发布 MCP 万能工具箱」误读为「360 浏览器提供 MCP server」——**方向反了**,360 是消费端不是服务端;
  2. 双核(Trident 兼容 + Chromium 极速),切换到兼容核时 CDP 协议会失效,自动化时需强制指定极速核;
  3. 内置强广告/反跟踪/安全策略可能拦截自动化脚本与扩展;
  4. 中文站点登录态(微信/扫码)强绑定特定浏览器指纹,迁移 Chrome 后可能要重新校验;
  5. 企业安全浏览器(browser.360.net)的策略自动化(自动升级/配置下发)面向 IT 管理员,不是给外部 agent 的 API;
  6. RPA 扩展机制依赖手动在 `se://extensions/` 启用插件,部署成本高。
- **CC 场景**:**不推荐** CC 用户作为 agent 驱动对象。理由:(1) 给人用的,AI 在浏览器内服务人而非服务外部 agent;(2) 无官方 MCP/CDP/API,CC 控制它要走非官方 CDP 或 RPA 扩展,ROI 低;(3) 中文+Chromium 双核,若 CC 用户真要做中文站点自动化,更应直接用标准 Chrome + chrome-devtools-mcp(--browser-url 复用)或 Playwright Skill,绕开 360 浏览器。**唯一考虑场景**:目标站点强风控、仅 360 浏览器能通过人机校验、且复用用户已登录态时,可用 Chromium CDP 直连 360 进程做兜底(但此场景极窄)。CC 用户不要选它做主控浏览器。
- **源**:[browser.360.cn](https://browser.360.cn/) · [browser.360.net 企业版](https://browser.360.net/) · [mse.360.cn/ai](https://mse.360.cn/ai) · [AI 助手详情](https://browser.360.cn/se/side/ai/ai-assist.html) · [新华社 2025-05-26 报道](http://www.news.cn/tech/20250526/db683f0775264458ad498cc5725c9160/c.html) · [财联社 2013368](https://www.cls.cn/detail/2013368) · [App Store 360 AI 浏览器](https://apps.apple.com/cn/app/360ai%E6%B5%8F%E8%A7%88%E5%99%A8/id6484503647) · [阿里云 RPA 操作 360 浏览器案例](https://help.aliyun.com/zh/rpa/use-cases/operating-360-browser) · [ai.360.com](https://ai.360.com/)

---

## 5. 对 CC 用户的结论

按场景对号入座,不要为了「AI 浏览器」这个热门词而偏离实际需求:

| 场景 | 首选 | 备选 |
|---|---|---|
| **80% 日常浏览器自动化**(单浏览器调试、登录态复用、本地抓取) | **chrome-devtools-mcp**(`--headless` 或 `--browser-url` 复用系统 Chrome) | Playwright CLI 打包成 Skill(比 MCP 省 ~4× token) |
| **反检测 / CAPTCHA / Cloudflare 关卡** | **Steel**(Stealth Browser + Dedicated IP) | Hyperbrowser(Ultra Stealth Mode);本地 nodriver/patchright(纯驱动层) |
| **云端规模化 / 多并发 / 免运维** | **Hyperbrowser**(便宜,免费 5000 credits) | Browserbase(见 01 文档);Browserless(规模化+SSPL 自部署) |
| **浏览器常驻 agent**(human-in-the-loop,人盯着 AI 跑) | **Nanobrowser**(扩展 100% 免费,Apache-2.0) | — |
| **面向人的 AI 浏览器**(Dia/Comet/夸克/360) | **不适合 CC**,别往这找 | 你自己日常用没问题,CC 另开一个 Chrome 实例做自动化 |
| **不要选** | MultiOn(已 pivot,API key 拿不到) | Arc(已冻结,2025-05 后无新功能) |

**一句话决策树**:
1. 要不要反检测/规模化?→ 要:看 Steel / Hyperbrowser / Browserless / Browserbase;不要:走 chrome-devtools-mcp。
2. 是 CC 驱动还是人驱动?→ CC 驱动:走 chrome-devtools-mcp 或 agent-native 基础设施;人驱动:Nanobrowser 扩展或面向人的 AI 浏览器(Dia/Comet 等)。

---

## 6. 横向对比表

| 项目 | 品类 | 面向 | 能否无头 | 能否被 agent 控制 | MCP | license | stars | 主要坑 |
|---|---|---|---|---|---|---|---|---|
| **Steel** | agent-native 基础设施 | agent | ✅ yes | ✅ REST+CDP+MCP+SDK 全开放 | ✅ 官方 | Apache 2.0(主仓) | ~5k+(未核验) | 云 vs 自-host 差异;反检测非银弹;按 browser-hour 计费 |
| **Hyperbrowser** | agent-native 基础设施 | agent | ✅ yes | ✅ MCP+SDK+CDP 全开放 | ✅ 官方(MIT) | MIT(MCP) | HyperAgent ~1.4K-1.5K | 4 人 YC 早期团队;云流量过它服务器;规模化付费 |
| **Browserless v2** | agent-native 基础设施 | agent | ✅ yes | ✅ MCP+CDP+REST 全开放 | ✅ 官方 | **SSPL-1.0**(非商业免费) | 未找到 | License 陷阱(商业需购);高价值特性都在付费层 |
| **Browserbase** | agent-native 基础设施 | agent | ✅ yes | ✅ Stagehand + CDP | ✅ 官方 | 闭源商业 | —(见 01) | **2FA 失败率 60%**;详见 01 浏览器文档 |
| **Nanobrowser** | 浏览器内 agent 扩展 | 人 | ❌ no | ❌ 无任何接口 | ❌ no | Apache-2.0 | ~13.5k | 扩展只给人用;LLM 成本自付;2025-11 后放缓 |
| **MultiOn** | 浏览器内 agent 扩展(已 pivot) | both | ⚠️ partial | ❌ 无 MCP、API key 拿不到 | ❌ no | 未找到 | 未找到 | **公司已 pivot 为 AGI, Inc.**;SDK 1.5+ 年不更新;Agent Q 2.0 vapor |
| **Dia** | 面向人的 AI 浏览器 | 人 | ❌ no | ❌ 无官方接口 | ❌ no | 闭源 | 未找到 | macOS 14+ M1+ 锁死;无 CDP/MCP;OpenDia 第三方≠Dia |
| **Comet** | 面向人的 AI 浏览器 | 人 | ⚠️ partial | ⚠️ 仅社区反向工程 MCP | ❌ no(官方) | 闭源 | 未找到 | CometJacking 安全漏洞;社区 MCP 随官方更新易碎 |
| **Arc** | 面向人的 AI 浏览器 | 人 | ⚠️ partial | ⚠️ 仅通用 Chromium + CDP | ❌ no | 闭源(不开源) | 未找到 | **已冻结维护模式**;2025-05 后无新功能;永不开源 |
| **夸克 AI 浏览器** | 面向人的 AI 浏览器 | 人 | ❌ no | ❌ 无任何接口 | ❌ no | 闭源专有 | 未找到 | 中国大陆封闭生态;移动端完全无法被 CC 驱动 |
| **360 AI 浏览器** | 面向人的 AI 浏览器 | 人 | ❌ no | ❌ 无任何接口 | ❌ no | 闭源专有 | 未找到 | 「MCP 万能工具箱」方向反了;双核 CDP 失效 |

---

## 7. 可信度与 caveat

**数据可信度标注**:

| 项目 | unverified | 说明 |
|---|---|---|
| Steel | ⚠️ true | stars ~5k+ 未能直连 GitHub 核验(API rate limit);其他字段多源交叉 |
| Hyperbrowser | ✅ false | 各字段多源验证,stars 有具体数字 |
| Browserless | ⚠️ true | stars 未找到;license/pricing 字段信息有限 |
| Nanobrowser | ✅ false | stars 2026-07-20 实测(13,482);其他字段多源 |
| MultiOn | ⚠️ true | stars/license 未找到;官方 SDK 仓库可达性存疑 |
| Dia | ✅ false | 各字段多源验证;无 stars 是因为闭源 |
| Comet | ✅ false | 各字段多源验证;无 stars 是因为闭源 |
| Arc | ⚠️ true | license 和收购细节多方报道一致但官方原文未直接核验;闭源无 stars |
| 夸克 AI 浏览器 | ⚠️ true | 闭源商业产品,数据多来自二手报道 |
| 360 AI 浏览器 | ⚠️ true | 闭源商业产品,数据多来自二手报道 |

**通用 caveat**:

1. **本调研用智谱 MCP 工具完成**(zread 读 GitHub 仓库与文档、web-search-prime/web-reader 抓取产品页与报道),未对所有 stars/pricing 字段做 GitHub API 直连核验,部分数字标注「未找到」或「约」即源于此。
2. **多源交叉但时效性强**:AI 浏览器/agent 基础设施赛道变化快(Steel Launch Week、Hyperbrowser MCP 工具增减、MultiOn pivot 等),建议读者对关键决策字段(license、pricing、MCP 工具清单)做一次最新核验,以官方 docs/releases 为准。
3. **GitHub stars 是 popularity 的弱代理**:Browserless 闭源商业、闭源浏览器(Dia/Arc/夸克/360)无公开 repo,stars 字段空白不代表项目不活跃。
4. **「CC 用户」语境**:本文档假设 CC 是外部 coding agent(Claude Code/Cursor 等),通过 MCP/CDP/SDK 驱动浏览器;若讨论 Anthropic Computer Use API 或视觉路线,结论会不同(详见 02 桌面文档)。
5. **与已有文档的关系**:Browserbase 详细调研在 01 浏览器文档;chrome-devtools-mcp / Playwright Skill / browser-use 的深入对比在 01 和 05 对比矩阵;本文档专注「AI 浏览器 vs Agent 浏览器」品类厘清,不重复展开。

---

**系列导航**:00 总览 · 01 浏览器 · 02 桌面 · 03 性能洞察 · 04 集成手册 · 05 对比矩阵 · **06 AI 浏览器 vs Agent 浏览器(本文)**