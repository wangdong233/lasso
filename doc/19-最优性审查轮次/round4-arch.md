# 第 4 轮最优性审查 —— 「MCP 架构与工程范式」域（验收轮）

> 调研员：Round 4（架构域）。日期：2026-08-17。
> 性质：**验收轮**（round3-verdict 附则三定位）——① 检验 round1 本域四项（T12/T13/T14/T16）+ round2 三项（T2-12/T2-13/T2-14）+ round3 两项（T3-4/T3-7）共 **9 项**是否全部达最优（白盒逐项抽验新代码）；② 用新证据复核 watch/NO-GO（R5/R9/R10/W-1/W-2/N-1/FastMCP/UTCP）；③ 全新热点。不重复已裁决内容（对标基线见 round1/2/3-arch.md）。
> 实测基线：**v1.13.0 工作树（round3 T3-1..7 + review03 R03-R3-1 落地，未 commit；HEAD=0b07536 v1.11.0；npm latest=1.10.0）**。
> 本轮门禁全量独立复跑：`build ✓ / npm test 122 files 1960 passed + 1 skipped 零 flake / check-invariants 79/79 ✓ / inv-selftest 14/14 红转 + 样本覆盖 14/79 报告 ✓`——与 round3-review03 终态（zero-issues-pass）逐项一致。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round3 T3-4（steel release 3s 上界）是否最优 | **达最优且超规格**：双层上界（index.ts race 3s 第一层 + SteelChannel 两处 fetch `AbortSignal.timeout(3s)` 第二层）——round3 标注"可选加固"的两处 fetch 也全做了；失败路径仍清 `cachedSessionId`（防悬挂会话复活复用，review03 未要求，实施自加的正确语义）；行为级定时测试在案（mock accept-but-silent fetch + AbortSignal 契约断言 + ≥2.5s ≤6s 窗口） |
| round3 T3-7（INV-76/68/71 样本）是否最优 | **达最优**：本轮实跑 `inv-selftest` **14/14 红转**（INV-76 toFnExpression 绕过 / INV-68 spawn-python / INV-71 合并丢失三条样本注入形态各异、锚点各选最脆弱子检查）；覆盖率报告实测输出 `样本覆盖 14/79（…外部契约类 INV-76/68/71 已于 v1.13 T3-7 覆盖）` |
| round1+round2 本域 7 项是否漂移 | **零漂移**（逐项源码锚点复核）：parseCdpPort（config.ts:138/375 三分支）；wrapHandler + `toolManager.setMetrics(metrics)` 接线（index.ts:1006-1008，WHY 注释在案）；SDK `^1.30.0` = v1 latest（registry 亲测无 1.30.1）；stdin EOF 双钩子（index.ts:1251-1259，幂等论证注释原样）；INV-79 样本 + 覆盖率报告（selftest L111-119/L264-277） |
| 新 INV 纪律一致性（round2 R2-D4 复发检查） | **纪律维持**：v1.12/v1.13 未新增 INV（仍 79 条）——无"新 INV 必须注册样本"的欠账；T3-7 反向把覆盖 11→14 |
| R10/O-1（SDK v2 迁移 Q4） | **维持，registry 冻结**：v1 latest 仍 1.30.0（无 1.30.1）/ v2=2.0.0 零补丁线 / codemod 2.0.0 / conformance 0.1.16（全部 2026-08-17 本机 registry 亲测）；12 个月 deprecation policy（round3 已证）继续成立，Q4 时机宽裕 |
| W-2（MCP Tasks 扩展） | **仍 watch，新证据微正向但不满足触发条件**：CC 客户端支持仍是 open FR（anthropics/claude-code#18617 未关，且派生 #31427/#52137 两条后续 FR——#52137 点名 CC 的 MCP 客户端 60s 硬超时是长时工具调用痛点，Tasks 是根治方案）；社区分析显示 **CC 捆绑的 TS SDK 已实现完整 Tasks 协议、缺口纯在应用层 callTool() 未暴露**——方向信号正向，但"CC 宣布支持"触发条件仍未满足，不翻 |
| 上游 #2002（stdin EOF） | **修复已进仓仍未发版**：修复 PR 已有 CI run 在案（检索呈现 #2274，round3 记档 #4794，两号同题"fix(server): exit when MCP client closes stdin pipe"——PR 号存疑不影响实质）；**npm v1/v2 线均无包含该修复的发版**（本机 registry 亲测）→ Lasso 本地 stdin 钩子（T2-12）继续必要，与上游未来发版共存安全（shutdown 幂等）；W-1 ⑤ 已预案 |
| #2622（v2 listChanged 覆写） | **维持 open**，且检索出同族更早的 #1488（维护者立场已明示"Setting the capabilities shouldn't be a side-effect of registering a tool"）——W-1 ② 迁移验收项继续有效，无翻案 |
| R5 / R9 / N-1 / FastMCP / UTCP / R11 | **无新证据，全部维持**：doctor.ts 2838→2863 行（**+25/轮，斜率从 +64 显著放缓**——R03-R3-1 重构净增仅微秒级 4 profile 字符串构造）；FastMCP 4 仍 beta（4.0.0b3 = 2026-08-14，3.x 仍 stable 线）；UTCP/R11 零声量 |
| 全新热点 | **无**。生态处于 2026-07-28 spec 后消化期（round3 判定的延续）：增量全是配套成熟化（#2002 修复在途 / conformance 门槛化 / 官方 SDK 快速迭代节奏未变）；8 月 MCP Dev Summit（Seoul/Bengaluru）与"State of MCP Security 2026"（50+ 已知漏洞库）属生态事件非范式变更，对 Lasso 架构面无对标增量 |
| **本域唯一未闭合项** | **非代码**：发布收口——round3-verdict 附则一指令"门禁绿后一次性 commit + npm publish v1.13.0"未执行（HEAD 仍 0b07536、npm latest 仍 1.10.0，**三轮 ≈40 项用户可感知修复积压**，含孤儿进程/假 worked/表格保真）；附则二手测清单 A-G 待用户签核。两项均归 verdict 官/用户动作，arch 域代码面无残留 |

