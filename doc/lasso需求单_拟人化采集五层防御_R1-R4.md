# Lasso 配合需求单：拟人化采集五层防御（R1-R4）

> 需求方：make-money 研究飞轮（登录态五站采集项目）
> 日期：2026-10-25　优先级：R1 > R2 > R3 > R4
> 背景：2026-10-25 小红书账号级风控报警（「浏览异常不符合真人使用」），三 Agent 白盒深析定论五层防御体系（输入事件/行为统计/环境信任/驱动泄露/会话结构）。其中**驱动泄露层与环境信任层的根治点在 lasso**——本单四项需求按价值排序，附完整实测证据与技术参考。

---

## 事故与结论摘要（为什么提这些需求）

我们的采集栈：lasso 管理的登录态 Chrome（`~/.cache/lasso/login-chrome-profile`，CDP 9225）+ Playwright `connectOverCDP` 附着。2026-10-25 小红书向账号持有人推送「浏览异常不符合真人使用」警告（页内零警告——账号级执法不发页面）。

白盒取证（Chrome History 量化）+ 五平台规则调研 + 开源反检测矩阵三方交叉的结论：

1. **行为层根因**（我们侧已修/在修）：输入事件真空（零鼠标轨迹/isTrusted=false 合成点击/零联想词请求）、停留分布、tuple 查询、凌晨采集
2. **驱动层根因**（需 lasso）：chrome-devtools-mcp 捆绑的 puppeteer 25.5.0 每帧开启 `Runtime.enable`——2026-03 公开的原型链 Proxy 变体（svebaa 实证）**至今未修复**，DataDome/Cloudflare Turnstile 实测在用。原话场景：**「真机+完美住宅 IP 也秒出验证码」**——与我们真机真 Cookie 的架构优势无关，纯驱动层泄露
3. **环境层根因**（半需 lasso）：语言/启动参数受 profile 与 launch-chrome 托管约束

---

## R1【P0·最高优】launch-chrome 支持 locale 与启动参数配置化

### 现状与根因（全部实测，2026-10-25）

- 需求场景：中文平台（小红书/B站/知乎/抖音）账号的登录态采集，浏览器必须是 zh-CN 环境。**当前 Accept-Language 全量 `en-US,en;q=0.9`——中文账号+英文请求头是服务端一个 IF 就能标记的硬错配**
- 我们实测了**三条命令行路径全部失败**：
  1. `--lang=zh-CN`（进程参数确认在，无效）
  2. `--accept-lang=zh-CN,zh;q=0.9`（无效）
  3. `LANG=zh_CN.UTF-8` + `LC_ALL`（系统 locale 已 `locale-gen` 生成，无效）
- **根因：Chrome 155 中 profile 的 `intl.accept_languages/selected_languages` 优先级高于一切命令行开关**。而该 profile 属 lasso 托管（用户禁令：外部禁改第三方 APP 配置，hook 强制拦截）——只有 profile 属主（lasso）能合规地设置
- 非因缺失语言包：`/opt/google/chrome/locales/zh-CN.pak` 存在（220 个 locale 包齐全）

### 需求详述

`lasso launch-chrome` 增加（任一实现均可）：

- **方案 A（推荐）**：`--locale zh-CN` 参数——启动时写入自己管理的 profile 的 `Preferences.intl.accept_languages = "zh-CN,zh;q=0.9"` 与 `selected_languages = "zh-CN"`（新建 profile 时初始化，或对已有 profile 提供一次性设置）
- 方案 B：`--user-args "..."` 通用参数透传 + `--set-pref intl.accept_languages=...` 通用偏好写入（更通用，覆盖本需求同时满足下面的参数保真需求）

### 顺带子需求：重启参数保真

我们当前**绕过 lasso 直接启动 Chrome**，唯一原因是需要非默认参数。若 launch-chrome 支持配置文件（如 `~/.config/lasso/chrome-launch.json`）持久化自定义 flags，我们可回归 lasso 托管。当前所需参数集：

```
--window-size=1920,1080        # 主流分辨率（默认 1280x900 是小众值，指纹特征）
（不要）--disable-quic          # 需启用 QUIC/H3 对齐真实 Chrome 网络行为
--lang=zh-CN                    # 配合 R1 的 profile 写入
--proxy-server=127.0.0.1:7897   # 已支持
```

### 验收标准

- `lasso launch-chrome --locale zh-CN` 后：`curl` 任意请求的响应侧看到 `Accept-Language: zh-CN,zh;q=0.9`；页面内 `navigator.language === 'zh-CN'`
- 重启后参数保真（分辨率/QUIC 状态保持）

---

## R2【P1·价值最大】浏览通道驱动 rebrowser 化

### 现状与根因

- lasso 的 browse_* 通道由 chrome-devtools-mcp 承载，其**构建产物内捆绑 puppeteer 25.5.0**（`build/src/third_party/` 打包，无独立 node_modules 可外部 patch——我们已实测确认）
- puppeteer 附着每帧开启 `Runtime.enable` → 页面可用原型链 Proxy 探针检测（`Object.create(new Proxy({}, {ownKeys(){...}}))` 传入 `console.*`，V8 `DebugPropertyIterator` 走原型链必触发 trap）
- 时间线：经典 Error-getter 变体已被 V8 2025-05 补丁杀死（Chrome 155 免疫）；**原型链变体 2026-03 公开至今未修**（svebaa 实证）；Castle.io（Vastel）确认检测方已多层化
- 另有次要泄露：`//# sourceURL=pptr:...` 脚本注释在 Error.stack 可见

