# parse13-acceptance：Lasso v1.5 Stealth P0 手测验收清单

> **定位**：v1.5 stealth P0 的**真机 / L3 证据**补完清单。parse13 §4.3 / §4.5 / §8.4 列出的
> deferred-Spike（chrome-devtools-mcp flag 透传、HTTP header 注入、sannysoft 真机通过率）
> 在 CI 单测 + 集成测层面无法验证（mock McpClient），必须在真实 chrome-devtools-mcp +
> 真实 Chromium 进程上跑一次（03 §0.3 L3 = 运行时复现证据）。
>
> **何时跑**：v1.5 release 前必跑一次；之后每次 stealth-profiles.ts / HeadlessChannel.ts /
> StealthEngine.ts 重大改动后回归。结果回填本文档「实测结果」列。
>
> **基准对照**：每次跑前先用 v1.4.0（git tag 或 build）跑同套用例得 baseline，再跑 v1.5
> 对比（03 §2.4 趋势告警）。

---

## 1. 前置准备

### 1.1 环境
- macOS / Linux 主机（开发机即可，不需 staging）
- Node.js 24.x（npm run build 要求）
- 网络：能访问 bot.sannysoft.com / abrahamjuliot.github.io / wikipedia.org / news.ycombinator.com
- chrome-devtools-mcp@0.3.0（`LOCKED_CDP_MCP_VERSION` 锁定版本；`npx` 自动拉取）

### 1.2 build
```bash
cd /Users/wangdong/Documents/Project/cc-control-all/lasso
npm run build && npm test && npm run check-invariants
# 期望：1552 passed + 73/73 INV 全绿（基线 v1.4.0 = 1511 passed + 72/72 INV）
```

### 1.3 Lasso 启动（待 CC 客户端接入后）
v1.5 的 HeadlessChannel 经 `browse_headless` 工具暴露给 CC；CC 调用示例：
```
browse_headless(url="https://bot.sannysoft.com/", action="navigate")
browse_headless(url="https://bot.sannysoft.com/", action="snapshot")
```
（注：当前 v1.5 尚未在 CC 客户端正式接入，手测可走 `npm test` 集成测 + 单独跑
chrome-devtools-mcp + StealthEngine 直调脚本，见 §4 手测脚本。）

---

## 2. 验收项 1：chrome-devtools-mcp flag 透传（parse13 §4.3 deferred-Spike）

### 2.1 项：`--disable-blink-features=AutomationControlled` 是否真到 Chromium 进程

**L1 spike 结论（已验，HeadlessChannel.ts:48-55 注释）**：
- chrome-devtools-mcp@0.3.0 `--help` 只文档化 6 个自有 flag（--headless/--isolated/--channel/...）
- yargs strict 未开 → unknown flag 不报错（实测 `--disable-blink-features=...` 启动 banner 正常，exit=0）

**L3 真机验证动作**：
1. `npx -y chrome-devtools-mcp@0.3.0 --headless --isolated --disable-blink-features=AutomationControlled` 启动
2. 启动后 `ps aux | grep chrome | grep -v grep` 抓 Chromium 进程
3. 检查进程 argv 是否含 `--disable-blink-features=AutomationControlled`

**判定标准**：
- ✅ pass：Chromium 进程 argv 含此 flag + sannysoft `navigator.webdriver` 表格行**绿色**（false）
- ⚠️ partial：Chromium 进程 argv 不含（chrome-devtools-mcp 吞掉），但 sannysoft `navigator.webdriver` 仍绿色
  → 因为 JS evasion 路 1（navigator.webdriver→undefined）等价覆盖此检测点，feature 仍可用
- ❌ fail：Chromium 进程 argv 不含 + sannysoft `navigator.webdriver` 红色
  → JS evasion 失效，需排查 StealthEngine.injectProfile 是否在 navigate 前被调到

**实测结果**：__________（待回填）

### 2.2 降级兜底确认

无论 §2.1 结果如何，**JS evasion 路 1（navigator.webdriver→undefined）必须独立生效**（
StealthEngine.ts:82 `evaluate(client, STEALTH_INJECTION_SCRIPT, ...)`）。验证：
- 集成测 `stealth-headless-integration.spec.ts:275-280` 已断言 SCRIPT 含 navigator.webdriver
  marker + CORE 3 路 + vendored 12 路 marker 齐全
- 真机补验：sannysoft `navigator.webdriver` 行绿色（即便 flag 不透传）

---

## 3. 验收项 2：sannysoft 基准（parse13 §5.3 + §6.2 黑盒验收）

### 3.1 访问 bot.sannysoft.com

