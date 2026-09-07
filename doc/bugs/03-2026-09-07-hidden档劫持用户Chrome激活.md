# 问题报告:hidden 档 Chrome 劫持用户 Chrome 激活(含症状①原生 Chrome 被关)

> 发现日期:2026-09-07 · 发现环境:cc-control 实机测试 lasso 期间(CCW agent 会话 42242dfe,执行用户「实机测试都用 lasso」指令) · 严重级:**事故级**(用户主权双违反:原生 Chrome 被 agent 裸 kill + Dock 激活被隐藏档捕获压回「打不开」)
>
> 调研支撑:四路调查员(白盒取证 / macOS 机制 / 外部 OSS+学术 / 消费方 cc-control 实战 4 条)全带证据链;设计合成员已对源码逐锚复核(launcher/* / render/* / index.ts 停机链 / doctor / BrowseChannel)。**2026-09-08 否定复审**:设计修订员对决议 v1 四条否定发现逐条源码复核,全部确认(B1 归因谬误/副作用耦合、A1×B1 矛盾、chrome-show 倒挂),决议修订见 §4.0 与修订版 A1/B1/INV-85/86。
>
> 🔴 **用户裁决红线(2026-09-07 原话「不要出现新的项目之外的组件」)**:修复一律禁引入 lasso 项目外新组件——禁复制/改名 Chrome.app、禁下载独立 Chromium/Canary、禁改 bundle id、禁新常驻守护进程/LaunchAgent。外部调研给出的「distinct bundle id(Chrome for Testing 式)」根治路线**按红线作废**,本报告全部决议落在仓库内既有组件的语义/默认值/判定逻辑改造上。

## 1. 现象(两症状,均已白盒闭环)

- **症状①(原生浏览器被「关闭」)**:用户原生 Chrome(pid 1282,约 11:39 启动,其内部服务占 127.0.0.1:9222——launch-chrome.ts:126-130 P3 注释记载的本机复现状态)于 20:09:46 被 cc-control 会话的 CC agent 以裸 shell `kill 1282 ...; lasso-mcp launch-chrome --idle-ms 0` 杀掉。**非任何 lasso 代码路径**(chrome-stop/reaper/停机钩子/CDP 全部经 pid+cmdline 归属验证逐一排除)。
- **症状②(主病灶,Dock 点 Chrome「打不开」)**:用户点 Dock 打开 Chrome → 窗口被立即压回后台。时间线逐帧捕获:ACTIVATE(26924)→ 用户前台应用被顶掉 → UNHIDE 闪现 1.41s → HIDE 压回 → 焦点落到无关应用。止血=`chrome-stop --port 9222`(两账清、执守 pid 9008 自退)。

## 2. 根因(白盒链,非猜测)

### 2.1 症状②:三因叠加的激活劫持

1. **LaunchServices 单应用槽位路由(macOS 机制层)**:macOS 对同 bundle id 应用执行单实例激活——Dock 点击/`open -a`/外链打开全部路由到已运行实例,不分 profile;多实例并存时「先注册者赢」(3/3 实测)。lasso hidden 档复用用户 Google Chrome.app(com.google.Chrome,`--user-data-dir` 只隔离数据不隔离身份)注册成 Foreground LS session 后,用户一切 Chrome 手势被路由进工具实例。业界同构:Chromium 官方 flavors 文档明确「同 bundle id 不可与 Stable 并行」;Google/Playwright 的根治=distinct bundle id(**被红线作废,见决议 B 仓库内路线**)。
2. **hidden 档无退场默认(生命周期层)**:CLI 显式拉起默认 `idleMs:0`(v1.18.5 bug02 §9.1 裁决,index.ts:1536-1551)——防 reaper 误杀外部消费者的同时,把「用完即关」的出口也拆了:实例常驻到显式 chrome-stop,8.5h 级暴露窗口 = 劫持可达性的放大器。
3. **执守无条件压回(判定层)**:desired-hide-watchdog 1.5s tick 的 reassert 原语(chrome-hide.ts reassertScript)只做「可见→压回」,不问**谁掀出来的**。macOS 调研实证唯一可编程因果判据:CGEventSource hidSystemState 输入年龄——真实用户激活 hid 年龄 1.66-22s(3 样本)vs 程序激活 380-1229s(8 样本),**零重叠**(真实硬件事件只进 hidSystemState,合成事件只进 combinedSessionState)。【2026-09-08 §4.0-F1 修订注:该零重叠结论**限定于机器闲置时段**(程序样本采自用户离席时);hidSystemState 为系统级信号无 per-app 归因,互动会话中恒小——B1 据此升级为三判据 AND+确认窗,见 §4 B1。】【🔴 2026-09-08 对抗复审 r1 再订正:「合成事件只进 combinedSessionState」只对 **CGEventSource state 查询 API** 成立;B1 实现读的是 **ioreg IOHIDSystem HIDIdleTime**,System Events 合成 CGEvent(key code)实测同样将其归零——ioreg 路径的判据 (a) 可被 shell 程序伪造(真机合成输入+open -a 走满确认窗落 userTakenAt 实证),详见 §4 B1 残余风险追加段。】

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

## 4. 架构决议(设计委员会,2026-09-07;2026-09-08 否定复审修订)

> 实施纪律:每项决议独立单主题 commit,配自动化测试,门禁三件套(npm run build && npx vitest run && npm run check-invariants)全绿;不 push 不发版(发版归用户)。全部落在仓库内既有组件。

### 4.0 否定复审(2026-09-08,设计修订员逐条复核——四条全部确认,零误报驳回)

| # | 否定发现(摘要) | 复核证据锚(白盒) | 裁决 |
|---|---|---|---|
| F1 | B1 hidAge 单判据**归因谬误**:hidSystemState 是系统级空闲计时器,无 per-window/per-app 归因——「hid 年龄小」只证明用户在机器某处活动,不证明用户激活了这个 Chrome。互动会话中用户打字时 hid 持续 <1s,活跃时段门 ≈ 恒放行;P27 实证程序掀出恰高发于 agent 活跃期=用户在场期(含页面 window.open 弹窗完整通路) | desired-hide-watchdog.ts:15-16 / desired-hide-state.ts:5-7(P27 契约与实证:掀出源=上游 CDP/页面 JS/Chrome 内部,发生于运行期);v1 草案「程序激活 hid 380-1229s」样本只在机器闲置时段成立(肯定后件的采样偏差);页面 JS 无法伪造 hidSystemState(合成事件只进 combinedSessionState)但无需伪造——环境性输入即通过 | **确认 P0**。B1 重写为三判据 AND+确认窗(见修订版 B1);阈值 60s→10s |
| F2 | B1 三副作用耦合过猛:一次门通过即**清粘滞账+标 userTakenAt 禁 idle**=对 v1.18.3 防闪契约(「任何激活源掀出至多存活一个 tick」)的实例级**永久回退**;其后页面弹窗全程无人压;失败路径(判据不可得)按 v1 文案同样放行——JXA 漂移/TCC 瞬态即永久 disarm | 粘滞账唯一写入方=chrome-hide CLI / launch-chrome hidden fuse(addDesiredHidden 全库仅 3 调用点:chrome-hideshow-cli.ts:136/:176、launch-chrome.ts:459),唯一清账方=chrome-show,**无任何自动重挂路径**——清账即永久 disarm | **确认 P0**。放行=暂停本 tick 零账面突变;userTakenAt 仅确认窗后落;判据不可得路径禁账面突变 |
| F3 | A1×B1 内部矛盾:A1 铁律「owner===self 退出可收」会杀掉 userTakenAt 实例——B1 自称对齐 visible 红线(含停机/exit 路径),A1 实际只给了 idle 级保护 | index.ts:1367/:1426(停机/exit 两路径)× index.ts:1412-1413(stdin EOF 即触发);chrome-stop.ts:50-57 modes 豁免防的正是同事故型「短命 server 退出把用户登录窗口砸掉」(v1.17.3 P1 / v1.18 D-5) | **确认 P0(规范级)**。收割谓词加第三维 userTakenAt 豁免(等同 visible);复核注记:当前仓库 launchChrome 唯一在世入口=CLI(runLaunchChromeCli,spawn 后即 process.exit 且不注册 exit 收割钩子),现网 ownerKind 记录皆 "cli" 本就不在任何 server 的 owner 范围——第三维护的是 server-owned 记录(MCP chrome-launch 曾在案,launch-chrome.ts:49/P31 注记)与 A1×B1 联合语义一致性 |
| F4 | chrome-show 清粘滞账但台账记录仍 hidden+idleMs:CLI 默认 idle 0 现状下无害,A1 翻默认 30min 后,用户 chrome-show 看窗的实例 30min 无 touch 即被 idle 收割——**窗口在用户面前被关**;而 B1 的 hidAge 启发式反而拿到更强 userTakenAt 待遇(倒挂) | chrome-hideshow-cli.ts:146-185(--port/--all 路径仅操作 desired-hidden,不更新台账);index.ts:1541-1547(CLI 显式拉起默认 idleMs=0 现状);chrome-idle-reaper.ts:229(visible 才 continue,hidden 记录进 stopFn 收割) | **确认 P0**。chrome-show 成功同标 userTakenAt(显式操作 > 任何启发式);测试覆盖「chrome-show 后 idle 不收」 |

> 复审方法:逐条对照源码(desired-hide-state / desired-hide-watchdog / chrome-hide reassertScript / chrome-hideshow-cli / chrome-idle-reaper / chrome-stop / index.ts 停机链 / launch-chrome)与本文 v1 决议文本;四条发现的机制链、调用点、行号锚全部实证成立,无误报。

### 决议 A(统一生命周期裁决,P0):渲染档模式统一到日常档——「无人持有 + 执守收割 + idle 默认」

**A1 停机不连坐(P0,消费方③根治)**
- 台账 `LaunchedChromeRecord` 增可选 `ownerKind?: "server" | "cli"`、`ownerPid?: number` 与 **`userTakenAt?: number`**(B1 确认窗/chrome-show 落写的让位时刻;schema 三字段同 commit 引入,免 B1 前向依赖)(typeof 守卫解析,与 launchMode/idleMs 同款前向兼容;chrome-ledger.ts)。
- **新铁律:任何进程退出只许收自己拉起的 Chrome**(`ownerPid === process.pid`);server 停机两路径(index.ts:1367 优雅 / :1426 exit 钩子)的 `stopLaunchedChromes({modes:["hidden"]})` 收割谓词升级为**三维过滤:modes × owner × userTakenAt 豁免**——`userTakenAt` 记录等同 visible 豁免:两路径不杀、**台账条目保留**(v1.17.3 P1 / v1.18 D-5 同一事故型「server 退出把用户正在用的窗口砸掉」;B1 声称对齐 visible 红线,谓词必须兑现——§4.0-F3)。旧台账无 owner 字段的陈留记录 = 归「无人」,只走 idle 超时收割或显式 chrome-stop,**永不因他人退出被杀**(失败方向安全:只会少杀不会多杀)。
- 收割宿主统一:**复用既有 hide-enforcer 进程**(bug02 v1.18.5 组件,零新守护进程,守红线)——enforcer 语义从「粘滞复隐」扩为「粘滞复隐 + hidden 档 idle 收割」:装配 `startChromeIdleReaper`(readLedgerFn 过滤 launchMode==="hidden",不动 render——render-guardian 自管;visible 由 reaper 内部既有豁免),沿用其 pidfile 单例/账空自退机制。
- **CLI 默认 idleMs 从 0 改为有限值(建议 30min,新单一真源常量)**:hidden 档获得自己的退场默认——「有活动(touch)就活,无消费者到期自动收」。touch 续命契约不变(bug02 §9.1 跨仓库契约:`touch ~/.cache/lasso/chrome-touch-<port>`)。显式 `--idle-ms 0` 与显式 env/config 配置仍最高优先(既有消费者零破坏)。
- 向后兼容面:显式 --idle-ms 0 的 media-gen 类工作流不受染;`chrome-stop` CLI 语义不变(用户显式=最高权限);render 档零涉及(停机过滤本就不含 render,render-guardian 独立);承诺口径修订:「external CDP consumers stay alive **while in use**(touch 续命)」,无信号常驻需显式 opt-out——回写消费方文档。
- 实施面:中(台账 schema 三字段 + index.ts 两处三维过滤 + enforcer 装配 + 测试 ≈12+:owner 过滤单测/旧记录安全侧单测/**owner===self 且 userTakenAt 不被收且台账保留单测(§4.0-F3)**/enforcer 双职责单测/停机白盒锚)。