---

## 1. 本域事实清单（round3 之后的增量）

| # | 事实 | 实测/来源 | 与 Lasso 的关系 |
|---|------|----------|----------------|
| 1 | npm 生态面五包**全部零变化**：`@modelcontextprotocol/sdk` v1 latest=1.30.0（versions 末位亲测）/ `@modelcontextprotocol/server`=2.0.0（零补丁）/ codemod=2.0.0 / conformance=0.1.16 / chrome-devtools-mcp=1.7.0 | 本机 `npm view` 亲测（2026-08-17） | 选型面零漂移；round1/2/3 全部选型裁决无需重开；R10 的 Q4 评估输入不变 |
| 2 | 上游 #2002（StdioServerTransport 不监听 stdin close/end → 孤儿进程）修复 PR 已在仓（CI run 在案；检索呈现 #2274 / round3 记档 #4794，同题两号存疑），**未进任何 npm 发版** | GitHub PR/Actions + npm dist-tags | T2-12 本地钩子继续必要且唯一；上游发版后共存安全（幂等）；v2 迁移时按 W-1 ⑤ 核对上游语义后可移除本地钩子 |
| 3 | CC Tasks 支持仍 open FR（#18617），派生 #31427（async/background 模式）与 #52137（点名 60s 硬超时 + "CC 捆绑 SDK 已实现完整 Tasks 协议、缺口在应用层"） | GitHub issues 检索 | W-2 触发条件未满足；新证据（捆绑 SDK 协议已备）把未来支持的成本预估下调——记入 W-2 注脚，不改变 watch 处置 |
| 4 | #2622 仍 open；同族 #1488 更早（维护者立场：能力声明不应是注册工具的副作用） | GitHub issues 检索 | W-1 ②（v2 迁移必验 listChanged 语义）继续有效 |
| 5 | FastMCP：v4 仍 beta（4.0.0b3，2026-08-14），stable 线仍 3.x | gofastmcp.com/updates + GitHub releases 亲测 | "不 FastMCP 化"裁决（round1）维持；v4 GA 前无重评基础 |
| 6 | MCP 生态事件：10k+ servers / ~97M installs 里程碑、MCP Dev Summit Seoul(08-13/14)+Bengaluru、State of MCP Security 2026（50+ 漏洞、13 critical） | 生态报道 | 非范式变更。安全报告侧写"生态漏洞面扩大"但 Lasso 攻击面（本地 stdio + 单用户）与报告主要场景（公网 HTTP server / 供应链）错位，无对标增量 |
| 7 | **lasso-mcp npm latest = 1.10.0**（本地 v1.13.0 三轮改动未 commit 未发布） | npm view 亲测 | round3 附则一未执行——三轮 ≈40 项修复（孤儿/假 worked/表格保真/defuddle 激活/locale 一致性/region 坐标补偿）未达 npx 用户；arch 域唯一未闭合项（流程级） |

