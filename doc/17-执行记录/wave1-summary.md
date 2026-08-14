# Wave1 验证汇总（wave1-summary）

- **汇总范围**：`doc/17-执行记录/` 下 4 份 wave1 记录（browse / desktop / entry-cli / gov-search），lasso v1.7.0，macOS Darwin 21.6.0 / Node v24.12.0 / TUN fake-ip 代理环境。
- **汇总纪律**：只汇总，不改 4 份记录本体。新缺陷编号沿用 browse 面板 W1-DEF-1..7，另为 desktop/gov 面板新发现分配 W1-DEF-8..10（与 D1-D11 已知清单正交）。

---

## 1. 总计（按面板）

| 面板 | 执行条目 | pass | fail | blocked | waived |
|---|---|---|---|---|---|
| browse（无头/登录态/forest/工具面，wave1-browse.md） | 47 | 24 | 20 | 3 | 0 |
| desktop（T-DESKTOP 全组，wave1-desktop.md） | 16 | 14 | 2 | 0 | 0 |
| entry-cli（入口/config/CLI，wave1-entry-cli.md） | 15 | 15 | 0 | 0 | 0 |
| gov-search（搜索/治理/安全，wave1-gov-search.md） | 51 | 47 | 2 | 1 | 1 |
| **合计** | **129** | **100** | **24** | **4** | **1** |

- blocked 4：T-BROWSE-16（无单侧故障注入手段）、T-LI-05 / T-LI-06（W1-DEF-4 传导）、T-SEARCH-15 场景①②（archive.org 对 undici TLS 指纹级 429 反爬，外部上游环境阻断）。
- waived 1：T-STEEL-06 第三态（需 Steel Docker 容器，本机无服务）。

---

## 2. fail 项逐条裁决表（24 条）

裁决口径：**用例判定**列区分「用例错（含笔误/半错）→改用例」与「用例对→产品缺陷」；**处置**列映射到缺陷编号（D1-D11 已知 / W1-DEF-n 新增 / 环境问题）。

### 2.1 browse 面板（20 条）

| ID | 实际 | 用例判定 | 处置 |
|---|---|---|---|
| U-02-3 | markdown 档 `didnt + fallback_exhausted`，error=`fn is not a function`（evaluate_script IIFE 被上游 0.3.0 拒） | 用例对（markdown_engine 是源码意图） | 产品缺陷 **W1-DEF-1**（新） |
| U-02-4 | markdown_cited 同上 | 用例对 | **W1-DEF-1**（新） |
| U-02-5 | screenshot 返 worked + `/tmp/lasso-screenshot-*.png` 路径，但文件不存在（复测 2 次；上游无 filePath 参数被 zod strip） | 用例对（预期文件真实存在） | **W1-DEF-3**（新，路径伪造） |
| T-BROWSE-04 | markdown 档同 U-02-3 | 用例对 | **W1-DEF-1** |
| T-BROWSE-05 | markdown_cited（HN）同上，citations 路径未达 | 用例对 | **W1-DEF-1** |
| T-BROWSE-08 | `wait {text}` → 上游 -32602 `Expected string, received array`（doWait 传数组） | 用例对（预期 worked） | **W1-DEF-2**（新） |
| T-BROWSE-09 | `js:"return ..."` 不可执行；等价改写 `() => navigator.webdriver` 返 **true** | **用例半错**：js 形态未适配上游函数表达式契约（改用例补文档化/包装）；改写后证实 stealth 未生效 → 缺陷成立 | **W1-DEF-1**（stealth 分支）；用例侧同步修 js 形态写法 |
| T-BROWSE-11 | network → `upstream_network_error:fn is not a function`，entries=0 | 用例对 | **W1-DEF-1** |
| T-BROWSE-13 | full_page/region 两版均 worked+路径但文件不存在（region 是否被忽略不可判） | 用例对（预期真实 PNG） | **W1-DEF-3** |
| T-BROWSE-20 | `() => navigator.webdriver` 返 true；日志误报 `stealth_injected` 成功（不检上游 isError） | 用例对（16 路注入佐证） | **W1-DEF-1**（注入静默失效+日志误报） |
| T-BROWSE-24 | 单会话退出后 chrome-devtools-mcp 子进程 +1（ppid=1 孤儿，受控实验） | 用例对（预期无残留） | **W1-DEF-6**（新） |
| T-BROWSE-27 | 404 与 NXDOMAIN 均 worked；NXDOMAIN 后 snapshot 是 Chrome 错误页；unknown_action 分支命中 | 用例对（预期 404/NXDOMAIN→didnt） | **W1-DEF-5**（新）；TUN fake-ip 对 NXDOMAIN 分支环境放大，但 404 分支纯产品缺口 |
| T-BROWSE-29 | network `filter:"3rd-party"` 同 T-BROWSE-11 | 用例对 | **W1-DEF-1** |
| T-TOOLS-09 | 同 T-BROWSE-13 | 用例对 | **W1-DEF-3** |
| T-TOOLS-11 | 同 T-BROWSE-11 | 用例对 | **W1-DEF-1** |
| U-04-1 | `launch-chrome` 返 ok:true+pid，但 Chrome 立即退出；curl 9222 → 404 不通（默认 profile 单例 + Chrome 136+ 禁调试；旧 Chrome pid 4800 占 IPv4 9222） | 用例对（承诺 curl 返版本 JSON） | **W1-DEF-7**（新）+ 环境干扰（pid 4800 占口，归属环境但产品不检测占口本身是缺陷） |
| U-04-4 | cookie export → `cdp_error:-32601 'Network.getAllCookies' wasn't found`（Chrome 150 已移除） | 用例对 | **W1-DEF-4**（新） |
| U-04-5 | import → `cookie_store_not_found`（export 从未产出加密包，主断言不可达） | 用例对（根因传导） | **W1-DEF-4** 传导 |
| T-LI-04 | 同 U-04-4 | 用例对 | **W1-DEF-4** |
| T-LI-11 | JSON 三元组 ✓、detached ✓，但 curl 9222 断言不通 | 用例对 | **W1-DEF-7** |

