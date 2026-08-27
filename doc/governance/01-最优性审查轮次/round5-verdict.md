# 第 5 轮最优性审查 · 终裁（verdict）

> 裁决官：Round-5 终裁。日期：2026-08-17。
> 输入：round5-{browser,search,desktop,arch}.md 四域复审报告全文 + round4-verdict 终止协议。
> 方法：**不采信文档**——对四域全部关键声称做白盒双源亲验（grep/逐行实读/git/npm 亲测），门禁四链（build / npm test / check-invariants / cargo test）全部独立复跑。基线：v1.13.0 工作树（HEAD=0b07536 v1.11.0；npm latest=1.10.0 实测确认）。

---

## 0. 裁决

# DECISION: ROUND-CLEAN

**调优项清单：空集（T5-N 无一立项）。** 四维复审（技术选型/架构/范围/实施）全部最优；round4 唯一调优项 T4-1 已落地并通过机械化验收；四域 watch/NO-GO 零翻案（且两条证据勘误、两条新 watch 均为方向加固）；门禁基线 1961/79/207 不减。**按 round4-verdict 终止协议，循环在发布收口（P-1，用户动作）执行后终止。**

---

## 1. 裁决官独立抽验记录（双源核实，本轮亲做）

| # | 声称（四域报告） | 裁决官亲验 | 结果 |
|---|---|---|---|
| 1 | T4-1 已实施：`grep "注入路径健在" src/` 零命中 | 亲跑 `grep -rn "注入路径健在" src/` → **exit=1 零命中** | ✓ |
| 2 | T4-1 五处新文案逐字在位 | 亲读 doctor.ts #27（「v1.11 起走原生 list_network_requests 直调；旧 PerformanceObserver 注入路径已随 T5 删除」）+ doctor.ts:1906 块（「切换完成，非待办」）+ types.ts:152（network_timeout_ms「仅为 zod 契约稳定」）+ types.ts:479/:495（「v1.11 原生采集无 TUN timing 干扰面」×2）——**五处逐字对齐 round4 裁决文案**；且 doctor.ts #27 与运行时 detail（「注入路径已删，F2 限制关闭」）文件内自洽 | ✓ |
| 3 | T4-1 排除项 network.ts:119 / descriptions.ts:641 正确保留 | 亲读 src/tools/network.ts:119（ResourceEntry shape 历史来源注释）+ descriptions.ts:641（"switched from" 历史对照）——均非失实活声称 | ✓ |
| 4 | browser 历轮锚点零回退 | SubprocessManager.ts:49 `LOCKED_CDP_MCP_VERSION="1.7.0"` ✓；HeadlessChannel spec 五 flag（--no-usage-statistics / --disable-blink-features=AutomationControlled / --user-agent= / --accept-lang=（含 T3-1 E1' 依据注释）/ --viewport= / --proxy-server= 条件展开）✓；`defaultHeadlessProfileForHost()`（HeadlessChannel.ts:41-43）mac_chrome 单源 ✓ | ✓ |
| 5 | arch 历史 10 项零漂移 | parseCdpPort（config.ts:138-151 三分支+warn+fallback）✓；wrapHandler（runtime/ToolManager.ts:105-108 三件横切 + 「不演化成可插拔管道」纪律注释原样）✓；setMetrics 接线（index.ts:1008 + WHY 注释「全仓生产零调用」）✓；stdin EOF 双钩子（index.ts:1266-1267 end/close）✓；steel 3s race（index.ts:1218-1221 Promise.race）✓；SDK `^1.30.0`（package.json:50）✓ | ✓ |
| 6 | search 域零触碰 + 锚点一致 | SearchChannel.ts:153 `search_recency_filter` 条件展开（不传=无字段，byte-identical 负向守护的载体）✓；MachineMcpSearchChannel.ts:38 ZHIPU_RECENCY_MAP 单一事实源 import ✓；SearchCache.ts freshness 尾拼注释+签名在位 ✓；extract.ts:55 CJK_RE / :62-63 serpEngineForQuery ✓；markdown-extractor.ts:116-120 useAsync:false 红线 + separateMarkdown:true ✓ | ✓ |
| 7 | desktop W1/W2 证据链属实（新 watch 不立项的依据） | W1：ax.rs:625-639 `ascii_char_to_keymap_spec`→CGEvent 裸 keycode 路径 + :641-643 读回跳过注释（「读失败/非 string 不视为失败——Electron 自绘控件」）——「AXValue 不可读交集下理论错字符+ok:true」推理成立 ✓；W2：ScreenshotVlmProvider.ts:445-452 `num()` 一切有限数直传绝对像素、无形态判定 ✓ | ✓ |
| 8 | desktop 其余接缝 | cgevent.rs:192-198 Event Synthesizing 预检（denied→诚实报因）✓；DesktopChannel.ts:259-311 verifyExpect 接线 + consecutive≥2 采样 ✓ | ✓ |
| 9 | 门禁基线 1961/79/207 | **裁决官独立复跑**：`npm run build` ✓ / `npm test` **122 files，1960 passed + 1 skipped（1961）零失败零 flake** / `check-invariants` **79/79 全绿**（INV-76/77/78/79 亲见 PASS）/ `cargo test`（rust-helper）**8 二进制 207 passed 零失败**（42+101+9+10+30+9+6+0） | ✓ |
| 10 | 发布积压属实 | `npm view lasso-mcp` → **latest=1.10.0**；package.json=**1.13.0**；HEAD=**0b07536**（v1.11.0）；git 46 M + 20 ??（含 round3-5 文档；四域报告记 62 系 round5 文档落盘前口径，自洽） | ✓ |

