# 登记问题:timing 假红 / 独立脚本退出契约 / R7 通用化 need-later

> 登记日:2026-09-03 · 性质:**登记级(只记录不修)**——本轮 media-gen-mcp 0.18.0 批量清理轮
> (HEAD 66a6f80)G 审查中浮出的三项,均非 lasso 当前默认路径的阻塞缺陷,按纪律登记留档。
> 关联仓:lasso(本仓)+ media-gen-mcp(`/Users/wangdong/Documents/Project/claude技能/media-gen-mcp`)。
> 关联文档:《渲染档设计决议.md》《需求-渲染档浏览器治理.md》(R1-R7)《对接实施说明-渲染档x-media-gen-mcp.md》
> 《渲染档-并行验收隔离配方.md》;消费方侧《渲染档共享实例-R5裁决与长期运行手册.md》。

---

## #8 timing-sensitive 测试高载假红

### 现象

本轮 G 审查跑 lasso 测试时,`doctor-deep-probe.spec.ts` 出现假红:该 spec **已经在**
`vitest.workspace.ts` 的 timing-sensitive 桶(SLOW_SPECS,testTimeout/hookTimeout 各 15s),
机器高载下单测执行仍超 15s 预算被 vitest 判红。即 v1.8 F-T1 那轮"移桶放宽到 15s"的治理
(轮换)在更高负载下**再次不够用**——红是环境性的,不是代码错了。

### 证据

- `vitest.workspace.ts`(本仓根):SLOW_SPECS 清单第 2 行即 `test/unit/doctor-deep-probe.spec.ts`,
  timing-sensitive project 设 `testTimeout: 15_000, hookTimeout: 15_000`;文件头注释自述治理背景:
  "时序敏感 spec(真实 spawn 子进程 / doctor 冷启动 / expect 轮询窗口)在机器高负载
  (Docker VM / CC 会话并发)下偶发超 vitest 默认 5s testTimeout → flaky 红"。
- 同款环境依赖非确定性的直接先例(注释在案):`test/unit/proxy-egress.spec.ts` 曾
  "全量并发下 5169ms 超 5s 默认 testTimeout、单文件 1648ms 通过(round2-arch 两次全量 +
  两次单跑实测)"——同一份代码,红/绿取决于旁边在跑什么,即假红的定义。
- 本轮 G 审查在多 agent 并行(主链 2 并发 + Docker VM)负载下,doctor-deep-probe 超 15s
  预算失败,复现同一模式(预算值变大,机制不变)。
- 该 spec 本身是 `vi.stubGlobal("fetch")` 纯 mock(30 测,零真网)——连 mock 测试都能被
  饿到超时,证明瓶颈是调度/CPU 饥荒而非被测代码慢。

### 根因(假设)

**机器高载下超时预算不足,非确定性**——测试时长是负载的函数,固定预算(5s→15s)只是把
假红阈值推高,没有消除"正确性依赖环境"这一结构性问题。并行 agent 全量跑测 / Docker VM /
CI runner 饱和都会让 wall-clock 预算失真。非 lasso 代码缺陷。

### 建议修法(届时有轮次承接时,从既有抽象出发)

SLOW_SPECS 桶已是单源清单,治理只需作用在该桶上,不逐文件打补丁。三选一(可组合):

1. **预算再放宽倍数**:timing-sensitive project 的 testTimeout 15s→30s(或对 spawn 真
   子进程的 spec 分级)。最小改动,但只是继续推阈值——proxy-egress 先例说明任何固定值
   都可能再被更高的负载击穿。
