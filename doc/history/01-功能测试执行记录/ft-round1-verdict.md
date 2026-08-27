# ft-round1 裁决记录（R1 审查裁决官，2026-08-18）

> **输入**：四面板记录 `ft-round1-{search,browse,infra,perf}.md`（+同目录证据 jsonl/log/执行器）。**裁决依据**：`/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md`（§1 六维 + §2 五阶段 + §3 闭环）与 `02_简单架构清单.md`（38 条）。**裁决性质**：R1 独立于四执行面板——按 03 §3.4「作者自批永不充分」红线，本记录同时充当六处修复的**新鲜复审者签字**（源码锚点逐读 + 回归钉逐验 + 门禁独立复跑两轮）。

---

## DECISION: ALL-CLEAN

**判据核对**（任务定义：零 fail + 02 评估全绿或差距均有接受理由 + 03 全过）：

| 判据 | 结果 |
|---|---|
| 零 fail | ✅ 四面板合计 fail 6（全部「判用例对→产品缺陷」），本轮内全部修复+单测钉+真机复测+门禁复跑；另有 7 处初判 fail 判**用例侧**（见 §3.2），处置正确 |
| 02 评估 | ✅ 39 行 **✅27 / ⚠️11 / ❌0 / ⏸1**；三条 🔴 硬不变量全 ✅（R-DEP-03 由 R1 本轮追加修复清零）；11 项 ⚠️ 逐条裁决=修 1 / 记 watch 6 / 接受理由 4（见 §5） |
| 03 全过 | ✅ §1 六维 + §2 五阶段逐项过（§4）；三处 🔴 级缺陷（FT-DEF-3 IPv6 SSRF 绕过、FT-DEF-1′ HighRiskGate 红线失效、W-DEF-R11-1 wait 假成功）均完成 §3.1 闭环（判用例→修产品→回归钉→门禁）+ §3.2 分类回溯 + 防复发清单项（INV-76(m)/gotHost 契约断言/INV-71 迁形） |

---

## 1. 门禁独立复跑（R1 本机，串行、不与任何面板并行）

| 轮次 | build | npm test | check-invariants | inv-selftest |
|---|---|---|---|---|
| 第 1 轮（六面板修复后、R1 追加修复前） | ✅ 0 error | ✅ **134 files / 2239 passed + 1 skipped（2240）** | ✅ **All 81 invariants passed** | ✅ 20/20 钉全红、工作树零污染 |
| 第 2 轮（R1 追加 R-DEP-03 别名清除后，§6） | ✅ 0 error | ✅ **134 files / 2239 passed + 1 skipped（2240）** | ✅ 81/81 | ✅ 20/20 |

- 基线 2227 → **2240（+13，只增不减 ✅）**：browse +4（tab-session ×2 / browse-upstream-contract ×2）、infra +8（doctor-config ×3 / hot-plug ×2 / ssrf ×3）、perf +1（FT-DEF-1′ 回归钉）——与三面板申报算术一致。
- 两轮均**串行执行**，零时序 flake——搜索域面板门禁首跑 9 红（expect-poll 桶在并行负载下超窗）与基建域 12 红复跑全绿，判**用例侧负载 flake 非产品**的结论被 R1 复跑佐证；处置=门禁串行跑（本轮已固化），符合 03 §2 flaky 政策（24h 内隔离）。

## 2. 六处产品修复的新鲜复审（03 §3.4 签字）

逐处独立读源码 + 验回归钉，全部通过：

