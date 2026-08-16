# 第 3 轮最优性审查 —— 「MCP 架构与工程范式」域（复审）

> 调研员：Round 3（架构域）。日期：2026-08-17。
> 性质：**复审轮**——① 检验 round1 本域四项（T12/T13/T14/T16）+ round2 本域三项（T2-12/T2-13/T2-14）是否达最优（白盒抽验新代码）；② 用新证据复核 watch/NO-GO 项（R5/R9/R10/W-1/W-2/FastMCP/UTCP）；③ 全新热点。不重复已裁决内容（对标基线见 round1-arch.md / round2-arch.md）。
> 实测基线：**v1.12.0 工作树（round2 T2-1..14 + review03 修复 R03-1，未 commit；HEAD 仍 = 0b07536 v1.11.0；npm latest = 1.10.0）**。本轮本机门禁全量复跑：`build ✓ / npm test 122 files 1940 passed + 1 skipped / check-invariants 79/79 ✓ / inv-selftest 11/11 红转 + 样本覆盖 11/79 报告 ✓`（与 round2-review03 终态逐项一致，零回归）。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round2 T2-12（stdin EOF → shutdown）是否最优 | **主体最优，一处量级残留**：shutdown 链三步异步收尾中 steel `releaseSession()` 是唯一**无上界 await**（兄弟步 stopLaunchedChromes/restoreTabs 均 3s race 封顶）——本机实测（Node 24.12）裸 fetch 对"接受连接但不响应"端点挂起 **300,978ms**（UND_ERR_HEADERS_TIMEOUT）→ Steel 会话在场 + endpoint 悬挂时，stdin_eof 路径从"秒级全链收尾"退化为 ≤5min（T2-12 的孤儿窗口 1h→5min 而非 1h→即时）。测试注释"各收尾步 3s 上界"与事实不符（测试过是因为无 Steel 会话时 releaseSession 为 no-op） |
| round2 T2-13（setMetrics 接线）是否最优 | **达最优**：index.ts:1008 接线在案；wrapHandler 经 `this.metrics?.record` **调用期读值**（late-binding，注册/装配顺序无关）；review03 行为级断言（`metrics.record("admin:worked")`）+ 本轮门禁绿 |
| round2 T2-14（INV-79 样本 + 覆盖率报告）是否最优 | **达最优**：本轮实跑 `inv-selftest` 11/11 红转（含 INV-79 遥测子检查样本）；覆盖率报告实测输出 `样本覆盖 11/79（未验证 pin 68 条）`，regex `^PASS\s+(\S+)` 与 checker L4159 输出格式逐字对齐。**自然延伸**（T2-14 已记档"优先 INV-76/68/71"）= 调优项 2 |
| round1 T12/T14/T16 是否漂移 | 零漂移：parseCdpPort（config.ts:138/375）三分支守卫在案；wrapHandler 边界纪律注释（"不演化成可插拔管道"）与三件横切（error/log/timing）原样；SDK ^1.30.0 仍 = v1 线 latest（2026-08-17 registry 实测无 1.30.1） |
| R10/O-1（SDK v2 迁移 Q4） | **维持，新证据双利无翻案**：registry 零动（v1 latest 1.30.0 / v2=2.0.0 零补丁 / codemod 2.0.0）；spec 正式 deprecation policy = **弃用特性最少保留 12 个月**（旧 era 最早 2027-07 才可能移除）→ Q4 时机安全甚至宽裕 |
| W-2（MCP Tasks 扩展） | **新证据双向加固，仍 watch**：ext-tasks（SEP-2663）已入 2026-07-28 正式 spec（官方 repo modelcontextprotocol/ext-tasks）；但 CC 客户端支持仍是 open feature request（anthropics/claude-code#18617）——触发条件未满足 |
| R5（outputSchema）/ R9（doctor 拆分）/ UTCP / FastMCP / R11 | 无翻案：doctor.ts 2774→2838 行（+64/轮，膨胀斜率不变，"自然触碰时顺带拆"处置继续成立）；FastMCP 4 仍 beta（4.0.0b3，2026-08-14）；UTCP/R11 零新证 |
| W-3（timing flake） | **已闭合**：round2 移桶后本轮全量复跑 0 flake |
| 全新热点 | 无结构性新项。增量事实四条：上游 #2002 的修复 PR **#4794 已存在**（未发版）/ ext-tasks 入正式 spec / 12 个月 deprecation policy / conformance 套件成 Tier-1 SDK 门槛 |
| **本轮新发现（round2 未覆盖）** | ①shutdown 链唯一无上界 await（调优项 1，实测 301s）；②**发布积压**：npm latest=1.10.0 vs 本地 1.12.0——两轮 30 项修复未发布（含孤儿进程修复），npx 用户仍拿旧版 |