### 需求详述

- chrome-devtools-mcp 的 `package.json` 增加 `overrides: {"puppeteer": "npm:rebrowser-puppeteer@^25"}` 自构建（rebrowser-patches 官方支持 puppeteer 至 24.8.1+，需确认 25.x 兼容性；不兼容则用其 patch CLI 对 25.5.0 打补丁）
- 或：允许调用方注入自建 patched 版（如 `LASSO_CDP_MCP_PATH` 环境变量指向自建产物），我们自维护——次选

### 技术参考（全部一手）

- rebrowser-patches：https://github.com/rebrowser/rebrowser-patches （三种 Runtime.enable 修复模式：addBinding/alwaysIsolated/enableDisable）
- Runtime.enable 泄露原理：https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries
- **敏感 CDP 方法清单**（可直接做 lasso 的运营红线文档）：https://rebrowser.net/docs/sensitive-cdp-methods —— `Runtime.enable`（必死）/`Page.setBypassCSP`（大红牌）/一切 `Emulation.*`
- 原型链 Proxy 变体（未修复证据）：https://svebaa.github.io/personal/blog/cdp-fingerprinting/
- DataDome CDP 信号：https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/

### 验收标准

三检测页全绿（我们可提供自动化验收脚本）：
1. https://brotector.com/
2. https://bot-detector.rebrowser.net/
3. https://bot.sannysoft.com/

### 受益面

**lasso 全部 browse_* 用户**（browse_headless/browse_logged_in），不止登录态高敏场景——任何对 Cloudflare/DataDome 类防护站点的访问都受益。

### 风险

- rebrowser patch 随 puppeteer 上游版本漂移，需固定版本+升级重打（CI 可加三检测页回归）
- `alwaysIsolated` 模式对某些 evaluate 语义有影响，建议默认 `addBinding` 模式并回归现有测试

---

## R3【P1】click/fill 原语增加可选 humanize 行为

### 现状与根因（我们事故的 Top1 信号直接相关）

- 现 click 实现：CDP `Input.dispatchMouseEvent`——事件 isTrusted=true 合格，**但是零移动 teleport 点击**：无 hover 路径、无光标位移历史、坐标恒为元素中心
- 现 fill 实现：CDP `Input.insertText` 一次性整串注入——无逐键 keydown 序列、无键序时间分布
- 行为传感器（PerimeterX sensor data/DataDome/网易易盾「轨迹+历史+设备+网络」四要素）恰好采集轨迹熵与轨迹-点击因果——**我们 2026-10 事故白盒取证的 Top1 触发信号即「输入事件真空」**（69 脚本零 mousemove、合成点击坐标恒 (0,0)）

### 需求详述

click/fill 增加 `humanize: true` 可选参数（默认关闭，不破坏现有调用方）：

1. **轨迹**：贝塞尔路径多步 `Input.dispatchMouseEvent(mousemoved)`（参考 ghost-cursor 的 `path()` 纯函数实现：https://github.com/Xetera/ghost-cursor ——贝塞尔+Fitts 定律速度曲线+过冲回修+元素内随机落点），终点为元素内随机点（非中心）
2. **点击前 hover dwell**：50-300ms 随机
3. **fill 逐键模式**：逐字符 `Input.dispatchKeyEvent`（键间 60-160ms 随机分布），可选

### 验收标准

- 开启 humanize 后，页面 JS 可观测到：连续 pointermove 事件序列（≥10 个点、非直线）、click 坐标在元素内非中心分布
- 现有非 humanize 调用零行为变化

---

## R4【低优】doctor 增加指纹体检

`lasso doctor` 增加「指纹五项」JSON 报告并与上次基线对比（漂移即 warn）：

```json
{
  "language": "zh-CN",            // navigator.language + Accept-Language 双口径
  "fonts_count": 140,             // fc-list 探针
  "audio": {"sampleRate": 44100, "channels": 2},
  "screen": "1920x1080",
  "webgl_renderer": "SwiftShader"  // 已知风险项，仅记录
}
```

排障价值：环境漂移比单点错配更危险（账号信任基于指纹连续性）。

---

## 附：需求方已完成的前置工作（衔接说明）

系统层 P0 已于 2026-10-25 在采集主机（京东云 jd-cloud-linux，tailscale 100.120.87.40）完成：

- 字体 57→140 族（fonts-noto-cjk 全家/emoji/西文常用）
- PulseAudio null-sink（AudioContext 44100Hz/2ch 主流形态）
- Xvfb 与窗口 1920×1080
- 系统生成 zh_CN.UTF-8 locale
- 移除 --disable-quic

**衔接风险提示**：若 lasso 侧 `chrome-stop`/`launch-chrome` 重启实例时使用默认参数（1280x900、disable-quic），上述环境改进中与启动参数相关的两项会被回退——这是 R1「参数保真」子需求的由来。

## 配合方式

- 验收环境：我们提供带登录态 Cookie 的测试实例 + 自动化验收脚本（三检测页截图 diff + Accept-Language 探针）
- 联调通道：tailscale 直连（macbook-pro ↔ jd-cloud-linux）；CDP 9225 可远程
- 优先级建议：R1（小时级工作量，解我们 P0 阻塞）→ R2（半天级+CI 回归，收益最大）→ R3（一天级）→ R4（可选）
