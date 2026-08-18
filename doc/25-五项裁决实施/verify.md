# verify — 五项裁决实施 真机验证报告（v1.17.0）

> 2026-08-18 · 真机验证员（parse24 §8 最终验收条款逐项执行）。
> 验证对象：W1-W4 四线实施终态（A3→A1→A2′→B1→C1→C2）+ 本轮验证修复。
> 验证方法：**真实 MCP server**（`node dist/index.js`，最小 stdio JSON-RPC harness，零依赖）真机调用 + 单测/INV 复跑 + 文档面清点。harness 与证据存 `/tmp/lasso-verify/`（api.json / scrape2.json / stale5.json / cb-en.json / cb-cn*.json / local*.json / c2-*.json / lcost*.json）。

---

## 0. 验证总结论

**PASS（含 2 个真机必修缺陷已修 + 回归钉）**。五项裁决全部按裁决原文落地且真机可走通；真机验证抓出 **2 个 mock 单测不可能发现的契约级缺陷**（W 层实现遗漏），已修复并加 9 条回归测试。门禁全绿：**build 0 错 / 2227 tests（2226 passed + 1 skipped，较基线 2032 净 +195，较 W4 终态 2218 净 +9）/ 81 INV / inv-selftest 20/20 / rust-helper 零改**。

### 真机抓出的 2 个缺陷（verify 轮修复，均已回归钉死）

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| V-1 | **machine_mcp 真机永远拿不到结果**（每次搜索静默降级 scrape 链——A3「智谱能力唯一载体」名存实亡） | 上游 web_search_prime 现行返回**双重编码裸数组**（`text = JSON.stringify(JSON.stringify([{title,link,content,refer}]))`，2026-08-18 本机 open.bigmodel.cn 实抓实证），W1 的 `parseMachineMcpContent` 只认单次编码 `{search_results}` 对象 → 恒解析 `[]` → `outcome=unknown` → 永远 fallback。**03 §1.2 项 1（producer 契约须 L1/L2 证据）违例**：实现按注释里的旧形状写，无真实运行捕获 | `MachineMcpSearchChannel.ts`：剥层 ≤3 次 + 裸数组/`search_results`/`results` 四形态兼容；+4 测（双重编码真机形态/单层裸数组/病态三层/双层对象） |
| V-2 | **include_refs 附录在长页被截断丢失**（C2 ref 句柄经 MCP 响应不可达，失去存在意义） | `data.markdown = truncatePreview(preview)` 上限 4000 字符，而 refs 附录缀在 markdown **末尾**——books.toscrape 真机实测：正文 5529 + 附录 3613，响应里附录整段被切。W4 测试用短 fixture 不可见 | `BrowseChannel.ts` 新增 `truncatePreviewKeepingRefs`：正文照常截断、附录钉尾（无附录时 byte-identical 旧语义）；preview/markdown 两出口都用；+5 测 |

---

## 1. 逐项验证表

### ① A1 质量轴真机（三态各现一条）✅

| 态 | 真机命令/条件 | served_by | quality | 结果 |
|---|---|---|---|---|
| **api** | `search {query:"lasso mcp github", no_cache}`（machine_mcp 正常） | `search.machine_mcp` | **`api`** | worked，10 条蓝链，1824ms |
| **scrape** | 同查询 + `LASSO_MACHINE_CLAUDE_JSON_PATH=<不存在>`（产品自带隔离 env，无 API 源） | `serp_http:baidu`（CJK 查询）/ `browse_headless`（EN） | **`scrape`** | worked，serp_http:baidu 17 条蓝链 1439ms；browse_headless（DDG 当日 202 反爬） |
| **stale** | machine_mcp 隔离 + `PATH=/usr/bin:/bin`（browse spawn npx ENOENT）+ 预置录制（经产品自身 `RecordingStore.save`） | `recording_replay` | **`stale`** | 全链 61.4s 熔断后 replay 命中，返回录制 fixture，`actions_and_results` 如实记录 serp_http unknown + browse_headless unknown |

