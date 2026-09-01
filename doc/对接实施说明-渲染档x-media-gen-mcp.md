# lasso × media-gen-mcp 对接实施说明(配合改动清单)

> 日期:2026-09-01 · 配套:《需求-渲染档浏览器治理.md》(R1-R7,要什么)· 本文(怎么接:接口契约/时序/双方义务/边界)
> 前提背景:media-gen-mcp P0 Chrome 泄漏已自愈根治(browser-pool 单例+exit 钩子,HEAD=2311f33);本文所述为 **lasso 渲染档落地后,media-gen-mcp 切换 attach 的对接细节** —— lasso 侧实现时照此预留,可避免二次返工。
> 【2026-09-01 补充·裁决对齐】用户已裁决:**废弃 media-gen-mcp 侧 LaunchAgent 过渡方案**,自管看门狗体系(`scripts/render-watchdog.mjs --clean` 的 SIGKILL 外置兜底)整体废弃、不做"阶段移交"(时序改写见 §二阶段 3);browser-pool 自管池保留为运行现实(lasso 落地切换前)。上句"已自愈根治"中原本并列的"看门狗"部分随之退出维护口径。

## 一、接口契约(R3 的精确定义)

> 【2026-09-01 补充】命名说明:lasso 二进制名是 `lasso-mcp`(bin,现 CLI 子命令面见其 CLI_USAGE:doctor/config/launch-chrome/chrome-stop/hide-enforcer/replay-baseline);本文与需求文档中简写 `lasso render-chrome` 均指 **`lasso-mcp render-chrome`(待 lasso 落地的新子命令)**。

### 1. ensure 协议(消费方唯一入口)

```bash
$ lasso render-chrome --ensure            # 幂等;默认端口 9224(待 lasso 裁决,见需求 §四.3)
# 成功 → stdout 单行 JSON + exit 0(消费方 spawn 解析,零 TTY 依赖):
{"wsEndpoint":"ws://127.0.0.1:9224/devtools/browser/<uuid>","port":9224,"startedAt":1690000000000,"reused":true,"touchPath":"/Users/<u>/.cache/lasso/chrome-touch-9224"}
# 失败 → 非零退出码 + stderr 结构化一行(消费方据此降级):
#  exit 2 = Chrome 二进制不存在   exit 3 = 端口被非渲染档占用 / 既有渲染档不健康且重生失败
#  exit 4 = 拉起超时(>20s)      exit 5 = 内部错误
```

- **超时预算**:消费方(node spawn)给 25s;lasso 内部拉起超时 20s(当前自管池实测冷启 ~6.3s,余量充足)
- **幂等语义**:实例健康 → `reused:true` 直接回;进程在但 CDP 不健康 → lasso 先收尸再重拉(消费方无感)

【2026-09-01 补充】ensure 字段与行为细则(消费方按 `JSON.parse(stdout)` 强依赖):
- **逐字段语义**:`wsEndpoint` 取自 `http://127.0.0.1:<port>/json/version`;`startedAt` = epoch ms(与台账 `launchedAt` 同源);`reused` true=复用既有健康实例;**`touchPath` = heartbeat 目标文件绝对路径(由 ensure 下发,消费方不硬编码路径)**;消费方必须忽略未知字段(前向兼容)
- **stdout 纯净性(硬约束)**:stdout 只允许这一行 JSON——任何日志/进度/警告走 stderr,否则消费方解析直接炸
- **退出码语义补全**:`0` 成功;`2/3/4/5` 见上;**未列举非零 = 未知失败**,消费方按通用失败降级并原样透传 stderr;台账写失败不改变退出码(best-effort)。**消费方判定规则:仅 `exit===0 且 stdout 可 parse` 才 attach,其余一律走降级**
- **并发单飞**:两个消费方同时 `--ensure` 不得 double-launch(台账"一 port 至多一条"+ 拉起前探活;消费方现单飞锁同语义)
- **消费方解析 lasso 可执行文件顺序**:`MEDIA_GEN_LASSO_BIN`(显式路径,CI 用)→ PATH 直查 `lasso-mcp` → `npx -y lasso-mcp` 兜底(冷启可超 25s,该路径超时预算放宽到 90s)
- `--status` 恒 exit 0(`{"running","port","pid"?,"wsEndpoint"?,"startedAt"?,"idleMs","lastUseAt"?,"renderSessions","touchPath"}`);`--stop` 幂等(不在运行也 exit 0,`{"stopped":[{port,pid,action}]}`;`render-chrome install-agent`/`uninstall-agent` 仅在 lasso 选 launchd 直管形态下存在,消费方不依赖)