**清单结论**：round3 → round4 本域**零结构性新项目、零范式变更**——生态消化期判定连续第三轮成立。所有增量都是"官方配套在途"（#2002 修复在仓未发 / Tasks FR 派生加深）。Lasso 架构面（四通道 + CapabilityBag + INV 体系 + v1 SDK 拉满 + 停机链全路径有界）处在稳定最优区间。

---

## 2. 白盒对标表（round4 验收维度）

| 维度 | Lasso 现状（源码锚点，本轮实测） | 对标锚点 | 判定 |
|------|------|------|---------|
| **R4-D1 T3-4 验收（停机链全路径有界）** | `src/index.ts` shutdown：steel 段 `Promise.race([releaseSession(), 3s])`（T3-4 注释含 301s 实测出处与"race 输者随 exit 消亡"论证）；`SteelChannel.ts:107`（建 session）与 `:360`（release）两处 fetch 均传 `AbortSignal.timeout(3_000)`——**二层上界**；release 失败（含 abort）catch 吞错后**仍清 cachedSessionId/cachedClient**（死会话不复用）；`test/unit/steel-channel.spec.ts:583` 行为级定时测（悬挂 fetch 只响应 abort + 断言 fetch 收到 signal 实例 + 时间窗）；`stdin-eof-shutdown.spec.ts:65-67` 注释已归真（"悬挂 endpoint 场景由 steel-channel.spec T3-4 单测覆盖"——测试盲区自认并闭环） | round3 T3-4 修法原文（race + "可选加固 AbortSignal"） | **达最优且超规格**。停机链五步全部有界：sync 停表（reaper/monitor）→ steel ≤3s（双层）→ chrome ≤3s → tab restore ≤3s → killAllSync（sync）→ exit 钩子兜底。T2-12+T3-4 合起来把"CC 异常退出"场景从 ≤1h 孤儿窗口收敛到全场景 ≤~7s 确定性收尾——round2 调优项 1 的完整兑现 |
| **R4-D2 T3-7 验收（INV 纪律）** | `scripts/inv-selftest.mjs`（279 行）：VIOLATION_SAMPLES 14 条（round2 10 + T2-14 补 INV-79 + T3-7 补 76/68/71）；三条新样本锚点选最脆弱子检查（INV-76(a) toFnExpression 绕过 / INV-68(a) spawn-python 第三运行时 / INV-71(b) 丢 file→env 合并）；覆盖率报告 `样本覆盖 14/79（未验证 pin 65 条；外部契约类…已覆盖）` 本轮实跑输出正确 | TS SDK pins 纪律（新 pin 必 mutation-check 一次） | **达最优**。外部契约类（最易随上游静默漂移的类别）全部获 mutation 实证；65 条未验证 pin 的缺口已显性化（报告非门禁、只增不减由 review 把守）——按需补样的诚实中间解已定型，无需再推进（全量 79 样本 = 高维护负担，违单人可持续） |
| **R4-D3 round1 四项 + round2 三项零漂移复核** | T12：parseCdpPort `config.ts:138`（三分支）+ `:375` 消费；T13/T2-14：selftest 机制 + 覆盖率报告；T14/T2-13：wrapHandler 三件横切 + `index.ts:1008` setMetrics 接线（1006 行 WHY 注释在案）；T16：`package.json` ^1.30.0；T2-12：stdin 双钩子 + 幂等注释（index.ts:1251-1259） | round1/2/3 各自记档锚点 | **零漂移**（7/7 逐项源码核对通过） |
| **R4-D4 门禁独立复跑** | build ✓ / npm test **122 files 1960 passed + 1 skipped 零 flake** / INV **79/79** / inv-selftest **14/14 红转 + 零污染** | round3-review03 终态（1961/79/207/14） | **逐项一致**（本轮未跑 cargo——rust-helper 本域无改动，round3-review03 已 207 绿且此后 ax.rs/cgevent.rs 的 T3-2/T3-3/T3-6 改动经其复跑） |
| **R4-D5 doctor/观测面** | doctor.ts 2863 行（2838→**+25**，斜率 +67→+64→+25 放缓）；增量 = R03-R3-1 把 #25 stealth 检查从"注释承载"（L0）升级为"producer 直验"（L1，逐 profile 直验 UA override 脚本） | round1 D5「Lasso 优」+ R9「自然触碰时拆」 | **维持且信号改善**：膨胀斜率显著放缓 + 本轮增量是证据等级升级（净健康增益）——R9 拆分处置继续成立 |
| **R4-D6 watch/NO-GO 全量复核** | R5 outputSchema（零新证）/ R10 v2 Q4（registry 冻结 + 12 个月 policy）/ W-1 六条清单（有效）/ W-2 Tasks（FR 未关 + 捆绑 SDK 已备的正向注脚）/ N-1 EPIPE（#1564 家族未动）/ FastMCP（仍 beta）/ UTCP / R11 | 本轮检索 + registry 亲测 | **零翻案**。唯一注脚：W-2 的"CC 侧支持成本已下降"（捆绑 SDK 协议已实现）让触发后的实施预估更乐观，但不构成触发 |

