# 问题报告:chrome-idle-reaper 误杀外部 CDP 消费者的 Chrome(第二消费者盲区)

> 发现日期:2026-08-26 · 发现环境:Claude Code(VSCode extension)Bash 工具内 CLI 拉起 + media-gen-mcp FlowProvider CDP 直连消费 · 严重级:**高**(外部消费者场景下 Chrome 稳定存活仅 ~60-75s,连接反复中断;lasso 自身 browse 通道不受影响)

## 1. 现象

- `lasso launch-chrome --port 9223`(默认 hidden 档)拉起的 Chrome,在宿主(Claude Code Bash 工具)的**工具调用间隙死亡**:稳定存活约 60-75 秒,随后 CDP 9223 `ECONNREFUSED`/S100
- 死亡与"哪个命令拉起"无关、与 Chrome 是否有打开的 page target 无关(已打开 labs.google 项目页仍被杀);本日实测 5+ 次全部复现
- 死后台账 `~/.cache/lasso/launched-chromes.json` 变回 `[]`(记录被删——stopLaunchedChromes 的删账行为)

## 2. 根因(白盒链,非猜测)

**不是** spawn/detached/宿主进程组回收问题(launch 是 detached + unref,reaper 注释自证 §1.4)。真凶是 lasso 自身的 **chrome-idle-reaper**(v1.10 parse18 §2 机制一):

1. **常驻 lasso MCP server 装配了 reaper**(`src/index.ts:477`):15s tick 读台账;本会话 CC 的 lasso MCP server 一直在跑 → 即使 Chrome 是从 Bash 里 CLI 拉起的,reaper 也看得见台账记录(台账是磁盘共享的单一数据面)
2. **LAUNCH_IDLE_MS 默认 60s**(`src/index.ts:470` 注释):hidden 档 Chrome 的"用完即关"设计语义
3. **touch 活动源唯一**:`LoggedInChannel` 每次 browse 经注入回调 `onChromeUse → touch(port)`(`chrome-idle-reaper.ts:18`)。**media-gen-mcp FlowProvider 这类外部 CDP 直连消费者对 reaper 完全不可见**——touchMap 永无记录 → `lastUse = launchedAt`
4. `now - lastUse > 60s` → 首个 15s tick 命中 → `stopLaunchedChromes({port})` 树杀 + 删账(`chrome-idle-reaper.ts:196-205`)

时间线完全吻合:存活 60-75s = idle 60s + tick 相位差 0-15s。

## 3. 定性

**by-design 机制与第二消费者的组合盲区,不是实现 bug**。reaper 的设计假设是"launched Chrome 的唯一消费者是 lasso 自己的 browse 通道";台账(磁盘共享)与 reaper(server 进程内)的分离使 CLI 拉起的 Chrome 也落入 server reaper 的管辖,而外部消费者零活动信号。这正是 `chrome-idle-reaper.ts:19` 自己引用的 **R-INT-07(运行时 mutable state 多消费者耦合)** 的活案例——touchMap 单写多读形态防的是 reaper/Channel 之间的写冲突,没有防"写者之外还有整个消费维度"。

同类先例:zombie reaper 管 procs(MCP shim→node 树)与 chrome reaper 管 ledger(detached Chrome)的两数据域分工(parse18)本身承认了"消费形态多样",但活动信号的扩展没有跟上。

## 4. 复现

```bash
# 前提:一个常驻 lasso MCP server 在跑(CC 会话内即满足)
cd lasso && node dist/index.js launch-chrome --port 9223   # 默认 hidden + 全局 idle 60s
sleep 1  # 打开 page target(证明"有页面"不影响)
node -e "..."  # 任意 CDP 直连操作
# 之后不再有任何 lasso browse 调用 → 60-75s 后:
curl http://127.0.0.1:9223/json/version   # ECONNREFUSED
cat ~/.cache/lasso/launched-chromes.json  # []
```

## 5. 缓解(已验证)

拉起时**record 级禁用收割**:

