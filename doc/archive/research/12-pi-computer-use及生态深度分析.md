# pi-computer-use 及 semantic-computer-use 生态深度分析（12）

> 数据基线：3 份 pi-computer-use 深读（injaneity 仓，逐行读了 docs/architecture.md + docs/development.md + src/runtime.ts/state.ts/outline.ts/actions.ts/view.ts/contract.ts/cdp.ts/bridge.ts 切片 + scripts/check-invariants.mjs）+ 5 角度开源深搜（共 30+ 项目）。诚实区分「短期可借鉴 v0.1-v0.3」vs「远期 v0.5+」vs「永远不适合」。
>
> 本文档为 08/09 的优化建议输入，verdict 见 §7。所有「借鉴点」必须给出源文件/函数级证据。

---

## 1. pi-computer-use 深读总结（架构/工具/源码的可实现技术细节）

### 1.1 三个高价值可移植机制（按对 Lasso 的杠杆排序）

**(A) state-scoped immutable observation + bounded LRU StateStore + AsyncLocalStorage 请求级 hydrate**
- 源证据：`src/runtime.ts` `StateStore<T>` = `Map<stateId, StoredState<T>>`，limit=128，`set` 时 `delete+set` 把记录挪到 MRU 端，超容量时 `keys().next().value` 取最老删之（LRU）；`StoredState={stateId:randomUUID(), resourceKey, epoch, value:T}`。
- 源证据：`src/state.ts` `SavedStates` 叠 `AsyncLocalStorage<OperationState>`：每次工具调用进 `.run()` 上下文，`hydrate(record)` 把磁盘/内存 `StoredState` 还原成请求本地的 `OperationState`（currentTarget/currentLook/currentOutline/epoch/resourceKey）。
- 含义：彻底放弃「session 级 current UI」可变全局；每次观察产生不可变快照 + UUID 短指针；后续所有操作携带 `stateId`；并发工具调用通过 ALS 隔离。

**(B) act_ui 的 expect 后置条件 + 三态 outcome（worked/didnt/unknown）+ 三态 check（verified/preexisting/failed）**
- 源证据：`src/contract.ts` `UiCondition={ref?, scopeRef?, text?, role?, value?, until:'present'|'absent', timeoutMs?}`；`validateCondition` 强制 text/role/value 至少一项。
- 源证据：`src/actions.ts` `outcomeAfterCheck`：verified→worked、failed→didnt、preexisting 保留原值（承认「我没造成它但它现在对」）；`outcomeAfterObservedValues` 对 setText 列表做「value 对得上」二次自检。
- 源证据：`src/bridge.ts` `performBrowserTransaction` 的 100ms poll 循环：`deadline=Date.now()+timeoutMs; do{ snap=cdpSnapshotForContext(); present=outlineConditionPresent(restoreOutline(snap.outline), cond); satisfied = present !== cond.gone; if(!satisfied) await sleep(100); }while(!satisfied && Date.now()<deadline)`。
- 含义：act 后不止报「事件已派发」，而是阻塞等待平台变更通知，区分「事件投递成功」与「语义目标达成」。架构铁律：**「event delivery alone is never treated as semantic success」**。

**(C) 架构不变量编码为可执行脚本（invariants-as-tests）**
- 源证据：`scripts/check-invariants.mjs` + `scripts/check-runtime-concurrency.mjs` + `scripts/check-tool-schemas.mjs`，`npm test` 跑 TS 编译 + 工具 schema 兼容 + 架构不变量 + 平台 helper 检查。
- 源证据：`docs/architecture.md` 硬规则：act_ui 是唯一公共桌面动作入口；不得重新引入 screenshot/click/set_text 公共工具；observe 必须返回 folded outline+note；UI 观察是 immutable record；cached 查询绕过调度器；helper 拥有 grounding/preflight/execution/verification。**failure-closed**：任一 helper 漏必需不变量则启动直接失败。
- 含义：把「不可违反的架构规则」写成 CI 子脚本，比纯文档审查强；防重构回退（和 media-gen-mcp 0.11.0 抓 3 个 mock 掩盖的🔴属同一思路：运行时证据>断言）。

### 1.2 三个有条件借鉴的机制（按 v0.x 门槛排序）

**(D) ResourceScheduler: resource-keyed 串行 + 单调 epoch + write 前 stale-reject + epoch 预自增 fail-safe**
- 源证据：`src/runtime.ts` `ResourceScheduler.resources=Map<resourceKey,{epoch,tail:Promise}>`；`write(key,baseEpoch,work)` 先比较 epoch===baseEpoch 否则 throw `StaleResourceStateError`，**相符则先把 `record.epoch=baseEpoch+1` 再调 work(nextEpoch)**（注释明说：partial effect 后续 write 仍 fail-safe）；`read/readAt` 区分纯缓存读 vs epoch 校验读。
- 源证据：缓存查询（search/expand/inspect）完全 BYPASS scheduler——只有 live work 排队。
- 门槛：今天 Lasso 主并发是「跨 provider fallback」（已有 60s 熔断），不是「跨 agent 同资源竞争」。**v0.3 F3.2.11 不真引入并发前属提前优化**。

**(E) compact diff: stabilizeRefs + changesBetween + 三 fallback gate**
- 源证据：`src/view.ts` `stabilizeRefs` 用 wireRef（原生稳定 id）强匹配 + structuralKey（path token + 同辈 peer-index）弱匹配；冲突退到新 `@e{nextIndex++}`。
- 源证据：`changesBetween` 三退回 full view：`root_replaced`（root role/subrole 变）/ `identity_confidence_low`（next.nodes.length>8 且 identityConfidence<0.4）/ `change_budget_exceeded`（changes>100 或 changes>20 且 changeRatio>0.65）。
- 门槛：**SERP 通道基本用不上**——每次重新生成不是 patch，diff 会一直退回 full view；browse click 大多触发 frame navigation=root_replaced。**受益面窄（SPA 分页/折叠展开），不要为 SERP 引入**。

**(F) multi-root forest: identity→ref 复用 map（仅这一小块）**
- 源证据：`src/state.ts` `RuntimeState` 持有 `windowRefs(@r→desktop record)` + `windowRefByIdentity(identityStr→@r)` + `browserRootByContext(contextId→@r)`；`storeWindowRef/storeBrowserRootRef` 都先查 identity→@r 表命中则复用、未命中才 `@r{nextRootRefIndex++}`。
- 门槛：「桌面 AX + CDP 同一 @r 空间」统一**不适合 Lasso**——你的领域只有 browser channel（search/browse_headless/browse_logged_in），不存在并发可观测的桌面森林。只取「identity 复用 map」这一小块，ref 用 `@pN`（page）而非 `@r`。

### 1.3 三个工具实现细节（output 折叠 / progressive disclosure / 平台契约）

