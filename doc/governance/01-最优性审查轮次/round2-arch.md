# 第 2 轮最优性审查 —— 「MCP 架构与工程范式」域（复审）

> 调研员：Round 2（架构域）。日期：2026-08-17。
> 性质：**复审轮**——① 检验 round1 本域四项调整（T12/T13/T14/T16）是否达最优；② 用新证据复核 watch/NO-GO 项（R5/R9/R10/O-1/O-2）；③ 全新热点项目。不重复 round1 已裁决内容（对标基线见 round1-arch.md）。
> Lasso 基线：v1.11.0（工作树，HEAD 仍为 v1.10.0 commit）。本轮实测门禁：`npm test` 1906 tests（1904 pass / 1 timing-flake / 1 skip）、`check-invariants` 79 全绿（v1.10 为 78，新增 INV-79）、`inv-selftest` 10/10 样本红转验证全过。npm registry / PyPI / 上游源码 / Lasso 源码全部实测。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round1 T12（cdpPort 守卫）是否最优 | **达最优**（实现逐行核对，含越界/NaN/空串三分支 + warn，无残留裸 parseInt） |
| round1 T13（INV selftest）是否最优 | **主体最优，两处残留**：①固定 10 样本（round1 设想的"确定性轮转"未做，69 条 INV 从未被 mutation 验证过）；②**INV-79（v1.11 新增）未注册违规样本——自定纪律"新增 INV 必须注册"被纪律诞生后第一条新 INV 即违反** |
| round1 T14（wrapHandler）是否最优 | **主体最优，一处残留**：`setMetrics` 生产装配层从未调用（grep 全仓零 call site）——T14 的 metrics 钩子是"仅测试可达"的死注入点 |
| round1 T16（SDK ^1.30.0）是否最优 | **达最优**（v1 线 latest 仍= 1.30.0，2026-08-17 registry 实测；1.30.0 的 SSE keep-alive + Zod 3.25 兼容两个 backport 均为 Lasso 受益面） |
| R10/O-1（SDK v2 迁移 roadmap 2026-Q4） | **维持，且新证据降本增险**：官方 codemod 已 stable；v2 双 era 同进程；但驱动层实测仍捆 v1 —— 不提前，Q4 评估时按新风险清单复核 |
| R5（outputSchema） | 无新证据，维持 watch（捆绑 v2 迁移） |
| R9/O-2（doctor.ts 拆分） | doctor.ts 2707 → 2774 行（+67），膨胀趋势延续，处置不变（下次自然加 check 时顺带拆） |
| 全新热点 | FastMCP 4 双 era / TS SDK v2 GA + codemod / **官方 conformance 测试套件（新范式）** / SDK 开放 issue 三连（#2002 #2619 #2622，其中两条与 Lasso 直接相关） |
| **本轮新发现（round1 未覆盖）** | **stdio stdin-EOF 孤儿窗口**：SDK StdioServerTransport 不监听 stdin close/end（上游 #2002，实测已装 1.30.0 源码确认），Lasso 的停机三路径（SIGTERM/SIGINT/exit 钩子）全部不覆盖"父进程死亡 → stdin EOF → 子进程句柄保活事件循环"场景 → CC 崩溃时 Lasso+cdp-mcp 树孤儿最长存活 1h（zombie reaper 兜底前） |

---

## 1. 本域最新最热项目清单（round1 之后的增量）

