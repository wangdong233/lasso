# Lasso 故障排查（FAQ + error_kind 释义）

> 用户排障手册。架构原理见 [`ARCHITECTURE.md`](../../ARCHITECTURE.md)；安装/配置见 [`README.md`](../../README.md)。

## 1. 第一步：跑 doctor

```bash
lasso doctor
```

`doctor` 跑全部 readiness check（检查项随版本持续增长，**以实跑输出为准**），输出 JSON：

```json
{
  "ready": true,
  "lasso_version": "1.18.4",
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
- 如果是 helper binary 真的装错平台 → `npm install -g lasso-mcp` 重装（或直接用 `npx -y lasso-mcp@latest`）

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

**为什么 Lasso 不解 2FA**：见 [doc/architecture/01 §7](../architecture/01-功能架构.md) 边界节。自动 2FA 需要存储用户 TOTP secret / 短信转发，这是身份越权，红线。

### 2.5 `recording_replay_miss`

**症状**：`search` 全源熔断（智谱 / Brave / 兜底实搜都失败），返 `outcome=didnt` + `error_kind="recording_replay_miss"`。

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

**根因**：v1.11 起 `network` 走 chrome-devtools-mcp 1.7.0 的**原生** `list_network_requests`（CDP Network 域），不再依赖页面内 JS 注入——旧版在 fake-ip / TUN 代理网络「资源抓不全」的限制已随之关闭。这个错误现在只剩一种来源：上游子进程的工具清单里缺 `list_network_requests`（上游进程被替换 / 启动不完整）。

**修复**：重启 Lasso（它会按锁定版本自动经 npx 重新拉起上游）；仍失败用 `LOG_LEVEL=debug` 看上游 `tools/list` 实际返回了什么；临时替代走 `browse_headless` 的 network action。

### 2.8 `ssrf_blocked`

**症状**：`search` / `fetch_url` 返 `outcome=didnt` + `error="ssrf_blocked:<ip>"`。

**根因**：目标 URL 解析到私有/保留 IP 段（如 10.0.0.0/8, 127.0.0.0/8, 192.168.0.0/16, 169.254.0.0/16）；Lasso 默认拒私有 IP 防 SSRF。

**设计行为说明（非缺陷）**：`127.0.0.1/32` 与 `198.18.0.0/15` 是内置放行段——前者供 `browse_logged_in` 连本机 Chrome CDP 调试端口（`127.0.0.1:9222`），后者供 Surge/Clash TUN fake-ip 网络。除此之外的回环地址（如 `127.0.0.2`）仍默认拒。

**修复**：
- 检查 URL 是否真的是公网资源
- 如在 fake-ip 网络（Surge/Clash/Mihomo TUN 模式，DNS 解析返 `198.18.x.x`）：Lasso 已默认放行 `198.18.0.0/15`，应无问题；如仍报错，确认代理软件未使用其他保留段

### 2.9 `channel_disabled`（admin action 触发）

**症状**：某 channel 返 `outcome=didnt` + `error="channel_disabled"`。

**根因**：运行时 `admin({action:"disable_channel", channel:"browse_logged_in"})` 显式禁用了。

**修复**：`admin({action:"enable_channel", channel:"browse_logged_in"})` 重启。

### 2.10 `tcc_event_synthesis_denied`（macOS 15+ 事件合成授权）

**症状**：坐标鼠标动作（拖拽 / 坐标点击 / 滚轮）返 `outcome=didnt`，detail 提示需要 Event Synthesizing 授权；`lasso doctor` 的 `#21 tcc_event_synthesizing` 为 `fail`/`warn`。

**根因**：macOS 15 起，合成鼠标 / 键盘事件需要单独的 TCC 授权（老版本没有这一项）。

**修复**：System Settings → Privacy & Security → **Event Synthesizing**（事件合成）→ 勾选 `lasso-rust-helper`；勾了 **Accessibility（辅助功能）** 一般也能兜底。改完重启 Lasso 进程（TCC 变更需进程重启生效），再跑 `lasso doctor` 验证。

### 2.11 `vlm_inference_only:*`（VLM 档诚实降级）

