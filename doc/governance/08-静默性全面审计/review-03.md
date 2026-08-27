# 27 · 修复轮 03 审查（review-03.md）

- **审查标准**：`/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md` §1 六维度（1.1–1.7）
- **被审改动面**：v1.17.1 → v1.17.2 —— `src/channels/LoggedInChannel.ts`（ensureOwnPageSelected + 装配序）、`src/logged-in/TabRegistry.ts`（parser + 登记制 reconcile）、`src/invariants/check-invariants.mjs`（INV-78(d) 精化）、测试三件、文档四件
- **审查人**：修复与文档官（本轮作者自审 + 机械化门禁；无独立第二审查人——如实声明，靠 INV/单测/L3 补偿）

## 1.1 代码规范 ✅

- 命名与既有范式平行（`ensureOwnPageSelected` ↔ `precreateBackgroundTabIfHidden`）；测试名 = 领域行为（S7-1..S7-7 / 所有权边界 / wire 契约）。
- 注释全部 WHY（为什么 id-diff 不取最大 id / 为什么登记制 / 为什么无死码守卫）；正则注释保留（03 1.1 例外条款）。
- style 由 tsc/build 门禁覆盖，人审零消耗。

## 1.2 数据逻辑 ✅（本轮最重维度）

- 🔴 **producer 契约证据（项 1）**——本轮全部上游读取三处锚：
  1. `list_pages` 文本格式 `<id>: <title> (<url>) [selected]`：上游源码（tarball `McpResponse.js:576-598`，L1）+ **本轮 L3 真机实捕**（`verify-data/s7fix-l3-result.json` 的 `after_list_raw_first3` 逐字一致：`1: Example Domain (https://example.org/) [selected]`）。
  2. `select_page {pageId}` 不带 bringToFront = 零激活：上游源码（`tools/pages.js`：`if (request.params.bringToFront)` 才 `page.bringToFront()`，激活严格 opt-in，L1）+ **L3 真机**：select 前后 frontmost 恒 `Windows App`（立即+1s 双采）、窗口恒 0。
  3. `close_page {pageId:number}` schema：上游源码 zod 定义（L1）+ verify.md §5e wire 级 -32602 实证（旧 `{url}` 形态被拒）。
- 🔴 **字段缺失语义（项 2）**：parser 空/无可解析行 → `null`（≠ `[]`）——调用方一律降级 no-op；`sel`/`fresh` undefined 路径显式处理；`news.length !== 1` 显式三分支（0=重试、1=选中、>1=放弃）。
- 🔴 **写前校验（项 3）**：`ownPageId` 只在 `select_page` 成功返回后写；`noteOwnPage` 同点——失败路径不污染 state。
- 🔴 **错误处理（项 7）**：全外部路径（CDP 连接/建塔/列表/select/close）显式 catch + 结构化 warn 事件（`logged_in_own_page_*` / `tab_reconcile_unparseable_list`），零 silent swallow；无 PII 入日志（只记 pageId/targetId/port）。
- 🔴 **宿主契约（项 8）**：本轮核心新原语（select_page 零激活）已 **L3 真机**（s7fix-l3，隔离 profile 零窗口零打扰跑通）；非 deferred。
- 🔴 **运营契约（项 9）**：chrome-devtools-mcp@1.7.0 版本锁（INV-79），上游存活由本轮 npx 实拉复证。

## 1.3 业务逻辑 ✅

- **边界/并发枚举（项 1）**：逐项列出并处置——
  | 边界 | 处置 | 证据 |
  |---|---|---|
  | 用户同刻手开 tab（id-diff >1） | 放弃不赌（宁走降级不误选用户页） | S7-5 |
  | 上游 respawn（pageId 计数器重置） | lastClient 实例变更 → 归因+登记双清空 | S7-7 |
  | targetCreated 事件未及（diff=0） | 两轮 300ms 有界重试 | L3 实测 `id_diff_attempts:2`（重试真实被需要） |
  | 选中页被用户/restore 关闭 | 上游回退 pages[0] → 下轮 mismatch → 重建 | 设计+代码路径 |
  | 并发 getMcpClient | 最坏多建一个 own tab（restore 收尾关）；无 state 损坏 | 分析（无锁单写者，见 1.6-5） |
  | 空列表/格式漂移 | null 降级 no-op | S7-6 |
- 1a（自启守护组合）：未新增任何 timer/thread/自动派发器——不适用。
- 🔴 项 4（design artifact）：机制设计在 fix.md F-1/F-2 + ARCHITECTURE §9/§12.2（diff 之外的可读设计记录），语义不从 diff 重建。

## 1.4 端到端接通 ✅