```bash
node dist/index.js launch-chrome --port 9223 --idle-ms 0
# 台账记录写 "idleMs": 0 → reaper tick 里 idleMs<=0 直接 continue,永不收割
# 或全局:env LASSO_LAUNCH_IDLE_MS=0(影响所有 launched Chrome,粒度粗)
```

实测 `--idle-ms 0` 后台账记录 `{"port":9223,...,"idleMs":0}`,Chrome 跨宿主多个工具调用持续存活(本报告附带的后续 media-gen 验证链全程依赖此缓解,90s+ 不死)。

## 6. 修复建议(lasso 侧,供裁决)

1. **文档级(最小成本,立即)**:`launch-chrome --help` 与 README 的 launch-chrome 章节显著标注——"Chrome 将被**非 lasso browse 通道**消费(外部 CDP 直连/自动化)时,必须 `--idle-ms 0`,否则 60s 后被 server 端 idle reaper 回收"。当前 `--help` 无此警示。
2. **语义级(建议)**:CLI **显式**拉起(用户手敲命令)与 server 内部自动拉起的语义区分——CLI 显式拉起默认写 `idleMs: 0`(用户显式要的 Chrome 不该被后台静默回收),server 自动补的维持 60s 用完即关。变化面:launch-chrome.ts 写台账处(473/502/545)默认值来源分级。
3. **结构级(长期,R-INT-07 正解)**:touch 活动源泛化——例如台账记录支持外部 touch(约定文件 `~/.cache/lasso/chrome-touch-<port>` mtime 即活动信号,reaper tick 顺带 stat),让第二消费者有一等信号通道而不是绕过收割。
4. **错误面**:CDP 断连错误(S103 类)的 hint 文案补一句"若 Chrome 由 lasso 拉起且超过 60s 无 browse 活动,可能已被 idle reaper 回收;外部消费场景请 `--idle-ms 0` 重新拉起"——把这类死亡从"神秘断连"变成自解释。

## 7. 时间线

- 2026-08-26 下午:media-gen-mcp Flow 渠道 live 验证过程中,Chrome 反复"活一个调用就死",最初误判为宿主 Bash 进程组回收(错误假设,已在 §2 澄清)
- 白盒定位:读 chrome-idle-reaper.ts → 60s 默认 + touch 唯一源 → 台账删除实锤 → `--idle-ms 0` 验证存活
- 本报告归档;media-gen-mcp 侧的 Flow 契约/文档同步改用 `--idle-ms 0` 启动命令

## 8. 关联

- media-gen-mcp FlowProvider(外部 CDP 消费者)契约 `doc/flow-api-contract.md` 启动命令已同步 `--idle-ms 0`
- R-INT-07(架构想法/02_简单架构清单.md)又一实证:运行时 mutable state(touchMap)的多消费者耦合,单写多读不够,还得防"未知消费者维度"

## 9. 闭环纪要(2026-08-27,v1.18.5 工作树,§6 四条建议全落地 + 隐藏洞补全)

### 9.1 本案四条(reaper 误杀外部消费者)

| §6 建议 | 落地 | 位置 |
|---|---|---|
| 1 文档级 | ✅ CLI_USAGE(index.ts launch-chrome 行)+ README.md/README.en.md + TROUBLESHOOTING 9.3 + descriptions.ts 错误 hint + doctor.ts cdp_9222 next_step | src/index.ts / docs |
| 2 语义级(CLI 显式拉起默认 idleMs:0) | ✅ `mergedEnv().LASSO_LAUNCH_IDLE_MS` 未显式配置(env/config.json 均无)→ CLI 传 0;显式配置与 argv 仍最高优先 | src/index.ts launch-chrome 分支 |
| 3 结构级(touch 活动源泛化) | ✅ 新模块 `src/launcher/chrome-touch.ts`:`chrome-touch-<port>` mtime 即活动信号;reaper tick `touchStatFn` stat 并入三源取 max(launchedAt / touchMap / touch mtime);launch-chrome 三处 recordLaunch 后自 touch 确立约定文件 | chrome-touch.ts + chrome-idle-reaper.ts + launch-chrome.ts |
| 4 错误面 | ✅ BROWSE_LOGGED_IN_DESCRIPTION 增「Chrome died ~60-75s after launch」段;doctor cdp_9222 fail next_step 附 reaper 归因 + touch 续命一行 | descriptions.ts + doctor.ts |

