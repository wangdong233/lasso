# 28 · 静默守则审计 fix-2 —— 03 审查记录（review-03.md）

- **日期**：2026-08-19
- **审查对象**：本轮（fix-2）改动——D-5 修复（chrome-stop.ts 同步版 modes + index.ts exit 钩子）/ C2 实现（chrome-idle-reaper.ts + config.ts + index.ts）/ INV-82 + selftest 3 样本 / 版本三真源 1.18.0 / 文档（README、KEY-GUIDE、ARCHITECTURE）/ 测试（d5 spec 6 例、chrome-autohide spec 14 例、p1 spec 锚更新 + 台账隔离修复、doctor 版本断言更新）。
- **审查标准**：`/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md` §1 六维（1.1-1.6）+ §1.7 + §0.3 证据阶梯。
- **范围声明**：工作树另有**并行轮次**未提交改动（G2 描述 runbook `descriptions.ts`、P6 `recoverNoPageSelected` `LoggedInChannel.ts`/`BrowseChannel.ts` + `browse-upstream-contract.spec.ts`），非本轮产物，不在本审查范围（见 F-3）。
- **门禁（终跑，两连跑一致）**：`npm run build` ✅ / `npm test` **139 文件 2292 passed + 1 skipped**（基线 2267+1 不减，+20 为本轮两新 spec，另见 F-2 波动说明）/ `npm run check-invariants` **82/82**（基线 81 + INV-82）/ `npm run inv-selftest` **23/23 样本注入即红**（+3 为 INV-82）。

## 1.1 代码规范

- ✅ 命名与既有范式一致：`modes` 选项与 async 版同名同语义（chrome-stop.ts `ChromeStopSyncOptions` vs `ChromeStopOptions`）；C2 命名沿 `autoHideAfterLogin` 全链一致（config 字段 / env 名 / reaper 选项 / 日志事件 `chrome_auto_hidden_after_login`）。
- ✅ 注释解释 WHY：每处新代码标注裁决来源（D-5/P1/C2/doc 编号 + 失效方向说明），无 WHAT 复述。
- ✅ 测试名读作领域行为（「护栏①：从未见墙（一直普通页）→ 永不 hide」），无纯技术名。

## 1.2 数据逻辑（含 producer 契约）

- ✅ **CDP /json 契约（L1+L3）**：`defaultTabUrlsFn` 假设响应为 `Array<{url: string,...}>`——producer 是 Chrome DevTools HTTP 端点。本轮真机实测（9231）`curl /json` 返回 page 条目含 `url` 字段（L2/L3 证据，review 实跑记录）；解析形状防御到位：非数组 → `[]`、元素非对象/url 非 string → 跳过（`defaultTabUrlsFn` 逐条 typeof 守卫）。字段缺失语义 = 无 URL 可判 → 视为非登录墙（保守方向：倾向不 hide）✅。
- ✅ **台账 schema（L1）**：C2 零 schema 变更（复用 `launchMode`/`idleMs` 既有可选字段；进程内三 Map 不落盘）——无迁移故事需求。exit 钩子 modes 过滤对 v1.9 老条目（无 launchMode）按 `?? "hidden"` 归档（d5 spec 用例 3 锚定）。
- ✅ **env/file 布尔契约**：`loadConfigFileEnv` 把 JSON boolean 规范化为 "true"/"false" 字符串（config.ts:270-273，L1）——`parseAutoHideAfterLogin` 只收字符串输入，契约闭合；非法值（"bogus"/""）显式落 false（14 例 config 用例覆盖）。
- ✅ **错误路径显式**：C2 两条失败路径都有结构化日志（`chrome_auto_hide_probe_error` / `chrome_auto_hide_failed`）+ 明确降级语义（重置延迟窗 / 永久降级），无静默吞；exit 钩子 catch 空——沿既有「exit 钩子绝不能抛」注释锚（index.ts:1359-1361）。
- ✅ **宿主执行环境契约（1.2 项 8）**：osascript System Events 需 Accessibility TCC——hide 失败路径（`osascript_exit_1743` 等）在 C2 设计内即降级不重试；本轮真机 TCC 可用（实跑 visible:false 读取成功），未验的「无 TCC 机器」路径有单测覆盖（chrome-autohide 用例 7）。

