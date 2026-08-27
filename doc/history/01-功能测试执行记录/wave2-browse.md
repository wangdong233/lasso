# Wave2 重测记录 — browse/登录态面板（wave2-browse）

- **范围**：wave1 browse 面板全部 20 fail（U-02-3/4/5、T-BROWSE-04/05/08/09/11/13/20/24/27/29、T-TOOLS-09/11、U-04-1/4/5、T-LI-04/11）+ 解锁项 T-LI-05/06。
- **版本**：lasso v1.8.0（本日 `npm run build`，dist/index.js 62757B 含 chmod +x，1711 tests + 76 INV 全绿后源码）。
- **环境**：macOS Darwin 21.6.0 / Node v24.12.0 / TUN fake-ip 代理；遗留 Chrome pid 29428（[::1]:9222）、pid 31973（127.0.0.1:9223）、**僵尸 pid 4800（127.0.0.1:9222，持口但不答 /json/version）**；本 CC 会话自带 ~55 个 chrome-devtools-mcp --isolated 进程（孤儿统计只看差值与特征签名）。
- **执行器**：`mcp.mjs` / `mcp-batch.mjs`（SDK Client + StdioClientTransport → `node dist/index.js`，cwd=仓库根，env 全透传）+ `wave2-run.mjs`（解析辅助）。
- **纪律**：每条先对照 v1.8 修复记录的新预期，再实测；仍 fail 判用例/产品，附关键输出。

---

## 1. 结果总表（22 条）

| ID | verdict | 用例判定 |
|---|---|---|
| U-02-3 | **pass** | 用例对；W1-DEF-1/1b 修复生效 |
| U-02-4 | **pass** | 用例对；W1-DEF-1/1b 修复生效 |
| U-02-5 | **pass** | 用例对；W1-DEF-3 修复生效 |
| T-BROWSE-04 | **pass** | 同 U-02-3 |
| T-BROWSE-05 | **pass** | 同 U-02-4 |
| T-BROWSE-08 | **pass** | 用例对；W1-DEF-2 修复生效 |
| T-BROWSE-09 | **pass** | 用例对（wave1 已修 js 形态写法）；W1-DEF-1/1c 修复生效 |
| T-BROWSE-11 | **fail** | 用例对→**产品新缺陷 W2-DEF-N1**（network 工具不导航） |
| T-BROWSE-13 | **pass** | 用例对；W1-DEF-3 修复生效（region 静默忽略=清单既定边界） |
| T-BROWSE-20 | **pass** | 用例对；W1-DEF-1c afterNavigate 生效（16 路首次真机可验） |
| T-BROWSE-24 | **fail** | 用例对→**W1-DEF-6 修复无效**（新机理 W2-DEF-N2） |
| T-BROWSE-27 | **pass** | 用例对；W1-DEF-5 主断言达成（分类粒度见观察） |
| T-BROWSE-29 | **fail** | 过滤逻辑本身正确；fail 归因同 W2-DEF-N1（独立调用 0 entries） |
| T-TOOLS-09 | **pass** | 同 U-02-5，data.path 可直读 |
| T-TOOLS-11 | **fail** | 同 T-BROWSE-11（W2-DEF-N1） |
| U-04-1 | **pass** | 用例对；W1-DEF-7 修复生效（环境注释见 §4） |
| U-04-4 | **pass** | 用例对；W1-DEF-4 修复生效 |
| U-04-5 | **pass** | 用例对；W1-DEF-4 修复生效 |
| T-LI-04 | **pass** | 同 U-04-4 |
| T-LI-11 | **pass** | 用例对；W1-DEF-7 修复生效 |
| T-LI-05（解锁） | **pass** | 用例对；W1-DEF-4 修复后双分支均达 |
| T-LI-06（解锁） | **pass** | 用例对；四断言全中（半截断落 auth_tag 见附注） |

**统计：pass 18 / fail 4 / blocked 0 / waived 0。** 4 fail 全部「用例对→产品缺陷」，归并为 2 个新缺陷编号（W2-DEF-N1 ×3 条、W2-DEF-N2 ×1 条）。

---

## 2. 逐条实录