外部消费者契约(跨仓库,改名即破坏):**续命 = `touch ~/.cache/lasso/chrome-touch-<port>`**(文件 mtime 即"最近一次外部使用");lasso 侧 env `LASSO_CHROME_TOUCH_DIR` 可重定位(测试隔离用)。

### 9.2 隐藏洞补全(「有时隐藏不住」主根因,三线调查 [隐藏洞] 实锤)

- **出生洞**:hidden 档出生即无粘滞保护——粘滞账全库唯一写入方是 chrome-hide CLI,launch 从不写;外部 CDP 消费者掀出后 server 全活也无人复隐(真机 A/B:sticky=[] 时 Target.createTarget 掀出 10.8s 仍 visible)。**修**:launch-chrome `scheduleHideFuse` 内 `r.ok && pid` → `addDesiredHidden` + `ensureHideEnforcerRunning`(hide 失败不记——与 chrome-hide CLI 降级形态一致)。
- **执守失配**:看门狗只活在 server 进程,Chrome 是 detached+unref——server 崩溃/SIGKILL/纯 CLI 拉起时掀出无人压回。**修**:新模块 `src/launcher/desired-hide-enforcer.ts` + CLI 子命令 `hide-enforcer`——chrome-hide 成功与 launch hidden 记账后 `ensureHideEnforcerRunning()`(pidfile `~/.cache/lasso/desired-hide-enforcer.json` + ps cmdline 标记三重活判定防 pid 复用;detached+unref;账空 2 tick 自退不留常驻 node;并发双起入口让位收敛);`startDesiredHideWatchdog` 增 `exitWhenIdleTicks`/`onIdleExit`(缺省 undefined = server 形态永不自退,不破既有契约)。
- 手动 `lasso chrome-show` 仍是明示解除(清账后执守不再压回);watchdog 与执守并发幂等(reassert 先读后写「可见才压回」)。

### 9.3 常驻 Chrome 判定(结论 A:不常驻,按需拉起)

真机实测(2015 MBP11,4 / i7-4770HQ / 16GiB,高压基线 free+spec≈130MB/swap 989MB/load 5.9):hidden 档冷启动 CDP 可用仅 1.24-1.51s(n=5,中位 1.36s)——"3-5s 启动慢"不成立;常驻真实代价是内存而非 CPU(纯净 hidden ~250MB/4procs,但任何外部消费者连过留下 tab 后 3 分钟膨胀到 885MB/13procs,且常驻必需的 `--idle-ms 0` 使增长无上界)。**裁决:不做 resident 便利命令**;文档层给「session 预热」配方:`--idle-ms 1800000`(到点自动收,即得常驻全部收益而无无上界代价)。已写进 README(中英)+ KEY-GUIDE。

### 9.4 测试增量(新基线 2446+1 / 82 INV,原 2417+1,+29)

