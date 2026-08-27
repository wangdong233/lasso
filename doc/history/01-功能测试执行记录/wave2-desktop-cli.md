# Wave2 重测执行记录（desktop + CLI 面板）

## 执行时间与环境

- 执行时间：2026-08-15 04:15 – 04:50（UTC+8）
- 机器：MacBookPro11,4，macOS 12.x（Darwin 21.6.0）；Node v24.12.0
- lasso **v1.8.0**：`npm run build`（tsc + chmod +x dist/index.js）当次重建，`--version` 实测输出 `1.8.0`
- MCP 客户端：复用 `mcp.mjs`（SDK Client + StdioClientTransport → `node dist/index.js`，cwd=仓库根，env 全量透传）；单会话多调用场景用本目录新建 `w2-browse-session.mjs` / `w2-steps2.mjs`（同一 server 进程内连续 callTool）
- TCC：Accessibility 已授权 / Screen Recording 已授权（wave1 探测 C 结论沿用，本轮无弹窗）
- 上游：chrome-devtools-mcp@0.3.0（npx 冷启动实测 navigate 首调 17.5s，与 wave1 探测 B 一致）
- 网络注意（沿用 v1.8 修复记录）：httpbin.org 本机被代理拦成中文错误页，404 用例按修复记录改用 `https://example.com/404`（curl 预检 `HTTP/2 404` ✓）

## 重测结论总表

| ID | wave1 | wave2 verdict | 一句话 |
|---|---|---|---|
| T-DESKTOP-09 | fail（W1-DEF-8） | **pass** | region 裁剪真实生效：`{0,0,800,600}` → PNG IHDR **1600×1200**（@2x Retina = 800×600 pt 精确）；width/height 已透出 data |
| T-DESKTOP-18 | fail（W1-DEF-9） | **pass** | ENOENT **21-28ms** reject（<1.5s 达标 70 倍余量），归因 `rust_helper_crashed:subproc_spawn_failed`；二次调用同速（closed 标记生效） |
| F-CLI-01 | fail | **pass** | `--version`/`-v` → `1.8.0` exit 0；`--help`/`-h` → usage exit 0；未知子命令 → usage 走 **stderr** + **exit 1** + stdout 0 字节、不挂起 |
| T-CLI-05 | fail（D11） | **pass**（附新缺陷 W2-DEF-1） | flag 真实解析：#38 spawn headless + stealth 16 路注入 + probeCreepjs 实跑（totalLies=0）；但 clean build 下 baseline fixture 不在 dist → 门禁止步 warn |
| T-BROWSE-14 / U-03-1 | fail（D2） | **pass** | steps 经 MCP 可达：actions_and_results/budget_used_ms 齐全；负向链 didnt + stopped_at 精确边界 |
| T-BROWSE-09 | fail（W1-DEF-1 半） | **pass** | `js:"return ..."` 语句体可执行；navigate 后 `navigator.webdriver` → **undefined**；缺 js → didnt |
| T-BROWSE-20 | fail（W1-DEF-1） | **pass** | 单会话 navigate→evaluate：`undefined | en-US,en | 4 | 5 | Windows UA`——16 路注入真机生效（W1-DEF-1c 修复实证） |
| U-08-3 | fail（W1-DEF-5） | **pass** | `example.com/404` → **didnt + `http_404:client_error`**（419ms，诚实否定） |
| T-BROWSE-27 | fail（W1-DEF-5） | **pass** | NXDOMAIN → **didnt + `dns_or_nav_error:net::ERR_CONNECTION_CLOSED`**；`action:"foo"` → didnt+`unknown_action:foo`（维持） |
| T-DESKTOP-01（回归） | pass | **pass** | Finder snapshot worked，root `@e0` application「访达」树正常 |
| T-DESKTOP-02（回归） | pass | **pass** | `find {text:"文件"}` worked，count=9 |

**统计：执行 11 条，pass 11 / fail 0 / blocked 0 / waived 0。**

---

## 逐条证据

### T-DESKTOP-09 screenshot + region 裁剪（W1-DEF-8 重测） — **pass**

两调用（各自独立 MCP 会话，PNG IHDR 字节 16-20/20-24 直接 readUInt32BE 断言）：

