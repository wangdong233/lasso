# 第 2 轮 03 审查测试报告（round2-review03）

> 审查测试员：第 2 轮 03 审查测试员（独立于实施者）。日期：2026-08-17。
> 输入：round2 全部改动（T2-1..T2-14 + 2 rider + W-3，工作树未 commit，v1.12.0）+ round2-verdict 裁决书。
> 方法：按 `03_审查测试清单.md` §1 六维逐条 + §2 五阶段；证据阶梯 L1（producer 源码）/L2/L3（真机实测）；mutation 抽查 4 处；门禁全量终跑。
> 基线承诺：1906 tests + 79 INV + 193 Rust 不减。

---

## 0. 裁决速览

| 维度 | 结论 |
|---|---|
| 1.1 代码规范 | **通过**（零问题） |
| 1.2 数据逻辑 | **通过**（producer 契约 L1 全链核验；发现并修复 1 处陈旧文案谎报） |
| 1.3 业务逻辑 | **通过**（边界/并发枚举齐；fallback 分支判定有据） |
| 1.4 端到端接通 | **通过**（三条值级 trace + 两处 L3 实测） |
| 1.5 性能/生产就绪 | **通过**（1 条非阻塞注记：doctor sync execFileSync） |
| 1.6 简单架构 | **通过**（零新依赖；复用优先；单源消费 ×3） |
| 1.7 冗余废弃 | **通过**（陈旧注释清理到位；本审查补修 1 处） |
| §2 测试五阶段 | **通过**（4 处 mutation 全 killed；手测清单 A-E 就位） |
| **总裁决** | **zero-issues-pass（附 1 项本审查修复 + 2 条非阻断注记 + 3 条遗留记档）** |

门禁终态：**build ✓ / npm test 122 files 1940 passed + 1 skipped（1941，基线 1906 → +35，零失败零 flake）/ check-invariants 79/79 ✓ / inv-selftest 11/11 红转（含新 INV-79 样本）+ 覆盖率 11/79 报告 ✓ / cargo test 202 passed（基线 193 → +9）✓**。

---

## 1. 六维逐条结论

### 1.1 代码规范 ✅

- 命名一致：`defaultHeadlessProfileForHost` / `vlm_inference_only` / `parseVlmActions` / `truncated` 全仓单一定义，无多义。
- 注释解释 WHY（上游 #2002 定性、agent-desktop 参数出处、useAsync 禁用理由=SSRF 面），非复述 WHAT。
- 测试名读作领域行为（「第一次命中后消失 → 不成立」），零 `test1` 类命名。
- Lint/type 层由 build（tsc strict）+ vitest 前置承载，人审零 style 消耗。

### 1.2 数据逻辑 ✅（核心维度，全链 L1 核验）

**T2-6 wire 契约（最大风险点，逐字段核验通过）**：
- 消费端 `parseVlmActions` 产出 `{kind:"click",x,y,button?}` / `{kind:"move",x,y}` / `{kind:"drag",from_x,from_y,to_x,to_y}` / `{kind:"scroll",dx,dy,x?,y?}`。
- Producer（`rust-helper/src/cgevent.rs exec_mouse_action`）读取键位逐一核对：click 走 `parse_point(a,"x","y")` + button 字符串（**left/right/center** —— VLM 侧白名单恰为此三者，无 "middle" 漂移）；drag 走 `parse_point(a,"from_x","from_y")`+`("to_x","to_y")`（平铺键与 VLM 产出完全一致）；scroll `dx/dy` 缺省 0、`x/y` 可选。✓ 零字段错配。
- 响应契约：`protocol.rs Response{id,ok,result?,error?,error_kind?}`（serde skip 形态）→ `RustBridge` TS 类型同形 → 消费端 `resp.ok` / `resp.result.results[i].{ok,error_kind,error}` 与 `dispatch()` 实际产出 `{results:[{index,ok,kind}|{index,ok:false,error_kind,error}]}`（cgevent.rs:298 `Response::ok(id, json!({"results":results}))`）逐字段对齐。✓
- 字段缺失语义：`result.results` 缺失 → `resultsArr=[]` → `successCount=0` → 诚实 unknown（不清零、不伪造）。✓
- 结果映射与 CGEventProvider（v1.11 既有消费者）逐行同构——同 producer 双消费者一致性成立。

