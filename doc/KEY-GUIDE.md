# Lasso Key 获取与配置指南

这份手册讲清楚：**每个 key 用在哪、去哪申请、有没有免费额度、配在哪里**。

> **配置位置说明（重要，先读）**
> Lasso 当前只读取**进程环境变量**（`process.env`），**暂不读取** `~/.claude.json`。也就是说：
> - 用 **Claude Code** 时，请用 `claude mcp add -e KEY=VAL` 把 key 注入 MCP 进程的 env，或写进你 MCP client 配置里对应的 `env` 块。
> - 用**其他 MCP client** 时，把 key 写进该 client 的 MCP server `env` 配置，或直接放在 shell 的 `~/.zshrc` / `~bashrc` 里。
> - 后续版本会合并读取 `~/.claude.json`（代码里已留接口），届时此段会更新。

---

## 快速对照表

| key / 变量 | 用途 | 哪里获取 | 必填 | 免费额度 |
|---|---|---|---|---|
| `ZHIPU_API_KEY` | 搜索（默认引擎，中文主力） | [智谱开放平台](https://open.bigmodel.cn/console/apikey) | 要用搜索就**必填** | 按 token 计费（有新用户额度） |
| `BRAVE_API_KEYS` | 搜索第二源（自动降级用） | [Brave Search API](https://brave.com/search/api/) | 否 | **2000 次/月**（Free 计划） |
| `BING_API_KEYS` | 搜索第三源（再兜底） | [Azure 门户](https://portal.azure.com/) | 否 | **1000 次/月**（F0 免费层） |
| `LASSO_ALLOW_CLOUD_BROWSER` | 云浏览器总开关（值设 `true`） | 无需申请 | 启用云浏览器时**必填** | — |
| `BROWSERBASE_API_KEY` | 云端反爬 Chrome | [browserbase.com](https://www.browserbase.com/) | 启用 browserbase 时**必填** | **100 分钟试用**（之后付费） |
| `STAGEHAND_API_KEY` | AI 友好的页面观察 | [api.stagehand.dev](https://api.stagehand.dev) | 启用 stagehand 时**必填** | 试用（付费为主） |
| `LASSO_COOKIE_PASSPHRASE` | 登录 cookie 加密口令 | 自己设一串足够长的密码即可 | 否 | — |

> **多 key 轮询**：`BRAVE_API_KEYS` / `BING_API_KEYS` 都支持 **CSV 多 key**（`k1,k2,k3`）。N 个 key = N 倍免费额度，自动轮询、单 key 失败自动换下一个。

---

## A. 搜索

### 1. 智谱（`ZHIPU_API_KEY`）—— 默认引擎，中文主力

**去哪申请**：<https://open.bigmodel.cn/console/apikey>

**步骤**：
1. 打开 [智谱开放平台](https://open.bigmodel.cn/console/apikey)，注册账号（手机号即可）。
2. 进入「API Keys」页面，点「创建 API Key」。
3. 复制生成的 key（格式形如 `xxxxxxxxxxxxx.yyyyyyyyyyyyy`，即 `{id}.{secret}`）。

**怎么配**：

```bash
# Claude Code（推荐）
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=你刚才复制的key \
  -- npx -y lasso-mcp@1.2.0
```

或写进其他 MCP client 的 `env` 块：

```json
{
  "mcpServers": {
    "lasso": {
      "command": "npx",
      "args": ["-y", "lasso-mcp@1.2.0"],
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

### 2. Brave Search（`BRAVE_API_KEYS`）—— 可选，第二源

**去哪申请**：<https://brave.com/search/api/>

**步骤**：
1. 打开 [Brave Search API](https://brave.com/search/api/)，注册账号。
2. 选择 **Free** 计划（每月 2000 次查询，无需信用卡）。
3. 在 Dashboard 复制你的 API key。

**怎么配**：

```bash
# 单 key
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=你的智谱key \
  -e BRAVE_API_KEYS=你的bravekey \
  -- npx -y lasso-mcp@1.2.0

# 多 key 轮询（推荐，3 个 key = 6000 次/月）
# -e BRAVE_API_KEYS=k1,k2,k3
```

**免费额度**：**2000 次查询/月**（Free 计划）；多 key 线性叠加。

---

### 3. Bing / Azure（`BING_API_KEYS`）—— 可选，第三源

**去哪申请**：<https://portal.azure.com/>

**步骤**：
1. 登录 [Azure 门户](https://portal.azure.com/)（需微软账号）。
2. 「创建资源」→ 搜索 **「Bing Search v7」** → 创建。
3. 定价层选 **F0 Free**（每月 1000 次）。
4. 创建完成后，在「密钥和终结点」页复制 `Ocp-Apim-Subscription-Key`（这就是 `BING_API_KEYS` 的值）。

**怎么配**：

```bash
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=你的智谱key \
  -e BRAVE_API_KEYS=你的bravekey \
  -e BING_API_KEYS=你的bingkey \
  -- npx -y lasso-mcp@1.2.0
```

**免费额度**：**1000 次/月**（F0 免费层）。新订阅可用性受限，配了不用也不影响主流程。

> 配齐智谱 + Brave + Bing 三家后，搜索「≈永不失败」——任一家临时限流/挂掉，自动切下一家，你无感。

---

## B. 登录态浏览（命令行配置，无 key）

### `lasso launch-chrome`

要抓「你已登录的页面」（Jira 待办、GitHub 私有仓库、公司内网等），先启动一个带调试端口的 Chrome，它会**复用你本机 Chrome 的全部登录态**（包括 2FA 你自己解过的会话）。

**怎么配**：

```bash
lasso launch-chrome
```

跑一次即可。命令会自动探测 macOS / Linux / Windows 上的 Chrome 路径并启动，之后对 Claude 说「打开我已登录的 Jira」就会自动连上。

> 桌面端口默认 `9222`，被占用时可用 `LASSO_CDP_PORT=9223` 改端口（见 [高级调优](#e-高级调优可选全不配)）。

---

## C. 桌面控制（系统授权，无 key）

### macOS：`lasso doctor`

要在 macOS 上控制原生 app（Finder / Mail / Safari / Notes / 系统设置等），需要给 Lasso 的桌面辅助进程授权。

**怎么配**：

```bash
lasso doctor
```

按提示打开 **「系统设置 → 隐私与安全 → 辅助功能」** 和 **「屏幕录制」**，把 `lasso-rust-helper` 勾上即可。`doctor` 会一步步引导，不需要你手动找路径。

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

默认**完全关闭**。仅当你需要抓被 Cloudflare / 反爬严重的站点时才开启。开启需要**两个条件同时满足**：

1. `LASSO_ALLOW_CLOUD_BROWSER=true`（总开关）
2. 至少一个云 key（`BROWSERBASE_API_KEY` 或 `STAGEHAND_API_KEY`）

缺任一，云通道行为完全等价于「没配」（零回归）。

### `BROWSERBASE_API_KEY` —— 云端反爬 Chrome

**去哪申请**：<https://www.browserbase.com/>

1. 打开 [browserbase.com](https://www.browserbase.com/)，注册。
2. Dashboard → API Keys → 新建并复制。

**免费额度**：100 分钟试用（之后按用量付费）。

### `STAGEHAND_API_KEY` —— AI 友好的页面观察

**去哪申请**：<https://api.stagehand.dev>

1. 打开 [api.stagehand.dev](https://api.stagehand.dev)，注册。
2. 复制 API key。

**怎么配**：

```bash
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=你的智谱key \
  -e LASSO_ALLOW_CLOUD_BROWSER=true \
  -e BROWSERBASE_API_KEY=你的browserbasekey \
  -- npx -y lasso-mcp@1.2.0
```

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
| `ZHIPU_ENDPOINT` | 智谱端点覆盖 | 智谱官方端点 | 自建反代时 |

> 关于 fake-ip 代理网络：如果你用 Surge / Clash 的 TUN 模式（fake-ip），`198.18.0.0/15` 网段已内置放行，无需额外配置 `LASSO_SSRF_ALLOW_RANGES`。

### `LASSO_COOKIE_PASSPHRASE` —— 登录 cookie 加密口令（可选）

默认情况下，Lasso 用 **macOS 钥匙串**（Keychain）保护你的登录 cookie。如果你不在 macOS、或想跨机器使用同一份加密 cookie，可以显式设一个口令：

```bash
-e LASSO_COOKIE_PASSPHRASE=一串足够长的密码
```

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

`ready: true` 就可以正常用了。**遇到任何错误，第一步永远是 `lasso doctor`。**

---

## 完整配置示例（一次配齐）

```bash
# Claude Code（推荐）
claude mcp add lasso --scope user \
  -e ZHIPU_API_KEY=你的智谱key \
  -e BRAVE_API_KEYS=bravekey1,bravekey2,bravekey3 \
  -e BING_API_KEYS=bingkey1,bingkey2 \
  -- npx -y lasso-mcp@1.2.0

# 然后跑一次自检
lasso doctor
```

其他 MCP client，把上面 `-e KEY=VAL` 的键值对填进 server 的 `env` 块即可（见 [A 节智谱示例](#1-智谱zhipu_api_key-默认引擎中文主力)的 JSON 片段）。

---

> 配置遇到问题？先看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)；想懂内部架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。