### 2. touch 契约(渲染档"在用"信号 —— 吸收 BUG-02 教训的强制设计)

🔴 lasso 的 idle reaper 曾树杀外部消费者(bug 02)。渲染档回收判定**不能只靠 lasso 自身活动信号**,双方约定:

- **touch 文件路径(2026-09-01 勘误定案)**:**复用 lasso 既有跨仓库约定 `~/.cache/lasso/chrome-touch-<port>`**(bug02 契约,`src/launcher/chrome-touch.ts`;idle reaper 每 tick 已 stat 该文件、活动判定三源取 max,渲染档零新管道)。渲染档 port=9224 → touch 文件即 `~/.cache/lasso/chrome-touch-9224`,并由 ensure 输出的 `touchPath` 字段下发。🔴 本节原示例 `~/.cache/lasso/render-chrome-9224.touch` **废弃**——新造命名既破坏既有外部消费者契约,又需要 lasso 侧新收割管道
- **消费方义务(2026-09-01 补充:心跳周期)**:仅"渲染前后各 touch 一次"**不足以覆盖长渲染**——render-video 单会话可超 10min(帧捕获上限 3600 帧),touch 过期即被 idle 误收。精确义务:① 每次 acquire 渲染前后各 touch 一次;② **渲染会话存续期间每 ≤60s heartbeat 一次**(消费方由 acquire/release 引用计数驱动 heartbeat 定时器的启停,unref 不 pin 事件循环)
- **lasso 义务**:渲染档 idle 判定 = `max(lasso 自身 touch, 消费方 touch 文件 mtime)`(现 reaper 三源取 max 结构原样适用);touch 文件 mtime **新于 idle 阈值** → 绝不回收
- wsEndpoint 断开(CDP 连接数归零)**只作参考不作依据**(短渲染间隙会断连,不能误判空闲)
- 触碰失败(文件被删等)→ 消费方 warning 上浮,**不阻断渲染**(降级为 lasso 自身信号)

### 3. 确定性验收(golden 双保险)

- lasso 侧:R6 自测(同一 SVG 经渲染档两次 byte-identical)
- media-gen-mcp 侧(迁移门槛):现有 `check-render-output strict` + `render-video-determinism`(真 Chrome byte-identical)在 attach 模式下必须全绿——**lasso 交付时请触发消费方跑这条**:`npm test` 中相关套件(我们不迁 fork,直接跑主仓)。【2026-09-01 补充】精确可复制命令(消费方仓内):
  ```bash
  MEDIA_GEN_RENDER_MODE=attach npm test          # 全量 622 测基线,attach 钉死
  # 单独钉死两条硬门槛(均加载 dist 产物,先 npm run build):
  npm run build && node --test test/render-video-determinism.test.mjs
  node scripts/check-render-output.mjs test/golden/expected/qr/url.png
  ```

### 4. 确定性旗标面导出(lasso 复刻对照用;2026-09-01 补充)

消费方真源 = `src/browser-pool.ts` `DETERMINISTIC_FLAGS`(8 条逐字清单见需求 §一勘误后版本)。消费方经 puppeteer-core(`^25.3.0`)launch,有效命令行**还含 puppeteer 注入的默认旗标**(如 `--mute-audio`/`--hide-scrollbars`/`--disable-dev-shm-usage`(Linux),随 puppeteer 版本变化)。**lasso 手拼 CLI 之前,先跑下面一击拿到当前精确全集**(在 media-gen-mcp 仓内以临时脚本执行,勿入库):

```js
// node dump-render-flags.mjs
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ channel: "chrome", headless: true,
  args: ["--no-sandbox","--disable-gpu","--font-render-hinting=full","--force-color-profile=srgb",
    "--run-all-compositor-stages-before-draw","--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"],
  userDataDir: "/tmp/dump-render-flags-profile" });
console.log(b.process().spawnargs.join("\n"));
await b.close();
```