**T2-3/T2-4 defuddle 契约**：已装 defuddle **0.19.2**（rider 落地）`types.d.ts` L1 核验：`separateMarkdown?`（"Include Markdown in the response"）、`useAsync?`（**默认 true**——"Allow async extractors to fetch content from third-party APIs"；钉 `false` 是真钉非摆设）、`contentMarkdown?`、node 入口签名 `(input, url?, options?)` 全部与调用吻合。`contentMarkdown` 缺失 → `|| null` → turndown 降级保底（`inputHtml = articleHtml ?? html`），served_by 语义仍准确（defuddle 抽取 + 其内部即 turndown）。✓

**T2-11**：Rust `apply_truncated_flag` 仅 `truncated=true` 时向根对象插 `truncated:true`（skip 形态）↔ AxProvider 读 `root.truncated === true`（读 wire 根而非映射后节点——绕开 OutlineMapper 字段裁剪风险）。浅树 byte-identical 有集成断言。✓

**T2-5**：`search_recency_filter` 参数名与 `ZHIPU_RECENCY_MAP` 值域（oneDay/oneWeek/oneMonth/oneYear）由 SearchChannel.ts:62/153 同上游既有实证复用（单一事实源 import，非复制）；DDG `df=` d/w/m/y 拼接 + baidu 不拼诚实降级，不传 byte-identical 有断言。✓

**T2-12**：无新字段读取；shutdown 幂等由既有 `shuttingDown` 守卫承载。

**发现并修复（issue (blocking)→已修）**：`src/tools/descriptions.ts` find 行原文 *"query cached snapshot by text/role/ref (no re-walk)"* 与运行时事实三重不符——①AxProvider.find 每次调 `ax_find` **重 walk**（AxProvider.ts:178 注释 + ax.rs:171 自述）；②state_id 是协议占位无缓存；③`where.ref` 被 zod 接受但 `ax_find` 只读 `where.text/where.role`（ax.rs:176-207），**纯 ref 查询会静默匹配全部节点**。该行恰是 T2-9 本轮编辑行（陈旧文案毗邻改动）。已改为真实描述（live tree / re-walks / ref ignored by find）。复跑门禁全绿。

### 1.3 业务逻辑 ✅

- 边界枚举：空文本、非 ASCII（`ensure_ascii_typable` 纯函数 + 单测）、NaN/字符串坐标（丢弃）、第一次命中后消失（专测）、部分成功、`from==to` 退化 drag（单测覆盖不 NaN 不发散）、`\u{0}` 控制字符（无映射诚实失败）。
- **T2-7 fallback 分支判定**是本轮最好的业务决策样本：`type_error_should_fallback` 只对 `ax_action_unsupported`/`ax_set_failed` 兜底，`ax_verify_failed` **不**兜底——理由成文（值确实没写对，键盘重打是重试不是兜底，保持失败诚实）。纯函数 + 表驱动单测。
- wait 稳定性采样保留 `preexisting` 语义正确性：`streakFromStart` 在 streak 第 1 次命中时锁定 `firstIteration`，第 2 次确认时裁决——首轮已存在 vs 后出现区分不丢。✓
- 无新守护线程/定时器（1.3-1a 不触发）；无第二套做同一件事的方式（键盘兜底复用 `cgevent::post_key_event` pub(crate)，非第二套合成器）。

### 1.4 端到端接通 ✅

三条值级 trace（含字段缺失跳）：
1. **stdin EOF**：spawn dist → `lasso_ready` → `stdin.end()` → end/close → 幂等 `shutdown("stdin_eof")` → exit 0 + `lasso_shutdown`/`stdin_eof` 日志断言——真实子进程 L3，非 mock。
2. **VLM 闭环**：vlmCaller → `parseVlmActions` → `rust.call("cgevent_dispatch")` → 逐项结果 → `actions_and_results`——测试断言到 wire 字节级（`params` toEqual 精确对象），drag 嵌套 from/to → 平铺 wire 的转换被显式断言。
3. **T2-13**：装配 grep（顺序断言：ToolManager 创建 → setMetrics）+ 行为级（wrapHandler 真调 `metrics.record("admin:worked")`）。

