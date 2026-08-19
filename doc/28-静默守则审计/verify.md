# 28 · 静默守则审计 —— 真机验证报告（verify.md）

- **日期**：2026-08-19
- **输入**：`audit.md`（矩阵+D 清单+分级）/ `fix.md`（G1/G2 实施记录）
- **验证员宪法**：「能够后台静默执行就尽量后台静默执行；不能完全静默则用户介入后**及时恢复**静默执行」
- **方法**：自有端口 9231/9232/9239 + 自有 profile（`/tmp/lasso-verify28/profile{,2}`），全程零触碰 9226 / dedao-profile / 该 Chrome 进程（验证前 pid 85359 监听 9226；验证结束复测仍存活监听，工作流零干扰）。六维快照脚本 `/tmp/lasso-verify28/sixdim.sh`（焦点/窗口+可见性/实例/Dock 口/音频/资源），MCP 客户端 `/tmp/lasso-verify28/mcp-phased.mjs`（SDK stdio 直连 `dist/index.js`，环境透传 `LASSO_CDP_PORT`）。
- **总体结论**：audit 矩阵 **14/17 A 类、C 类边界、D-1/D-2/D-3/D-4 定性全部真机复现实锤**；G1/G2 修复真机生效。**但发现一个 audit 未覆盖的新违例 D-5：MCP server 退出钩子无条件 SIGKILL 台账在案 Chrome——P1 v1.17.3 的 visible 豁免只修了优雅停机路径，exit 钩子路径把用户 visible 登录窗口照杀**（§6，三次独立复现 + 服务端日志归属实锤）。

---

## 1. 验证环境与隔离纪律

| 项 | 值 |
|---|---|
| 被测 | lasso-mcp v1.17.3 本地 build（`node dist/index.js`，72712df） |
| 端口 | Chrome 实例 9231（visible）/9232（hidden 对照）/ 无 Chrome 失败路径 9239；均验证前空闲 |
| profile | `/tmp/lasso-verify28/profile`（visible）/ `profile2`（hidden）——不在 `~/.cache/lasso` 内，与 dedao-profile 零交集 |
| 隔离证据 | 验证前基线：9226=pid 85359（dedao）监听、9231/9239 无监听、台账 `[]`；验证结束：85359 仍存活监听 9226、非 dedao debug Chrome = 0、台账 `[]` |
| TCC | 本 shell 持 Accessibility（System Events 读写 visible 均成功），chrome-hide/show 原语全程真实生效 |

六维快照存档：`/tmp/lasso-verify28/sixdim-*.txt`（baseline / after-launch-visible / v1-pre-hide / v1-post-hide / v1-during-hidden / v1-post-show / d2-visible-start / d2b-hidden-start / v3-before-stop / v3-after-stop）。

---

## 2. V1 · 登录流转完整往返（launch visible → 登录 → chrome-hide → 后台 browse → chrome-show）

**流转**（时延为真机实测，含 node CLI 启动）：

```
lasso launch-chrome --port 9231 --profile … --mode visible   5402ms → {ok:true, pid, 台账 launchMode:"visible", idleMs:60000}
  [模拟登录] raw CDP: Page.navigate example.com + Network.setCookie verify28_login   → cookie 落 profile
lasso chrome-hide --port 9231                                 2769ms → {ok:true}
  [验证] visible:false / CDP /json/version 200 (1.8ms) / cookie 在 / browse 后台继续 navigate → outcome=worked (1341ms)
lasso chrome-show --port 9231                                 2415ms → {ok:true, visible:true, cookie 在}
```

### 六维前后对照（pid 级实测）

| 维度 | 基线 | visible 起后 | chrome-hide 后 | chrome-show 后 | 备注 |
|---|---|---|---|---|---|
| **焦点** | Chrome 85359（dedao） | **被 2072 抢**（spawn 激活 app） | **归还 85359** | 保持 85359 | launch visible 抢焦点=S2 合法介入面；**show 恢复不抢焦点**（只 set visible，不 activate）——S1 加分项 |
| **窗口** | — | visible=true，2 窗 | **visible=false**（app 级隐藏，进程/窗口/登录态全保留） | visible=true，2 窗 | hide 无损可逆实锤 |
| **Dock** | 1 枚 Chrome 图标（bundle 合并） | 同（多实例去重为 1 枚） | 同 | 同 | 多 Chrome 实例 Dock 无法区分（bundle 去重）；hide 不增不减图标 |
| **音频** | — | `--mute-audio` PRESENT | PRESENT | PRESENT | launch-chrome.ts:338 恒静音真机生效 |
| **通知** | 无 | 无 | 无 | 无 | 全程零通知/零弹窗（除 visible 窗口本体） |
| **资源** | — | 151→162MB RSS，启动峰 49%CPU | 161MB，空闲 0.2-0.3%CPU | 162MB | 单实例常驻量级，可接受 |