---

## 3. 候选调优项

**空集。**

依据（五门槛逐条）：

1. **白盒证据差距**——本域三轮 9 项调整全部验收通过（§2 R4-D1..D3），源码层零残留；唯一发现的差距是流程级（发布收口未执行），不是代码可调优点。
2. **既有能力范畴**——无可优化对象：停机链全路径有界、INV 纪律闭环（新 INV 零欠账 + 外部契约类全覆盖）、横切收拢装配完成、config 数值守卫归一、SDK 版本拉满。
3. **单轮可完成 / 收益可验证**——无候选自然豁免。
4. **不破红线**——反向确认：本轮若为找事而立项（如全量 79 样本、doctor 预防性拆分、outputSchema 提前铺）恰是违"简单架构/单人可持续"红线的过度设计，round1/2/3 已逐项裁掉且无新证据翻案。

这正是任务书预设的合法结论形态：**三轮实施尾巴清偿完毕，本域代码面进入无残留状态**——与 round3-arch 预言（"若本轮实施，下轮预期 ROUND-CLEAN"）和 round3-verdict 附则三（round4 = 验收轮）一致。

---

## 4. 观察项与流程收口（非调优项）

- **P-1 发布收口（本域唯一未闭合项，非代码）**：round3-verdict 附则一指令未执行——HEAD=0b07536（v1.11.0）、npm latest=1.10.0、工作树含 round2+round3+review03 全部改动（v1.13.0）。门禁已三轮复证全绿（本轮再证一次），**建议 verdict 官本轮直接执行：一次性 commit（v1.13.0 语义化版本号已就位）+ npm publish**。每延迟一轮，孤儿进程修复/假 worked 修复等用户可感知项就多压一版。
- **P-2 手测签核**：清单 A-G（round2 A-E + Accept-Language echo / T3-2 真机 VLM / T3-6 权限场景）待用户真机执行签核（round3-review03 §2.5 遗留 1）——三轮质量证据链的最后一环，随发布同窗口完成。
- **W-1 SDK v2 迁移验收清单（六条，维持）**：① conformance 基线 → ② #2622/#1488 listChanged 验证 → ③ codemod dry-run → ④ 保持旧 era → ⑤ #2002 修复发版后移除本地 stdin 钩子并核对上游语义 → ⑥ Tasks 若届时 CC 支持，与迁移联动排期。Q4-2026 时机不变（12 个月 policy 宽裕）。
- **W-2 MCP Tasks（watch，注脚增补）**：触发条件不变（CC 宣布支持，#18617 仍 open）；新注脚——CC 捆绑 TS SDK 已实现完整 Tasks 协议（缺口纯应用层），支持落地后 Lasso 长时 browse/desktop 操作的 Tasks 化成本预估下调。同时注意它是 v1/v2 唯一 wire 不兼容面（round3 已证）。
- **R9 doctor 拆分（维持，信号改善）**：+25/轮（斜率放缓）；继续"下次自然加 check 时顺带拆"，不主动立项。
- **R5 outputSchema / N-1 EPIPE / FastMCP / UTCP / R11**：零新证据，维持原判。