| # | 缺陷 | 修复锚点（R1 实读） | 回归钉（R1 实验存在性） | 复审结论 |
|---|---|---|---|---|
| W-DEF-R11-1 | doWait 假成功（timeout_ms 被忽略 + 上游超时 isError 不检） | BrowseChannel.ts:1041-1053：`timeout: opts.expect?.timeout_ms` 透传 + `r.isError → throw wait_timeout:` → classify 落 unknown（可 fallback） | browse-upstream-contract.spec:173「timeout_ms 透传」/:184「isError→不再假 worked」 | ✅ 修复面最小、注释带真机实证链；timeout falsy（0/undefined）不透传守边界正确；unknown 可 fallback 语义与「页面慢可重试」一致 |
| W-DEF-R11-2 | TabSession 重启守卫纯 url 判定 → tab_restore 恒 no-op | TabSession.ts:124-146：overlap 判定加 targetId 通道；diff 步复用同一 snapshotIds Set | tab-session.spec:214/:241（navigate+新增→关新增；url 全变 targetId 存续→不误判） | ✅ 浏览器重启后 targetId 必全新——守卫语义不放松的论证成立；diff 复用 Set 无二次计算 |
| FT-DEF-1（infra） | doctor 直读裸 env，file 配置键不可见而运行时装配 | config.ts:330 `mergedEnv()` 单一真源（loadConfig 同源改用）；index.ts:279/:379 两 doctor 调用点接线 | doctor-cli-config-file.spec:132/:148/:165（file 2 key / env 覆盖 / bing warn） | ✅ 守 R-CI-02 消第二实现；cloud 家族键不扩面的边界裁决（O-7 留档）克制正确——动安全闸门超出最小修复面 |
| FT-DEF-2 | SIGHUP 热插拔 keys-less provider 抛 TypeError | provider-registry.ts:73/:183 `(config.keys?.length ?? 0) > 0` | runtime-hot-plug.test:324/:349（add+constructor 双路径） | ✅ choke point 正确（INV-40 唯一 add 入口）；O-8（SIGHUP 接受文件 keys 违 INV-10 精神）正确留产品 owner 裁决 |
| **FT-DEF-3（🔴 安全）** | IPv6 字面量 URL 经 TUN fake-ip 绕过 SSRF | ssrf-guard.ts:86 lookup 前剥方括号（`hostname.replace(/^\[(.+)\]$/, "$1")`）→ dns 识别字面量直返 → isPrivateIp 拒 | ssrf-guard.spec:165（gotHost 契约断言：lookup 收到 "::1"）/173/:181（mapped-hex 拒/公网不误拒） | ✅ **03 §1.2 项 1 教科书式闭环**：mock 按 producer 假设写死放过 → 修复把 mock 升级为记录 gotHost 的契约断言（producer→consumer 接缝钉住）；TUN 最 harsh 环境真机复验 6 类全拒 |
| **FT-DEF-1′（perf，🔴 安全红线）** | HighRiskGate 裸 JSON.parse 围栏响应 → gate_error 保守**放行**（C1 红线端到端失效） | HighRiskGate.ts:47/:188-190 改 `parseEvalResult`（upstream-response 单一权威），删本地 firstText 重复实现 | high-risk-gate.spec:214「FT-DEF-1 回归钉：围栏形状→gate 必须命中而非放行」+ mock 统一 upstream-mock；INV-76(m) 扩展禁旧范式回潮 | ✅ V-1/V-2/F-2 同型第 3 例 → R-CHG-03 趋势警示成立；8/8 消费点经适配器后该风险面收敛；场景 0 真机双中（rte+drag_drop byte-identical didnt） |

**裁决**：六处修复全部**维持**，无需返工。修复纪律（先判用例→再修产品→回归钉→门禁）与 03 §3.1 一致；三处 🔴 级均完成 §3.2 分类回溯（FT-DEF-3→1.2 项 1/1.4；FT-DEF-1′→1.2 项 1+1.4 项 1；W-DEF-R11-1→1.2 项 7 错误路径显式化）。

## 3. fail / 初判 fail 逐条裁决汇总

### 3.1 判「用例对→产品缺陷」（6，均已修，见 §2）

W-DEF-R11-1 / W-DEF-R11-2 / FT-DEF-1(infra) / FT-DEF-2 / FT-DEF-3 / FT-DEF-1′(perf)。

### 3.2 判「用例侧」（7，处置正确，无需改产品）