三态均由真实 server 输出 `quality` 字段（V-1 修复前 api 态不可达——修复即本项验证的一部分）。

### ② A3 链终态 ✅

- **链序** `machine_mcp → brave → serp_http → browse_headless → recording_replay`：stale 态运行的真实 `actions_and_results` 依序展示 `serp_http → browse_headless`（brave 无 key 不注入）；INV-80 墓碑机械守卫全绿；KEY-GUIDE/README 链叙事同步。
- **假 key 静默忽略**：`ZHIPU_API_KEY=fake…` + `ZHIPU_ENDPOINT=https://fake.example.invalid` 下搜索照常 `worked | search.machine_mcp | quality=api`（9 条）——键零消费；provider registry 仅 3 providers（browse_headless/browse_logged_in/brave，无 zhipu）。
- **doctor 提示**：配假 key → `zhipu_keys_retired: warn`「该配置永远不被消费」；未配 → `pass`（常态）。config 文件残留路径已由 W1 集成测覆盖（`doctor-cli-config-file.spec.ts` 2 条，复跑绿）。
- **诚实破坏**：`engine:"zhipu"` → zod 拒绝，错误信息列出合法值 `auto/brave/fallback_chain`。

### ③ content_blocks 真机（EN+CN）✅

| 查询 | 耗时 | per-result 标注 | 语义核对 |
|---|---|---|---|
| EN `rust tokio async runtime tutorial` cb=3 | 2482ms | tokio.rs `ok` 5332 字符（预算内）；medium `fetch_failed`（反爬如实标注）；async-book `ok`+`truncated:true` 6110 字符（超预算裁剪）；第 4/5 条无标注（未富化=只取 top N）✓ | 四态语义全对 |
| CN `量子计算 原理 科普` cb=3 | 6697ms | IBM 中文页 `ok` 1550 字符（中文正文+查询裁剪）；niar.org.tw `ok` 1749；YouTube `ok`+`truncated` | CJK bigram 裁剪真机可用 |
| CN `王阳明 心学 思想` cb=3 | 3266ms | wikipedia/philarchive/知乎 3 条全部 `fetch_failed`（反爬站如实标注，蓝链保留，主 outcome/served_by 不变） | **tri-state 诚实红线真机成立**：失败不伪装、不改变主结果 |

附加：`extract_failed` 态由 `教育部 双减` 查询（hao123 页）真机出现。cache 纪律代码核验：`cache.set` 恒在富化前、content_blocks 不入 key（search.ts:424/611，INV-11 不动）。

### ④ search_local 真机 ✅

| 源 | 真机结果 | 隐私红线抽验 |
|---|---|---|
| history | `query:"lasso"` 64ms → 5 条**本机 Chrome 真历史**（github.com/wangdong233/lasso 各页，含 visited_at ISO 时间）；`profile:"Profile 1"` 定向 → `profiles_searched:["Profile 1"]` ✓ 多 profile | 输出字段仅 `profile/title/url/visited_at/snippet`——**无 content/正文全文字段** ✓；WAL 规避：`mkdtemp` 临时目录复制 + `finally rmSync`（只删临时目录）✓ |
| files（mdfind） | `query:"lasso mcp"` 571ms → 5 条真实 Spotlight 路径 | 字段仅 `path/modified_at`——**只读元数据不读文件内容** ✓ |
| notes | `query:"架构"` → `didnt + retrieval_method/error=notes_deferred_v2` | **诚实推迟**（enum 可见但未开放，不伪装空结果）✓ |
| limit 硬顶 | `limit:500` → zod 拒绝（isError） | 50 硬顶不可绕 ✓ |

INV-81（只读/无全文/limit≤50/零网络/日志只记 query_len）81 项全绿 + selftest 20/20。

### ⑤ C1 降级路径 + C2 include_refs 对照 ✅

