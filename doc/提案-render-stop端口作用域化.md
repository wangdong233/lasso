# 提案:render-chrome --stop 端口作用域化(已裁决 2026-09-02——见 §6 实施决议)

> 2026-09-02 生成。纪律:重能力增强只出文档不实施——本提案只给语义/草图/回滚面,
> 用户点头才动代码。配套现状钉死测试:test/unit/render-chrome.spec.ts
> 「stop 收台账内全部 render 记录(跨 port)」tripwire(变更本语义必须先过本提案裁决)。
> **2026-09-02 裁决落款:主提案定案实施 + 非法 env 分支收紧 + doctor 附带裁决点定案,
> 见 §6(设计合成轮,输入=白盒基线核查全实证 + 外部 OSS 调研)。**
> **2026-09-02 修订轮(否定发现复核):3 条发现逐条白盒实证全部成立、零误报——
> §6.1 补 scope 同谓词硬约束+等价语料 tripwire(发现一);§6.2 E 案由留档 P2 升级为
> 随 commit ② 与 D 叠加实施(发现三);§6.4/§6.5 补 render-tier-acceptance.mjs
> env 泄漏 fail-fast 守卫(发现二)。各节以「修订轮」标记,证据 file:line 内嵌。**

## 1. 问题

CLI 内部**作用域不对称**:

- `--ensure` / `--status` 认 `LASSO_RENDER_PORT`(render-flags.ts `renderCdpPort()`),
  只作用于该端口;
- `--stop` **不认**该 env——按设计决议 3.7「收全部 render 记录(任意 port)」,
  render-chrome.ts runStop 调 `stopLaunchedChromes({modes:["render"]})` 不传 port。

后果:设了 `LASSO_RENDER_PORT=9234` 的用户合理期待 `--stop` 只收自己的实例,实际杀掉
**全机**渲染档(含其它 agent 在用实例)——这是「同机多 agent 并行验收互杀」的第一入口。
业界对照:Playwright/Puppeteer/Docker 的 kill 全部按 handle/session/container 作用域化,
killall 型只作显式管理员逃生口;lasso 的 `--stop` 在用户已表达端口命名空间的前提下
仍默认 killall,属设计债而非用户误用。

## 2. 提案语义(向后兼容)

`render-chrome --stop`:

- `LASSO_RENDER_PORT` **显式设置** → 只收该 port 的 render 记录(与 ensure/status 对称);
- **未设置** → 维持现状「收全部 render 记录」(设计决议 3.7 语义不变,单用户全收场景零影响);
- 全局收口仍可用:`chrome-stop --modes render`(或临时 unset env)。

## 3. 实施草图(约 10 行 + 2 个 spec 用例)

engine 与 CLI 旗标支持**均已存在**,只差接线:

1. `src/render/render-flags.ts`:新增 `renderCdpPortExplicit(): number | undefined`
   (env 显式设置且合法 → 该值;否则 undefined。现 `renderCdpPort()` 无法区分
   「未设」与「非法降级默认」,需新函数而非改旧函数)。
2. `src/render/render-chrome.ts` runStop:
   ```ts
   const port = renderCdpPortExplicit();
   const result = await stopLaunchedChromes({
     ...(port !== undefined ? { port } : {}),       // 显式设置才限定;未设=全收(3.7 不变)
     modes: ["render"],
     logFn: cliLog as LedgerLogFn,
   });
   ```
   (`stopLaunchedChromes` 的 `opts.port` 过滤在 chrome-stop.ts:199-201 早已实现;
   `chrome-stop` CLI 的 `--port N` 旗标同理已存在——本提案零 engine 改动。)
3. spec:改 tripwire 用例为「显式 port env → 只收该 port;未设 → 跨 port 全收(3.7)」。
4. 文档同步:README 渲染档节(双语)、本文标记已裁决、并行验收隔离配方 §4 更新。

## 4. 风险与回滚

- 风险:已有脚本「设了 port env 却期待 --stop 全收」会被改变行为。缓解:全局收口
  仍有 `chrome-stop --modes render`;changelog 显著位写 breaking-change 说明。
- 回滚:还原 runStop 两行 + spec;零数据/存储迁移。

## 5. 附带裁决点(更重,独立评估)