**(G) bounded output 48KiB/2000 行 + @oN 续页 + tool-specific refine hint**
- 源证据：`src/output.ts` 常量 `MODEL_TEXT_MAX_BYTES=48*1024`、`MODEL_TEXT_MAX_LINES=2000`、`MODEL_PREVIEW_BYTES=16*1024`、`OUTPUT_PAGE_BYTES=16*1024`，单条 16 MiB / store 总 64 MiB 上限；`storeOutput` 在 `os.tmpdir()` 建 `mkdtempSync` 目录 mode `0o600`，文件名 `@oN.txt`；`applyOutputEnvelope` 超限存盘返回 preview + 三行 trailer（`output truncated` / `refine: <tool-specific hint>` / `continue: read_text({ref:"@oN", offset:X})`）。
- 含义：长结果外置 + 偏移量按需拉；64MiB LRU 保护 server 内存；mode 0o600 适合 browse_logged_in 私密 cookie 内容。

**(H) progressive outline 查询缓存：纯缓存 search/inspect + epoch-checked escalation**
- 源证据：`src/bridge.ts` `performExpandUi`（`graftScopedOutline` + `clearScopedRects`）/`performSearchUi`（`shouldEscalateSearchOCR`）；`search_ui` 先对缓存 outline 跑 `searchOutlineRanked`（遍历 `outline.nodes` 数组），只有当 `shouldEscalateSearchOCR(matches,text)` 且本 look 未 escalation 过，才走 `resourceScheduler.readAt(resourceKey, state.epoch, ...)`；`state.lastSearchOcrEscalatedLookId` 做每 look 只升级一次去重。
- 门槛：**graftScopedOutline 子树合并 + clearScopedRects【不适合】**——AX 树有 truncated 子树语义，DOM 页面没有；只取「缓存优先 + epoch 校验升级」这层。

**(I) 平台中立缝 + architectureVersion + 启动 fail-closed 不变量**
- 源证据：`src/platform/architecture.ts` 定义 `BackendContract` 接口（observation/text/batching/lifecycle 四组操作），每个 backend 报 `architectureVersion` 字符串 + 它实现的 invariant 名集合；启动时 `check-invariants.mjs` 比对必需集，缺即 fail-closed 退出。
- 含义：跨平台不靠源码结构镜像而靠不变量契约；三证据层：共享契约测试 + 原生单测 + 黑盒交互验收。

### 1.4 文档卫生警告（重要）

5 角度调研揭示一个关键的命名冲突：**GitHub 上有两个「pi-computer-use」**：
- `injaneity/pi-computer-use`（MIT，macOS AX + Windows UIA + CDP，本调研主对象）——「observe_ui/act_ui/expect/multi-root forest/state-scoped observation」**真实存在**
- `swairshah/pi-computer-use`（Pi 扩展，screenshot→vision grounding→Swift helper 三段式）——只有 18 个 `gui_*` 工具 + `gui_batch`，**没有任何高级语义抽象**

之前调研角度 5 的「pi-computer-use 描述失实」是看了 swairshah 版本。**08/09 文档若引用 pi-computer-use 必须明确标 injaneity 仓**，否则后续维护者去 GitHub 搜可能看到完全不同的项目。

---

## 2. 之前调研的盲区（5 角度揭示的漏掉的开源生态）

按对 Lasso v0.7/v0.8 价值排序：

### 2.1 高价值漏项（强烈建议补进调研链）

| # | 项目 | 漏掉的关键技术 | 价值 |
|---|---|---|---|
| 1 | **pi-web-access**（nicopreme，130K/mo） | **SSRF allowRanges 对 fake-IP 代理**（198.18.0.0/15 默认拒保留 IP，可配 CIDR allowlist 解锁 Surge/Clash/Mihomo TUN+fake-IP 场景）；**get_search_content(responseId, urlIndex/url/query) 渐进披露**（先返回摘要>30000 字截断，全量内容存盘按 responseId 按需取）；Readability→RSC parser→Jina Reader→Gemini URL Context→Gemini Web 五层兜底；Exa 双模（keyed 直连 / 无 key MCP） | **直接命中用户环境**（MEMORY 明确「push 走 HTTPS 因代理 fake-ip 拦 SSH」）；渐进披露范式比 v0.3 「短指针写盘」更结构化 |
| 2 | **pi-agent-browser-native**（fitchmultz，12.6K/mo） | **spill files for oversized raw output**（结构化落盘按内容分类）；**「Omitted high-value controls」段 + details.data.highValueControlRefIds**（dense 页裁剪时显式列出被裁掉的高价值控件 refId）；`snapshot --search <text>` / `--filter role=<role>` 服务端过滤 + `details.refSnapshot` 保留全量；docs/SOURCE_OF_TRUTH.md + SUPPORT_MATRIX.md 文档纪律 | 强化 v0.3 短指针设计：spill 是结构化的（按内容分类）；裁剪后显式列出被裁控件让 agent 知道还有什么可点 |
| 3 | **visioncortex/ui-automata** | **shadow DOM 缓存**（per-tab 缓存 CDP a11y/DOM 树，跨 step 复用，navigation 时失效）—— 单点最大 token 节省漏招；CSS-like selector 统一语言 `[role=button][name=Open]`；per-step expect + recovery handler 声明式 YAML；write-once + replay 确定性工作流缓存 | **F3.2.11 每步重新查询是浪费**；声明式 recovery handler 比 F3.2.11 隐式约定严谨 |
| 4 | **Stagehand**（browserbase，~16k stars） | `verify(prompt)` 直接返回 bool 的 API 形状；`extract(prompt, zod_schema)` 返回 `VerificationResult{data, verified}`；`diffCombinedTrees()` 在 self-heal 路径里对 pre/post DOM 树做 diff（比 pi compact diff 更轻量）；ActCache 的 self-heal「corrupted cache must not crash, fall through to fresh LLM」 | Lasso 抄 diff 范式时这是更小代码量的参考；`verify(prompt)` API 形状比 `act+expect` 两字段更符合 CC 工具调用习惯 |
| 5 | **Skyvern**（~13k stars） | **actions_and_results: list[tuple[Action, list[ActionResult]]]**——每个意图 Action 配一条 ActionResult 链；`ActionFailure.should_terminate_remaining_chain` 标志（默认 True）；`page.validate(prompt)` 返回 bool；`WaitAction` 过滤逻辑（有其他 action 时 WAIT 被视为失败信号过滤掉）；adaptive caching 的 fallback episode | F3.2.11 多步链式直接抄这个形状：steps 返回不是黑盒 list[str] 而是 `[(step, [result...]), ...]`；CC 拿完整因果链 |
| 6 | **GitHub Accessibility Agent**（内部 pilot） | **complexity scoring 门槛**（小 shell 脚本算代码复杂度分数，过门槛 agent 不执行只给建议）；**high-risk pattern 黑名单**（drag-drop/toasts/rich-text-editor/tree-view/data-grid 标「不自动操作」）；**anti-gaming instructions**（防 LLM 绕过自己指令）；**linear ordered phases > parallel sub-agents**（反直觉发现：线性优于并行 for accuracy） | browse_logged_in 遇这些交互模式放弃自动操作并升级用户；多步链默认线性，不为速度引入并行子 agent |
| 7 | **agent-sh/computer-use-linux** | **`doctor` readiness 模式**——返回结构化 JSON+blockers+next step；**MCP ToolAnnotations**（readOnlyHint/destructiveHint/idempotentHint/openWorldHint 四象限）；screenshot payload size bounding（max 1920px/2MiB，format/quality/scale 可调） | **doctor 完全缺失是最高杠杆漏项**，应进 v0.1 MVP；ToolAnnotations 是 chrome-devtools-mcp 不会替你做的责任 |
| 8 | **MCPWorld**（arxiv 2506.07672） | **API/GUI/Hybrid 三分框架**（把 search→browse fallback 重定位为「hybrid CUA」）；**white-box verification**（用结构化信号验证任务完成而非 selector 是否返回非空）；75.12% 任务完成率（hybrid > 纯 GUI/纯 API）量化基线 | 给 v0.2 provider 矩阵学术背书的术语；SERP selector「债」可用同款：验证时检查结构化字段（result count/duration/pagination）而非「有 div.serp-result 就算成功」 |
| 9 | **AskUI Vision Agent** | token-cost 基准数据：screenshot 每次 perception **1200-5000 tokens**，agent 成功率 **66.2%** vs human 72.4% | 为 Lasso 选择「a11y/DOM 主 vs screenshot 主」提供量化论据，证明视觉优先策略的 token 成本 |
| 10 | **LUMOS**（arxiv 2606.30697） | **「agent interface plane 平行于 human interface plane」框架**；blueprint 紧凑序列化格式（element_id/role/name/value/bounds/action_affordance）；allowlist + confirmation policy | 为 Lasso 增加 a11y-tree 提取通道提供论据；风险操作 allowlist 直接映射 browse_logged_in 安全边界 |