| # | 项目 | 热度/状态（实测） | 一句话机制 | 与 Lasso 的关系（相对 round1 的增量） |
|---|------|----------------|-----------|----------------------------------|
| 1 | **PrefectHQ/fastmcp v4 线** | v4.0.0b1（2026-07-28）→ v4.0.0b3（2026-08-14，仍 beta）；3.x 维护线活跃（3.4.7 = 2026-08-10）；~25k★ 量级 | **双 era 单部署**：一个 server 同时应答无状态 2026-07-28 协议与旧握手协议，按连接协商；`UserSession`/`SessionId` 显式服务端状态；`io.modelcontextprotocol/tasks` 后台任务扩展；`add_extension()` 插件面；BREAKING：移除 server 主动 sampling/roots | v4 的"stateless 协议上显式建状态"（UserSession）**反向验证** Lasso `withOperation` ALS 请求隔离（INV-12）是同一问题的同型答案；tasks 扩展是长时 browse 操作的 spec 级终局，但 CC 客户端支持未知 → watch（W-2）。不改变 round1"不 FastMCP 化"裁决 |
| 2 | **modelcontextprotocol/typescript-sdk v2 GA** | `@modelcontextprotocol/server@2.0.0`（2026-07-27 stable，2026-08-17 实测无 2.x 补丁）；v1 线 latest 仍 1.30.0；**`@modelcontextprotocol/codemod@2.0.0` stable**（npm 实测） | "采用 v2 SDK ≠ 采用 2026-07-28 协议——两步独立"；单端点同时服务两 era（`server/discover` 探测 + 旧 initialize 回退）；Standard Schema（Zod v4/Valibot/ArkType）；官方自动迁移 codemod：`npx @modelcontextprotocol/codemod v1-to-v2 .` | Lasso 直接依赖的终局线。**codemod stable 使 R10 迁移成本从"手工全量改"降为"机械改 + 人工复核"**。开放 issue 三条对 Lasso 有直接指向（见 §2 D7/D10） |
| 3 | **modelcontextprotocol/conformance**（官方一致性测试套件） | npm `@modelcontextprotocol/conformance` 0.1.16 stable / 0.2.0-alpha.11（2026-08-07，活跃） | 官方 spec 一致性框架：对 client/server 实现按已发布规范自动化验证；SDK 分级（Tier 1/2）以通过率为标尺（SEP-2484 已要求 SEP 终稿必须带 conformance 测试）；TS SDK v2 已"server-stateless 套件去基线化"（不再预期失败） | **round1 未覆盖的新官方测试范式**。Lasso 现有三层守护（InMemoryTransport 测试 / INV 静态 / selftest mutation）全是"对内"，conformance 是第一个"对 spec"的第三方裁决面。定位：v2 迁移验收基线（W-1），不作常驻门禁 |
| 4 | **chrome-devtools-mcp 1.7.0 的依赖矩阵**（非项目，是关键事实） | tarball `build/src/third_party/bundled-packages.json` 白盒实测：`"@modelcontextprotocol/sdk": "1.30.0"`（全量打包，零运行时依赖） | 驱动层把 SDK 1.30.0 打进自身 bundle | **round1 R10 留的"先评估 chrome-devtools-mcp 子进程兼容矩阵"现在有答案了**：驱动层在 v1 线上，Lasso v1 client ↔ 驱动 v1 server 同质，无跨 era 协商问题。v2 迁移时 Lasso（若升 v2 client 且维持旧 era 协议）↔ 驱动（v1 server）由"协议版本协商"承载——SDK 文档明示两 era 可混布，风险从"未知"降为"可验证"（conformance 一跑便知） |
| 5 | lastmile-ai/mcp-agent | PyPI 最后发版 0.2.6 = **2025-12-05**（GitHub push 2026-01-25）——停滞加深至 ~8 个月 | （同 round1）双 YAML config/secrets + Pydantic Settings | round1 锚点有效性复核：停滞加深。其 config/secrets 范式仍是参考锚，但"停滞项目的范式"权重应随时间衰减；Lasso 扁平 JSON + doctor 校验路线无需动摇 |
| 6 | UTCP（universal-tool-calling-protocol） | 多语言实现（Py/TS/Go），社区热度中等（HN/Reddit 讨论为主） | MCP 替代协议：只做 discovery，主张 agent 直调既有 API，反对代理层 | **NO-GO（一句话裁决）**：Lasso 是挂在 CC 上的 MCP server，CC 说 MCP；引入第二协议违 R-INT 简单架构。仅记录其"直调 vs 代理"的论点作为生态多样性注脚 |
| 7 | 多 agent 编排层（LangGraph 已成 de facto / CrewAI 52.4k★ / Agent-MCP 等） | 生态格局与 round1 相比无结构性变化 | （框架层） | Lasso 明确不做 agent 框架（round1 R11 已裁），无翻案证据 |

**清单结论**：本域 round1 → round2 的真实增量集中在三件事——**TS SDK v2 配套成熟化（codemod stable + 双 era 明示）**、**官方 conformance 套件成形**、**SDK 开放 issue 中两条戳中 Lasso 的机制面（#2002 stdio 孤儿 / #2622 listChanged 覆写）**。FastMCP 4 与 UTCP 均不改变 Lasso 的选型裁决。

---

## 2. 白盒对标表（round2 复审维度；round1 九维 D1-D9 不重复，仅列增量维度与复核结论）