### U-02-3 / T-BROWSE-04 — extract markdown — **pass**

同会话（navigate → extract）`browse_headless {url:"https://example.com", action:"extract", options:{extract_mode:"markdown"}}`：

```
outcome: worked | title: "Example Domain"
preview: "This domain is for use in documentation examples without needing permission. Avoid use in operations.\n\n[Learn more](https://iana.org/domains/example)"
markdown_engine: defuddle+turndown
```

wave1 表现（`fn is not a function` + fallback_exhausted）消失；markdown_engine 与正文标题断言双中。
**注意**：extract 的 handler 不自行导航——单次独立调用 extract 会 evaluate 在 about:blank 上（实测返回空 title/空 markdown 但 worked + markdown_engine 仍标记）。清单流程 U-02-1→U-02-2 先导航，用例侧不判错；记为观察 W2-OBS-1（url 入参对非 navigate action 仅作 SSRF/状态键，不触发导航）。

### U-02-4 / T-BROWSE-05 — extract markdown_cited（HN） — **pass**

```
title: "Hacker News" | engine: defuddle+turndown
citations: [{"n":1,"url":"https://huggingface.co/Qwen/Qwen3.8-27B-FP8"},...（前 5 条）]
preview: "1.\n\nQwen 3.8 27B ⟨1⟩ ([huggingface.co](from?site=huggingface.co)) ..."
```

- 角标转换：preview 中 `⟨N⟩` 计 14 处（U+27E8/27E9）✓
- References 段：content 文件 preview 全文 9732 字符，`References` 位于 7911，`[1] https://huggingface.co/...` 逐条去重列出 ✓
- citations 数组非空 ✓（MCP 层 preview 4000 截断属 T-BROWSE-28 既定行为，全文在 content_path）

### U-02-5 / T-TOOLS-09 — screenshot 落盘 — **pass**

`screenshot {url:"https://example.com"}`（独立调用，两次）：

```
outcome: worked | path: /tmp/lasso-screenshot-5daed169-....png
-rw-r--r--  2095 bytes  magic: 89504e470d0a1a0a  (PNG ✓ ≥100B ✓)
```

文件真实存在 + PNG magic（89504e47 0d0a1a0a）+ 2095B。wave1「返 worked 但文件不存在」消失。

### T-BROWSE-13 — screenshot full_page / region — **pass**

同会话 browse_headless action=screenshot：

```
{"full_page":true}  → worked, preview: "screenshot saved to /tmp/lasso-screenshot-4188367d-....png"（15668B PNG magic ✓）
{"region":{x:10,y:10,width:200,height:100}} → worked, "screenshot saved to /tmp/lasso-screenshot-b7d83702-....png"（15668B）
```

两文件均真实 PNG；region 未生效（两图同尺寸）——与清单「region 被静默忽略（边界确认）」预期一致。附注：action 路径的落盘路径在 `data.preview`（"screenshot saved to ..."），独立 screenshot 工具才有 `data.path` 字段。

### T-BROWSE-08 — wait 等文本 — **pass**

```
{"expect":{"text":"Example Domain"}} → worked | preview: "waited for \"Example Domain\""
{"options":{}}                        → didnt  | error: all_channels_failed_or_skipped
```

wave1 `-32602 Expected string, received array` 消失（W1-DEF-2 修 string 透传）。缺 expect.text → didnt（错误码是通道层汇总 `all_channels_failed_or_skipped` 而非内层文案，观察项不扣分）。

### T-BROWSE-09 / T-BROWSE-20 — stealth 注入 — **pass**

navigate 后 evaluate（`js:"return ..."` 语句体由 v1.8 包进函数体）：

```
return navigator.webdriver
  → worked, preview 含 "```json\nundefined\n```"   （wave1 为 true）
return JSON.stringify({wd:navigator.webdriver, langs:..., hc:...})
  → {"langs":["en-US","en"],"hc":4}   （wd 键被 JSON.stringify 丢弃 = undefined 实证）
stderr: "evt":"stealth_injected","profile":"windows_chrome_120","roads":16
缺 js → didnt ✓
```

