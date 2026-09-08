# 问题报告与决议：上游选中页死锁（P1）+ 归属鉴定 chrome-status + 复验轮 P3 批（BUG-04）

> 发现日期：2026-09-08 · 来源：cc-control 复验报告（/Users/wangdong/Documents/Project/cc-control/doc/lasso-报告-2026-09-08-事故与复验.md §9 新问题清单）· 严重级：P1（通道级）+ 主权纵深（事故直接教训）
>
> 本轮构成：问题核查员（白盒+真机三段复现，实验实例已按纪律 chrome-stop 清理，两账复核干净）+ 纵深调研员（用户诉求①诚实边界+两层补位）+ 设计合成员（本文件；对全部输入 findings 逐锚复核——上游 tarball 源码逐行核验 + lasso 源码逐锚核验，见 §2/§3 复核注记）。
>
> 🔴 沿用红线（BUG-03 §0）：禁项目外新组件；**永不 kill 用户浏览器**；chrome-stop 只认「台账在案 + cmdline 归属验证」的 pid，不得放松；对非账本资产维持零 kill 逃生口。
>
> **r1 修订（2026-09-08，对抗复核轮）**：三项否定发现逐锚白盒复核后**全部 CONFIRMED、零驳回**（复核证据与修订记录见 §12）：①决议 A 僵尸分支 agent 指引改**门槛变体** `chrome-stop --zombie-gate`（TOCTOU 窗——B1 认领/chrome-show 在 agent 读分类与执行 kill 之间落 userTakenAt，CLI kill 不复查；§4 A2）；②A1 矩阵补**失效安全终态 + pid 一致性 + 慢启动守卫**（§4 A1）；③决议 E 从「样例指针」升级为**需求规格 + 交付要求**（裸 pid kill 静态不可区分——事故原形 `kill 11633` 无进程名；§9）。

## 1. 问题清单与定级

| # | 问题 | 定级 | 本轮裁决 |
|---|---|---|---|
| ① | browse_logged_in 页引用僵死（通道级，MCP 重启才解） | **P1** | 决议 B：检测 + 通道内自愈 + 单次重试（§5） |
| ②a | evaluate 第三形态（IIFE）报 `fn is not a function` | P3 | 决议 C1（§7） |
| ②b | 调用方坏 JS 也拉响 fallback 链 | P3 | 决议 C2（§7） |
| ③a | doctor `detail` 措辞（HTTP 404 vs 实测连接接受空响应） | P3 | 决议 C3（§7） |
| ③b | 账本跨重启丢失的无主 lasso 实例不自愈 | 边界 | 决议 D：**NO-GO 维持边界**，chrome-status 上报包替代（§8） |
| ③c | chrome-status：归属鉴定从 agent 手里收走 | 事故直接教训 | 决议 A（§4） |
| E | agent 经 Bash kill 浏览器的硬拦 | 用户诉求① | CC 配置层 PreToolUse hook 样例，交付 cc-control，**不进本仓库**（§9） |

## 2. P1 根因（设计合成员独立复核确认——改写报告 §9-① 原归因）

**报告原假设「click+expect 内部闭掉句柄」被核查员真机证伪**（click 单 action expect 被忽略 / steps 路径仅 evaluate_script 轮询，两形态均不关页）。真根因是**上游 chrome-devtools-mcp@1.7.0 的结构性死锁**，设计合成员对 npm registry tarball 逐行复核确认：

- `build/src/ToolHandler.js:189`：`const targetPage = page ?? context.getSelectedMcpPage();` **无条件执行**——位于内层 try/catch（155-187，仅覆盖 handler 执行与 `response.setError`）之后、`response.handle(context, dataFormat)`（:201）之前。
- `build/src/McpContext.js:252-254`：`getSelectedMcpPage()` 在选中页 `isClosed()` 时 throw `The selected page has been closed. Call list_pages to see open pages.`
- 死锁链：选中页被关（**任何**途径：用户手关 / 页面 JS window.close / 会话收尾 restore 关自建 tab / 上游 prune 前）→ 下一次**任何**工具调用：页级工具在 :169 throw 进 setError，但随后 :189 再次 throw → 落入**外层** catch（:214）→ `response.handle` 被跳过 → **唯一自愈点 `createPagesSnapshot()`（McpResponse.js:275 经 #handleSnapshot）永不执行** → 连错误信息自己指的补救工具 `list_pages` 也死（list_pages 非 pageScoped，`page` 恒 undefined，同样死在 :189）。
- 逃逸口（复核确认）：`select_page` / `new_page` 的 handler（pages.js）**先于 :189** 重置 `#selectedPage` → 不抛；spec 重启（进程重启）亦解。核查员真机：`/json/close` 选中页后 evaluate/list_pages 全报同一错误，new_page 可解除——与源码推演一致。
- lasso 侧放大因：`TabRegistry.reconcile`（TabRegistry.ts:188-191）把 list_pages 的 isError 错误文本当「格式漂移」吞成 `tab_reconcile_unparseable_list` warn——**零检测零自愈**；`LoggedInChannel.getMcpClient`（LoggedInChannel.ts:226-230）对 throw 路径同样只 warn。主通道从此每 action 失败 → classifyBrowseError 落 unknown → fallback 每次拉响 headless（报告 §8 实测「fallback 链实测会拉响」即此）——主通道僵死被 fallback 掩盖而非修复。
- lasso 内生触发面（复核补充登记）：`admin tab_restore`（index.ts:1216）在 upstream 存活时经 raw CDP 关快照后新增 target——若其中含上游选中页（ensureOwnPageSelected 自建页场景）即楔死；用户手关选中 tab 是 browse_logged_in 的一等场景。修复不依赖枚举触发途径——按签名检测 + 自愈覆盖全部途径。

