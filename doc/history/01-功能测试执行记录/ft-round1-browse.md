# ft-round1 — R11 浏览与交互域（T-BROWSE 核心 / T-REFS / stealth 真机 / T-LIFE）

- **执行员**：R11（browse 域）
- **日期**：2026-08-18 19:07–19:51
- **版本**：lasso-mcp v1.17.0 → **v1.17.1-dirty（本轮修 2 缺陷，未 bump 版本号）**；基线门禁 pre：`npm run build` ✓ / 2227 tests（2226 pass + 1 skip）/ 81 INV / selftest 20/20。
- **环境**：macOS Darwin 21.6.0 / Node v24.12.0 / ClashX TUN fake-ip；用户 Chrome pid 2420 持 127.0.0.1:9222（LISTEN）；台账起点 `[]`；**并行面板警示**：本轮执行期间有兄弟 R 面板并发跑 lasso（曾见 pid 5508 `launch-chrome --mode hidden` + 9222 lasso-chrome + `chrome-stop --port 9223`）——共享台账互扰 2 次（见 OBS-R11-3），后续均用 `LASSO_LAUNCHED_CHROMES_PATH` 隔离重测。
- **执行器**：`ft-r11-browse.mjs`（A/B/C/D/E/F/G/H 全程单 server 串行会话）、`ft-r11-probe2.mjs`（W/R/S 聚焦探针）、`ft-r11-life.sh`/`ft-r11-life2.sh`（T-LIFE）、`ft-r11-cost.mjs`（L-COST-04/14）、`ft-r11-e3.mjs`/`ft-r11-verify.mjs`（修复复测）；资源采样 `ft-r11-meter.mjs`（复刻 test/helpers/resource-meter.ts 三特征 + ppid 闭包）。全部串行 + 用例间 2s 间隔（§0.2）。
- **纪律执行记录（§0.2 第 1/2 条，先判用例）**：本轮 3 次初判 fail 后判定为**用例 bug 而非产品 bug**（F01 steps expect 大小写、H02 fill 把 `<a>` 当输入框、A06 wait 的 URL 语义），1 次 fail 判定**用例对→产品缺陷**（W2 wait 假成功），1 次 fail 判定**用例对→产品缺陷**（E3 tab_restore 恒 no-op）。两个产品缺陷已修 + 单测 + 真机复测 + 全量门禁（见 §6）。

---

## 1. 结果总表