**A2 僵尸占位自愈(P1,消费方①根治)**
- launch-chrome 判 `port_in_use_non_cdp` 前(或同时)查台账:占用 pid == 台账在案 pid 且归属验证通过(verifyOwnership)→ 判「自家挂死 Chrome」→ 走 render 收尸重拉同语义:`stopLaunchedChromes({port})` 收尸(删账+清 profile 由既有路径)后重试 spawn 一次;错误面新增机器可读 token `ledger_zombie_collected`(供 agent/消费方区分「自家僵尸已自愈」vs「用户资产占口」)。
- doctor checkCdp9222 归因修正:catch/非 ok 分支先查台账+lsof 三分类——自家僵尸→建议 `chrome-stop --port N`;用户 Chrome 占口→**如实报告「用户资产,lasso 不会动它,请用户裁决」**;真空闲→launch-chrome。**删 `open -na` 建议**(实测逃不出单实例槽位,徒增混乱)。
- 实施面:小-中(launch-chrome 预检分支 + doctor 归因 + 测试)。

### 决议 B(激活劫持根治,P0):用户激活让位门 + headless 可选档(仓库内路线)

**B1 用户激活判定接入执守压回决策(P0 主修;2026-09-08 §4.0-F1/F2/F4 复审后重写——v1 草案的 hidAge 单判据存在归因谬误+副作用耦合过猛)**