## 1.3 业务逻辑（状态机与并发）

- ✅ **状态机边界枚举**（chrome-autohide.spec 全 14 例即枚举表）：从未见墙 / 见墙中 / 墙刚消失（起表）/ 窗内再进墙（重置）/ 窗过但 agent 活跃 / 全过 → hide / hide 失败（终态 failed）/ 已 hide（终态 done）。两个终态都有幂等门（`autoHideDone.has` 先置检查）。
- ✅ **1.3 项 1a 守护线程三问**（C2 复用既有 reaper 调度器，不新增 timer）：
  - 重复触发：同一 port 重复 hide 由 `autoHideDone` 原子闸门保证幂等（单线程 JS 内 Set 检查-置位无竞态窗口）；reaper 自身有 `ticking` 防叠 tick 门（既有）。
  - 并发写：`touchMap` 维持「LoggedInChannel 写 / reaper 读」单写多读形态不变（R-INT-07 合规）；C2 新增三 Map 均 reaper 单写单读。
  - 闭环：hide 不改 `launchMode` → visible 记录每 tick 仍进 considerAutoHide 但被 `autoHideDone` 短路——无「A 重建 B 消费」环。
- ✅ 业务规则不散布：登录墙判据单点（`LOGIN_WALL_URL_RE` 顶级导出）；延迟默认单点（`AUTO_HIDE_AFTER_LOGIN_DELAY_MS` reaper 导出、config import——INV-82(f) 钉死）。

## 1.4 端到端接通（值级 trace + L3 真机）

- ✅ **D-5 值级 trace（L3 真机，无插桩生产路径）**：launch visible 9230（pid 41930，台账 launchMode:"visible"）→ 起 server（隔离台账 env）→ stdin EOF 4s → `lasso_shutdown sig:stdin_eof` → server exit 0 → **复测：pid 41930 存活 + visible:true + 台账条目保留 + 全日志零 chrome_stop 事件**。对照修复前（verify §6 三次复现）：同流程 pid 在 ~724ms 内被 `chrome-stop-exit` SIGKILL。行为差异即修复证明。
- ✅ **C2 值级 trace（L3 真机）**：launch visible 9231 AT github.com/login（pid 42835）→ server `LASSO_AUTO_HIDE_AFTER_LOGIN=1 DELAY_MS=3000` → 20s 后 `/json` 实见 login URL tab → PUT `/json/new` + `/json/close/<id>`（模拟登录完成离开墙）→ tick 见墙消失起表 → 过 3s 窗 + agent 安静 → **日志 `chrome_auto_hidden_after_login port:9231 pid:42835` + 实测 visible:false + 进程 ALIVE + CDP 200 + 台账 launchMode 仍 "visible"** → `chrome-show` 恢复 visible:true → `chrome-stop` 定向清零。
- ✅ **护栏①野外实证**：同台账内的 9230（visible、从未见登录墙）在全程 **未被 hide**——「从未见墙 → 不动」在真机多实例场景下成立。
- ✅ **文档面清点（1.4 项 7）**：README（守则句 + 登录节 + 折叠区 env + changelog）/ KEY-GUIDE §B（重写）/ ARCHITECTURE（§3.6 + §5.11 + §11 + §14）/ 本目录三文档（fix-2/decisions/review-03）——受影响面全覆盖；TROUBLESHOOTING 无新 error_kind（C2 失败走手动出口，已有 chrome-hide 条目），not-affected。

## 1.5 性能 + 生产就绪