| 用例 | verdict | 一句话证据 |
|---|---|---|
| T-BROWSE-01 navigate 正/404/NXDOMAIN | **pass** | worked+final_url；`http_404:client_error` didnt；`dns_or_nav_error:…net::ERR_CONNECTION_CLOSED` didnt |
| T-BROWSE-02 snapshot | **pass** | 361 字符 a11y 树，含 "Example Domain" |
| T-BROWSE-03 extract raw 默认档 | **pass** | 与 snapshot preview 逐字节相同（361B=361B，尾串一致）；无 byline/citations |
| T-BROWSE-04 extract markdown | **pass** | `markdown_engine:"defuddle+turndown"`；**别名字段 `data.markdown` 存在且=preview（149B）**；raw 档无该字段 |
| T-BROWSE-05 markdown_cited（HN） | **pass** | citations 59 条；preview 4022B 截断带 `…[truncated by lasso]`；References 段 `[8] https…` 可见 |
| T-BROWSE-08 wait（修复后复测） | **pass** | 在场 44ms worked；缺 text → didnt；**负路径（文本永现）修复前假 worked 30009ms → 修复后 didnt（见 W-DEF-R11-1）** |
| T-BROWSE-09 evaluate webdriver | **pass** | ```` ```json\nundefined\n``` ````（stealth 生效佐证） |
| T-BROWSE-10 pdf | **pass**（**清单勘误 F-R11-1**） | 真机 `-32602: Tool pdf not found` → didnt + `retrieval_method:"upstream_unsupported:pdf"` + next_step——上游 1.7.0 **无** pdf 工具（清单漂移声明 6③ 与此相反，错） |
| T-BROWSE-11 network 原生 | **pass**（**清单勘误 F-R11-2**） | worked + `retrieval_method:"native_list_network_requests"`；example.com rc=1/3p=0（**W2-DEF-N1 修复保持**）；实际字段 name/type(常空)/reqid/method/status/third_party——**无 duration** |
| T-BROWSE-12 console（v1.11 实装） | **pass** | evaluate 注 `console.log('lasso-ft-console-marker')` 后 action=console 返回 `[{"id":3,"type":"log","text":"lasso-ft-console-marker","argsCount":1}]` |
| T-BROWSE-13 screenshot 真文件 | **pass** | `/tmp/lasso-screenshot-*.png` 45418B PNG magic 1680x1050（工具档含 `data.path`；action 档路径在 preview）；region 变体同尺寸=静默忽略（清单既定边界） |
| T-BROWSE-14 steps 链 | **pass** | **steps 经 MCP 可达（D2 v1.8 已修，§0.3 行过时——F-R11-3）**；S1 链 worked：actions_and_results[2] + navigate duration_ms:1103 + expect 命中 |
| T-BROWSE-15 expect 三态 | **pass** | S1 preexisting→worked 4159ms；S2 超时→`expect failed:{"text":...,"timeout_ms":3000}` didnt 5291ms（**timeout_ms 被 honor**）；三字段全缺→schema optional 不拒 |
| T-BROWSE-16 headless→logged_in fallback | **pass**（旁证） | VA-2 wait_timeout→unknown→`served_by:browse_logged_in, fallback_used:true`（didnt 类不触发，A09/A10 无 fallback ✓） |
| T-BROWSE-17 SSRF 守门 | **pass** | navigate/pdf/screenshot/network 四入口均 didnt + `rm:"ssrf_blocked"` + `ssrf_blocked:private_ip:192.168.1.1`（零配置，未起浏览器即拒） |
| T-BROWSE-18 StateStore 落盘 | **pass** | 每条 worked 带 state_id+content_path；B01/B02 content 文件实读成功（JSON 含 url/action/preview） |
| T-BROWSE-19 48KiB spill | **pass**（部分面） | network envelope `{preview,truncated}` 走 spill 语义；pdf 侧因上游无 pdf 工具不可达（F-R11-1 连带）；read_text 续读属 R-read 面板 |
| T-BROWSE-20 stealth 注入 | **pass** | stderr `stealth_injected profile=mac_chrome roads:16`（afterNavigate 时机，W1-DEF-1c 修复保持） |
| T-BROWSE-24 子进程清理 | **pass** | 资源三采样 before=0 → peak=18 → after(2.5s)=3（SIGTERM 轮询窗口内）→ **after(+90s)=0**；当前 `--disable-blink-features` 特征进程 0 |
| T-BROWSE-27 错误→outcome | **pass** | `unknown_action:foo` didnt；404/NXDOMAIN didnt；wait_timeout（新）→unknown 可 fallback |
| T-BROWSE-28 preview 4000 上限 | **pass** | wiki/books 均 4022B（4000+尾标）+ `…[truncated by lasso]` |
| T-BROWSE-29 3rd-party 过滤 | **pass** | selenium.dev filter=3rd-party：rc=9 **9/9 third_party:true**（code.jquery.com/cdn.jsdelivr.net/plausible.io/netlify.com——真第三方） |
| T-BROWSE-31 引擎档+URL 透传 | **pass** | github 页 engine 仍 `defuddle+turndown`；正文链接全绝对化（`https://github.com/...`） |
| T-BROWSE-32 stealth 三件套 | **pass** | webdriver=undefined；languages="en-US,en"；hardwareConcurrency=4；platform="MacIntel"（mac_chrome darwin 默认档，UA/platform 一致性 v1.12 T2-1 生效） |
| T-BROWSE-33 会话语义边界 | **pass** | 先驻 vscode 页，再单发 `extract url=example.org` → title 仍 "microsoft/vscode"（extract 不导航——设计行为证据在档） |
| T-REFS-02 附录格式 | **pass** | books.toscrape：`## Interactive refs` + `- [r1] a "Books to Scrape" → index.html`… **恰 50 条（REFS_CAP 命中）** |
| T-REFS-03 正文零内嵌/byte-identical | **pass** | content 文件实读：ON=9142B（body 5529 + 附录 3611），OFF=5529B，**body1===p2 → true（逐字节）** |
| T-REFS-04 附录钉尾抗截断 | **pass** | wiki 长页 ON preview=7709B = 截断正文 + 完整附录钉尾（尾行 `- [r?] a "Browsers based on Chromium" → #…`）；OFF=4022B 截断 |
| T-REFS-05 ref→click 往返 | **pass** | G02 `clicked r1 (a via lasso ref)` → G03 snapshot；**R1 全链**：fill r2/r3 → click r4(Login) → snapshot 显示 `/secure`（登录成功） |
| T-REFS-06 ref→fill | **pass** | `filled 2 fields (2 via lasso ref)`；evaluate 验证 `u:"tomsmith", p:"SET"` |
| T-REFS-08 raw 档组合 | **pass** | `ignored_include_refs:true` + raw 快照输出（宽松进严格出） |
| T-REFS-05b ref 失效诚实语义 | **pass** | click r77（超 cap）→ didnt + `ref_stale_re_snapshot: ref "r77" not found in DOM` |
| T-LIFE-01 hidden 启动档 | **pass** | 探活 Chrome/150；**FRONT_BEFORE=AFTER=Finder（零夺焦点）**；cmdline：`--no-startup-window --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --mute-audio`（三件套+mute 齐） |
| T-LIFE-03 默认档 | **pass** | 不传 --mode → 台账 `mode:"hidden"` + cmdline 同上（argv>config>内置默认链，config.ts:284 默认 hidden 生效） |
| T-LIFE-04 台账登记 | **pass** | port/pid/profileDir/launchMode/idleMs 全字段；`chrome_ledger_recorded status:ready` |
| T-LIFE-05 chrome-stop 五步 | **pass** | `{"stopped":[{"port":9230,"pid":73406,"action":"killed"}]}` + 删账 |
| T-LIFE-06 pid 复用保护 | **pass**（单测面） | suite 全绿含该 spec（本轮未单跑） |
| T-LIFE-07 幂等与定向 | **pass** | 定向只关 9230（9229 存活）；--all 清 9229；空台账 --all 与无 flag 均 exit 0 `stopped:[]` |
| T-LIFE-08 idle reaper | **pass** | **活动臂**：idle-ms 20000 下每 8s browse，+28/+36/+44s 全部存活；**闲置臂**：停触后 +47s `REAPED_AFTER_IDLE`（20s 阈值 + 15s 周期口径内） |
| T-LIFE-09 reaper 禁用 | **pass** | `chrome_idle_reaper_disabled idle_ms:0` 日志（env=0） |
| T-LIFE-10 活动打点 | **pass**（旁证） | onChromeUse→touch(cdpPort) 接线由 T-LIFE-08 活动臂端到端证明 |
| T-LIFE-11 hidden 预建 bg tab | **pass** | `chrome_bg_tab_precreated port:9229 targetId:5373D3CE…` |
| T-LIFE-12 tab_restore | **pass**（**修复后**，W-DEF-R11-2） | 修复前：canonical 流程恒 `browser_restarted` no-op；修复后 VB：`pages after open=[example.org, example.com]` → restore `closed:[4A8EC20B…]` → **`pages after restore=[example.com]`**（只关 lasso 开的 tab）；未注入/CDP 死两态 `no_snapshot`/`cdp_unreachable` 诚实 |
| L-COST-04 browse 兜底第一跳 | 回填 | baidu SERP 直访：nav 9341ms + extract 904ms；md 4022B 为降级壳页（result_hints=0、captcha=false——本轮非验证码形态，同为 0 条） |
| L-COST-12 launch-chrome 冷启动 | 回填 | **2592ms / 3181ms**（两次独立 hidden 冷启到探活 200；npx 预热后） |
| L-COST-14 include_refs 开销 | 回填 | 同页 A/B×3 deltas **[+8, −18, +191]ms**（中位 ≈0——expr 顺带无第二跳，与预期一致） |