afterNavigate 注入（W1-DEF-1c）真机生效：webdriver=undefined、languages 注入、hardwareConcurrency=4（伪装值）。16 路 stealth 自 v1.5 起首次真机可验证生效；isError 检查后记 stealth_injected（日志不再误报，注入均真实成功）。

### T-BROWSE-11 / T-TOOLS-11 — network 资源抓取 — **fail（产品，新缺陷 W2-DEF-N1）**

**底层修复已生效**（同会话 navigate → network action，selenium.dev）：

```
outcome: worked | entries: 22
entry0: {"name":"https://www.selenium.dev/scss/main.min.c81a179e...css","type":"link","duration":164.7,"ttfb":81.3,"bytes":66178,"workerStart":0}
hosts: www.selenium.dev, code.jquery.com, cdn.jsdelivr.net, plausible.io, www.netlify.com, fonts.googleapis.com
```

entries 含 name/type/duration ✓，wave1 `upstream_network_error:fn is not a function` 消失（W1-DEF-1b parseEvalResult 生效）。

**但独立调用 `network` 工具不导航**：network.ts → `headless.browse(url, "network", opts)` → dispatch 直达 doNetwork（evaluate PerformanceObserver），**当前页仍是 about:blank**。独立调用实测（selenium.dev / wikipedia.org，无前置 navigate）：resource_count 恒 0 + next_step 误导提示「可能页面真实简单」。工具头注释与 schema 承诺「URL → navigate + 注入 PerformanceObserver」，实现缺 navigate 步。wave1 该缺陷被 fn 错误遮蔽，W1-DEF-1 修复后暴露。
**判定：用例对 → 产品缺陷 W2-DEF-N1**（修复点：network/pdf 类 URL 驱动工具在 browse 前先 navigate，或 doNetwork 入口自导航）。涉及 T-BROWSE-11、T-TOOLS-11、T-BROWSE-29 三条。
另采证：wikipedia.org 场景 evaluate 上游 `Runtime.callFunctionOn timed out`（重页 + 3s 观察窗 + 上游 protocolTimeout 交互），归 didnt/upstream_network_error:is_error——分类诚实，记录备查。

### T-BROWSE-29 — network 3rd-party 过滤 — **fail（同 W2-DEF-N1；过滤逻辑本身正确）**

同会话（navigate selenium.dev → `network {filter:"3rd-party"}`）：

```
outcome: worked | resource_count: 6 | third_party_count: 6
hosts: code.jquery.com, cdn.jsdelivr.net, plausible.io, www.netlify.com, fonts.googleapis.com
```

过滤与计数逻辑完全正确（6/6 全部 host≠pageHost，pageHost=www.selenium.dev 被排除）。fail 仅因独立调用继承 W2-DEF-N1 不导航（standalone 实测 entries=0）。修复 N1 后本条应自然转 pass，无需单独改代码。

### T-BROWSE-27 — 错误→outcome 分类 — **pass**

```
https://example.com/no-such-page-xyz          → didnt | dns_or_nav_error:net::ERR_CONNECTION_CLOSED at ...
https://nonexistent-domain-xyz123abc.com      → didnt | dns_or_nav_error:net::ERR_CONNECTION_CLOSED at ...
action:"foo"                                  → didnt | unknown_action:foo
```

主断言 404/NXDOMAIN→didnt 双中（wave1 均 worked 假阳性）；unknown_action 分支逐字命中。W1-DEF-5 的 NAV_ERROR_SIGNATURES 校验生效。
**观察 W2-OBS-2**：404 场景实际分类为 `dns_or_nav_error`（ERR_CONNECTION_CLOSED）而非 `http_404`——本机 TUN 代理对 example.com 404 路径直接断连，responseStatus 权威检测（performance API）在连接被断时不可达。outcome 正确、分类粒度受环境限制，不判 fail。

### T-BROWSE-24 — 子进程孤儿清理 — **fail（W1-DEF-6 修复无效，新机理 W2-DEF-N2）**

受控实验（单次 mcp.mjs 生命周期，前后 pid 精确 diff）：

```
before: 95 → after: 97
new pids:
74175  ppid=1  npm exec chrome-devtools-mcp@0.3.0 --headless --isolated --disable-blink-features=...
74196  ppid=74175  node /tmp/npm-cache/_npx/.../chrome-devtools-mcp --headless ...
```

