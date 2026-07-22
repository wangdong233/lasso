# Lasso 故障排查（FAQ + error_kind 释义）

> 用户排障手册。架构原理见 [`ARCHITECTURE.md`](../ARCHITECTURE.md)；安装/配置见 [`README.md`](../README.md)。

## 1. 第一步：跑 doctor

```bash
lasso doctor
```

`doctor` 跑 32 项 readiness check，输出 JSON：

```json
{
  "ready": true,
  "lasso_version": "1.0.0",
  "platform_backend_active": "mac",      // darwin→mac / win32→win_uia / linux→linux_atspi
  "recording_baseline_count": 12,         // fixtures/serp-baseline/ 数量；0 = warn（不阻塞 ready）
  "checks": [
    { "name": "...", "status": "pass"|"warn"|"fail", "detail": "...", "next_step": "..." }
  ]
}
```

任何 `fail` 都会附 `next_step`；按提示修。`ready: false` 时 Lasso 仍可启动但功能受限。

## 2. 常见 `error_kind` 释义

### 2.1 `tcc_denied`（macOS Accessibility / Screen Recording）

**症状**：`desktop` 工具调用返 `outcome=didnt` + `error_kind="tcc_denied"`，detail 提示 "AxUIElement API returns errAEEventNotPermitted"。

**根因**：`lasso-rust-helper` binary 未获 macOS TCC 授权。

**修复**：
1. System Settings → Privacy & Security → **Accessibility** → 勾选 `lasso-rust-helper`（或 `Terminal` / `iTerm` / `Claude Code` 启动进程）
2. 同步勾选 **Screen Recording**（如需 screenshot）
3. 重启 Lasso 进程（TCC 变更需进程重启生效）
4. `lasso doctor` 验 `tcc_status=pass`

### 2.2 `not_macos` / `not_windows` / `not_linux`

**症状**：调用某 method 时 helper binary 返 `not_<platform>`。

**根因**：helper binary 平台不匹配（如在 macOS 上调用 `uia_snapshot`，会返 `not_windows`，因为 `uia.rs` 在非 Windows 编译时返 `not_windows`）。

**修复**：
- macOS 上不要调用 `uia_*` / `atspi_*` method（那是 Win/Linux 专用；macOS 走 `ax_*`）
- 如果是 helper binary 真的装错平台 → `npm install -g lasso-mcp@1.0.0` 重装

### 2.3 `unsupported_platform:<x>`

**症状**：`AxBackendFactory.create()` 抛 `unsupported_platform:freebsd` 等。

**根因**：当前 OS 不是 `darwin` / `win32` / `linux`。

**修复**：Lasso v1.0 只支持这三个平台。其他平台（如 FreeBSD / OpenBSD）请开 issue 讨论适配。

### 2.4 `NEEDS_MANUAL_2FA`（红线）

**症状**：`browse_logged_in` 返 `outcome=didnt` + `error="NEEDS_MANUAL_2FA"`。

**根因**：目标站点要求 2FA（短信 / TOTP / passkey）。**Lasso 不解 2FA（这是红线）**，明确返"需要人介入"信号。

**修复**：
1. 本机打开 Chrome（带 :9222 CDP 端口的那个）
2. 手动完成 2FA 登录
3. 回到 Lasso 重试 `browse_logged_in`（cookie 已在 Chrome 本地，Lasso 复用）

**为什么 Lasso 不解 2FA**：见 [doc/08 §7](../../doc/08-media-interact-功能架构.md) 边界节。自动 2FA 需要存储用户 TOTP secret / 短信转发，这是身份越权，红线。

### 2.5 `recording_replay_miss`

**症状**：`search` 全源熔断（智谱 / Brave / Bing / Wayback 都失败），返 `outcome=didnt` + `error_kind="recording_replay_miss"`。

**根因**：所有上游 search 引擎都失败（如配额耗尽 / 网络），且本地无录制基线可兜底。

**修复**：
1. 配 `LASSO_RECORD_SEARCH=true` 跑一次成功 search（落盘基线）
2. 关 `LASSO_RECORD_SEARCH`（默认 OFF）
3. 下次全源熔断时 Lasso 自动用录制基线兜底（08 §3.4 F3.8.14）

### 2.6 `upstream_unsupported:pdf`

**症状**：`pdf` 工具返 `outcome=didnt` + `retrieval_method="upstream_unsupported:pdf"`。

**根因**：当前 chrome-devtools-mcp 版本不支持 `Page.printToPDF` 或上游移除了 pdf 工具。

**修复**：用 `browse_headless` + `action="screenshot"` 截页面替代（pdf 是上游限制，Lasso 不绕过）。

### 2.7 `upstream_unsupported:network`

**症状**：`network` 工具返 `outcome=didnt` + `retrieval_method="upstream_unsupported:network"`。

**根因**：当前 chrome-devtools-mcp 版本不支持 `Network.*` CDP 域 或 `Runtime.evaluate`。

**修复**：等上游 chrome-devtools-mcp 支持；或用 `browse_headless` + `action="evaluate"` 跑 JS。

### 2.8 `ssrf_blocked`

**症状**：`search` / `fetch_url` 返 `outcome=didnt` + `error="ssrf_blocked:<ip>"`。

**根因**：目标 URL 解析到私有/保留 IP 段（如 10.0.0.0/8, 127.0.0.0/8, 192.168.0.0/16, 169.254.0.0/16）；Lasso 默认拒私有 IP 防 SSRF。

**修复**：
- 检查 URL 是否真的是公网资源
- 如在 fake-ip 网络（Surge/Clash/Mihomo TUN 模式，DNS 解析返 `198.18.x.x`）：Lasso 已默认放行 `198.18.0.0/15`，应无问题；如仍报错，确认代理软件未使用其他保留段