---

## 1. 本域最新事实清单（round2 之后的增量）

| # | 事实 | 实测/来源 | 与 Lasso 的关系 |
|---|------|----------|----------------|
| 1 | **上游 #2002 修复 PR #4794 已开**："fix(server): exit when MCP client closes stdin pipe"（CI run 在案），但**未进任何 npm 发版**（v1 线 latest 仍 1.30.0 无 1.30.1；v2=2.0.0 零补丁） | GitHub PR/Actions + npm dist-tags（2026-08-17） | T2-12 的本地修复**仍然必要**（上游定性同构："fix is two lines"）；未来上游发版后与 Lasso 本地钩子共存安全（shutdown 幂等）。R10 迁移时应**移除本地钩子核对上游语义**（W-1 清单加一行） |
| 2 | MCP Tasks 扩展（SEP-2663，`io.modelcontextprotocol/tasks`）已入 2026-07-28 正式 spec（官方 modelcontextprotocol/ext-tasks repo）；**CC 客户端支持 = open FR**（anthropics/claude-code#18617）；C# SDK v2 博客确认 Tasks 是 v1/v2 **唯一 wire 不兼容面** | 官方 repo / spec blog / MS DevBlogs | W-2 触发条件（CC 宣布支持）未满足，维持 watch。附注：若 CC 未来支持，Tasks 与 Lasso 长时 browse/desktop 操作语义匹配度高——评估时注意它是 v2 迁移中唯一 wire 断裂点 |
| 3 | **正式 deprecation policy：弃用特性最少保留 12 个月**（2026-07-28 spec blog / Cloudflare 解读） | spec blog | 旧 era 协议最早 2027-07 才可能被移除；R10 的 Q4-2026 评估时机安全宽裕，无提前压力 |
| 4 | 官方 conformance 套件成 **Tier-1 SDK 门槛**（TS SDK v2 已通过 stateless 检查）；SEP-2484 要求 SEP 终稿带 conformance 测试 | zread typescript-sdk 文档 / conformance repo | W-1 ①（迁移前建 wire 基线）从"建议"升为"生态标准动作"；conformance 0.1.16/0.2.0-alpha.11 与 round2 实测零变化 |
| 5 | npm 生态面：chrome-devtools-mcp latest 仍 1.7.0（锁版=latest 继续成立）；`@modelcontextprotocol/server` latest 2.0.0 零补丁线；FastMCP 4.0.0b3（2026-08-14）仍 beta 冲 GA | npm dist-tags（2026-08-17 全部亲测） | 选型面零漂移；round1/2 全部选型裁决无需重开 |
| 6 | **lasso-mcp npm latest = 1.10.0**（本地 1.12.0 未 commit） | npm view 亲测 | 发布积压：round1 16 项（v1.11.0 已 commit 未发布）+ round2 14 项（工作树未 commit）均未达 npx 用户。孤儿修复/假 worked 修复等用户可感知项被压两版 |

**清单结论**：本域 round2 → round3 无结构性新项目（FastMCP 4 未 GA、UTCP 无声量、v2 无补丁线）——生态进入 spec 后的**消化期**，工程范式层的增量全部是"官方配套成熟化"（PR 修复在途 / policy 定型 / conformance 门槛化）。这反向确认 Lasso 的架构面（四通道 + FallbackChain + INV 体系 + v1 SDK 拉满）处在稳定最优区间，本轮唯一值得动的都是**自家实现收尾**。

---

## 2. 白盒对标表（round3 复审维度）

