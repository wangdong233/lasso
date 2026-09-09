# 问题决议：消费方台账 L-1/L-2/L-3（navigate 死参数 + file:// 白名单 + console 暴露面）（BUG-05）

> 日期：2026-09-09 · 来源：novel-engine 消费方台账 `/Users/wangdong/Documents/Project/小说/base/novel-engine/research/lasso-工具问题台账.md`（L-1/L-2/L-3）+ 实测佐证 `timeline-viz-浏览器实测.md` · 基线：v1.22.1（6003604，工作树净）
>
> 本轮构成：白盒核查员（源码锚点+真机双证）+ 外部调研员（/tmp/lr 证据包：chrome-devtools-mcp main 全源、playwright-mcp 源、McpContext validatePath、path-is-inside）+ 设计合成员（本文件；对全部输入 findings 逐锚复核——**复核有修正**，见 §2）。
>
> **修订 r1（2026-09-09，设计修订员）**：三路否定发现逐条复核——①号确认（live 复现）→ **新增决议 E**（screenshot filePath 任意写盘，P1，本决议原稿漏处置且 §2-6 锚被证误导）；②号确认 → D1/D2 修订（network_include_bodies 死参化自相矛盾，P1）；③号**文本截断无法裁决**（what/fix 缺失）。逐条裁决见 §10；受污染锚点已就地标 【r1】。
>
> 🔴 沿用红线：禁项目外新组件；**永不 kill 用户浏览器**；**SSRF 守卫本体（内网段/fake-ip 拦截）不得削弱——file:// 白名单必须是加法且 opt-in，默认行为不变**；上游 chrome-devtools-mcp@1.7.0 只读依赖（本轮无升级诉求）。

## 1. 问题清单与定级

| # | 问题 | 定级 | 本轮裁决 |
|---|---|---|---|
| L-1 | `action=navigate` + `options.screenshot` → worked 但零文件零告警（违「空输出≠空属性」） | P1 | 决议 A：**诚实化 GO / 接线 NO-GO**（§3；复核新证据推翻接线前提） |
| L-2 | ssrfGuard 一刀切拦 `file://`（`ssrf_blocked:protocol_not_allowed:file:`），本地静态文件测试断路 | P1 | 决议 B：`LASSO_ALLOW_FILE_FROM` 目录白名单 **GO**（默认关；§4） |
| L-3 | 无 console 订阅通道（消费方靠 window.onerror 注入绕路） | P2 | 决议 C：console action **暴露面补全 + 参数化 GO**（§5；doConsole v1.11 已实装，缺口是描述零暴露+零参数） |
| D | 白盒扫出的其它死/漏 options | P2 | 决议 D：**ignored_options 泛化 + schema 反向补全 一揽子**（§6；r1 修订 D1/D2——network_include_bodies 移出，见 §10-2） |
| E（r1 新增） | `options.screenshot.filePath` 任意路径写盘（上游 validatePath 被 lasso 本地回退路径绕过，live 双证） | **P1** | 决议 E：`LASSO_SCREENSHOT_DIR` 写根约束 **GO**（默认关；§6-E） |

## 2. 白盒复核注记（设计合成员对输入 findings 的独立验证——含三处修正/新发现）

输入 findings 全部复核确认，另有四处**修正或新发现**（改变裁决方向）：

1. **【新发现·裁决 A 的决定性证据】`action=screenshot` 本身就是「navigate+screenshot 一步走」**。`BrowseChannel.ts:1637` `NAV_FIRST_ACTIONS = new Set(["network", "screenshot", "pdf"])` + `dispatchAction`（:329-339）——单 action 路径对这三个 action **无条件先导航再执行 handler**。即 `browse_headless url=X action=screenshot options.screenshot={filePath,full}` 已经一步完成导航+落盘（消费方 L-1 规避时用的独立 screenshot 工具内部正是这条路径，`tools/screenshot.ts:104` 经 `headless.browse(rawUrl,"screenshot",...)`）。**「接线 doNavigate 消费 options.screenshot」与既有 nav-first 机制重复建路径**——裁决 A 据此转向诚实化。
2. **【修正·L-3 定性】console action 不是缺失，是「实装但零暴露」**。`doConsole`（`cdp-actions.ts:276`，v1.11 round1 T5）调 1.7.0 原生 `list_console_messages` 并结构化解析（`parseConsoleMessageLines`），dispatch Map 已注册（`BrowseChannel.ts:161`）。缺口精确化为：①`descriptions.ts:151-166` action 列表**无 console/network/pdf 行**——CC 消费方不可见（台账「无 console 订阅通道」即此）；②doConsole `_opts` 全忽略——无 level/limit。消费方今天就可以用 `action=console`（schema action 是裸 string），只是没人知道。
3. **【新发现·决议 D 素材】schema 与消费面存在反向缺口（消费但未声明）**：`types.ts` BrowseOptions 有 `pdf_format/pdf_landscape/pdf_print_background/pdf_margin_*`（doPdf 消费）与 `network_filter`（doNetwork 消费），但 `tools/browse.ts:45-114` browseSchema options **均未声明** → MCP 层被 zod strip → 经 MCP 的 `action=pdf`/`action=network` 不可参数化（U-03「schema 缺键致不可达」同族，方向相反）。另 `action=pdf` 在锁定上游 1.7.0 下恒 `upstream_unsupported:pdf`（P10 实锤：1.7.0 无 pdf 工具）。
   【r1 修正（否定发现②号）】原稿此处把 `network_include_bodies` 也写成「doNetwork 消费」——**与代码事实相反**：`cdp-actions.ts:185-187` v1.11 注释明载「network_timeout_ms / network_include_bodies：不再适用（原生工具即时返回）；字段保留（zod 契约稳定），**值被忽略**」，doNetwork 函数体只读 `opts.network_filter`（:198）。该错误已传染 D1 消费表与 D2 键清单（原稿会重建「schema 声明接受→channel 零消费→CONSUMED_OPTIONS 豁免标注」三重死参反模式，即 v1.18.7 删除的那类），D1/D2 已在 r1 同步修正（§10-2）。