## 3. 用户诉求①的诚实边界（调研员结论，合成员确认）

lasso 单侧**无法硬拦** agent 经 Bash 发出的 kill——shell 不在 MCP 管辖内；v1.21.0 的 never_kill_user_asset 文案防线在 09-08 事故中被证明「读到但降级为背景信息」。纵深两层各自补位：

- **(A) lasso 侧（决议 A）**：把「归属鉴定」收走——消灭事故四根因之首「agent 自行推断归属」。现状实证：`classifyPortOccupierNextStep`（doctor.ts:982-1029）与 launch-chrome A2 门只查台账，**不解析真实占口 pid**——非台账占口者零证据面，事故中 agent 只能自己跑 lsof/curl/osascript/ps 然后三重误判。
- **(B) CC 配置层（决议 E）**：PreToolUse hook 硬拦 agent 发起的 kill——唯一真正的强制层；交付 cc-control，不进本仓库。

## 4. 决议 A：`chrome-status` 独立子命令（归属鉴定 + 上报包）——GO

**定位**：只读信息面。回答一个问题——「这个端口的占用者是谁、归谁管、我能做什么」——并永远不给 agent 任何 kill 能力。

### A1 核心：`classifyPortOccupier()` 单一真源（新模块 src/doctor/chrome-status.ts）

证据集（全只读、全仓库内既有组件）：TCP 探测（tcpConnectable）→ CDP `/json/version`（+`/json/list` 页数）→ `lsof -nP -iTCP:<port> -sTCP:LISTEN` 取真实监听 pid → `ps -p <pid> -o command=,etime=` → 台账（readLedgerSync）→ verifyOwnership（cmdline `--user-data-dir` 精确子串）→ isUserOwnedRecord → profileDir 指纹（cmdline 含 lasso cache 下 profile 路径）。全部 DI 注入（lsofFn/psFn/aliveFn/ledgerFn/cdpFn，repo 既有惯例）。

分类矩阵（enum，机器可读；r1 修订：7 枚举 → 10 枚举 + 三条机械规则 R1-R3）：

| 分类 | 判定 | agent_directive |
|---|---|---|
| `free` | TCP **主动拒连**（ECONNREFUSED 实测形态；连接工具级异常 ≠ free） | 可 launch-chrome |
| `lasso_launching` | 台账在案 +（launchedAt 未知 ∨ 距今 < LAUNCH_GRACE_MS=60s）；或 status==="cdp_not_ready" 且年龄不可证 | 等待 ≥60s 后重跑 chrome-status；**永不给 kill 指引** |
| `lasso_live` | CDP ok + 台账在案 + **lsofPid===rec.pid** + 归属通过 | 正常使用 |
| `ledger_zombie_collectible` | CDP 死 + 台账 + **lsofPid===rec.pid** + 归属 + !isUserOwnedRecord + 非 render + **非 launching（R3 同款守卫）** | **唯一**给 `chrome-stop --zombie-gate --port N` 指引的分支（lasso 自己的资产；门槛变体见 A2） |
| `ledger_user_owned` | 台账 + isUserOwnedRecord | 换口 + 上报（never_kill_user_asset） |
| `lasso_profile_orphan_suspected` | 无台账 + 占口者 cmdline 含 lasso profileDir 指纹（含 R2 的 pid_match:false 实际占口者） | **只上报**（见决议 D：不认领不杀） |
| `user_asset_suspected` | 无台账 + Chrome 进程（带/不带 --remote-debugging-port）无 lasso 指纹 | 只上报 |
| `external_occupier` | 无台账 + 非 Chrome 进程 | 只上报 |
| `probe_failed` | 任何探针失败/空输出/证据链断链：lsof 空/缺失、ps 空、CDP fetch 工具级异常、TCP 连接判定本身不可得 | **只上报；allowed_commands 恒空**（must_report:true） |

