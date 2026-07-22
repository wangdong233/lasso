# Lasso

> Claude Code 的「全交互对外抓手」—— 搜、抓、登录态抓、控桌面，一个 MCP 全包。牛仔套索，套住任何界面。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Status: stable](https://img.shields.io/badge/status-stable--v1.2.0-green)]()
[![npm version](https://img.shields.io/badge/npm-lasso--mcp%401.2.0-blue)](https://www.npmjs.com/package/lasso-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-macOS%20full%20%C2%B7%20Win%2FLinux%20compile--verified-orange)]()

与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：「所有图像操作归一个 MCP」↔「所有外部交互归一个 MCP」。

**v1.2.0 稳定版**。70 条架构不变量 / 1416+ TS 单测 / 179 Rust 单测 CI 守门。

---

## 目录

- [你说一句话，得到什么](#你说一句话得到什么)
- [60 秒上手](#60-秒上手)
- [能力全家桶](#能力全家桶)
- [配置详解](#配置详解)
- [工具完整清单（15）](#工具完整清单15)
- [隐私与安全](#隐私与安全)
- [故障排查](#故障排查)
- [这是给谁的](#这是给谁的)
- [架构与开发](#架构与开发)
- [License](#license)

---

## 你说一句话，得到什么

| 你说 …… | 你得到 |
|---|---|
| 「搜一下 rust async 生态最新动态」 | 结构化搜索结果（多引擎 fallback，≈永不失败） |
| 「抓一下 github.com 首页文字」 | 干净 markdown（自动剥导航/广告，省 30–70% token） |
| 「打开我已登录的 Jira 看看待办」 | 登录态页面快照（复用本机 Chrome，2FA 你自己解） |
| 「这个 URL 404 了，找找存档」 | Wayback Machine 最近快照元数据 |
| 「把 Finder 当前窗口的文件列出来」 | macOS AX 语义树（OutlineNode，非截图） |
| 「截个整页 PNG」「存成 PDF」 | 落盘文件路径（不灌 base64 进上下文） |
| 「这个页面加载了哪些第三方 tracker」 | 资源列表 + 第三方计数（PerformanceObserver 注入） |
| 「列一下我现在能控的所有窗口和标签」 | 统一 `@pN`/`@wN` 列表（browse + desktop 一入口） |
| 「控制一下系统设置，把深色模式关掉」 | desktop act（click/type/hotkey，带 `expect` 验证） |
| 「GET 这个 JSON API」 | 原始字节（4× 快、4× 便宜于 browse） |
| 「我这个 Cloudflare 站点抓不动」 | 云 Chrome 反爬通道（默认 OFF，需显式 opt-in） |
| 「Lasso 现在健康吗，配置对吗」 | doctor 32 项 readiness JSON |

> 不用记通道名，Claude 自动挑最合适的方式完成；降级对 CC 透明。

---

## 60 秒上手

### 30 秒｜一行接入（零 Key）

```bash
# Claude Code 配置（推荐）
claude mcp add lasso --scope user -- npx -y lasso-mcp@1.2.0
```

重启 CC → `/mcp` → `lasso ✓ Connected`。

### 30 秒｜免 Key 立刻能用

装完不用配任何东西，下面这些就能跑：

- `browse_headless` 抓公开页 / JS SPA
- `fetch_url` 直抓 JSON / 字节
- `screenshot` 整页 PNG / `pdf` 存档
- `network` 第三方资源审计
- `desktop` 控 macOS 原生 app（Finder / Mail / Safari / Notes / 系统设置）

直接对 Claude 说：

> 「抓一下 example.com 的文字，转成 markdown」

### 想要更多？配一行（可选）

- **搜索多源**：`ZHIPU_API_KEY`（必，默认引擎）+ `BRAVE_API_KEYS` / `BING_API_KEYS`（可选 fallback）
- **登录态浏览**：`lasso launch-chrome`（启动 `:9222` CDP Chrome）
- **desktop macOS**：`lasso doctor`（引导 TCC 授权）
- **desktop Win/Linux**：首次调用弹 UIA 授权 / 确保 AT-SPI2 已装

---

## 能力全家桶

按你**想干什么**分组，不按工具名。每组都是一句话进、一句话出。

### 搜（关键词 → 结果）

> 你：「搜一下 X」 → 多引擎 fallback 结果（≈永不失败）

智谱 → Brave → Bing → browse_headless 实搜 → Wayback → 录制回放，自动降级，你无感。

### 抓公开页（无登录）

> 你：「抓 example.com 文字」 → `markdown` / `markdown_cited` / `raw` 三档

v1.1 起 `extract_mode` 支持 markdown 抽取（defuddle + turndown JS 原生引擎），自动剥导航/广告/冗余 DOM，**省 30–70% token**。`markdown_cited` 附引用角标，适合 RAG/引用场景。

### 抓登录态页（有 2FA）

> 你：「看看我 Jira 待办」 → 登录态快照（2FA 你解）

复用你本机已登录的 Chrome（`:9222` CDP）。**2FA 红线：Lasso 不解 2FA / CAPTCHA / magic-link**，链止返 `NEEDS_MANUAL_2FA`。

### 直抓字节（最快最便宜）

> 你：「GET 这个 JSON API」 → 原始字节

`fetch_url` 比 `browse_headless` 快约 4×、便宜约 4×，body 按 `Content-Type` 路由（JSON / 文本 / 二进制）。

### 看图 / 存档

> 你：「截个整页 PNG」「存成 PDF」 → 落盘文件路径

PNG / PDF 都落盘返回路径，**不灌 base64 进上下文**。PDF 走上游能力，不支持时优雅降级到截图。

### 审计网络

> 你：「这页加载了哪些第三方」 → 资源列表 + tracker 计数

PerformanceObserver 注入抓资源时序，第三方域名聚合计数。

### 控桌面原生 app

> 你：「关掉深色模式」「读一下 Mail 收件箱」 → desktop act（AX 语义）

三平台同构 `OutlineNode` 契约；macOS AXAPI 本机验证，Windows UIA / Linux AT-SPI 编译可证（详见 [架构与开发](#架构与开发) 边界声明）。v1.2 起 `interactive_only` 模式只返可交互节点，进一步省 token。

### 跨 surface 统一调度

> 你：「列一下我能控的所有窗口」 → `@pN`/`@wN` 一列表

forest 统一入口：browse 页面（`@pN`）和 desktop 窗口（`@wN`）共用一套根/观察/动作语义，model 只挑一次 root，后续 observe/act 不重路由。

### 死链救活

> 你：「这个 URL 404 了」 → Wayback 快照元数据

独立工具 `wayback_lookup`，不自动探测（避免误判活链）。

### 反爬强攻（默认关）

> 你：「Cloudflare 站点抓不动」 → 云 Chrome

`browserbase` 云 Chrome 反爬，**默认 OFF**，需 `LASSO_ALLOW_CLOUD_BROWSER=true` + API key 双重解锁。

---

## 配置详解

按「**我想干什么**」查表，不用读参数清单。

| 你想干什么 | 要配什么 | 配了立刻能用 |
|---|---|---|
| 抓公开页 / desktop / fetch / screenshot / pdf / network | 什么都不用配 | 装完即用 |
| search（默认智谱） | `ZHIPU_API_KEY` | 多引擎 fallback 主入口 |
| search ≈永不失败（多源） | + `BRAVE_API_KEYS` / `BING_API_KEYS` | 自动降级，你无感 |
| browse_logged_in | `lasso launch-chrome`（启 `:9222`） | 复用本机 Chrome 登录态 |
| desktop macOS | `lasso doctor`（引 TCC） | 控原生 app |
| desktop Windows | 首次弹 UIA 授权 | 控原生 app（真机手测 pending） |
| desktop Linux | 确保 AT-SPI2 已装 | 控原生 app（真机手测 pending） |
| markdown 抽取（省 token） | 什么都不用配 | 调用时 `extract_mode=markdown` |
| 云 Chrome 反爬 | `LASSO_ALLOW_CLOUD_BROWSER=true` + `BROWSERBASE_API_KEY` | 默认 OFF，双重解锁 |
| fake-ip 代理网络（Surge/Clash TUN） | 什么都不用配 | `198.18.0.0/15` 已内置放行 |

### 配置示例（Claude Code / 通用 MCP client，stdio）

```bash
# 搜索（必）
export ZHIPU_API_KEY=...                # 智谱（默认引擎）

# 搜索（可选多源 fallback）
export BRAVE_API_KEYS=key1,key2,...     # Brave（CSV 多 key 轮询）
export BING_API_KEYS=key1,key2,...      # Bing 第三源

# browse_logged_in：启动带 :9222 CDP 的 Chrome
lasso launch-chrome                     # 跨平台路径探测（macOS/Linux/Windows）

# desktop macOS：自检并引导 TCC 授权
lasso doctor                            # 32 项 readiness 检查

# desktop Windows：首次调用系统弹 UIA 授权（与 macOS TCC 等效）
# desktop Linux：确保 AT-SPI2 已装（大多数 GNOME/MATE 桌面默认有）
```

### 自动兜底（配了就不用管）

- **search**：智谱 → Brave → Bing → browse_headless 实搜 → Wayback → 录制回放
- **desktop**：`ax` → `appleScript` → `cgEvent` → `screenshotVlm` 四档降级
- **唯一例外**：2FA 不解（红线，链止返 `NEEDS_MANUAL_2FA`）

### lasso doctor（自检）

```bash
lasso doctor
```

输出 32 项 readiness JSON：`lasso_version` / `platform_backend_active` / `recording_baseline_count` / TCC 状态 / 各 channel 健康度 等。`ready: true` 即可正常使用。**遇到任何错误，先跑 `lasso doctor`。**

---

## 工具完整清单（15）

| 工具 | 通道 | 一句话用途 |
|---|---|---|
| `search` | search | 多引擎 fallback 搜索（`engine=auto/fallback_chain/zhipu/brave`） |
| `wayback_lookup` | search | 死链救活（独立 tool，不自动探测） |
| `browse_headless` | browse | 公开页无头浏览（navigate/snapshot/extract/click/fill/wait/evaluate；+ markdown 抽取 v1.1） |
| `browse_logged_in` | browse | 登录态浏览（复用本机 Chrome；2FA 红线） |
| `fetch_url` | fetch | 直 HTTP 抓原始字节（最快最便宜，按 Content-Type 路由） |
| `screenshot` | browse | 整页 PNG 落盘（非 base64） |
| `pdf` | browse | 页面存 PDF（上游不支持时优雅降级） |
| `network` | browse | 第三方资源审计（PerformanceObserver 注入） |
| `desktop` | desktop | 控原生 app（snapshot/find/act/wait/screenshot/doctor；v1.2 `interactive_only` 省 token） |
| `interact_roots` | forest | 列 `@pN`/`@wN` 统一根（browse + desktop 一入口） |
| `interact_observe` | forest | 跨 surface 只读 observe（snapshot/find） |
| `interact_act` | forest | 跨 surface 副作用 act（navigate/click/fill/type…） |
| `browserbase` | cloud | 云 Chrome 反爬（默认 OFF，双重 opt-in） |
| `admin` | — | 运行时加减通道 / provider（capability_list/disable/enable、tool_list、provider_add/remove/set_tos、caller_cap_set/list，共 9 action） |
| `doctor` | — | 32 项 readiness 自检 JSON |

完整字段定义见源码 `src/tools/*.ts` 的 `inputSchema`（每个工具都注册了完整的 Zod schema + `ToolAnnotations`）。

---

## 隐私与安全

- **cookie = 身份**：`browse_logged_in` 不导出用户 cookie；除非用户**显式 opt-in** `admin` action 且经 **AES-256-GCM 加密**落盘（mode `0o600` + IV 唯一 + auth tag 验签）。`doctor` 永不清读 cookie 内容，只报「是否已配置」。实现细节（密钥派生 / 存储位置）不下沉到 README，见 `ARCHITECTURE.md`。
- **SSRF 防护**：所有外网请求经 `allowRanges` 守门（默认拒私有 IP；fake-ip 环境 `198.18.0.0/15` + `127.0.0.1/32` CDP 内置放行；`LASSO_SSRF_ALLOW_RANGES` 可扩）。
- **desktop audit log**：所有 `desktop act` 落 JSONL audit log（本地，10MB 轮转，零遥测）。
- **录制 opt-in**：`LASSO_RECORD_SEARCH=true` 才落盘 SERP 快照（默认 OFF）。
- **零远程 telemetry**：所有指标进程内，不上报任何第三方。
- **云浏览器双重解锁**：`browserbase` 默认 OFF，须 env + API key 双重确认。

---

## 故障排查

**遇到任何错误，第一步永远是 `lasso doctor`。**

| `error_kind` | 释义 | 下一步 |
|---|---|---|
| `tcc_denied` | macOS Accessibility / Screen Recording 未授权 | System Settings → Privacy & Security → 勾选 `lasso-rust-helper` |
| `NEEDS_MANUAL_2FA` | 站点要 2FA（红线，Lasso 不解） | 本机 Chrome 手动登 → 回到 `browse_logged_in` |
| `not_macos` / `not_windows` / `not_linux` | helper binary 平台不匹配 | 重装对应平台 binary |
| `unsupported_platform:<x>` | AxBackend 不支持该 platform | 支持 `darwin` / `win32` / `linux` |
| `recording_replay_miss` | 全源熔断 + 无录制基线 | 配 `LASSO_RECORD_SEARCH=true` 录一份基线兜底 |
| `upstream_unsupported:pdf` | chrome-devtools-mcp 不支持 pdf | 改用 `browse_headless` + `action="screenshot"` |
| `upstream_unsupported:network` | chrome-devtools-mcp 不支持 evaluate | 改用 `browse_headless` + `action="evaluate"` |
| `ssrf_blocked` | URL 命中私有/保留 IP 段 | 检查 URL；fake-ip 网络确认 `198.18.0.0/15` 已放行 |

完整 FAQ + 调试技巧见 [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md)。

---

## 这是给谁的

**适合**

- **Claude Code 重度用户**：每周都要搜 / 抓 / 控桌面，不想装 N 个 MCP
- **数据 / 研究 / 调研**：`fetch_url` markdown 抽取 + `search` 多源 + `wayback_lookup` 死链救活
- **自动化 / DevOps**：`desktop act` 控原生 app（macOS 主战场）
- **RAG / LLM 应用**：`markdown_cited` 引用角标 + 省 token
- **跨平台工具开发者**：Win/Linux 编译可证，OutlineNode 契约同构

**不太适合**

- 不用 Claude Code 的（Lasso 是 MCP，依赖 MCP client）
- 只要单一能力且已搭好专方案的
- 需要绕 2FA / CAPTCHA 的（红线，做不到）

---

## 架构与开发

> 本节面向贡献者。日常使用不需要读。

- **权威架构**：[`ARCHITECTURE.md`](./ARCHITECTURE.md) — 分层图 / data flow / 设计原则 / 边界
- **深度架构基线**：[`doc/08`](./../doc/08-media-interact-功能架构.md) — F 编号、能力矩阵、不变量
- **实施排期**：[`doc/09`](./../doc/09-media-interact-实施排期.md) — v0.1 → v1.2 能力跃升路径
- **桌面演进**：[`doc/13`](./../doc/13-全交互抓手重设计.md) — 全交互重设计
- **selector 维护**：[`doc/SELECTOR-MAINTENANCE.md`](./doc/SELECTOR-MAINTENANCE.md) — 录制回放回归 + 改版检测

### 开发命令

```bash
npm install                                # 装依赖
npm run build                              # TypeScript 编译
npm run check-invariants                   # 架构不变量检查（70 条；CI 强制）
npm test                                   # 全量单测（1416+ TS）
npm run replay-baseline                    # SERP 录制回放回归（selector 改版检测）

# Rust helper（macOS 本机；跨平台 backend）
cd rust-helper && cargo build && cargo test                                   # macOS 零回归
cd rust-helper && cargo check --target x86_64-pc-windows-msvc                 # 验 Windows 编译
cd rust-helper && cargo check --target x86_64-unknown-linux-gnu               # 验 Linux 编译
```

### 跨平台 desktop 现实边界（诚实声明）

| 平台 | backend | 状态 |
|---|---|---|
| macOS | AXAPI | 本机运行时验证 |
| Windows | UIA | `cargo check --target` 编译可证 + 契约层 CI 单测；**真机手测 pending** |
| Linux | AT-SPI | `cargo check --target` 编译可证 + 契约层 CI 单测；**真机手测 pending** |

Win/Linux 的 OutlineNode 三平台同构契约经 CI 单测守，但真实运行时执行留手测清单（`parse11-acceptance.md` 标 pending），待真 Windows / Linux 环境社区反馈。**不伪造「已验证 Windows / Linux」。**

### 设计原则（用户可感知的 4 条承诺）

1. **状态写盘省 token**：页面 DOM / 桌面 OutlineNode 写 `~/.cache/lasso/state/`，返短 `state_id`（约 4× token 效率）
2. **诚实三态交付**：`worked / didnt / unknown`——event delivery ≠ semantic success，不伪造成功
3. **四通道共享一套降级**：search / browse / fetch / desktop 共用 fallback 范式 + 状态模型 + 工具风格
4. **平台差异隔离在 backend 内部**：TS 层不出现平台字面量，AxBackend 三平台同构契约

> 完整 7 条设计原则（含 R-CI-02 / INV-21/60/61 等架构不变量编号）见 `ARCHITECTURE.md`。

---

## License

MIT © wangdong233

Rust helper 使用官方 `windows` crate（Windows UIA）/ `atspi` crate（Linux AT-SPI）；`chrome-devtools-mcp` 上游契约锁版本，避免上游升级破坏 Lasso。

---

> Built for everyone who'd rather say it than script it.
> 装一次，搜 / 抓 / 登录态抓 / 控桌面都是一句话。