判据从单信号升级为**三判据 AND + 确认窗**(全部仓库内可实现):

- **(a) hidSystemState 年龄 < 阈值,阈值下调 60s→10s**:hidSystemState 是系统级空闲计时器,**无 per-window/per-app 归因**——「hid 年龄小」只证明「用户在机器某处活动」,不证明「用户激活了这个 Chrome」(v1 草案「程序掀出时 hid 年龄大→照常压回」只在机器闲置时段成立)。真激活检出时 hid 年龄 ≤ tick 1.5s + 处理延迟,10s 级足够;60s 只会放大误开放窗。页面 JS 无法伪造 hidSystemState(沙箱无 CGEvent 权限,合成事件只进 combinedSessionState——Apple 文档区分),但**无需伪造:互动会话中用户在 VSCode/邮件打字即持续满足 (a),环境性输入直接通过**。原「真实激活 1.66-22s vs 程序 380-1229s 零重叠」样本结论**限定于机器闲置时段**(程序掀出样本采自用户离席时);P27 实证(desired-hide-state.ts 头注)程序掀出高发于 agent 活跃期=用户在场期,恰是 (a) 恒真期——单判据在该时段 ≈ 恒放行(含页面 window.open 弹广告窗完整通路)。
- **(b) 归因绑定:同一次 System Events 调用读 `frontmost of p`**:Dock/Spotlight/用户点击激活 → Chrome 进程 frontmost;AX `set visible` 型程序掀出(页面 JS unhide / Chrome 内部)→ 不 frontmost → 照常压回,payload 交付路径零影响。与 (a) 在同一 reassertScript 内读取(reassert 原语单一真源扩展,零额外进程往返)。
- **(c) 确认窗:放行=暂停本 tick,零账面突变**:门通过仅「本 tick 不压回」+ 打 `user_activation_pending` 日志;**连续 N tick(默认 20 ≈ 30s)满足 (a)+(b)** 才落 `userTakenAt`。窗内任一 tick 失守(失 frontmost / (a) 超阈值)→ 恢复压回、计数清零——v1.18.3 契约「任何激活源掀出的窗口至多存活一个 tick」在未确认归因期间**保持武装**(确认窗把该上限有界放宽到 30s 换取归因确认;失守即回 1 tick)。