### 2.2 误判排除（之前调研把以下列为「核心抽象」实为桌面 AXAPI 专属，web-only 用不上）

- **multi-root forest 的 desktop roots 部分**（pi-computer-use 桌面 AX/UIA）——Lasso 走 CDP，不适用
- **focus 保留 / HID 交付 / foreground-background retry**——CDP 页面没有「前台/后台焦点」问题
- **native helper / macOS ScreenCaptureKit/AppKit / Windows UIA / SetWinEventHook / UIA InvokePattern ladder**——整块与 web-only 无关
- **cursor overlay / agent cursor animation**——MCP server 不渲染 UI
- **graftScopedOutline + clearScopedRects**——AX truncated 子树语义，DOM 没有对应
- **WindowNote seen/changed/never-looked**——交互式 UI 遍历贴切，SERP 是扁平行集
- **8 immutable look records ring buffer**——其内存约束非通用

### 2.3 反向印证（已确立的判断得到加强）

- **SERP selector 是债不是资产**——5 角度调研强烈印证（Brave/Tavily/Exa 都是结构化 JSON API，浏览器型明确降级为兜底）
- **不解 2FA 边界**——pi-web-access `chromeProfile + allowBrowserCookies opt-in` + GitHub Accessibility Agent `anti-gaming` 都印证这是正确边界
- **chrome-devtools-mcp 零侵入跟随**——pi-agent-browser-native 显式「keeps upstream agent-browser as the browser engine and adds the Pi-native wrapper behavior, without bundling or re-implementing it」互相印证
- **三通道划分是行业共识**——vercel-labs/agent-browser（headless Chromium / 真 Chrome 带 profile / 云托管远程浏览器三模式）直接映射 browse_headless / browse_logged_in / v0.4 云浏览器

---

## 3. 对 08 架构的优化建议

### 3.1 重点评估 ①：act verify delivery + compact diff 是否进 v0.3 多步链式

#### verify delivery —— 【强烈建议进 v0.3，最高价值借鉴】

**借鉴点**：pi-computer-use `bridge.ts performBrowserTransaction` + `actions.ts outcomeAfterCheck/outcomeAfterObservedValues` + `contract.ts UiCondition/ActParams.expect`。
**具体技术**：
1. 把 08 §3.2 `BrowseOptions` 加 `expect: ExpectCondition | None` 字段：
   ```python
   @dataclass
   class ExpectCondition:
       text: str | None = None        # 期望文本出现/消失
       selector: str | None = None    # 期望 selector 存在/消失
       url_contains: str | None = None  # 期望 URL 含某片段（验证 navigate 真跳转）
       gone: bool = False             # True=期望条件消失（如登录弹窗关闭）
       timeout_ms: int = 5000         # 后端 waitForSelector/waitForFunction 超时
   ```
2. 100ms poll 循环（chrome-devtools-mcp `evaluate_script` 内跑 `document.querySelector + textContent.includes`）直接抄 `performBrowserTransaction`；CDP 原生 `Page.frameNavigated` + `Runtime.evaluate` 轮询。
3. 三态结果：
   - `verified` = beforePresent=false, afterFound=true（动作真造成条件）
   - `preexisting` = beforePresent=true（条件本就成立，动作可能幂等或没必要）—— **诚实报告，契合已确立的诚实原则**
   - `failed` = afterFound=false → outcome 强制改 `didnt`（不是「事件投递了」就装成功）
4. 涉及 F 编号：**新增 F3.2.18 expect 后置条件 + 三态**（v0.3）+ **F3.4.11 handler 层 tri-state outcome**（worked/didnt/unknown，unknown 才是 fallback 引擎的真正触发器）。

**优先级**：**v0.3 P0**（与 F3.2.11 steps 同期落地，因为多步链式没 verify 就是黑盒）。
**理由**：当前 F3.2.11 设计 `steps=[navigate,click,extract]` 返回「短指针」是盲返；SPA 导航会和 extract 竞态，没 expect 就会读到过渡态 DOM。pi-computer-use 的「event delivery alone is never treated as semantic success」铁律直接命中。

#### compact diff —— 【不适合 v0.3，留到 v0.6+ 或砍掉】

**借鉴点**：pi-computer-use `view.ts stabilizeRefs/changesBetween`。
**诚实判断**：
- SERP 通道每次重新生成不是 patch，diff 会一直退回 full view（`root_replaced` 或 `change_budget_exceeded`）；
- browse click 大多触发 frame navigation=`root_replaced`，diff 也常退回全景；
- 真正受益场景窄（同页 SPA 分页/折叠展开）。

**优先级**：**v0.6+ 或 NO-GO**。不要为 SERP 通道引入；只在 v0.6+ 如果真有 SPA 分页需求再评估。如引入，借鉴 Stagehand `diffCombinedTrees` 而非 pi-computer-use 的全套（代码量小一个数量级）。

### 3.2 重点评估 ②：immutable cached snapshot