`render-chrome doctor --clean` 跨命名空间孤儿误判(指纹对 + 本台账缺位 + >10min →
杀其它命名空间在用实例)。选项:doctor 增加 `--namespace` 显式声明 / 孤儿判定加
「指纹对且所有已知台账均缺位」聚合(需枚举台账目录,引入目录布局契约)。短期靠纪律
(并行期间禁 doctor --clean,见隔离配方 §3),长期随本提案一并裁决。

---

## 6. 实施决议(2026-09-02 设计合成轮落款)

> 输入:白盒基线核查(提案 §1-§4 全部现状声称实证成立:renderCdpPort() 不分未设/非法、
> runStop 全收、stopLaunchedChromes opts.port 过滤在位、tripwire 在位;三个 render spec
> 在 HEAD 32/32 绿)+ 外部调研(OSS 惯例:kubectl #1272 同形事故——用户设了 `-n` 仍被
> `--all` 全删,"broke my cluster beyond repair";「具名作用域默认 + killall 显式」是
> Docker/kubectl/tmux/Playwright 普适惯例)。本节为裁决记录,实施按 §6.5。

### 6.1 主提案定案:按草案实施 + 一处收紧(非法 env 分支)

**三态语义表**(`render-chrome --stop` 对 `LASSO_RENDER_PORT`):

| env 状态 | --stop 行为 |
|---|---|
| 未设 / 空串 | **全收**(台账内全部 render 记录,跨 port——设计决议 3.7 语义不变,单用户维护窗零影响) |
| 显式且合法 | **只收该 port** 的 render 记录(与 ensure/status 对称) |
| 显式但非法/越界 | **exit 1 用法错**(stderr 单行 JSON 注明 env 名+原值),不猜作用域、不动台账 |

- 草案 §3.1「env 显式设置**且合法** → 该值;**否则** undefined」把「未设」与「非法」
  两态合并进同一「否则」分支——这是基线指出的未裁决语义分支。本决议拆开:**非法 =
  硬错**,不并入「未设→全收」。理由:(a) 「用户已表达作用域,因值写错被静默按全局
  删除」正是 kubectl #1272 的事故形态(外部调研实证的缺陷类别:作用域旗标被静默忽略 +
  广谱删除),非法 env 静默全收是该类别在 lasso 的翻版,而 exit 1 已在 3.6 退出码全集
  (「1 用法错」)内,零新增退出码;(b) 对脚本可检测可修复,静默全收是对 typo 的最坏
  解释;(c) 降级到默认口 9224 更不可取(那会杀共享生产实例)。
- **消费方零影响**(实证):media-gen attach 路径只做幂等 ensure + touch 续命 +
  disconnect 非 close,从不调 --stop(对接实施说明 §一/隔离配方档头);非法 env 硬错
  仅影响手工误配场景。
- 落点(全部基线已核,零 engine 改动):
  1. `src/render/render-flags.ts`:新增 scope 解析导出(建议 `renderCdpPortScope()`
     判别联合:`unset | {explicit, port} | {explicit, invalid, raw}`)。**不改
     `renderCdpPort()`**——ensure/status 的「非法降级默认」语义与 render-flags.spec:122
     既有用例保持;同目录相对 import,INV-64 兼容。
     **同谓词硬约束(修订轮补钉)**:scope 解析必须与 `renderCdpPort()` 共享**同一
     接受集**,禁独立实现更严/更宽谓词——推荐把 render-flags.ts:107-111 判定体提取
     为私有共享 helper,两函数同源调用(raw undefined 或 `trim()===""` → unset;
     否则 `parseInt(raw,10)` + `Number.isInteger` + `0<n≤65535`。即 "+9224"/
     " 9224"/"09224"/"9224.5"/"9224 " 均为 explicit:**9224**——parseInt 语义非
     Number/正则语义,真机 node 语料实证)。裂脑机理(实证):消费方 media-gen-mcp
     browser-pool.ts `runEnsure` 的 `execFileAsync` **不传 env → process.env 全量
     继承**,shell 泄漏的奇形合法值同一字符串同时到达 ensure 与 stop——谓词分叉
     即产生「ensure 在 9224 运行 / stop exit 1 拒收」裂脑态(ensure 走 renderCdpPort
     的宽松 parseInt,stop 走独立严谓词)。
  2. `src/render/render-chrome.ts` runStop:按草案 §3.2 草图接线(scope 解析上移到
     CLI stop 分支以便取 exitFn;`stopLaunchedChromes` opts.port 过滤 chrome-stop.ts:199-201
     已在)。`RENDER_CHROME_USAGE` 的 --stop 行补一句 env 语义。