**统计：执行 42 条 → pass 40 / fail→修复后 pass 2（W-DEF-R11-1/2）/ blocked 0 / waived 0。**（含 3 条初判 fail 后判用例 bug 重测通过；2 条判产品缺陷已修复复测。）

---

## 2. 关键实录摘编

### 2.1 extract 三档 + markdown 别名字段（A02/A03/A04/A05b）

```
A02 snapshot : previewLen 361  title "## Latest page snapshot"
A03 extract  : previewLen 361  （byte-identical：与 A02 尾串一致 "uid=1_4 StaticText \"Learn more\"\n"）
A04 markdown : dataKeys +markdown_engine,+markdown | engine=defuddle+turndown | markdown(149)=preview(149)
A05b cited   : citations=59 [{"n":1,"url":"https://pixelcluster.dev/VRAM-Overcommit/"},…] | preview 4022（截断）
```

别名字段语义（源码锚点 BrowseChannel.ts:346-350）：`markdown` 仅 markdown* 档出现、与 preview 同值（均经 refs 附录感知截断）；raw 档 dataKeys 无此键——byte-identical 铁律保持。

### 2.2 T-REFS 全链（B/G/R/H 批）

```
B01 refs ON : preview 7635（MCP 档=截断正文+完整附录）；content 文件 9142 = body 5529 + appendix 3611（50 refs 恰 cap）
B02 refs OFF: content 文件 5529 —— body1===p2 → true
G02 click r1: "clicked r1 (a via lasso ref)"（querySelector [data-lasso-uid="r1"] + JS click）
G04 click r77: didnt + ref_stale_re_snapshot: ref "r77" not found in DOM
R1 fill r2/r3: "filled 2 fields (2 via lasso ref)" → {"u":"tomsmith","p":"SET"} → click r4 → /secure
B05 raw+refs : dataKeys 含 ignored_include_refs:true
H01 附录形态: "## Interactive refs\n- [r1] a → https://github.com/tourdedave/the-internet\n- [r2] input[type=text]\n- [r3] input[type=password]\n- [r4] button[type=submit] \"Login\"\n- [r5] a \"Elemental Selenium\" → …"
```