4. **【确认·L-2 前提】拦截 100% 在 lasso 侧协议白名单**：`ssrf-guard.ts:90`（`ALLOWED_PROTOCOLS = {http:,https:}`）+ :114-119（DNS 前快败）；入口在 `tools/browse.ts:215/255`（tool 注册层，不在 channel）。上游 chrome-devtools-mcp@1.7.0 navigate_page 直透 Puppeteer 不拦 file://（npx 真机已证：导航+快照+console 全通）。补充核实：**zod `z.string().url()` 接受 file://**（实测 safeParse true）——L-2 无 schema 改动需求；**interact_act(@pN) 路径不经 guard**（`InteractDispatcher.dispatchToBrowse` 直调 `channel.browse`），但 @pN 只能重导航到 root 注册时的原 URL（注册入口已过守卫）——file-guard 放 tool 入口与现有守卫拓扑一致，无新洞。
5. 安全机制实测锚（node 实测，2026-09-09）：WHATWG URL 在**解析期**归一 `%2E%2E` 编码穿越（`file:///Users/x/%2E%2E/../etc/passwd` → pathname `/etc/passwd`）；`file://localhost` 被归一为空 host；`realpathSync("/tmp/../etc/passwd")` → `/private/etc/passwd`（macOS /tmp 符号链接归一——**白名单双侧必须 realpath** 的依据）。
6. 外部模式锚（/tmp/lr）：playwright-mcp `browser_console_messages` 的 `level` 参数语义原文「Each level includes the messages of more severe levels」（severity 阈值而非数组）——决议 C 采同语义；`path-is-inside.js` 的边界匹配（`p === dir || p.startsWith(dir + sep)`）+ win32 才小写化——决议 B 采同匹配；上游 main `McpContext.validatePath`/`--allow-unrestricted-paths` 只管**文件写路径**（filePath），不管 navigate URL——不是 L-2 的杠杆，排除。
   【r1 修正（否定发现①号）】本锚只排除了 validatePath 作为 **L-2（navigate URL）** 的杠杆，**不构成 doScreenshot 写盘的安全保障**——原稿据此产生的「写路径有上游校验兜底」推断是误导：`BrowseChannel.ts:1030-1038`（BUG-03 对抗复审注释）自证上游 1.7.0 因未协商 roots **拒一切 filePath** → 恒走「不带 filePath 重试」→ **实际写者几乎总是 lasso 自己的本地 writeFile**，而它零路径约束（live 双证见 §6-E）→ 决议 E 立项（§10-1）。

## 3. 决议 A（L-1）：诚实化 GO · 接线 NO-GO

**接线（navigate 消费 options.screenshot）NO-GO**，依据：
- 消费价值为零增量：一步形态已存在（§2-1 NAV_FIRST_ACTIONS）；且接线引入新失败语义难题（nav 成功 + screenshot 落盘失败时 outcome 归属——现分类 `screenshot_write_failed→didnt` 会把成功导航谎报为整体失败）。
- 与 v1.18.7 先例（`tools/browse.ts:52-56`：wait_until/screenshot.element/timeout_ms「schema 接受→channel 零消费」即删）同族处置，但本字段**不删**：它在 `action=screenshot` 是活的（E② 双路径消费，`BrowseChannel.ts:1039-1043`）——死的是「navigate 场景下」，属**作用域未标注**而非全链路死字段。

**三层诚实化 GO**：
- **A1 描述作用域**：`descriptions.ts:154-157` screenshot 条目与 :200 options 行标注「options.screenshot **仅 action=screenshot 读取**；navigate 等忽略（一步导航+截图用 `action=screenshot`——它 nav-first）」。extract_mode 的「仅 extract 读」标注先例（:96）推广。
- **A2 运行时 ignored_options 标注**（机制见决议 D）：navigate 传 screenshot → worked + `data.ignored_options:["screenshot"]`。不再静默（「空输出≠空属性」红线兑现），且不改变 worked/preview 语义。
- **A3 schema 注释**：`tools/browse.ts:57-65` E② 注释补作用域（仅 doScreenshot 消费）。

兼容：响应无新必填字段（ignored_options 空省略=byte-identical）；error 形态零变。

## 4. 决议 B（L-2）：`LASSO_ALLOW_FILE_FROM` 目录白名单 GO（默认关 · 加法 · opt-in）

