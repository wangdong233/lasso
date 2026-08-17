# 决策文档 B：本地私有数据搜索——并入 Lasso 还是独立 MCP（D-DECISION，交用户裁决）

> 2026-08-18 · doc/24 颠覆性调研 verdict 产物。依据：scan-edge §2（Rewind/Recall/组件事实）+ zero-base ZB-5 + 本裁决官对本机状态的核实。

---

## 0. 一句话问题

「我上周看过的那篇文章在哪」「我笔记里记过 X 吗」——今天 CC 完全无法回答（claude-mem 只覆盖对话记忆）。这是**整类缺失**，且 2025-12 之后 macOS 上没有存活产品（Rewind 2025-12-19 被 Meta 收购后停服；Recall 不上 mac）。要不要建、建在 Lasso 里还是旁边，是范围裁决。

## 1. 事实基座

| # | 事实 | 来源/验证 |
|---|---|---|
| F1 | 底层组件全成熟零依赖守护：Chrome 历史 = SQLite（History）、Apple Notes = SQLite（NoteStore.sqlite）、文件 = mdfind/Spotlight、剪贴板 = pbpaste/pb | scan-edge §2.1（S/C 级多源） |
| F2 | FTS 路径 <10ms / $0 / 零后台进程；本地 embedding 入库 50k 条在 Intel CPU 上数十分钟起（本机 2015 MBP / macOS 12） | scan-edge §2.2 L-COST 表 |
| F3 | Lasso 现状：grep 全 src 零命中 chrome history / apple notes / mdfind | 裁决官 grep 亲验（沿 zero-base ZB-5） |
| F4 | 隐私红线：浏览历史全文不出本地（云 embedding 否决） | zero-base §3-I5 |
| F5 | 用户画像 I5 占比 5-10% 且增长中，但「查自己历史」的频率可能高于查冷门网络信息 | zero-base §1.2（E 级推理估计） |

## 2. 方案对比

### 方案 B1：并入 Lasso 作第四通道 `search_local`

- **形态**：与 search/browse/desktop 平级的新工具组（如 `search_local`），SQLite FTS 只读查询 Chrome History / Apple Notes / mdfind 三源，纯本地。
- **代价**：大（相对本轮其它项）——约 500-800 行 + 各源 schema 适配 + 测试。Chrome History 路径（`~/Library/Application Support/Google/Chrome/*/History`）与 Notes 的 NoteStore.sqlite（zipped protobuf body，解析有坑——v1 只查标题/日期可绕）复杂度不同，可分源落地。
- **收益**：①单一 MCP 收纳哲学的镜像（「所有对外交互归一个 MCP」+「搜自己的机器也归它」）；②共享 attribution/tri-state/envelope 既有机器；③ npm 用户直接受益。
- **风险**：①Lasso 自我定义是「**对外**抓手」，加「对内」通道稀释品牌与边界（scan-edge §2.4 已点出此张力）；②浏览历史是高敏数据，工具暴露面扩大意味着 CC 可被 prompt 注入诱导读取历史（须 read-only + 无全文导出，只返 title/url/时间戳 + 片段）；③体量上这是新一条通道的全部工程成本。

### 方案 B2：独立新 MCP（memory-sibling）

- **形态**：另起 `@wangdong233/local-recall-mcp`（名字待定），Lasso 零改动。
- **代价**：新项目基建（重复 envelope/SSRF 不需要但 logger/测试/CI/npm 要重建）。
- **收益**：①边界纯净——Lasso 保持对外定位；②独立演进节奏（embedding 升级、更多源）不挤占 Lasso 带宽；③失败隔离。
- **风险**：①两个 MCP 的安装/配置负担（对 npm 生态用户）；②跨 MCP 组合查询（「我看过讲 X 的页面 + 搜一下 X 最新动态」）要 CC 自己拼，但这本来就是 CC 的强项。

### 方案 B3：暂不建（观察）

- **理由**：F5 是 E 级估计，真实频率未经验证。可先人工观察两周：数一数「想查自己历史但没查到」的真实次数。若 <每周 2 次，价值不足以开新面。
- **代价**：零。**收益**：避免为想象中的需求建 800 行。

## 3. 技术要点（两方案通用，先立边界）

1. **FTS 先行，embedding 不做**（F2：Intel CPU 入库痛苦；等换机再议）。
2. **只读 + 不出本地**：工具无任何写路径；查询结果不进任何网络通道。
3. **最小数据暴露**：默认只返回 {title, url, visited_at, snippet≤200 字符}；无「dump 全历史」类动作。
4. **Chrome History 是 WAL 库**：Chrome 运行时会锁——用 SQLite immutable/readonly 模式或复制后查（scan-edge 组件事实已覆盖）。
5. **Apple Notes v1 只查元数据**（标题/日期/文件夹），全文解析（NoteStore zip+protobuf）留 v2。

## 4. 分阶段路径（若 GO）

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P0 | 两周人工计数（B3 的观察，零成本） | 笔记即可 |
| P1 | 三源只读 FTS 最小版（mdfind 最简单先做，Chrome History 次之，Notes 元数据最后） | 单元测 + 真机延迟 <50ms 断言 |
| P2 | 与 search 的组合语义文档化（「先查本地，0 命中再出网」是 CC 编排，不硬编码） | README 段落 |

## 5. 交用户的问题

1. 要不要建（B3 的两周观察 vs 直接建）？
2. 若建：B1 并入（一个 MCP 全包）还是 B2 独立（边界纯净）？——这是「收纳哲学 vs 边界纪律」的价值排序，只有你能排。