### 2.3 stealth 真机（A07/A08 + stderr）

```
A07 return navigator.webdriver → preview "page and returned:\n```json\nundefined\n```"
A08 → {"langs":"en-US,en","hc":4,"plat":"MacIntel"}
stderr: "evt":"stealth_injected","profile":"mac_chrome","roads":16 ×17 次（每次 navigate 后）
```

profile=mac_chrome（darwin 宿主默认，v1.12 T2-1）：UA/platform/client-hints 三方一致；sec-ch-ua HTTP 头侧由 `--accept-lang`/`--user-agent` launch 级对齐（HeadlessChannel.ts:85-100）。

### 2.4 T-LIFE 关键输出

```
A1 launch 9229 hidden: ok pid=73376 wall 2592ms；chrome_hide_fuse_ok；探活 Chrome/150.0.7871.182
FRONT_BEFORE: Finder → FRONT_AFTER: Finder（零夺焦点）
chrome-stop --port 9230 → {"stopped":[{"port":9230,"pid":73406,"action":"killed"}]}；9229 探活不受影响
E3（隔离台账）: keep1/2/3（+28/+36/+44s）probe=200 → 停触后 +47s REAPED_AFTER_IDLE
VB（修复后）: pages [example.org, example.com] → tab_restore closed:[4A8EC20B…] → pages [example.com]
停机收尾: lasso_shutdown sig=stdin_eof → stopLaunchedChromes(all) → 台账清空、chrome 亡（设计行为）
```

---

## 3. 新缺陷（2，已修）+ 观察（5）+ 清单勘误（3）

### W-DEF-R11-1 — doWait 双缺口：timeout_ms 被忽略 + 上游超时假 worked（🔴 功能性说谎，已修）