决策语义与副作用(v1 草案三副作用耦合解耦,§4.0-F2):

- **放行(单 tick)绝不 mutate 粘滞账/台账**:不删 desired-hidden 记录、不落 userTakenAt。粘滞账唯一清账路径保持 chrome-show(既有);唯一重挂路径 = 显式 chrome-hide(既有 addDesiredHidden)——双向可逆。v1 草案「一次门通过即清粘滞账+禁 idle」= 对 v1.18.3 防闪契约的实例级永久回退(其后页面弹窗无人压),且失败路径按 v1 文案同样放行(JXA 常量漂移/TCC 瞬态即永久 disarm),均废除。
- **userTakenAt 仅在确认窗通过后落**:台账该记录标 `userTakenAt`(epoch ms);此后粘滞执守对本 pid 退位(等效 chrome-show 的让位语义,但台账留痕),idle 收割禁用,停机/exit 收割豁免(A1 第三维)——唯一关闭出口=用户自己关或显式 chrome-stop,与 visible 档红线(P1/D-5)语义对齐(hidden 档的状态迁移补全)。**显式 chrome-hide 可重武装:写粘滞账恢复执守,并同步清 userTakenAt(台账回写)**——让位/武装两态与粘滞账/台账双账一致,不留「已重武装但仍收割豁免」的混合态。
- **判据不可得(非 darwin / TCC 瞬态 / JXA 常量漂移):跳过本 tick,零账面突变**——不压回、不确认、不落账(宁失隐藏不失用户主权,与 E8「宁可不压回,绝不误伤」同向;**失败路径禁账面突变**)。
- **残余风险(诚实声明)**:(a)+(b) 仍无法区分「用户 Dock 激活」与「用户在场期间的 CDP activateTarget / 弹窗夺焦」(后者同样产生 frontmost)。确认窗 30s 把误认领成本从「瞬时永久 disarm」升为「持续 30s 夺焦存活才被认领」,且 chrome-hide 可逆重武装;此残余按用户主权方向校准,接受并记录。**🔴 对抗复审 r1(2026-09-08)追加:判据 (a) 可被任何 shell 能力程序伪造**——`osascript 'tell application "System Events" to key code 63'`(空键/合成键)实测将 ioreg HIDIdleTime 归零(0.23s),配合 `open -a` 激活(frontmost 可编程达成),(a)+(b) 在**用户完全离席**时也可全真持续满足:真机实测合成输入循环 20+ tick 后 userTakenAt 被完整落账(粘滞执守永久退位+收割全豁免)。§2.1 的「真实硬件事件只进 hidSystemState」结论限定于 **CGEventSource state 语义**(合成事件确实只进 combinedSessionState);**实现读的是 ioreg IOHIDSystem 计时器,该计时器被 System Events 合成 CGEvent 一并重置**——原 §2.1 表述对实现路径不成立,已订正。威胁面评估:shell 能力 agent 本就可直接调 chrome-show CLI 获得同等认领(显式出口,B1 门未新增特权上限);真实新增风险=**无恶意自动化工作流的自伤**(如 agent 用 lasso desktop act type 合成键入 + CDP activateTarget 在用户离席期意外走满 30s 确认窗→工具 Chrome 永久可见化+收割豁免,BUG-03 A1 要消除的「常驻放大器」借尸还魂)。缓解现状:chrome-hide 重武装可逆 + 真机已验证;进一步收紧(如认领前要求 CGEventSource hidSystemState 与 combinedSessionState 差分)留作后续决议。
- **chrome-show 对齐(§4.0-F4)**:chrome-show 成功 = 最强用户意图信号(显式操作 > 任何启发式)→ **同标 userTakenAt**(台账记录更新,复用 recordLaunch 同 port 覆盖;--pid 无台账记录则仅清粘滞账、无操作);粘滞账清账既有语义不变。B1 启发式拿到的保护待遇不得高于显式操作——v1 草案给 hidAge 启发式 userTakenAt,而 chrome-show 后实例仍按 hidden+idleMs 被 A1 新默认 30min 收割(窗口在用户面前被关),倒挂废除。
- 测试:hidAgeFn/frontmostFn DI 注入(真机 hid 年龄不可单测)+ 确认窗状态机四分支(真激活确认窗满→userTakenAt;frontmost=false 程序掀出→压回;窗内失守→复压+零 userTakenAt;判据不可得→零账面突变)+ **账面突变禁令锚**(放行/暂停/失败路径对粘滞账与台账零 mutation,账本快照断言)+ chrome-show 后 idle 不收 + 真机验证记录。
- 实施面:中(reassert 原语双判据扩展 + watchdog 确认窗状态机 + 粘滞账/台账联动解耦 + chrome-show 台账更新 + 测试 ≈8+)。