**C1**：
- 红线测试核验（复跑 `high-risk-gate-elicitation.spec.ts` 18 测 + `elicitation-port.spec.ts` 21 测全绿）：`clientCapabilities` 未声明 elicitation 的**四态**（undefined / `{}` / 有 elicitation 无 form / elicitation.url 有 form 无）→ `assessStep` 与现行 **deep-equal** + `elicitInput` **零调用**（spy 计数=0）——裁决红线「100% 走现行 didnt」测试钉死。
- 附带钉死：elicitInput throw（timeout/传输/SDK 守卫同步 throw）→ blocked 不放行；port 违约 → fail-closed；**accept 无记忆**（连续两步各确认一次，第一步 accept 第二步 decline → 第二步 blocked，无跨步授权）；未命中 pattern → port 不被调用。
- **真机手测清单存档**：`doc/25-五项裁决实施/c1-真机手测.md`（场景 0 降级 + RTE/drag_drop/toast 三 pattern × 继续/跳过/终止/超时/重复确认；前置 CC ≥2.1.76）。真机交互验证需 CC 客户端弹窗，留待用户按清单执行（本机 browse_logged_in 需 CDP :9222，用户 Chrome 未开调试口，doctor `cdp_9222_logged_in: fail`——不替用户重启浏览器）。

**C2**（真机 books.toscrape.com，先 navigate 后 extract 的会话语义）：

| 档 | include_refs | 持久化 preview | data.markdown | refs 附录 |
|---|---|---|---|---|
| markdown | 关 | 5529 字符 | （截断后）无附录 | 无 ✓（缺省关 byte-identical） |
| markdown | 开 | 9142 字符 | V-2 修复前附录被 4000 上限切掉 / **修复后 7635 字符含完整附录** | `[r1] a "Books to Scrape" → index.html`… `## Interactive refs` ✓ |
| raw | 开 | — | — | `ignored_include_refs:true` 运行时忽略标注 ✓（宽松进严格出） |

- **ref→click 真机往返**：extract(include_refs) → `click selectors:{click:"r3"}`（r3 = `a "Books"`）→ worked → 后续 snapshot 命中 category 页（`books_1` 出现）✓。ref 失效语义（`ref_stale_re_snapshot`）由单测钉死（browse-refs-flow / extract-refs 28+80 测绿）。
- 正文零内嵌标记核对：OFF 体与 ON（去附录）内容一致，附录独立段。

### ⑥ L-COST 表更新（第二跳自研版延迟实测；本机 2026-08-18，TUN 代理网络，每项独立 server 进程）

| 场景 | 第一跳基线 | 总耗时 | **第二跳增量** | 产出 |
|---|---|---|---|---|
| EN cb=3（rust warp；1 ok + 2 fail） | 2086ms | 3475ms | **+1389ms** | 6295 字符正文 |
| EN cb=3（asyncio；2 ok + 1 fail） | 1424ms | 3974ms | **+2550ms** | 12290 字符正文 |
| EN cb=5（warp；3 ok + 2 fail） | ~3981ms（2 次均值） | 4811ms | **~+900ms**（并发 3 摊薄） | 15203 字符正文 |
| EN cb=3（tokio；2 ok 其中 1 truncated + 1 fail） | — | 2482ms | **~+700ms** | 11442 字符正文 |
| CN cb=3（量子计算；2 ok + 1 fail） | — | 6697ms | ~+3-5s（含 machine_mcp 握手抖动） | 3299 字符正文 |

**结论**：自研第二跳增量成本 **p50 ≈ +1.4s / 实测区间 +0.7s~+2.6s**（wall-clock，并发 3；单条 5s 硬超时、整体 15s 软预算封顶）；单位产出 ≈ 5-6k 字符/成功条（预算 6k）。失败条目（403/反爬）快速失败不拖尾。对照（L-COST 分层）：第一跳 machine_mcp 1.4-4.1s（MCP 握手抖动主导）≫ 第二跳增量——第二跳不是延迟瓶颈。