三条机械规则（全部进 INV-88 断言面 + DI 单测；r1 修订新增）：

- **R1 失效安全（fail-safe）**：空输出 ≠ 空属性、CDP 死 ≠ 僵尸——任何探针失败/空输出/证据断链一律落 `probe_failed`，只上报、allowed_commands 恒空；`free` 仅认 TCP 主动拒连。事故四根因之首「空输出≠空属性/确认偏误」的结构化排除。
- **R2 pid 一致性**：lsof 实测监听 pid ≠ 台账 rec.pid（`pid_match:false`，进 JSON evidence）时，**永不**进 `lasso_live`/`ledger_zombie_collectible`——按**实际占口者** cmdline 身份落 orphan/user/external 分支，台账记录另标注 stale（门槛变体清账路径本身 kill-free：already_dead/pid_reused_skipped 不杀）。理由：hidden/visible/headless 三档共用固定 `~/.cache/lasso/chrome-profile-default`（launch-chrome.ts:319-320/233，仅 render 用临时前缀目录），verifyOwnership 的 marker 三档同串——只能证明「某只 lasso 日常档 Chrome」，**证明不了「台账记录的那只」**；pid 等值是唯一实例级凭据。
- **R3 慢启动守卫**：`launchedAt` 距今 < LAUNCH_GRACE_MS=60_000（=CDP_PROBE_ATTEMPTS_VISIBLE 12s 探活窗 ×5 余量，同源对齐；无 launchedAt 的陈留记录按 status==="cdp_not_ready" 归入）→ `lasso_launching`：等待/上报，永不给 kill 指引。锚：launch-chrome.ts:701-706 既有注释原文「cdp_not_ready 时 Chrome 可能仍在慢启动——launch 时刻仍不代 kill（会误杀）」。**同款守卫回补 A2 门**（launch-chrome.ts:414-430 现无年龄/状态守卫——存量隐藏缺陷：年轻 cdp_not_ready 记录在并发 launch 场景会被当僵尸收割；`zombieCollectible` 谓词追加 `!isLaunchingRecord(zombie)`）。

### A2 输出契约（对 agent）

- CLI：`lasso-mcp chrome-status [--port N] [--json]`（缺省端口同 config cdpPort；process.argv[2] 字面量 dispatch，INV-71(c) 同款）。缺省输出人话 + `--json` 结构化。
- MCP：admin tool 增只读 action `chrome_status`（admin 既有 action-enum 折叠范式，INV-17 同款；只读免 reason）。两入口共用 A1 核心。
- JSON 形状：`{ port, classification, evidence: { pid, pname, etime_s, cmdline_excerpt, pid_match, ledger_record, cdp: {reachable, browser_field, pages}, ownership_verified }, agent_directive: { allowed_commands: [...], must_report: true }, user_paste_pack: "..." }`（r1：增 `pid_match`）。
- **铁律（进 INV-88）**：输出**永不包含 kill/pkill/killall/osascript quit 形态命令**（grep tripwire 断言）；`chrome-stop` 指引**在 agent_directive.allowed_commands 中只允许门槛变体 `chrome-stop --zombie-gate --port N`**，且仅允许出现在 `ledger_zombie_collectible` 分支（台账陈留清账指引同用门槛变体）；其余一切占用分支（含 `probe_failed`/`lasso_launching`）必含 `never_kill_user_asset` token 与 `must_report: true`。user_paste_pack（给人看）不受此限——用户专属出口仍可提裸 `chrome-stop --port N`（用户 = 同意通道本体）。

### A2b 门槛变体 `chrome-stop --zombie-gate`（r1 修订新增——关 TOCTOU 窗）

**根因（复核实证）**：chrome-stop CLI 的 kill 谓词只有 `verifyOwnership`（chrome-stop.ts:237-252 目标过滤仅 port/modes/ownerPid/exemptUserTaken 四维；`isUserOwnedRecord` 在该文件零引用；CLI argv 面 :400-447 不暴露 exemptUserTaken）——**kill 时刻不复查 userTakenAt**。决议 A 原稿把 agent 指引到裸 `chrome-stop --port N`，则 B1 认领路径（desired-hide-watchdog 确认窗 ≈30s / chrome-show 即时，chrome-ledger.ts:241-258 markUserTakenByPid）在 agent「读 chrome-status → 执行 kill」的秒~分钟级间隔内落 userTakenAt 后 kill 照常执行——r2-F1 事故型（「userTakenAt 唯一关闭出口」契约经 agent 路径逃逸），且与 doctor.ts:1018-1032 现存文案（「唯一出口 = 用户自行关闭或**用户本人**运行 chrome-stop」「Agents must not run chrome-stop against a user_taken_asset on their own」）直接矛盾：机器可读指引比口头禁令对 agent 更有约束力，不能自相矛盾。