| 维度 | Lasso 现状（源码锚点，本轮实测） | 对标锚点（本轮实测） | 差距判定 |
|------|------|------|---------|
| **R3-D1 T2-12 复核（stdin EOF 实现质量）** | `src/index.ts:1251-1259`：注释含上游 #2002 定性与幂等论证；仅 server 模式装配（main() L1326+ 先 dispatch CLI 子命令早退，stdin 钩子不会进 doctor/CLI 路径——结构核验）；`shutdown` 幂等（`shuttingDown` L1199-1202）；真实子进程 E2E 测试（stdin-eof-shutdown.spec.ts：spawn dist → end() → 断言 exit 0 + stdin_eof 日志）。**残留**：L1211-1217 `await steelChannel.releaseSession()` 是 shutdown 链唯一无上界 await（L1220-1237 两兄弟步均 `Promise.race` 3s 封顶）；`SteelChannel.ts:345-366` releaseSession 裸 fetch 零超时零 AbortSignal（本文件 `:101` 建 session 同样无超时，但那在请求路径有错误信封兜底，非停机路径） | 上游修复范式（PR #4794）：transport 层监听关闭即退——Lasso 应用层同构。**实测挂起边界**：Node 24.12 全局 fetch 对 accept-but-silent TCP 端点 POST → **300,978ms 后才 UND_ERR_HEADERS_TIMEOUT**（本机实证） | **主体最优，一处量级残留**（调优项 1）。触发面：Steel 会话在场（cachedSessionId 非空）+ endpoint 悬挂（自托管 docker 停摆半途/TUN 劫持类网络异常）→ killAllSync/exit 被阻 5min。频率低但恰是 T2-12 针对的"父进程死亡 + 环境异常"同源场景 |
| **R3-D2 T2-13 复核（setMetrics 装配）** | `src/index.ts:1006-1008` 接线 + WHY 注释；`ToolManager.ts` wrapHandler 用 `this.metrics?.record` **调用期求值**（本官核验：register 时 wrap、invoke 时读 metrics——装配顺序天然无关）；review03 行为级断言在案 | round1 T14 设计（FastMCP middleware 对照、边界纪律注释原样） | **已收敛（最优）** |
| **R3-D3 T2-14 复核（INV 纪律闭环）** | `inv-selftest.mjs:111-119` INV-79 样本（遥测子检查 replaceAll 注入）+ WHY 注释；`:231-245` 覆盖率报告（非门禁、只增不减由 review 把守）；本轮实跑 11/11 红转 + `样本覆盖 11/79（未验证 pin 68 条）` 输出正确（regex 与 checker L4159 `PASS  ${id}  —  ${desc}` 格式逐字对齐，startsWith 防前缀误配安全） | TS SDK pins 纪律 (b)（新 pin 必 mutation-check 一次）；T2-14 自记后续优先 INV-76/68/71 | **已收敛（最优）**；自然延伸 = 调优项 2（68 条未验证 pin 中外部契约类三条优先补样，覆盖 11/79 → 14/79） |
| **R3-D4 round1 项漂移复查** | T12：`config.ts:138` parseCdpPort 三分支 + `:375` 消费在案；T14：wrapHandler 三件横切 + "不演化成可插拔管道"纪律注释原样；T16：package.json ^1.30.0 = v1 latest（registry 亲测） | round2 R2-D1/D3/D5 结论 | **零漂移** |
| **R3-D5 进程生命周期完整性（T2-12 同域延伸）** | 停机链全景：sync（reaper.stop/monitor.stop）→ steel release（**无界**）→ chrome 停 3s race → tab 恢复 3s race → killAllSync（sync）→ exit(0)。exit 钩子兜底 sync 树杀。另观察：SDK 1.30 `send()` 对 `_stdout` 零 error 监听（stdio.js 白盒）——客户端死亡瞬间若有 in-flight 响应帧写出 → EPIPE → uncaughtException 路径，graceful 步（steel release/tab restore）被跳过，但 exit 钩子仍跑 killAllSync → **不孤儿，仅优雅度降级** | 上游 #1564（EPIPE 家族 open） | 调优项 1 收口唯一无界点后，停机链全路径确定性 ≤ ~7s。EPIPE 观察项 N-1 记档不立项（上游层面问题；不孤儿化；exit 钩子已兜底） |
| **R3-D6 测试与门禁** | 本轮全量：122 files / 1940 pass + 1 skip / 79 INV / inv-selftest 11/11；W-3 移桶后零 flake（review03 结论本轮复证） | conformance 套件（Tier-1 门槛化）定位不变：迁移验收工具非常驻门禁 | **持平偏优（保持）** |
| **R3-D7 doctor/观测面** | doctor.ts 2838 行（round2 2774 → +64）；INV-47 runtime_state / T2-13 metrics 面已可见 | round2 R2-D8 | 维持 R9 处置（自然触碰时顺带拆）；+64/轮斜率稳定，无突变 |
| **R3-D8 发布卫生（新维度）** | npm latest=1.10.0；本地 1.12.0（round2 未 commit、round1 已 commit 未发布） | npm 分发语义（`npx -y lasso-mcp` 是 README 主安装路径） | **流程缺口（非代码）**：两轮 30 项（孤儿修复/假 worked 修复/表格保真/defuddle 激活）未达用户。建议本轮 verdict 后 commit + publish 1.12.0 一次收口 |

