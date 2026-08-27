# 第 5 轮最优性审查 —— 「MCP 架构与工程范式」域（收尾轮）

> 调研员：Round 5（架构域）。日期：2026-08-17。
> 性质：**收尾轮（closure round，round4-verdict §4 定位）**——① 检验 round1 四项（T12/T13/T14/T16）+ round2 三项（T2-12/T2-13/T2-14）+ round3 两项（T3-4/T3-7）+ round4 一项（T4-1，doctor.ts/types.ts 注释卫生与本域 doctor 面交叠）共 **10 项**是否全部维持最优（白盒逐项源码复核）；② 用新证据复核 watch/NO-GO（R5/R9/R10/W-1/W-2/N-1/FastMCP/UTCP/R11）；③ 全新热点。
> 方法升级（本轮关键差异）：**上游 issue 面首次全部改走 GitHub REST API 直验**（`api.github.com/repos/<o>/<r>/issues/<n>` 逐条取 state/state_reason/closed_at），不再沿用搜索引擎转述——该方法学修正本身产出两条前轮证据勘误（见 §1-3/§1-4）。
> 实测基线：**v1.13.0 工作树（HEAD=0b07536 v1.11.0；npm latest=1.10.0；62 文件未 commit）**。本轮门禁全量独立复跑：`build ✓ / npm test 122 files 1960 passed + 1 skipped（1961）零 flake / check-invariants 79/79 ✓ / inv-selftest 14/14 红转 + 样本覆盖 14/79 报告 ✓ 工作树零污染`——与 round4-review03 终态逐项一致。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round1 四项 + round2 三项 + round3 两项 + T4-1（10 项）是否维持最优 | **全部零漂移**（逐项源码锚点亲读）：parseCdpPort（config.ts:138 三分支+warn）、wrapHandler（ToolManager.ts:105-108 三件横切+「不演化成可插拔管道」纪律注释）、setMetrics 接线（index.ts:1008+WHY 注释）、SDK ^1.30.0（=v1 latest）、stdin EOF 双钩子（index.ts:1266-1267+#2002 注释）、INV-79 样本+覆盖率报告（selftest L111+/末行）、steel release 3s race（index.ts:1218-1221）、INV-76/68/71 三样本、T4-1 五处新文案（doctor.ts:37-40/:1907-1908、types.ts:152/:479/:495 全部在案，验收 grep `注入路径健在` 零命中 exit=1 亲跑） |
| round4-verdict 终止条件 ①（T4-1+门禁绿） | **已满足**（round4-review03 zero-issues-pass + 本轮独立复跑复证） |
| round4-verdict 终止条件 ②（commit v1.13.0 + npm publish） | **未执行**——HEAD 仍 0b07536、npm latest 仍 1.10.0、62 文件 dirty；三轮 ≈40 项用户可感知修复（孤儿进程/假 worked/表格保真/locale 一致性）已积压两版+，仍是全项目唯一实质欠账（流程级，归 verdict/用户） |
| R10/O-1（SDK v2 迁移 Q4） | **维持**：registry 六包零变化（sdk 1.30.0/server 2.0.0/codemod 2.0.0/conformance 0.1.16/chrome-devtools-mcp 1.7.0/lasso-mcp 1.10.0，本轮亲测）；12 个月 deprecation policy 继续成立 |
| W-2（MCP Tasks） | **维持 watch，但触发条件距前轮记录更远（证据勘误）**：前轮反复引用的 CC 侧 FR 全部已关且非完成态——#18617 closed **not_planned**（2026-04-07）/ #52137 closed **not_planned**（2026-06-19）/ #31427 closed **duplicate**（2026-03-10）。Anthropic 已明确拒绝 Tasks 客户端支持，「CC 宣布支持」触发不是未到而是被负面裁决过 |
| W-1 六条清单 | **有效，上游双 anchor 直验**：#2002 仍 **open**（stdin close/end 修复未合入——且 registry 无 1.30.1/2.0.1 发版互证；installed 1.30.0 stdio.js start() 白盒仍只有 data/error 两监听）；#2622 仍 **open**（listChanged 静默覆写）。Lasso 本地 stdin 钩子（T2-12）继续必要且唯一 |
| N-1（EPIPE） | **证据勘误，处置不变**：#1564 closed **completed**（2026-03-25）——round3/4「#1564 家族未动」表述过时；但白盒复核 installed 1.30.0 `stdio.js send()`（L69-77）仍无 stdout error 监听（修复或在 protocol.js 层 .catch 路由 L743/L857）。「不孤儿、仅优雅度降级、exit 钩子兜底」的定性不变，继续归 W-1 ⑥ 随 v2 迁移核对 |
| R5 / R9 / FastMCP / UTCP / R11 | 无翻案：doctor.ts 2863→**2864 行（+1/轮，斜率 +67→+64→+25→+1 趋零）**——R9「自然触碰时拆」处置继续且信号持续改善；FastMCP PyPI stable 仍 3.4.7、v4 仍 4.0.0b3 beta 无 GA（注：npm `fastmcp@4.15.1` 是**同名异包**的 JS 框架，非 PrefectHQ Python 线，对标锚须用 PyPI）；UTCP/R11 零声量 |
| 全新热点 | **无**（连续第四轮消化期判定）：检索面仍为 listicle 噪音 + 官方配套成熟化；Rust 框架脉冲（pulseengine/mcp 等）与 Lasso（TS 主体+微型 rust-helper）无对标增量 |
| 候选调优项 | **空集**（§3 五门槛逐条）——与 round4 ROUND-CLEAN 裁决及终止协议一致 |