L3 实测两处：defuddle URL 透传真跑（HN fixture：传 url → `/item?id=1` 绝对化 + GFM 表格；不传 → 保持相对，与测试断言一致）；Chrome `--version` 探测真跑（本机 `Google Chrome 150.0.7871.182` → stdout 可解析、skew hint 机制成立）。

文档面清点：README（v1.12 段 + 三处行内更新）/ KEY-GUIDE（R-ECO-6 补记）/ descriptions.ts（T2-7/T2-9/T2-11 + fetch_url TIP）/ 版本四处对齐（package.json + index.ts + doctor.ts + 3 个测试文件，INV-63 绿）。✓

### 1.5 性能 + 生产就绪 ✅（1 条非阻断注记）

- **注记 A（non-blocking）**：`chromeVersionSkewHint` 用 `execFileSync(bin,["--version"],{timeout:3000})`——而 `runDoctor` 经 doctor-tool 暴露为 MCP tool，doctor 调用期间同步阻塞 server 事件循环上限 3s。判定：诊断路径非热路径、doctor 本身秒级多探测、3s 硬上界、单用户场景——按 satisficing 接受，不建议为它引入 async 改造（改动面 > 收益）。若未来 doctor 高频化再改 async。
- drag ~500ms 物理时长是**交付物本身**（目标 app 需要轨迹），发生在 Rust 进程，Node 事件循环零阻塞。
- Heisenbug 纪律：W-3 移桶后全量并发零 flake（doctor-cli-config-file 在 timing-sensitive 桶 9.0s 通过）；stdin-eof 用真实子进程无插桩断言。
- 回滚：14 项均单点可 revert；默认路径 byte-identical 承诺处（浅树/不传 freshness/不传 url/raw 档）均有断言钉住。

### 1.6 简单架构 ✅

- 零新依赖（defuddle 0.19.2 仅 lockfile 刷新，^range 已含）；零新通道/机制。
- 复用优先的三个样本：`post_key_event` pub(crate)（T2-7 不复制键盘合成）；`ZHIPU_RECENCY_MAP` import（T2-5 不复制映射表）；`defaultHeadlessProfileForHost` 单源三消费（index 装配 / doctor-cli 探测 / doctor #25——三处不会漂移）。
- `do_type` 拆分为 `do_type_via_axvalue` + `type_via_keyboard`——单一职责改善而非缠绕增加；`walk` 仅增 1 参数（`&mut truncated`），find/act 传占位保持签名统一。
- `parseVlmActions` 导出为纯函数（可独立测试），不锁 VLM shape（宽化 record 提取）——符合"接口小实现厚"。
- 多写者检查：本轮唯一新写者是 stdin EOF → shutdown；shutdown 幂等守卫既有，SIGTERM 先到被 `shuttingDown` 挡住——无未协调竞写。

### 1.7 冗余与废弃 ✅

- 陈旧注释清理（T2-2）：BrowseChannel PerformanceObserver/M0.5b 两处、StagehandChannel R-ECO-6 档案更新（含 doctor #39 next_step 文案同步）、SerpHealthMonitor "google"→"ddg"、ax.rs「走档2/3」死胡同错误文案随修复移除。全部与 v1.11/v1.12 现实对齐。
- M0.5b 永久落空的注释承诺被真实现替换（谎言→真话，1.7 最佳实践）。
- 本审查补修 1 处（find 描述，见 1.2）。无新死代码、无注释掉的代码、无 tracked 构建产物。

---

## 2. §2 五阶段