### 判定

- **V1 完整往返 ✅**：hide 后 visible=false + CDP 活（HTTP 200 / 1.8ms）+ cookie/登录态无损 + **browse 后台静默继续（outcome=worked）** + show 可逆恢复且不抢焦点。P4 的「登录弹窗→登录后转后台静默」机制本体真机成立。
- **hide/show 出口本身是 L0**（必须用户记得跑命令），此定性见 audit D-2，真机量化见 §3。

---

## 3. V2 · 介入后恢复时机量化（从「用户完成动作」到「恢复静默」）

| 流转 | 恢复触发 | 人工步骤 | 真机实测成本 | 恢复档位 |
|---|---|---|---|---|
| **C1 elicitation accept** | 用户在**同一轮**表单点 accept | 1 次表单点击 | **0ms**——同 chain 同轮继续（audit §2.3 白盒；本轮未重触高风险动作，沿白盒结论） | **L2** |
| **2FA/登录墙解除检测** | 用户在 Chrome 完成登录 | 0 | 下一次 browse 调用自动重探清除（LoggedInChannel.ts:198 无条件重探；白盒+audit 确认） | **L2** |
| **tab_restore 会话收尾** | server 停机 / idle hook / admin | 0 | 自动（index.ts:1319 区段；whitebox） | **L2** |
| **chrome-hide（登录完成）** | **用户记得**该命令存在 | ≥1：离开 CC→终端→跑命令→回来 | CLI 墙钟 **2769ms**；裸 AppleScript 原语 1861-2480ms（osascript 启动为主） | **L0** |
| **D-1 无 Chrome 恢复** | 用户读懂 unknown 裸错误→查描述 runbook | ≥2：切终端→launch-chrome（首登再加 visible→登录→hide 三步） | hidden 档 **4365ms** / visible 档 5402ms（含 CDP 探活） | **L0**（C1 落地后可升 L1） |
| **D-2 登录后自动恢复** | **不存在** | — | **∞**（见 §5-D2：8s idle 阈值 + 40s 观察窗后仍 visible=true） | 无档位 |
| **D-5（新，§6）server 退出** | 任何 server 会话结束 | —（用户毫无动作也发生） | 停机信号→SIGKILL 树杀间隔 **724ms** | ——（违例） |

**结论**：恢复档位与 audit 分级完全一致——elicitation/2FA/tab_restore 是 L2 标杆；chrome-hide/D-1 是 L0 人工；D-2 无恢复路径。量化补充：**L0 出口的墙钟成本本身不高（2-5s），成本大头是「用户必须记得并离开对话」这一步**——这印证 D-1b（admin chrome_launch，升 L1）与 C2（登录后自动 hide，升 L2）的价值排序。

---

## 4. V3 · 残留清零（chrome-stop 后 Dock/窗口/端口/台账）

```
launch visible 9231 (pid 8996) → lasso chrome-stop --port 9231   2605ms → {action:"killed"}
复测（停止后 2s）：
  进程    pid 8996 消失（System Events「无效的索引」）
  端口    9231 无监听
  台账    []（条目删除）
  窗口/Dock 回基线（仅剩 dedao 85359 的 9226）
  焦点    85359（与基线一致，未被扰动）
  残余    verify28 相关进程 0；Chrome helper 树全清
  隔离    dedao 9226 全程存活（验证前/后各复测一次）
```

**判定 ✅**：chrome-stop 收尾出口真机零残留、零误伤（--port 定向 + 归属验证红线生效）。

---

## 5. D 类违例真机取证

### D-1 无 Chrome 失败路径（S1+S3）——复现 ✅

真机（9239 无监听，MCP 直调 browse_logged_in）：

```
冷调用 6465ms / 热调用 38ms → 一致返回：
  { "outcome": "unknown", "served_by": "browse_logged_in",
    "error": "Error: nav_error:Could not connect to Chrome. Check if Chrome is running.
              Cause: Failed to fetch browser webSocket URL from http://localhost:9239/json/version: fetch failed" }
```