| 调用 | outcome | PNG magic | IHDR W×H | data 透出字段 |
|---|---|---|---|---|
| `desktop {action:"screenshot"}` | worked | PNG ✓ | 2880×1800（全屏） | `screenshot_width=2880, screenshot_height=1800` |
| `+ options:{screenshot_region:{x:0,y:0,w:800,h:600}}` | worked | PNG ✓ | **1600×1200** | `screenshot_width=1600, screenshot_height=1200` |

- wave1 同用例返回 2880×1800 全屏（裁剪被 wire 键名漂移吞掉）；wave2 裁剪**真实生效**。
- 1600×1200 = 800×600 逻辑 pt × Retina scale 2 精确值。清单预期「尺寸≈800x600」按**逻辑像素**口径成立（用例侧口径注记即可，非缺陷）。
- width/height 现已透出到 data（wave1 附带的「用例小笔误：data 无 width/height」同步消除）。
- 用例判定：用例对（v1.8 预期达成）。

### T-DESKTOP-18 ENOENT 快速 reject + rust_helper_crashed 归因（W1-DEF-9 重测） — **pass**

`LASSO_RUST_HELPER_PATH=/nonexistent`，单会话脚本内只计 callTool 耗时（排除 node 启动 + MCP connect）：

```
run1: isError=true text="rust_helper_crashed:subproc_spawn_failed" callTool_ms=21
run2: isError=true text="rust_helper_crashed:subproc_spawn_failed" callTool_ms=28   ← closed 标记后同样快速拒绝
```

- server stderr：`rust_proc_error: spawn /nonexistent ENOENT` → `rust_helper_error {code:"ENOENT", pending:1}`（pending 确实被 reject，非只打日志）。
- wave1 表现：每次烧满 3s 超时 + 归因 `rust_call_timeout:*`；v1.8 承诺 `rust_helper_crashed:subproc_spawn_failed` **逐字命中**，<1.5s 达标（实测 21-28ms）。
- 用例判定：用例对（v1.8 预期达成）。

### F-CLI-01 --version / --help / 未知子命令三分支 — **pass**

| 分支 | 实际 | 判定 |
|---|---|---|
| `--version` / `-v` | stdout `1.8.0`，exit 0 | ✓ |
| `--help` / `-h` | stdout 完整 usage（含 `doctor [--stealth-check]` 行 + Flags 段），exit 0 | ✓ |
| `frobnicate`（未知子命令） | stdout **0 字节**，usage 走 **stderr**，**exit 1**，不挂起（`</dev/null` 直返） | ✓ |

- wave1 表现：argv 白名单外静默落入 MCP server 模式，stdout 0 字节挂起等 stdin。v1.8 三分支全部按承诺落地。
- 用例判定：用例对（v1.8 预期达成）。

### T-CLI-05 `doctor --stealth-check` 真实解析（D11 重测） — **pass**（附新缺陷 W2-DEF-1）

干净 build（刚 tsc 完，未动 dist）下 `node dist/index.js doctor --stealth-check`：

1. **flag 不再被忽略**（对照 wave1：输出与不带 flag 完全一致、#38 恒 warn-skip）。实测 stderr：

```
subproc_spawned name=headless pid=47416
stealth_injected profile=windows_chrome_120 roads=16        ← #38 真的拉起浏览器注入了
```

2. **#38 走到了步骤 5（读 baseline）才 warn**：

```json
{"name":"stealth_creepjs_regression","status":"warn",
 "detail":"creepjs-baseline.json 读取失败：ENOENT ... 'dist/doctor/fixtures/creepjs-baseline.json'",
 "next_step":"检查 .../dist/doctor/fixtures/creepjs-baseline.json 存在 + JSON 合法"}
```

→ **新缺陷 W2-DEF-1**：`src/doctor/fixtures/creepjs-baseline.json` 存在，但 build（纯 tsc）不复制 .json 资产，`dist/doctor/fixtures/` 不存在；且 `.npmignore` 保 src 也救不了——代码用 `__dirname/fixtures`（doctor.ts:2554）解析的是 **dist** 路径，npm 安装包同样命中。clean build / npm 安装下 #38 门禁永远止步于 baseline-read warn。修复一行：build script 补 `cp src/doctor/fixtures/*.json dist/doctor/fixtures/`（或 tsc asset 方案）。

3. **诊断补证**（手动 cp fixture 进 dist 后复跑，跑完已删除还原 dist 原状）：

```json
{"name":"stealth_creepjs_regression","status":"warn",
 "detail":"creepjs-baseline.json 未 freeze (frozenAt=null)。本次实跑：totalLies=0,
           navigatorLied=false, liedModules=[]。首次 freeze 须把此数值写入 baseline..."}
```