| 维度 | Lasso 现状（源码锚点，本轮实测） | 对标锚点（本轮实测） | 差距判定 |
|------|------|------|---------|
| **R2-D1 上轮 T12 复核（config 数值守卫）** | `src/config/config.ts:136-151`：`parseCdpPort` 空串/undefined→默认、`parseInt` NaN→默认、`≤0 或 >65535`→默认，三分支齐备 + `logger.warn config_invalid_value`；`config.ts:375` 消费点已替换；config-file spec 补用例（v1.11 diff 实测 +46 行） | mcp-agent Pydantic Settings 全量校验（参考锚，停滞加深）；TS SDK v2 Standard Schema 只管工具参数不管 env | **持平（已收敛）**。round1 设想"顺手核对其余 parseInt 裸调"未做（grep config.ts 剩余 parseInt 均在已守卫的 parse* 帮助函数内），无残留面 |
| **R2-D2 上轮 T13 复核（INV mutation 自检）** | `scripts/inv-selftest.mjs`（221 行）：基线绿门 → 临时副本注入 → 目标 INV 必须红 → 工作树零污染；`node:*` only；10 样本（INV-2/3/4/7/11/17/21/28/33/63）实测 10/10 红转；INV-63 样本锚点动态取 package.json 版本（bump 不失效，好设计） | TS SDK behavior-surface-pins 三纪律（round1 白盒）；FastMCP 无对应物；**官方 conformance 套件（新增）测 spec 合规而非架构不变量——两者正交** | **Lasso 优（机制独创性保持），两处残留**：① 固定 10 样本 vs round1 设想的确定性轮转 → 69 条 INV 从未被 mutation 验证（含 INV-76 这种曾真实假绿过的类型）；② INV-79 未注册（见 R2-D4）。残留①的诚实中间解是"覆盖率报告"而非全量样本（全量 79 样本 = 高维护负担，违单人可持续） |
| **R2-D3 上轮 T14 复核（wrapHandler 单点横切）** | `src/runtime/ToolManager.ts:105-192`：register 内 wrap（error→isError envelope / log→结构化 warn / timing→duration_ms / metrics?.record 可选）；边界注释明写"不演化成可插拔管道"；admin 工具经 `tools/admin.ts:207` `toolManager.register` 走 wrap（实测）；ToolManager.test.ts 三用例（worked/error 入窗、setMetrics 单次注入语义） | FastMCP v4 中间件面（round1 白盒；v4 未改变 middleware 基本形态，增量在 auth/DI） | **持平（按 round1 设计达最优）+ 一处接线残留**：`src/index.ts:998-999` 创建 `metrics` 并 `decider.attachMetrics(metrics)`，**但 `toolManager.setMetrics(metrics)` 全仓零调用**（grep src+test，仅测试文件调用）→ 生产装配中 T14 的 metrics 钩子不可达，admin 工具时延/错误不入 INV-43 观测窗。属"设计完成、装配漏一步"，一行修复 |
| **R2-D4 新增 INV 的纪律一致性** | `check-invariants.mjs:4055-4072` INV-79（1.7.0 迁移守护 + launch stealth，79 全绿）；`inv-selftest.mjs:18` 头注释纪律："**新增 INV 必须注册违规样本**（VIOLATION_SAMPLES 加一行）"；`VIOLATION_SAMPLES`（L45-110）共 10 条，**无 INV-79** | TS SDK pins 纪律 (b)"pin 落地前必须 mutation-check 一次"——新 pin 新验证 | **落后（纪律执行）**：纪律写入与 INV-79 落地同版本（v1.11），第一条新 INV 即违反。INV-79 五个子检查全部静态可证伪（如删 HeadlessChannel 的 `--no-usage-statistics` 验 (b)），写得出样本，非不可证伪问题 |
| **R2-D5 SDK 版本姿态（T16 复核 + v2 局势更新）** | `package.json` `@modelcontextprotocol/sdk ^1.30.0`（node_modules 实装 1.30.0） | v1 latest = 1.30.0（2026-08-17 实测，无更新）；v2 = 2.0.0 无补丁线；官方承诺 v1 维护 ≥6 个月（≈2027-01）；**codemod 2.0.0 stable**；v2 "采用 SDK ≠ 采用新协议"两步独立 | **持平（v1 线已拉满）**。R10 维持 roadmap 2026-Q4：codemod stable + 双 era 设计把迁移从"破坏性"降为"机械+复核"，但驱动层（#4）在 v1 线、CC 侧 era 支持未明——**不提前迁移**的理由不变，评估时的检查清单反而更具体（见 W-1） |
| **R2-D6 v2 已知缺陷对 Lasso 的前向风险** | Lasso 依赖链：`listChanged` 通知（CapabilityBag 禁用 → ToolManager.disableChannel → SDK sendToolListChanged，INV-37 全链）；stdio 传输（唯一传输形态） | TS SDK v2 开放 issue：**#2622** `McpServer` 首次 `registerTool` 时把 `capabilities.tools.listChanged:false` 静默覆写为 `true`（构造器选项被丢弃）；**#2619** 探测响应 2xx 空体会硬失败 `connect()`（HTTP 面，Lasso 不涉及）；**#2165** abort 与超时错误混淆 | **前瞻风险（迁移清单项）**：#2622 直接触碰 CapabilityBag 的能力声明语义——v2 迁移必须验证"禁用通道后 listChanged 通知仍按 SDK 语义送达"，列入 W-1 验收清单。当前 v1.30 无此问题（ToolManager 注释引用的 mcp.js L644-651 语义实测在） |
| **R2-D7 进程生命周期（新维度；round1 未覆盖）** | `src/index.ts:1189-1248`：停机三路径 = SIGTERM / SIGINT / `process.on("exit")` killAllSync 兜底；全部 timer `unref()`（`SubprocessManager.ts:210` zombie 60s、chrome-idle-reaper 60s、ResourceMonitor 60s）；`SubprocessManager` 注释自认"MCP stdio 模式下我们靠 SIGTERM/SIGINT 显式 shutdown"；`cleanupZombies`（1h 阈值）会真杀（`_kill`）；index.ts:1242-1244 注释已点名"stdin 关闭等自然退出不触发信号处理器"——**但只兜了"进程真的退出"的路径** | SDK 1.30.0 实装源码 `dist/esm/server/stdio.js`（白盒实读）：`StdioServerTransport.start()` 只挂 `stdin.on('data')` 与 `stdin.on('error')`，**无 close/end 监听**（第 21 行的 `this.close()` 仅解析错误路径）；上游 issue **#2002**（开放，v2 同样存在）："StdioServerTransport 从不监听 stdin close/end → 客户端关窗时服务进程孤儿化"，用户实测一天 37 个孤儿进程，场景即 Claude Code | **落后（一处量级明确的窗口）**：CC 崩溃/杀进程不给信号 → stdin EOF → Node 事件循环本可排干，但**活跃子进程（cdp-mcp / rust-helper）的 ChildProcess 句柄保活循环** → Lasso 不退出 → exit 钩子永不触发 → Lasso+子进程树孤儿，直到 zombie reaper 1h 阈值杀掉空闲子进程后才连锁收尾（chrome-idle-reaper 60s 先收 Chrome）。窗口 = ≤1h 的 node+cdp-mcp 双进程，触发条件 = CC 异常退出时恰有活跃子进程。修复两行（见调优项 1），与上游 #2002 修法同构（"fix is two lines in start()"） |
| **R2-D8 doctor/观测面（O-2 复核）** | doctor.ts 2774 行（v1.10 2707 → +67）；INV-47 runtime_state 扩展；doctor T10 proxy 回显检查已接线（proxy-egress.spec 10 用例） | Inspector / ToolHive（round1；无自检面对照变化） | **维持 round1 判定（Lasso 优，观察膨胀）**。+67 行/轮的速度证实 R9"下次自然触碰时顺带拆"的处置是对的——现在拆仍不抵扰动 |
| **R2-D9 测试与契约守护（增量）** | 1906 tests（+105 vs v1.10）；timing bucket 先例（vitest.workspace.ts）；T10 doctor proxy 用例在全量并发下 5169ms 超时失败、单文件重跑 1648ms 通过（本轮两次全量 + 两次单跑实测） | 官方 conformance 套件（0.1.16 stable）为 server 实现提供 spec 级第三方裁决 | **持平偏优（保持）+ 一条 flaky 观察**（T10 doctor CLI 用例疑似应移入 timing-sensitive bucket，见观察项）；conformance 定位为迁移验收工具而非常驻门禁（W-1） |

