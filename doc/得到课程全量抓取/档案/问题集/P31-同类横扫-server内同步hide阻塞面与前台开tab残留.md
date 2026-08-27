# P31：同类问题横扫——server 进程内同步 hide 阻塞面（S3/S4）修复 + 同族项裁决

> 来源：2026-08-20 横扫（同类问题）4 项 S1-S4。实施规则：只修 P0/P1 且属 lasso src 的项；
> .engine / .dedao-extract / skill 域**列出不动**（引擎管线域，主循环统一裁决）；skill 域不动。
> 本档案 = lasso src 两修（S3/S4，一个主题）+ 两项列档不修的白盒论据（S1/S2）。

## 现象（横扫输入）

P27 复盘定案了两个机制级教训，但 v1.18.3 只根治了各自的第一现场，同族调用点残留：

1. **同步 spawnSync 阻塞面**（P27 教训②：server 进程内禁 spawnSync 长阻塞——watchdog 曾
   阻塞事件循环致 5.7× 降速）：v1.18.3 给 watchdog 造了 `reassertChromeHiddenByPidAsync`
   （execFile 异步），但 **reaper autoHide** 与 **launch 隐藏保险丝** 两处仍默认同步
   `hideChromeByPid`（spawnSync osascript，timeout 2s）。
2. **/json/new 前台开 tab**（P27 定案①：前台语义端点抢用户焦点，事后 guard 救不回焦点）：
   merge.mjs/engine.mjs 已根治，但 `合并演示/render-merge-b.mjs` 仍是活的 `/json/new`。

## 白盒证据（横扫四项核真）

| 项 | 证据 | 属地 | 裁决 |
|---|---|---|---|
| S1 (P0) | `合并演示/render-merge-b.mjs:201` `fetch(`${CDP}/json/new`, {method:"PUT"})` + `:204` `chromeGuard()` 事后补救；`SKILL.md:44` 把未来运行指向它 | 得到课程侧管线域（非 lasso src） | **列出不修**（论据见下） |
| S2 (P1) | `skill/dedao-course-extract/SKILL.md:50` 仍教授 P21 世代纪律「/json/new + Page.navigate + 事后 chromeGuard 复隐」；`:69` 未沉淀 25min 校准/degraded 纪律 | skill 域 | **列出不修**（skill 域不动，主循环裁决） |
| S3 (P1) | `src/launcher/chrome-idle-reaper.ts:150` 默认 `hideChromeByPid`（spawnSync 2s）→ `:257` 在 server 常驻 15s timer 的 async tick 内执行；autoHide 触发窗（登录完成+10s）恰是 agent 最可能并发 MCP 请求的时刻 | lasso src | **修复** |
| S4 (P1) | `src/launcher/launch-chrome.ts:352` 默认 `hideChromeByPid` → `:423-431` scheduleHideFuse 在 MCP chrome-launch 请求路径同步执行（注释自认「spawnSync 同步调用」） | lasso src | **修复** |

## 修复（S3+S4 同一主题：server 进程内 hide 原语异步化；v1.18.3 working tree 增量）

### 1. 新原语：`chrome-hide.ts` 增 `setChromeVisibleByPidAsync` + `hideChromeByPidAsync` / `showChromeByPidAsync`

- 形态照抄 `reassertChromeHiddenByPidAsync:142-153`（P27 已验证款）：`execFile` 回调 +
  `timeout: 4_000` + `killSignal: "SIGKILL"`——慢则慢完成，**零事件循环阻塞**。
- 脚本体抽出 `setVisibleScript(pid, visible)`，sync/async 两变体共用单一真源（极性单点
  三元插值不漂移；G1-5 白盒断言 `${visible ? "true" : "false"}` 继续成立）。
- 退出态解析抽 `parseHideSignal`（非零退含 TCC -1743 一切失败 → `{ok:false}` 降级不抛）。
- PID 定向红线（unix id，永不按进程名——E8）与 非 mac/no-op 语义 byte 对称继承。
- **分工边界**：异步版只服务 server 进程内路径（reaper/launch fuse）；CLI 短命路径
  （chrome-hideshow / launch-chrome 直跑）维持同步版——自身即唯一进程，阻塞无受害者。

### 2. S3：`chrome-idle-reaper.ts`

- 默认 hideFn：`hideChromeByPid(pid)` → `hideChromeByPidAsync(pid)`。
- `hideFn` 注入签名宽化为 `ChromeHideResult | Promise<ChromeHideResult>`（既有同步注入的
  测试形态零破坏）；调用点 `considerAutoHide` 内 `const r = await hideFn(rec.pid)`。
- INV-82(e) 锚（reaperCode 含 `hideChromeByPid`）不受影响（Async 名含该子串）。

### 3. S4：`launch-chrome.ts`