### B1 形态
- **env**：`LASSO_ALLOW_FILE_FROM=/Users/wangdong/Documents/Project/小说:/tmp`——冒号分隔。选型理由：POSIX 路径名禁冒号（NUL 与 `/` 之外唯一禁字符），而路径可含逗号——与 `LASSO_SSRF_ALLOW_RANGES` 用逗号（CIDR 不含逗号）是同一选型逻辑，不可互换。
- **载入**：`SsrfConfig` 增 `fileAllowFrom: string[]`（`loadSsrfConfig` 扩展读 env）。additive 字段对既有 12 个 `ssrfGuard` 调用点惰性（它们不读此字段）。载入时逐条 `realpathSync`：不存在/不可解析的条目**丢弃并记降级清单**（doctor 可见），绝不静默含糊。
- **守卫**：新模块 `src/ssrf/file-guard.ts`，`checkFileUrl(rawUrl, allowDirs): SsrfCheckResult`（同步；无 DNS 面）。七步：
  1. URL 解析失败 → `invalid_url`；
  2. `parsed.host !== ""` → 拒 `file_url_host_not_allowed:<host>`（实测 localhost 被 WHATWG 归一为空 host；非空 host=UNC/SMB 潜在语义，不分平台直接拒）；
  3. `decodeURIComponent(parsed.pathname)` 单次解码（编码穿越已在解析期归一，§2-5 实测；单次与 Chrome 取路径语义一致，禁双重解码）；
  4. `realpathSync` 归一（符号链接+词法穿越一并消解）；ENOENT → 拒 `file_url_not_found`（Chrome 本也会错误页，诚实前置）；
  5. 白名单条目**载入时已 realpath**（macOS `/tmp`→`/private/tmp` 前缀问题由此消解：双侧同规范才可能匹配）；
  6. **path-boundary 子树匹配**（path-is-inside 语义）：`p === dir || p.startsWith(dir + path.sep)`。禁朴素字符串前缀（`/allow` 不得覆盖 `/allowdev`）。realpath 后大小写失配方向=拒（误拒不误放——安全方向，darwin 不做 win32 小写化）；
  7. 全条目不命中 → 拒 `file_not_in_allowlist`。**allowDirs 为空 → 恒拒且 reason 字节等于 `protocol_not_allowed:file:`（现行为）**——测试断言 payload 与旧输出逐字节相等。
- **接线面**：**仅 `tools/browse.ts` 两个入口**（browse_headless:215 / browse_logged_in:255）。入口先判 `new URL(url).protocol === "file:"`：file: → `checkFileUrl`；非 file: → `ssrfGuard` 原样。**ssrfGuard 本体零改动**——`ALLOWED_PROTOCOLS` 恒 {http:,https:}（红线兑现：守卫本体不削弱；file: 白名单是入口旁路加法，默认关零行为变化）。
- **tri-state**：file-guard 全部 reason 走 `ssrfDenial`（均为策略确定性类 → didnt + `ssrf_blocked`；`isSsrfEnvTransientReason` 对它们恒 false——已核）。
- **边界（明确不做）**：screenshot/pdf/network/fetch_url/fetch_feed/wayback/browserbase/steel 独立工具**保持 http(s)-only**（远程采集面；本地文件截图走 `browse_headless action=screenshot`）。fetch_url 开 file:// = 纯文本任意读，**永不由本决议顺带打开**（如需，独立裁决）。

### B2 绕过面逐条封口（裁决依据：白名单必须守住的攻击面）
| 绕过向量 | 封口机制 | 实测锚 |
|---|---|---|
| 编码穿越 `%2E%2E` | WHATWG URL 解析期归一 | §2-5 |
| 词法 `../` | realpathSync 归一 | `/tmp/../etc/passwd`→`/private/etc/passwd` |
| symlink 逃逸 | realpath 解引用 + 双侧规范化 | 同上（/tmp 即 symlink） |
| 前缀伪造（allowdev） | path-boundary 匹配 | path-is-inside 源码语义 |
| host 注入（file://evil.com/x） | 非空 host 拒 | §2-5 |
| 大小写变体 | realpath 后失配=拒（安全方向） | darwin 不小写化 |
| TOCTOU（realpath 与 Chrome 打开之间换文件） | 接受——单用户本地场景，与上游 validatePath 同窗 | 上游先例 |

**威胁模型显式化**：白名单收敛的是「**agent 经 lasso 可读的本地目录面**」——防 prompt-injected agent 借 file://+snapshot/extract 把 `~/.ssh` 等读进模型上下文。目录 opt-in 把该面压缩到用户明示子树。这与 IP/CIDR allowRanges 机制正交（第三维：路径维）。

### B3 错误信息升级 + doctor 感知
- `ssrfBlocked()`（tools/browse.ts:119）对 file: 族 reason 在 payload 增**可选 `hint` 字段**（InteractResult additive 字段——`quality`/`partial_failures` 先例）：白名单空 → `hint: "file:// blocked by default; opt-in: LASSO_ALLOW_FILE_FROM='<colon-separated dirs>' (browse_headless/browse_logged_in only)"`；白名单非空未命中 → hint 指向已配置目录数。**error 字符串本身字节不变**（既有断言零破）。
- doctor：`checkSsrfConfig`（doctor.ts:1180，第 8 检）detail 扩展 `fileFrom=<n>`（n=0 注明「file:// 默认拒」）；被丢弃的不存在条目 → status `warn` + next_step。**不新增 check 项**（doctor 计数断言面不动）。

