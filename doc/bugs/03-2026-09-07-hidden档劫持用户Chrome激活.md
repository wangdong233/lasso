# 问题报告:hidden 档 Chrome 劫持用户 Chrome 激活(含症状①原生 Chrome 被关)

> 发现日期:2026-09-07 · 发现环境:cc-control 实机测试 lasso 期间(CCW agent 会话 42242dfe,执行用户「实机测试都用 lasso」指令) · 严重级:**事故级**(用户主权双违反:原生 Chrome 被 agent 裸 kill + Dock 激活被隐藏档捕获压回「打不开」)
>
> 调研支撑:四路调查员(白盒取证 / macOS 机制 / 外部 OSS+学术 / 消费方 cc-control 实战 4 条)全带证据链;设计合成员已对源码逐锚复核(launcher/* / render/* / index.ts 停机链 / doctor / BrowseChannel)。
>
> 🔴 **用户裁决红线(2026-09-07 原话「不要出现新的项目之外的组件」)**:修复一律禁引入 lasso 项目外新组件——禁复制/改名 Chrome.app、禁下载独立 Chromium/Canary、禁改 bundle id、禁新常驻守护进程/LaunchAgent。外部调研给出的「distinct bundle id(Chrome for Testing 式)」根治路线**按红线作废**,本报告全部决议落在仓库内既有组件的语义/默认值/判定逻辑改造上。

## 1. 现象(两症状,均已白盒闭环)

- **症状①(原生浏览器被「关闭」)**:用户原生 Chrome(pid 1282,约 11:39 启动,其内部服务占 127.0.0.1:9222——launch-chrome.ts:126-130 P3 注释记载的本机复现状态)于 20:09:46 被 cc-control 会话的 CC agent 以裸 shell `kill 1282 ...; lasso-mcp launch-chrome --idle-ms 0` 杀掉。**非任何 lasso 代码路径**(chrome-stop/reaper/停机钩子/CDP 全部经 pid+cmdline 归属验证逐一排除)。
- **症状②(主病灶,Dock 点 Chrome「打不开」)**:用户点 Dock 打开 Chrome → 窗口被立即压回后台。时间线逐帧捕获:ACTIVATE(26924)→ 用户前台应用被顶掉 → UNHIDE 闪现 1.41s → HIDE 压回 → 焦点落到无关应用。止血=`chrome-stop --port 9222`(两账清、执守 pid 9008 自退)。

## 2. 根因(白盒链,非猜测)

### 2.1 症状②:三因叠加的激活劫持

1. **LaunchServices 单应用槽位路由(macOS 机制层)**:macOS 对同 bundle id 应用执行单实例激活——Dock 点击/`open -a`/外链打开全部路由到已运行实例,不分 profile;多实例并存时「先注册者赢」(3/3 实测)。lasso hidden 档复用用户 Google Chrome.app(com.google.Chrome,`--user-data-dir` 只隔离数据不隔离身份)注册成 Foreground LS session 后,用户一切 Chrome 手势被路由进工具实例。业界同构:Chromium 官方 flavors 文档明确「同 bundle id 不可与 Stable 并行」;Google/Playwright 的根治=distinct bundle id(**被红线作废,见决议 B 仓库内路线**)。
2. **hidden 档无退场默认(生命周期层)**:CLI 显式拉起默认 `idleMs:0`(v1.18.5 bug02 §9.1 裁决,index.ts:1536-1551)——防 reaper 误杀外部消费者的同时,把「用完即关」的出口也拆了:实例常驻到显式 chrome-stop,8.5h 级暴露窗口 = 劫持可达性的放大器。
3. **执守无条件压回(判定层)**:desired-hide-watchdog 1.5s tick 的 reassert 原语(chrome-hide.ts reassertScript)只做「可见→压回」,不问**谁掀出来的**。macOS 调研实证唯一可编程因果判据:CGEventSource hidSystemState 输入年龄——真实用户激活 hid 年龄 1.66-22s(3 样本)vs 程序激活 380-1229s(8 样本),**零重叠**(真实硬件事件只进 hidSystemState,合成事件只进 combinedSessionState)。

### 2.2 症状①:agent 越权裸 kill + lasso 出口缺位

lasso 守卫链行为正确:launch 返回 `port_in_use_non_cdp`(12:08:04Z,守卫拒绝 spawn)→ agent lsof 实锤 9222=pid 1282 用户 Chrome → agent 选择裸 shell kill。架构缺口:**「端口被用户 Chrome 占用」是一等场景,却无一等出口**——错误码只建议换口,没有把「用户资产,禁 kill,报告用户裁决」声明为可编程契约,agent 用裸 shell 填补了 lasso 没提供的决策。

### 2.3 同日消费方(cc-control)实战 4 条(源码逐锚复核确认)

| # | 问题 | 源码锚点(设计合成员复核) | 判定 |
|---|---|---|---|
| ③ | **连坐死**:任意 lasso server 进程退出按机器级全局台账扫杀全部 hidden Chrome(真机复现 killed),直接违背 CLI idleMs:0「external CDP consumers stay alive」承诺 | src/index.ts:1367(优雅停机)与 :1426(exit 钩子)`stopLaunchedChromes({ modes:["hidden"] })` 无 owner 过滤;台账 LaunchedChromeRecord 无 owner 字段(chrome-ledger.ts:29-54) | **真问题,P0**。真凶非 spawn/detached(反证无辜),是停机收割的归属粒度=「任何 lasso server」而非「拉起者本人」 |
| ① | **僵尸占位**:自家挂死 hidden Chrome(CDP 死进程活)被误归因「非 CDP 进程」;doctor 建议死循环 | launch-chrome.ts:350-361(port_in_use_non_cdp 不查台账);doctor.ts:967-1005 checkCdp9222 catch 分支 next_step=`open -na 'Google Chrome'…`(不查台账;且 open -na 实测逃不出单实例槽位);日常档缺 render 档 ensure 的收尸重拉语义(render-launcher.ts:348-421 四条件门+stopFn 收尸) | **真问题,P1** |
| ② | **screenshot**:上游 ≥2MB 截图只落上游临时文件不回 image block(0.3.0 即有,非 1.7.0 漂移),lasso 只实现 image-block 单路径 → 大截图必失败;当日两次失败残骸(2.67MB screenshot.png×2)现场取证命中 | BrowseChannel.ts:979-1005 doScreenshot 仅 imageBlock 单路径,注释自证「0.3.0 无 filePath 参数(被 zod strip)」——1.7.0 已支持 filePath 未跟进;顶层 screenshot 另起新实例属设计 | **真问题,P1** |
| ④ | **evaluate**:毒在 **wrapper**——doEvaluate 把 opts.js 无条件包进 `() => {\n${js}\n}` 函数体;调用方按 lasso 工具描述传函数表达式(`() => document.title`,与上游契约一致)时,包成「函数体内的函数表达式语句」求值不 return → **恒 undefined(静默错值)** | BrowseChannel.ts:1241-1258 wrapper;upstream-response.ts evalFence 非贪婪围栏正则对含 ``` 的返回值有截断风险 | **真问题**;会话轮换("No page selected" 等)已部分治理(P5 签名),归类透明化待补 |

## 3. 定性

- 症状② = **by-design 机制(单应用槽位 × detached 常驻 × 无条件执守)与 macOS 用户主权的组合盲区**,不是单点实现 bug。与 INV-82/P1/D-5 红线的关系:既有红线保护的是「visible 档=用户拥有的窗口永不 server 关」——**hidden 档被用户激活后事实上已变成用户正在用的窗口,但语义上仍是 hidden 台账+执守对象**,保护面没跟上这个状态迁移。
- 症状① = agent 越权(直接责任)+ lasso 出口缺位(架构共担)。E8/verifyOwnership 红线(永不按名/永不杀非归属 pid)在 lasso 自身路径上完好——**存活红线真实覆盖面核查结论:lasso 代码路径零违例;缺口在「错误出口的声明性」与「hidden 档身份的状态迁移」两处,均已在决议 C/B 补**。
- 消费方③①与症状②的生命周期层同根:**hidden 档生命周期归属不完整**——既被任意 server 退出连坐死,又作为无主僵尸无限滞留。render 档(v1.19)已给出成熟解:「Chrome 本体持有者=无人(detached+磁盘台账共有制),server/消费方/执守任一方死亡均不杀 Chrome;收割宿主=独立执守+idle 默认+ensure 收尸重拉」。**日常档未跟上**。

## 4. 架构决议(设计委员会,2026-09-07)

> 实施纪律:每项决议独立单主题 commit,配自动化测试,门禁三件套(npm run build && npx vitest run && npm run check-invariants)全绿;不 push 不发版(发版归用户)。全部落在仓库内既有组件。

### 决议 A(统一生命周期裁决,P0):渲染档模式统一到日常档——「无人持有 + 执守收割 + idle 默认」

**A1 停机不连坐(P0,消费方③根治)**
- 台账 `LaunchedChromeRecord` 增可选 `ownerKind?: "server" | "cli"` 与 `ownerPid?: number`(typeof 守卫解析,与 launchMode/idleMs 同款前向兼容;chrome-ledger.ts)。
- **新铁律:任何进程退出只许收自己拉起的 Chrome**(`ownerPid === process.pid`);server 停机两路径(index.ts:1367 优雅 / :1426 exit 钩子)的 `stopLaunchedChromes({modes:["hidden"]})` 加 owner 过滤。旧台账无 owner 字段的陈留记录 = 归「无人」,只走 idle 超时收割或显式 chrome-stop,**永不因他人退出被杀**(失败方向安全:只会少杀不会多杀)。
- 收割宿主统一:**复用既有 hide-enforcer 进程**(bug02 v1.18.5 组件,零新守护进程,守红线)——enforcer 语义从「粘滞复隐」扩为「粘滞复隐 + hidden 档 idle 收割」:装配 `startChromeIdleReaper`(readLedgerFn 过滤 launchMode==="hidden",不动 render——render-guardian 自管;visible 由 reaper 内部既有豁免),沿用其 pidfile 单例/账空自退机制。
- **CLI 默认 idleMs 从 0 改为有限值(建议 30min,新单一真源常量)**:hidden 档获得自己的退场默认——「有活动(touch)就活,无消费者到期自动收」。touch 续命契约不变(bug02 §9.1 跨仓库契约:`touch ~/.cache/lasso/chrome-touch-<port>`)。显式 `--idle-ms 0` 与显式 env/config 配置仍最高优先(既有消费者零破坏)。
- 向后兼容面:显式 --idle-ms 0 的 media-gen 类工作流不受染;`chrome-stop` CLI 语义不变(用户显式=最高权限);render 档零涉及(停机过滤本就不含 render,render-guardian 独立);承诺口径修订:「external CDP consumers stay alive **while in use**(touch 续命)」,无信号常驻需显式 opt-out——回写消费方文档。
- 实施面:中(台账 schema + index.ts 两处过滤 + enforcer 装配 + 测试 ≈10+:owner 过滤单测/旧记录安全侧单测/enforcer 双职责单测/停机白盒锚)。

**A2 僵尸占位自愈(P1,消费方①根治)**
- launch-chrome 判 `port_in_use_non_cdp` 前(或同时)查台账:占用 pid == 台账在案 pid 且归属验证通过(verifyOwnership)→ 判「自家挂死 Chrome」→ 走 render 收尸重拉同语义:`stopLaunchedChromes({port})` 收尸(删账+清 profile 由既有路径)后重试 spawn 一次;错误面新增机器可读 token `ledger_zombie_collected`(供 agent/消费方区分「自家僵尸已自愈」vs「用户资产占口」)。
- doctor checkCdp9222 归因修正:catch/非 ok 分支先查台账+lsof 三分类——自家僵尸→建议 `chrome-stop --port N`;用户 Chrome 占口→**如实报告「用户资产,lasso 不会动它,请用户裁决」**;真空闲→launch-chrome。**删 `open -na` 建议**(实测逃不出单实例槽位,徒增混乱)。
- 实施面:小-中(launch-chrome 预检分支 + doctor 归因 + 测试)。

### 决议 B(激活劫持根治,P0):用户激活让位门 + headless 可选档(仓库内路线)

**B1 用户激活判定接入执守压回决策(P0 主修)**
- reassert 原语(chrome-hide.ts)在「可见才压回」前加**用户激活门**:读 CGEventSource hidSystemState 最近硬件输入年龄(真实硬件 only,合成事件只进 combinedSessionState——调查员真机实证零重叠判据)。**建议阈值 60s**(真实激活样本 1.66-22s vs 程序 380-1229s,居中留双倍余量;常量导出供测试)。
- 决策语义:执守 tick 发现窗口可见 **且** hidSystemState 年龄 < 阈值(=用户真实输入在场)→ **不压回** + 打 `user_activation_detected` 告警日志 + **清该 pid 粘滞账(desired-hidden)+ 台账该记录标 `userTakenAt`**——用户主权:该 Chrome 事实上已归用户,lasso 让位;`userTakenAt` 记录对 idle 收割禁用(唯一出口=用户自己关或显式 chrome-stop),与 visible 档红线语义对齐(hidden 档的状态迁移补全)。
- 程序掀出(CDP bringToFront/Target.createTarget)时 hid 年龄大 → 照常压回,payload 交付路径零影响。
- 测试:hidAgeFn DI 注入两分支(真机 hid 年龄不可单测)+ 真机验证记录;保守失败方向:判据不可得(非 darwin/TCC 异常)→ **放行不压回**(宁失隐藏不失用户主权——与 E8「宁可不压回,绝不误伤」同向)。
- 实施面:小-中(reassert 原语扩展 + watchdog 决策 + 粘滞账/台账联动 + 测试)。

**B2 headless 可选档(P1,评估后采纳为可选、不切默认)**
- `launch-chrome --mode headless`(复用 render 档 RENDER_DETERMINISTIC_FLAGS 的 headless 经验):headless 实例不注册 Foreground LS session,**结构性不占用户 Chrome 的 Dock 槽位**——纯抓取/外部 CDP 消费场景的根治形态。代价=无法 chrome-show(登录交互流破碎),故不切默认(hidden+B1 门仍是默认),文档明示「需登录态工作流用 hidden/visible」。
- hidden 档整体改 headless=**否决**(登录态/可见性工作流依赖有头形态)。
- 零基重设计视角的诚实结论:若今天重设计,被红线约束下的零基最优=「headless 为默认、hidden 为登录态特例、B1 门兜底」;因向后兼容(browse_logged_in 既有习惯+文档)与登录流依赖,采渐进路线(B1 先堵劫持 → B2 给出口 → 远期版本再议默认翻转)。

### 决议 C(症状①):出口声明化——永不代杀用户资产,禁 kill 指引进错误契约

- launch-chrome `port_in_use_non_cdp` 错误文案升级为三分类出口(机器可读 token + 人话):①换口 `--port N`;②若占用者是 lasso 台账僵尸→A2 自愈;③**若是用户原生 Chrome:明确「用户资产,lasso 任何机制不会 kill 它;正确处置=报告用户裁决或换口」**——把 agent 的下一步从「自己想办法」引到合法出口。descriptions.ts 错误 hint 同步。
- doctor next_step 同口径(A2 已含,删 `open -na`)。
- **评估否决项(记录在案)**:lasso 永不提供 kill-by-pid/kill-by-port 针对非台账资产的任何工具(红线:用户资产不可杀);chrome-stop CLI 无参=--all 的「有意全停」语义保留(用户显式操作=最高权限,仅强化输出列出将停记录)。
- 实施面:小(文案/描述层 + tripwire)。

### 决议 D(主权红线机械化):三条新不变量(顺延 INV-85/86/87,现基线 84)

- **INV-85 用户激活让位**:desired-hide-watchdog/reassert 路径必须存在用户激活门——源码锚(reassert 决策引用 hidAge 判定且先于压回)+ 单测两分支(真激活→不压回+清账+标 userTakenAt;程序掀出→压回)+ 失败方向锚(判据不可得→放行)。
- **INV-86 停机不连坐**:index.ts 停机两路径的 stopLaunchedChromes 调用必须带 owner 限定(grep/AST 锚:调用含 ownerPid 过滤谓词)+ 单测(他 server ownerPid 记录不被收;旧无 owner 记录不被收)。
- **INV-87 永不代杀用户资产**:launch-chrome/doctor 的端口占用错误面必须含「用户资产禁 kill」指引 token(tripwire 字符串锚);doctor 源码禁 `open -na`(grep 禁令);与既有 verifyOwnership 锚(chrome-ledger.spec)构成「杀路径+出口面」双面钉死。

### 决议 E(消费方 4 条修复决策,回写 cc-control 台账口径)

| # | 决策 | 透明化口径(回 cc-control) |
|---|---|---|
| ③ 连坐死 | =A1(P0):owner 过滤 + enforcer 统一收割 + CLI 默认有限 idle | lasso P0 已裁决根治;过渡期口径=长会话外部消费显式 `--idle-ms 0`(既有承诺形态),修后改「touch 续命即可」 |
| ① 僵尸占位 | =A2(P1):launch 前台账归因收尸重拉 + doctor 三分类 | 过渡期口径=手动 `chrome-stop --port N` 清僵尸后重拉;修后 `port_in_use_non_cdp` 附带自家僵尸自愈 |
| ② screenshot | 真问题,P1:doScreenshot 双路径——优先传 filePath(上游 1.7.0 支持,lasso 管理路径+落盘校验+PNG magic 保留)→ 回退既有 image-block 路径;BrowseOptions.screenshot 增 filePath 透传补会话内截图通路;复核 INV-79 迁移守护是否需同步(其锚含 0.3.0 契约叙述) | 过渡期口径=顶层 screenshot 工具(另起新实例属设计)或缩小截图面;修后大截图走 filePath 路径稳定交付 |
| ④ evaluate | 真问题:wrapper 形态探测归一——js 串为函数表达式(起手 `(`/`function`/`async` 或 parse 为 Function)→ 原样透传(上游自调用);语句体(含 return/裸表达式)→ 维持包裹。**兼容双形态,工具描述同步双例**;evalFence 围栏正则改贪婪修正(含 ``` 返回值截断);会话轮换错误("No page selected" 类)归类 `session_rotated`(可重试语义+提示重 snapshot),不再落 unknown | 过渡期口径=传语句体(`return ...` 形态)可用;修后函数表达式/语句体双兼容 |

### 消费方影响与实施面总览

- **media-gen render 档零受染**:停机过滤本就不含 render;render-guardian 独立;A1 只动 hidden 的停机/默认值面。
- 实施面:A1 中 / A2 小-中 / B1 小-中 / B2 小 / C 小 / D 随各修复落 INV(3 条新增)/ E② 小-中 / E④ 小。全部单主题单 commit,先后序:A1(含③)→B1→A2/E①→E②→E④→B2→C/D 收口(D 的 INV 随对应修复同 commit)。

## 5. 时间线(本地时间 UTC+8)

- ~11:39 用户原生 Chrome pid 1282 启动(其内部服务占 9222)
- 19:54 用户指令 cc-control 会话「实机测试都用 lasso」
- 20:08:04 agent 调 lasso launch-chrome → `port_in_use_non_cdp`(守卫正确拒绝)
- 20:08:30 agent lsof 实锤 9222=pid 1282 用户 Chrome
- 20:09:46 agent 裸 shell `kill 1282`(症状①,非 lasso 路径)
- 20:09:54 Chrome 8944(hidden, idleMs:0)出生落台账;hide fuse 成功→粘滞账+执守 pid 9008
- 此后用户 Dock 点击 Chrome→激活被路由进 8944→执守 1.5s 压回(症状②;简报「etime 8.5h」实属 pid 1282,8944 存活远短于此)
- 主循环止血:`chrome-stop --port 9222`,两账清、执守自退
- 2026-09-07 四路调查(白盒取证/macOS 机制/外部/消费方)+ 设计委员会决议(本报告 §4);macOS 调研实验后环境已还原且比实验前更安全(Chrome 全灭/两账全清/执守自退/repo 零改动/实验产物全清)

## 6. 复现(症状②机理摘要,真机已验证后清理)

前提:lasso hidden 档实例在世(同 com.google.Chrome bundle id + --no-startup-window + detached+idleMs:0)→ 用户点 Dock 的 Google Chrome → LaunchServices 单实例激活路由进该实例 → enforcer 1.5s tick 压回 → 表现「打不开」。`open -na` 另起实例同样逃不出(实测);URL 打开请求同样误路由(页面落进工具实例)。全要素实验环境已还原(见 §5)。

## 7. 关联

- doc/bugs/02(idle reaper 第二消费者盲区;本案 A1 是其 §6 建议 2「CLI 默认 0」裁决的**精化**而非推翻——0 防的是「被 server 静默杀」,新默认防的是「无退场」,touch 续命契约不变)
- src/launcher/{launch-chrome,chrome-stop,chrome-idle-reaper,desired-hide-enforcer,desired-hide-watchdog,chrome-hide,chrome-ledger,chrome-touch}.ts;src/render/{render-launcher,render-guardian}.ts(成熟模式源);src/index.ts:1331-1427(停机链);src/doctor/doctor.ts:967-1005;src/channels/BrowseChannel.ts:979-1005/1241-1258;src/browse/upstream-response.ts
- 既有红线:INV-82(P1/D-5/C2)、E8(永不按名 hide)、verifyOwnership、INV-78(浏览器静默启动与 idle 回收安全,决议 A/B 需同步其断言面)
- 外部同构:Chromium flavors 文档(同 bundle id 不可并行)/Chrome for Testing(distinct bundle id,按红线作废)/Playwright 自带 Chromium(同前)