- **现象**（probe2 W1/W2 真机）：文本在场 44ms worked ✓；**文本永不在场 → 30009ms 后仍 `worked` + `waited for "…"`**；显式 `expect.timeout_ms:3000` 完全被忽略（恒烧上游默认 30s）。
- **机理**：BrowseChannel.ts doWait `await c.callTool("wait_for", {text:[text]})` ① 不透传 timeout（上游 snapshot.js timeoutSchema 支持 ms timeout）；② 上游超时以 **isError 响应**返回（McpClient.callTool 对 is_error 不 throw——与 doPdf 已检 isError 的范式相同），doWait 不检 → 落到 `return {preview: waited for}`。与 W1-DEF-1（StealthEngine 不检 isError）同类，当年只修了 stealth 消费点。
- **判定**：用例对（wait 应诚实）→ 产品缺陷。
- **修复**（BrowseChannel.ts:1030-1056）：透传 `timeout: opts.expect?.timeout_ms`；`r.isError → throw wait_timeout:<text>` → classifyBrowseError 落 **unknown**（可 fallback——页面慢可重试语义）。
- **单测**：browse-upstream-contract.spec.ts +2（timeout 透传契约 / isError→unknown+wait_timeout）。
- **真机复测**（ft-r11-verify VA）：在场 44ms worked（无回归）；**缺席 3s → 7846ms `didnt` + fallback 链 `all_channels_failed_or_skipped`（不再假成功，timeout honored）**；相邻 snapshot 无回归。

### W-DEF-R11-2 — TabSession 重启守卫纯 url 判定，canonical 流程 tab_restore 恒 no-op（🟡 已修）

- **现象**（E3 真机）：connect（快照=[预建 bg tab about:blank]）→ navigate 既有 tab → window.open 新 tab → `tab_restore` 返 `browser_restarted, closed:[]`——**lasso 自己开的 tab 永不回收**。
- **机理**：TabSession.ts 守卫 2 用 url 零交集判「Chrome 重启」；同一 tab 被 navigate 后 url 变而 **targetId 稳定**，url 通道必零交集 → 误判。头注「诚实声明」只豁免了"没开新 tab"形态，主流形态（导航+开新 tab）恰是 restore 的存在意义。
- **判定**：用例对 → 产品缺陷（diff 本就用 targetId，守卫却不用）。
- **修复**（TabSession.ts 守卫 2）：overlap 判定加 targetId 通道（`snapshotUrls.has(t.url) || snapshotIds.has(t.targetId)`）；浏览器重启后 targetId 必然全新，守卫语义不放松；diff 步复用同一 Set。
- **单测**：tab-session.spec.ts +2（navigate+新增→关新增；url 全变但 targetId 存续→不误判）。
- **真机复测**（ft-r11-verify VB）：`closed:[4A8EC20B…]`，restore 后 pages 只剩原 tab（**正路径首次真机打通**）；相邻 nav 无回归。

### 观察项（不修，记录在档）

| # | 观察 | 证据/锚点 |
|---|---|---|
| OBS-R11-1 | wait 缺 expect.text 的最终错误码是通道层汇总 `all_channels_failed_or_skipped`，内层 `wait: opts.expect.text required` 只在 stderr——CC 侧归因弱 | A06b；wave2 已记，维持 |
| OBS-R11-2 | fill 到非输入 ref（`<a>`）→ `ref_fill_failed:r1:TypeError: Illegal invocation` → unknown → **fallback 到 logged_in 白跑一趟**且最终错误归因 logged_in（困惑性）——建议 locate 预检加可填性（tag 白名单）→ 直接 didnt | 批1 H02 stderr 两行对照；extract-refs.ts buildRefFillExpr native setter |
| OBS-R11-3 | **共享台账多 server 并发互杀**：任一 server 停机 `stopLaunchedChromes({all:true})` / 兄弟面板 `chrome-stop --all` 会击杀台账内**所有人**的 Chrome（本轮被杀 2 次：E2 9232、E3 首跑 9233；9234 也在 +38s 被外部击杀）。单用户 CC 场景是设计行为（index.ts:1300-1307），多实例/并行测试场景是互扰面——测试出口 `LASSO_LAUNCHED_CHROMES_PATH` 已在（chrome-ledger.ts:53-58），本轮后续全部启用 | E2/E3/9234 时间线；ledger 争用实证 |
| OBS-R11-4 | **steps 的 Step schema 无 per-step `options`**（browse.ts steps zod 形状对照 steps-types.ts）——链内 `extract` 恒 raw 档、`include_refs` 不可达；F01 实证 step2 extract 返回 a11y 快照 | F01 payload `"step":{"action":"extract","expect":…}`（options 未入账）；browse.ts:66-88 |
| OBS-R11-5 | refs 附录 href 是 `getAttribute('href')` 原样——相对链接（如 `index.html`）不绝对化，与正文 markdown 的 URL 透传绝对化不一致（click 路径不受影响，CC 判断去向略受损） | B01 附录 `- [r1] a "Books to Scrape" → index.html` vs 正文 `[Home](https://books.toscrape.com/index.html)` |