**症状**：`desktop` 链尾（canvas / 自绘 UI 场景）返 `outcome=unknown` + `error_kind="vlm_inference_only:no_coordinate_action"` 或 `vlm_inference_only:execution_failed`，结果附 VLM 推断原文。

**根因**：VLM 档的工作方式是截图→推断→把推断解析成坐标动作→真执行。解析不出可执行动作、或执行失败时，v1.12 起**不再谎报成功**，诚实返 `unknown`（触发降级链）并把推断原文附在结果里（不浪费）。这不是故障，是设计。

**修复**：先重新 observe 拿最新快照再 act；canvas 场景可指定 `screenshot_region` 缩小范围（v1.13 起区域内的坐标会自动换算回全屏，落点正确）；持续失败说明该 UI 不适合 VLM 档，人工接管。

### 2.12 doctor 提示 Chrome 版本偏差（stealth self-check 的 skew hint）

**症状**：`lasso doctor` 的 stealth self-check detail 提示「与已装 Chrome 版本偏差 ≥2 个大版本」（skew），或「UA 年龄超过 12 个月」。

**根因**：无头浏览器的反检测档案里带一套浏览器版本号；它和你本机真实 Chrome 差得太多（或档案太旧）时，版本年龄本身就是被识破的信号。doctor 在替你盯这个。

**修复**：这是「建议刷新」级提示（warn，不阻塞 `ready: true`）。常规做法：升级 `lasso-mcp` 到最新版（stealth 档案值域随版本刷新，v1.11 已刷到 2026-07 时代的版本值）；如果你手动定制过 profile，改回内置档案（macOS 上默认与宿主系统对齐，v1.12 起）。

### 2.13 Steel 自托管停摆 / 不可达

**症状**：`browse_cloud_steel` 返 `outcome=unknown`（自动降级到下一档通道）；`lasso doctor` 的 `#37 steel_endpoint_reachable` 为 `warn`（GET `/health` 不通）。

**根因**：Steel Docker 容器停了 / 没起，或 endpoint 悬挂不返回（实测可挂 ~5 分钟不响应）。