**B2 headless 可选档(P1,评估后采纳为可选、不切默认)——🔴 对抗复审 r1(2026-09-08)真机证伪其核心声明,保留为无人值守形态**
- `launch-chrome --mode headless`(复用 render 档 RENDER_DETERMINISTIC_FLAGS 的 headless 经验):零窗口/零 AX 面的纯抓取形态。**原声明「headless 实例不注册 Foreground LS session,结构性不占用户 Chrome 的 Dock 槽位」经真机证伪不成立**:仅有 headless 实例在世时 `open -a "Google Chrome"`(Dock 等价)**不会**另起新实例——激活仍被同 bundle id 单实例槽位吸收,且零窗口零可见反馈(症状②的无窗变体,比 hidden 更静默:hidden 有 B1 让位门会掀出窗口,headless 无窗可掀)。实测:Chrome 150.0.7871.182 / macOS 12.x,headless 实例 pid 在世 + open -a exit 0 + 无新进程 + AX windows=0。
- 保留价值:无人值守机器(无人会点 Dock)的纯抓取/外部 CDP 消费;拉起时打 `headless_dock_slot_caveat` 观测点(darwin)。**有人使用的机器禁用此档**,用 hidden+B1(修订后口径:README/ARCHITECTURE/§8 已同步订正)。
- hidden 档整体改 headless=**否决**(登录态/可见性工作流依赖有头形态)。
- 零基重设计视角的诚实结论:若今天重设计,被红线约束下的零基最优=「headless 为默认、hidden 为登录态特例、B1 门兜底」;因向后兼容(browse_logged_in 既有习惯+文档)与登录流依赖,采渐进路线(B1 先堵劫持 → B2 给出口 → 远期版本再议默认翻转)。

### 决议 C(症状①):出口声明化——永不代杀用户资产,禁 kill 指引进错误契约

- launch-chrome `port_in_use_non_cdp` 错误文案升级为三分类出口(机器可读 token + 人话):①换口 `--port N`;②若占用者是 lasso 台账僵尸→A2 自愈;③**若是用户原生 Chrome:明确「用户资产,lasso 任何机制不会 kill 它;正确处置=报告用户裁决或换口」**——把 agent 的下一步从「自己想办法」引到合法出口。descriptions.ts 错误 hint 同步。
- doctor next_step 同口径(A2 已含,删 `open -na`)。
- **评估否决项(记录在案)**:lasso 永不提供 kill-by-pid/kill-by-port 针对非台账资产的任何工具(红线:用户资产不可杀);chrome-stop CLI 无参=--all 的「有意全停」语义保留(用户显式操作=最高权限,仅强化输出列出将停记录)。
- 实施面:小(文案/描述层 + tripwire)。

### 决议 D(主权红线机械化):三条新不变量(顺延 INV-85/86/87,现基线 84)

- **INV-85 用户激活让位(归因绑定版,§4.0-F1/F2 修订)**:desired-hide-watchdog/reassert 路径必须存在**双判据门**——源码锚(reassert 决策同时引用 hidAge 与 frontmost 判定且先于压回;阈值与确认窗常量导出供测试)+ 单测四分支(真激活确认窗满→userTakenAt;frontmost=false 程序掀出→压回;窗内失守→复压+零 userTakenAt;判据不可得→零账面突变)+ **账面突变禁令锚**(放行/暂停/失败路径对粘滞账与台账零 mutation,账本快照断言;userTakenAt 只经「确认窗」与「chrome-show」两路径落)。v1 草案锚(「真激活→不压回+清账+标 userTakenAt」单测)只锚 hidAge 存在性、锚不住归因谬误与副作用耦合,随修作废。
- **INV-86 停机不连坐(§4.0-F3 修订)**:index.ts 停机两路径的 stopLaunchedChromes 调用必须带 owner 限定(grep/AST 锚:调用含 ownerPid 过滤谓词)+ 单测三面(他 server ownerPid 记录不被收;旧无 owner 记录不被收;**owner===self 且 userTakenAt 的记录不被收且台账条目保留**)。
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
- 实施面:A1 中 / A2 小-中 / **B1 中(三判据+确认窗+chrome-show 对齐,§4.0 复审后自小-中上调)** / B2 小 / C 小 / D 随各修复落 INV(3 条新增)/ E② 小-中 / E④ 小。全部单主题单 commit,先后序:A1(含③,台账 schema 含 userTakenAt 字段)→B1(落 userTakenAt 写路径)→A2/E①→E②→E④→B2→C/D 收口(D 的 INV 随对应修复同 commit)。

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
- 2026-09-08 否定复审(§4.0):决议 v1 四条否定发现逐条源码复核全部确认,B1 重写(三判据+确认窗)、A1 升三维过滤、INV-85/86 断言面修订、chrome-show 同标 userTakenAt

## 6. 复现(症状②机理摘要,真机已验证后清理)