**借鉴点**：pi-computer-use `runtime.ts StateStore<T>` LRU(128) + `state.ts SavedStates.AsyncLocalStorage<OperationState>` + `hydrate`。
**具体技术**：
1. 修改 F3.2.10「页面状态写磁盘」：保留磁盘（用于跨进程重启恢复），但**主路径改为内存 StateStore<PageSnapshot>**：
   ```python
   @dataclass
   class PageSnapshot:
       state_id: str                # UUID, 对 agent 暴露的不透明指针
       resource_key: str            # "browse_logged_in:9222:tabA" 或 "browse_headless:session1"
       epoch: int                   # 每次 navigate 自增
       url: str
       dom_summary: str             # 折叠摘要（前 N 节点）
       full_snapshot_path: Path | None  # 大对象落盘
       cookie_fingerprint: str | None    # logged_in 通道用
       captured_at: datetime
   ```
2. ALS 模式直接照搬：每个 MCP 请求 `hydrate(record)` 出请求局部 OperationState，跨调用不共享可变状态。
3. epoch 字段保留但不启用 ResourceScheduler（单 tab 串行已够）；v0.5+ 视并发压力再启用 write 前 stale-reject。
4. **LRU=128 抗内存膨胀**；长链 F3.2.11 步骤间 stateId 复用；过期 stateId `cleanly fail`（明确报 stale 而非覆写）。
5. 涉及 F 编号：**修改 F3.2.10** + **新增 F3.2.19 StateStore + stateId + epoch**（v0.3）。

**优先级**：**v0.3 P0**。
**理由**：v0.3 F3.2.11 当前「短指针写磁盘」是可变状态；并发 browse_logged_in + browse_headless 各走各的 ALS 才不互相覆盖；epoch 字段为 v0.5+ ResourceScheduler 铺路（不必现在启用）。

### 3.3 重点评估 ③：语义 action 层级（observe_ui/act_ui/search_ui/inspect_ui）

**借鉴点**：pi-computer-use 把 screenshot/click/set_text 全废弃，统一到 observe_ui/search_ui/inspect_ui/act_ui 语义层。

**诚实判断**：**【不适合 Lasso】**——pi-computer-use 的统一语义层建立在 AX outline 之上（每个 DOM 节点都有 role/subrole/actions）；Lasso 的核心数据单元是 **SERP 条目 / 抽取文本（行集）**，没有 AX 树语义。硬套 @eN/@rN 双层 ref 体系对纯文本抽取场景过度。

**但可吸收的子集**：
- **CSS-like selector 统一语言**（visioncortex/ui-automata）：`[role=button][name=Open]` 一套选择器同时工作于 chrome-devtools-mcp 的 a11y tree 和 DOM querySelector——降低 LLM 学习成本。Lasso 可在 `BrowseOptions.selectors` schema 里允许这种统一形式。
- **action enum 折叠**（已用 mcp-chrome `chrome_computer`，附录 E.1 已采纳）：navigate/snapshot/screenshot/extract/click/fill 等 enum。
- **工具描述内嵌路由**（已用 mcp-chrome `[Prefer X over Y]`）：3 工具 description 已分流。

**优先级**：**不做大改**，保持当前 3 工具（search/browse_headless/browse_logged_in）+ action enum。

### 3.4 重点评估 ④：multi-root forest 对未来桌面的意义

**借鉴点**：pi-computer-use `bridge.ts performListWindows/storeBrowserRootRef` + `cdp.ts listCdpPageContexts/cdpSnapshotForContext`。

**诚实判断**：
- **当前完全不适合 Lasso**：web-only 领域，三通道是异质离散通道（search API + headless Chrome + logged-in Chrome），不是同质多窗口；硬套 forest 会把 3 个离散 channel 伪装成 forest，徒增抽象层。
- **只取「identity→ref 复用 map」那一小块**：同 url+session 重开拿到同一 `@pN` 页面指针，避免重复开 tab（已部分在 F3.3.3 tab 复用）。

**战略意义**（远期）：
- 若 cc-control-all 项目（macOS AXAPI 已识别为重点自建方向）启动，pi-computer-use 的 multi-root forest 是「桌面+浏览器统一抽象」的最佳参考实现；
- 那是另一个项目，不应污染 Lasso 的当前范围。

**优先级**：**永远不进 Lasso**；战略上保留为 cc-control-all 的借鉴候选。

### 3.5 其他具体架构建议（按优先级）