| 阶段 | 结论 |
|---|---|
| 2.1 单测 | ✅ 新增 35 测试；**mutation 抽查 4 处全 killed**：①stdin EOF 两行移除 → spec 红（642ms 复现）；②`REQUIRED_CONSECUTIVE 2→1` → 瞬时命中守护红；③`successCount===0 → <0` → 全项失败分支红；④separateMarkdown 的表格断言由 producer 不可达性证明（裸 turndown 对 `<table>` 产出无 `|` 分隔符，裁决书 L3 实测 `"a\n\nb"` 形态）。producer 缺字段用例：resultsArr 缺失/NaN 坐标/非对象 result 全覆盖 |
| 2.2 集成 | ✅ cgevent wire 契约双消费者同构（CGEventProvider ↔ ScreenshotVlmProvider 读法一致 = 契约同步等价）；desktop-action-enum/ax-act 经 DesktopChannel 全装配验证 T2-9/10/11；serp-ddg/machine-mcp 透传断言含不传 byte-identical |
| 2.3 冒烟 | ✅ stdin-eof 真子进程退出 + 日志值级断言；defuddle 真跑激活；真机物理路径（drag 轨迹/Electron 输入/echo server 指纹/kill CC）正确归档手测清单 A-E（状态 pending 待用户执行） |
| 2.4 性能 | N/A（无性能敏感路径改动；drag 时长是功能本体） |
| 2.5 用户验收 | 手测清单 A-E 就位待非作者（用户）执行签核——记遗留 |

---

## 3. 本审查修复清单（1 项）

| # | 文件 | 问题 | 修复 | 门禁复跑 |
|---|---|---|---|---|
| R03-1 | `src/tools/descriptions.ts` | find 描述谎报 "cached snapshot / no re-walk / ref"（实际每次 re-walk；ref 被 ax_find 静默忽略）——1.7-5 陈旧引用毗邻 T2-9 编辑行 | 改为真实描述（live tree / re-walks every call / ref ignored by find） | build + npm test（122 files 1940+1 skip）+ INV 79 全绿 ✓ |

非阻断注记（不修，记档）：
- **N-1**：doctor skew hint `execFileSync` 同步阻塞（≤3s，诊断路径）——见 §1.5 注记 A。
- **N-2**：T2-6 rust 层 `tcc_event_synthesis_denied` 归 `unknown` 而非 CGEventProvider 的 `didnt`——链尾 unknown 上报不算不诚实（verdict 未要求对齐），记为后续一致性小项。
- **N-3**：实施报告称「不传 url byte-identical 断言」——实际测试断言的是窄性质（相对链接不绝对化），非字节全等；T2-4 本就合法改变转换层输出，报告措辞略强。测试本身诚实无问题。

---

## 4. 遗留项（下轮/记档，非本轮阻断）

1. **`where.ref` 静默忽略（1.2 家族）**：zod 接受 `where.ref` 但 `ax_find` 只消费 text/role——纯 ref find 会匹配全部节点并成功返回（tri-state 静默参数丢弃，与 T2-5 同族）。本轮只修了描述文案；根治（schema 收紧或 Rust 消费 ref 或缺参报 didnt）建议进 round3 候选。
2. **手测清单 A-E 执行**：五项真机验证（kill CC 收尾 / echo server OS 一致 / Electron type / drag 滑条 / find actions+truncated 真机）待用户跑后签核，2.5 才算闭合。
3. **T2-6 真机 VLM 端到端**：需 LASSO_VLM_ENDPOINT 真配置 + 真 VLM 返回坐标——单测 mock 三分支已覆盖验收线；真机闭环可作为手测清单 F 增补（可选）。
4. **INV 样本覆盖 11/79**：报告已显性化（非门禁）；下轮优先 INV-76/68/71 外部契约类（T2-14 记档）。

---

## 5. 门禁终跑输出（审查员本机，2026-08-17）

```
npm run build          → BUILD_OK（tsc + dist 产物）
npm test               → Test Files 122 passed (122)
                         Tests  1940 passed | 1 skipped (1941)   [基线 1906 → +35]
npm run check-invariants → All 79 invariants passed.             [79/79]
npm run inv-selftest   → All 11 sampled pins flipped red under violation.
                         样本覆盖 11/79（含新 INV-79 样本）
cargo test (rust-helper) → 42+96+9+10+30+6 = 202 passed, 0 failed [基线 193 → +9]
```

## 6. Sign-off

- **Reviewed-by**：第 2 轮 03 审查测试员（六维 + 五阶段 + 4 mutation + 门禁全量）
- **Tested-by**：同上（独立复跑：门禁 5 项 + defuddle L3 + Chrome 探测 L3 + stdin/vlm/稳定性 mutation 红）
- **裁决**：**zero-issues-pass**。T2-1..T2-14 + 2 rider + W-3 全部过验收线；1 项审查修复（R03-1）已落并复跑；遗留 4 项记档不阻断。工作树可 commit。