- tripwire 改写(test/unit/render-chrome.spec.ts:314-333,单用例拆三):
  ①未设 env → 跨 port 全收(**3.7 分支钉死保留**,注释改「未设分支钉死」);②env=9224
  显式 → 只收 9224、9324 记录留存台账;③env 非法 → exit 1 + 台账零改动。另加
  render-flags 侧 scope 函数 spec(未设/空串/合法/非法四态)+ **同谓词等价 tripwire
  (修订轮)**:语料 `{"+9224"," 9224","09224","9224.5","0x2406","65536","-1",
  "not-a-port","9224 ","\t"}` 逐值断言
  `renderCdpPort() === (scope 为显式合法 ? scope.port : RENDER_CDP_PORT_DEFAULT)`
  ——单一不变量钉死两函数接受集永不分叉(该语料已对本仓 render-flags.ts:106-112
  谓词真机 node 实证:前五值 → 9224,其余 → 默认)。

### 6.2 附带裁决点定案:doctor --clean 端口作用域化(与主提案同一原则、同一 env)

**定案:doctor 孤儿判定随 `LASSO_RENDER_PORT` 作用域化**——显式合法 → 只判该 port 的
候选;未设 → 现状全扫(单用户维护窗不变);非法 → exit 1(stop 同规,CLI 层硬错,
`renderDoctor` 本体「恒不 throw」保持——它收已解析的 scopePort)。**修订轮:另叠
E 案 touch 新鲜度豁免(在用实例不判孤儿,与 D 同 commit ②,详见表 E 行与落地项)。**

机理与实施面(~8 行 + spec):

- 候选 port 从其命令行 `--remote-debugging-port=(\d+)` 提取(镜像既有
  `extractUserDataDir`;render-launcher 每实例必带该旗标,per-instance 项之一);
- scope 生效时:候选 port ≠ scope 或不可提取 → 不判孤儿不计 clean,入报告**新增**
  `outOfScope` 字段(pid+port 列表;既有字段零改动,只追加)——诚实降级:作用域
  doctor 报零孤儿 ≠ 全机干净,报告型 CLI 不得让用户误读;
- **E 落地(修订轮,与 D 同 commit ②)**:孤儿判定在指纹对+台账缺位+年龄线全过后加
  第四重豁免——候选 port(与 D 同一提取正则;不可提取 → 按 outOfScope 保守不杀,
  reason `portUnknown`)的 `chromeTouchMtimeSync(候选port)` 距今 ≤
  `RENDER_ORPHAN_MIN_AGE_SEC`(600s,固定线——刻意不取 per-instance idleMs,doctor
  是维护窗工具;数值与 reaper 默认包络 600s 一致)→ 不判孤儿、不计 clean,入报告
  `outOfScope`(reason `touchFresh`,与 scope 不匹配的 `portMismatch` 区分——
  `outOfScope` 为本决议新字段,出生即带 reason:`portMismatch|touchFresh|portUnknown`,
  字段注释须写明语义 =「被豁免不判孤儿的候选清单」,既有字段零改动)。touch 文件
  缺失/读失败 → 不豁免,维持孤儿判定(无续命证据 = 与 reaper 同向,安全侧)。DI
  注入面:`RenderDoctorOptions` 增 `touchStatFn?: (port:number)=>number|undefined`
  (默认 `chromeTouchMtimeSync`,镜像 chrome-idle-reaper.ts:181 的 touchStatFn 注入
  模式;src/launcher 同仓相对 import,INV-64 合规)。
  覆盖面:默认口撞车误杀(未设 env 全局 doctor 撞正在渲染的生产 9224)、分账下他人
  **正在渲染**的实例。**纪律不因此降级**:配方 §3「未设 env 的全局 doctor 并行期间
  仍禁」保持——touch 只保护心跳在写的实例,两次渲染间隙 touch 可陈旧而实例仍被想用,
  该场景仍靠三 env/纪律(与 reaper 的 by-design 可收割包络同界,E 不越界保护);
- 陈年 profile 扫描**不动**:它按台账引用集 + 24h mtime 判,活实例 profile 被 Chrome
  持续写入、mtime 恒新,天然免疫跨命名空间误删(RENDER_STALE_PROFILE_MS 语义实证)。

**五案对比与裁决理由**(E 于修订轮升级):

