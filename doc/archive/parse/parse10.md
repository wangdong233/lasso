parse10 已产出，落盘在 `/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse10.md`。

## 核心产出摘要（供 parent agent）

**文档结构**（与 parse1-9 一致，7 节）：
1. v0.9 目标与范围（v0.8 增量 + 范围矩阵 + **「search ≈永不失败」边界表**——7 种场景 tri-state 诚实分类）
2. 文件结构（4 新增 + 7 修改 = ~1025 行 TS + 150 行 INV 脚本；零改 Rust）
3. 各模块实施细节（BingChannel ~210 / FallbackChain ~180 / wayback.ts ~140 / RecordingStore 集成 ~80；接口签名 + 伪码 + 借鉴源 + 行数估算）
4. 不明确点调研结论（Bing F0 免费层现状 / Wayback 速率 / 录制回放触发条件 / fallback_chain 不替换 fanout 默认 / 未决推 v1.0）
5. 测试计划（4 新单测 + 4 集成扩 + INV-54..59 不变量测试 + mock 策略）
6. 验收标准（V1-V10 CI + M1-M3 手测，引用 09 §2.10）
7. 风险 + 实施顺序（R13-R17 + 4 phase A/B/C/D/E，每 phase 独立可 tag 回退，~13 工日）

**关键设计决策**（守简单性 02 §5 R-CI-02 + §5.5 R-ABS）：
- **第三源 Bing 不抽 `OpenSearchChannel` 通用类**（R-ABS-01 警惕：三源真实共性只有「都是 HTTP」一层）—— 保 BraveChannel / BingChannel 两独立 class，代码相似度容忍
- **不开第二套串行 fallback 引擎**（INV-4 衍生 INV-55）—— fallback_chain 是 plan 构造器，仍走 `FallbackDecider.runWithFallback`
- **不自动探测 search result url 死链**（守横切关注点边界 INV-58）—— wayback_lookup 是独立 tool，CC 显式调
- **不替换 fanout 默认**（零回归）—— `engine="fallback_chain"` 是显式 opt-in；`engine="auto"` 默认行为 byte-identical v0.8
- **录制回放默认 OFF**（INV-57）—— CI 测试集不被污染

**新 INV 编号 54-59**（v0.8 的 53 不破坏）：
- INV-54: BingChannel 必经 QuotaLedger（INV-10 衍生）
- INV-55: 三层 fallback 复用 FallbackDecider（INV-4 衍生）
- INV-56: wayback_lookup 经 doFetchUrl + ssrfGuard（INV-31 同源）
- INV-57: 录制回放必显式 opt-in
- INV-58: 禁自动探测死链（wayback 是独立 tool）
- INV-59: RecordingStore.save 异步不阻塞 search 主路径

**重要未明点**（v0.9 立项前需实测）：web search 限流未跑通，Bing Azure F0 免费层对**新订阅**的可用性基于既有知识（2023-08 调整后多 region 受限）—— v0.9 接入结构不强依赖 F0 必可用，fallback_order=4 仍配但 key=[] 时 ProviderRegistry 跳过，行为完全等价 v0.8。