**单次 server 退出净残留 2 进程**（npm exec shim 沦 ppid=1 孤儿 + 其 node 子进程整树存活）。wave2 全程累计：ppid=1 孤儿从基线涨至 40+（04:26-04:28 时间戳与本次运行精确对应；测后已按 `@0.3.0+disable-blink-features` 签名定向清理 42 个，本 CC 会话自带 55 个 --isolated 未动）。

根因（源码级实证，stderr 日志 74 次 lasso_start / 53 次 lasso_shutdown / **0 次 subproc_exit_kill**）：
1. 优雅退出路径 `shutdown() → _kill(name)`：`m.client.close()`（SDK transport 优雅关）后 **`this.procs.delete(name)`**——exit 钩子的 `killAllSync()` 遍历空 map，SIGKILL 永不发出；
2. SDK `client.close()` 对 `npm exec` shim 树不构成致死信号（npm exec 不转发），shim 存活 → ppid=1。
即 killAllSync 代码存在但**在唯一常见路径（优雅退出）上不可达**（SubprocessManager.ts `_kill` 与 index.ts:1151 exit 钩子的执行序错配）。
**判定：用例对 → W1-DEF-6 修复无效，登记 W2-DEF-N2**。修复点：`_kill` 改为先 SIGKILL 后删 map（或 exit 钩子读独立 pid 存量），并对 npm shim 树 `kill(-pgid)` / 直接 spawn node 绕过 npx shim。

### U-04-1 — launch-chrome — **pass（含环境注释）**

三段实测：

| 场景 | 结果 |
|---|---|
| 默认 9222（被占） | `ok:false, error:"cdp_not_ready", pid:74620, profileDir:~/.cache/lasso/chrome-profile-default`，exit=1 |
| `--port 9224`（profile 被上轮存活 Chrome 单例占用） | `ok:false, error:"chrome_exited"`，exit=1 |
| `--port 9226`（干净口） | `ok:true, pid:75159, port:9226, profileDir:...`；`curl 127.0.0.1:9226/json/version` → Chrome/150.0.7871.182 版本 JSON ✓ |

wave1 核心缺陷（假 ok:true + Chrome 秒退 + 9222 永不通）消除：默认注入隔离 `--user-data-dir`（~/.cache/lasso/chrome-profile-default）生效、spawn 后 3s 探活生效、错误码三档（cdp_not_ready/chrome_exited/port_in_use）中两档实测可达。
**环境注释（W2-OBS-3）**：①9222 被**僵尸 pid 4800**（持 IPv4 口但不应答 /json/version）+ pid 29428（[::1]）双占——预检只认「/json/version 有响应」才算占口，遇不应答的僵尸持口者判「空闲」放行 spawn，最终落 cdp_not_ready（诚实失败，但 `port_in_use` 档在本机不可达，预检可加 TCP connect 级检测）；②连续两次默认 profile 启动会因 Chrome 单例转发第二次报 chrome_exited（共用 profileDir 所致，一次性使用场景可接受，记录备查）。

### T-LI-11 — launch-chrome CLI 三元组 + detached — **pass**

`--port 9226` 场景：stdout JSON `{ok:true, binaryPath:"/Applications/Google Chrome.app/...", pid:75159, port:9226}` ✓；CLI 进程退出后 Chrome 75159 仍 LISTEN 127.0.0.1:9226（lsof 实证）→ detached 语义 ✓；curl 版本 JSON ✓。

### U-04-4 / T-LI-04 — cookie export — **pass**

`admin {action:"cookie_restore", op:"export", reason:"backup test"}`（LASSO_CDP_PORT=9223，Chrome pid 31973）：

```
{"ok":true,"op":"export","profile":"default","bytes":728,
 "sha256":"153bdda24f0bdb9fdfcd08e3e9357e81f134e6598de9350602d1105b60e832cc",
 "mode":"0o600","note":"AES-256-GCM encrypted package written (INV-48/49/52)"}
```