| # | 建议 | 借鉴源（证据） | 涉及 F | 优先级 |
|---|---|---|---|---|
| 3.5.1 | **tri-state outcome** 进 handler 层：`unknown` 是 fallback 真正触发器（当前二元 bool 把信号丢了） | pi-computer-use `actions.ts outcomeAfterCheck`；调研角度 3「unknown 才是 fallback 引擎的真正触发器」 | 新增 F3.4.11 | v0.1 P0 |
| 3.5.2 | **doctor readiness 工具**从 v0.7 提前到 v0.1：返回结构化 JSON+blockers+next step，覆盖 search API key/headless Chrome/:9222/SERP selector 四个失败面 | agent-sh/computer-use-linux `doctor` 单发 JSON readiness 报告 | 修改 F3.6.7 | v0.1 P0 |
| 3.5.3 | **架构不变量测试**章节加到 §5.4：CI 强制跑「browse 是唯一 browse 入口 / BaseChannel 不被绕过 / ProviderConfig 注册表单一真源 / 不复用第二套 fallback 范式」断言 | pi-computer-use `scripts/check-invariants.mjs + check-runtime-concurrency.mjs + check-tool-schemas.mjs` + docs/development.md「Run invariants after architecture changes」 | 新增 F3.9.8 | v0.1 P0 |
| 3.5.4 | **MCP ToolAnnotations**：browse_logged_in 标 `readOnlyHint=false/openWorldHint=true`（带 session cookie 出网）；search 标 `readOnlyHint=true` | agent-sh/computer-use-linux ToolAnnotations 四象限（readOnlyHint/destructiveHint/idempotentHint/openWorldHint） | 新增 F3.9.9 | v0.1 P1 |
| 3.5.5 | **SSRF allowRanges 字段**对 fake-IP 代理（198.18.0.0/15）：默认拒私有/保留 IP，可配 CIDR allowlist 解锁 Surge/Clash/Mihomo TUN 场景 | pi-web-access（nicopreme）SSRF 守卫 + allowRanges；MEMORY「push 走 HTTPS 因代理 fake-ip 拦 SSH」直接命中 | 修改 F3.9.5 | v0.1 P0 |
| 3.5.6 | **bounded output + @oN 续页**：48KiB/2000 行硬限，超限存盘 `/tmp/@oN.txt` mode 0o600 返回 16KiB preview + tool-specific refine hint | pi-computer-use `output.ts applyOutputEnvelope/storeOutput/refinementFor`；MODE_TEXT_MAX_BYTES/LINES 常量 | 新增 F3.2.20 | v0.3 P1 |
| 3.5.7 | **high-risk pattern 黑名单 gate**（browse_logged_in only）：遇 drag-drop/toast/rich-text-editor/tree-view/data-grid 直接放弃自动操作并升级用户 | GitHub Accessibility Agent 内部 pilot；complexity scoring 门槛 | 新增 F3.3.13 | v0.3 P1 |
| 3.5.8 | **API/GUI/Hybrid 框架自定位**（文档层）：search channel 是 API 路径，browse_headless/browse_logged_in 是 GUI 路径，跨通道 fallback 链是 hybrid——给 v0.2 provider 矩阵学术背书的术语 | MCPWorld（arxiv 2506.07672）75.12% 任务完成率 hybrid > 纯 GUI/纯 API | §0 定位补充 | v0.2 P2 |
| 3.5.9 | **white-box verification**（SERP selector 验证升级）：验证时检查结构化字段（result count/duration/pagination 存在）而非「有 div.serp-result 就算成功」 | MCPWorld white-box verification | 修改 F3.8.10 | v0.7 P1 |
| 3.5.10 | **actions_and_results 审计链**（F3.2.11 steps 返回值升级）：steps 返回不是黑盒 list[str] 而是 `[(step, [result, result...]), ...]`；`should_terminate_remaining_chain` 标志（默认 True） | Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]` + `ActionFailure.should_terminate_remaining_chain` | 修改 F3.2.11 返回值 schema | v0.3 P0 |
| 3.5.11 | **screenshot payload size bounding**：max 1920px / 2MiB；format/quality/scale 可调；metadata 返回 `coordinate_width/height/scale` 让调用方换算坐标 | agent-sh/computer-use-linux screenshot 默认 size-bounded | 修改 F3.2.3 | v0.5 P2 |
| 3.5.12 | **verify(prompt) 作为 CC 友好 API 形状**：v0.3 可考虑单独暴露 `verify(state_id, prompt)` 工具比 act+expect 两字段更符合 CC 工具调用习惯 | Stagehand `verify(options) → bool`；`extract(prompt, zod_schema) → VerificationResult{data, verified}` | 评估项 | v0.3 评估 |

---

## 4. 对 09 排期的调整建议

### 4.1 提前的项（v0.7 → v0.1 / v0.3 加新）

| 调整 | 原 | 新 | 理由 |
|---|---|---|---|
| doctor CLI（F3.6.7） | v0.7 | **v0.1** | agent-sh/computer-use-linux 证明 doctor 是装机长尾教训的最佳兜底；三通道各有失败面（API key/headless Chrome/:9222/SERP selector 债），v0.1 没有它调试极痛 |
| 架构不变量测试（F3.9.8） | 无 | **v0.1** | pi-computer-use `check-invariants.mjs` 范式；02 简单清单脚本化；防重构回退（如 BaseChannel 被绕过、第二套 fallback 范式被引入）；和 media-gen-mcp 0.11.0 抓 3 个 mock 掩盖的🔴同一思路 |
| MCP ToolAnnotations（F3.9.9） | 无 | **v0.1** | browse_logged_in 携带 session cookie 出网是 openWorldHint；chrome-devtools-mcp 不会替你做，是 MCP host 能看见的责任 |
| SSRF allowRanges（F3.9.5 修改） | v0.1 已有 SSRF | **v0.1 补 allowRanges** | pi-web-access 命中用户 fake-ip 环境；不补则部署到 Surge/Clash/Mihomo TUN 环境直接挂 |
| tri-state outcome（F3.4.11） | 无 | **v0.1** | 当前二元 bool 把 unknown 信号丢了的实锤；pi-computer-use actions.ts 证据；fallback 引擎重构前必须先把 outcome 升 tri-state |

### 4.2 v0.3 多步链式重排（F3.2.11 的实质升级）

原 09 v0.3 设计：「steps 多步链式 + session 隔离」，验收标准只看延迟和 token 节省。

**修正后的 v0.3 应包含**：

| 子项 | F 编号 | 借鉴源 | 验收标准 |
|---|---|---|---|
| steps + expect 后置条件 | F3.2.11 升级 + F3.2.18 新增 | pi-computer-use `bridge.ts performBrowserTransaction` 100ms poll + `actions.ts outcomeAfterCheck` | 5 步链式 navigate→click→wait→fill→snapshot 中每步可附 expect；failed postcondition 改 outcome 为 didnt |
| actions_and_results 审计链 | F3.2.11 返回值 schema 升级 | Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]` + `should_terminate_remaining_chain` | CC 拿到 `[(step, [result...]), ...]` 因果链而非黑盒序列 |
| StateStore + stateId + epoch | F3.2.10 修改 + F3.2.19 新增 | pi-computer-use `runtime.ts StateStore` LRU(128) + `state.ts AsyncLocalStorage` | 并发 2 session ALS 隔离率 100%；过期 stateId `cleanly fail` |
| bounded output + @oN 续页 | F3.2.20 新增 | pi-computer-use `output.ts` 48KiB/2000 行 | 多步链式返回结果超 48KiB 自动落盘 + 16KiB preview + refine hint |
| high-risk pattern gate | F3.3.13 新增（browse_logged_in only） | GitHub Accessibility Agent complexity scoring | 遇 drag-drop/toasts/RTE/tree-view/data-grid 放弃自动操作并升级用户 |

**验收标准补充**（除原 09 v0.3 五条外）：
- [ ] 每步 expect 失败时链式正确终止，返回 `failed_postcondition` + stoppedAt 精确边界
- [ ] `preexisting` 三态诚实报告（条件本就成立→动作可能幂等或没必要）
- [ ] outcome=unknown 时 fallback 引擎自动触发（browse_headless 验证不了→升 browse_logged_in）

### 4.3 推迟或砍掉的项

| 调整 | 原 | 新 | 理由 |
|---|---|---|---|
| compact diff（stabilizeRefs + changesBetween） | 未规划 | **v0.6+ 或 NO-GO** | SERP 通道每次重新生成不是 patch；browse click 大多触发 root_replaced；受益面窄（同页 SPA 分页/折叠展开）；如真要做借 Stagehand `diffCombinedTrees` 而非 pi-computer-use 全套 |
| ResourceScheduler + epoch 串行 | 未规划 | **v0.5+ 视并发压力** | 今天主并发是「跨 provider fallback」（已有 60s 熔断）；非「跨 agent 同资源竞争」；v0.3 F3.2.11 单 tab 串行已够；过早引入拖累 MVP |
| multi-root forest | 未规划 | **永远不进** | web-only 领域错位；cc-control-all 桌面项目另议 |
| AX outline / a11y tree 主路径 | 未规划 | **永远不进 Lasso** | 数据单元是 SERP/抽取文本行集；不是 AX 树；硬套过度设计 |

### 4.4 新增版本项

**v0.2 补**：
- `F3.6.1` per-provider 多 Key 池 + 配额账本（前置，调研已识别）
- `F3.6.2` provider_type 三态 schema（前置）
- **SSRF allowRanges 配置项**（v0.1 落地，v0.2 完善 CIDR 表）

**v0.3 加**：见 §4.2

**v0.6+ 评估**：compact diff（如真有 SPA 分页需求）

---

## 5. 明确「不借鉴」的（诚实排除）

### 5.1 领域错位（web-only vs 桌面）