两条实现路线(lasso 裁决):
- **a) render-chrome 直接依赖 `puppeteer-core`(与消费方同 major)以同款 options launch**——自动继承 puppeteer 默认旗标面,零漂移,推荐;注意 lasso 现有 INV-64 红线("launcher/*.ts 只 import node:* 内置 + 同目录模块"),render-chrome 应放独立模块目录并显式豁免/修订该不变量,勿塞进 launcher/
- b) 手拼 CLI = 导出全集减去 per-instance 项(`--remote-debugging-*`/`--user-data-dir`/起始 URL)——零新依赖,但 puppeteer 升级需重导出对照,以消费方 golden 为最终裁决

注:传输层差异(消费方自管走 puppeteer 管道,渲染档走 TCP 9224 供多消费方 attach)不影响渲染产物确定性——像素与页面时钟不经过传输层;`/json/version` 是 wsEndpoint 的权威来源。

### 5. attach 侧集成契约(2026-09-01 补充;含最易翻车的 close() 陷阱)

- 消费方 `puppeteer.connect({ webSocketDebuggerUrl: wsEndpoint, defaultViewport: null })`;页面级 `setViewport` 照旧由渲染方自管(多渲染会话互不污染)
- 🔴 **归还 = `browser.disconnect()`,严禁 `browser.close()`**:对 connect() 得到的实例调 `close()` 会向 Chrome 下发 `Browser.close` CDP 指令,**直接杀掉共享渲染档**(后续 ensure 被迫重拉冷启 ~6s + 渲染会话全断)。消费方 browser-pool 的 attach 适配层必须把池语义的 `close()` 映射为 `disconnect()`
- **attach 模式下 browser-pool 与 connect 的关系(明确"完全旁路什么、保留什么")**:
  - **完全旁路**:`launch`/exit 钩子杀/idle 定时器/SIGTERM 异步 close——全部不武装(SIGTERM 钩子仅断连后退出);`MEDIA_GEN_BROWSER_IDLE_MS` 在 attach 下不生效(idle 归 lasso)
  - **保留复用**:`acquire/release` 引用计数外壳——它同时驱动 §一.2 heartbeat 的启停与"渲染中不误判在用";`BrowserLike` 类型面(消费方三渲染文件零改动受益)
  - **生命周期归属**:池的 legacy 路径(launch+exit 钩子)仅 `MEDIA_GEN_RENDER_MODE=legacy` 下可达,随 90 天逃生门一并退役删除
- CDP 断连(connected 归零)不触发 lasso 回收(§一.2)——短渲染间隙频繁连断是常态,`disconnected` 事件只做消费方侧自清理

## 二、切换时序(谁先谁后)