- 🔴 **值级 trace**（一条完整路径）：CC `browse_logged_in` → `getMcpClient`（ensureRunning→touch→precreate→**快照**→2FA→**ensureOwnPageSelected**→reconcile）→ `select_page {pageId:3}`（L3 实值）→ `navigate_page {type:"url",url:...}` → 值级断言：`user_tab_a_url before=after=example.org/`（**S-7 修复的核心值级证据**）、`own_tab_url_after=example.com/?s7fix=l3`、`upstream_selected_after=3`。
- 🔴 producer→first-consumer 接缝：list_pages 文本（producer=上游 McpResponse）→ parseUpstreamPageEntries（consumer）——格式证据同 1.2。
- 🟡 项 5（跨组件契约 pinned）：上游 1.7.0 文本格式/parser 契约写在 TabRegistry 文件头 + INV-78(d) 实装锚；上游漂移时 parser 返 null 保守降级（version-skew 行为显式）。
- 🟡 项 7（文档面清点）：README（矩阵+changelog+边界行）/ KEY-GUIDE（B 节重写+v1.17.2 note）/ TROUBLESHOOTING（§8.0 新增+症状条目）/ ARCHITECTURE（§9+§12.2+版本数）全部更新，无 not-affected 遗留。

## 1.5 性能 + 生产就绪 ✅

- **性能四问**：新增每 attach 开销 = 1–2 次 list_pages（文本 <1KB）+ 1 次 WS createTarget + 1 次 select_page ≈ 数十 ms（有界重试最坏 +300ms）；对照冷启动 npx ~10s，占比可忽略；无新常驻资源。
- 🔴 **Heisenbug 纪律**：本轮唯一的时序敏感点（targetCreated 异步）以**有界重试 + 保守降级**处置，且 L3 在无插桩真实场景复现（重试第 2 轮命中——机制被真实观测，非注入）。
- 🔴 **PRR 闸门**：(a) 禁用/回滚——无 flag；**降级路径即安全网**（任何失败自动回落旧行为，且旧行为 = v1.17.1 已发布行为）+ git revert 即回滚；认为加 flag 属过度设计（R-ABS，见 1.6-3）。(b) 观测——`logged_in_own_page_selected/ambiguous/not_visible/select_failed` + `tab_reconcile_unparseable_list` 结构化事件已就位。(c) on-call 文——TROUBLESHOOTING §8.0 症状条目（含日志锚）已更新。
- 主线程阻塞：全 async I/O；parser O(行数)、行 <1KB——无同步重段。

## 1.6 简单架构 ✅（最高杠杆维度）

- 🔴 项 1（代码健康）：净删除一个隐性 hazard（全量入册）+ 一个死契约（close_page{url} 永失败）；新增概念三个小 state 字段（ownPageId/lastClient/ownPages）+ 一个纯函数 parser + 一个方法——每个都直接服务「操作面归 own tab」单目标。TabSession/TabRegistry 语义分离（parse17 设计）保持未混。
- 项 3（过工程拒绝）：曾评估「ownership 判定谓词注入」「ledger 分路径 filter」等更强抽象——拒绝，收敛为最小登记制（noteOwnPage/resetOwnPages 两方法）；未加任何 config 旋钮。
- 项 4：`ensureOwnPageSelected` 单一职责（把操作面挪到自建页，含降级）；`reconcile` 单一职责（own 页 LRU）；读者一遍可复述。
- 项 5/6（R-INT-07 多写者）：`ownPageId`/`lastClient` 单调用点写（ensureOwnPageSelected）；`ownPages` 两个写方法但同一调用链内顺序执行（respawn 重置先于本轮登记）；无跨 handler 竞写字段。
- 项 7（对偶问）：合并方向（precreate 与 ensureOwn 共用 createBackgroundTarget 原语）是**原语复用**非行为合并——两路径判定门互斥（台账 hidden vs 非台账），无双写。

## 1.7 冗余与废弃 ✅

- 🔴 死代码：`urlToTabId`（旧 URL 哈希键）随重写删除；`_touchForTests(url)` 旧签名删除；tsc noUnusedLocals/build 绿证。
- 文档陈旧面：verify.md/audit.md 为**带日期的审计记录**（历史事实，不改写）；现行文档四处全部对齐 v1.17.2 语义（含删除已失效的「个别操作可能抢一次焦点」表述——verify.md §7 明示该表述在 1.7.0+v1.17.1 下未复现）。

## 结论

**六维全过，可 ship（v1.17.2）。** 最重维度 1.2（producer 契约）达到本轮可得的最高证据等级（上游源码 L1 + 真机 L3 双锚）；唯一残余声明：无独立第二审查人（单 agent 轮次），以 81 INV 机械化 + 2253 单测/集成测 + L3 真机补偿。已知未修项（desktop/Dock/visible/用户 Chrome 不静音）均为 03 意义上的「设计契约」而非缺陷，已文档化固化。