| 项 | 来源 | 不借鉴理由 |
|---|---|---|
| multi-root forest 的 desktop roots | pi-computer-use `bridge.ts performListWindows/storeWindowRef` | Lasso 是 web-only，没有可并发观测的桌面 UI 森林 |
| AXAPI/UIA/ScreenCaptureKit/AppKit/Windows UIA/SetWinEventHook/HID 投递 | pi-computer-use `platform/` + native helper | 桌面专属机制，与 browser-only 无关 |
| focus 保留 / foreground-background retry | pi-computer-use `actions.ts canRetryInForeground` | CDP 页面无前台/后台焦点问题 |
| native helper / Windows bridge stdin/stdout JSON-lines | pi-computer-use `platform/architecture.ts` + `windows-bridge.md` | 与 web-only 无关 |
| cursor overlay / agent cursor click-through animation | pi-computer-use `configuration.md cursor_overlay=true` | MCP server 不渲染 UI |
| coordinate grounding / pictureOnly / image-based grounding | pi-computer-use grounding ladder | CDP 操作有 selector，无坐标概念 |
| TCC 持久化策略（签名 Developer ID 二进制） | mac-mcp（MichaelAdamGroberman） | Lasso 不控桌面，无 TCC 权限流 |
| AT-SPI/ydotool/Wayland portal | agent-sh/computer-use-linux | Linux 桌面专属 |
| macOS AppleScript / Windows UIA / 三平台桌面控制 | vitalops/opendesk | 桌面专属 |

### 5.2 复杂度不划算（过度设计）

| 项 | 来源 | 不借鉴理由 |
|---|---|---|
| @rN + @eN 双层 ref 体系 | pi-computer-use `contract.ts` | 对纯文本抽取场景过度；Lasso 用 stateId+resultIndex 即可 |
| graftScopedOutline + clearScopedRects 子树合并 | pi-computer-use `outline.ts graftScopedOutline` | AX 树有 truncated 子树语义，DOM 没有对应；过度设计 |
| WindowNote seen/changed/never-looked 三态 | pi-computer-use `note.ts WindowNote` | 交互式 UI 遍历贴切；SERP 是扁平行集，简化即可 |
| 8 immutable look records ring buffer | pi-computer-use 内存约束 | 其内存约束非通用 |
| progressive disclosure fold-to-budget maxDepth:2/maxNodes:150 | pi-computer-use `outline.ts foldToBudget` | DOM 折叠应按 tag/class 而非 role；对 SERP 不适用 |
| compact diff（stabilizeRefs + changesBetween） | pi-computer-use `view.ts` | 受益面窄（同页 SPA 分页/折叠展开）；SERP 通道每次重新生成不是 patch；browse click 大多触发 root_replaced |
| ResourceScheduler + epoch 串行（v0.1-v0.4 规模） | pi-computer-use `runtime.ts ResourceScheduler` | 主并发是「跨 provider fallback」（已有 60s 熔断）；非「跨 agent 同资源竞争」；过早引入拖累 MVP；v0.5+ 视并发压力再评估 |
| agent-loop 层（Judge + loop detection / speculative execution / workflow DSL） | Skyvern / browser-use | agent-loop 是 CC 自己的职责，下沉到 MCP 越界 |
| workflow engine（forge agent step lifecycle / Block.execute_safe） | Skyvern | 媒体交互不需要 workflow DSL |
| 6 通道冗余 system prompt | Wide-Moat/open-computer-use | CC stdio-only 单通道，无 Open WebUI filter 适配需求 |
| Docker 沙箱隔离 | Wide-Moat / e2b-dev | Lasso 跑本地，不需容器化 |
| pynput 录制 + APScheduler 回放 | vitalops/opendesk learn+schedule | browse 不是录制回放任务 |
| Exa 视觉优先策略 + grounding/vision/action 三模型分离 | e2b-dev/open-computer-use | Lasso 走 CDP/DOM 不走截图 |
| Anthropic Computer Use 坐标缩放 | Anthropic 官方 computer-use-tool | 像素驱动路径，应明确「永不引入坐标缩放」作为不变式 |

### 5.3 违反简单性（02 清单视角）

| 项 | 来源 | 不借鉴理由 |
|---|---|---|
| Pi ExtensionAPI / 事件系统（pi.on/pi.registerTool/pi.registerCommand） | earendil-works/pi | Lasso 是 MCP server 不是 harness；引入第二套生命周期模型违反「不复用第二套做法」 |
| curator HTTP+SSE 人工审核 UI | pi-computer-use curator | CC stdio only；人工审核不在 MCP 职责内 |
| Pi 的 `pi install npm:` 扩展生态分发 | earendil-works/pi | 哲学与 Lasso「统一对外交互 MCP 单包」相反；Lasso 应警惕「统一但浅」，但不引入扩展生态 |
| 完整的 act/observe/extract 三 API 高层封装 | Stagehand | Lasso 是 CC 工具，chrome-devtools-mcp 已给 CC 这个层；再加一层是过度抽象 |
| CDP engine 内部细节 | Stagehand | 已被 chrome-devtools-mcp 吸收 |
| Python Engine 代码生成执行 | LaVague | 越界，非 MCP 职责 |
| World Model COMPLETE/SUCCESS 状态机 | LaVague | agent-loop 决策层 |

### 5.4 部署/商业模式不适用

| 项 | 来源 | 不借鉴理由 |
|---|---|---|
| browserbase 2FA 自动解 | Skyvern/browserbase | 已知 60% 失败率前车之鉴；已确立「不解 2FA」边界 |
| E2B Desktop Sandbox / OS-Atlas/ShowUI grounding 模型 | e2b-dev/open-computer-use | CUA 视觉路线，与 Lasso CDP/DOM 路线相反 |
| AppReveal in-app debug-only MCP | UnlikeOtherAI/AppReveal | 要源码集成，与 Lasso 零侵入定位不同 |

---

## 6. 新增 F 编号清单