- `test/unit/chrome-touch.spec.ts`(新,4 测):路径约定/env 覆盖/mtime 刷新/best-effort
- `test/unit/desired-hide-enforcer.spec.ts`(新,15 测):probe 四态一活/ensure 单例 spawn+跳过+入口缺失降级/watchdog exitWhenIdleTicks 三形态/CLI 接线白盒
- `test/unit/chrome-idle-reaper.spec.ts`(+3 测 it10-12):外部 touch 新鲜不杀/陈旧照杀/缺省接线白盒
- `test/unit/launch-chrome.spec.ts`(+7 测 B1-B7):hidden 落账+执守被调/visible 不落账/fuse denied 不落账/fallback 同落账/自 touch 诞生/两处白盒锚点
- 实施期修复 3 个测试自伤:B1/B2 的 `ensureEnforcerFn` 被 `...FAST_PROBE` 覆盖(属性序);pidfile JSON 断言空格;test8 的 endsWith("/index.js") 弱断言升级为结构锚定(见 9.6)
- 实施期修复 1 个**新引入的 hermeticity 漏洞**(全量套跑实锤):p1-visible-chrome-lifecycle.spec 的 ok 路径经新 touchChromePort 落了**真实** ~/.cache/lasso/chrome-touch-9222,反噬 chrome-autohide.spec 的无注入 reaper(default touchStatFn 读真实文件→mtime≈真实时钟≫fake now 1e6→永不收割→2 用例 flaky)。修:p1 spec 三 env 隔离(LAUNCHED_CHROMES/DESIRED_HIDDEN/CHROME_TOUCH_DIR)+ autohide makeAutoHideReaper 注入 `touchStatFn: () => undefined`(与 reaper spec makeReaper 同款范式——**凡消费 reaper/launchChrome 的 spec 必须显式注入 touchStatFn 或隔离 touch dir**)

### 9.5 真机全生命周期验证(2026-08-27,端口 9223,MBP11,4)

| 步骤 | 结果 |
|---|---|
| CLI `launch-chrome --port 9223`(无 --idle-ms) | 台账 `"idleMs": 0` ✅(新默认);touch 文件 `chrome-touch-9223` 诞生 ✅;sticky 账出生落 pid ✅ |
| 执守拉起(修 9.6 后) | detached node `dist/index.js hide-enforcer` 真起,pidfile 三重判定 running ✅;二次 ensure → `already_running` 不双起 ✅ |
| 掀出压回 | AX `set visible → true` 读回 true,~1s 内被执守压回 false ✅(server 全程不在场——独立执守生效的实锤) |
| `chrome-stop --port 9223` | Chrome 死 ✅ + sticky 账清空 ✅ + 执守 2 空账 tick 自退(无残留进程) ✅ |
| 清理 | profile/touch/pidfile/台账全清,9223 释放 ✅ |

注:reaper 的 touch-stat 消费面为单测+白盒锚定(it10-12);未起第二个 server 做活体 reaper 实验(3 个 CC 会话 server 存活,cache 争用面不值得——真机主路径「CLI 默认 0 已不进 reaper 管辖」已实锤)。

### 9.6 实施期真机实锤:执守入口路径 bug01 同族复发(已修)

初版 `hideEnforcerEntryPath()` 用 `new URL("../../index.js")`——注释声称「launcher/ → 上两级」,实际 launcher/ 到 index.js 只隔**一级**(dist/launcher/ → dist/index.js = package.json bin 入口)。后果:真机 launch-chrome 后执守**静默从未真起**(accessSync 诚实降级 entry_missing,主流程无感)。单测 test8 初版断言 `endsWith("/index.js")` 对两种深度都通过——弱断言放过此 bug(与 bug01 的路径相对解析同族,且同样只有真机能抓)。修:`../index.js` + test8 升级为结构锚定(=== src/index.js 精确路径 + dist 布局同构 existsSync 双断言)。

### 9.7 残余与边界(诚实)

- `--idle-ms 0` 的 Chrome 需要显式 `chrome-stop` 收(工作流侧 media-gen 已如此用);reaper 只活在 server 进程的边界不变(CLI 无 reaper)。
- 执守进程 spawn 用 `process.execPath` + `../index.js`(launcher/ 上一级;见 9.6——初版 `../../` 是 bug01 同族,已修并有结构锚定测试);布局异常(无 index.js)诚实降级不 spawn——server 内看门狗仍是主执守面。
- bug01 侧核验:§4 五条 + §8 A1 三件套在 HEAD 全部在位,代码与档案零漂移;唯一叙述注记见 doc/bugs/01 §5 补记(净版 v1.18.5)。
