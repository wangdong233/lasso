# Lasso

> CC 的**全交互**对外抓手 MCP（浏览器 + 桌面）。牛仔套索，"套住任何界面"。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Status: stable](https://img.shields.io/badge/status-stable--v1.0-green)]()
[![npm version](https://img.shields.io/badge/npm-lasso--mcp%401.0.0-blue)](https://www.npmjs.com/package/lasso-mcp)

## 这是什么（30 秒读完）

Lasso 让 Claude Code 通过这**唯一一个** MCP，高效和**浏览器 + 桌面**交互。与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：「所有图像操作归一个 MCP」↔「所有外部交互归一个 MCP」。

**四通道**：
- `search` — 智谱 / Brave / Bing / Wayback 多引擎 fallback（默认入口，≈永不失败）
- `browse_headless` — chrome-devtools-mcp `--headless --isolated`（干净无头）
- `browse_logged_in` — chrome-devtools-mcp `--browser-url :9222`（复用本机已登录 Chrome，2FA 不解）
- `desktop` — macOS AXAPI / Windows UIA / Linux AT-SPI（三平台语义同构 OutlineNode）

跨模态 fallback 链自动降级（search 失败 → browse_headless 实搜；desktop ax 失败 → screenshotVlm 兜底），对 CC 透明。

**v1.0 稳定版**。权威架构见 [`doc/08`](./../doc/08-media-interact-功能架构.md)，实施排期见 [`doc/09`](./../doc/09-media-interact-实施排期.md)。

## 四通道（能力导向）

| 工具 | 通道 | 后端 | 平台 |
|---|---|---|---|
| `search` | search | 智谱 / Brave / Bing / Wayback 多引擎 fallback | 跨平台 |
| `browse_headless` | browse | chrome-devtools-mcp `--headless --isolated` | 跨平台 |
| `browse_logged_in` | browse | chrome-devtools-mcp `--browser-url :9222` | 跨平台 |
| `desktop` | desktop | macOS AXAPI / Windows UIA / Linux AT-SPI | 三平台 |

## 安装

### 1. 装 Lasso

```bash
# Claude Code 配置（推荐）
claude mcp add lasso --scope user -- npx -y lasso-mcp@1.0.0

# 或全局安装
npm install -g lasso-mcp@1.0.0
```

### 2. 配置（按需）

```bash
# 搜索（必）
export ZHIPU_API_KEY=...               # 智谱（默认引擎）

# 搜索（可选多源 fallback）
export BRAVE_API_KEYS=key1,key2,...    # Brave（CSV 多 key 轮询）
export BING_API_KEYS=key1,key2,...     # Bing（v0.9 第三源）

# browse_logged_in：先启动带 :9222 CDP 的 Chrome
lasso launch-chrome                    # 跨平台路径探测（macOS/Linux/Windows）

# desktop macOS：让 Lasso 自检并引导 TCC 授权
lasso doctor                           # 32 项 readiness 检查

# desktop Windows：首次调用时系统会弹 UIA 授权（与 macOS TCC 等效）
# desktop Linux：确保 AT-SPI2 已装（大多数 GNOME/MATE 桌面默认有）

# 可选：fake-ip 代理网络（Surge/Clash TUN 段；默认拒私有 IP）
# Lasso 已默认放行 198.18.0.0/15，无需额外配置
```

### 3. 自检

```bash
lasso doctor
```

输出 32 项 readiness JSON：`lasso_version` / `platform_backend_active` / `recording_baseline_count` / TCC 状态 / 各 channel 健康度 等。`ready: true` 即可正常使用。

## 工具列表（4 能力工具 + admin + doctor）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `search(query, limit, engine, region)` | 关键词搜索（多引擎 fallback） | `engine="auto"` 默认；`engine="fallback_chain"` 显式走全链 |
| `browse_headless(url, action, options)` | 无头浏览（snapshot/click/fill/scroll/wait/...） | `action` enum |
| `browse_logged_in(url, action, options)` | 复用登录态浏览（2FA 不解） | 需 `:9222` CDP |
| `desktop(action, options)` | 控原生 app（snapshot/find/act/...） | `action` enum；三平台同构 OutlineNode |
| `admin(action, ...)` | 运行时管理（channel_health / reset / profile_list / profile_switch / cookie_restore / ...） | `action` enum |
| `doctor()` | readiness JSON | — |

完整字段定义见源码 `src/tools/*.ts` 的 `inputSchema`（每个工具都注册了完整的 Zod schema + ToolAnnotations）。

## 隐私

- **cookie=身份**：`browse_logged_in` 不导出用户 cookie；除非用户显式 opt-in `admin` action 且经 AES-256-GCM 加密落盘（08 §5.1 红线；INV-48..53 守）。
- **SSRF 防护**：所有外网请求经 `allowRanges` 守门（默认拒私有 IP；fake-ip 环境配 `198.18.0.0/15` 已内置；INV-31/32 守）。
- **desktop audit**：所有 `desktop act` 落 JSONL audit log（本地，10MB 轮转，零遥测）。
- **录制 opt-in**：`LASSO_RECORD_SEARCH=true` 才落盘 SERP 快照（默认 OFF；INV-57 守）。
- **无远程 telemetry**：所有指标进程内（INV-43 守）。

## 故障排查（常见 `error_kind`）

| error_kind | 释义 | next_step |
|---|---|---|
| `tcc_denied` | macOS Accessibility / Screen Recording 未授权 | System Settings → Privacy & Security → Accessibility（Screen Recording）→ 勾选 `lasso-rust-helper` |
| `not_macos` / `not_windows` / `not_linux` | helper binary 平台不匹配 | 重装对应平台 binary（`npm install -g lasso-mcp@1.0.0`） |
| `unsupported_platform:<x>` | AxBackendFactory 不支持该 platform | Lasso v1.0 支持 `darwin` / `win32` / `linux` |
| `NEEDS_MANUAL_2FA` | 站点要 2FA（Lasso 不解 2FA，这是红线） | 本机 Chrome 手动登 → 回到 `browse_logged_in` |
| `recording_replay_miss` | 全源熔断 + 无录制基线 | 配 `LASSO_RECORD_SEARCH=true` 录一份基线兜底 |
| `upstream_unsupported:pdf` | chrome-devtools-mcp 不支持 pdf 工具 | 用 `browse_headless` + `action="screenshot"` |
| `upstream_unsupported:network` | chrome-devtools-mcp 不支持 evaluate_script | 等上游支持，或用 `browse_headless` + `action="evaluate"` |
| `ssrf_blocked` | URL 命中私有/保留 IP 段 | 检查 URL；fake-ip 网络确认 `198.18.0.0/15` 已放行 |

完整 FAQ + 调试技巧见 [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md)。

## 架构

架构分层图 + data flow + 设计原则 + 边界 见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

深度架构基线（F 编号、能力矩阵、不变量）见 [`doc/08`](./../doc/08-media-interact-功能架构.md)；v0.1 → v1.0 实施排期与决策记录见 [`doc/09`](./../doc/09-media-interact-实施排期.md)。

selector 维护（v1.0 录制回放回归 + 改版检测流程）见 [`doc/SELECTOR-MAINTENANCE.md`](./doc/SELECTOR-MAINTENANCE.md)。

## 设计原则

1. **能力导向命名**（search / browse_* / desktop，不按后端）
2. **页面/界面状态写磁盘**（不灌上下文，4× token 效率）
3. **诚实三态交付**（`worked / didnt / unknown`）—— event delivery alone is never treated as semantic success
4. **第二套做法红线**（四通道共享一套 fallback 范式 / 状态模型 / 工具风格）
5. **架构不变量脚本化**（CI 守门 65 条，防 refactor 回退）
6. **平台差异隔离在 backend 内部**（AxBackend 三平台同构 OutlineNode 契约；TS 层不出现平台字面量，INV-21/60/61 守）
7. **macOS-only 开发，跨平台编译可证**（Win/Linux backend 经 cfg-gate + `cargo check --target` 验编译；真机执行待社区反馈，不伪造）

## 开发

```bash
npm install                    # 装依赖
npm run build                  # TypeScript 编译
npm run check-invariants       # 架构不变量检查（65 条；CI 强制）
npm test                       # 全量 vitest（≈1400 测试）
npm run replay-baseline        # SERP 录制回放回归（v1.0；selector 改版检测）

# Rust helper（macOS 本机；v1.0 跨平台 backend）
cd rust-helper && cargo build && cargo test                    # macOS 零回归
cd rust-helper && cargo check --target x86_64-pc-windows-msvc  # 验 Windows 编译
cd rust-helper && cargo check --target x86_64-unknown-linux-gnu # 验 Linux 编译
```

## 跨平台 desktop 现实边界（诚实声明）

Lasso v1.0 的 desktop 通道在 macOS 上**本机可运行时验证**；Windows UIA + Linux AT-SPI 经 `cargo check --target` 验证编译可证 + OutlineNode 三平台同构契约层 CI 单测，**但真实 Win/Linux 运行时执行留手测清单**（`parse11-acceptance.md` 标 pending），待真 Windows/Linux 环境社区反馈。**不伪造「已验证 Windows/Linux」**。

## 相关文档

- [08 功能架构](./../doc/08-media-interact-功能架构.md) — 权威架构基线（F 编号、不变量）
- [09 实施排期](./../doc/09-media-interact-实施排期.md) — v0.1 → v1.0 能力跃升路径
- [13 全交互重设计](./../doc/13-全交互抓手重设计.md) — 桌面演进设计
- [ARCHITECTURE.md](./ARCHITECTURE.md) — v1.0 架构概览（本文档的姐妹篇）
- [doc/TROUBLESHOOTING.md](./doc/TROUBLESHOOTING.md) — FAQ + error_kind 释义
- [doc/SELECTOR-MAINTENANCE.md](./doc/SELECTOR-MAINTENANCE.md) — selector 债维护手册

## License

MIT © wangdong233