2. **vitest retry 标记(推荐主选)**:timing-sensitive project 加 `retry: 1`(或 2),
   **只挂该桶**——default 桶保持零 retry,保住 v1.8 治理的既定意图("其余文件保持默认
   5s,不掩盖真正的死挂")。retry 对环境性偶发红是对症语义:同一测二次通过 = 标记为
   flaky 而非绿,诚实性不降级。
3. **高载检出/降载**:全量跑测限制自身并发(`poolOptions` / `maxConcurrency`),或 CI 上
   检出 load 阈值后显式 skip timing 桶(标注 skipped,不冒充红/绿)。治本是降载,但
   排程权不完全在测试侧。

推荐组合:方案 2 为主(桶级单点、语义对症)+ 方案 1 兜底(15s→30s 一并提);禁止逐
spec 散点 `test.setTimeout` 补丁(违反单源纪律)。

### 复核命令

```bash
cd /Users/wangdong/Documents/Project/claude技能/lasso
# 单桶单文件(低载下应稳绿,证明非代码问题)
npx vitest run --project timing-sensitive test/unit/doctor-deep-probe.spec.ts
# 全量(基线不回归)
npm test
# 高载复现(可选,验证假红的环境性):并行两个全量跑测窗口,观察 timing-sensitive 桶
# 是否出现"另一窗口在跑就红、独占就绿"的非确定性
```

---

## #9 独立脚本退出契约(attach 热复用持有事件循环)

### 现象

attach 归还后,消费方 browser-pool 为**热复用**保持 CDP ws 连接打开(归还 ≠ 断连),
该 ws socket 是 Node 事件循环的 active handle → **一次性(独立)脚本**完成渲染后
不自然退出、挂住;**长驻消费方**(MCP server、`node --test` runner)无此问题。信号路径
(SIGTERM/SIGINT/SIGHUP)已有 `process.exit(0)` 出口,唯独"正常干完活"的自然退出路径
没有出口。

### 证据

- 关联断言:media-gen-mcp `test/browser-pool-attach.test.ts:134`——
  `assert.equal(conn.state.disconnectCalls, 0, "渲染归还不得断连(连接留用热复用)")`;
  这条断言钉死的正是"连接留用"语义,即持有事件循环的那个连接,**设计如此、不可改**
  (断连换退出 = 牺牲热复用,是补丁式对应)。
- 信号路径出口:media-gen-mcp `src/browser-pool.ts:727`(syncCleanupOnExit)与
  `:757`(`closeBrowser().catch(() => {}).finally(() => process.exit(0))`)——信号来了会退,
  自然干完不会。
- lasso 侧文档已有相邻条款但未覆盖此面:《对接实施说明-渲染档x-media-gen-mcp.md》
  §一.5 "归还 = `browser.disconnect()`,严禁 `browser.close()`"(为什么不能关连接);
  §三.5 "正常退出≠能等回收——短命脚本事件循环即退,收尾必须由 lasso(常驻归属方)负责"
  (该条讲的是**渲染档实例的回收**归 lasso,没讲**消费方独立脚本自身**会被留用的 ws
  挂住——两个方向,只文档化了一半)。

### 根因

不是缺陷,是**使用形态契约未文档化**:热复用(连接留用)对长驻消费方是纯收益;对
进程生命周期 = "干完这批活就退"的一次性脚本,留用的 ws 把进程生命周期拉长到连接关闭
为止。组合缺口,代码无需动。

### 建议修法(零代码,补一句文档)

在两处补同一句配方(消费方使用形态的真源各补各的,不留单点):

1. **主落点**:lasso `doc/对接实施说明-渲染档x-media-gen-mcp.md` §一.5 attach 侧集成
   契约,"归还 = disconnect 严禁 close" 条目之下追加一条:
   > 独立(一次性)脚本渲染完成后需显式 `process.exit`——热复用保持的 CDP ws 连接会
   > 持有事件循环,自然退出不会发生;长驻消费方(MCP server / 测试 runner)无此问题。
2. **镜像落点**:media-gen-mcp `doc/渲染档共享实例-R5裁决与长期运行手册.md` §2 长期运行
   手册(该手册就是消费方长/短命使用形态的运营真源)同句追加。

若未来出现真实的独立脚本消费方且"手动 exit"成为实际痛点,再评估 browser-pool 提供可选
idle-disconnect 旋钮——届时有第二使用形态佐证才动代码,现在零代码。

### 复核命令

```bash
# 复现(可选,验证现象存在):一次性脚本 attach 渲染后不 exit,观察进程挂住
cd /Users/wangdong/Documents/Project/claude技能/media-gen-mcp
node -e '
const {createRequire} = require("module");
(async () => {
  const pool = await import("./dist/browser-pool.js");
  await pool.withBrowser(() => Promise.resolve("done"));
  console.log("render done —— 不 process.exit 观察是否挂住");
})();'
# 关联测试(归还语义不被将来改动破坏)
npm run build:tests && node --test dist-test/browser-pool-attach.test.js
```

---

## #10 R7 跨消费方通用化:need-later 重开条件与届时动作

### 现象

渲染档按"单消费方单实例"最小面实现并已发布(v1.19-1.20):默认口 9224 固定、冲突
exit 3 无协商、无多实例池。R7(跨消费方通用化:profile/端口/命名可配,kinocut 等第二
消费方同模式接入)为 P1 need-later,**未实施且刻意不实施**。

### 证据

- R7 定义:`doc/需求-渲染档浏览器治理.md:85`——"profile/端口/命名可配,未来其它消费方
  (kinocut 等)同模式接入"。
- 刻意延后的裁决在案:`doc/渲染档设计决议.md:127`("默认 9224,env `LASSO_RENDER_PORT`
  覆盖(测试隔离用;**单值覆盖不构成端口协商,冲突仍 exit 3——协商留 R7**)");
  `:275`("端口协商:固定 9224 + exit 3 最小可行;真实多消费方并发需求出现再开(R7)");
  `:273`(browserless 式 CONCURRENT/QUEUED/TIMEOUT 容量旋钮"属 R7 多消费方范畴");
  `doc/提案-render-stop端口作用域化.md:166`(跨台账聚合"真实跨命名空间孤儿清扫需求
  出现时随 R7 一并设计")。
- **R7 的手动形态已提前落地的部分**(重开前必须先盘点,避免重造):`LASSO_RENDER_PORT`
  端口作用域已覆盖 ensure/status/--stop/doctor 四入口(2026-09-02 提案 §6)+
  `LASSO_LAUNCHED_CHROMES_PATH` / `LASSO_RENDER_GUARDIAN_PID_PATH` 三 env 命名空间
  (`doc/渲染档-并行验收隔离配方.md`)——即"第二消费方手动配一套互异 env"今天就能
  接入,**零代码**;缺的只是自动协商与多实例池。

### 根因

不是债,是**反过度设计纪律的正确结果**:第二消费方未出现前,任何端口协商/池化/
命名参数化都是投机面(browserless 调研也确认其常驻容量旋钮服务的是多租户并发,
单消费方单实例用不上)。

### 建议修法(重开条件 + 届时要做什么)

**重开条件(任一命中才开,否则维持 need-later)**:

1. kinocut 等第二消费方要同模式 attach **同机常驻**,且手动三 env 配方被判定为
   不可接受的使用负担(先跑配方验证——很可能零代码已够用);
2. 单消费方出现真实并发容量不足(render-video 长会话(单会话可 >10min)饿死短渲染,
   R5 页级独立性正确但吞吐不够);
3. 出现跨命名空间孤儿清扫的真实运维需求(现为提案 §5 留档的选项 B 边缘场景)。

**届时要做什么(按依赖序,先读《渲染档设计决议.md》§9 与提案 §5 留档再裁)**:

1. **端口可配协商**:冲突不再 exit 3 了事——消费方 env 指定端口段,或 `--ensure` 返回
   池内可用实例的 wsEndpoint(ensure 输出契约 §一.1 已前向兼容:消费方忽略未知字段、
   port 字段本就在)。
2. **池化**:多实例 per-port;台账 `LaunchedChromeRecord` 本就 per-port,天然支持多记录,
   主要增量在 ensure 的实例选择与 idle reaper 的逐实例收割(现逻辑已按记录粒度,面很小)。
3. **profile/命名可配**:`render-chrome-profile-*` 前缀与指纹旗标参数化——注意指纹
   (run-all-compositor-stages-before-draw 等)是孤儿识别与零误伤的根基,参数化时必须
   保持"渲染档可识别"不变(设计决议 §三 边界 3)。
4. **容量/队列旋钮**(仅条件 2 命中才做):browserless 式 CONCURRENT/QUEUED;TIMEOUT
   硬寿命上限维持永久否决(touch 心跳是活性真源,§9 裁决不因 R7 翻案)。
5. **跨台账聚合与审计字段升级**:renderSessions 升级为真实会话计数,随独占锁/队列
   一并设计(§3.7 显式偏差声明的既定句式)。

### 复核命令

```bash
cd /Users/wangdong/Documents/Project/claude技能/lasso
# 现状单实例语义确认(默认口)
npx lasso-mcp render-chrome --status
# R7 手动形态(三 env 命名空间)现可用的证据——按配方 §5 自检
LASSO_RENDER_PORT=9234 LASSO_LAUNCHED_CHROMES_PATH=/tmp/accept-x/launched-chromes.json \
  npx lasso-mcp render-chrome --ensure
# 需求与裁决留档定位
grep -n "R7" doc/需求-渲染档浏览器治理.md doc/渲染档设计决议.md doc/提案-render-stop端口作用域化.md
```

---

*本文由 2026-09-03 登记级批量清理轮 B 任务产出(只文档零代码);#8/#9/#10 均不改变
lasso 当前默认路径行为——lasso 与 media-gen-mcp 双仓门禁基线均不受影响。*