**设计**：CLI 增 flag `--zombie-gate`，内部映射 `stopLaunchedChromes({ port, exemptUserTaken: true, modes: ["hidden","headless"] })`——两参数既有（chrome-stop.ts:58/73），纯增量、不触碰裸 chrome-stop 的用户无条件出口（收紧而非放松，与红线「chrome-stop 只认 lasso profile 不得放松」同向）。kill 时刻谓词 = 矩阵谓词的运行时重估：exemptUserTaken 排除 userTakenAt、modes 排除 visible/render。约束三条：

1. `--zombie-gate` **必须**与显式 `--port N` 同现（agent 永不 all-stop）；与 `--modes` 显式组合即拒绝（防反向放宽）。
2. 被门排除的记录在输出中以 `gated_skipped` 列出并附 `never_kill_user_asset` token——**agent 的合法下一步被收敛为上报，而非升级到裸 chrome-stop**（静默零动作会诱发 agent 自行换路，事故已证）。
3. INV-88 断言：`agent_directive.allowed_commands` 全分类面永不出现裸 `chrome-stop`（无 `--zombie-gate` 后缀形态）；chrome-stop.ts 源码锚定 `--zombie-gate` 分支必含 `exemptUserTaken: true`。

### A3 上报包（user_paste_pack）

给人看的粘贴块（fenced text）：端口/pid/进程名/etime/cmdline 摘录/台账状态/CDP 探测结果/分类 + **用户专属出口**（自行关闭 / 自己跑 `chrome-stop --port N`（僵尸与已认领实例皆是用户的合法关闭出口——chrome-stop.ts:71-73 既有契约）/ 让 agent 换口）。这是「零 kill 逃生口」的替代物：agent 的合法下一步被收敛为「把这个包粘给用户」。

### A4 消费方接线与兼容

- doctor `checkCdp9222` 的 catch/!ok 分支与 `classifyPortOccupierNextStep` 升级为消费 A1（补齐非台账占口的真实 pid 证据面——A2 门的 launch 错误文案同源受益）；INV-87 (a)「全窗口扫描必含 never_kill_user_asset」断言面保持。**r1**：doctor 现存僵尸/陈留分支文案（classifyPortOccupierNextStep）指向的裸 `chrome-stop --port N` **同步换成门槛变体**——否则 TOCTOU 窗经 doctor 路径原样残留（同一矛盾的两个出口面）。
- 向后兼容：纯增量（新子命令 + 新 action + 新 flag + doctor next_step 证据变富）；无行为删除——裸 `chrome-stop`（用户出口）行为零变化。
- 实施面：中。测试 ≈18+（r1 扩）：分类矩阵逐分支 DI 单测（含新增 `lasso_launching`/`probe_failed`/pid_match:false 三族）/ 无 kill 字符串 tripwire / allowed_commands 永不含裸 chrome-stop / paste_pack 形状 / admin action 接线 / CLI smoke（help 面 + INV-71(c) 守护点登记）/ **--zombie-gate 单测**（豁免 userTakenAt 记录、无 --port 拒绝、与 --modes 组合拒绝、gated_skipped 输出面）/ **A2 门年龄守卫单测**（年轻 cdp_not_ready 记录不被 zombieCollectible 收割）。

## 5. 决议 B：P1 选中页死锁自愈——GO（以 §2 根因为准）

三层，全部 LoggedInChannel/BrowseChannel 通道内，零新组件：

1. **检测**：导出签名常量 `UPSTREAM_WEDGE_SIGNATURE = /The selected page has been closed/`（上游 McpContext.js:253 整串，窄匹配防误伤）+ 辅助 `isUpstreamWedgeError(text)`。`classifyBrowseError` 命中 → unknown + 错误前缀 `upstream_wedge_selected_page_closed`（session_rotated 先例同款透明化）。
2. **自愈（healUpstreamWedge，LoggedInChannel 实装）**：
   - 层 1：`new_page {url:"about:blank", background:true}`——零抢焦（background 实证）、单往返、handler 先于 ToolHandler:189 重置选中页（结构性逃逸口）；成功后登记 own page（noteOwnPage）+ TabRegistry 入册，纳入既有 LRU/会话收尾管理。
   - 层 2（层 1 失败才走）：respawn upstream spec（forgetSpec + ensureRunning，既有机器）——只杀 npx 上游子进程，**不触碰 Chrome**。
3. **重试**：自愈后原 action 重跑一次（P6/W2-DEF-N1 自愈重试先例）。仍失败 → `upstream_wedge_unhealed`（unknown：通道错，fallback 到 headless 语义正确）。