| 用例/场景 | 判定 | R1 核验 |
|---|---|---|
| F01 steps expect 大小写 / H02 fill 把 `<a>` 当输入框 / A06 wait 的 URL 语义 | 用例 bug，重测通过 | ✅ browse 记录 §0.2 留痕在案 |
| L05/L06 首测零增量 | **用例方法缺陷**：browse 0 结果 entry 污染持久缓存 → enrich 合法跳过；修正=每轮清缓存+warm 三段法 | ✅ ContentSecondHop.ts:531-540 gating `results.length===0 → 原样返回` 是正确行为；产品无缺陷 |
| L13 两次无 spill | 用例姿势错误：extract 不在 NAV_FIRST_ACTIONS、browse 单 action 不走 48KiB 信封（自限 4000 字） | ✅ 已升格为清单姿势注回写 U-16（防后续误判） |
| T-QUALITY-02 预期文本「didnt 不带 quality」 | **清单错**：quality 是路径轴（QualityTag.ts:88 按 served_by 打标，与 outcome 正交） | ✅ R1 读源码证实；F-a 勘误已回写 doc/17 |
| T-FEED-08/U-14-6 错误码 | 清单口径错：HTML=not_a_feed / 空骨架=feed_has_no_entries（fetch-feed.ts:408-414 双分支） | ✅ R1 读源码证实；F-b 勘误已回写 |
| 门禁 9/12 红（并行负载） | 用例侧时序 flake（F-T1 桶） | ✅ R1 两轮串行复跑零红佐证 |

### 3.3 blocked / waived / ⏸ 裁决

- **blocked 3+2**：T-SEARCH-14/T-SERPHTTP-01（裸 curl ddg=202/brave=429 第三方取证）、T-SEARCH-15（archive.org 429 裸 curl 同象；SSRF 负向已 pass）、L-COST-02（同因）、L-COST-12（9222 会话前占用，9223 旁证 ≤2s UP 在档）——均**环境/上游**，产品诚实降级语义本身被判 pass；回归条件=网络/IP/端口恢复。
- **waived 2+1**：T-SEARCH-02/06（退役，zod 拒+doctor warn 实证）、T-FALL-05（本机不可达不强造击穿——守「不与用户环境争资源」，形状由门禁 spec 覆盖）。
- **⏸ key缺失 4**：T-SEARCH-05/08/09/23（Brave）——零 key 剔除侧已真机证、单测语义全绿；假 key 422 计划级探测（T-CLI-08③）真机 pass 归 key 无效桶。配真 key 后回归。
- **blocked(人工) 2**：T-ELICIT-07/08——需 CC ≥2.1.76 客户端人工点选（子代理不可替代）；前置场景 0 降级红线已真机 pass。**建议用户择窗执行 c1 清单场景 1-3**（FT-DEF-1′ 修复后该面才首次可测）。

## 4. 03 清单审查（§1 六维 + §2 五阶段）

**§1.1 规范**：修复全部沿既有范式（isError 检查/null-safe/单一真源），零风格游离。**§1.2 数据逻辑**：本轮三处 🔴/🟡 缺陷全部落在本维（producer 契约/宿主契约/合并真源）且闭环——FT-DEF-3 把 mock 升级为 gotHost 契约断言、FT-DEF-1′ 补 INV-76(m)、INV-71 检测体+mutation 迁形（selftest 抓出假绿即改即验）是 03 §2.1 项 3「测试必须能失败」的正面示范。**§1.3 业务逻辑**：W-DEF-R11-2 的 targetId 连续性边界（重启→targetId 全新）被显式论证而非默认。**§1.4 端到端**：四面板证据均为 stdio 真机值级输出（jsonl 在档）；R1 抽查 O-2 wrap-before-cache.set、F-b 双分支、F-a 路径轴三处争议点均以源码+真机双证落定。**§1.5 性能**：L-COST 14 行回填（11 有效/2 env/1 观察注）；Heisenberg 纪律执行到位（L08 180s 样本隔离复测不复现→判环境；所有 flake 隔离复跑）。**§1.6 简单架构**：见 §5；R1 追加修复 1 处。**§1.7 冗余**：F-R11-1（doc 声称 pdf 可用 vs 真机不可达）已按真机回写清单；R1 删除 listPageTargets 死别名。