---

## 3. 候选调优项（2 条，宁缺毋滥）

> 门槛：①白盒证据差距 ②愿景内既有能力优化 ③代价≤中 ④收益可验证 ⑤不破 INV/tri-state/简单架构。全部零新依赖、单点可回滚。

### 调优项 1（P2）：shutdown 链 steel release 加 3s 上界（T2-12 收尾；实测 301s 挂起边界）

- **对标证据**：① `src/index.ts:1211-1217` `await steelChannel.releaseSession()` 是停机链**唯一无上界 await**——兄弟步 stopLaunchedChromes（:1220-1224）与 restoreTabs（:1230-1234）均 `Promise.race` 3s 封顶，范式已在同函数内；② `SteelChannel.ts:345-366` 裸 fetch 零超时/零 AbortSignal；③ **本机实证**（Node 24.12，Lasso 同运行时）：fetch POST 对 accept-but-silent 端点 **300,978ms** 才 UND_ERR_HEADERS_TIMEOUT；④ stdin_eof 场景 = 父进程死亡 + 环境异常同源——恰是 endpoint 悬挂（自托管 docker 停摆/网络劫持）概率上扬的场景；⑤ `test/integration/stdin-eof-shutdown.spec.ts:65` 注释"shutdown 各收尾步 3s 上界"与事实不符（测试通过仅因无 Steel 会话时 releaseSession 为 no-op——测试盲区即残留证据）。
- **具体改法**：`src/index.ts` steel 段照抄兄弟步范式：
  ```ts
  await Promise.race([
    steelChannel.releaseSession(),
    new Promise<void>((resolve) => setTimeout(() => resolve(), 3_000)),
  ]);
  ```
  （releaseSession 内部已自吞错，race 输者随 process.exit 一并消亡，无残留句柄问题。）顺手：stdin-eof 测试注释改为"无 Steel 会话时秒级；有会话时各步 3s 上界"。可选加固（同 PR 非必须）：SteelChannel 两处 fetch 传 `signal: AbortSignal.timeout(3_000)`（:101 建 session 同治，防请求路径同型悬挂）。
- **预期收益**：stdin_eof 路径全场景确定性 ≤ ~7s 收尾（当前 Steel+悬挂子场景 ≤5min，60 倍）；T2-12 声称的"即时全链收尾"兑现为真；兄弟步范式统一（零新机制）。
- **实施代价**：XS（1 处 race + 注释 1 行 + 用例 1 个：mock steelChannel 悬挂 promise，断言 shutdown 在 3s+ε 内到达 killAllSync/exit——或最小形态：单测 releaseSession 输掉 race 后 exit 不被阻）。
- **风险评估**：近零。release 本就是 best-effort（catch 吞错）；race 后 cachedSessionId 可能未清——进程随即 exit(0)，无后效。

### 调优项 2（P3）：INV-76/68/71 补违规样本（T2-14 记档步骤的执行，覆盖 11/79 → 14/79）

- **对标证据**：`inv-selftest.mjs` 覆盖率报告本轮实测输出"样本覆盖 11/79（未验证 pin 68 条；后续补样本优先外部契约类 INV-76/68/71——round2 T2-14 记档）"——**自报的下一步即本项**。三条全部静态可证伪（本官核验 checker 定义）：INV-76（上游 chrome-devtools-mcp@0.3.0 契约守护 + wave1 修复回归，曾真实漂移过的外部契约类）、INV-68（markdown-extractor 禁 spawn/exec/python——注入一行 exec 即红）、INV-71（config 文件机制——删 loadConfigFileEnv 调用即红）。
- **具体改法**：VIOLATION_SAMPLES 追加三条（沿用既有 replace/replaceAll 注入形态，锚点选各 INV 最脆弱的子检查）。
- **预期收益**：外部契约类 INV（最易随上游/重构静默漂移的类别）获得一次 mutation 实证；覆盖率只增不减纪律从口号变数据；为后续轮次提供红转健康基线。
- **实施代价**：XS（三条样本 + 跑 selftest 验证 14/14 红转；注入机制现成）。
- **风险评估**：近零。临时副本注入、工作树零污染机制既有。

### 观察项（不计入调优项）