接入点两处：**被动**——browseSingle/链 catch 识别签名后调 heal + 重试一次；**主动**——`TabRegistry.reconcile` 不再把该签名吞成 `tab_reconcile_unparseable_list`：list_pages 结果文本命中签名 → 返回类型化信号（throw `upstream_wedge:...`），LoggedInChannel.getMcpClient 在返回 client 前触发 heal（下一个 action 永远看不到楔死态）。

- 兼容：纯增量；new_page 新增的 tab 走既有 own-page 清理路径；reconcile 行为变化=原静默 no-op 变类型化信号（消费方仅 LoggedInChannel 一处）。
- 实施面：中。测试 ≈10：签名单测 / reconcile 类型化信号（不再落 unparseable）/ heal 层 1 成功→重试成功 / 层 1 失败→层 2 respawn / 双失败→unhealed（fallback-worthy）/ 主动 getMcpClient heal / **INV-89 锚**（签名常量导出 + reconcile 不吞 + 重试路径存在 + heal 永不触碰 Chrome 进程）。真机复现配方沿用核查员已验证路径（/json/close 选中页 → evaluate 楔死 → 自愈解除）。

## 6.（并入 §5，编号保留防歧义）

## 7. 决议 C：P3 批——GO（三小项，各自单主题 commit）

- **C1 evaluate 第三形态（IIFE）**：机理（复核确认）——上游 `performEvaluation`（script.js:158-165）= `evaluateHandle('(' + fnString + ')')` 后 `fn(...args)`；IIFE 串（`(async()=>{...})()` 等）求值成**结果**而非函数 → `fn is not a function`。而 `evaluateFunctionArg`（BrowseChannel.ts:1441-1446）起手 token 规则把 `(async...` 判函数表达式透传 → 中招。修：增 IIFE 探测（起手函数表达式 token + **结构化尾部调用判定**：剥尾 `;` 后以 `()` 收尾且其前一字符属于平衡的 `)`/`}` 组），命中 → 包成表达式体箭头 `() => (\n${t}\n)`。**失败方向纪律**：误判必须响亮（上游语法/执行错），永不静默 undefined；测试向量：三 IIFE 形态 + 反例锚 `() => document.getElementById('x').click()`（箭头尾调用，必须维持透传）+ `() => (foo)(x)` 边界（文档化取向：维持透传——静默变更风险大于响亮报错）。工具描述双例→三例同步。
- **C2 fallback 语义**：调用方脚本错不拉响备用通道。`classifyBrowseError` 增 `eval_upstream_error` → **didnt**（确定性不可得，P10 upstream_unsupported 同先例——换通道救不了坏 JS）；`isFallbackWorthy` 无需改（didnt 本就不 fallback）。回归面：脚本错从 unknown+fallback 变 didnt+直达错误——正是报告 §9-②b 要的行为；B 的 `upstream_wedge_*` 维持 unknown（通道错，fallback 正确）。
- **C3 doctor 措辞**：`checkCdp9222` detail 如实区分实测形态——`HTTP <status>` / `connection accepted, empty/invalid body` / `fetch aborted (timeout)` / `connection refused`（fetch DI 注入断言四种文本）；next_step 仍走 A1 分类器。不引入「僵尸」暗示性叙事（事故教训：空响应≠CDP 坏≠僵尸）。

## 8. 决议 D：③b 认领无主实例——**NO-GO（维持边界；已落地为文档化边界 + chrome-status 替代出口）**

- **认领=杀**。指纹（cmdline 含 lasso profileDir）证明「跑着 lasso profile」，**证明不了「没人在用」**：B1 之后无主 hidden Chrome 可能已被用户激活认领（userTakenAt 在台账里——台账丢了即不可知）→ 自动认领可杀掉用户正在用的窗口 = 09-08 事故型，且被系统化。
- 机器内不存在 agent 不可伪造的「用户裁决」通道（CLI/Bash/文件 agent 都能代跑——事故已证）。**r1 订正原前提句**（原句「现有全部杀路径的安全谓词（isUserOwnedRecord）依赖台账」对 CLI 路径事实性错误）：各杀路径谓词分层——A2 门/doctor 用 isUserOwnedRecord（台账）、停机/exit 用 ownerPid+exemptUserTaken（台账）、**chrome-stop CLI 仅 verifyOwnership（cmdline marker）**；CLI 之所以可接受，靠的不是谓词而是**运行者=用户**（同意通道）。无主认领既拿不到台账谓词、更没有同意通道 → 自动认领 = 把「CLI 级弱谓词 + 零同意通道」交给机器自动执行，比任何既有杀路径都更不安全。
- **替代已交付**：chrome-status 的 `lasso_profile_orphan_suspected` 分类 + 完整证据 + 上报包（§4）——用户自己决定、自己动手关（用户的 shell 是唯一合法行刑者）。失败方向 = 少杀（安全侧）。
- 重议条件（登记不实施）：出现带外用户确认通道（如需用户交互式特权/钥匙串的确认步骤）**且**与 E 类 CC 侧硬拦联动后，再议。