| 方案 | 裁决 | 理由 |
|---|---|---|
| A. `doctor --namespace` 显式旗标(提案 §5 选项) | 拒 | 命名空间声明通道已有(三 env 配方);再加旗标 = 双通道携带同一信息,必然产生「设了 env 忘了旗标」的 kubectl #1272 形态;外部调研结论(具名作用域从既有声明派生、批量清场才显式)反对平添旗标;解析面无谓增长 |
| B. 跨台账聚合「指纹对且所有已知台账均缺位」(提案 §5 选项) | 拒(留档) | 需枚举台账目录 → 目录布局契约(`LASSO_LAUNCHED_CHROMES_PATH` 任意路径、无注册表),为边缘场景引入跨文件契约违反最小面;作用域化后并行场景已不需要。真实跨命名空间孤儿清扫需求出现时随 R7 一并设计(与 3.7 renderSessions 延后同款句式) |
| C. 已知 render 端口集豁免(默认 9224+env 显式值+本台账 render port ∈ 集则不判孤儿) | 拒 | **不解决本案**:并行误杀场景中,被误判实例在**他人端口**(如 9235),不在我可枚举的任何集合里——豁免集不含他人口,误判照旧;它只防「默认口被误判」一个子集 |
| D. 端口作用域化(本定案) | **采纳** | 与主提案同一原则/同一 env/同一 scope 函数,一次裁决两处对称落地;并行场景(配方 §2 三 env 必配)全覆盖;零新契约、零新可观测源 |
| E. touch 新鲜度豁免(候选 port 的 `~/.cache/lasso/chrome-touch-<port>` mtime ≤10min → 有消费者续命,不判孤儿) | **采纳(修订轮升级:随 commit ② 与 D 叠加实施)** | 原留档理由「须先核实 touch 写入节奏(长渲染 >10min 分布)」已被既有契约+依赖面回答:①心跳契约已定案(对接说明 §一.2:**渲染会话存续期每 ≤60s heartbeat**、单会话可超 10min——长渲染恰是心跳覆盖场景,活实例 touch 恒 ≤60s 新鲜,600s 豁免线 10× 裕量);②idle reaper 已把 touch mtime 当活性真源(设计决议 3.3 三源取 max;chrome-idle-reaper.ts:181 `chromeTouchMtimeSync` 注入)——doctor 信任同一信号 = 与 reaper 收割包络同源对齐,零新增观测面、零新风险包络(心跳若坏 reaper 先坏,非 doctor 新债);③原语现成(chrome-touch.ts:70;render-chrome.ts:136 已在用)。性质 = 「不删在用物」(docker prune 不删 in-use 同款);touch 跨命名空间按 port 键控(bug02 契约),连未设 env 的全局 doctor 也受益——**D 只保护显式设 env 场景,E 补齐未设 env 的在用保护**;E 只增豁免不扩大击杀(失效方向 = 少杀,安全向) |

配方 §3 纪律随动:「禁止 doctor --clean」改为「并行期间 doctor --clean 须三 env 配齐
(作用域随 `LASSO_RENDER_PORT` 生效);未设 env 的全局 doctor 在并行期间仍禁」。
配方 §1 行「只设 LASSO_RENDER_PORT 不构成隔离」同步改写:本决议后单设 port env 即对
render-chrome 四命令(ensure/status/stop/doctor)构成端口作用域,但 `chrome-stop --all`
与共享台账 idle reaper 仍需台账/执守 env 才隔离——三 env 配齐的必要性不降级。

### 6.3 changelog 口径(breaking-change 说明位)

本仓无 CHANGELOG.md(2026-09-02 核:根目录无此文件;发布惯例 = `chore(vX.Y.Z)` bump
commit + README 双语同步)。breaking 说明位定三处:

1. 发布 commit `chore(v1.20.0)` message 正文首段 ⚠ 行为变更块,口径:
   「**行为变更**:`render-chrome --stop` 与 `doctor [--clean]` 现认显式
   `LASSO_RENDER_PORT`——显式合法值时由『作用全部 render 记录』改为『只作用该 port』;
   全收出口不变(`chrome-stop --modes render` 或 unset env);显式**非法**值由原先的
   静默全局改为 exit 1。未设 env 行为零变化。」
2. README.md 渲染档段 / README.en.md 同步段:--stop、doctor 句各补
   「认 `LASSO_RENDER_PORT`(显式设 port 只作用该 port;未设=全部;非法值 exit 1)」
   ——用户向用法信息,合 README user-first 口径。
