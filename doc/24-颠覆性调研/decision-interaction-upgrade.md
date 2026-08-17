# 决策文档 C：交互面升级——elicitation 回合内确认 + 抽取产物交互句柄（D-DECISION，交用户裁决）

> 2026-08-18 · doc/24 颠覆性调研 verdict 产物。依据：scan-mcp-proto ①②⑦（协议/CC 实证）+ scan-edge §1（GUI agent 借鉴）+ zero-base ZB-6/ZB-7 + 裁决官对 HighRiskGate 现状的核实。

---

## 0. 一句话问题

两条「交互体验断层」：①高风险操作现在是「中断重来」（HighRiskGate 命中 → didnt + 停整轮，用户须重发请求），协议层已有更好的答案（elicitation，CC v2.1.76+ 支持回合内弹窗确认）；②browse 抽取产物是「只读 markdown」，CC 拿到后无法就地续交互（要重跑底层 snapshot）。两项都是中等体量 + 安全相关，本轮调研不实施，交裁决。

## 1. 事实基座

| # | 事实 | 来源/验证 |
|---|---|---|
| F1 | HighRiskGate 现行语义：命中高风险 pattern（drag-drop/toasts/RTE/tree-view/data-grid）→ outcome=didnt + StepEngine stop——「不做也不继续」，用户重发整轮 | HighRiskGate.ts 头注释（裁决官亲读）+ grep 全 src 零命中 elicitation（亲验） |
| F2 | CC v2.1.76（2026-03-14）起支持 MCP elicitation：server 可中途回结构化表单/URL 确认；v2.1.117 修复 print 模式兼容；Elicitation/ElicitationResult hooks 可编程自动应答 | scan-mcp-proto ②（官方 CHANGELOG 5163 行全量解析 + 官方文档，S 级） |
| F3 | TS SDK v1（本仓 ^1.30.0）已支持 server 侧发送 elicitation（`server.request` + capability guard） | scan-mcp-proto ②（S 级） |
| F4 | 现行 click/fill 的 uid 是底层 chrome-devtools-mcp 自己的 ref 透传（BrowseChannel.ts:903-906）；HighRiskGate.ts:204 自注「data-lasso-uid（Lasso 未来在 snapshot 注入）」——自产 uid 是**规划未实施** | 裁决官亲读（沿 zero-base ZB-7） |
| F5 | 生态第一的 Playwright MCP 用 snapshot/ref 范式（a11y 树结构化文本 + `ref=eN`），截图+坐标是 opt-in 兜底——与 Lasso browse/desktop 架构同向（外部效度证明，非新范式） | scan-mcp-proto ⑦（S 级） |
| F6 | sampling（server 借 client LLM）协议 2026-07-28 弃用（SEP-2577）+ CC 从未支持——VLM 档零配置借模型的设想双负否决 | scan-mcp-proto ①（S 级） |

## 2. 方案

### C1. HighRiskGate elicitation 化（ZB-6）

- **内容**：命中高风险 pattern 时，向 CC 用户弹结构化确认（「命中 RTE pattern，片段 ≤200 字符。确认继续 / 跳过本步 / 终止」），确认后**同一轮**继续。必须保留降级：clientCapabilities.elicitation 未声明 → 维持现行 didnt 行为。次级候选场景：desktop 权限缺失、云浏览器 key 缺失、doctor 发现配置问题的一次性修复确认。
- **代价**：约 100-200 行 + 测试（mock elicitation callback 单元测 + 真机 CC 手测）；触 HighRiskGate 安全机制核心路径。
- **收益**：高风险场景从「中断重来」变「回合内确认」，净体验为正（本来就要人到终端）；安全模型不变（pattern 表仍写死代码 INV-14，不从 config 读）。
- **风险**：①安全关键代码——若降级分支有 bug，最坏情形是旧客户端上高风险操作被静默执行或永远卡死，须「capability 未声明 → 100% 走现行 didnt」用测试钉死；②SDK v1 的 elicitation API 形态需真机验证（scan-mcp-proto 只验了协议存在性）；③本轮不实施的原因即此——调研轮里碰安全机制核心路径不谨慎，值得单独一轮含真机验证。

### C2. 抽取产物带交互句柄（ZB-7）

- **内容**：markdown 抽取输出附元素引用（`[ref:12] <button>提交</button>` 形态），click/fill 接受 Lasso 自产 ref。现状是透传底层 chrome-devtools-mcp 的 ref——CC 拿到 Lasso 的 markdown 后要交互，得自己再跑一次底层 snapshot。
- **代价**：中——输出形状变更（markdown 里嵌 ref 标记，可能影响既有抽取测试的黄金断言）；需要 ref 生命周期管理（页面变了 ref 失效的诚实处理）。
- **收益**：「读→点」不断链：一次 browse 后 CC 可就地续交互，省一次整页 snapshot；对齐 F5 的生态主流范式。
- **风险**：①markdown 混入 ref 标记会增大 token 输出（须 opt-in 参数，如 `include_refs:true`，默认关）；②ref 失效语义要诚实（失效返 didnt + 提示重 snapshot，不猜）。

### C3. CC Channels 推送原型（scan-mcp-proto ④ 捕获项）

- **内容**：`capabilities.experimental['claude/channel']` + `notifications/claude/channel`——desktop 值守（文件/剪贴板/窗口变化）→ 事件推进会话上下文。**research preview + allowlist 门控**：自定义通道需 Anthropic allowlist 或 `--dangerously-load-development-channels` 危险 flag。
- **裁决建议**：**不进主干**。npm 分发的用户默认跑不起来；等 GA。若你想本地实验，<100 行单文件原型可做（文档已有 Bun 示例），与主干隔离。

## 3. 分阶段路径（若 GO）

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P1 | C1：capability 探测 + 降级分支先行（纯增量，现行行为 byte-identical 当未声明时） | mock 单元测 + 「未声明必 didnt」断言 + 真机 CC ≥2.1.76 手测记录 |
| P2 | C1 全量：三个高风险 pattern 场景真机过一遍 | 手测清单存档 |
| P3 | C2：`include_refs` opt-in 参数 + ref 失效诚实语义 | 抽取黄金断言不回归（默认关时 byte-identical） |
| P4 | C3 仅在 GA 后重评 | — |

## 4. 交用户的问题

1. C1（elicitation）优先级是否高于决策 A 的 A1 质量轴？（两者都小；A1 零风险，C1 安全关键但体验收益更直观）
2. C2 的 token 增量换交互连续性，值不值？（你的 browse 使用频率里「读后要点」的占比是判断依据）