---

## 1. 本域事实清单（round4 之后的增量）

| # | 事实 | 实测/来源 | 与 Lasso 的关系 |
|---|------|----------|----------------|
| 1 | **registry 六包零变化**：`@modelcontextprotocol/sdk` v1 latest=1.30.0（1.x 末位，无 1.30.1）/ `@modelcontextprotocol/server`=2.0.0（零补丁线）/ codemod=2.0.0 / conformance=0.1.16 / chrome-devtools-mcp=1.7.0 / **lasso-mcp=1.10.0**（local 1.13.0 未 commit 未发布） | 本机 `npm view` 亲测（2026-08-17） | round4-verdict 设定的 surveillance 重启条件（「registry/上游 issue 面出现版本级变动」）**未触发**——四域静默验收协议继续成立；选型面零漂移 |
| 2 | 上游 **#2002 仍 open**（Bug: StdioServerTransport doesn't handle stdin close/end）；**#2622 仍 open**（listChanged 静默覆写） | GitHub REST API 直验（经代理），state/state_reason/closed_at 三字段 | T2-12 本地 stdin 钩子继续必要且唯一；W-1 ②⑤ 两条验收项继续有效；与 registry 无发版互证自洽 |
| 3 | **证据勘误 ①（W-2 触发条件）**：CC Tasks 三条 FR 全部已关且非完成——#18617 not_planned（04-07）、#52137 not_planned（06-19）、#31427 duplicate（03-10）。round2/3/4 多处「#18617 仍 open」表述过时（该 issue 在前几轮运行前一个多月即已关闭） | GitHub REST API 直验 | **不构成翻案、反而加固 watch**：原触发条件「CC 宣布支持」被官方负面裁决（not_planned ≠ 未排期，是拒绝）。W-2 语义修正为「CC 已拒绝 Tasks 客户端支持；仅当立场反转才重评」。附带：#52137 点名的 60s 硬超时痛点同样未获正面回应，Lasso 长时操作的工具侧分段/状态盘设计继续自扛 |
| 4 | **证据勘误 ②（N-1 EPIPE）**：#1564 closed **completed**（2026-03-25）——round3「上游 #1564 家族 open」/ round4「未动」表述过时；但 installed 1.30.0 白盒：`stdio.js send()`（L69-77）`_stdout.write` 无 error 监听、`start()`（L33-40）仍只挂 data/error；protocol.js 侧 request/notification 的 send 带 `.catch → _onerror`（L743/L857），response 路径在 await 链内 | GitHub API + node_modules 白盒双源 | N-1 处置不变（不孤儿、仅优雅度降级）：Lasso 的 exit 钩子 killAllSync 兜底覆盖该场景。W-1 增补注脚：v2 迁移核对上游 EPIPE 处理现状时，**不能以 #1564 已关推定已修**——须重读目标版本 stdio.js（本轮已示范该方法） |
| 5 | FastMCP：PyPI latest=3.4.7（stable 线），v4 仍 4.0.0b3（无 b4/GA）；npm `fastmcp`=4.15.1 系**同名异包**（JS 框架，非 PrefectHQ Python 线） | PyPI JSON API + npm 亲测 | 「不 FastMCP-化」裁决（round1）第五轮维持；对标锚固定为 PyPI 线。同名异包事实记档，防后续轮次误引 |
| 6 | MCP 生态面：10k+ servers / ~97M 月下载量级延续；Rust 框架讨论升温（pulseengine/mcp 等中型项目）；无架构范式级新项目（无新 middleware/registry/lifecycle 范式进入前十热榜） | 检索（多源交叉） | 连续第四轮「spec 后消化期」判定成立；Rust 框架脉冲与 Lasso 无对标面（Lasso 主体 TS，rust-helper 是 AXAPI 薄封装非 MCP 框架） |
| 7 | **发布收口仍未执行**：HEAD=0b07536（v1.11.0）/ npm latest=1.10.0 / 工作树 62 文件 dirty（package.json=1.13.0） | git + npm 亲测 | round4-verdict 附则一（一次性 commit + publish）是**当前全项目唯一实质欠账**；每延迟一天，孤儿进程修复（T2-12/T3-4）等用户可感知项多压一版。属流程级动作，非本域代码调优项 |