```
阶段 0(现在):media-gen 自管池(单例+exit 钩子)= 基线运行中(看门狗体系已按 2026-09-01
  裁决废弃,不再是基线组成部分,见阶段 3)
阶段 1:lasso R1-R4 落地 + §三验收 → 发布
阶段 2:media-gen-mcp 侧切 attach:
  a. render 三处 acquire 改为「render-chrome --ensure → wsEndpoint 直连」(puppeteer.connect,
     不再 launch;DETERMINISTIC_FLAGS 责任移交 lasso 渲染档 profile)
  b. 失配降级:ensure 非零退出 → 返回结构化错误(【2026-09-01 勘误】统一模板见下 d 的
     RENDER_BROWSER_UNAVAILABLE——自愈命令是 `render-chrome --ensure`,不再是 install-agent)——
     🔴 绝不静默回落自管 launch(泄漏路径复活)
  c. MEDIA_GEN_RENDER_MODE=legacy 环境变量保留旧自管池 90 天(逃生门/回退基线),默认 auto:
     ensure 成功用 attach,失败报错(不静默)
  d.【2026-09-01 补充】MEDIA_GEN_RENDER_MODE 三态精确语义与切换:
     | 值 | 行为 | 用途 |
     |---|---|---|
     | auto(默认) | ensure 成功 → attach;失败 → 结构化错误(🔴 绝不静默回落自管 launch) | 常规 |
     | attach | 强制 attach;ensure 失败同上报错 | CI/验收钉死渲染档(§一.3 命令即用它) |
     | legacy | 现自管 browser-pool 全量语义(launch+exit 钩子+idle 5min) | 逃生门,自发布日起 90 天退役 |
     - 切换命令:`export MEDIA_GEN_RENDER_MODE=attach`(env 唯一入口,优先级 env > 默认;非法值启动 warn 后按 auto,与 MEDIA_GEN_BROWSER_IDLE_MS 容错风格一致)
     - 退役后:移除 legacy 与自管池代码,设 legacy → warn + 按 auto;`MEDIA_GEN_BROWSER_IDLE_MS` 随 legacy 一并移除
     - 失配降级的结构化错误模板(消费方返回,lasso 无需实现但验收时照此比对文案):
       code=`RENDER_BROWSER_UNAVAILABLE`,
       message="确定性渲染需 lasso 渲染档:先运行 `npx -y lasso-mcp render-chrome --ensure` 后重试(未装 lasso 见其 README);或临时设 MEDIA_GEN_RENDER_MODE=legacy 回退自管池(逃生门,<退役日> 移除)。ensure stderr: <原样透传>"
阶段 3(2026-09-01 裁决改写):media-gen 侧看门狗体系随 attach 落地**直接退役,无移交过渡**——
  - `scripts/render-watchdog.mjs`(--clean 的 SIGKILL 清理)与《渲染看门狗-LaunchAgent安装指引.md》:SIGKILL 外置兜底体系已按用户裁决整体废弃,不再安装/不再维护,随 attach 落地 PR 移除或归档
  - `src/render-selfcheck.ts`(渲染调用侧孤儿检测告警):attach 模式下**必须显式禁用**(默认关)而非"自然失活"——🔴 其孤儿判定是"指纹旗标对 + PPID=1/spawner 已死",而 lasso CLI spawn 渲染档后即退出(detached Chrome PPID=1),lasso 拥有的健康渲染档会被**误判为孤儿**(其告警线=孤儿主进程 ≥3,单实例未必触发,但判定逻辑对 lasso 档整体失真,留着必积误报)
  - 孤儿检测/清理的**唯一出口 = lasso R4 doctor**(台账在案判定,天然无 PPID 问题)——单一清理器,杜绝双清理器竞态
```

## 三、lasso 侧实现时的边界清单(易踩点,来自本次 P0 调查)

| # | 边界 | 说明 |
|---|---|---|
| 1 | **SIGKILL 免疫是硬验收** | R2 的核心:消费方宿主被 `kill -9` 后渲染档照常存活、照常被 idle 回收 —— 验收命令:`kill -9 <消费方> && sleep <idle+30s> && pgrep -f <渲染档指纹> = 0` |
| 2 | **chrome-stop mode 过滤需加 render** | 现有 `modes: hidden|visible` 扩为三值;`--modes hidden` 不得触碰渲染档,`--modes render` 可单独收 |
| 3 | **指纹与通用名隔离** | 渲染档命令行保留 `--run-all-compositor-stages-before-draw` 等旗标作可识别指纹;🔴 不要用 `puppeteer_dev_chrome_profile` 作判定依据(puppeteer 通用名,chrome-devtools-mcp 等他家用,会误伤)—— 台账/PPID 归属优先 |
| 4 | idle 默认 10min,env 可调 | `LASSO_RENDER_IDLE_MS`;与消费方 MEDIA_GEN_BROWSER_IDLE_MS 解耦(attach 后消费方不再自管,以 lasso 为准) |
| 5 | 正常退出≠能等回收 | 短命脚本事件循环即退,收尾必须由 lasso(常驻归属方)负责 —— 消费方侧不再有 idle 定时器假设 |
| 6 | headless 渲染档不进 lasso 日常档语义 | 不参与 chrome-show/hide、desired-hide 状态机(那是 headed 日常档的) |
| 7 | 【2026-09-01 补充】stop/reap 必须删 render profile 目录 | 现 chrome-stop 只"杀进程+删台账"**不删 profile**(日常档持久 profile 是设计);渲染档是每实例临时 profile——stop/idle 收割/doctor 三条路径都必须连带 `rmSync(profileDir)`,否则重演"陈年 profile 积垃圾"(P0 附带伤害:tmp 积 114 目录 7.2GB) |
| 8 | 【2026-09-01 补充】chrome-stop CLI 缺 `--modes` 旗标 | 现 CLI 仅 `--port N / --all`(modes 只是 API 选项,停机收尾路径用)——需求 R1 验收依赖 `chrome-stop --modes render`,**需补 CLI 旗标**;无 `--modes` 的 `--all` 语义 = 全停(含渲染档),属有意的"全停"出口,文档化即可 |
| 9 | 【2026-09-01 补充】三套 idle 默认值 owner 对照,勿互抄 | 日常档 CLI 默认 `--idle-ms 0`(不回收,CLI_USAGE 明示)/ 渲染档默认 10min(`LASSO_RENDER_IDLE_MS`,需求 R1)/ 消费方自管池 5min(`MEDIA_GEN_BROWSER_IDLE_MS`,attach 下不生效、legacy-only)——三者归属不同生命周期,抄默认值 = 抄 bug |