**修复**：`docker ps` 看容器、`docker start <容器>` 或重跑一行启动命令（见 [KEY-GUIDE · Steel](./KEY-GUIDE.md#steel_endpoint--自托管云浏览器v16-新推荐免费)），`curl http://localhost:3000/health` 验证。**退出卡顿在 v1.13 已修**：Steel 会话释放加了 3 秒双层上界——旧版 Steel 停摆会把 Claude Code 退出拖到分钟级，现在最多 3 秒收尾，「Steel 挂了」不再拖死退出，恢复容器即可。

### 2.14 Electron 输入框的 type 降级（v1.12）

**症状**：在 Slack / VSCode 等 Electron 应用的输入框输入时，结果里显示走了「键盘合成」路径而非无障碍赋值。

**根因**：Electron 控件经常吞掉无障碍赋值接口（AXSetValue 设了没反应）。v1.12 起档内自动降级：聚焦输入框 → 全选（cmd+a）→ 逐字符键盘合成。

**行为说明**：输入语义是**整值替换**——说「输入 X」就是把框内容变成 X，不是在光标处追加。降级路径只合成 ASCII 字符；值读不回来时跳过读回验证（诚实优先，不误报）。

### 2.15 中文 IME 下 type 的边界

**症状 / 边界**：键盘合成路径（Electron 降级、坐标档输入）走按键码合成——**ASCII 字符直通；中文等非 ASCII 依赖输入法状态**，中文 IME 激活时可能产出错字符或无输出。

**怎么办**：原生 macOS app 的输入框走无障碍赋值路径，输入中文没有问题；只有降级到键盘合成的场景受此限制。需要在这类框里输中文时，先切到英文输入法 / US 键盘布局，或改由你自己粘贴。目前没有实测失败案例在案（已知边界，持续观测）——遇到了请提 issue，附 app 名与输入法状态。

### 2.16 `rust_helper_spawn_failed` 四态自诊断（v1.18.4）

**症状**：`desktop` 工具调用返 `outcome=didnt` + `error_kind="rust_helper_crashed:subproc_spawn_failed"`，detail 里带 `[gate:<态>]` 前缀。

**根因**：rust-helper binary 无法 spawn。v1.18.4 起 spawn 前有可行性门（`src/subprocess/rust-helper-path.ts` rustSpawnGate）四态自诊断，**看 gate 态即可一眼定位**：

| gate 态 | 含义 | 修法 |
|---|---|---|
| `ok` | 可执行、有 exec 位 | spawn 失败另有原因，看 detail 的 errno（EACCES/E2BIG…） |
| `missing` | 路径不存在（或探测后消失的竞态） | 重装 `npm install -g lasso-mcp`（binary 未随包发布时本仓用户需先 `cargo build --release`）；或 `LASSO_RUST_HELPER` 指向了不存在的路径 |
| `not_file` | 存在但不是普通文件（目录 / FIFO） | `LASSO_RUST_HELPER` 配错成了目录——改成 binary 全路径 |
| `no_exec` | 普通文件但缺执行位（`chmod -x` / 解压丢失） | `chmod +x <binary 路径>` |

**历史**：v1.18.3 及之前 helper 路径是 cwd 相对路径——在非 lasso 目录拉起 server 时 desktop 通道全挂（根因与修复全案见 [`BUG-rust-helper-relative-path.md`](../bugs/01-rust-helper-relative-path.md)，v1.18.4 根治：路径 resolve 为绝对 + 四态门 + ad-hoc 签名链 + CI）。

**签名链**（macOS）：无 Apple Developer 账号时 build 末段自动 ad-hoc 重签（`scripts/ad-hoc-sign-helper.mjs`）——TCC 授权绑定的身份以「当前 ad-hoc 签名」为准；升级后 TCC 失效跑 `lasso doctor` 的 tcc 检查项按 `next_step` 重授权即可。

## 3. FAQ

### Q1：`npx lasso-mcp` 启动报 "command not found"

确认 Node.js 版本 ≥ 20（`engines.node >=20`）：

```bash
node --version
```

如版本低 → 升级 Node（推荐用 nvm）。

### Q2：`lasso doctor` 报 `chrome_devtools_mcp_version=fail`

Lasso 的浏览器驱动 chrome-devtools-mcp **版本由 Lasso 锁定（当前 1.7.0）、启动时自动经 npx 拉取**——不需要也不建议手动全局安装（全局装的那份不会被用到，还可能与锁定版本混淆）。报 fail 时：

1. 检查网络 / 代理能否访问 npm registry（npx 拉包失败是最常见原因）
2. `npm cache verify` 清理后重试
3. 重启 Claude Code，让 Lasso 重新拉起上游子进程

### Q3：`browse_logged_in` 一直返 cookie expired

Lasso 不存 cookie；cookie 留在本机 Chrome。如果 Chrome 的 cookie 过期：

1. 本机打开 Chrome（带 :9222 CDP 端口的）
2. 访问目标站点手动重登
3. Lasso 重试（cookie 自动复用）

### Q4：`desktop` 在 macOS 上报 "AxAPI not authorized"

见 [§2.1 `tcc_denied`](#21-tcc_deniedmacos-accessibility--screen-recording)。

### Q5：`desktop` 在 Windows/Linux 上能跑吗？

**编译可证 + 契约可证，真机执行待社区反馈**。Lasso v1.0 的 Windows UIA + Linux AT-SPI backend 经 `cargo check --target` 验证编译可过（v1.18.4 起 GitHub CI 每次推送都跑 Linux `cargo check --target x86_64-unknown-linux-gnu` 面），OutlineNode 三平台同构契约层有 CI 单测。但真实 Win/Linux 运行时执行留 [parse11-acceptance.md](../archive/parse/parse11-acceptance.md) 手测清单（标 pending）。**不伪造「已验证 Windows/Linux」**。

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
- 智谱耗尽 → Brave → browse_headless 实搜兜底 → RecordingStore replay（Bing 源已移除：上游 2025-08-11 退役）
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

`--strict` 模式下命中率 <50% 的 fixture 触发 exit 1。说明 selector 改版了。修复流程见 [`SELECTOR-MAINTENANCE.md`](03-SELECTOR-MAINTENANCE.md)。

### Q10：能不能禁用 cloud 浏览器通道？

可以，**默认就是禁用的**。cloud 浏览器（Browserbase / Stagehand）必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch AND API key 双重解锁（INV-25 守）。不设 env 就完全不会实例化 cloud channel。

### Q11：升级后 `desktop find` 用 ref 查询报 `invalid_params`？

**v1.13 起的行为变化（诚实化）**：`find` 的 `where` 只认 `text` / `role`——`ref` 是 act / expect 的域（引用 observe 拿到的节点）。旧版本里纯 ref 查询会**静默退化成全节点命中**（token 爆炸还报成功），现在改为明确报 `invalid_params`。

**正确用法**：`find` 用 text / role 定位 → 拿到节点 ref → `act` / `expect` 用这个 ref。

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

- [README.md](../../README.md) — 用户手册（安装 / 配置 / 工具列表 / 隐私）
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — 架构概览
- [SELECTOR-MAINTENANCE.md](03-SELECTOR-MAINTENANCE.md) — selector 债维护手册
- [doc/architecture/01 功能架构](../architecture/01-功能架构.md) — 权威架构基线（冻结）
- [doc/architecture/02 实施排期](../architecture/02-实施排期.md) — v0.1 → v1.18.4 全周期决策记录

## 8. 浏览器静默 / 后台节流（v1.10）

### 8.0 静默性结论速查（v1.17.2 真机审计）

六维打扰面（焦点/窗口/Dock/音频/通知/资源）逐格实测的完整矩阵和证据在 [`doc/governance/08-静默性全面审计/`](../governance/08-静默性全面审计/)（audit.md 白盒 + verify.md 真机）。速记：纯查询五路径（search 三源 / fetch_url / fetch_feed / content_blocks 二跳）完全静默；`browse_headless` 不注册 Dock/cmd-tab、恒静音，只有存活期 ~400MB 底噪；`launch-chrome` hidden 档唯一残留是 Dock 图标；连你自己开的 Chrome 操作面零抢焦（v1.17.2 起 lasso 在后台 tab 干活，你的 tab 不被改写）；`desktop` 设计上占用键鼠。用户向矩阵表在 [README · 隐私与安全](../../README.md#隐私与安全)。

**连你自己 Chrome 时发现「我的第一个 tab 被 navigate 走了」**：v1.17.1 及之前的已知缺陷（S-7，tab 内容劫持），v1.17.2 已修复——lasso 现在自建后台 tab 干活、会话结束自动关。若仍复现，说明该次连接处于降级态（列表解析失败/建塔失败时维持旧行为不阻断），跑 `lasso doctor` 看 CDP 可达性，并反馈日志里的 `logged_in_own_page_*` 事件。

### 8.1 让「你自己开的 Chrome」获得反节流能力（browse_logged_in 复用 9222 时）

Lasso 自己 `launch-chrome` 起的 Chrome **恒带**反节流三件套 + 静音（后台 tab 的 rAF 不被钳到 1 帧/秒、定时器不合并、永不发声）。但**你自己手动启动**、只加 `--remote-debugging-port=9222` 的 Chrome 拿不到这些 flag——`browse_logged_in` 连接（`--browser-url`）是零注入的：谁的 Chrome 听谁的，Lasso 不改写你的进程参数（也不该）。

如果你长时间把这台 Chrome 挂在后台给 Lasso 用，且页面自身的 JS（懒加载、前端轮询）明显变慢，重启 Chrome 时自行附加三件套：

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cache/lasso/chrome-profile-default" \
  --disable-backgrounding-occluded-windows \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --mute-audio
```

说明：

- Lasso 自身的轮询（导航等待等）走 CDP `Runtime.evaluate`，由 DevTools 会话直接调度，**不受**后台节流影响；受影响的是页面自己的 JS。
- 即使带齐三件套，hidden >10s 的链式定时器仍有 intensive throttling（M109+ 每分钟 1 次的 Chromium 内建行为，flag 关不掉）——Lasso 的 60s「用完即关」把 Chrome 生命周期压在这个机制的主要伤害区之前，是天然缓解。
- 后台 tab 的 `document.visibilityState === "hidden"` 对反爬脚本可见，这是浏览器上报值，页面 JS 域改不了。要最低指纹用 `browse_headless`，要静默 + 登录态用 lasso 自己 launch 的 hidden 档。

### 8.2 Windows hidden 档说明（#W-pending）

Windows 上 hidden 档 = `--start-minimized` + `--no-startup-window` 双发。`--no-startup-window` 在 Windows 上同样有效；`--start-minimized` 对部分 Chrome 版本会被忽略（Puppeteer#852 先例），故两者同发兜底。flag 组合已由 CI 单测断言（shape 可证），真机行为留待 Windows 用户反馈（沿用 #W7 pending 范式，不伪造「已验证」）。

如果两个 flag 都被你的 Chrome 版本忽略（窗口照常弹出），可选的两段式 Win32 方案（本版未实现，供自行处置）：用 PowerShell 对该 pid 的窗口调 `ShowWindowAsync(hWnd, SW_SHOWMINNOACTIVE)`（最小化且不激活）+ `SetWindowPos(HWND_BOTTOM)`（沉底）：

```powershell
# 概念示意（需按 pid 找主窗口句柄；SW_SHOWMINNOACTIVE = 7）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int x, int y, int cx, int cy, uint flags);
}
"@
# [Win32]::ShowWindowAsync($hWnd, 7); [Win32]::SetWindowPos($hWnd, [IntPtr]1, 0,0,0,0, 0x13)
```

macOS 不需要以上任何处置：lasso 用 PID 定向的 System Events hide 作保险丝（需要辅助功能授权；无授权自动降级为 warn，不影响功能，`doctor` 可查）。

## 9. chrome-hide / 粘滞看门狗 / idle reaper（v1.18.x）

### 9.1 `chrome-hide` 直达命令与 `--pid`

```bash
lasso chrome-hide          # 隐藏台账内全部 lasso 拉起的 Chrome（按台账 pid 定向，永不误伤非台账窗口）
lasso chrome-hide --pid 12345   # 按 pid 直达隐藏（须已在台账；E8 误伤红线——非台账 pid 会被拒）
lasso chrome-show          # 取消隐藏 + 清粘滞账
```

`launch-chrome --mode visible` 首次登录后 `chrome-hide` 回到后台静默（`chrome-show` 再现身）。v1.18.3 起 hide 原语异步化 + `--pid` 直达。

### 9.2 粘滞复隐看门狗（P27，v1.18.3）

Chrome 窗口「自己弹出来」的场景（上游 CDP 激活 / 页面 JS / Chrome 内部唤起）：常驻 server 每 1.5s tick 读 desired-hidden 粘滞账，发现可见即压回（单 osascript「可见才压回」，不盲发）。**闪现上限 = 一个 tick（1.5s）**。观测点：日志事件 `desired_hidden_reasserted`。CLI chrome-hide 单跑**没有**看门狗（进程退出即止——粘滞账是跨进程契约，只有长命 server 消费）。

### 9.3 Chrome 60-75 秒后神秘死亡（idle reaper + 外部消费者盲区）

**症状**：`launch-chrome` 拉起的 Chrome 在无 lasso browse 活动时约 60-75s 后 CDP 断连、台账变空。

**根因**：by-design 的 idle reaper（hidden 档「用完即关」，默认 `LASSO_LAUNCH_IDLE_MS=60s`）。**若 Chrome 由非 lasso browse 通道消费（外部 CDP 直连，如其他 MCP/自动化脚本），reaper 看不到活动信号，照样收割**——这是已知盲区（R-INT-07 活案例，全案见 [`BUG-chrome-idle-reaper-second-consumer.md`](../bugs/02-chrome-idle-reaper-second-consumer.md)）。

**修法**：外部消费场景拉起时禁用收割：

```bash
lasso launch-chrome --port 9223 --idle-ms 0   # record 级：仅这条 Chrome 永不收割（推荐）
# 或全局：export LASSO_LAUNCH_IDLE_MS=0（影响所有 launched Chrome，粒度粗）
```