- ✅ **feature flag（1.5 项 5a）**：`LASSO_AUTO_HIDE_AFTER_LOGIN` 默认 **off**（INV-82(b) 钉死 CONFIG_TEMPLATE false + 仅显式真值解析）——默认行为零变化。
- ✅ **rollback（5b）**：双出口——关 env 即回旧行为；单次误收 `chrome-show` 一条命令可逆（登录态无损）。
- ✅ **可观测（5c）**：`chrome_auto_hide_after_login_enabled` / `chrome_auto_hidden_after_login` / `chrome_auto_hide_probe_error` / `chrome_auto_hide_failed` 四结构化事件（stderr→MCP 日志，util/logger 路径）。
- ✅ **Heisenbug 纪律（1.5 项 2）**：D-5 本质是时序敏感（exit 钩子 vs 优雅路径竞速）——本轮验证在**无插桩**真实进程上完成（生产 dist、真实 stdin EOF、真实 osascript），非注入 delay 复现。
- ✅ 开销量销：C2 开启时每 tick 每 visible 记录 1 次 localhost HTTP GET（1s 超时）+ 命中 hide 时 1 次 osascript（~2s spawnSync，一次性）——量级与既有 reaper 读台账同阶；默认 off 时零开销（分支不进）。

## 1.6 简单架构

- ✅ **代码健康**：exit 钩子与优雅停机现在**同款裁决同款参数形态**（`modes:["hidden"]`）——修复了 P1 只修一半的认知缠绕；同步版补齐注入面与 async 版对称（测试债偿还）。
- ✅ **零第二套**：C2 复用 reaper 调度器（audit R-INT 范式：「第二消费者，不是第二套调度」）；hide 原语复用 chrome-hide.ts（INV-82(e)）；延迟常量单点（INV-82(f)）。
- ✅ **过工程化检查**：C2 状态机三 Map + 四护栏是裁决条件的最小机械化，未加「未来可能要」的参数（如自定义词表 env、per-port 覆盖——皆未做，decisions.md §6 记录了不做的边界）。
- 🟡 `ChromeIdleReaperOptions` 参数增至 10 个（>3）——既有 options-object 注入范式的延续（同文件原 7 个），未拆分是**有意的**（拆分反而造第二抽象）；一般读者可一遍说出唯一一件事（「按台账调度 idle 收割与登录后转静默」）。

## 1.7 冗余与废弃

- ✅ 无死代码引入；旧签名 `stopLaunchedChromesSync(logFn)` 唯一调用点同步更新，无兼容残骸。
- ✅ 文档计数同步：ARCHITECTURE §11「81 条」→82、§14 门禁数字、README changelog v1.18.0——无 stale 引用残留（grep 1.17.3 仅存于历史注释/测试背景描述，属合法历史记载）。

## 发现清单

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| F-1 | 🟡 | **测试污染真实台账**（1.7/1.2 交叉）：`p1-visible-chrome-lifecycle.spec.ts` P3 的 launchChrome 注入测试无 `LASSO_LAUNCHED_CHROMES_PATH` 隔离——全量套每跑一次就向真实 `~/.cache/lasso/launched-chromes.json` 落一条陈旧 entry（本轮实测 pid 42 条目；生产 exit 钩子会以 already_dead 惰性清理，但污染用户状态 + 干扰并行工作流判读） | ✅ **本轮已修**：spec 加 beforeEach/afterEach 台账隔离（tmpdir + env 覆盖），复跑 6/6 绿 + 真实台账保持 `[]` |
| F-2 | 🔵 | 全量测例总数存在 ±5 环境态波动（`vitest list` 声明 2300；实跑 2288-2293 间波动，timing-sensitive project 条件用例所致，**先于本轮存在**） | 记录不阻断；门禁以两连跑一致结果（2292+1）为准；后续可作独立测试债清理 |
| F-3 | 🔵 | 工作树含**并行轮次**未提交改动（G2 descriptions runbook / P6 recoverNoPageSelected 及其 spec）——与本轮改动无文件冲突、门禁同树通过 | 提交编排归工作流所有者：建议本轮（v1.18.0）与 P6（其注释预期 v1.18.1）分 commit，P6 的 03 审查归其轮次 |

## 结论

六维零 🔴 阻断、零未处置 🟡；两项行为变化（D-5 豁免 / C2 opt-in）均有 L3 真机证据 + INV 钉死 + mutation 红验证。**通过（ship）**。