前提:lasso hidden 档实例在世(同 com.google.Chrome bundle id + --no-startup-window + detached+idleMs:0)→ 用户点 Dock 的 Google Chrome → LaunchServices 单实例激活路由进该实例 → enforcer 1.5s tick 压回 → 表现「打不开」。`open -na` 另起实例同样逃不出(实测);URL 打开请求同样误路由(页面落进工具实例)。全要素实验环境已还原(见 §5)。

## 7. 关联

- doc/bugs/02(idle reaper 第二消费者盲区;本案 A1 是其 §6 建议 2「CLI 默认 0」裁决的**精化**而非推翻——0 防的是「被 server 静默杀」,新默认防的是「无退场」,touch 续命契约不变)
- src/launcher/{launch-chrome,chrome-stop,chrome-idle-reaper,desired-hide-enforcer,desired-hide-watchdog,chrome-hide,chrome-ledger,chrome-touch}.ts;src/render/{render-launcher,render-guardian}.ts(成熟模式源);src/index.ts:1331-1427(停机链);src/doctor/doctor.ts:967-1005;src/channels/BrowseChannel.ts:979-1005/1241-1258;src/browse/upstream-response.ts
- 既有红线:INV-82(P1/D-5/C2)、E8(永不按名 hide)、verifyOwnership、INV-78(浏览器静默启动与 idle 回收安全,决议 A/B 需同步其断言面)
- 外部同构:Chromium flavors 文档(同 bundle id 不可并行)/Chrome for Testing(distinct bundle id,按红线作废)/Playwright 自带 Chromium(同前)

---

## 8. 实施记录（2026-09-08 实施员落地，全部决议闭环）

### 8.1 commit 清单（单主题单 commit，不 push 不发版）

| commit | 决议 | 摘要 |
|---|---|---|
| `9633dd6` | A1（含消费方③） | 台账 ownerKind/ownerPid/userTakenAt 三字段 + stopLaunchedChromes/Sync 三维谓词（modes × owner × userTakenAt 豁免）+ index.ts 停机两路径接线 + reaper 对 userTakenAt 禁收 + 执守双职责（startEnforcerIdleReaper + 双职责自退闩）+ CLI 默认 idle 30min（CLI_LAUNCH_IDLE_DEFAULT_MS 单一真源）+ INV-86 + a1-owner-scoped-shutdown.spec 13 用例 |
| `08fffa1` | B1 | reassertChromeHiddenGatedAsync（HIDIdleTime+frontmost 双判据单 osascript 内判定且先于压回；gate_unavailable 零副作用）+ 看门狗确认窗状态机（20 tick）+ 认领退位 + markUserTakenByPid/clearUserTakenByPid（写路径唯一性）+ chrome-show 同标/chrome-hide 重武装（F4 对齐）+ INV-85 + b1-user-activation-gate.spec 17 用例 |
| `bf89348` | A2/E① + C 前半 | launch-chrome port_in_use_non_cdp 门前台账归因收尸重拉（ledger_zombie_collected）+ 三分类出口（never_kill_user_asset）+ doctor checkCdp9222 catch/!ok 两分支 classifyPortOccupierNextStep 三分类 + 删 open 另起新实例建议 + a2-zombie-selfheal.spec 8 用例 |
| `2a1ceba` | E② | doScreenshot 双路径（filePath 直写优先 + image-block 回退；两路径同 stat+PNG magic 终验）+ BrowseOptions.screenshot.filePath/schema 透传 + INV-76(c) 修订（禁传→必传+双路径同校验）+ e2-screenshot-dual-path.spec 7 用例 |
| `8973b2a` | E④ | evaluateFunctionArg 双形态（函数表达式透传/语句体包裹，判定方向保守）+ evalFence 惰性组+负向前瞻锚定最后围栏（值内 ``` 不截断）+ session_rotated 归类（isError 与 P5 文本本体两路径）+ e4-evaluate-dual-form.spec 10 用例 |
| `310e04c` | B2 | --mode headless 可选档（--headless=new；零 AX 面；台账第四值；chrome-stop --modes 值域扩；config 层不扩）+ enforcer 收割域扩日常档两形态 + b2-headless-mode.spec 7 用例 |
| `e28bada` | C/D 收口 | descriptions.ts 出口指引 + idle 段落新口径 + chrome-stop 结果行携带 launchMode + INV-87（never-kill-user-assets：token 双面 + doctor open 形态 grep 禁令 + 僵尸自愈只经验证杀路径） |
| docs commit | 本节 | 本实施记录 + README.md/README.en.md 受影响节 + ARCHITECTURE.md §3.6 |

门禁：每 commit `npm run build && npx vitest run && npm run check-invariants` 全绿（终态 163 files / 2658+ tests / 87 invariants，基线 84→87）。

### 8.2 真机验证记录（2026-09-08，隔离端口 9399，实验后全清）

- **A1 归属与双职责**：`launch-chrome --port 9399 --idle-ms 120000` → 台账落 `ownerKind:"cli", ownerPid:<CLI pid>`；粘滞账落 pid；hide-enforcer 执守进程在世（pidfile + ps 确认）。
- **B1 门原语**：生产 dist `reassertChromeHiddenGatedAsync(pid)` 真机返回 `{ok:true, wasVisible:false}`（"already" 信号——hidSystemState 读取（ioreg HIDIdleTime，实测 hid_ms=5696922）→ System Events AX 枚举 → pid 匹配 → visible=false → 不压回，全脚本链路真机贯通；pending 分支需真用户激活，判定逻辑经 DI 单测四分支钉死 + 脚本顺序锚 INV-85）。
- **A2 僵尸自愈**：`kill -STOP <chrome pid>` 模拟 CDP 死进程活（curl 超时 exit 28 + TCP connectable）→ 重跑 launch-chrome → `ledger_zombie_collected` 事件 → chrome-stop 验证路径收割（SIGSTOP 进程经 2s 优雅窗升级 SIGKILL 树杀，日志实证）→ fresh spawn ok:true（新 pid）。
- **C 输出强化**：chrome-stop 结果行携带 `launchMode`。
- **清理证据**：`chrome-stop --port 9399` → 台账 9399 记录清、粘滞账 9399 清、`pgrep -f "chrome.*9399"` 空；执守双职责自退（粘滞账 2 tick + reaper 2 tick 后 process.exit，进程复核 0 行）；陈旧 pidfile 已删；临时脚本全删；`node scripts/check-readme-sync.mjs` 全绿。

### 8.3 消费方（cc-control）4 条修复实况与回写答复要点

| # | 修复 commit | 回写口径（对 cc-control 台账） |
|---|---|---|
| ③ 连坐死 | `9633dd6`（A1） | 已根治：任何 lasso server 退出只收自己拉起的 Chrome（ownerPid 过滤 + 旧无 owner 记录归「无人」永不连坐）。过渡期长会话外部消费仍建议显式 `--idle-ms 0`；**修后口径：touch 续命即可**（默认 30min，`touch ~/.cache/lasso/chrome-touch-<port>` 即「在用」；执守进程负责收割，server 不在也活着） |
| ① 僵尸占位 | `bf89348`（A2/E①） | 已根治：`port_in_use_non_cdp` 时 launch-chrome 自动归因——自家挂死实例自动收尸重拉（机器可读事件 `ledger_zombie_collected`）；doctor 三分类（自家僵尸→`chrome-stop --port N` 清后重拉；陈留→清账；用户资产→如实报告永不动）。过渡期手动 `chrome-stop --port N` 清僵尸后重拉仍有效 |
| ② screenshot | `2a1ceba`（E②） | 已根治：doScreenshot 双路径——优先传 filePath（上游 1.7.0 直写盘，≥2MB 截图不再依赖 image block）；上游忽略时回退 base64 解码落盘（两路径同 PNG magic 校验）。会话内截图通路：`options.screenshot.filePath` 可指定输出路径。过渡期顶层 screenshot 工具/缩小截图面不再必要 |
| ④ evaluate | `8973b2a`（E④） | 已根治：js 入参双形态兼容——函数表达式（`() => document.title`）原样透传（不再恒 undefined 静默错值）；语句体（`return ...`）维持包裹；工具描述双例已同步。围栏解析修值内 ``` 截断；会话轮换错误透明化为 `session_rotated:`（可重试 + 提示重 snapshot），不再落泛 unknown 文案 |