---

## 附：判定汇总

| 验收维度 | 判定 |
|------|------|
| R4-D1 T3-4 停机链有界 | 达最优且超规格（双层上界 + 死会话清理 + 行为级定时测） |
| R4-D2 T3-7 INV 纪律 | 达最优（14/14 红转；外部契约类全覆盖；覆盖率报告定型） |
| R4-D3 round1/2 七项 | 零漂移（7/7 源码锚点复核） |
| R4-D4 门禁独立复跑 | 与 review03 终态逐项一致（1961/79/14，零 flake） |
| R4-D5 doctor | 维持 R9 处置；膨胀斜率 +25/轮显著放缓，证据等级净升级 |
| R4-D6 watch/NO-GO | **零翻案**（registry 冻结 / #2622 族仍 open / FastMCP 仍 beta） |
| 候选调优项 | **空集**（代码面无残留——ROUND-CLEAN 成立） |
| 流程收口 | P-1 commit+publish v1.13.0 / P-2 手测 A-G 签核（唯一未闭合，非代码） |

**核心结论**：本域三轮 9 项调整**全部达最优、零漂移、零残留**——round3 预言的 ROUND-CLEAN 在 arch 域成立。生态连续第三轮无结构性新热点（spec 后消化期），watch/NO-GO 全部零翻案且无一项被新证据动摇。本域对 round4-verdict 的建议输入：**arch 域 ROUND-CLEAN；唯一动作是执行 round3 附则一/二（commit + publish v1.13.0 + 手测签核），这是流程收口而非代码调优**。循环在本域应终止；若后续轮次仍需运行，本域预期持续空集（除非 registry/上游 issue 面出现结构性变化，即 §1 清单所列事实发生版本级变动）。

外部来源（本轮实测/检索）：[typescript-sdk #2002](https://github.com/modelcontextprotocol/typescript-sdk/issues/2002) / [修复 PR CI run（#2274 呈现）](https://github.com/modelcontextprotocol/typescript-sdk/actions/runs/25197511854) / [#2622](https://github.com/modelcontextprotocol/typescript-sdk/issues/2622) / [#1488](https://github.com/modelcontextprotocol/typescript-sdk/issues/1488) / [claude-code#18617](https://github.com/anthropics/claude-code/issues/18617) / [#52137](https://github.com/anthropics/claude-code/issues/52137) / [FastMCP Updates](https://gofastmcp.com/updates) / [Cloudflare MCP v2](https://blog.cloudflare.com/mcp-v2/) / [State of MCP Security 2026](https://pipelab.org/blog/state-of-mcp-security-2026/) / npm dist-tags（@modelcontextprotocol/sdk、server、codemod、conformance、chrome-devtools-mcp、lasso-mcp，2026-08-17 本机亲测）。