---

## 3. 候选调优项（3 条，宁缺毋滥）

> 门槛沿用 round1：①白盒证据差距 ②愿景内既有能力优化 ③代价≤中 ④收益可验证 ⑤不破 INV/tri-state/简单架构。
> 全部零新依赖、单点可回滚。

### 调优项 1（P1）：stdin EOF → shutdown 钩子（进程生命周期补全，上游 #2002 同构修复）

- **对标证据**：① SDK 1.30.0 实装 `stdio.js` 白盒——`start()` 只挂 `data`/`error`，无 `close`/`end`；② 上游 #2002 开放 issue（v2 同病），用户报告 Claude Code 关窗后 37 个孤儿进程，官方定性"fix is two lines in start()"；③ Lasso `index.ts:1242-1244` 注释自认 stdin-关闭路径依赖 exit 钩子，但 exit 钩子只在进程真退出时触发——活跃 ChildProcess 句柄保活事件循环的场景（CC 崩溃时正在 browse）进程不退出，三重停机路径全部落空，只能等 `cleanupZombies` 1h 阈值兜底（实测其 `_kill` 为真杀，窗口有界但真实）。
- **具体改法**：`src/index.ts` 停机段（L1240-1241 旁）加两行：
  ```ts
  process.stdin.on("end", () => void shutdown("stdin_eof"));
  process.stdin.on("close", () => void shutdown("stdin_eof"));
  ```
  复用现成幂等 `shutdown`（`shuttingDown` 防双触发，L1190-1193）——正常 CC 退出先 SIGTERM，后到的 stdin EOF 被幂等挡住，零竞态新增。SDK transport 已挂 `data` 监听（流处于 flowing 模式），EOF 后 `end`/`close` 必达，无需额外 resume。顺手在 shutdown 事件名上保留 `stdin_eof` 供日志区分来源。