### 清单勘误（doc/17 需回改，本轮以真机为准执行）

| # | 勘误 | 真机证据 |
|---|---|---|
| F-R11-1 | 漂移声明第 6 条③「1.7.0 确认暴露原生 pdf 工具（doPdf 契约注释）」**与真机相反**——上游返回 `-32602: Tool pdf not found`；pdf.ts:11-13/:77-96 与 SubprocessManager.ts「pdf 工具仍不存在」注释才是对的。T-BROWSE-10/U-02-6/T-TOOLS-10 预期应回到「didnt+upstream_unsupported:pdf+next_step」主路径 | A13：`rm:"upstream_unsupported:pdf"` + next_step 在 dataKeys |
| F-R11-2 | T-BROWSE-11 预期「entries 含 name/type/duration」——上游 1.7.0 实际字段 `name/type(常空串)/reqid/method/status/third_party`，**无 duration** | A14/A15b envelope 实抓 |
| F-R11-3 | §0.3 D2 行「browse schema 不含 options.steps【静态已确认】」已过时——v1.8 已修（browse.ts:66-88 steps 数组在 schema），本轮 S1/F01 真机证 steps 经 MCP 可达；该行应加「已修（v1.8）」防误导 | S1 worked + F01 actions_and_results |

---

## 4. L-COST 回填（§5 表口径）

| ID | 场景 | 本轮回填 | 起步值对照 |
|---|---|---|---|
| L-COST-04 | 第一跳 browse_headless 兜底 | baidu SERP：**nav 9341ms + extract 904ms / 0 条**（降级壳页形态，本轮非验证码但同 0 结果） | 5304-5856ms/0 条（验证码页）——本轮偏慢：TUN + npx 冷启；量级一致 |
| L-COST-12 | launch-chrome hidden 冷启动（到探活 200） | **2592ms / 3181ms**（两次独立） | 基线建立 ✓ |
| L-COST-14 | include_refs 增量（同页 A/B×3，github） | **[+8, −18, +191]ms，中位 ≈0** | 预期「仅 evaluate 表达式顺带，无第二跳」**证实** |

判读：①browse 各 action 热会话延迟（snapshot 12ms / extract-raw 8ms / markdown 600-1600ms / network 850-1200ms / screenshot 850-950ms）远低于冷启首跳（6-9s，npx+TUN 主导）；②refs 开销可忽略；③失败路径快速失败（ssrf 3-27ms、unknown_action 5ms、ref_stale 215ms）✓。

---

## 5. 02 简单架构对齐判定（R11 域内证据行；全表由 §6 专官汇总）