| F 编号 | 名称 | 版本 | 源证据 | 说明 |
|---|---|---|---|---|
| **F3.2.10 修改** | 页面状态写磁盘 → 内存 StateStore<PageSnapshot> + stateId | v0.3 | pi-computer-use `runtime.ts StateStore<T>` LRU(128) + `state.ts SavedStates.AsyncLocalStorage` | 保留磁盘用于跨进程重启；主路径改内存；ALS 请求级 hydrate；epoch 字段保留但不启用 ResourceScheduler |
| **F3.2.11 升级** | steps 返回 actions_and_results 审计链 | v0.3 | Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]` + `ActionFailure.should_terminate_remaining_chain` | 返回不是黑盒 list[str]；CC 拿因果链 |
| **F3.2.18 新增** | expect 后置条件 + 三态（verified/preexisting/failed） | v0.3 | pi-computer-use `contract.ts UiCondition/ActParams.expect` + `actions.ts outcomeAfterCheck` + `bridge.ts performBrowserTransaction` 100ms poll | BrowseOptions 加 `expect: ExpectCondition` 字段 |
| **F3.2.19 新增** | StateStore + stateId + epoch 字段 | v0.3 | pi-computer-use `runtime.ts StateStore` + `state.ts SavedStates.hydrate` | LRU(128) 抗膨胀；过期 cleanly fail |
| **F3.2.20 新增** | bounded output + @oN 续页 | v0.3 | pi-computer-use `output.ts applyOutputEnvelope/storeOutput/refinementFor` | 48KiB/2000 行硬限；超限落盘 mode 0o600；16KiB preview + tool-specific refine hint |
| **F3.2.21 新增** | 架构不变量编码为可执行脚本 | v0.1 | pi-computer-use `scripts/check-invariants.mjs + check-runtime-concurrency.mjs + check-tool-schemas.mjs` | CI 强制跑「browse 是唯一 browse 入口 / BaseChannel 不被绕过 / ProviderConfig 注册表单一真源 / 不复用第二套 fallback 范式」断言 |
| **F3.3.13 新增** | MCP ToolAnnotations | v0.1 | agent-sh/computer-use-linux ToolAnnotations 四象限（readOnlyHint/destructiveHint/idempotentHint/openWorldHint） | browse_logged_in=openWorldHint；search=readOnlyHint |
| **F3.3.14 新增** | high-risk pattern 黑名单 gate（browse_logged_in only） | v0.3 | GitHub Accessibility Agent complexity scoring + high-risk pattern 黑名单 | 遇 drag-drop/toasts/RTE/tree-view/data-grid 放弃自动操作并升级用户 |
| **F3.4.11 新增** | tri-state outcome（worked/didnt/unknown + fail closed when uncertain） | v0.1 | pi-computer-use `actions.ts outcomeAfterCheck`；调研角度 3「unknown 才是 fallback 引擎的真正触发器」 | 替换当前二元 success:bool；unknown 自动触发 fallback 链 |
| **F3.6.7 修改** | doctor CLI 从 v0.7 提前到 v0.1 | v0.1 | agent-sh/computer-use-linux `doctor` 单发 JSON readiness 报告 | 覆盖 search API key/headless Chrome/:9222/SERP selector 四失败面 |
| **F3.8.10 修改** | selector 命中率统计 → white-box verification | v0.7 | MCPWorld white-box verification | 验证时检查结构化字段（result count/duration/pagination 存在）而非「有 div.serp-result 就算成功」 |
| **F3.9.5 修改** | SSRF 拒绝 → SSRF allowRanges（CIDR allowlist 解锁 fake-IP 代理） | v0.1 | pi-web-access（nicopreme）SSRF 守卫 + allowRanges | 默认拒私有/保留 IP；可配 CIDR allowlist 解锁 Surge/Clash/Mihomo TUN 场景（命中用户 MEMORY） |

---

## 7. 是否立即更新 08/09（verdict + 具体改哪几处）

### Verdict: **GO-WITH-CONDITIONS（立即更新 v0.1/v0.3 部分，v0.5+ 借鉴标注延后）**

**理由**：pi-computer-use 深读揭示的 tri-state outcome / expect 后置条件 / StateStore immutable / 架构不变量测试 / bounded output 五项是「立即可落地、不增加复杂度、直接提升可靠性」的高价值借鉴；agent-sh doctor + ToolAnnotations 是装机必备漏项；pi-web-access SSRF allowRanges 直接命中用户环境。compact diff / ResourceScheduler / multi-root forest 则诚实排除或推迟。

### 7.1 立即更新 08（v0.1/v0.2/v0.3 阶段）

**修改 08 §0 设计原则**：在第 4 条「fallback 对 CC 透明」后加：
> 4.5 **诚实三态交付**（借鉴 pi-computer-use `actions.ts outcomeAfterCheck`）：动作结果不止报「事件已派发」，必须区分 verified / preexisting / failed 三态；failed 强制 outcome 降为 didnt；unknown 自动触发 fallback 链。架构铁律：event delivery alone is never treated as semantic success。

**修改 08 §3.4 fallback 链引擎**：在 `run_with_fallback` 后加：
> - **tri-state outcome（worked/didnt/unknown）**（F3.4.11，借鉴 pi-computer-use `actions.ts outcomeAfterCheck`）：当前 `InteractResult.ok: bool` 升级为 `outcome: Literal["worked","didnt","unknown"]`；`unknown` 是 fallback 引擎的真正触发器——browse_headless 验证不了时 `unknown` 应自动升 browse_logged_in，二元 bool 把这个信号丢了。

**修改 08 §3.9 错误模型**：加新章节 §3.9.3 「架构不变量测试」：
> - **invariants-as-tests**（F3.9.8，借鉴 pi-computer-use `scripts/check-invariants.mjs`）：CI 强制跑断言——browse 是唯一 browse 入口；BaseChannel 不被绕过；ProviderConfig 注册表单一真源；不复用第二套 fallback 范式；MCP ToolAnnotations 完整性（每个工具有 readOnlyHint/openWorldHint）；架构不变量漂移任一项即 CI 失败。

**修改 08 §5.1 安全**：SSRF 守卫段加：
> - **SSRF allowRanges**（F3.9.5 修改，借鉴 pi-web-access）：默认拒私有/保留 IP；可配 CIDR allowlist 解锁 Surge/Clash/Mihomo TUN+fake-IP 场景（默认 allowlist 空；用户在 fake-ip 环境可加 `198.18.0.0/15`）。**命中用户部署环境**（push 走 HTTPS 因代理 fake-ip 拦 SSH）。

**修改 08 附录 B 接口签名**：在 `BrowseOptions` 加：
```python
@dataclass
class ExpectCondition:
    text: str | None = None
    selector: str | None = None
    url_contains: str | None = None
    gone: bool = False
    timeout_ms: int = 5000

@dataclass
class BrowseOptions:
    selectors: dict | None = None
    js: str | None = None
    steps: list[Step] | None = None
    expect: ExpectCondition | None = None    # 新增（F3.2.18, v0.3）
    wait_until: str = "networkidle"
    screenshot: ScreenshotSpec | None = None
    timeout_ms: int = 30000
    no_cache: bool = False