**动作**：
```
browse_headless(url="https://bot.sannysoft.com/", action="navigate")
browse_headless(url="https://bot.sannysoft.com/", action="snapshot")
```

**判定标准**（关键检测点表格逐项核）：

| 检测点 | v1.4 期望 | v1.5 期望 | 路 | 实测 v1.4 | 实测 v1.5 |
|---|---|---|---|---|---|
| `navigator.webdriver` | ❌ 红（true） | ✅ 绿（undefined） | 路 1 | __ | __ |
| `navigator.languages` | ❌ 红（空数组） | ✅ 绿（["en-US","en"]） | 路 2 | __ | __ |
| `navigator.permissions` | ❌ 红（Notification denied） | ✅ 绿（不 denied） | 路 3 | __ | __ |
| `chrome.runtime` | ⚠️ 部分 | ✅ 绿（runtime/app/csi/loadTimes 齐） | 路 4-7 | __ | __ |
| `navigator.plugins` | ❌ 红（空数组，headless 头号破绽） | ✅ 绿（PDF Viewer 等 5 个） | 路 8 | __ | __ |
| `navigator.vendor` | ⚠️ 默认值可能露馅 | ✅ 绿（"Google Inc."） | 路 9 | __ | __ |
| `hardwareConcurrency` | ⚠️ 露 headless 默认值 | ✅ 绿（4） | 路 10 | __ | __ |
| `media.codecs` | ❌ 红（H.264 不支持） | ✅ 绿（canPlayType "probably"） | 路 11 | __ | __ |
| `webgl.vendor` | ❌ 红（"Google SwiftShader"） | ✅ 绿（"Intel Inc."） | 路 12 | __ | __ |
| `iframe.contentWindow` | ⚠️ HEADCHR_IFRAME 检测露馅 | ✅ 绿（contentWindow proxy） | 路 13 | __ | __ |
| `window.outerdimensions` | ⚠️ outerHeight=0 露馅 | ✅ 绿（outerHeight=innerHeight+85） | 路 14 | __ | __ |
| `userAgentData.brands` | ⚠️ 缺失 | ✅ 绿（brands 版本与 UA 一致） | 路 15 | __ | __ |
| `navigator.userAgent` | ⚠️ Chrome 120 过期 | ✅ 绿（Chrome 130） | 路 16 | __ | __ |

**整体判定**：
- ✅ pass：13 项全绿（含 v1.4 红的关键项：webdriver / plugins / webgl.vendor / media.codecs）
- ⚠️ partial：≤2 项非绿（记录哪些）
- ❌ fail：≥3 项非绿 或 webdriver 仍红（路 1 是兜底，必绿）

**实测结果**：__________（待回填）

---

## 4. 验收项 3：真实站点冒烟（parse13 §5.3 至少 3 个公开页）

### 4.1 Wikipedia（无 bot 检测，基础可用性）

**动作**：
```
browse_headless(url="https://en.wikipedia.org/wiki/Headless_browser", action="navigate")
browse_headless(url="https://en.wikipedia.org/wiki/Headless_browser", action="extract")
```

**判定**：
- ✅ pass：outcome=worked + 提取到正文 markdown（非空，含 "headless" 关键词）
- ❌ fail：outcome=didnt 或提取空 / challenge 页

**实测 v1.5**：__________

### 4.2 HackerNews（轻度 bot 检测，Y Combinator）

**动作**：
```
browse_headless(url="https://news.ycombinator.com/", action="navigate")
browse_headless(url="https://news.ycombinator.com/", action="snapshot")
```

**判定**：
- ✅ pass：outcome=worked + snapshot 含帖子标题（≥10 条 `<a class="titlelink">`）
- ❌ fail：被 challenge 页挡 / outcome=didnt

**实测 v1.5**：__________

### 4.3 GitHub（中等 bot 检测，public page）

**动作**：
```
browse_headless(url="https://github.com/microsoft/vscode", action="navigate")
browse_headless(url="https://github.com/microsoft/vscode", action="snapshot")
```

**判定**：
- ✅ pass：outcome=worked + snapshot 含仓库 stars / forks 数字
- ❌ fail：跳 challenge / 登录墙 / outcome=didnt

**实测 v1.5**：__________

---

## 5. 验收项 4：creepjs 基准（parse13 §5.3 v1.7 自动化，v1.5 手测）

### 5.1 访问 abrahamjuliot.github.io/creepjs

**动作**：
```
browse_headless(url="https://abrahamjuliot.github.io/creepjs/", action="navigate")
# 等待 creepjs 计算（通常 5-10s）
browse_headless(url="https://abrahamjuliot.github.io/creepjs/", action="snapshot")
```