3. doc/渲染档设计决议.md §3.7 追加日期修订行(不改写原文):
   「2026-09-02 修订(提案 §6 决议):--stop/--doctor 认显式 LASSO_RENDER_PORT;
   未设时本条『收全部 render 记录』语义不变。」

版本:1.19.0 → 1.20.0(行为变更进 minor,pre-2.0 惯例)。

### 6.4 文档同步清单(实施轮逐项打勾)

1. README.md 渲染档段(双语中文侧)
2. README.en.md 渲染档段(英文侧)
3. doc/渲染档-并行验收隔离配方.md:§1 表行 1 与「只设 LASSO_RENDER_PORT 不构成隔离」
   段、§1 第四面 doctor 互杀面、§3 两条纪律、§4「已知不对称」节(标记已裁决落地)
4. doc/渲染档设计决议.md §3.7 日期修订行
5. 本提案标题与档头(已随本决议更新;修订轮落款同步)
6. (代码内)`RENDER_CHROME_USAGE` --stop/doctor 行 env 语义一句
7. (修订轮)test/render-tier-acceptance.mjs:启动 fail-fast 守卫——`LASSO_RENDER_PORT`
   / `LASSO_LAUNCHED_CHROMES_PATH` / `LASSO_RENDER_GUARDIAN_PID_PATH` 任一在调用
   shell 已设非空 → 一句话报错退出,文案指向车道 A 串行纪律(暴露面注记见 §6.5)
8. (修订轮)doc/渲染档-并行验收隔离配方.md §3 例外条款补一行:调用 shell 泄漏
   `LASSO_RENDER_PORT`(尤其 =9224)会被新语义把该脚本的全局清场静默收窄为 port
   限定(item 0.2 假红 + 收尾漏杀);脚本已配 fail-fast 守卫(第 7 项)

### 6.5 实施、验收与回滚

- **commit 划分(单主题单 commit,两个 commit)**:①主提案(stop 作用域化 + scope 函数
  (§6.1 同谓词约束)+ tripwire 三态 + 等价语料 tripwire + render-tier-acceptance.mjs
  启动 fail-fast 守卫 + 文档同步);②doctor 作用域化 + E touch 豁免(独立 seam——
  renderDoctor opts 注入含 `touchStatFn`,独立 spec:scope 内孤儿仍判 / 他人 port 入
  outOfScope(portMismatch)不动 / 非法 env exit 1 / **touch 新鲜活实例豁免(touchFresh
  不杀,含未设 env 场景)/ touch 缺席不豁免(孤儿判定维持)**;既有「真身 Chrome
  零误伤」测试保持绿)。两 commit 独立 revert:提案 §4 回滚故事(「还原 runStop
  两行 + spec」)不因 doctor 并入而膨胀。
- **render-tier-acceptance.mjs 守卫暴露面注记(修订轮)**:该脚本是车道 A 真机验收
  资产,不在三门禁内;其 runCli `env:{...process.env,...env}`(行 90)继承调用
  shell,四处全局清场 stop(行 216 item0 step0 / 315 item3.0 / 479 cleanup /
  649 item5 收尾)按全局语义断言。本提案后泄漏 `LASSO_RENDER_PORT=9224` 会使清场
  静默降级为 port 限定:item 0.2「指纹归零」假红(异 port 残留不再被收)+ 收尾漏杀
  (违反真机清理纪律);非法泄漏 → stop exit 1 → item 0.1 假红。守卫 = 启动即断言
  三 env 未设/空,把静默降级/假红转为一句话硬错;测试配档 = 守卫随脚本每次运行自动
  执行(真机资产的自检即其自动化),不入 vitest(与脚本体其余部分一致)。三 env 中
  后两个(分账/执守路径 vs 脚本硬编码全局台账/guardian pidfile)是**提案前的既有
  泄漏暴露面**,一并纳入同一 fail-fast(一个断言块,零额外面)。
- **门禁**:每 commit `npm run build && npm test && npm run check-invariants` 全绿。
- **真机验收**:实施完成后按隔离配方 §5 自检两命令真机跑一轮(两 agent 互异端口互杀
  复现用例:stop 只收自己 / doctor 不判他人口),Chrome 用后清理(纪律)。
- 风险重申(提案 §4):已有脚本「设了 port env 却期待 --stop 全收」行为改变——全局
  收口 `chrome-stop --modes render` 不变,changelog 三处显著位说明。