```

**修改 08 附录 A 版本路线 v0.1 行**：核心交付加：
> F3.4.11 tri-state outcome / F3.6.7 doctor CLI（从 v0.7 提前）/ F3.9.5 SSRF allowRanges / F3.9.8 架构不变量测试 / F3.3.13 MCP ToolAnnotations

**修改 08 附录 A 版本路线 v0.3 行**：核心交付加：
> F3.2.10 修改（内存 StateStore）/ F3.2.11 升级（actions_and_results）/ F3.2.18 expect + 三态 / F3.2.19 stateId+epoch / F3.2.20 bounded output + @oN / F3.3.14 high-risk pattern gate

**新增 08 附录 F：基于 12 pi-computer-use 深度分析的修正（2026-07-21）**：把本文档的 §3/§5/§6 浓缩成表格，与附录 D/E 同结构。

### 7.2 立即更新 09（v0.1/v0.3 排期）

**修改 09 §1 阶段总览表 v0.1 行**：
> 核心交付加：F3.4.11 tri-state outcome / F3.6.7 doctor CLI / F3.9.5 SSRF allowRanges / F3.9.8 架构不变量测试 / F3.3.13 ToolAnnotations
> 验收标志加：架构不变量测试 100% 通过；doctor CLI 覆盖 10 项检查；tri-state outcome 在 unknown 时正确触发 fallback

**修改 09 §2.1 v0.1 实现要点**：加：
> 7. **架构不变量测试借鉴 pi-computer-use `scripts/check-invariants.mjs`**：CI 强制断言「browse 是唯一 browse 入口 / BaseChannel 不被绕过 / ProviderConfig 注册表单一真源」
> 8. **doctor CLI 借鉴 agent-sh/computer-use-linux**：返回结构化 JSON readiness 报告（API key/headless Chrome/:9222/SERP selector 四失败面 + blockers + next step）
> 9. **tri-state outcome 借鉴 pi-computer-use `actions.ts outcomeAfterCheck`**：替换二元 success:bool；unknown 自动触发 fallback

**修改 09 §2.3 v0.3 实现要点**：加：
> 6. **steps + expect 借鉴 pi-computer-use `bridge.ts performBrowserTransaction`**：100ms poll 循环等 postcondition；三态 verified/preexisting/failed；failed 强制 outcome=didnt
> 7. **actions_and_results 审计链借鉴 Skyvern**：返回 `[(step, [result...]), ...]` + `should_terminate_remaining_chain` 标志
> 8. **StateStore LRU(128) + stateId + AsyncLocalStorage 借鉴 pi-computer-use `runtime.ts StateStore + state.ts SavedStates`**：保留磁盘用于跨进程重启；主路径改内存；ALS 请求级 hydrate
> 9. **bounded output + @oN 续页借鉴 pi-computer-use `output.ts`**：48KiB/2000 行硬限；超限落盘 mode 0o600
> 10. **high-risk pattern gate 借鉴 GitHub Accessibility Agent**：browse_logged_in 遇 drag-drop/toasts/RTE/tree-view/data-grid 放弃自动操作并升级用户

**修改 09 §2.3 v0.3 验收标准**：加：
> - [ ] 每步 expect 失败时链式正确终止，返回 `failed_postcondition` + stoppedAt 精确边界
> - [ ] `preexisting` 三态诚实报告
> - [ ] outcome=unknown 时 fallback 引擎自动触发

**修改 09 §5.3 依赖关系矩阵**：
> v0.1 → v0.3：v0.3 的 StateStore + expect 依赖 v0.1 的 tri-state outcome（unknown 触发 expect failed）

**新增 09 附录：基于 12 pi-computer-use 深度分析的排期修正（2026-07-21）**：
> - doctor CLI 从 v0.7 提前到 v0.1（最高杠杆漏项）
> - 架构不变量测试 v0.1 立即加
> - SSRF allowRanges v0.1 补（命中 fake-ip 环境）
> - v0.3 多步链式重排：加 expect + StateStore + bounded output + actions_and_results + high-risk pattern gate 五项
> - compact diff（stabilizeRefs + changesBetween）标注 v0.6+ 或 NO-GO（受益面窄）
> - ResourceScheduler + epoch 串行标注 v0.5+ 视并发压力
> - multi-root forest 标注永远不进（领域错位）

### 7.3 推迟标注（写入附录但不立即落地）

- **compact diff**：08 §3.2 加注释「v0.6+ 评估；如引入借 Stagehand `diffCombinedTrees` 而非 pi-computer-use 全套」；09 加 v0.6 候选项「SPA 分页场景 compact diff 评估」
- **ResourceScheduler + epoch 串行**：08 §3.5 加注释「v0.5+ 视并发压力再启用；单 tab 串行已够」；F3.2.19 的 epoch 字段保留但不启用 write 前 stale-reject
- **multi-root forest**：08 §7 边界加「永远不进；桌面扩展是 cc-control-all 项目范围」

### 7.4 文档卫生动作

- **08/09/MEMORY 所有提到 pi-computer-use 处明确标 `injaneity/pi-computer-use`**（避免与 `swairshah/pi-computer-use` 混淆——后者只有 18 个 `gui_*` 工具 + `gui_batch`，没有 observe_ui/act_ui/expect 等高级语义抽象）
- **MEMORY 加 [Lasso project] 条目**：记录 08/09 现状 + 12 号优化建议的核心决策（tri-state outcome 进 v0.1 / expect+StateStore 进 v0.3 / compact diff 推迟 / multi-root forest 永不进）

---

## 关键决策回顾（一句话）

1. **tri-state outcome（worked/didnt/unknown）** 进 v0.1 = pi-computer-use `actions.ts outcomeAfterCheck` + 「unknown 才是 fallback 引擎真正触发器」的实锤
2. **expect 后置条件 + 三态（verified/preexisting/failed）** 进 v0.3 = pi-computer-use `bridge.ts performBrowserTransaction` 100ms poll + 「event delivery alone is never semantic success」铁律
3. **StateStore LRU(128) + stateId + AsyncLocalStorage** 进 v0.3 = pi-computer-use `runtime.ts StateStore + state.ts SavedStates` 把「短指针写磁盘」升为不可变快照
4. **架构不变量编码为 CI 脚本** 进 v0.1 = pi-computer-use `check-invariants.mjs` + 02 简单清单脚本化 + media-gen-mcp 0.11.0 抓 mock 掩盖🔴思路
5. **doctor CLI** 从 v0.7 提前到 v0.1 = agent-sh/computer-use-linux 范式 + 三通道各有失败面的现实
6. **SSRF allowRanges** 进 v0.1 = pi-web-access 直接命中用户 fake-ip 部署环境
7. **bounded output + @oN 续页** 进 v0.3 = pi-computer-use `output.ts` 48KiB/2000 行 + 64MiB LRU
8. **actions_and_results 审计链** 进 v0.3 = Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]` + `should_terminate_remaining_chain`
9. **high-risk pattern 黑名单 gate** 进 v0.3 = GitHub Accessibility Agent complexity scoring + drag-drop/toasts/RTE/tree-view/data-grid 不自动操作
10. **compact diff（stabilizeRefs + changesBetween）/ ResourceScheduler / multi-root forest** 推迟或永不进 = 诚实承认领域差异（web-only vs 桌面 AX）+ 复杂度门槛（v0.1-v0.4 规模未达）+ 受益面窄（SERP 重新生成非 patch）

---

**参考文件路径**（绝对路径）：
- `/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md`（待更新：附录 F + §0/§3.4/§3.9/§5.1/附录 B/附录 A v0.1+v0.3 行）
- `/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md`（待更新：§1 总览表 v0.1 行 + §2.1/§2.3 实现要点与验收 + §5.3 依赖矩阵 + 新附录）
- `/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md`（架构不变量测试的清单基础）