### 8.4 教训（新增，区别于既有档案）

1. **「防误杀」与「用完即关」是两个正交面**：bug02 把 CLI 默认 idle 归 0 防住了「被 server 静默杀」，却拆掉了「无消费者退场」——8.5h 级常驻把激活劫持的可达性放大到事故级。生命周期能力必须成对设计（谁杀 + 何时死），单面修补会把风险转移到另一面。
2. **错误出口是安全边界的一部分**：症状①的直接责任在 agent 裸 kill，但架构共担是「端口被用户资产占用」这个一等场景没有一等出口——错误面只说「换口」，agent 就会用 shell 填补你没提供的决策。`never_kill_user_asset` 进错误契约（INV-87 token 锚）后，合法下一步变成机器可读。
3. **同 bundle id 单实例是 macOS 平台级契约，绕不开只能让位或退出有头形态**：外部调研的 distinct-bundle-id 路线（Chrome for Testing 式）被用户红线作废后，仓库内解 = 让位门（B1，用户激活检测）+ 结构性豁免（B2 headless）+ 退场默认（A1）三层叠加——每层单独都不足以根治。
4. **单信号归因在互动环境中恒失效**（§4.0-F1）：hidSystemState 无 per-app 归因，「hid 年龄小」在用户在场时段恒真——判定必须 AND 归因绑定信号（frontmost）+ 确认窗（时间维），并诚实声明残余（CDP activateTarget 类夺焦在用户在场期仍可被误认领，按用户主权方向校准接受）。
5. **账面突变与判定解耦**（§4.0-F2）：让位/暂停/失败路径对粘滞账与台账零 mutation 是防「一次误判永久 disarm」的结构保证——v1 草案的清账方案在 TCC 瞬态时会把执守永久缴械，账本快照断言（INV-85）钉死这类回潮。

---

## 9. 对抗否定复审记录（2026-09-08 adversarial r1，复审员第 1 轮）

**方法**：变异验证 7 发（改坏接线→测试/INV 红→还原→md5 核对）+ 用户主权真机攻击（隔离 env 四覆盖 `/tmp/adv-bug03-r1`，用户全程离席 HIDIdleTime 1400s+，零接触用户 Chrome）+ 消费方 4 条真机重跑 + 文档零漂移 + 项目外零新组件 find 复核。