**判定标准**（核心指纹指标对比 v1.4）：

| 指标 | v1.4 基线 | v1.5 期望 | 实测 v1.4 | 实测 v1.5 |
|---|---|---|---|---|
| `lies` 计数 | 基准 | 显著下降（16 路覆盖减少谎言） | __ | __ |
| `trust score` | 基准 | 上升 | __ | __ |
| `fingerprint` 稳定性 | 基准 | 同 profile 多次访问一致 | __ | __ |

**整体判定**：
- ✅ pass：lies 计数显著下降（≥5 项）+ trust score 上升
- ⚠️ partial：lies 计数下降 < 5（部分路覆盖不到位，记哪些）
- ❌ fail：lies 反而上升（回归）

**实测结果**：__________（待回填）

**注**：creepjs 是激进指纹库，全过非 v1.5 目标（parse13 §7.1 R-V15-5 Camoufox 论证
JS stealth 结构性上限——worker/toString 露馅）；v1.5 定位是过基础检测（sannysoft），
强反爬走 `browse_logged_in`。

---

## 6. 验收项 5：HTTP header 一致性（parse13 §4.5 deferred-Spike）

### 6.1 sec-ch-ua / sec-fetch-* HTTP header 注入路径

**架构约束**：HTTP request header（sec-ch-ua / sec-fetch-*）不能通过 `evaluate_script` 注入
（JS 只能改 navigator 属性，不能改浏览器网络层 header）。要设置 HTTP header 需要：
1. CDP `Network.setExtraHTTPHeaders`——chrome-devtools-mcp@0.3.0 是否暴露此工具？
2. Chromium 启动 flag——只 `--user-agent` 可设 UA，sec-ch-ua 不可由 flag 设

**v1.5 MVP 策略**（已实施）：
- header 集**定义在 StealthProfile 顶级 const**（INV-30 anti-gaming，单测断言字段完整）
- 运行时注入走 **JS 侧 navigator.userAgentData**（ua-client-hints.ts，sec-ch-ua 的 JS API 投影）
- HTTP 网络层 sec-ch-ua header 注入 = **deferred-Spike**（若 chrome-devtools-mcp 不暴露 setExtraHTTPHeaders，
  v1.5 只能做到 JS 侧 userAgentData 一致，HTTP header 侧仍裸奔——但比 v1.4 强，至少 JS 检测过）

### 6.2 真机验证动作

1. 启动 chrome-devtools-mcp，list_tools 查是否有 `set_extra_http_headers` / `set_headers` 类工具
2. 若有：在 StealthEngine.injectProfile 加 `client.callTool("set_extra_http_headers", {...})`
   注入 profile.secChUa / secFetch* / accept*；本项目 §6.3 重新跑
3. 若无：HTTP header 侧 sec-ch-ua 暂裸奔（记为已知短板，v1.6 评估 chrome-devtools-mcp 升版或自建 CDP proxy）

**判定标准**：
- ✅ pass：chrome-devtools-mcp 暴露 header 注入工具 + 抓包验证 sec-ch-ua header 发出且值与 UA 一致
- ⚠️ partial：chrome-devtools-mcp 不暴露 header 工具，但 navigator.userAgentData.brands 正确（JS 侧）
- ❌ fail：JS 侧 userAgentData 也错（ua-client-hints.ts 失效）

**实测结果**：__________（待回填）

---

## 7. 验收项 6：性能基准（parse13 §5.4 + §8.5）

### 7.1 16 路 evasion 注入 latency

**动作**：用 `Date.now()` 在 beforeNavigate 前后计时（或在 StealthEngine.injectProfile 包 timing log）

**判定标准**：
- ✅ pass：< 100ms（一次性注入，parse13 §5.4 阈值）
- ⚠️ partial：100-300ms（可接受，记原因——chrome-devtools-mcp cold start？）
- ❌ fail：> 300ms（影响 browse 体验）

**实测结果**：__________（待回填）

### 7.2 StealthProfile 初始化开销

**动作**：`new StealthEngine()` + 首次 `injectProfile` 计时（含顶级 const 加载）

**判定标准**：
- ✅ pass：< 50ms（顶级 const 加载，header-generator 未引入）
- ❌ fail：> 50ms（排查是否意外引入 npm dep）

**实测结果**：__________（待回填）

---

## 8. 验收项 7：跨 profile 回归（parse13 §3.2）

### 8.1 mac_safari_17 / linux_firefox_121 profile 不发 sec-ch-ua