文件实测：`~/.cache/lasso/cookies/default.cookies` 存在，`mode=600` size=728，目录 `drwx------`(0700)，`xxd` 头 4B=`4c53 434f`("LSCO") ✓。wave1 `-32601 Network.getAllCookies wasn't found`（Chrome 150 移除）消失——Storage.getCookies 修复生效。

### U-04-5 / T-LI-05（解锁） — cookie import — **pass**

双分支：

```
未 export 先 import → cookie_store_not_found ✓（T-LI-05 负分支）
export 后 import   → {"ok":true,"imported":2,"failed":0,
                       "note":"AES-256-GCM auth-tag verified on decrypt (INV-48/53)"} ✓
```

wave1 传导性 blocked（cookie_store_not_found 因 export 恒失败而不可达主断言）全部解除。

### T-LI-06（解锁） — CookieStore 加密格式 — **pass**

| 场景 | 实测 |
|---|---|
| mode 0600 / 目录 0700 / magic "LSCO" | 全中（见 U-04-4 采证） |
| 头部以下截短（`LSCO\x00\x01` 6B） | `cookie_bad_length` ✓ |
| 改 magic（LSCO→XXXX） | `cookie_bad_magic` ✓ |
| 篡改密文（2 字节翻转） | `cookie_auth_tag_failed` ✓ |
| 恢复原文件再 import | `imported:2, failed:0` ✓ |

附注：对半截断（364B，仍长于头部）落 `cookie_auth_tag_failed` 而非 `cookie_bad_length`——`bad_length` 只对短于固定头部的文件触发，语义合理（GCM 兜底捕获一切长度异常），用例「截断→bad_length」表述宜收窄为「头部以下截短」；不影响判定。

---

## 3. 新缺陷登记（wave2）

| 编号 | 缺陷 | 证据锚点 | 涉及条目 |
|---|---|---|---|
| **W2-DEF-N1** | `network` 工具（及同范式的 URL 驱动单 action）不导航：doNetwork 在 about:blank 上 evaluate，独立调用恒 0 entries + 误导性 next_step；设计注释承诺「URL → navigate + 注入」 | src/tools/network.ts:242（browse(url,"network") 直达 dispatch）；src/channels/BrowseChannel.ts actionDispatch（仅 navigate 包 wrapNavigate）；对照实测 22 entries（同会话）vs 0（独立） | T-BROWSE-11、T-TOOLS-11、T-BROWSE-29 |
| **W2-DEF-N2** | W1-DEF-6 修复无效：优雅退出路径 `_kill` 先 `client.close()` 再 `procs.delete(name)`，exit 钩子 `killAllSync()` 遍历空 map；且 SDK close 对 `npm exec` shim 树不致死 → 每次 server 退出净残留 2 进程（ppid=1） | SubprocessManager.ts `_kill`（delete 顺序）vs index.ts:1151 exit 钩子；stderr 0 次 subproc_exit_kill；受控 diff +2 pid | T-BROWSE-24 |

观察项（不判 fail）：W2-OBS-1 非 navigate action 的 url 入参不触发导航（extract 独立调用空内容，需前置 navigate）；W2-OBS-2 404 在 TUN 断连下分类为 dns_or_nav_error 而非 http_404（responseStatus 检测不可达）；W2-OBS-3 launch-chrome 预检对「持口不应答」的僵尸进程判空闲（port_in_use 档不可达）。

## 4. 环境遗留与清理

- wave1 遗留 Chrome pid 29428（[::1]:9222）/ 31973（127.0.0.1:9223）保留未动；僵尸 pid 4800（127.0.0.1:9222 不应答）非本轮产物，未动。
- 本轮启动的 Chrome（9225 手动 / 9226 launch-chrome，pid 74856/75159）测后已 kill。
- wave2 产生的 chrome-devtools-mcp ppid=1 孤儿 42 个已按签名（@0.3.0 + --disable-blink-features=AutomationControlled）定向清理；清理后存量 55 个全部为本 CC 会话自带（--isolated，@latest），未触碰。
- cookie 包备份：/tmp/w2-cookies-backup；`~/.cache/lasso/cookies/default.cookies` 已恢复为 export 原件（import 复验 imported:2）。