## 5. 决议 C（L-3）：console 暴露面补全 GO（文档 + 参数化；不新建独立工具）

- **形状**（对齐 `network_*` 前缀惯例 + playwright-mcp severity 语义先例）：
  - `console_level: z.enum(["error","warn","info","debug"]).optional()`——**严重度阈值语义**（pw 原文先例「Each level includes the messages of more severe levels」）：error={error} / warn={error,warn} / info={error,warn,info,log,+其余非 verbose 类型} / debug=全部。缺省=不过滤（兼容现行为）。上游类型映射进代码注释：log/warn/error/debug/info 直传；verbose→debug 档；dir/dirxml/table/trace/clear/group 族/issue→info 档。
  - `console_limit: z.number().int().min(1).max(500).optional()`——过滤后取**最近** N 条（preview 上限 4000 字符；无 limit 时 truncate 会丢尾部=最新消息，limit 让最新保形）。
  - 消费点：`doConsole`（parse 后过滤）——抽纯函数 `filterConsoleMessages(messages, level?, limit?)` 导出可测。preview 维持 JSON 数组形态（现消费方 parse 兼容）。
- **描述补全**（两处 description 的 action 列表，descriptions.ts:151-166）：加 `console`（读**当前页**自最近导航以来的 console 消息；先 navigate——**不进** NAV_FIRST/FRESH_PAGE_NAV，读当前会话是本质语义，消费方流程 navigate→evaluate→console）与 `network`（资源面粗览；完整功能用独立 network 工具）。**不加 `pdf` 行**——锁定上游 1.7.0 无 pdf 工具（P10），描述不宣传必死路径（诚实化）。
- **不新建独立 console MCP 工具**：action 形态接线零成本已通；独立工具=无增量价值的新组件面（network 有独立工具是 v1.11 历史形态，非先例义务）。

## 6. 决议 D：诚实化一揽子

- **D1 ignored_options 泛化机制**（INV-66 `ignored_include_refs` 手法推广）：`BrowseChannel` 增 per-action `CONSUMED_OPTIONS` 表（与 actionDispatch 同源维护，新 action 必须同步登记——INV 锚）。`browseSingle` 出口：实际传入 options 键 −（该 action 消费键 ∪ 入口级消费键）→ `data.ignored_options?: string[]`（空省略=byte-identical）。表内容【r1 修订】：
  `navigate:[no_cache]` / `snapshot:[]` / `screenshot:[screenshot]` / `extract:[extract_mode,include_refs]` / `click,fill:[selectors]` / `wait:[expect]` / `evaluate:[js]` / `pdf:[pdf_* 六键]` / `console:[console_level,console_limit]` / `network:[network_filter]`。
  【r1 修正（否定发现②号）】原稿 `network:[network_filter,network_include_bodies,network_timeout_ms]`——后两键 doNetwork 实际零消费（`cdp-actions.ts:185-187` v1.11 注释「值被忽略」）。CONSUMED_OPTIONS 表的纪律必须是**表项=channel 实际消费键**：把死键列入消费表不只是事实错误，还会让 ignored_options 机制对其豁免——调用方传了也零信号，恰是本机制要消灭的静默面。副作用核过：独立 network 工具内部仍转发这两键（`network.ts:241-244` 旧形态），browseSingle 会因此多算出 `ignored_options`，但 network 工具层自建响应 envelope、不透传该字段（network.ts 只读 `result.data.preview`/outcome/error/served_by）→ MCP 面零暴露。network.ts 死转发清理记**边界**（防范围蔓延，留独立小 commit/裁决）。
  入口级：`steps`（非空走链）；`budget_ms` 仅 steps 路径消费（单 action 路径传入→列入 ignored）。
  旧旗标 `ignored_include_refs` 保留（兼容）；`include_refs` 在非 extract action 传入今后也进 `ignored_options`（超集标注，不冲突）。
- **D2 schema 反向补全**（消费但未声明，§2-3【r1 修正后】）：browseSchema options 增 `pdf_format/pdf_landscape/pdf_print_background/pdf_margin_top|bottom|left|right/network_filter/console_level/console_limit`——全部 `.optional()` 无 `.default()`（防 zod 自动注入破坏 byte-identical 断言；extract_mode 同款纪律，browse.ts:94 注释先例）。`network_timeout_ms` 与 `network_include_bodies` **均不进 schema**（r1 修正：v1.11 起二者同属「字段保留（zod 契约稳定），值被忽略」的死字段——`cdp-actions.ts:185-187`；`src/types.ts:213/215` 保留为进程内契约稳定，但 MCP 面不宣传死参数——与 v1.18.7 删除 wait_until/screenshot.element/timeout_ms 的纪律一致，且本决议 A2 的 ignored_options 机制**只对 schema 已声明的键负责**，未声明键经 MCP 边界即被 zod strip，属标准边界行为，非静默失效）。
- **D3 steps 链边界**：step 内部各自的作用域标注属 StepEngine 域，本轮不动（记边界，防范围蔓延）。

## 6-E. 决议 E（r1 新增·否定发现①号裁决，P1）：screenshot filePath 写根约束 GO（默认关 · 加法 · opt-in）

### E0 问题定性（live 双证）