### 2.2 desktop 面板（2 条）

| ID | 实际 | 用例判定 | 处置 |
|---|---|---|---|
| T-DESKTOP-09 | `screenshot_region:{0,0,800,600}` 仍返 2880×1800 全屏 PNG，裁剪完全未生效 | 用例对（产品 wire 键名漂移：TS `{region}` 包裹 vs Rust 读 `screenshot_region`）；附带用例小笔误：data 无 width/height 字段（channel 层丢弃），尺寸断言改由 PNG IHDR 验证 | 产品缺陷 **W1-DEF-8**（新）；用例侧修 width/height 子断言 |
| T-DESKTOP-18 | `LASSO_RUST_HELPER_PATH=/nonexistent`：调用被拒语义正确，但 spawn ENOENT 只打日志，pending 不 reject、不标 closed → 每次烧满 3s 超时且归因 `rust_call_timeout:*`（承诺的 `rust_helper_crashed` 分类不可达） | 用例意图对，产品错误分类/可观测性缺陷（轻） | **W1-DEF-9**（新） |

### 2.3 gov-search 面板（2 条）

| ID | 实际 | 用例判定 | 处置 |
|---|---|---|---|
| T-RT-06 | `caller_cap_set` 后 6 次真实调用无一被拒，`used` 恒 0；全仓 grep `tryAcquire` 零调用点 | 用例对，产品错（接线缺口：CallerTierTracker 设计意图写明 handler 入口调 tryAcquire，实际未接） | **W1-DEF-10**（新） |
| U-08-3 | browse_headless navigate httpbin 404 → **worked**（classifier 的 `includes("404")→didnt` 分支依赖上游报错文本，上游 navigate 对 404 页正常成功，检测不可达） | 用例对（源码注释/清单承诺与实际不符） | **W1-DEF-5** 同根（navigate 不校验结果，与 T-BROWSE-27 合并处置） |

### 2.4 裁决汇总

- **用例对→产品缺陷：23 条**（唯一例外 T-BROWSE-09 为半错半缺陷：用例 js 形态不适配上游契约需改用例，但 stealth 失效缺陷独立成立）。
- **新缺陷 10 个**：W1-DEF-1..7（browse 面板）+ W1-DEF-8..9（desktop）+ W1-DEF-10（gov-search）；均不在 D1-D11 已知清单内。
- **环境参与但非纯环境**：U-04-1 / T-BROWSE-27（NXDOMAIN 分支）有 TUN fake-ip / 旧 Chrome 占口放大，但产品「不检测子进程退出/不校验导航结果」的核心缺口独立成立，仍判产品缺陷。

---

## 3. 探测 A-D 结论