- 默认 hideFn 同步→异步；`scheduleHideFuse` 改 async，两条成功路径（primary + 离屏
  fallback）`await scheduleHideFuse(pid)` **在 launchChrome 返回前完成**。
- 关键取舍（横扫建议给了二选一）：不用 fire-and-forget——CLI 路径 `runLaunchChromeCli`
  返回后随即 `process.exit`，未决 Promise 会重演 **F1**（v1.10 保险丝被 exit 击败）事故
  形态；await 形态保 F1 修复，且 4s kill 上限给最坏延迟封顶（典型 osascript 亚秒）。

### 4. index.ts 装配点（核验后零改动）

横扫建议提到「index.ts:479 装配点同步更新」——白盒核验：`startChromeIdleReaper` 装配
（index.ts:479-484）**不注入 hideFn**（只传 defaultIdleMs/touchPorts/autoHide 三键/logFn），
默认值在 reaper 模块内单点切换即生效，无需改装配。

### 5. 测试（DI 注入 + 源码断言，沿用 G1 范式；+9 测）

- `chrome-hide.spec.ts` P31 组 4 测：异步 hide 脚本 PID 定向红线 / show 极性 / 非零退
  降级 + no-op 零调用 / 白盒（execFile 4s+SIGKILL≥2 处、setVisibleScript 单源≥3 处、
  双极性经同一私有实现分发）。
- `chrome-autohide.spec.ts` P31 组 2 测：**门控差分**（hide Promise 未 resolve 前成功/失败
  日志均不落——若漏 await，`r.ok` 取自 Promise 对象会立即误判 `chrome_auto_hide_failed`；
  resolve + 微任务冲刷后才落成功日志，且不重复 hide）；白盒（默认 Async + `await hideFn`
  + 零 `spawnSync(` 调用回流）。
- `launch-chrome.spec.ts` P31 组 3 测：异步 hideFn 下 launchChrome 返回时 fuse 已完成
  （零额外等待）；门控差分（hide resolve 前 fuse 日志不落——真 await 非 fire-and-forget）；
  白盒（默认 Async + 两条 `await scheduleHideFuse` + 同步原语零回流 `hideChromeByPid\b(?!Async)`）。

### 门禁（lasso 根目录跑）

`npm run build` ✅ / `npm test` 2395 passed + 1 skipped（142 文件）✅ /
`npm run check-invariants` 82/82 ✅（基线 2386+1 → +9 全绿，82 INV 不破）。

## 列出不修项的白盒论据

### S1（render-merge-b.mjs 活的 /json/new）——非 lasso src，主循环裁决

1. 属地：`得到_薛兆丰的经济学/合并演示/render-merge-b.mjs`，课程侧管线演示脚本，横扫
   规则明示 .engine/.dedao-extract 侧「列出不动（引擎管线域，主循环统一裁决）」——本文件
   同域（合并终局工步的演示入口）。
2. 现实风险为零：用户明示**当前课程不重处理**（不重渲染全书），该脚本本轮不会再跑；
   全量线早已切 `.engine/merge.mjs`（P27 已根治的 openTabWs：浏览器级 WS
   `Target.createTarget {background:true}` + /json/list 轮询 + 8s 超时 + 4 次重试，
   merge.mjs:230-282 可整体搬运）。
3. 若主循环决定修：推荐方案=演示模式直接调 `.engine/merge.mjs`，本文件标 deprecated；
   次选=把 openTabWs 整体搬入替换 :201 块。**随修必须同步 S2**（否则 SKILL.md 又把人
   引回旧脚本），这也是两项应捆绑主循环统一裁决的原因。

### S2（SKILL.md 教授 P21 世代纪律）——skill 域不动

1. 属地：`skill/dedao-course-extract/SKILL.md`，横扫规则明示 skill 域不动。
2. 影响面=下一门课程（本课程已终局交付）。:50 应改写为「开 tab 一律 WS
   `Target.createTarget {background:true}`（P27：/json/new 与无 background 档都会
   activate 抢焦点，事后 guard 救不回焦点）」；:69 补「全本光栅/列表类超时按 1360 页
   25min 档校准（P25/P26 教训③），QC 扫描失败降级记 degraded 不丢报告（教训⑤）」。
3. 与 S1 捆绑：S1 改法决定 SKILL.md:44「node render-merge-b.mjs」工步指向是否仍成立。

## 判断（三分法）

- S3/S4 = **产品缺陷→已修复**（与 P27 watchdog 同机制同阻塞面的残留调用点；修法同源）。
- S1 = **产品缺陷（引擎管线域）→列档移交主循环**（当前课程零运行风险；修法与 S2 捆绑）。
- S2 = **skill 资产陈旧→列档移交主循环**（教训回流按 skill 惯例由 skill 域流程处理）。

## 状态

S3/S4 已落地（lasso working tree，与 v1.18.3 desired-hide 增量共存，未发版——随
v1.18.3 一并发布）；S1/S2 移交主循环统一裁决。