### 9.1 变异验证：7 发 6 杀 1 存活（存活项当场补锚）

| # | 变异 | 结果 |
|---|---|---|
| M1 | reassertGatedScript 删 `fm is true and`（AND→单判据，§4.0-F1 归因谬误回潮） | **🔴 存活**——b1 spec 17/17 绿 + INV-85 绿（两 token 顺序锚锚不住合取语义）；当场补锚：b1 spec 2a 增 `if fm is true and hidMs < N then` 整串断言 + INV-85 同锚；补锚后复测 M1 双红 ✓ |
| M2 | 确认窗 `n >= 20` → `n >= 1`（瞬时认领） | 杀（b1 spec 3 red） |
| M3 | index.ts 停机两路径删 ownerPid/exemptUserTaken | 杀（INV-86 FAIL + a1 spec 1 red） |
| M4 | reaper 删 userTakenAt continue | 杀（INV-86 FAIL） |
| M5 | A2 僵尸门删 verifyOwnership | 杀（a2 spec 1 red） |
| M6 | E④ evaluate 双形态判定禁用（恒包裹） | 杀（e4 spec 2 red） |
| M7 | E② screenshot 删 filePath 上传参 | 杀（INV-76 FAIL + e2 spec red） |

### 9.2 真机攻击裁定

- **劫持场景-修复对照（PASS）**：hidden 档 + `open -a`（用户离席 hid 1479s）→ 掀出至多 1 tick 压回（0.2s 可见→0.4s 已压回）；程序掀出（AX set visible）0.88s 压回——v1.18.3 契约保持。
- **🔴 判据 (a) 可伪造（确认为验收员同源发现，实证补全）**：`osascript key code 63` 实测将 ioreg HIDIdleTime 归零；合成输入循环 + open -a 真机走满确认窗，**userTakenAt 被完整落账**（台账实证）——用户零参与下程序获得用户级认领（执守退位+收割豁免）。特权上限未变（chrome-show 显式出口本就等权），新增真实风险=无恶意自动化自伤（desktop act type 合成键 + CDP activate 意外走满 30s）。处置：文档诚实化（§2.1/§4 B1 残余风险订正）+ 收紧方案留后续决议；chrome-hide 重武装真机验证 ✓（清 userTakenAt+复压回）。
- **🔴 B2 headless 核心声明真机证伪**：仅有 headless 实例在世时 `open -a "Google Chrome"` 不另起新实例——激活被吸收、零可见反馈（AX windows=0、无新进程）。症状②以无窗变体复存。处置：headless_dock_slot_caveat 观测点（darwin 拉起即打，b2 spec 2d 钉死）+ README 双语/ARCHITECTURE/§4 B2/源码注释全量订正为「无人值守专用」。
- **chrome-show 同标 userTakenAt（F4）真机 ✓**；**chrome-hide 重武装真机 ✓**。
- **消费方③连坐免疫真机 ✓**：CLI-owned（ownerPid=死 CLI）+ 无 userTakenAt 记录，独立 server stdin_eof 停机收割链真跑——Chrome 存活。
- **消费方①僵尸自愈真机 ✓**：SIGSTOP（CDP 超时 exit 28 + TCP 可连）→ `ledger_zombie_collected` → 2s 优雅窗升级 SIGKILL 树杀 → fresh spawn ok（新 pid）。
- **🔴 消费方②screenshot 真机 FAIL（当场修复）**：上游 1.7.0 filePath 带工作区根校验（McpContext.validatePath），lasso 未协商 roots/未配 `--allow-unrestricted-paths` → **任何路径（含 /tmp 管理路径）被拒**，原实现 isError 即抛、image-block 回退永不执行 → screenshot action 真机 100% 失败（比修复前更糟）。修复：Access denied → 不带 filePath 重试一次（路径 2）+ ≥2MB 上游临时文件文本行（`Saved screenshot to <path>`）读取物化到 target；e2 spec 补 3 用例（8/9/10），10/10 绿；真机复测 screenshot worked（file 落盘 PNG magic ✓）。
- **消费方④evaluate 真机 ✓**：函数表达式 `() => 'fnexpr-' + (typeof 41)` → `fnexpr-number`（非恒 undefined）；语句体 `return 6*7` → 42；值内 ``` 围栏不截断（`a\`\`\`b\`\`\`c TAIL`）。
- **find 复核 ✓ 零新组件**：/Applications 与 ~/Applications 无 Chrome 副本/LassoE4/Chromium/Canary；launchctl 无 lasso 项；Downloads 的 chrome 相关文件均为 2026-07 以前旧物。

### 9.3 r1 处置清单（commit 化）

1. fix(channels): E② Access-denied 降级重试 + ≥2MB 上游临时文件物化 + e2 spec 3 用例（P0）
2. test(b1)/invariants: 双判据 AND 合取锚（M1 存活补锚，P1）
3. fix(launcher): headless_dock_slot_caveat 观测点 + b2 spec 2d（P1）
4. docs(bugs/README/ARCHITECTURE): B2 证伪订正 + B1 判据 (a) 伪造残余 + §2.1 CGEventSource 语义澄清（P1）