`options.screenshot.filePath` 全链零路径约束：`BrowseChannel.ts doScreenshot` 中 `target = opts.screenshot?.filePath ?? /tmp/lasso-screenshot-<uuid>.png`（:1039）→ `mkdir(dirname(target),{recursive:true})` best-effort 造父目录（:1067-1071）→ 三条写路径全部直写 target：上游兑现 filePath（路径 1）/ image-block base64 解码（:1126）/ ≥2MB 上游临时文件物化（:1108）。上游 1.7.0 validatePath 因未协商 roots 拒一切 filePath（:1030-1038 注释自证）→ 恒走「不带 filePath 重试」→ **实际写者几乎总是 lasso 自己的 writeFile，上游工作区校验形同虚设**。schema 侧 `tools/browse.ts:63` 仅 `z.string().min(1).optional()` 零路径约束。

**Live 双证（2026-09-09）**：否定发现方 PoC `/tmp/lasso-advA-write-poc/nested/decoy.zshrc`（worked，45418 字节真 PNG）；修订员独立复现 `/tmp/lasso-revision-poc/nested/decoy.zshrc`——`outcome=worked`、真 PNG（1680x1050，magic `8950 4e47`）、**不存在的嵌套父目录被自动创建**、任意扩展名照收（已清理）。暴露面：prompt-injected agent 可让 lasso 覆写任意可写路径（`~/.zshrc` 类）。写面入口收敛核实：仅 browse_headless/browse_logged_in 的 `options.screenshot.filePath`（独立 screenshot 工具只透传 `full`，`screenshot.ts:106`——无此面）。

### E1 形态

- **env `LASSO_SCREENSHOT_DIR`**：冒号分隔写根目录列表，默认空=关（选型逻辑与载入纪律同 §4 B1 `LASSO_ALLOW_FILE_FROM`：逐条 `realpathSync`，不存在条目丢弃+doctor 降级可见）。
- **守卫位置**：`doScreenshot` 顶部——计算 target 之后、**任何上游调用与 mkdir 之前**（三条写路径+mkdir 全部被前置覆盖，含未来协商 roots 后上游兑现的路径 1）。判定：
  1. filePath 缺省 → 管理路径 `/tmp/lasso-screenshot-<uuid>.png`，**行为零变**（默认主路径不动）；
  2. filePath 显式 + env 空 → 拒 `screenshot_path_not_allowed`（didnt；**绝不静默回退随机 /tmp 名**——把错误输入伪装成成功比拒绝更糟，「空输出≠空属性」同族红线）；
  3. filePath 显式 + env 非空 → 双重 containment：`path.resolve` 词法归一后 path-boundary 匹配（§4 B1 第 6 步同语义）**且** 最近存在祖先（父目录可不存在——向上取最近存在者）`realpath` 后边界匹配（消解 symlink 逃逸）；双判皆过 → mkdir 限写根内；任一失配 → 拒 `screenshot_path_not_allowed`（reason 附 hint：已配置写根数 + opt-in 指引）。
- **tri-state**：`screenshot_path_not_allowed` 是策略确定性拒 → didnt（`classifyBrowseError` 增显式分支——不复用 `screenshot_write_failed` 前缀，policy 拒与交付失败对 agent 是不同下一步：前者改参数/配 env，后者重试无益）。
- **hint/doctor**：reason 字符串内嵌 opt-in 指引（同 B3 hint 精神）；doctor `checkSsrfConfig` detail 扩 `shotDir=<n>`（不新增 check 项，同 B3 纪律）。

### E2 绕过面（同 §4 B2 表同封口）

`../` 词法穿越=path.resolve+边界匹配；symlink 逃逸=最近存在祖先 realpath+双侧规范化；前缀伪造（`/allow` vs `/allowdev`）=path-boundary；大小写变体=realpath 后失配即拒（安全方向）；TOCTOU=接受（与上游 validatePath 同窗先例）。

### E3 红线对齐

纯加法、默认关；默认（无 env）唯一行为变化 = 显式 filePath 从「任意路径写盘」**收紧为拒**——这是收窄暴露面，不是削弱守卫（SSRF 守卫本体零涉，`ALLOWED_PROTOCOLS` 不动）；既有依赖默认管理路径的调用方零感知（byte-identical）。

## 7. 测试 / INV / 门禁 / 实施序