**抽验结论**：四域报告全部关键声称经亲验属实，零虚报、零夸大。三条「不翻案」推理链（基准文章非实质更新、W1/W2 缺 Lasso 侧实测失败、arch 两条证据勘误方向加固）逻辑与证据均成立。

---

## 2. 四维总评

| 维度 | 判定 | 依据 |
|---|---|---|
| **技术选型** | **最优，维持** | 五轮零换轨：chrome-devtools-mcp 锁版 1.7.0=latest（第四轮）/ defuddle 0.19.2=latest 且 2026-08 社区媒体面反向验证（T2-3/T2-4 押注引擎成为焦点）/ SDK ^1.30.0=v1 latest / AXAPI+Rust 四档获品类共识第 4 独立佐证（dev.to AXAPI 通用接口论）。新浮现项目全部三重不符或归入既有 watch 族（Donut Browser AGPL+闭源引擎+GUI 形态 NO-GO；g-search-mcp 归第二免费兜底引擎族）。registry 六包零变化，surveillance 重启条件未触发。 |
| **架构** | **最优，维持** | INV 纪律闭环（79 全绿 + 14 样本红转四度复证）；横切单点不演化成管道；停机链全路径有界（steel 3s race 亲验）；doctor.ts 斜率 +67→+64→+25→+1 趋零——R9「膨胀」叙事实际终止；简单架构红线（反过度设计）贯穿五轮无一违例。arch 域两条证据方法学勘误（W-2 触发条件被官方负面裁决 / #1564 已关≠已修）不改变任何决策方向，反而证明「无新证据不翻」纪律吸收了证据噪声。 |
| **范围** | **最优，维持** | 四通道+forest 统一入口范围五轮零漂移；agent 层/browser 层/GUI 矩阵层新项目全部正确不收录；五轮拒绝清单累积生效（FastMCP-化/R8 融合/outputSchema 预铺/Windows 深度实装/第二兜底引擎提前接线等全部维持拒绝）；无范围蔓延亦无范围缺失。 |
| **实施** | **最优，维持** | 四轮累计 37 项 + T4-1 全部落地且经本轮独立抽验/独立 mutation（search 3 针全新针位全 kill）/独立直读（desktop 七接缝）三重复证；注释卫生族（T2-2→T3-5→T4-1）全域闭环，全 src 无「声称已删机制健在」类失实；门禁基线 1961/79/207 五轮不减（round1 commit 0b07536 时 1906+79 → 现 1961+79+54 净增全部来自轮次守护测试）。 |

---

## 3. 调优项清单