- **N-1 EPIPE 优雅度降级（不孤儿）**：SDK 1.30 `send()` 对 stdout 零 error 监听（stdio.js 白盒）——客户端死亡瞬间 in-flight 帧写出 → EPIPE → uncaughtException → graceful 步被跳过，但 exit 钩子 killAllSync 仍收树。不立项（上游 #1564 家族；后果是"不够优雅"非"孤儿"）；v2 迁移时随 W-1 清单一并核对上游是否已治。
- **W-1 SDK v2 迁移验收清单（增补两条）**：原四条不变（conformance 基线 / #2622 listChanged 验证 / codemod dry-run / 保持旧 era）+ ⑤ 上游 #2002 修复若已发版，迁移后移除 Lasso 本地 stdin 钩子并核对上游 transport 语义与 shutdown 链的交互；⑥ Tasks 扩展是 v1/v2 唯一 wire 不兼容面（C# SDK 博客），若届时 CC 支持 Tasks（#18617），迁移与 Tasks 评估需联动排期。Q4 时机因 12 个月 deprecation policy 更宽裕，不提前。
- **W-2 MCP Tasks**：触发条件未满足（CC 仍 open FR），维持 watch。
- **R5 outputSchema / R9 doctor 拆分（+64/轮，斜率稳定）/ FastMCP（仍 beta）/ UTCP / R11**：无新证据，处置全部不变。
- **跨域移交**：round2-review03 遗留 #1（`where.ref` 被 zod 接受但 ax_find 只消费 text/role——纯 ref 查询静默匹配全部节点，tri-state 静默丢参家族，同 T2-5 同族）归属 **desktop 域** round3 处置；本轮仅在本域记"tri-state 家族仍有点位未清"的范式注脚。
- **发布积压（R3-D8）**：非代码项——建议 verdict 官本轮收口时 commit v1.12.0 + npm publish（1.10.0→1.12.0 跨两轮 30 项；README v1.12 段已就位，review03 已 zero-issues）。

---

## 附：判定汇总

| 复审维度 | 判定 |
|------|------|
| R3-D1 T2-12 stdin EOF | 主体最优；steel release 无界 await 残留（实测 301s；调优项 1） |
| R3-D2 T2-13 setMetrics | 已收敛（最优） |
| R3-D3 T2-14 INV 纪律 | 已收敛（最优）；延伸 = 调优项 2 |
| R3-D4 round1 四项 | 零漂移 |
| R3-D5 生命周期完整性 | 一处收尾（调优项 1）+ N-1 观察记档 |
| R3-D6 测试/门禁 | 持平偏优（本轮全量复证零 flake） |
| R3-D7 doctor | 维持（+64/轮，自然触碰时拆） |
| R3-D8 发布卫生 | 流程缺口（commit+publish 建议，非代码） |
| watch/NO-GO 复核 | **零翻案**：R10 时机更宽裕（12 个月 policy）/ W-2 双向加固仍 watch / 其余无新证 |

**核心结论**：round1+round2 本域七项调整中**六项已达最优**（T12/T13/T14/T16/T2-13/T2-14 零残留），唯 T2-12 余一处量级明确的收尾（steel release 无界 await，本机实测 301s 挂起边界——"修复孤儿窗口的路径里藏着一条 5 分钟的悬崖"），一行 race 修复且范式同函数现成。watch/NO-GO 全部零翻案，生态进入 spec 后消化期无结构性新热点。两条候选均为 XS、零新依赖、不动架构。若本轮实施，本域将首次进入"无残留"状态——按 round2-verdict 的收敛轨迹预判，**下一轮本域预期 ROUND-CLEAN**（实施尾巴清偿完毕后循环应自然终止）。

外部来源（本轮实测/检索）：[typescript-sdk #2002](https://github.com/modelcontextprotocol/typescript-sdk/issues/2002) / [PR #4794](https://github.com/modelcontextprotocol/typescript-sdk/pull/4794) / [ext-tasks](https://github.com/modelcontextprotocol/ext-tasks) / [claude-code#18617](https://github.com/anthropics/claude-code/issues/18617) / [2026-07-28 spec blog（deprecation policy）](https://blog.modelcontextprotocol.io/posts/2026-07-28/) / [Cloudflare MCP v2](https://blog.cloudflare.com/mcp-v2/) / [C# SDK v2（Tasks 唯一 wire 断裂）](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/) / [FastMCP releases](https://github.com/PrefectHQ/fastmcp/releases) / npm dist-tags（@modelcontextprotocol/sdk、server、codemod、conformance、chrome-devtools-mcp、lasso-mcp，2026-08-17 亲测）。