- **预期收益**：CC 异常退出场景的 Lasso+cdp-mcp 孤儿窗口从 ≤1h 收敛到即时全链收尾（走既有 Steel release / tab restore / 树杀全流程）；对齐 MCP stdio 语义共识（客户端关闭 stdin = 终止服务，与上游修法同构）；不等待上游 #2002 落地（v1 线大概率不会 backport）。
- **实施代价**：XS（2 行 + 1 个用例：spawn dist/index.js、读写端关闭 stdin、断言进程在 N 秒内退出）。
- **风险评估**：近零。唯一理论顾虑是"客户端故意关 stdin 但想让 server 活着"——MCP stdio 语义不存在该契约（上游 issue 即此定性）；真机手测（kill CC 进程）归档即可。

### 调优项 2（P2）：`toolManager.setMetrics(metrics)` 装配接线（T14 收尾一行）

- **对标证据**：`ToolManager.ts:77` 提供 `setMetrics`（注释明写"装配层 index.ts 用"）；`ToolManager.test.ts:422-456` 三用例验证注入语义——但 grep 全仓，生产代码零调用。对照同文件同范式：`index.ts:999` `decider.attachMetrics(metrics)` 已接线（FallbackDecider 同源设计，装配完即挂）。T14 的验收语义"metrics?.record 入窗"在生产装配下永远走 null 分支。
- **具体改法**：`src/index.ts:999` 后加一行 `toolManager.setMetrics(metrics);`（toolManager 在 :861 已创建，metrics :998，顺序合法）。
- **预期收益**：admin/动态注册工具的 worked/error 时延进入 INV-43 观测窗（RingBuffer 128，admin channel 维度），doctor runtime_state（INV-47）随之可见；T14 注入点从"仅测试可达"变真装配。
- **实施代价**：XS（1 行 + 断言 admin 调用后 metrics snapshot 含 admin channel 的单测，或并入现有 ToolManager 测试装配用例）。
- **风险评估**：近零。`record` 签名兼容（wrapHandler 传 `channel, "worked"|"error", durationMs` 与 MetricsCollector.record 同形，实读签名核对）；"不覆盖已有"语义对单次装配无影响。

### 调优项 3（P2）：INV-79 注册违规样本 + selftest 覆盖率报告（T13 纪律闭环）

