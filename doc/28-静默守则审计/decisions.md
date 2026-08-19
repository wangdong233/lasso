# 28 · 静默守则审计 —— 自动化候选裁决记录（decisions.md）

- **日期**：2026-08-19
- **裁决官**：修复与文档官（doc/28 第三轮；输入 = audit.md §4 分级 + verify.md 真机矩阵 + 用户授权「GO 项实施；候选如登录完成自动 hide 若裁决 GO——注意防误判：检测登录墙消失 + 延迟 N 秒 + 仅对 lasso 台账 Chrome + 失败降级不 hide」）
- **宪法**：「能够后台静默执行就尽量后台静默执行；不能完全静默则用户介入后**及时恢复**静默执行」
- **实施记录**：GO 两项见同目录 `fix-2.md`；本文件是裁决台账（含 DECISION 项决策文档与 NO-GO 理由固化）。

## 0. 裁决总表

| 项 | audit 分级 | 本轮裁决 | 去向 |
|---|---|---|---|
| D-5 exit 钩子杀 visible Chrome（verify 新发现） | —（audit 未覆盖，verify §6 建议「升级为独立修复轮」） | **GO（缺陷修复，非候选）** | ✅ 已实施（fix-2 §1） |
| C2 登录完成自动 hide | DECISION（「opt-in 默认 off；依赖 C3 落地后再议」） | **GO（opt-in 默认 off）** | ✅ 已实施（fix-2 §2） |
| C1 admin `chrome_launch` action | DECISION（「建议做，但走独立裁决轮」） | **维持 DECISION**（交用户裁决，见 §2） | ⏸ 决策文档 |
| C3 NEEDS_MANUAL_2FA 生产者实装 | DECISION（「建议做，判据设计需单独评审」） | **维持 DECISION**（交用户裁决，见 §3） | ⏸ 决策文档 |
| C4 无 Chrome 全自动恢复链 | DECISION（「整链不建议本轮做」） | **NO-GO（现阶段）**（见 §4） | ⛔ 理由固化 |
| N1-N4 | NO-GO | **维持 NO-GO** | ⛔ 理由固化（§5） |

## 1. C2 裁决 GO 的理由与边界（为何推翻 audit 的「依赖 C3 再议」）

**audit 的保留点**：C2 判据「登录墙消失」复用 D-3 的检测器，而 C3（词表假阳性 + worked→didnt 行为变化）未落地，故「依赖 C3 落地后再议」。

**本轮裁决 GO 的三个依据**：

1. **依赖解耦**：实施采用**独立的 URL 级判据**（CDP `/json` tab URL × 词边界正则 `LOGIN_WALL_URL_RE`，chrome-idle-reaper.ts），不复用 C3 的快照词表——C2 与 C3 的判定语义本就不同（C3 是「给 CC 的介入信号」，C2 是「用户登录完成的时刻观测」）。依赖关系不成立，保留点失效。
2. **失效方向安全**：判据假阴性（URL 不含登录词的 modal 式登录）= 永不自动 hide = 退回手动 `chrome-hide`（现状）；假阳性被四重护栏压低（见下）且后果可逆（`chrome-show` 一条命令恢复，登录态无损）。与 C3 的假阳性后果（CC 收到假 didnt、任务被误终止）不同级。
3. **用户授权明确**：任务书点名该候选并给出四条防误判要求（检测登录墙消失 + 延迟 N 秒 + 仅台账 Chrome + 失败降级不 hide）——四条全部机械化落地（另加第五条「agent 安静度」，护栏③）。

**边界（如实声明）**：

- **默认 off**（audit 裁决本体不变）：`LASSO_AUTO_HIDE_AFTER_LOGIN` 未显式配置时零行为变化（config 默认 false 有 INV-82(b) 钉死）。
- **每 server 进程每 port 只收一次**：手动 `chrome-show` 后 reaper 不会二次自动收（进程内 `autoHideDone` 状态；跨进程感知 show 需台账字段，属过度设计，本版不做——要再收一次跑手动 `chrome-hide` 或重启会话）。
- **只在 server 会话内生效**：CLI 单独 `launch-chrome` 无调度器（parse18 §5.1 诚实边界同源），文档已明示。
- **hide 失败（TCC 缺失等）永久降级**：本进程内不再重试（防 osascript 周期性空转），日志 `chrome_auto_hide_failed`，手动出口不受影响。

## 2. C1（admin `chrome_launch`）决策文档 —— 维持 DECISION，交用户裁决

- **价值**：D-1b 恢复档位 L0→L1——「Chrome 没起」时 CC 在**同一会话内**拉起 hidden 档（零窗口/零焦点/恒静音，S1 可静默动作），无需用户离开对话去终端。audit D-1 真机实锤：现状 CC 收 `outcome=unknown` + 裸错误 + 无 next_step（G2 只修了「CC 知道该做什么」，动作本身仍要用户执行）。
- **风险**：agent 获得 spawn GUI 进程能力——新增 mutation action 面（admin.ts 现有 19 action 无一能起进程）。
- **若裁决 GO 的前置条件**（audit §3 D-1b + 本轮补充）：
  1. mutation 必传 reason（审计沿既有 admin mutation 范式）；
  2. 默认 hidden 档（visible 档必须留给用户终端手动——S2 介入面不由 agent 决定）；
  3. 端口冲突预检复用 P3 `port_in_use_non_cdp` 诚实拒绝（launch-chrome.ts:312-321 已在位）;
  4. 台账 + 归属验证 100% 复用（同 launch-chrome 落账路径）；
  5. 建议同轮补 INV（action 面 + hidden 默认 + reason 必传三条 grep 锚）。