## 9. 决议 E：CC hook 硬拦（交付 cc-control，不进本仓库）——r1 修订：先规格后交付

PreToolUse hook——唯一真正强制层，拦截 agent 经 CC 工具发出的浏览器 kill。**r1 复核确认原稿三缺陷**：(a) 只写 matcher=Bash；(b) grep 型拦截对裸 pid kill 静态不可区分——事故原形 `kill 11633` **无进程名**（报告 §2 时间线 14:20），静态匹配「chrome」字样的 hook 恰好漏掉真事故命令，而 `kill <vitest-pid>` 与之同形；(c) 交付物未落盘（cc-control 全库 grep PreToolUse = 空）、无回归测试载体。修订后的需求规格：

**E1 覆盖面**：matcher 至少 `"Bash|mcp__lasso__desktop"`。
- Bash：kill/kill -9/pkill/killall/osascript-quit 全形态。
- desktop：`act` 的 hotkey/press 路径可对前台 app 发 Cmd+Q（优雅退出用户浏览器的真实向量，不经 Bash）。appleScript 档经复核**今日不可杀**——rust-helper/src/applescript_whitelist.rs 静态 9 模板白名单（finder/mail/safari/notes/volume/uptime），无 kill 形态、未知 action 拒绝、参数白名单+字符过滤；该白名单作为 tripwire 锚（新增含 kill/quit 的模板须重议 E 覆盖面）。

**E2 判定规则（须动态解析，禁纯静态 grep）**：
- 名字型：命令文本含 killall/pkill/osascript quit 且匹配浏览器名/lasso profile 标记（Chrome/Chromium/puppeteer_dev_chrome_profile/chrome-profile-default/render-chrome-profile-）→ deny。
- **裸 pid 型**（kill [-SIGNAL] <pid>...）：hook 内对每个 pid token 执行 `ps -p <pid> -o command=` 实时解析——解析结果匹配上述浏览器/lasso 模式 → deny；ps 查无此进程（已死，kill 无害）→ allow；**解析工具本身出错 → deny（失效安全）**。
- 回馈：exit 0 + `permissionDecision:"deny"` + reason 指引 agent 改走 chrome-status 上报路径（never_kill_user_asset 语义）。

**E3 诚实边界**（沿用）：只拦 CC 中介的工具调用，用户自己终端的 kill 不受影响；desktop 的 AX 点击/键入无法与合法自动化静态区分——Cmd+Q 规则只拦 hotkey/press 显式形态。

**E4 交付要求（不进 lasso 仓库，但必须落盘+可回归）**：脚本实体文件落 cc-control 仓库（如 `scripts/hooks/deny-browser-kill.mjs`）+ 测试载体（至少：`kill 11633` mock-ps 为 Chrome → deny / `kill <pid>` mock-ps 为 vitest → allow / `pkill -f puppeteer_dev_chrome_profile` → deny / `killall "Google Chrome"` → deny / desktop cmd+q → deny / ps 工具异常 → deny）+ user 级 `~/.claude/settings.json` 接线样例（跨全部项目会话——事故 agent 恰是另一项目会话）。**验收门：样例测试不绿不算交付**；本仓库仅存本节规格指针。

## 10. 实施序与门禁

单主题单 commit，序：**B（P1）→ A（chrome-status + --zombie-gate + R1-R3 守卫回补 + INV-88）→ C1 → C2 → C3 → D/E 文档收口（E 按 §9 E4 规格交付 cc-control）**。每 commit `npm run build && npx vitest run && npm run check-invariants` 全绿；不 push 不发版。新 INV：INV-88（chrome-status 输出契约：无 kill 字符串 tripwire + allowed_commands 永不含裸 chrome-stop + R1 失效安全终态 + R2 pid 一致性 + R3 慢启动守卫含 A2 门回补锚）、INV-89（wedge 自愈锚）；基线 87→89。真机实验 Chrome 用后清理（两账+进程复核）。上游 chrome-devtools-mcp@1.7.0 维持锁定只读——B 的自愈是对上游结构缺陷的仓库内补偿，不构成升级理由（升级须全量回归另议）。

## 11. 关联