- **新增**：`test/unit/file-guard.spec.ts`（矩阵：%2E%2E 穿越/词法穿越/symlink 逃逸 fixture/host 拒/不存在目标/不存在 allowDir 丢弃/`allow` 不匹配 `allowdev`/localhost 归一/空 host/空白名单 payload 与现输出逐字节相等）；`test/unit/screenshot-guard.spec.ts`【r1】（矩阵：无 env+filePath=`~/.zshrc` 类路径→didnt+reason `screenshot_path_not_allowed`/无 env+无 filePath→管理路径 worked 零变（byte 锚）/env 配置+写根内嵌套**不存在**父目录→worked+目录创建/写根外→didnt/`../` 词法出根→didnt/symlink 逃逸 fixture→didnt/写根 `allow` 不吞 `allowdev`/env 载入不存在条目丢弃+降级清单）；`filterConsoleMessages` 单测（severity 四档 × limit 截尾）；ignored_options 单测（fake McpClient 惯例；含【r1】`network` 传 `network_include_bodies`（经 channel 直调注入）→ 进 `ignored_options` 断言）；`loadSsrfConfig` 冒号解析（含 `LASSO_SCREENSHOT_DIR`【r1】）。
- **修改**：doctor `checkSsrfConfig` detail 断言（含 `shotDir=<n>`【r1】）；descriptions 含 console/network 行断言；`browse-tool-steps-schema` 增新键（**不含** `network_include_bodies`——r1 反死参断言：schema 拒收该键）；ssrf-guard.spec **本体用例零改**（守卫零改动的旁证）。
- **INV 新增（实现轮落，INV-90..93）**：INV-90 file-guard 默认关不变量（`ALLOWED_PROTOCOLS` 字面量恒 {http:,https:} + 空白名单 reason 字节锚）；INV-91 CONSUMED_OPTIONS 完备性（actionDispatch 每个 key 有表项**且表项=channel 实际消费键**——`network:[network_filter]` 为锚【r1】）；INV-92 console 暴露面锚（两处 description 含 console 行 + schema 键与 doConsole 消费同 commit）；INV-93 screenshot 写根不变量【r1】（env 空 + 显式 filePath 恒拒 `screenshot_path_not_allowed`；filePath 缺省走管理路径 byte-identical；mkdir 仅写根内）。
- **commit 划分（单主题，不 push 不发版）**：① file-guard + env + 入口接线 + hint + doctor；② ignored_options 泛化 + A1/A3 描述与注释作用域；③ console 参数化 + 描述暴露 + D2 schema 反向补全；④ screenshot 写根守卫 + env + classify 分支 + doctor detail【r1】。每个 commit 自带测试，`npm run gate` 判绿（读 GATE VERDICT 汇总行，不信管道退出码）。
- **真机验证（Chrome 用后按纪律清理）**：`LASSO_ALLOW_FILE_FROM=<临时目录>` 下 `browse_headless navigate file://<fixture.html>` → snapshot/console/action=screenshot 落盘全通；清 env 复验默认拒（字节不变）；【r1】`LASSO_SCREENSHOT_DIR=<临时目录>` 下 filePath 写根内落盘 + 清 env 后 filePath 复验恒拒 + 无 filePath 复验管理路径不变；PoC 残留（/tmp/lasso-*-poc）随清理。fixture 用 `test/fixtures/` 既有惯例。

## 8. 兼容性总表

| 面 | 默认零配置 | opt-in 后 |
|---|---|---|
| file:// | 拒绝 reason/outcome/payload **逐字节同现行为**（唯一新增：file: 拒绝 payload 多一个可选 hint 字段） | 白名单子树内导航可用（仅 browse 两工具） |
| worked 响应 | 无新字段（ignored_options 空省略） | 传了死 options 的调用多得 `ignored_options` 标注 |
| error 字符串 | 不变 | 不变（hint 是并列新字段） |
| schema | 新键全 optional；旧调用方零感知 | console/pdf/network action 可参数化 |
| ssrfGuard 本体 | **零改动**（12 调用点全部无感） | 同 |
| screenshot `options.screenshot.filePath`【r1】 | 默认**收紧**：显式 filePath 从任意路径写盘→拒 `screenshot_path_not_allowed`（didnt+hint；仅依赖默认管理路径的调用方零感知 byte-identical——故意破坏的只有「任意写」这一非契约暴露面） | 写根内正常落盘（嵌套父目录自动创建限写根内） |

## 9. 关联

- 消费方台账与实测报告：`/Users/wangdong/Documents/Project/小说/base/novel-engine/research/lasso-工具问题台账.md`、`timeline-viz-浏览器实测.md`（§四 file:// 受限说明即 L-2 的现场记录）
- 先例：BUG-03 E② 截图双路径（doScreenshot filePath + 上游 validatePath 实锤）——**r1 补注：E② 当日只在上游面实锤 validatePath，未审 lasso 本地回退路径绕过它（§10-1）**；BUG-04 P10 `upstream_unsupported:pdf`；v1.18.7 死参数删除（browse.ts:52-56 注释）；INV-66 `ignored_include_refs`；U-03 schema 缺键不可达
- 外部证据包：/tmp/lr（pwm-console.ts severity 语义；path-is-inside.js 边界匹配；McpContext.ts validatePath 仅管写路径）

## 10. 修订 r1 逐条裁决（2026-09-09 · 设计修订员 · 输入=三路否定发现）

**①号 `options.screenshot.filePath` 任意路径写盘（P1）——确认成立，live 独立复现**
- 源码锚全核属实：target 任意取值（BrowseChannel.ts:1039）/ mkdir recursive（:1067-1071）/ 三写路径直写（:1108 ≥2MB 物化、:1126 image-block 解码、路径 1 上游兑现）/ schema 零约束（browse.ts:63 `z.string().min(1)`）/:1030-1038 注释自证上游拒一切 filePath→本地回退路径是实际写者。
- 独立 live 复现（修订员，/tmp/lasso-revision-poc/nested/decoy.zshrc）：worked + 45418 字节真 PNG + 嵌套父目录自动创建（发现方 PoC 工件已清但代码路径无约束=结构性成立，复现补足行为证）。
- 对原稿的否定成立：§2-6 锚只证 validatePath 与 L-2 无关，原稿未处置「lasso 自己绕过 validatePath」这条面——**本决议原稿无任何条款覆盖 doScreenshot 写路径**（决议 B 管读面 file://，决议 D 管 options 标注，均非写盘约束）。
- 处置：新增**决议 E**（§6-E，`LASSO_SCREENSHOT_DIR` 写根，默认关加法 opt-in，双 realpath containment，拒时不静默回退）；测试/INV-93/commit ④/兼容表行/真机验证项已同步（§7-§8）。误报驳回：无。