- **裁决官倾向**：GO（价值/风险比良好，前置条件全部可机械化），但新增 agent 权限面超出本轮「修复与文档」授权范围，按 audit 原裁决留独立轮次交用户拍板。

## 3. C3（NEEDS_MANUAL_2FA 生产者实装）决策文档 —— 维持 DECISION，交用户裁决

- **问题本体**（verify §5-D3 真机 + 白盒双实锤）：描述向 CC 承诺 `outcome=didnt + error="NEEDS_MANUAL_2FA"`（descriptions.ts:212-214），但全 src 零生产者（8 处命中全为注释/类型/死消费端）。真机 navigate github.com/login 返回 `worked` + 登录页内容——介入信号缺失，CC 可能继续在登录页上 click/fill 试探（S2 介入面放大）。
- **属还债**（承诺未实装），audit 建议「做，判据设计需单独评审」。
- **需要用户拍板的判据**（行为变化 worked→didnt 的影响面）：
  1. 判据组合：URL pattern × 快照词表（TWOFA_KEYWORDS）× 密码输入框 selector——单用词表假阳性高（正文讨论 verification code 的文章页被误杀）；建议**组合判据 + 仅 navigate 后首屏判定**；
  2. didnt 文案必须带「确认后在 Chrome 完成登录再重试」指引（next_step 语义）；
  3. fallback 引擎 stop-word 已在位（outcome.ts:111），didnt 会正确终止链——需评估对多步任务的中断代价；
  4. 建议判据先以 doctor/诊断形态灰度（只报不拦），观感数据后再切换行为。
- **与 C2 的关系更正**：C2 已实施且**不依赖** C3（见 §1）；C3 若落地，其登录墙检测器与 C2 的 URL 判据可考虑合并为单一真源（届时报 ARCHITECTURE §3 变更）。

## 4. C4（无 Chrome 全自动恢复链）—— NO-GO（现阶段）

- **形态**：无 Chrome → 自动起 hidden → 探测登录墙 → 自动切 visible 等登录 → 检测登录完成 → 自动 hide（audit D-1c，把 ~5 分钟人工往返压到 ~30s「窗口弹-登录-窗口自隐」）。
- **NO-GO 理由**（audit §4 原裁决维持）：
  1. 叠加 C1（agent spawn GUI）+ C3（行为变化）+ C2（自动收窗）全部风险面，单一轮次不可验收；
  2. **焦点抢占时机**：自动切 visible = agent 决定何时抢用户焦点（S2 介入时机不应由后台决定，C1 决策文档前置条件 2 同款理由）；
  3. 与并行工作流的端口/profile 冲突面（verify 隔离纪律的存在本身就是证据——同机多 lasso 工作流是真实场景）。
- **路径**：C1-C3 各自落地后链路自然成形（届时每段都有独立 INV 与真机验证），再做整链验收——不是不做，是不整链做。

## 5. N1-N4 NO-GO 理由固化（audit §4 原文 + verify 佐证）

| # | 项 | 理由 | verify 佐证 |
|---|---|---|---|
| N1 | desktop cgEvent「静默化」 | 物理边界（C 类）：CGEvent 合成的就是物理键鼠事件，静默即失能（KEY-GUIDE §C 诚实声明；doc/27 fix.md 固化） | — |
| N2 | 自动登录 / 解 2FA | 铁律（LoggedInChannel.ts:8-10 头注）+ 凭证安全边界 | — |
| N3 | hide/kill 用户自开（非台账）Chrome | 红线：永不按进程名操作（chrome-hide.ts:4-7，E8 实测事故级结论）；P1 精神——用户拥有的窗口后台无权处置 | C2 实施结构性满足：只迭代台账记录 + PID 定向 |
| N4 | visible Chrome 的自动 kill 出口 | P1（v1.17.3）实战根因已裁决反对；恢复静默只能用 **hide**（无损可逆），永远不能用 kill | **D-5 恰是 N4 被exit 钩子绕过的实证**——本轮修复后 N4 全路径成立（优雅 shutdown + exit 钩子 + idle reaper 三口全豁免 visible；INV-82(a) 钉死） |

## 6. 未尽事项

- D-2 的「驻留」另一半：visible Chrome 在**无 server 会话**时（CLI 起的、CC 已退出）仍无任何自动恢复——这是调度器进程边界的诚实限制（autoHide 只活在 server 内），文档已如实声明，不伪装解决。
- `chrome-show` 后不二次自动收（§1 边界）；若实践证明高频困扰，再议台账字段方案。