- 与 audit §2.2 锤点**逐字段一致**（unknown + 裸错误 + 无 next_step + isError=false）。失败快（38ms 热路径）、无重试风暴——这半边合格；恢复链 L0 断在对话外——违例成立。
- **G2 修复真机生效 ✅**：tools/list 运行时描述实测含 `"IF CHROME IS NOT RUNNING you get outcome=unknown …"` + `lasso launch-chrome`（hidden）/`--mode visible` 首登三步 + `chrome-hide`/`chrome-show` runbook（descriptions.ts:209-220）。CC 在 tool-selection 面即可自愈或准确转告。

### D-2 登录完成后无限期非静默驻留（S3）——复现 ✅（含对照实验）

对照实验（同 reaper 配置 `LASSO_LAUNCH_IDLE_MS=8000`、观察窗 40s、reaper 周期 15s、browse 触摸一次）：

| 档 | 结果（40s 后，server 存活期间） |
|---|---|
| **visible**（9231，idle-ms 8000） | **仍存活 + visible=true + 台账在案 + 端口监听** —— reaper `launchMode === "visible") continue` 跳过（chrome-idle-reaper.ts:118-120），无任何 hide 类出口 |
| **hidden**（9232，idle-ms 8000，对照） | **被收割**：进程亡 + 台账清 + 端口关（server 存活期内发生，非 exit 钩子所为）——「用完即关」对 hidden 正常工作 |

- **D-2 定性实锤**：visible 档登录完成后系统**没有任何自动转静默路径**——8s idle 阈值早已过期、多个 reaper tick 经过，窗口依然可见。恢复唯一出口 = 用户手动 `chrome-hide`（L0）。且该窗口此刻还会被 §6 的 D-5 在会话结束时直接杀死。
- 附带验证：hidden 档 Chrome 上 browse 正常（outcome=worked，冷 11.0s）——「hide 转后台后 browse 照常」与 V1 结论互证。

### D-3 NEEDS_MANUAL_2FA 承诺未实装（S2）——真机 + 白盒双重确认 ✅

- **真机**：browse_logged_in navigate `https://github.com/login`（真实登录墙页）→ **`outcome: "worked"`**（非描述承诺的 `didnt + NEEDS_MANUAL_2FA`）。CC 收到的是「成功 + 登录页内容」，需自行从内容推断身处登录墙——介入信号缺失，介入面放大风险成立。
- **白盒**：`grep -rn NEEDS_MANUAL_2FA src/` 8 处命中全为注释/类型说明/消费端匹配（types.ts:19、descriptions.ts:226、browse.ts:12/250、FallbackDecider.ts:12/260、outcome.ts:6/90），**零生产者**（无任何 throw/return 该错误串的路径）。

### D-4 恢复出口零防护+零文档——G1 修复抽检 ✅

- `test/unit/chrome-hideshow.spec.ts` 在位（8 用例，门禁 2267 passed 含之）。
- README.md:294/303/320 与 doc/KEY-GUIDE.md:128 实测记载 P4 三步（`--mode visible` 首登→登录→`chrome-hide`）+ `chrome-show` 可逆 + 「只动台账在案 Chrome」红线说明。文档面补齐。

---

## 6. 🔴 新发现 D-5 · server 退出钩子无条件杀 visible Chrome（S3/N4 级违例，audit 未覆盖）

### 现象（三次独立复现）

任意 MCP server 会话结束（stdin EOF / client close → shutdown → process.exit），**台账在案的 visible Chrome 被整树 SIGKILL**：

1. V1 首轮：browse 后 client.close() → pid 95035 亡、台账清空（当时归因未明）；
2. **零调用隔离复现**：起 server（**零工具调用**，排除 chrome-devtools-mcp 干扰）3s 后 stdin EOF → pid 99413 亡、端口关、台账清；
3. V1 完整往返尾：client.close() → pid 2072 亡。

### 归属实锤（服务端日志）

`/tmp/lasso-verify28/exit-hook-server.log`：

```
05:35:17.921  evt:lasso_shutdown  sig:stdin_eof            ← 优雅停机入口
（优雅路径 stopLaunchedChromes({all:true, modes:["hidden"]}) 对 visible 正确豁免——全日志零 chrome_stop_result 事件）
05:35:18.645+ evt:subproc_exit_kill name:"chrome-stop-exit" pid:99413 SIGKILL   ← 724ms 后，exit 钩子补刀
              （连杀 7 个 helper：99413/99500/99502/99504/99510/99511/99512/99536）
```