**集成测断言**（已实施，stealth-headless-integration.spec.ts:313-317）：
- `STEALTH_PROFILES.mac_safari_17.secChUa === ""`
- `STEALTH_PROFILES.linux_firefox_121.secChUa === ""`

真机补验：用 mac_safari_17 profile 访问 sannysoft，确认 `navigator.userAgentData` 为
undefined（Safari/Firefox 原生不支持 userAgentData API，ua-client-hints.ts 应跳过注入）。

**实测结果**：__________（待回填）

---

## 9. 验收项 8：rollback path（parse13 §8.5 生产就绪闸门）

### 9.1 disable switch 验证

**动作**：将 HeadlessChannel 构造改为不传 stealth 实例（`new HeadlessChannel(subproc)`），
build + test，确认：
- 集成测 `stealth-headless-integration.spec.ts:202-213` 「未传 stealth → 内部建 default
  StealthEngine（向后兼容）」仍 pass（向后兼容路径已验证）
- 真机：browse_headless 仍可工作（无 stealth 注入但 navigate 不抛）

**判定**：
- ✅ pass：构造不传 stealth 仍可工作（向后兼容）
- ❌ fail：构造抛 / navigate 抛

**实测结果**：__________（已通过 CI 集成测；真机补验可选）

### 9.2 完整 rollback path（紧急回滚到 v1.4 行为）

**动作**：注释掉 HeadlessChannel.ts:84-94 的 beforeNavigate override + 删 spec args 中的
`--disable-blink-features=AutomationControlled`

**期望**：回到 v1.4「零 stealth 注入」行为，browse_headless 仍可用（只是被 bot 检测概率上升）

**实测结果**：__________（设计上的单点 rollback，无需真机跑）

---

## 10. 验收总表

| 验收项 | 优先级 | 状态 | 实测结果 |
|---|---|---|---|
| 1. chrome-devtools-mcp flag 透传 | P0 | ⚠️ deferred-Spike | __ |
| 2. sannysoft 13 项全绿 | P0 | 待跑 | __ |
| 3. 真实站点 ×3 冒烟 | P0 | 待跑 | __ |
| 4. creepjs lies 下降 | P1 | 待跑 | __ |
| 5. HTTP header 注入路径 | P1 | ⚠️ deferred-Spike | __ |
| 6. 注入 latency < 100ms | P1 | 待跑 | __ |
| 7. 跨 profile 回归 | P2 | 已通过 CI | __ |
| 8. rollback path | P2 | 已通过 CI（设计层） | __ |

---

## 11. 已知短板（v1.5 ship 前须承认 + 后续路线）

| 短板 | 影响 | 缓解 / 后续 |
|---|---|---|
| HTTP header 侧 sec-ch-ua 不注入（§6） | 强指纹库（creepjs）能检测 UA ↔ sec-ch-ua 不一致 | v1.6 评估 chrome-devtools-mcp 升版 / 自建 CDP proxy / Camoufox 路径 |
| `--user-agent` / `--window-size` / `--timezone` 未走 spec args（spike 未解） | viewport/timezone 死字段未激活 | v1.6 chrome-devtools-mcp flag 透传机制确认后补 |
| Camoufox 结构性上限（worker / toString 露馅） | 强反爬站点仍挡 | parse13 §7.1 R-V15-5；定位是过基础检测非企业级反爬，强反爬走 browse_logged_in |
| puppeteer-extra-plugin-stealth@2.11.2 停更（2023.3） | evasion 可能过时 | v1.7 加 creepjs 回归门禁 + 定期跟版 |

---

## 12. 回滚决策树（实测失败时）

- **sannysoft 仍 ≥ 3 项红** →
  - 排查 StealthEngine.injectProfile 是否被 beforeNavigate 真调到（看 `stealth_injected` log evt）
  - 排查 evaluate_script 是否抛错（看 `stealth_inject_stealth_core_failed` log evt）
  - 仍失败 → rollback §9.2，本 feature 延后到 v1.5.1

- **真实站点冒烟 ≥ 1 个 fail** →
  - 排查是否 Cloudflare challenge 页（detectCloudflareChallenge 应升 manual-switch）
  - 排查该站点是否要求 sec-ch-ua header（§6 短板）
  - 仍失败 → feature flag 默认 OFF，手动 enable 路径走

- **性能 > 300ms** →
  - 拆 STEALTH_INJECTION_SCRIPT 为两段 evaluate（async 让步，避免主线程长阻塞）
  - 或推迟到 v1.5.1 优化

---

**版本对应**：本文档随 v1.5.0 release。后续版本更新 stealth 时同步回填实测结果列。