| 探测 | 结论 | 关键事实 |
|---|---|---|
| **A：zhipu key** | **fail（未设置）** | `~/.lasso/config.json` 不存在，零 key 环境；doctor blockers 含 `zhipu_api_key`；search.zhipu 链内恒 unknown `ZHIPU_API_KEY missing`（文件 key 机制本身验证 pass，U-07-4/5）。智谱通道本机不可用 |
| **A：machine MCP** | **pass** | doctor #36 `machine_search_mcp` 检测到机器 web-search-prime MCP（host=open.bigmodel.cn，Authorization 已配置，fallback_chain 首选 search.machine_mcp），无 url/auth 泄漏。注意：machine_mcp 仅 engine=fallback_chain 路径注入（engine=auto 不含），且 L1 free_only 过滤在其注入之前早返回（U-08-7 括注与源码注释自相矛盾） |
| **B：headless** | **PASS** | 首次 `browse_headless navigate example.com` 成功（outcome=worked，final_url 正确）；npx 冷启动 chrome-devtools-mcp@0.3.0 约 11-13s。上游契约实测锚点：take_screenshot 无 filePath、wait_for.text 要 string、evaluate_script 要函数表达式、无 pdf 工具 |
| **C：TCC** | **PASS（双授权）** | Accessibility pass + Screen Recording pass（无系统弹窗）；rust helper ping pass（v0.1.0，x86_64，完全未签名）；helper JSON-lines 协议手测（坏 JSON/未知方法/空行）全过。tcc_denied 分支本机已授权不可测（n/a 不扣分）。另：doctor #15 把「完全未签名」误报为「可能未构建」warn（正则未覆盖 "code object is not signed at all"，观察项） |
| **D：9222** | **PARTIAL-FAIL** | `launch-chrome` 默认版返 ok:true 但 Chrome 立即退出、9222 curl 404 不通（默认 profile 无 --user-data-dir：Chrome 136+ 禁调试 + 单例转发；且用户旧 Chrome pid 4800 占住 IPv4 9222）。绕开：`--profile <隔离目录>` 可用——遗留 Chrome pid 29428（[::1]:9222）与 pid 31973（127.0.0.1:9223，登录态用例通道 LASSO_CDP_PORT=9223）。U-04/T-LI 组未整组 blocked，按 9223 实际执行判定 |

---

## 4. 修复清单建议（v1.8 范围）

### 4.1 新缺陷（wave1 实锤，全部「用例对→产品缺陷」）

| 编号 | 缺陷 | 修复要点（源码锚点） | 涉及 fail |
|---|---|---|---|
| **W1-DEF-1** | evaluate_script 全部以 IIFE 语句串调用，上游 0.3.0 需函数表达式 → markdown/markdown_cited 抽取、network、stealth 16 路注入全部静默失效；StealthEngine 不检 isError 日志误报成功 | BrowseChannel.ts:646/:460、StealthEngine.ts:172、network 注入点统一改传函数表达式；StealthEngine 校验上游 isError 后再记 `stealth_injected` | 9 条 |
| **W1-DEF-2** | doWait 传 `{text:[...]}` 数组，上游要 string → wait 恒失败 | BrowseChannel.ts:722 改传 string | 1 条 |
| **W1-DEF-3** | doScreenshot 传 filePath 被上游 zod strip → PNG 永不落盘但返 worked+伪造路径 | BrowseChannel.ts:619-626：上游返回 base64 后自行落盘，或移除 path 字段并校验落盘 | 3 条 |
| **W1-DEF-4** | CdpClient 用 `Network.getAllCookies`（Chrome 150 已移除）→ cookie export 恒 -32601 | CdpClient.ts:131 改 `Storage.getCookies`；修复后连带解锁 T-LI-05/06 两个 blocked | 3 条 |
| **W1-DEF-5** | navigate 不等待加载完成也不校验导航错误：404/NXDOMAIN/慢页均 worked；classifier `includes("404")` 分支因上游 navigate 对 404 正常成功而不可达；navigate+snapshot 竞态取上一页 | BrowseChannel.ts:795-805：navigate 后校验 HTTP 状态/加载态（或改用返回 final_url+title 判定），snapshot 前等待稳定 | 2 条（T-BROWSE-27、U-08-3）+多处观察 |
| **W1-DEF-6** | lasso 退出不清理 chrome-devtools-mcp 子进程 → 孤儿泄漏（ppid=1，受控 +1 实证；并行面板存量 15+） | 退出钩子（SIGTERM/SIGINT/exit）kill 子进程树 | 1 条 |
| **W1-DEF-7** | launch-chrome 默认不带 `--user-data-dir`：Chrome 136+ 默认 profile 禁调试 + 单例退出 → 9222 永不可用；且不检测子进程退出/端口被占即返 ok:true | 默认注入隔离 user-data-dir；启动后探活 `/json/version` 再返 ok | 2 条 |
| **W1-DEF-8** | desktop screenshot 裁剪参数全链路失效（wire 键名漂移） | ScreenshotVlmProvider.ts:92 传 `{region}` vs screenshot.rs:77 读 `screenshot_region`，二选一对齐（建议 Rust 兼容读 `region`）；顺手把 width/height 透出到 data | 1 条 |
| **W1-DEF-9** | rust helper spawn ENOENT 只打日志：pending 不 reject、不标 closed → 烧满 3s 超时且归因 timeout（`rust_helper_crashed` 分类不可达） | SubprocessManager `proc.on("error")` 接入 pending reject + closed 标记（RustBridge.ts:27 承诺的 crash 检测补齐） | 1 条 |
| **W1-DEF-10** | caller-tier 配额完全未接线：`tryAcquire` 全仓零调用点，cap_set/list 空转，6 次调用无一被拒 | search.ts / browse.ts handler 入口调 CallerTierTracker.tryAcquire（CallerTierTracker.ts:26 自证设计意图） | 1 条 |