**§2 五阶段**：2.1 单测（+13 钉，selftest 20/20）→ 2.2 集成（MCP stdio 真 server 流 + 契约同步 fixture 钉：machine-mcp 四形态/upstream-mock/serp fixture）→ 2.3 冒烟（真机值级断言：byte-identical refs、缓存 2ms 命中、熔断 open→half-open 全链）→ 2.4 性能（L-COST 表 + 快速失败纪律 + 资源三采样 released 全 ✅）→ 2.5 用户（场景 0 done；07/08 人工面移交用户；**非作者签字=本 R1 记录**）。**遗留**：2.5 的 T-ELICIT-07/08 与 T-LIFE-02（visible 档防打断用户焦点）两项按 §3.3 处置，不构成本轮阻断。

## 5. 02 简单架构终判（doc/17 §6 已回填，39 行）

**分布：✅27 / ⚠️11 / ❌0 / ⏸1**（R-FF-04≡R-DEP-03 共享行）。🔴 硬不变量三条全 ✅：R-FF-01（import 图 137 模块/467 边实跑零非法边）/ R-FF-02（值级 0 环，3 个 type-only 环留档）/ R-DEP-03≡R-FF-04（R1 修复后 AST 扫 0 命中）。

⚠️ 11 项逐条裁决：

| 项 | 裁决 | 理由/去向 |
|---|---|---|
| R-DEP-03/R-FF-04 | **本轮修** | listPageTargets 纯转发别名删除、listPages public 化（§6）；修后门禁 2240 全绿零回归 |
| R-INT-06 | 记 watch | browseSingle ≥4 职责类已部分拆；候选=verifyNavigatedPage 独立 nav-verify 模块 |
| R-DEP-04 | 记 watch | schema↔interface 镜像 >60% + W1-DEF-8 前科；候选=奇偶 INV（round2） |
| R-CHG-03 | 记 watch | mock≠真契约 4 例实证（V-1/V-2/F-2/FT-DEF-1′）；INV-76(m)+upstream-mock 铁律已补，趋势持续观察 |
| R-CI-07 | 记 watch | 冲突清单在册非 PR 模板强制；进 PR checkbox |
| R-CI-08 / review#1 | 记 watch | 两套 tmp 根（SPILL_ROOT vs /tmp 硬编码，win 兼容隐患）；统一 SPILL_ROOT 与 O-1 截断帽同批裁决（round2） |
| R-INT-02 | 接受 | 4 修改点有 INV-81(f)/INV-76(k) 机械守护（漏一处即红）；长期收敛注册器单点 |
| R-INT-03≡R-DEP-01 | 接受 | 3 席=BaseChannel 生命周期契约，构造参=依赖/测试注入位（02 §B-2 上下文，satisficing） |
| R-INT-05≡R-CHG-01 | 接受 | 版本合批放大属观测口径问题（按 feature 拆 commit 即让度量生效），非结构劣化 |
| R-FF-03 | 接受（声明） | 未接复杂度扫描——「未度量」显式声明，起步最小集不依赖本条 |

R-INT-07 两面板分歧（browse ⚠️ vs perf ✅）裁决：**✅ + watch 注**——chrome ledger 消费面 ≥4 类各持 kill 权是单用户 CC 设计内（单写者台账 + kill 前 cmdline 归属验证红线在），多 server 并发互扰（OBS-R11-3，2 次实证）有测试出口 `LASSO_LAUNCHED_CHROMES_PATH`；若未来多实例产品化再升 ⚠️。**起步最小集（02 §1 六条）**：R-FF-01 ✅ / R-FF-02 ✅ / R-DEP-03 ✅（修复后）/ R-CHG-01 ⚠️（接受理由在格）/ R-CI-01 ✅ / review 三问 ⚠️（#1 命中 1 项记 watch）。**阈值均为起点值未校准（02 §0.3）**。

## 6. R1 追加修复（本轮内完成 + 门禁 + 复测）

- **R-DEP-03 别名清除**：`src/logged-in/TabSession.ts` 删 `listPageTargets()`（方法体仅 `return this.listPages()`——全仓 AST 启发式唯一穿堂命中）、`listPages()` public 化并合并文档注释；`src/channels/LoggedInChannel.ts:228` 唯一 caller 改直调。全仓 grep 零残留引用（注释中的裁决记号除外）。行为零变化（纯可见性/命名重构）→ 测试数不变；门禁第 2 轮 build+2240+81+20/20 全绿（§1）。