→ fixture 补齐后门禁走完全部 6 步：probeCreepjs **实跑成功**（totalLies=0、navigatorLied=false——stealth 16 路注入下 creepjs 判 0 lies，与 T-BROWSE-20 互证），warn 档位是设计内「baseline 待 freeze」状态（6a 分支），非 skip。

- 裁决：D11 的承诺「--stealth-check 真实解析、#38 实跑」**达成**，判 pass；W2-DEF-1（构建产物缺 fixture）独立记录为产品缺陷（轻，一行 build 修复），不推翻本条主断言。
- 用例判定：用例对（v1.8 预期达成；fixture 缺失是产品构建问题非用例问题）。

### T-BROWSE-14 / U-03-1 steps 多步链经 MCP 可达（D2 重测） — **pass**

正向链（`action:"navigate"` + `options.steps:[snapshot, wait(expect text), evaluate]`，单会话）：

```
outcome=worked  data.action="chain"  budget_used_ms=462  stopped_at=undefined(worked 不填 ✓)
step=snapshot(snap)        outcome=worked  dur=8ms   preview="# take_snapshot response ## Page content uid=2_0 RootWebArea..."
step=wait(wait-title)      outcome=worked  expect_check=preexisting  dur=244ms  ← 文本已在页，tri-state 判 preexisting ✓
step=evaluate(eval-title)  outcome=worked  dur=209ms  preview="Example Domain"  ← return document.title 求值成功
```

负向链（中间步 wait 不可能文本 `timeout_ms:3000`，尾步 `never-reach`）：

```
outcome=didnt
stopped_at={"step_index":1,"reason":"failed_postcondition","failed_action":"wait","detail":"expect failed: {...}"}
steps_done=evaluate>wait   ← 第三步精确未执行（Skyvern 精确边界语义 ✓）
```

- wave1 表现：steps 被 zod strip、行为等同单步 navigate（D2 证据采集）。v1.8 schema 补 steps 后经 MCP **真实可达**，审计链/边界/预算三要素齐全；W1-DEF-2b（steps 先导航再跑链）隐含验证——snapshot 步拿到的已是 example.com 页面而非 about:blank。
- 用例判定：用例对（v1.8 预期达成；U-03-1 旧「证明 D2」预期已被 v1.8 修复记录取代，按新预期裁决）。

### T-BROWSE-09 evaluate js 语句体（W1-DEF-1 半侧重测） — **pass**

单会话 navigate→evaluate（wave1 改写发现 `() => navigator.webdriver` 返 true；v1.8 修复记录承诺用户 `js` 语句体自动包函数体）：

- `options:{js:"return navigator.webdriver"}` → worked，preview=`# evaluate_script response\nScript ran on page and returned:\n```json\nundefined\n``` ` → **语句体可执行且值为 undefined**（wave1 为 true）。preview 带原文围栏是 `undefined` 非 JSON 时 parseEvalResult 的设计内回退（见观察 O-3），值可读。
- 缺 js → didnt（top error=`all_channels_failed_or_skipped`，审计链保留内因 `Error: evaluate: opts.js required`，双通道各一条）——「缺 js 报错」断言成立。
- 用例判定：用例对（v1.8 预期达成）。

### T-BROWSE-20 stealth 16 路真机生效（W1-DEF-1/1c 重测） — **pass**

单会话 navigate example.com → evaluate 多探针：

```
[typeof navigator.webdriver, navigator.languages.join(','),
 navigator.hardwareConcurrency, navigator.plugins.length, navigator.userAgent.slice(0,60)].join(' | ')
→ "undefined | en-US,en | 4 | 5 | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
```

- `navigator.webdriver` = **undefined**（wave1 实测 true）✓
- languages=`en-US,en`、UA=Windows Chrome（`windows_chrome_120` profile 伪造值，真机是 macOS/zh-CN）✓
- hardwareConcurrency=4、plugins.length=5（伪造档位）✓
- 互证：T-CLI-05 诊断跑里 doctor #38 用同 StealthEngine 注入后 creepjs 实跑 **totalLies=0 / navigatorLied=false**——第三方指纹引擎视角 16 路注入自 v1.5 起首次真实生效。
- 用例判定：用例对（v1.8 预期「navigator.webdriver 应 undefined」逐字达成）。