**空集。**（编号 T5-1 起无一立项）

五准入终判：
1. **白盒证据差距**——四域报告声称的差距清零经裁决官独立抽验属实（§1 全表）；本轮无任何新发现的源码级差距。
2. **既有能力范畴**——无可优化对象；W1/W2 修法虽已预写（均 XS），但缺 Lasso 侧实测失败，属「为可能性加机制」，违反 round3「先拿事实再加参数」纪律与简单架构红线。
3. **单轮可完成 / 收益可验证**——无候选自然豁免。
4. **不破红线**——闭轮阶段为找事而立项本身违终止协议（round4-verdict 明示）。
5. **门槛只紧不松**——desktop W1/W2 是本轮唯一有上游新证据的候选，按最紧口径（须 Lasso 侧实测失败）不立项，正确。

## 4. 拒绝清单（本轮看过且拒绝）

| # | 候选 | 拒绝理由 |
|---|---|---|
| RJ-1 | desktop W1（键盘兜底非 US 布局 ASCII 门）提前实施 | 上游实证（Peekaboo #330）仅证明失败类存在；Lasso 零实测失败，主路径 AXSetValue 零事件合成；触发条件=手测清单 E 节在中文 IME 激活态实测产出错字符且 ok:true。挂 watch。 |
| RJ-2 | desktop W2（parseVlmActions 归一化坐标形态判定）提前实施 | 同上纪律：Lasso prompt 已传 width/height，配置 VLM 是否产出 normalized 未观测；触发条件=真机 VLM 观测到 [0,1]/[0,1000] 刻度坐标致落点错误。挂 watch。 |
| RJ-3 | 把发布收口（commit v1.13.0 + npm publish）立项为调优项 | 非代码项；round4-verdict 附则已定为流程动作。本轮裁决官依「Commit or push only when the user asks」不代行——归 P-1 用户动作。 |
| RJ-4 | 手测清单 A-G 立项 | 非代码项，归用户真机签核（P-2）；E 节兼 W1 触发判定，建议中文 IME 激活态跑。 |
| RJ-5 | defuddle master 未发版 commits 跟进（footnote #351/Reddit Atom #403） | 锁版=latest 政策下无 npm release 不跟进；记为下轮（若存在）复查锚点即可。 |
| RJ-6 | 依 arch 域证据勘误做任何代码动作 | 两条勘误（CC Tasks 三 FR 全部 not_planned/duplicate；#1564 closed completed 但 1.30.0 未含修复）方向均为「维持现状」；唯一产出是方法学记档（issue 状态必须 REST 直验）。 |

## 5. 收尾裁决与剩余动作

**DECISION: ROUND-CLEAN。** 四维最优、门禁全绿、零翻案、调优项空集——round4-verdict 终止条件①（T4-1 落地+门禁绿）**已满足**（本轮裁决官独立复证）；条件②（发布完成）为用户动作：

- **P-1 发布收口（最优先，唯一实质欠账）**：一次性 commit v1.13.0（工作树含四轮 ≈40 项用户可感知修复：孤儿进程 stdin-EOF/假 worked/表格保真/where.ref/locale 一致性/region 坐标补偿等）+ `npm publish`。门禁四链已五度复证全绿，无再延迟的技术理由。
- **P-2 手测清单 A-G 用户真机签核**：七节（stdin-EOF / OS 指纹 / Accept-Language echo / Electron type（建议中文 IME 激活态，兼裁决 W1）/ drag / find actions+truncated / VLM 真机（兼 W2 观测））。
- **W1/W2 挂 watch**（触发即修，修法已预写，均 XS）；arch 域 W-1 六条/FastMCP PyPI 锚/defuddle 未发版 commits 等全部 watch 项随本轮记档冻结，重启条件=registry/上游 issue 版本级变动。

**循环终止**：P-1 执行后本审查循环（round1→round5，37+1 项调优全部落地）即达终态；此后进入静默 surveillance（锚点与验证方法已在本轮各报告固化：issue 状态 REST 直验 / 缓存敏感证据 curl 原始 HTML / npm 同名异包防误引 / cargo 全路径调用）。