### ⑦ 文档面 + version ✅

- **README ×8**（zh 主 + de/en/es/fr/ja/pt/ru）：① 智谱段全部改 machine MCP 口径（能力表/零配置主路径/`#36 machine_search_mcp` 指引）✓ ② zhipu key 退役说明（⚠️ 段落 + 降级顺序括注「静默忽略 + doctor 提示」；**zh 版原残留「要配就三步 {ZHIPU_API_KEY…}」误导示例已改为 Brave-only 两步 + 退役警示**——verify 抓出的文档级失实）③ search_local + content_blocks 用户段 8 语言新增（本验证轮补齐——W 层未写）④ v1.17 changelog 条目 8 语言 ⑤ 免费能力表补「本地私有搜索」。
- **KEY-GUIDE**：machine MCP 唯一路径（核实日期 2026-08-18）/ `ZHIPU_API_KEY`+`ZHIPU_ENDPOINT` 退役行 / free_only 表 L1 语义 / doctor 检查项 / 零 key 新能力段（verify 补）✓。
- **version 1.17.0 三处**：package.json / index.ts `LASSO_SERVER_VERSION` / doctor.ts `LASSO_VERSION`（INV-63 对齐）+ 3 处测试断言（doctor-v17 / doctor-v10 / doctor-cli-config-file）+ doctor 实跑回显 `lasso_version:1.17.0` ✓。附带：package-lock.json 根 version 自 v1.12.0 起漏更（历史漂移）已同步 1.17.0。
- 其余文档面清点：ARCHITECTURE.md / TROUBLESHOOTING.md 零 zhipu 直连残留（grep 核验）；doc/09 排期表无 v1.17 行（历史惯例补排期，非用户面，记为遗留小项不阻断）。

---

## 2. 03 六维审查（/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md §1）

| 维度 | 结论 | 证据/发现 |
|---|---|---|
| 1.1 规范 | PASS | 新命名一致（QualityTag/ContentSecondHop/search-local/ElicitationPort/extract-refs）；注释全部 WHY 级（含裁决/doc 引用链）；测试名领域行为式。自动化闸门（tsc+INV+vitest）全绿，人审零 style 消耗 |
| 1.2 数据逻辑 | **PASS（修 2 后）** | 🔴 项 1 违例 1 处已修：V-1（parseMachineMcpContent 按 v1.4 注释形状写、无上游真实捕获——双重编码数组才是现行契约；修复附 2026-08-18 实抓证据进代码注释）。🔴 项 2 语义缺口 1 处已修：V-2（附录字段在截断下的缺失语义=「被切掉」，未答「字段不在时行为」）。项 9 运营契约：KEY-GUIDE 逐条核实日期 2026-08-18 / Brave 免费档取消已标 / zhipu 退役有 INV-80 墓碑。四态 content_status / ignored_include_refs / notes_deferred_v2 字段缺失语义全部显式 |
| 1.3 业务逻辑 | PASS | C1 确认无记忆=INV-14 反博弈延伸（测试钉）；第二跳并发池 + 15s 预算边界有测；fanout 三态（双源/单源/零源）专项测试（W1 交付，复跑绿）；无新增自启守护线程（1a n/a） |
| 1.4 端到端 | PASS（本轮即执行） | 值级 trace：五特性全部经真实 server 真机走通（§1 表）；**两个 mock 不可见缺陷恰证 §1.4-1/2**（「单测过 ≠ e2e」：V-1/V-2 均为单测 mock 形状与真实 producer 形状的差）。受影响文档面已清点（⑦） |
| 1.5 性能+PRR | PASS | 性能四问以 L-COST 实测回答（§⑥）；feature flag=opt-in 参数缺省关（byte-identical 基线测试钉）；rollback=参数关闭即回旧行为；观测=evt 结构化日志（search_local 按 INV-81(e) 只记 query_len）。Heisenbug 纪律 n/a（无时序敏感修复） |
| 1.6 简单架构 | PASS | 新增 1762 行/7 文件全部单一职责；**零新 npm 依赖红线守住**（node:sqlite/child_process 内建）；单 fallback 引擎不动（INV-4/55）；quality 单一真源 QualityTag；不建空壳 channel（search_local 走纯本地工具先例，R-ABS-01） |
| 1.7 冗余废弃 | PASS | zhipu 死层清除=INV-80 墓碑范式（照 INV-54 先例）；文档零失实残留（本轮修 zh README 误导示例）；package-lock version 历史漂移修正；遗留小项：doc/09 排期表无 v1.17 行（非阻断） |