## 7. 观察项裁决汇总（不构成本轮阻断）

| 观察项 | 裁决 |
|---|---|
| O-2（search）attribution 字段随缓存外溢 | **接受**：外溢字段是**准确的**溯源信息（该条确由该 channel 该 rank 产出），非错误数据；T-SEARCH-10 契约（不入 key+命中重 wrap）保持、INV-11 未动、无隐私面。改法（cache.set 前剥离）= 为零用户收益加一层变换，记 watch：若后续消费者依赖「非 attributed 调用零额外字段」的严格契约再改 |
| O-1（search）截断帽 201/501 边界 | **接受**：省略号是标记符非内容；口径注已回写 doc/17（T-FEED-05 行）；若统一改 `slice(0,N-1)+"…"` 须两处同改 |
| OBS-R11-3 共享台账多 server 互杀 | 接受（单用户设计内；测试出口已在；见 §5 R-INT-07 裁决） |
| infra O-6 logged_in 死 CDP snapshot 返 worked（错误页文本） | **记 watch→round2 logged_in 专项**：与 W1-DEF-5 同类的假成功候选（snapshot 路径缺 NAV_ERROR_SIGNATURES 二次校验）；非本轮回归、需活 CDP 环境验证修复 |
| infra O-7 cloud 键 file 不解锁 / O-8 SIGHUP 接受文件 keys | 记 watch→产品 owner 裁决（动安全闸门/INV-10 精神，非最小面） |
| OBS-R11-1 wait 缺 text 归因弱 / OBS-R11-2 fill 可填性预检 / OBS-R11-4 steps 无 per-step options / OBS-R11-5 附录 href 相对 | 记 watch（P3 候选，round2 裁决） |
| search O-3 第二跳视频页裸图 markdown / O-4 serp_health brave miss 不计数 / O-5 feed NXDOMAIN 错误串未归一化 / infra O-2 422 额度措辞 / infra O-3 双 warn / infra O-9 root_ref 拼写 | 记 watch（低优先） |
| O-6（search）门禁并行 flake | 接受并固化处置：**门禁必须串行跑**（R1 两轮串行零红实证） |

## 8. round2 复核清单（移交）

1. **环境恢复回归**：T-SEARCH-14 / T-SERPHTTP-01 / L-COST-02（TUN 出口解挡后）、T-SEARCH-15（archive.org 限流解除）、L-COST-12（9222 空闲口冷启真值）。
2. **人工面**：T-ELICIT-07/08（CC ≥2.1.76 按 c1 清单场景 1-3）；T-LIFE-02（visible 档专门窗口）。
3. **watch 项裁决批次**：两套 tmp 根统一 SPILL_ROOT + O-1 截断帽是否两处同改；R-DEP-04 奇偶 INV；infra O-6 snapshot 二次校验；OBS-R11-2/4/5；R-CI-07 PR checkbox。
4. **双盲验证（03 §3.6）**：派新 agent 复查 INV-76(m)/INV-71 迁形后的抓获力（防规则空转）；并对 R1 的 R-DEP-03 修复做一次非作者复核（本轮 R1 亦为修复作者，round2 需新鲜眼睛）。
5. L-COST-05/06 偏慢样本持续观察（搜索域样本超 44%/<50% 判读线，判环境+场景）。

## 9. 残留清理复核（R1 收尾盘点）

- 本裁决官零 spawn 浏览器/零起被测 server（门禁 vitest 自收）；未触碰用户 Chrome（pid 2420）与兄弟会话 chrome-devtools-mcp 树。
- 工作树=四面板 + R1 的修复文件（git status 18 处 M + 执行记录未跟踪件），门禁两轮全绿在档（/tmp/ft-verdict-gate{,2}.log）。
- doc/17 回填完成：状态列（§1/§2 全部执行面）、§5 L-COST 14 行、§6 39 行判定+终判汇总、清单勘误 F-a..F-d/F-R11-1..3/O-1/O-4/U-16 姿势注/§0.3 历史表警示。