- cc-control 复验报告（本文件问题源）：…/cc-control/doc/lasso-报告-2026-09-08-事故与复验.md
- doc/bugs/03（BUG-03 全案：never_kill_user_asset/INV-87/A2 门/isUserOwnedRecord——本文件 A/D 直接续用其谓词与红线）
- 源码锚：upstream@1.7.0 build/src/{ToolHandler.js:154-201, McpContext.js:247-256, McpResponse.js:275, tools/pages.js:10-122, tools/script.js:158-165}；src/logged-in/TabRegistry.ts:179-222；src/channels/LoggedInChannel.ts:188-231；src/channels/BrowseChannel.ts:897-930/1400-1446/1549-1584；src/doctor/doctor.ts:982-1069；src/launcher/{launch-chrome.ts:384-474, chrome-stop.ts:103-135}；src/fallback/outcome.ts:107-121；src/index.ts:1216/1535-1604

## 12. r1 修订记录（对抗复核轮，2026-09-08）

三项否定发现逐锚白盒复核，**全部 CONFIRMED、零驳回**：

| # | 发现 | 复核证据（独立重验） | 裁决与落点 |
|---|---|---|---|
| F1 | 僵尸分支 agent 指引 = 无门槛 chrome-stop，kill 时不复查 isUserOwnedRecord，TOCTOU 窗重开 r2-F1 型；决议 D 前提句对 CLI 路径事实性错误 | chrome-stop.ts:237-252 四维过滤实证；grep 全库 isUserOwnedRecord 消费者 = launch-chrome.ts:421/doctor.ts:1018/check-invariants（chrome-stop.ts 零引用）；parseChromeStopArgs:400-429 无 exemptUserTaken 面；markUserTakenByPid=chrome-ledger.ts:241-258（B1 确认窗 USER_ACTIVATION_CONFIRM_TICKS=20≈30s + chrome-show 即时）；A2 门 :414-430 check-时刻判定后同 tick 调 stopLaunchedChromes（ms 窗）；doctor.ts:1018-1032 文案与机器指引矛盾实证 | **采纳**。§4 A2b 新增 `--zombie-gate`（port 必带/禁与 --modes 组合/gated_skipped 输出）；A2 铁律改「agent_directive 只允许门槛变体」；A4 doctor 文案同步换；§8 D 前提句订正（分层谓词 + 同意通道论证，结论 NO-GO 不变且更强） |
| F2 | 矩阵缺失效安全终态/pid 一致性/慢启动守卫 | 矩阵原 7 枚举无 failure/pid/age 规则（本文件原稿实证）；launch-chrome.ts:701-706 慢启动注释原文核验；:319-320/233 三档共用固定 profileDir（仅 render 临时前缀）→ marker 同串实证；A2 门 :414-430 无年龄/状态守卫（存量隐藏缺陷确认）；CDP_PROBE_ATTEMPTS_VISIBLE=40×300ms=12s | **采纳**。§4 A1 矩阵 7→10 枚举（+lasso_launching/probe_failed）+ R1/R2/R3 机械规则（进 INV-88 + DI 单测）；R3 同款守卫回补 A2 门；JSON 增 pid_match；测试 ≈12+→≈18+ |
| F3 | §9 规格不全：matcher 只 Bash / 裸 pid 静态不可区分 / 交付物未落盘无测试载体 | 本文件 §9 原稿文本实证；事故 kill 原形 `kill 11633` 无进程名（报告 §2 时间线）；cc-control 全库 grep PreToolUse = 空；desktop 通道复核修正——appleScript 档为 rust 静态白名单（applescript_whitelist.rs 9 模板，无 kill 形态）**今日不可杀**，真实向量 = act hotkey/press Cmd+Q | **采纳（含一处机理修正）**。§9 重写为 E1-E4 需求规格：matcher 至少 Bash+mcp__lasso__desktop（desktop 向量按实测修正为 hotkey 形态，appleScript 白名单作 tripwire 锚）；E2 强制动态 pid 解析 + 失效安全；E4 落盘 cc-control + 测试载体 + 验收门 |

**驳回清单：空**（无一项误报；F3 的 desktop-appleScript 向量机理被复核修正，属收窄而非驳回）。

## 13. 实施落地记录（2026-09-08，实施员轮）

按 §10 实施序完成，单主题单 commit（不 push 不发版），每 commit `npm run build && npx vitest run && npm run check-invariants` 全绿：