- **对标证据**：`inv-selftest.mjs:18` 自定纪律"新增 INV 必须在 VIOLATION_SAMPLES 注册一行；写不出样本 = INV 不可证伪应重写"；`check-invariants.mjs:4055-4072` INV-79 为 v1.11 新增且 79 全绿；VIOLATION_SAMPLES（L45-110）实测无 INV-79——**纪律与执行在同版本内脱节**。另：round1 设想"10 条/轮确定性轮转"未实现，69 条 INV（含曾真实假绿的 INV-76 类型）从未被 mutation 验证。
- **具体改法**：① VIOLATION_SAMPLES 追加 INV-79 样本一条（如 `HeadlessChannel.ts` 上 `replaceAll: ["--no-usage-statistics", "--usage-statistics-off"]` 验 (b) 子检查由绿转红，或版本锁 `replace: ['"1.7.0"', '"0.3.0"']` 验 (a)）；② selftest 汇总段加一行非门禁输出：解析 checker 全量 INV id 列表 vs 样本覆盖，打印 `样本覆盖 11/79`——让覆盖缺口从隐式变显式（不设阈值不 fail，守单人可持续；覆盖数只增不减由 code review 把关）。
- **预期收益**：纪律自洽（新 INV 有样本红转一次）；69 条未验证 pin 的缺口显性化，为后续按需补样本（优先 INV-76/68/71 等外部契约类）提供工作面清单；不增加常驻 CI 成本。
- **实施代价**：XS-S（样本一条 + 覆盖统计 ~20 行；checker 的 FAIL 行格式已在 runChecker 解析，全量 id 可从 checker 输出或 assertions 注册表取）。
- **风险评估**：近零。注入走临时副本既有机制；覆盖率仅报告不门禁，无 flaky 面。

### 观察项（不计入调优项）

- **W-1 SDK v2 迁移验收清单（R10/O-1 的 Q4 评估输入，本轮新增证据具体化）**：① 迁移前跑一次官方 conformance 套件（`@modelcontextprotocol/conformance@0.1.16`）建立 wire 基线，迁移后对比——这是"协议两步独立"论断的实证闸门；② 验证 v2 #2622（listChanged 静默覆写）对 CapabilityBag 链的影响——`registerTool` 后 capabilities.tools.listChanged 必须与实际通知行为一致（INV-37 语义依赖它）；③ 用官方 codemod（2.0.0 stable）跑 dry-run 评估 `server.tool(` 17 处 + `captureHandle` 形态的机械转换率；④ 保持旧 era 协议（"采用 v2 SDK ≠ 采用 2026-07-28 协议"），驱动层（捆 SDK 1.30.0）与 CC 两侧都不强制。全部归入 doc/architecture/02 路线图的 Q4 评估动作，本轮不动代码。
- **W-2 MCP Tasks 扩展（`io.modelcontextprotocol/tasks`）**：spec 级长时任务范式（FastMCP 4 已产品化），与 Lasso 长时 browse/桌面操作的语义匹配度高；触发条件：CC 客户端宣布支持 Tasks 扩展，或 v2 迁移时一并评估。当前不做。
- **W-3 T10 doctor CLI proxy 用例 timing-flake**：全量并发下 5169ms 失败 / 单文件 1648ms 通过（本轮两次全量复现一次、单跑两次全过）——疑似应移入 `vitest.workspace.ts` 的 timing-sensitive 分桶（该文件有 flaky 治理先例注释）。归 test 卫生，随手修。
- **R5（outputSchema）/ R9（doctor 拆分）/ R11（不做 agent 框架）**：无新证据，处置不变。

---

## 附：判定汇总

| 复审维度 | 判定 |
|------|------|
| R2-D1 T12 cdpPort 守卫 | 已收敛（最优） |
| R2-D2 T13 INV selftest | Lasso 优（机制），固定样本+覆盖率缺口两残留（调优项 3） |
| R2-D3 T14 wrapHandler | 设计最优，装配漏一行（调优项 2） |
| R2-D4 新 INV 纪律一致性 | 落后（调优项 3 对症） |
| R2-D5 SDK 版本姿态 | 持平（v1 线拉满；v2 维持 Q4 roadmap，成本下调） |
| R2-D6 v2 前向风险 | 前瞻风险清单成立（W-1 ②） |
| R2-D7 进程生命周期 | **落后（stdin-EOF 孤儿窗口；调优项 1 对症）** |
| R2-D8 doctor | 维持（Lasso 优 + 膨胀观察） |
| R2-D9 测试/契约 | 持平偏优（保持）+ W-3 flaky |

**核心结论**：round1 本域四项调整中 T12/T16 已最优、T13/T14 各余一步收尾（调优项 2/3，均为 XS-P2）；watch 项无翻案、R10 因官方 codemod stable 与双 era 设计**成本下调但时机不变**。本轮唯一量级新发现是进程生命周期维度的 **stdin-EOF 孤儿窗口**（上游 #2002 实证 + 已装 SDK 源码实读 + Lasso 停机三路径盲区三方互证），修复两行、复用幂等 shutdown、与上游修法同构。三条调优项全部零新依赖、不动架构、不触 INV 语义（仅加样本/接线）。