### 2.9 `channel_disabled`（admin action 触发）

**症状**：某 channel 返 `outcome=didnt` + `error="channel_disabled"`。

**根因**：运行时 `admin({action:"disable_channel", channel:"browse_logged_in"})` 显式禁用了。

**修复**：`admin({action:"enable_channel", channel:"browse_logged_in"})` 重启。

## 3. FAQ

### Q1：`npx lasso-mcp` 启动报 "command not found"

确认 Node.js 版本 ≥ 20（`engines.node >=20`）：

```bash
node --version
```

如版本低 → 升级 Node（推荐用 nvm）。

### Q2：`lasso doctor` 报 `chrome_devtools_mcp_version=fail`

Lasso 依赖 chrome-devtools-mcp 契约版本。如未装：

```bash
npm install -g chrome-devtools-mcp@<pinned-version>
```

具体锁定版本见 `package.json` 的 dependencies / devDependencies。

### Q3：`browse_logged_in` 一直返 cookie expired

Lasso 不存 cookie；cookie 留在本机 Chrome。如果 Chrome 的 cookie 过期：

1. 本机打开 Chrome（带 :9222 CDP 端口的）
2. 访问目标站点手动重登
3. Lasso 重试（cookie 自动复用）

### Q4：`desktop` 在 macOS 上报 "AxAPI not authorized"

见 [§2.1 `tcc_denied`](#21-tcc_deniedmacos-accessibility--screen-recording)。

### Q5：`desktop` 在 Windows/Linux 上能跑吗？

**编译可证 + 契约可证，真机执行待社区反馈**。Lasso v1.0 的 Windows UIA + Linux AT-SPI backend 经 `cargo check --target` 验证编译可过，OutlineNode 三平台同构契约层有 CI 单测。但真实 Win/Linux 运行时执行留 [parse11-acceptance.md](../../doc/parse/parse11-acceptance.md) 手测清单（标 pending）。**不伪造「已验证 Windows/Linux」**。

### Q6：如何录制 search 基线？

```bash
export LASSO_RECORD_SEARCH=true
# 跑任意 search（成功后会落盘到 ~/.cache/lasso/recordings/）
# 关录制
unset LASSO_RECORD_SEARCH
```

CI 基线（签入仓库）在 `fixtures/serp-baseline/`；运行时录制（用户本地）在 `~/.cache/lasso/recordings/`。两者分离，cookie=身份红线（INV-51/62 守）。

### Q7：search 引擎配额耗尽怎么办？

Lasso 自动 fallback 到下一源：
- 智谱耗尽 → Brave → Bing → Wayback → RecordingStore replay
- 全源耗尽 → `recording_replay_miss`（见 [§2.5](#25-recording_replay_miss)）

配额监控经 `QuotaLedger`（INV-10 守：Brave 必经 ledger，不裸读 env）。可 `admin({action:"channel_health"})` 看各源剩余配额。

### Q8：如何调试 fallback 链？

```bash
# 启 Lasso 时设 LOG_LEVEL=debug
LOG_LEVEL=debug npx lasso-mcp
```

debug 日志会打印每档 fallback 决策（`fallback_decided` event）。或在运行时 `admin({action:"profile",...})` 看 fallback history。

### Q9：`replay-baseline` CI 失败怎么办？

```bash
npm run replay-baseline -- --strict
```

`--strict` 模式下命中率 <50% 的 fixture 触发 exit 1。说明 selector 改版了。修复流程见 [`SELECTOR-MAINTENANCE.md`](./SELECTOR-MAINTENANCE.md)。

### Q10：能不能禁用 cloud 浏览器通道？

可以，**默认就是禁用的**。cloud 浏览器（Browserbase / Stagehand）必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch AND API key 双重解锁（INV-25 守）。不设 env 就完全不会实例化 cloud channel。

## 4. 性能调优

### 4.1 Token 效率

Lasso 把页面 DOM / 桌面 OutlineNode 写本地磁盘（`~/.cache/lasso/state/`），返回 `state_id`。CC 后续调用经 `state_id` 引用，**4× token 效率**。不要在 prompt 里粘大段 HTML；让 Lasso 自己存。

### 4.2 连接池

`SubprocessManager.acquireHttpClient`（INV-32 守）复用 undici Agent。不要 new Agent / 裸 fetch。

### 4.3 并发限流

`search` 的 `MultiSourceFanout` 并发请求多引擎，但每源有独立限流（`QuotaLedger`）。不要绕过 admin 直改 env 配额。

## 5. 卸载

```bash
# Claude Code 移除
claude mcp remove lasso --scope user

# 全局卸载
npm uninstall -g lasso-mcp

# 清本地 cache（可选）
rm -rf ~/.cache/lasso
```

## 6. 反馈与 issue

- GitHub Issues: https://github.com/wangdong233/lasso/issues
- 真机 Win/Linux desktop 测试反馈**特别欢迎**（帮助从 pending 转为 verified）
- 附 `lasso doctor` 完整 JSON 输出 + LOG_LEVEL=debug 日志

## 7. 相关文档

- [README.md](../README.md) — 用户手册（安装 / 配置 / 工具列表 / 隐私）
- [ARCHITECTURE.md](../ARCHITECTURE.md) — 架构概览
- [SELECTOR-MAINTENANCE.md](./SELECTOR-MAINTENANCE.md) — selector 债维护手册
- [doc/08 功能架构](../../doc/08-media-interact-功能架构.md) — 权威架构基线
- [doc/09 实施排期](../../doc/09-media-interact-实施排期.md) — v0.1 → v1.0 路径