| 序 | commit | 内容 | 测试增量 |
|---|---|---|---|
| B | `b61827a` fix(channels) | P1 选中页死锁自愈：`src/browse/upstream-wedge.ts` 签名单一真源；browseSingle 被动检测+heal+单次重试（双失败透明前缀 `upstream_wedge_selected_page_closed`/`upstream_wedge_unhealed`，classify→unknown）；LoggedInChannel heal 两层（层 1 `new_page {background:true}` 结构性逃逸口 / 层 2 `subproc.restart`——永不触碰 Chrome）；reconcile 类型化信号不再吞；INV-89 新增；INV-78(d) 激活禁令精化（new_page 唯一例外 = heal 层 1 零抢焦形态） | +17（bug04-wedge-selfheal.spec） |
| A | `cc35194` feat(doctor,launcher) | chrome-status 归属鉴定：`src/doctor/chrome-status.ts` classifyPortOccupier 单一真源（10 枚举 + R1 失效安全 + R2 pid 一致性 + R3 慢启动守卫）+ AGENT_DIRECTIVES（全表永无 kill 形态；chrome-stop 只允许 `--zombie-gate` 门槛变体且仅 zombie/stale 分支）+ user_paste_pack 上报包；CLI `chrome-status [--port N] [--json]` + admin 只读 action `chrome_status` + doctor 渲染器消费（三处分类收敛）；chrome-stop `--zombie-gate`（kill 时刻重估 exemptUserTaken+modes；拒无 --port / 拒与 --modes 组合；gated_skipped 输出面）；launch-chrome A2 门 R3 回补（`isLaunchingRecord` 进 zombieCollectible + `ledger_launching_not_collected` 诚实拒绝分支）+ 默认收尸出口映射门槛谓词；INV-88 新增；INV-87 (b)(e) doctor 锚随迁渲染器 | +37（bug04-chrome-status.spec 36 + a2 spec 1i 等） |
| C1 | `e921289` fix(channels) | evaluate 第三形态（IIFE）：结构化尾部调用判定（剥尾 `;` + 空参 `()` 收尾 + 前字符平衡 `)`/`}` + 括号平衡含字符串感知）→ 包 `() => (\n${t}\n)`；反例锚（箭头尾调用 / `() => (foo)(x)`）维持透传；工具描述双例→三例 | +4（e4 spec 5a-5d） |
| C2 | `d834c94` fix(fallback) | `eval_upstream_error` → didnt（P10 先例：换通道救不了坏 JS）；`upstream_wedge_*` 维持 unknown（分流锚）；e4 4c / upstream-contract ①② 期望同步（有意行为变更：脚本错不再拉响 fallback） | 期望修订 + fallback 锚 |
| C3 | `e6927e9` fix(doctor) | checkCdp9222 detail 如实四形态（HTTP <status> / connection accepted, empty/invalid body / fetch aborted (timeout) / connection refused）+ fetchFn DI；归因接线三分支 | +5（a2 spec 3a-3e） |
| 文档 | 本 commit | 决议 D 文档化定稿（本节）+ README 双语 chrome-status 用户面 + 附录 E（cc-control 答复要点 + hook 交付包，§9 E4 规格的落盘样例） | — |

基线与终态：测试 2676+1 skipped → **2739+1 skipped**（+63：wedge 17 + chrome-status 37 + C1 4 + C3 5）；不变量 87 → **89**（INV-88/89）；INV-78/87 两处既有断言随架构演进精化（均有本批 commit 说明）。

### 实施期新发现（白盒 + 真机）

1. **macOS ps 合并列截断（真机 smoke 实锤）**：`ps -p <pid> -o command= -o etime=` 会把 command 截到 16 字符（用户 Chrome 被截成 `/Applications/Go` → external_occupier 误分类）。修复：defaultPsFn 两次独立探测 + 源码锚测试（bug04-chrome-status.spec 10a）。这是「证据断链导致误判」的又一实例——正是 R1 要结构化排除的形态。
2. **INV-76(a) grep 禁令与文档字面量冲突**：BrowseChannel 注释中的 `(function(){...})()` 示例撞上「裸 IIFE 串直传上游」禁令的正则——注释改用带空格形态表述，禁令本身不动（锚语义不变）。
3. **真机 chrome-status 冒烟**（本机 9222 实况）：占用者 = 用户自己的 Chrome（pid 3881，运行 ~2h10m）→ 正确分类 `user_asset_suspected` + must_report + never_kill_user_asset + 上报包——与 09-08 事故现场同形态的场景，分类器给出了事故当时 agent 三重误判未给出的答案。

### 决议 D 落地形态（NO-GO 边界文档化）

- 边界维持：**无主 lasso 实例（台账丢失的旧实例）不被自动认领**——认领=杀（指纹只证明「跑着 lasso profile」，证明不了「没人在用」；B1 之后无主 hidden Chrome 可能已被用户激活认领，台账丢了即不可知；机器内不存在 agent 不可伪造的用户裁决通道）。重议条件不变（带外用户确认通道 + E 类 CC 侧硬拦联动）。
- 替代出口已交付：chrome-status 的 `lasso_profile_orphan_suspected` 分类 + 完整证据 + user_paste_pack——用户自己决定、自己动手（`chrome-stop --pid` 不存在，用户出口 = 本人跑 `chrome-stop --port N` 或手动关）。失败方向 = 少杀（安全侧）。

