# Lasso Key 获取与配置指南

这份手册讲清楚：**每个 key 用在哪、去哪申请、有没有免费额度、配在哪里**。

> **配置位置说明（重要，先读）**
>
> Lasso 支持两种 key 配置方式，**任选其一**：
>
> - **推荐：配置文件**——跑 `lasso config init` 创建 `~/.lasso/config.json`，按需编辑。文件是**扁平 JSON**，key 名同环境变量名（无需学新 schema）：
>
>   ```json
>   { "ZHIPU_API_KEY": "你的key", "BRAVE_API_KEYS": "k1,k2,k3" }
>   ```
>
> - **高级/临时覆盖：env 变量**——`claude mcp add -e KEY=VAL`、shell `~/.zshrc` / `~bashrc`、或 MCP client 的 `env` 块仍生效；**env 优先级高于配置文件**（向后兼容：既有 env 用户不破）。
>
> 安装命令本身**不需要带任何 key**（`claude mcp add lasso -- npx -y lasso-mcp`）。装完 browse / 截图 / PDF / 控桌面立即可用；只有搜索等需要 key 的能力才按上面任一方式配。下文每个 key 的「怎么配」默认示范配置文件方式，并提示 env 覆盖。

---

## 快速对照表

| key / 变量 | 用途 | 哪里获取 | 必填 | 免费额度 |
|---|---|---|---|---|
| `ZHIPU_API_KEY` | 搜索（默认引擎，中文主力） | [智谱开放平台](https://open.bigmodel.cn/console/apikey) | 要用搜索就**必填** | 按 token 计费（有新用户额度） |
| `BRAVE_API_KEYS` | 搜索第二源（自动降级用） | [Brave Search API](https://brave.com/search/api/) | 需信用卡 | **~1000 次/月**（$5/月额度，2026-02 起免费档取消） |
| `BING_API_KEYS` | （已关停）配置键保留 | ~~Azure 门户~~ 2025-08-11 退役 | 否 | 不可用 |
| `LASSO_ALLOW_CLOUD_BROWSER` | 云浏览器总开关（值设 `true`） | 无需申请 | 启用云浏览器时**必填** | — |
| `STEEL_ENDPOINT` | 自托管云浏览器端点（v1.6 新·推荐） | 无需申请（自己跑 Docker） | 启用 Steel 时**必填** | —（零 per-session 费，自托管） |
| `BROWSERBASE_API_KEY` | 云端反爬 Chrome | [browserbase.com](https://www.browserbase.com/) | 启用 browserbase 时**必填** | **100 分钟试用**（之后付费） |
| `STAGEHAND_API_KEY` | AI 友好的页面观察 | [api.stagehand.dev](https://api.stagehand.dev) | 启用 stagehand 时**必填** | 试用（付费为主） |
| `LASSO_COOKIE_PASSPHRASE` | 登录 cookie 加密口令 | 自己设一串足够长的密码即可 | 否 | — |

> **多 key 轮询**：`BRAVE_API_KEYS` 支持 **CSV 多 key**（`k1,k2`）。每个 key 各带一份月度额度，自动轮询、单 key 失败自动换下一个。

---

## A. 搜索

### 1. 智谱（`ZHIPU_API_KEY`）—— 默认引擎，中文主力

> 💡 **零配置优先（v1.4 新）**：如果你机器已经配过智谱 `web-search-prime` MCP（在 `~/.claude.json` 的 `mcpServers` 里，type=http + url 含 `web_search_prime`/`bigmodel.cn` + `headers.Authorization`），**Lasso 启动时自动检测复用它的 key 作搜索首选源（`search.machine_mcp`），可以不配 `ZHIPU_API_KEY`**。机器 MCP 临时限流或失败 → 自动降级到 Lasso 自己的 `ZHIPU_API_KEY`（按下面填）→ Brave →（Bing 层已关停自动跳过）→ `browse_headless` 兜底。跑 `lasso doctor` 看 `#36 machine_search_mcp` 是 `pass`（host=open.bigmodel.cn）还是 `warn`（未检测到）。安全：Lasso 只读不写 `~/.claude.json`，永不 log Authorization 值。

**去哪申请**：<https://open.bigmodel.cn/console/apikey>

**步骤**：
1. 打开 [智谱开放平台](https://open.bigmodel.cn/console/apikey)，注册账号（手机号即可）。
2. 进入「API Keys」页面，点「创建 API Key」。
3. 复制生成的 key（格式形如 `xxxxxxxxxxxxx.yyyyyyyyyyyyy`，即 `{id}.{secret}`）。

**怎么配**：

**推荐：写进 `~/.lasso/config.json`**（跑 `lasso config init` 创建）：

```json
{
  "ZHIPU_API_KEY": "你刚才复制的key"
}
```

或临时覆盖（env，优先级高于配置文件）：export `ZHIPU_API_KEY=...` 到 shell，或写进其他 MCP client 的 `env` 块：

```json
{
  "mcpServers": {
    "lasso": {
      "command": "npx",
      "args": ["-y", "lasso-mcp"],
      "env": {
        "ZHIPU_API_KEY": "你刚才复制的key"
      }
    }
  }
}
```

> 🔴 **红线警告：不要用 Code Plan 的 `ZAI_API_KEY` 顶替**
> 智谱的 **Code Plan 套餐 key**（形如 `ZAI_API_KEY`，绑定 `z.ai` 端点 + 工具白名单）**不能**用于 Lasso 搜索。违规调用会触发白名单校验、可能封号。请务必走上面开放平台的 `ZHIPU_API_KEY` 路径。（与 media-gen-mcp 同一红线。）

**免费额度**：智谱按 token 计费，新用户注册有赠送额度，具体数值以平台公示为准。

---

### 2. Brave Search（`BRAVE_API_KEYS`）—— 可选，第二源（现为付费计划 + 每月 $5 免费额度）

> **⚠️ 2026-02 起免费档已取消**：Brave 原先的「Free 计划 2000 次/月免信用卡」已下架。现在所有计划都是付费制，每计划附带 **$5/月免费额度**（Search 计划 $5/千次，约 **1000 次/月**）；超出额度后绑定的信用卡**自动按量扣费、无消费上限**。免费搜索主力请用智谱（见上文），Brave 作为可选增强。

**去哪申请**：<https://brave.com/search/api/>

**步骤**（新账号注册后）：
1. 登录 [API 控制台](https://api-dashboard.search.brave.com/)，**绑定信用卡**（必须，官方称反欺诈用途——注意：这就是超额后自动扣费的那张卡）。
2. 订阅 **Search** 计划（$5 / 千次查询，含每月 $5 免费额度 ≈ 1000 次）。
3. **加上 Attribution 才有免费额度**：在你的项目网站 / 关于页标注 "Powered by Brave Search API"——不加的话连每月 $5 额度都没有。
4. 在控制台拿到 API key。

**怎么配**：

**写进 `~/.lasso/config.json`**：

```json
{
  "ZHIPU_API_KEY": "你的智谱key",
  "BRAVE_API_KEYS": "你的bravekey"
}
```

多 key 轮询用 CSV 字符串（`"BRAVE_API_KEYS": "k1,k2"`，每个 key 各自带一份月度额度）。

（env 覆盖同样支持：`export BRAVE_API_KEYS=k1,k2`，优先级高于配置文件。）

**费用提醒**：想只花免费额度的话，月查询量控制在 ~1000 次以内；要绝对不被扣费就别绑卡、不配 Brave——智谱 + 免费兜底已覆盖日常搜索。

---

### 3. Bing / Azure（`BING_API_KEYS`）—— 🔴 已关停，无法新开通

> **微软已于 2025-08-11 完全退役 Bing Search APIs**（[官方公告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)），所有实例一并停用，新账号无法再创建资源。`BING_API_KEYS` 配置键在 Lasso 中保留（配了会自动跳过、不影响主流程），但没有可用的 key 来源了。

第二源请选 Brave（上文）；免费搜索靠智谱 + 兜底实搜（Lasso 自带 DuckDuckGo 兜底，无需配置）。

> 💡 **时效过滤无需任何配置**（v1.11）：搜索时直接对 Claude 说「搜最近一周 / 最近一个月的 X」，会自动带 `freshness` 参数（day / week / month / year），智谱 / Brave 通用（Bing 已关停）——不用往查询词里手写日期，也不用配任何 key。

---

## B. 登录态浏览（命令行配置，无 key）

### `lasso launch-chrome`

要抓「你已登录的页面」（Jira 待办、GitHub 私有仓库、公司内网等），先启动一个带调试端口的 Chrome，它会**复用你本机 Chrome 的全部登录态**（包括 2FA 你自己解过的会话）。

**怎么配**：

```bash
lasso launch-chrome
```

跑一次即可。命令会自动探测 macOS / Linux / Windows 上的 Chrome 路径并启动，之后对 Claude 说「打开我已登录的 Jira」就会自动连上。

> v1.8 行为变化：① 默认注入 Lasso 独立的 `--user-data-dir`（`~/.cache/lasso/chrome-profile-default`）——Chrome 136+ 不允许对默认 profile 开调试端口，老办法会秒退；第一次在这个窗口里登录，之后该 profile 的登录态一直复用。也可 `lasso launch-chrome --profile <目录>` 指定已有 profile。② 启动后探活 CDP `/json/version`（3 秒窗口）：Chrome 没起来 / 端口被占会明确报错（`chrome_exited` / `port_in_use` / `cdp_not_ready`），不再「返回 ok 但其实连不上」。

> 桌面端口默认 `9222`，被占用时可用 `LASSO_CDP_PORT=9223` 改端口（见 [高级调优](#e-高级调优可选全不配)）。

> v1.9 生命周期收尾：`launch-chrome` 起的 Chrome 会登记到 `~/.cache/lasso/launched-chromes.json` 台账，任务结束后用 `lasso chrome-stop`（或 `lasso chrome-stop --port 9222` 关指定一个）按台账关闭——只杀验证过命令行归属的 pid，不会误伤你手动开的 Chrome。`browse_logged_in` 用完后，对 Claude 说 `admin {action:"tab_restore", reason:"任务完成"}` 可关掉 Lasso 新开的 tab、恢复你原来的 tab 列表（server 退出时也会自动做）。无头浏览器默认 5 分钟没人用就自动回收（见 `LASSO_HEADLESS_IDLE_MS`）。

> v1.10 默认静默 + 用完即关：① `launch-chrome` 默认 **hidden 档**——零窗口启动、不抢键盘/窗口焦点、恒静音（macOS 用 `--no-startup-window`，Windows 追加 `--start-minimized`）；唯一可感知残留是 Dock / 任务栏多一个 Chrome 图标。想要可见窗口（v1.9 行为）用 `lasso launch-chrome --mode visible`，或在 `~/.lasso/config.json` 配 `"LASSO_LAUNCH_MODE": "visible"`。② **用完即关**：server 运行期间，这个 Chrome 最后一次被使用后约 60 秒内自动关闭（60s idle 判定 + 15s 检查周期，上界 ~75s），不用等 `chrome-stop`。阈值用 `LASSO_LAUNCH_IDLE_MS` 调：要回退 5 分钟配 `300000`；要更激进配 `1000`（代价是间隔稍长的连续操作会触发 ~11 秒重冷启动）；配 `0` 完全禁用（常驻到 `chrome-stop`）。单次 launch 想单独放行用 `lasso launch-chrome --idle-ms 3600000`。③ 诚实边界：`launch-chrome` 单独 CLI 起的 Chrome 没有 idle 回收（回收器只活在 server 进程），关闭出口仍是 `chrome-stop`；`browse_logged_in` 连**你自己开的可见 Chrome** 时是「低打扰，非零打扰」（macOS 上游 CDP 平台级限制，个别操作可能抢一次焦点）——要纯静默就用 lasso 自己 launch 的 hidden 档或 `browse_headless`；`desktop` 通道是模拟真人键鼠，**设计上就会占用你的物理键鼠**，不存在静默形态。

---

## C. 桌面控制（系统授权，无 key）

### macOS：`lasso doctor`

要在 macOS 上控制原生 app（Finder / Mail / Safari / Notes / 系统设置等），需要给 Lasso 的桌面辅助进程授权。

**怎么配**：

```bash
lasso doctor
```

按提示打开 **「系统设置 → 隐私与安全 → 辅助功能」** 和 **「屏幕录制」**，把 `lasso-rust-helper` 勾上即可。`doctor` 会一步步引导，不需要你手动找路径。

> **macOS 15+ 补充（坐标鼠标）**：如果你还要用**坐标鼠标动作**（拖拽滑条、按坐标点击、滚轮等），系统会多一项 **「Event Synthesizing」（事件合成）** 授权——同样在「系统设置 → 隐私与安全」里，给 `lasso-rust-helper` 勾上即可（已勾「辅助功能」通常也能兜底）。`lasso doctor` 的 `#21 tcc_event_synthesizing` 检查会专查这项；缺了它坐标动作会明确报「需要授权」而不是含糊失败。macOS 14 及以下没有这一项，走「辅助功能」即可。

### Windows

首次对 Claude 说一个桌面操作时，系统会弹「UIA 授权」窗，点「允许」即可（与 macOS 的辅助功能等效）。

### Linux

确保系统装了 AT-SPI2（大多数 GNOME / MATE 桌面默认就有）：

```bash
sudo apt install at-spi2-core     # Debian/Ubuntu
# 或对应发行版的等价包
```

---

## D. 云浏览器反爬（默认关，双重解锁）

默认**完全关闭**。仅当你需要抓被 Cloudflare / 反爬严重的站点时才开启（轻度反爬 `browse_headless` 自带反检测就能过，不必开云浏览器）。开启需要**两个条件同时满足**：

1. `LASSO_ALLOW_CLOUD_BROWSER=true`（总开关）
2. 至少一个云通道——`STEEL_ENDPOINT`（自托管，推荐免费）或 `BROWSERBASE_API_KEY` / `STAGEHAND_API_KEY`（托管型，付费）

缺任一，云通道行为完全等价于「没配」（零回归）。

---

### `STEEL_ENDPOINT` —— 自托管云浏览器（v1.6 新·推荐·免费）

[Steel](https://github.com/steel-dev/steel-browser)（Apache-2.0 开源）是一个云端浏览器服务，你**自己用 Docker 跑**——**零 per-session 费 + cookie 不出本地**。适合不想用付费托管型（browserbase/stagehand）、又需要过 Cloudflare 级反爬的场景。Steel 自带指纹伪装和 stealth 插件，反检测能力比 browserbase 更强。

**去哪申请**：无需申请——自己跑 Docker 即可。

**前提**：Docker 已装（[Docker Desktop](https://www.docker.com/products/docker-desktop/) 下载安装，启动后 `docker --version` 能出版本号就行）。

**步骤**：

1. 一行启动 Steel（`3000`=REST API 端口，`9223`=CDP 端口）：

   ```bash
   docker run -d -p 3000:3000 -p 9223:9223 ghcr.io/steel-dev/steel-browser
   ```

   （`-d` 后台跑；想看实时日志去掉 `-d`。）

2. 验证 Steel 已就绪——任选其一：

   ```bash
   curl http://localhost:3000/health     # 返回 JSON（健康检查，doctor 也探这个）
   ```

   或浏览器打开 <http://localhost:3000> 看到 Steel 就绪页即可。

3. 配 Lasso（写进 `~/.lasso/config.json`）：

   ```json
   {
     "LASSO_ALLOW_CLOUD_BROWSER": true,
     "STEEL_ENDPOINT": "http://localhost:3000"
   }
   ```

   （env 覆盖：`export LASSO_ALLOW_CLOUD_BROWSER=true` + `export STEEL_ENDPOINT=http://localhost:3000`，优先级高于配置文件。）

4. 跑 `lasso doctor`，看 `#37 steel_endpoint_reachable` 是 `pass`（GET `/health` 通）还是 `warn`（没配 / 不可达）。

**费用**：**完全免费**（自托管，无 per-session 费）。代价是要自己维护一个 Docker 容器——机器关机后下次 `docker start` 重启即可（用了 `-d` 的容器不会自动重启，可加 `--restart unless-stopped` 让它开机自启）。

**与托管型（browserbase / stagehand）对比**：

| 维度 | Steel 自托管 | browserbase / stagehand 托管型 |
|---|---|---|
| 费用 | ✅ **完全免费** | ⚠️ 试用后按量付费 |
| 登录 cookie | ✅ **不出本地**（在你的 Docker 里） | 出本地（发到云端） |
| 反检测能力 | ✅ 内置指纹伪装 + stealth 插件（更强） | 依赖 Lasso 注入 |
| 部署复杂度 | 自己跑一个 Docker 容器 | 注册账号拿 key 即可 |
| 适合谁 | 想零成本、不想 cookie 出本地 | 不想维护 Docker、能接受付费 |

---

### `BROWSERBASE_API_KEY` —— 云端反爬 Chrome（托管型·付费）

**去哪申请**：<https://www.browserbase.com/>

1. 打开 [browserbase.com](https://www.browserbase.com/)，注册。
2. Dashboard → API Keys → 新建并复制。

**免费额度**：100 分钟试用（之后按用量付费）。

### `STAGEHAND_API_KEY` —— AI 友好的页面观察（程序化实验通道）

> ⚠️ **状态说明（重要）**：Stagehand 在 Lasso 中是**程序化实验通道**——配了 key 只会装配内部 channel 与熔断器，**没有对应的 MCP 工具入口**（`tools/list` 里不会出现 stagehand 工具）。其 `/verify|/extract` REST 契约未经验证（wave1 裁决 R-ECO-6；v1.12 复核补记：上游托管 REST 已上线但形状是 `sessions.*` 生命周期 API、无 `/verify` 路由、v0 unstable——本通道契约仍无佐证；`lasso doctor` #39 `stagehand_rest_contract_probe` 专测此项）。要实际过 Cloudflare 级反爬，请用 [Steel 自托管](#steel_endpoint--自托管云浏览器v16-新推荐免费) 或 browserbase。

**去哪申请**：<https://api.stagehand.dev>

1. 打开 [api.stagehand.dev](https://api.stagehand.dev)，注册。
2. 复制 API key。

**怎么配**：

**写进 `~/.lasso/config.json`**（注意布尔值用 `true` 不是字符串）：

```json
{
  "ZHIPU_API_KEY": "你的智谱key",
  "LASSO_ALLOW_CLOUD_BROWSER": true,
  "BROWSERBASE_API_KEY": "你的browserbasekey"
}
```

（env 覆盖：`export LASSO_ALLOW_CLOUD_BROWSER=true` + `export BROWSERBASE_API_KEY=...`，优先级高于配置文件。）

---

## E. 高级调优（可选，全不配）

日常使用**完全不用管**下面这些。只在特殊场景才需要：

| 变量 | 用途 | 默认值 | 什么时候改 |
|---|---|---|---|
| `LASSO_CDP_PORT` | 登录态 Chrome 的调试端口 | `9222` | 端口被其他程序占用 |
| `LASSO_CACHE_DIR` | 缓存 / 状态文件根目录 | `~/.cache/lasso` | 想换存储位置（如放外置盘） |
| `LASSO_SEARCH_FREE_ONLY` | 是否禁用付费搜索源 | `L4`（全部允许） | 设 `L2` 只用免费源 |
| `LASSO_SSRF_ALLOW_RANGES` | 允许访问的内网 IP 段（CIDR） | 内置安全默认 | 公司内网 / 特殊代理环境 |
| `LASSO_SSRF_DENY_RANGES` | 禁止访问的 IP 段（CIDR） | 内置安全默认 | 需要额外封禁某段 |
| `LASSO_RECORD_SEARCH` | 是否落盘搜索结果快照（做回归用） | `false` | 想做搜索回归 / 调试 |
| `LASSO_HEADLESS_IDLE_MS` | 无头浏览器空闲多少毫秒后自动回收 | `300000`（5 分钟） | 高频连用想免冷启动 → 配 `3600000`（1 小时）；配 `0` 完全禁用（浏览器常驻到 server 退出） |
| `LASSO_LAUNCH_MODE` | `launch-chrome` 启动档：`hidden`（零窗口零打扰）/ `visible`（v1.9 可见行为） | `hidden` | 想看着它干活配 `visible`；非法值自动回退 `hidden` |
| `LASSO_LAUNCH_IDLE_MS` | launch-chrome 起的 Chrome「用完即关」空闲阈值（server 进程内 15s 周期回收） | `60000`（60 秒） | 想回退 5 分钟配 `300000`；要逼近瞬时配 `1000`（轻交互场景会频繁付 ~11s 重冷启动）；配 `0` 禁用（常驻到 `chrome-stop`）。注意与 `LASSO_HEADLESS_IDLE_MS` 分工不同：这个管 launch-chrome 起的独立 Chrome，那个管无头浏览器子进程 |
| `LASSO_PROXY` | 浏览器出口代理（v1.11 新增） | 空（直连） | 反封锁 / 代理网络环境。**只影响 `browse_headless`（`--proxy-server`）和 Steel 云浏览器（session `proxyUrl`）**；`browse_logged_in` 永不读取——你真实 Chrome 的出口保持原样。例：`"LASSO_PROXY": "http://127.0.0.1:7890"`。配没配可用 `lasso doctor` 看 `proxy_config` 回显 |
| `ZHIPU_ENDPOINT` | 智谱端点覆盖 | 智谱官方端点 | 自建反代时 |

> 关于 fake-ip 代理网络：如果你用 Surge / Clash 的 TUN 模式（fake-ip），`198.18.0.0/15` 网段已内置放行，无需额外配置 `LASSO_SSRF_ALLOW_RANGES`。
>
> 关于本机回环：`127.0.0.1/32` **默认放行——这是设计行为**，供 `browse_logged_in` 连本机 Chrome 的 CDP 调试端口（`127.0.0.1:9222`）；`127.0.0.0/8` 的其余地址（如 `127.0.0.2`）仍默认拒。不是安全漏洞，也无需配置。

### `LASSO_PROXY` —— 浏览器出口代理（可选，v1.11 新）

**什么场景配**：无头浏览器抓的站点有地区限制 / 想统一出口 IP 反封锁，或你的网络必须经代理才能出公网。

**只影响谁（铁律）**：

- ✅ `browse_headless`（无头浏览器，经 `--proxy-server` 下发）
- ✅ Steel 自托管云浏览器（session 级 `proxyUrl`）
- ❌ **`browse_logged_in` 永不读取这个配置**——你真实 Chrome 的出口保持原样，登录态浏览绝不被改道（这是设计，不是漏配）

**怎么配**（写进 `~/.lasso/config.json`）：

```json
{
  "LASSO_PROXY": "http://127.0.0.1:7890"
}
```

（env 覆盖：`export LASSO_PROXY=http://127.0.0.1:7890`，优先级高于配置文件。）

**验证**：跑 `lasso doctor`，看 `proxy_config` 项的回显（配没配、生效面说明；只回显不探活——代理本身通不通，doctor 不替你测）。

### `LASSO_COOKIE_PASSPHRASE` —— 登录 cookie 加密口令（可选）

默认情况下，Lasso 用 **macOS 钥匙串**（Keychain）保护你的登录 cookie。如果你不在 macOS、或想跨机器使用同一份加密 cookie，可以显式设一个口令：

**写进 `~/.lasso/config.json`**：

```json
{
  "LASSO_COOKIE_PASSPHRASE": "一串足够长的密码"
}
```

（env 覆盖：`export LASSO_COOKIE_PASSPHRASE=...`，优先级高于配置文件。）

设了之后，cookie 会用这个口令加密落盘（不设则走系统钥匙串）。**口令丢失 = cookie 无法解密**，请妥善保管。

---

## F. 配完怎么验证？

```bash
lasso doctor
```

跑一次自检。它会告诉你：
- 哪些 key 已配、哪些没配
- 登录态 Chrome 是否已启动
- 桌面授权是否通过
- 缓存目录是否可写

doctor 的检查项随版本持续增长（**以 `lasso doctor` 实跑输出为准**，不在这里背数字），其中几个跟本指南相关的关键项：`#36 machine_search_mcp`（机器智谱 MCP 是否复用）、`#37 steel_endpoint_reachable`（Steel Docker 是否可达，v1.6 新）、`#38 stealth_creepjs_regression`（反检测回归门禁，v1.7 新，需 `lasso doctor --stealth-check` 才实跑——它会驱动 creepjs 检测页对比基线，验证 `browse_headless` 的反检测效果）、`#21 tcc_event_synthesizing`（macOS 15+ 事件合成授权，坐标鼠标用，v1.11 新）；另有 `proxy_config` 回显（`LASSO_PROXY` 配没配、只影响无头/Steel，v1.11 新）。

`ready: true` 就可以正常用了。**遇到任何错误，第一步永远是 `lasso doctor`。**

---

## 完整配置示例（一次配齐）

**推荐：写进 `~/.lasso/config.json`**（跑 `lasso config init` 创建模板，按需编辑）：

```json
{
  "ZHIPU_API_KEY": "你的智谱key",
  "BRAVE_API_KEYS": "bravekey1,bravekey2,bravekey3",
  "BING_API_KEYS": "bingkey1,bingkey2"
}
```

然后跑一次自检：

```bash
lasso doctor
```

> 用其他 MCP client 想走 env？把上面 JSON 的键值对填进 server 的 `env` 块即可（env 优先级**高于**配置文件；见 [A 节智谱示例](#1-智谱zhipu_api_key-默认引擎中文主力)的 JSON 片段）。安装命令本身仍是零配置的 `claude mcp add lasso -- npx -y lasso-mcp`。

---

> 配置遇到问题？先看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)；想懂内部架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。