`name:"chrome-stop-exit"` 是**同步版独有 reason 标签**（chrome-stop.ts:215）——杀死 visible Chrome 的路径**只有** exit 钩子，与优雅路径无关。

### 代码锚点

- `src/index.ts:1348-1356`：`process.on("exit", () => { stopLaunchedChromesSync(...) })` —— **无 modes 过滤**；
- `src/launcher/chrome-stop.ts:202`：`stopLaunchedChromesSync(logFn?)` —— **签名根本不收 modes 参数**，无差别杀全台账；
- 对照：优雅路径 `src/index.ts:1306` `stopLaunchedChromes({ all: true, modes: ["hidden"] })`（P1 v1.17.3 修复所在）；
- 测试缺口：`test/unit/p1-visible-chrome-lifecycle.spec.ts` 仅断言 ①chrome-stop.ts 存在 modes 过滤语法 ②reaper visible continue——**未覆盖 exit 钩子路径**，故 2267 测全绿仍漏。

### 判定（对照守则与既有裁决）

- 违反 **S3**：介入（登录）完成后非但没有「及时恢复静默」，反而在会话收尾时把用户正在用的窗口**销毁**（比 D-2 的「驻留」更糟——不可逆，cookie 虽留 profile 但用户视角窗口/打开页全失）。
- 直接顶撞 **NO-GO N4**（audit §4：「visible Chrome 的自动 kill 出口……永远不能用 kill」）与 **P1 v1.17.3 根因裁决**（短命 server 退出砸用户登录窗口）。P1 修复只覆盖了 `shutdown()` 优雅路径，exit 钩子（v1.9 parse17 引入，早于 visible/hidden 分档）从未同步。
- **触发面**：CC 每次重启 lasso server / 会话结束 / CC 退出——即**生产环境里用户 visible 登录窗口的存活期 = 当前 server 会话存活期**。与 P1 当初的实战事故同构。
- 修复方向（建议，未实施——本轮验证员角色零代码改动）：exit 钩子收尾同样按 `launchMode` 过滤（`stopLaunchedChromesSync` 增加 modes 参数，或钩子内改为只收 hidden），补 exit-hook 路径白盒测试；门禁按惯例 build+test+INV 基线不减。

---

## 7. 验证矩阵总表

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | 登录流转完整往返（V1） | 真机 9231：launch visible→登录模拟→hide→后台 browse→show | ✅ 成立（hide 后 visible:false+CDP 200+cookie 无损+browse worked；show 不抢焦点） |
| 2 | 六维前后对照 | pid 级 System Events/ps/lsoof 快照 ×10 | ✅ 唯一焦点抢占点=visible spawn（S2 合法）；hide 后六维全静默 |
| 3 | 恢复时机量化（V2） | 墙钟计时+白盒 | ✅ L2（elicitation/2FA/tab_restore）vs L0（chrome-hide 2769ms / launch 4365-5402ms）vs ∞（D-2 无路径） |
| 4 | 残留清零（V3） | chrome-stop→进程/端口/台账/焦点/隔离复测 | ✅ 零残留、dedao 零误伤 |
| 5 | D-1 复现 | 9239 死端口 MCP 直调 | ✅ unknown+裸错误+无 next_step（冷 6465ms/热 38ms）；G2 runbook 运行时可见 ✅ |
| 6 | D-2 复现 | 8s idle+40s 窗对照实验 | ✅ visible 存活且可见（无恢复出口）；hidden 对照被收割 |
| 7 | D-3 复现 | github.com/login 真机 + grep | ✅ outcome=worked 非 didnt；生产者零 |
| 8 | D-4/G1+G2 抽检 | spec/README/运行时描述 | ✅ 8 测在位、文档三步在位、runbook 在位 |
| 9 | **D-5（新）** | 零调用隔离复现×3 + 服务端日志 | 🔴 **exit 钩子杀 visible Chrome**（index.ts:1352 无 modes；chrome-stop.ts:202 无此参数；P1 测试缺口）——建议升级为独立修复轮 |

## 8. 隔离与清理声明

- 全程自有端口 9231/9232/9239 与 `/tmp/lasso-verify28/*` profile；**9226 / dedao-profile / pid 85359 零触碰**（前后存活复测一致）。
- 验证结束态：台账 `[]`、无 verify28 相关进程、9231/9232/9239 无监听、自有 Chrome 实例全清。
- 产物：本文件 + `/tmp/lasso-verify28/`（sixdim ×10、mcp-phased.mjs、各 run JSON、exit-hook-server.log）。