**②号 决议 D2+D1 把 network_include_bodies 重新死参化（P1）——确认成立**
- 源码锚全核属实：`cdp-actions.ts:185-187` v1.11 注释「network_timeout_ms / network_include_bodies：不再适用…值被忽略」；doNetwork 体只读 `opts.network_filter`（:198）；独立 network 工具每次调用经 `network.ts:241-244` 转发该键（进程内旧形态）。
- 原稿三重叠加确会重建 v1.18.7 反模式：D2 声明接受（schema）→ channel 零消费 → D1 消费表豁免 ignored_options 标注 = 「声明接受→零消费→零信号」，与决议 A 自己援引的 browse.ts:52-56 先例直接矛盾；病根是 §2-3 复核锚写错（「doNetwork 消费」）。
- 处置：§2-3 就地修正；D1 消费表改 `network:[network_filter]`；D2 键清单移除该键（与 network_timeout_ms 同处置：`src/types.ts:213/215` 保留、MCP 面不宣传）；INV-91 补「表项=实际消费键」纪律；副作用核过（network 工具自建 envelope 不透传 ignored_options→MCP 面零暴露；network.ts 死转发清理记边界）。误报驳回：无。

**③号 dispatchAction/NAV_FIRST/FRESH_PAGE_NAV 相关发现——无法裁决（文本截断）**
- 发现文本在「FRESH_PAGE_NAV_ACTIONS 空白会话（snapshot/extract，:1646+needsFreshPage」处截断，what/severity/fix 全缺——按「空输出≠空属性」纪律不虚构其主张。
- 可核部分：所引锚点真实存在（`dispatchAction` :322-345 中 `NAV_FIRST_ACTIONS.has(action) || this.needsFreshPageNav(c, action, url)` 分支；`NAV_FIRST_ACTIONS = new Set(["network","screenshot","pdf"])` :1637；`FRESH_PAGE_NAV_ACTIONS = new Set(["snapshot","extract"])` :1646）——但锚存在≠主张成立，无主张即无裁决。
- 处置：决议 A/C 涉及的 nav-first/空白会话语义**本轮不动**；请完整重发该发现后独立裁决（不阻塞 ①② 实施）。

## 11. 实施轮定稿（r2，2026-09-09 · 实施员 · 四单主题 commit + 真机验证 11/11）

### 11.1 落地清单（commit 序）

| commit | 内容 | INV | 测试 |
|---|---|---|---|
| ① e17a4dc | 决议 B：`src/ssrf/dir-allowlist.ts`（冒号装载+realpath+dropped）+ `file-guard.ts`（七步判定）+ SsrfConfig.fileAllowFrom + browse 两入口路由 + ssrfBlocked hint + doctor fileFrom/dropped | INV-90 | file-guard.spec 27 用例（含入口端到端真 ssrfGuard 不 mock） |
| ② 529ce55 | 决议 A+D1：CONSUMED_OPTIONS + computeIgnoredOptions + browseSingle worked 出口 ignored_options + A1/A3 描述与 schema 作用域 | INV-91 | ignored-options.spec 11 用例（L-1 回归锚+r1 network 锚） |
| ③ 2639762 | 决议 C+D2：filterConsoleMessages + doConsole 参数化 + descriptions console/network 行 + schema 反向补全 10 键 | INV-92 | console-action.spec 19 + steps-schema D2 5（r1 反死参锚） |
| ④ 18a7138 | 决议 E：screenshot-guard.ts + doScreenshot 守卫（先于上游调用与 mkdir）+ classify 分流 + doctor shotDir | INV-93 | screenshot-guard.spec 13 + e2-dual-path 显式 filePath 用例改设写根 |

- INV 89 → **93**（inv-selftest 违规样本 26 → 30，全数由绿转红）；vitest 2761+1skipped → **2834+1skipped**（+73 用例）。
- 真机验证（决议 §7，真 chrome-devtools-mcp@1.7.0 + 真 headless Chromium 驱动脚本，已清理）：**11/11 GREEN**——A/D1 file:// 默认拒字节锚（error+hint）；B1-B4 白名单内 navigate/extract/console(error 档过滤实机验证：仅 error-line 无 info-line)/screenshot(写根内落盘)；C1 白名单外拒+n 目录 hint；E1-E4 写根矩阵（嵌套新目录创建/写根外拒/清 env 恒拒/无 filePath 管理路径不变）。
- Chrome 纪律核对：驱动脚本的 npx 子进程经 subproc.shutdown() 树杀（pid 已消失）；会话窗口内 /tmp 截图残骸 34 个清理；非本任务的 chrome-devtools-mcp@1.9.0 进程（CC 会话自身基建）**未触碰**（永不 kill 红线）。

### 11.2 实施偏差记录（相对决议字面，均为白盒实证修正）