**清单结论**：round4 → round5 本域零结构性新热点、registry 冻结、上游关键 issue 零状态变化（#2002/#2622 均 open）——surveillance 重启条件未触发。本轮真正的方法学产出是**上游证据勘误两条**（W-2 触发条件被官方负面裁决 / #1564 已关但 1.30.0 未含 transport 级修复）：两条都不改变任何既有裁决方向，反而都加固「维持现状」。前几轮依赖搜索引擎转述 issue 状态的做法（已被证明会引用已关闭数月的 issue 为「open」）应成为后续轮次（若存在）的固定反面教材：**issue 状态必须 REST API 直验**。

---

## 2. 白盒对标表（round5 收尾验收维度）

| 维度 | Lasso 现状（源码锚点，本轮实测） | 对标锚点 | 判定 |
|------|------|------|---------|
| **R5-D1 10 项零漂移复核** | T12：`config.ts:138-151` parseCdpPort（undefined/空串→默认、NaN→默认+warn、越界→默认+warn）+ `:375` 消费；T14：`ToolManager.ts:105-108` wrapHandler（error/log/timing 三件 + 「**不演化成可插拔管道**」边界注释原样）；T2-13：`index.ts:1006-1008` setMetrics 接线 + WHY 注释（「全仓生产零调用（仅测试可达）」的动机记录）；T16：`package.json` ^1.30.0 = v1 latest；T2-12：`index.ts:1266-1267` stdin 双钩子 + #2002 注释（幂等论证完整）；T2-14/T3-7：`inv-selftest.mjs` L111+ INV-79 样本、INV-76/68/71 三样本，本轮实跑 14/14 红转；T3-4：`index.ts:1218-1221` steel race 3s + 注释含 301s 实测出处；T4-1：五处新文案逐处亲读与 round4-verdict §2 逐字一致，`grep -rn "注入路径健在" src/` exit=1 零命中 | round1/2/3/4 各自记档锚点 | **零漂移（10/10）** |
| **R5-D2 门禁独立复跑** | build ✓ / npm test 122 files **1960 passed + 1 skipped（1961）零失败零 flake** / check-invariants **79/79** / inv-selftest **14/14 红转 + 工作树零污染** + 覆盖率报告输出正常（`样本覆盖 14/79`） | round4-review03 终态基线（1961/79/14/207） | **逐项一致**（本轮未跑 cargo——rust-helper 自 round3-review03 后无改动，git status 佐证 ax.rs/cgevent.rs 修改均属 round3 已验收范围） |
| **R5-D3 doctor/观测面（R9 斜率追踪）** | doctor.ts **2864 行**（2707→2774→2838→2863→2864：+67/+64/+25/**+1**）；T4-1 两处改动即本轮全部增量（注释行替换，净 +1 行） | R9「下次自然加 check 时顺带拆」处置 | **维持且信号趋稳**：斜率连续三轮单调下降至 ~0——「膨胀」叙事实际已终止（近两轮增量全部是注释卫生/文案对齐类，非新机制）。R9 拆分的触发条件（自然加 check）更远，处置不变 |
| **R5-D4 上游证据面方法学修正（新维度）** | 本域 round2/3/4 对 issue 状态的引用（#18617「open」×3 轮、#1564「未动」×2 轮）经 REST 直验全部为过时转述 | GitHub REST API（state/state_reason/closed_at） | **落后的是证据方法而非代码**：已在本轮修正（§1-3/1-4）。Lasso 代码面对这些勘误的响应=零（处置全部维持），恰好说明前几轮在「无新证据不翻」纪律下没有基于错误证据做出过任何错误决策——纪律本身吸收了证据噪声。记档：后续轮次 issue 状态必须直验 |
| **R5-D5 watch/NO-GO 全量复核** | R5 outputSchema（零新证）/ R10 v2 Q4（registry 冻结+12 个月 policy）/ W-1 六条（#2002 #2622 直验 open，两条 anchor 有效）/ W-2（触发条件勘误后更远）/ N-1（#1564 勘误，处置不变）/ FastMCP（PyPI 无 GA）/ UTCP / R11（零声量） | §1 全部实测 | **零翻案；两条证据勘误均方向加固** |

---

## 3. 候选调优项

**空集。**

五门槛逐条：

1. **白盒证据差距**——10 项历史调整全部零漂移（§2 R5-D1）；本轮白盒复查（含 installed SDK stdio.js 直读、五处 T4-1 文案、14 样本红转）未发现任何新的源码级差距。
2. **既有能力范畴**——无可优化对象：停机链全路径有界（steel 3s race 亲验）、INV 纪律闭环（79 全绿 + 14/14 红转 + 覆盖率报告）、横切收拢装配完成、config 数值守卫归一、SDK 版本拉满、注释卫生族清尾。
3. **单轮可完成 / 收益可验证**——无候选自然豁免。
4. **不破红线**——反向确认：闭轮阶段为找事而立项（如全量 79 样本、doctor 预防性拆分、outputSchema 提前铺、W-2 押注 Tasks）均违「简单架构/单人可持续」红线或已被官方负面裁决证伪，round1-4 已逐项裁掉。
5. **终止协议一致性**——round4-verdict 明确「T4-1 落地且发布完成即达终态 ROUND-CLEAN，循环终止」；T4-1 已验收，本轮若新开调优项即违终止协议。唯一未闭合项（发布收口）是流程动作而非代码调优项。

---

## 4. 观察项与流程收口（非调优项）

- **P-1 发布收口（全项目唯一实质欠账，最优先）**：一次性 commit v1.13.0（62 文件已在工作树，门禁四链已三轮+本轮四度复证全绿）+ `npm publish`。npm latest=1.10.0 与本地 1.13.0 跨两版三轮 ≈40 项修复（孤儿进程/假 worked/表格保真/where.ref/locale 一致性/region 坐标补偿）。归 verdict/用户动作。
- **P-2 手测清单 A-G 用户真机签核**（含 T3-1 Accept-Language 全链；E1'' 已机制层预验）——随发布同窗口完成。
- **W-1 SDK v2 迁移验收清单（六条，维持；Q4-2026 时机不变）**：① conformance 基线 → ② #2622/#1488 listChanged 验证 → ③ codemod dry-run → ④ 保持旧 era → ⑤ #2002 修复发版后移除本地 stdin 钩子（本轮直验：仍 open、无发版）→ ⑥ Tasks 若 CC 立场反转则联动评估（注脚勘误：现行立场=not_planned 拒绝，见 W-2）。
- **W-2 MCP Tasks（watch，语义勘误）**：触发条件从「CC 宣布支持（FR open 中）」修正为「CC 立场反转（三条 FR 已全部关闭：not_planned×2 + duplicate×1）」——比前轮记录更远。ext-tasks 已入正式 spec 与 CC 捆绑 SDK 已实现协议栈两事实不变（round3/4 已记），缺的纯是应用层意愿，且意愿已表达为拒绝。
- **N-1 EPIPE（处置不变，证据勘误记档）**：#1564 closed completed（2026-03-25）但 installed 1.30.0 `send()` 仍无 stdout error 监听——「issue 已关 ≠ 版本已修」，v2 迁移核对时须直读目标版本源码（本轮方法示范：stdio.js L33-40/L69-77）。
- **R9 doctor 拆分（维持，斜率趋零）**：+1/轮；继续「下次自然加 check 时顺带拆」，不主动立项。
- **R5 outputSchema / FastMCP / UTCP / R11**：零新证据，维持原判（FastMCP 对标锚固定 PyPI 线，防 npm 同名异包误引——§1-5）。
- **方法学记档（供后续轮次，若存在）**：上游 issue 状态必须 GitHub REST API 直验；本域 round2-4 共 5 处 issue 状态引用为过时转述（#18617×3、#1564×2），全部经本轮直验勘误。该教训与 Lasso INV 体系的「pin 必须红过一次」同构：**引用外部状态而不验证 = 假绿 pin 的生态版**。

---

## 附：判定汇总

| 验收维度 | 判定 |
|------|------|
| R5-D1 历史 10 项 | 零漂移（10/10 源码锚点复核） |
| R5-D2 门禁独立复跑 | 与 round4-review03 终态逐项一致（1961/79/14，零 flake） |
| R5-D3 doctor | R9 维持；斜率 +1/轮趋零，「膨胀」叙事实际已终止 |
| R5-D4 上游证据方法 | 勘误两条（W-2 触发条件被官方负面裁决 / #1564 已关但未含修复）；零代码影响 |
| R5-D5 watch/NO-GO | **零翻案**（registry 冻结 / #2002 #2622 open 直验 / FastMCP 无 GA） |
| 候选调优项 | **空集**（终止协议一致） |
| 流程收口 | P-1 commit+publish v1.13.0 / P-2 手测 A-G 签核（唯一未闭合，非代码） |

**核心结论**：本域 10 项历史调整全部零漂移、门禁四度复证全绿、registry/上游 issue 面零版本级变动——round4-verdict 设定的 ROUND-CLEAN 终态在代码面成立且经受住了收尾轮复验。本轮新产出是证据方法学层面的两条勘误（CC Tasks 三 FR 全部被官方拒绝而非「open 待支持」；#1564 已关但 1.30.0 未含 transport 级修复），两条均不构成翻案、反而加固全部既有裁决。**候选调优项空集**；唯一未闭合项是发布收口（commit v1.13.0 + npm publish）与手测签核，均为流程/用户动作。本域建议 round5-verdict：arch 域 ROUND-CLEAN 维持，循环按终止协议收敛；若后续仍需 surveillance，重启条件（registry/上游 issue 版本级变动）与验证方法（REST 直验）均已在本报告固化。

外部来源（本轮实测/直验）：GitHub REST API（typescript-sdk #2002/#2622/#1564、claude-code #18617/#31427/#52137，state/state_reason/closed_at 直取）/ npm dist-tags（@modelcontextprotocol/sdk、server、codemod、conformance、chrome-devtools-mcp、lasso-mcp、fastmcp，2026-08-17 亲测）/ PyPI JSON API（fastmcp）/ node_modules 白盒（@modelcontextprotocol/sdk@1.30.0 dist/esm/server/stdio.js、shared/protocol.js）/ Lasso 源码 10 锚点 + T4-1 五处 + 门禁四链（本机全量独立复跑）。