### U-08-3 / T-BROWSE-27 404 与 NXDOMAIN 诚实 didnt（W1-DEF-5 重测） — **pass**

| 输入 | wave1 | wave2 实测 |
|---|---|---|
| `https://example.com/404`（curl 预检 HTTP/2 404） | worked（假成功） | **didnt**，error=`Error: http_404:client_error`，419ms，data=null，不触发截图/抽取 |
| `https://nonexistent-lasso-test-xyz123.invalid` | worked + Chrome 错误页快照 | **didnt**，error=`dns_or_nav_error:net::ERR_CONNECTION_CLOSED`，230ms |
| `action:"foo"`（维持项） | didnt+unknown_action | didnt + `unknown_action:foo`（复测一致） |

- NXDOMAIN 在本机 TUN fake-ip 下呈现为 `ERR_CONNECTION_CLOSED` 而非 `NAME_NOT_RESOLVED`——环境塑形错误文案，但 NAV_ERROR_SIGNATURES 命中、**归因诚实**（wave1 环境放大项已不掩盖结果）。
- 404 检测按修复记录走 performance API responseStatus 权威路径（httpbin 内容签名不可达问题绕开）。
- 用例判定：用例对（v1.8 预期达成）。

### T-DESKTOP-01 / T-DESKTOP-02 回归抽测（TCC 双授权下顺带） — **pass / pass**

- 01：`snapshot {app:"Finder",max_depth:4}` → worked，data.root role=application label=「访达」 ref=`@e0`，window 层 ref=@e1 带 rect —— 与 wave1 pass 形状一致，无回归。
- 02：`find {app:"Finder",where:{text:"文件"}}` → worked，count=9。

---

## 新缺陷与观察（wave2 本面板新增）

### W2-DEF-1（产品缺陷，轻，一行修复）：build 不复制 creepjs-baseline.json 进 dist

- 证据：见 T-CLI-05 第 2 步。`src/doctor/fixtures/creepjs-baseline.json` 存在；`npm run build`（纯 tsc）后 `dist/doctor/fixtures/` 不存在；doctor.ts:2554 按 `__dirname/fixtures` 解析 dist 路径；`.npmignore` 保 src 不改变解析目标。clean build / npm 安装下 `--stealth-check` 门禁永远止步 baseline-read warn，freeze/比对路径不可达。
- 处置建议：build script 追加 `mkdir -p dist/doctor/fixtures && cp src/doctor/fixtures/*.json dist/doctor/fixtures/`；修复后 #38 可走到「未 freeze → 实跑数值写回」完整闭环。

### 观察（不判 fail，供产品组参考）

- **O-1（stealth 语义边界）**：stealth 注入时机是 afterNavigate（每次 navigate 完成后覆盖当前文档）。**新会话直接调 `evaluate`（不先 navigate）会在 about:blank 上执行且未注入**——本轮实测独立进程首调 `js:"return navigator.webdriver"` 返 true、`typeof` 为 `boolean`；同会话 navigate 后即 undefined。这是 W1-DEF-1c 修复的设计行为（evaluate 不导航、复用上游当前页），但「evaluate 带 url 参数却在别的页执行」存在用户预期落差，建议 README/KEY-GUIDE 注明「evaluate 须跟在同会话 navigate 之后」或 evaluate 前置导航。
- **O-2（wait 步 timeout 未透传）**：负向链 wait 步 `timeout_ms:3000`，实际整链 34.4s——doWait 只传 `{text}` 给上游 wait_for（W1-DEF-2 修复时改的单 string），`opts.timeout_ms` 未透传，烧的是上游默认超时。与 W1-DEF-9 修复前的「烧满超时」同类延迟可观测性问题（轻）。
- **O-3（undefined 返回值的 preview 回退）**：evaluate 返回 `undefined`（非 JSON）时 parseEvalResult 返 null → preview 回退为上游原文（含 ```json 围栏与说明文字），值仍可读但略噪；返回合法 JSON（如字符串 "Example Domain"）时解析干净。纯观感项。

## 遗留与清理

- 诊断用 `dist/doctor/fixtures/` 已删除（dist 还原为 build 原状）；`w2-browse-session.mjs` / `w2-steps2.mjs` / `w2-time-call.mjs` 留在本目录作复测脚本；`w2-browse-stderr.log` 留证。
- wave1 遗留运行物（Chrome 9222/9223、8765 http server、chrome-devtools-mcp 孤儿）未动。