| 规则 | 判定 | 域内证据（L1+） |
|---|---|---|
| R-INT-07 运行时同源耦合 | ⚠️ | chrome 台账（chrome-ledger.ts:53-58）消费面 ≥4 类（launch-chrome CLI / chrome-stop CLI / 每 server 的 idle reaper / 每 server 停机钩子），**每类均持 kill 权**——单用户设计成立（kill 前 cmdline 归属验证红线在），多 server 并发互杀实证 2 次（OBS-R11-3）。SubprocessManager 单例本身各 channel 独立 spec/独立降级，链语义 ✅ |
| R-DEP-03/R-FF-04 穿堂式=0 | ✅（域内抽样） | doWait（array 适配+timeout+isError 语义）/ doClick（ref 分流）/ admin tab_restore（audit+reason 包装）均加语义非原样转发；未发现纯穿堂 |
| R-CI-08 知识重复 | ⚠️ | **两套 tmp 根真机同框**：screenshot `/tmp/lasso-screenshot-*.png`（A16）vs envelope spill `os.tmpdir()/lasso-output`（G2 注）——U-02 观察注在档，本轮提供 L1 实据 |
| R-DEP-05 信息泄漏 | ✅ | 上游响应形状收敛 upstream-response.ts（parseEvalResult/imageBlock 单点）；evaluate 空值时 preview 回退原文展示 fence（cosmetic，非契约泄漏） |
| review-Q1 第二套做法 | ✅（有意并存已文档化） | click/fill 双路径（ref JS click vs 上游 uid CDP click）注释自证「两路径并存」（BrowseChannel.ts:943-951）；chrome-stop vs SubprocessManager 共享 kill-tree 单一真源（INV-77a） |
| review-Q2 what vs how | ✅ | include_refs 附录=把「uid 体系 how」升维成「可点击句柄 what」（本轮 50 ref cap + 钉尾 + 往返全链真机证）；steps 无 per-step options（OBS-R11-4）是反向小缺口 |

---

## 6. 修复后门禁（只增不减 ✓）

```
npm run build ✓
npm test          → Test Files 134 passed；Tests 2238 passed | 1 skipped (2239)   [基线 2227 → +12，含本轮 +4：tab-session ×2 / browse-upstream-contract ×2；余为并行面板同期新增]
npm run check-invariants → All 81 invariants passed.
npm run inv-selftest      → All 20 sampled pins flipped red under violation. 工作树零污染.
```

修复面：`src/channels/BrowseChannel.ts`（doWait）、`src/logged-in/TabSession.ts`（守卫 2 targetId 通道 + 头注）、`test/unit/browse-upstream-contract.spec.ts`（+2）、`test/unit/tab-session.spec.ts`（+2）。

---

## 7. 资源三采样 + 残留清理

| 面板 | before | peak | after | released |
|---|---|---|---|---|
| browse 全程（批1） | 0 进程 / 0KB | 18 进程 / 1.82GB | +2.5s=3 进程 → **+90s=0** | ✅（SIGTERM 轮询窗内 3 个为瞬态，90s 后归零） |
| T-LIFE2 | 2 进程（兄弟面板 server）/ 193MB | —（CLI 型） | 兄弟面板进程不计入 | ✅（我方 launch 的 9229/9230/9231 全收：chrome-stop 定向/all + server 停机钩子） |
| 终态盘点 | `ps` 特征三签名：我方 `--disable-blink-features` 0 个、`user-data-dir=…ft-p92x` 0 个、9229-9235 端口探活全空；兄弟面板进程（9222 launch-chrome / chrome-stop --port 9223）**未触碰** | | | ✅ |

清理动作：`chrome-stop --all`（隔离台账）/ server 停机自收 / `rm -rf ~/.cache/lasso/ft-p92{9,30,31,33,34,5}` / `rm /tmp/ft-r11-*-ledger.json`。产物文件：`ft-r11-*.mjs/.sh/-out.json/-stderr.log/-run.log`（本目录，供复审复跑）。

---

## 8. 遗留（移交）

1. F-R11-1/2/3 清单勘误待清单官回写 doc/17。
2. OBS-R11-2（fill 可填性预检）/ OBS-R11-4（steps per-step options）/ OBS-R11-5（附录 href 绝对化）——P3 候选，建议下轮裁决。
3. T-LIFE-02（visible 档）本轮未跑（避免打断用户桌面焦点），留待专门窗口。
4. W-DEF-R11-1/2 修复未经独立交叉审（本轮自修自测 + 门禁全绿）——按 03 清单「新鲜复审者」红线，建议 round2 由非 R11 执行员复核两处修复。