### 4.2 D1-D11 已确认项（wave1 采证去重后进入 v1.8）

| 编号 | 内容 | wave1 证据 | 处置建议 |
|---|---|---|---|
| **D1** | read_text 缺席 + 6 处 description 指向 | T-TOOLS-13（fetch_url×1 / screenshot×2 / pdf×2 / network×1 精确命中）+ T-TOOLS-08 continue_hint 再采集 | **修**：实现 read_text 或改写 6 处 description + continue_hint |
| **D11** | `--stealth-check` 被 main() 完全忽略 | T-CLI-05（flag 对输出零影响，#38 两模式恒 warn-skip） | **修**：解析 flag 注入 doctorOpts，或删 README 承诺 |
| **D8** | appleScriptAction 被 zod strip 后落 `missing_applescript_action` | T-DESKTOP-20（预期缺陷行为命中，采证固化） | **修**：schema 补 appleScriptAction 或文档化不可达 |
| **D4** | ax_act not_implemented（Phase A observe-only 占位） | T-DESKTOP-04（D4 锚点逐字命中） | 维持占位，Phase B 实现时消除；不阻塞 v1.8 |
| **D7** | 无 breaker_reset admin action | T-FALL-03（enum 无此值，zod 即拒；维持） | 按需决定是否补 action；非缺陷级 |
| **D10** | SSRF 放行 127.0.0.1:9222（设计行为） | T-SSRF-01 / U-08-2（放行到达 HTTP 层） | 设计行为，维持；文档化即可 |
| D2/D3/D5/D6/D9 | wave1 未见直接采证（D3 仅 vlm_endpoint warn 语境旁证） | — | 不进 v1.8 范围，待后续波次 |

### 4.3 测试基建与 CLI 惯例（两个已知项，任务指定纳入）

1. **测试基建 flaky timeout**：纳入 v1.8 测试修复（已知 flaky 项，wave1 未复现于本仓用例但按已知清单纳入治理）。
2. **`--version` / `--help` 缺失**（F-CLI-01 实证）：argv 白名单外一切参数静默落入 MCP server 模式，stdout 0 字节、终端挂起等 stdin——补 `--version` 输出版本号与 `--help`/未知子命令输出 usage（index.ts:1074-1098 白名单处）。

### 4.4 用例侧修订（不改产品，清单再版时同步）

- T-BROWSE-02 title 断言（上游快照首行格式过时）；T-BROWSE-07 空 selectors 表述；T-BROWSE-09/T-BROWSE-23 退避序列首档（2/4/8/16s）；T-DESKTOP-06 `key:36` number 子项（zod 先拒，INV-28 经 MCP 不可达）；T-DESKTOP-09 width/height 子断言；T-CLI-01 CLI desktop 六项「warn-skip」改「缺席」；T-ENTRY-04 kill 条件表述（disable desktop channel 且四档全 down）；U-08-7 machine_mcp/L1 括注与源码相反；T-FOREST-02 未知前缀在 zod 层被拒。

### 4.5 解锁项（修复后回归）

- W1-DEF-4 修复 → 解锁 T-LI-05 / T-LI-06（import 主路径 + 加密包三断言）。
- W1-DEF-5 / W1-DEF-7 修复 → T-BROWSE-16（单侧故障注入）具备构造手段后回归。
- T-SEARCH-15 场景①②：换出口 IP 或 archive.org 解除 undici 拦截后回归。

### 4.6 遗留运行物（复测用，勿清）

- Chrome pid **29428**（[::1]:9222，/tmp/lasso-chrome-test-profile）、pid **31973**（127.0.0.1:9223，/tmp/lasso-chrome-profile-9223）。
- 本地 8765 端口 python http server（/tmp/lasso-2fa-test.html）。
- chrome-devtools-mcp 孤儿进程 15+1 个（W1-DEF-6 证据，未清理）。