## 四、media-gen-mcp 侧承诺的配合改动(lasso 落地后一次性做)

1. render 三处 acquire 切 `puppeteer.connect(wsEndpoint)`——【2026-09-01 补充】精确落点:`src/render-svg.ts:161`(withBrowser)/ `src/render-video.ts:223`(acquireBrowser)/ `src/interactive-html/export-png.ts:48`(withBrowser);实际改动集中在 browser-pool.ts 的 ensure/defaultLaunch 单点(attach 适配层:ensure 子进程 → connect;池语义 close → disconnect,见 §一.5),~50 行,三个渲染文件经 BrowserLike 类型面零改动受益
2. 依赖声明:render 确定性档的 README/hint 增加"lasso 渲染档"为推荐路径(裸 Chrome attach 不再提供——确定性旗标必须由渲染档保证)
3. `MEDIA_GEN_RENDER_MODE=legacy` 逃生门(90 天)与退役时间表
4. watchdog 体系退役(见 §二阶段 3:【2026-09-01 裁决】直接废弃、无移交——`--clean` 清理与 LaunchAgent 指引移除,selfcheck 在 attach 下默认禁用以防 PPID=1 误报)
5. E2E 批测(e2e-tools.mjs)加 L3' 档:attach 渲染 golden 对比

## 五、双方向未定项(需共同裁决后写进各自文档)

1. 9224 端口冲突 fallback(渲染档要不要支持非常规端口协商?最小可行=固定端口,占用即报错 exit 3)——【2026-09-01 补充】**最小可行已定进 §一.1 退出码表**(固定端口 + exit 3);端口协商仅在出现真实多消费方并发单机需求后再开(R7 范畴)
2. 多消费方并发(两个 media-gen 实例同用一档:CDP 多 page 天然支持?独占锁需求何时引入=lasso R5)——【2026-09-01 补充】基础前提已硬化:ensure 并发单飞不 double-launch(§一.1);页面级隔离(每渲染会话独立 page + setViewport)消费方侧已具备
3. render-chrome install-agent 的卸载/升级路径(plist 版本管理)——【2026-09-01 补充】仅当 lasso 裁决为 launchd 直管形态(需求 R2a)才存在;若是 daemon 形态(b)本项整体消失。裁决前不设计

---
*【2026-09-01 补充】本文含同日二次审校补充(§一.1 字段/退出码/可执行文件解析、§一.2 touch 路径勘误+heartbeat 周期、§一.4 旗标导出法、§一.5 attach 集成契约含 close() 陷阱、§二阶段 2d 三态表+阶段 3 裁决改写、§三边界 7-9、§四精确落点、§五收口),依据 = 双仓现码(media-gen-mcp HEAD 2311f33:browser-pool.ts/render-selfcheck.ts/render-watchdog.mjs;lasso 现码:chrome-ledger.ts/chrome-touch.ts/chrome-stop.ts/chrome-idle-reaper.ts/launch-chrome.ts/CLI_USAGE)。*