1. **决议 D1 表项补 no_cache（会导航 action）**：决议字面表 `screenshot:[screenshot]` / `network:[network_filter]` / `snapshot:[]` 等——但 NAV_FIRST 三者无条件先导航、snapshot/extract 空白会话先导导航，**都经 doNavigate 消费 no_cache**。照字面表会把主流路径（如空白会话首 snapshot 传 no_cache）误标 ignored（诱导调用方删有效参数）。方向性裁决：误标比漏标有害——no_cache 记入 navigate/snapshot/screenshot/extract/pdf/network 六表项（INV-91 锚 network:[network_filter, no_cache]）。INV-91 (b) 的死键禁入纪律不受影响。
2. **决议 C 的 console 表项分两 commit**：commit② 建 CONSUMED_OPTIONS 时 console 键尚无参数（表项 `[]`），commit③ 引入 console_level/console_limit 同步补表项——每 commit 表项=当时实际消费键（自洽），终态与决议一致。
3. **决议 D1「pdf_* 六键」实为 7 键**：pdf_format/pdf_landscape/pdf_print_background + pdf_margin_top/bottom/left/right（margin 是 4 键）。CONSUMED_OPTIONS 与 schema 均按 7 键落地。
4. **决议 E1 第 3 步双重 containment 的实装形**：字面「path.resolve 词法匹配 ∧ 最近存在祖先 realpath 匹配」在 macOS 有**误拒 bug**——用户传 `/var/folders/.../wroot/x.png`（/var 是 /private/var symlink），写根装载 realpath 成 `/private/var/...`，词法前缀失配 → 合法嵌套新目录目标被拒（真机前置发现）。实装收敛为 `canonicalizeExistingPrefix`：path.resolve 坍缩 ../（封穿越）→ 从父目录向上走到最近存在祖先取 realpath（封 symlink 逃逸 + 归一 /var 前缀）→ 途经未存在段（纯名字段，path.resolve 后无 `..`；symlink 不可能存在于未存在路径）原样拼回 → 与 realpath 化写根边界匹配。绕过面封口效果与 E2 表逐条等价（单测+真机全过）。

### 11.3 兼容性实测确认（§8 表兑现）

- 默认零配置：file:// 拒绝 payload 与旧输出逐字节相等（唯一新增可选 hint）；无死键 worked 响应无 ignored_options 字段；screenshot 无 filePath 走 /tmp 管理路径不变（真机 E4）。
- 默认唯一行为变化=决议 E 的**故意破坏面**：显式 options.screenshot.filePath 从任意写收紧为拒（非契约暴露面收窄；e2-dual-path 显式 filePath 用例改设写根 env——测试更新即行为变更的显式记录）。

### 11.4 给 novel-engine 的回写答复要点

> 回复对象：`research/lasso-工具问题台账.md`（L-1/L-2/L-3）与 `timeline-viz-浏览器实测.md` §四。lasso v1.22.1 后四个本地 commit（e17a4dc/529ce55/2639762/18a7138，未发版）已全量处置：

1. **L-1（options.screenshot 静默失效）——裁决「不接线、诚实化」**：白盒发现 `action=screenshot` 本身就是「先导航再截图」的一步形态（NAV_FIRST 机制），navigate 接线 screenshot 与其重复建路径。落地三层诚实化：①工具描述明标「options.screenshot 仅 action=screenshot 读取；一步导航+截图就是 action=screenshot」；②navigate 等传入未消费 options 键会在响应 `data.ignored_options` 数组如实列出（不再静默，worked/preview 语义不变）——**消费方升级后可直接依赖该字段自查参数面**；③schema 注释作用域标注。你们的规避法（独立 screenshot 工具/一步 action=screenshot）一直是正确用法。
2. **L-2（file:// 断路）——`LASSO_ALLOW_FILE_FROM` 目录白名单已落地（默认关）**：设 `LASSO_ALLOW_FILE_FROM=/Users/wangdong/Documents/Project/小说` 后 browse_headless/browse_logged_in 可导航/快照/抽取/截图白名单子树内本地文件（真机验证 navigate+extract+console+screenshot 全通）。../穿越/symlink 逃逸/目录前缀伪造封口；拒绝时 error 带 opt-in hint；`lasso doctor` 看 `fileFrom=<n>`。**时间轴可视化器的 T12「结构性验证+用户人工双击」绕路下次可直接真机打开 file:// 验收**。注意 fetch_url 等仍 http(s)-only（file:// 纯文本任意读面永不顺带打开）。
3. **L-3（无 console 通道）——console action 本就实装，本轮补齐暴露+参数**：`browse_headless url=X action=console` 读当前页自上次导航以来的 console（**单发不重导航**——流程 navigate→evaluate→console）；`options.console_level` 按严重度过滤（error⊂warn⊂info⊂debug，档位含更严重档）、`console_limit` 只留最近 N 条。window.onerror 注入绕路可退役；渲染 bug 定位（你们实测的两个 bug 形态）今后 action=console + console_level=error 一步直达。
4. **附带加固（与台账无关，审查轮发现的 P1）**：options.screenshot.filePath 此前可任意路径写盘——现默认拒、`LASSO_SCREENSHOT_DIR` 写根 opt-in。你们「独立 screenshot 工具（只传 full）」的用法零感知。
5. **正面记录已内参**：evaluate 通道的 8 轮注入式测试好评与 navigate+screenshot 组合可用性记录进入决议 §9 关联证据。