**诚实记录的真机观察（非本轮缺陷，不阻断，供后续裁决）**：
1. browse_headless 对「DDG 202 挑战页」仍报 `worked+0 结果`（v1.14 级联语义：nav+snapshot 成功即 worked）——本机验证日 DDG 对该 IP 反爬，EN 零 key 路径暂拿不到结果（serp_http→brave 429 同因）。环境性，非代码回归；若常态如此可考虑「worked+0 视作 unknown 继续级联」的裁决变更。
2. browse `extract/snapshot` 单发（无先行 navigate）作用于 about:blank（NAV_FIRST_ACTIONS 只含 network/screenshot/pdf）——会话语义是设计（CC 常规用法先 navigate），但 README 未写明；已在 verify 记录。
3. replay（stale 档）在健康机器上几乎不可达——需 Chrome 启动失败级故障（browse_headless 连 Chrome 错误页都算 worked）。ZB-3b 新鲜度门因此实际很少触发。语义诚实但可达性低，记录备查。

---

## 3. 门禁终跑（verify 全部改动合入后）

| 门禁 | 基线（任务书） | W4 终态 | **verify 终态** | 结论 |
|---|---|---|---|---|
| `npm run build` | ✓ | ✓ | ✓（tsc 0 错） | 通过 |
| `npm test` | 2032 | 2218（2217+1 skip） | **2227（2226 passed + 1 skipped）** | 较基线 **+195**、较 W4 **+9**，只增不减 ✓ |
| `npm run check-invariants` | 79 | 81 | **81 全绿**（INV-80/81 墓碑+隐私新增项在列） | 通过 |
| `npm run inv-selftest` | 15/15 | 20/20 | **20/20**（pin 全翻红，工作树零污染） | 通过 |
| `rust-helper/` | 零改 | 零改 | **零改**（git diff 空） | 通过 |
| 真机 doctor | — | — | `lasso_version:1.17.0` / zhipu_keys_retired pass / machine_search_mcp pass / invariants 81 | 通过 |

## 4. verify 轮改动清单（除验证外的最小修复，全部有测试钉）

| 文件 | 改动 | 理由 |
|---|---|---|
| `src/channels/MachineMcpSearchChannel.ts` | parseMachineMcpContent 剥层+四形态兼容（V-1） | A3 前提修复 |
| `src/channels/BrowseChannel.ts` | truncatePreviewKeepingRefs + preview/markdown 两出口（V-2） | C2 可用性修复 |
| `test/unit/machine-mcp-search-channel.spec.ts` | +4 测（含真机双重编码形态回归钉） | V-1 钉 |
| `test/unit/extract-refs.spec.ts` | +5 测（附录感知截断） | V-2 钉 |
| `test/unit/v114-tail-fixes.spec.ts` | 源锚正则随 V-2 更新（语义不变） | 锚点维护 |
| `package.json` / `src/index.ts` / `src/doctor/doctor.ts` / `package-lock.json` | version 1.17.0 | ⑦ |
| 3 个测试文件 version 断言 | 1.16.0 → 1.17.0 | ⑦ |
| `README.md` + 7 语言 | content_blocks/search_local 段、v1.17 changelog、zh 配置示例退役修正、能力表、版本行 | ⑦ |
| `doc/KEY-GUIDE.md` | 零 key 新能力段 | ⑦ |
