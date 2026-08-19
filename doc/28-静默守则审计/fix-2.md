# 28 · 静默守则审计 —— 第二轮修复实施记录（fix-2.md）

- **日期**：2026-08-19
- **输入**：`verify.md`（真机矩阵 + D-5 新发现）+ `audit.md` §4 分级 + 用户授权（GO 项实施 / DECISION 写决策文档 / NO-GO 记理由）
- **裁决台账**：见同目录 `decisions.md`（C2 裁 GO 的理由与边界 / C1、C3 决策文档 / C4、N1-N4 理由）
- **版本**：1.17.3 → **1.18.0**（有行为修复：D-5；有新能力：C2 opt-in）
- **03 审查**：见同目录 `review-03.md`（§1 六维全过）

## 1. D-5 · server 退出钩子杀 visible Chrome（缺陷修复，最高优先）

**现象**（verify §6，三次独立复现 + 服务端日志 `name:"chrome-stop-exit"` 归属实锤）：任意 MCP server 会话结束（stdin EOF / client close → exit 钩子），台账在案的 visible Chrome 被整树 SIGKILL——P1 v1.17.3 的 visible 豁免只修了优雅 shutdown 路径，exit 钩子路径漏同步。

**修复**：

| 文件 | 改动 |
|---|---|
| `src/launcher/chrome-stop.ts` | `stopLaunchedChromesSync` 签名 `logFn?` → `ChromeStopSyncOptions`（`modes` 过滤 + `aliveFn/psFn/killTreeFn/logFn` 可注入——同步版补齐 async 版的测试注入面）；过滤逻辑与 async 版同款（`opts.modes.includes(r.launchMode ?? "hidden")`）。源码顺序锚保留：`verifyOwnership` 守卫仍先于 `killTreeSync`（chrome-ledger.spec.ts 既有断言不破） |
| `src/index.ts` exit 钩子 | `stopLaunchedChromesSync({ modes: ["hidden"], logFn })`——visible 档豁免；台账条目**保留**（进程还活着，清账 = 孤儿化 chrome-stop 出口） |
| CLI 语义 | `chrome-stop` CLI 显式操作**不过滤**（用户主动 = 最高权限），缺省 modes 行为不变 |

**测试**：新 `test/unit/d5-exit-hook-visible-survival.spec.ts` 6 用例——①modes 过滤行为（visible 不杀 + 条目保留 / hidden 照杀照清）②缺省不过滤（CLI 语义回归锚）③v1.9 老台账（无 launchMode 字段）按 hidden 计仍收尾④pid 复用红线在 modes 命中时仍绝不 kill⑤index.ts 装配源码锚（防回潮）⑥同步版过滤 regex + 零 await 纪律锚。

**修后行为**：visible 登录窗口的存活期 ≠ server 会话存活期——CC 重启 / 会话结束不再杀窗口；关闭出口唯一 = 显式 `chrome-stop`（N4 全路径成立：优雅 shutdown + exit 钩子 + idle reaper 三口全豁免 visible）。

## 2. C2 · 登录完成自动 hide（opt-in，默认 off）

**裁决**：GO（理由与边界见 decisions.md §1——依赖解耦 + 失效方向安全 + 用户授权四条防误判全机械化）。

### 2.1 实现（挂在既有 chrome-idle-reaper 调度器上，零第二套 timer）

| 文件 | 改动 |
|---|---|
| `src/launcher/chrome-idle-reaper.ts` | ① `LOGIN_WALL_URL_RE`：URL 级登录墙判据（词边界正则；假阴性 = 不收，失效方向安全）；② `defaultTabUrlsFn`：CDP `/json` tab URL 读取（1s 超时，127.0.0.1）；③ `considerAutoHide` 状态机（`loginWallSeen` / `wallClearSince` / `autoHideDone` 进程内三 Map）；④ visible 分支扩展：`if (autoHideAfterLogin) await considerAutoHide(...)` 后仍 `continue`（kill 豁免语义不变——P1 测试锚同步改块体形态）；⑤ 启动门：`defaultIdleMs ≤ 0 && !autoHide` 才返 null（idle 禁用 + autoHide 开启时 reaper 仍跑）；⑥ hide 原语 = `chrome-hide.ts hideChromeByPid`（PID 定向，import 契约；INV-78c「reaper 零 kill 原语」在扩展后仍成立） |
| `src/config/config.ts` | `LASSO_AUTO_HIDE_AFTER_LOGIN`（默认 false，仅 1/true/yes/on 显式真值开启）+ `LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS`（默认 10s，单一真源 = reaper 导出常量 `AUTO_HIDE_AFTER_LOGIN_DELAY_MS`，config 从 reaper import）；CONFIG_TEMPLATE 补两键 |
| `src/index.ts` | 装配：`config.launchIdleMs > 0 \|\| config.autoHideAfterLogin` 启 reaper（INV-78b 的 `config.launchIdleMs > 0` token 保留）；开启时打 `chrome_auto_hide_after_login_enabled` 日志 |

### 2.2 四重护栏（任一不满足 → 本 tick 不 hide）

1. **见墙前提**：`loginWallSeen.has(port)`——从未观测到登录墙 URL 的 Chrome 永不收（用户可能只是开着看）；
2. **延迟窗**：墙消失后 `wallClearSince` 起表，须 ≥ `autoHideDelayMs`（默认 10s）；窗内再见墙**重新计时**（多步登录）；
3. **agent 安静度**：`now - max(launchedAt, touchMap)` ≥ delayMs——browse 近期打点过就等（in-flight 粗近似；touchMap 与 idle 收割共用活动源，单写多读形态不破）；
4. **失败降级**：CDP 探测 throw → 重置延迟窗不收（`chrome_auto_hide_probe_error`）；hide 失败（TCC 缺失等）→ 本进程永久降级不重试（`chrome_auto_hide_failed`），手动出口不受影响。

结构性红线：只迭代**台账记录**（永不按进程名找 Chrome）+ hide 按 **PID** 定向 + 台账 `launchMode` 保持 `"visible"`（后续 tick 继续 kill 豁免）+ `chrome-show` 可逆。

### 2.3 测试

新 `test/unit/chrome-autohide.spec.ts` **14 用例**（全注入零真机）：URL 判据正反例（/login ✓ /log-in ✓ /authorizations ✗ /login-tips ✗）/ 默认 off 零调用 / 全护栏通过后 hide 一次且 stopFn 永不收 visible / 护栏①③④各自拦截 / 护栏②窗内重进墙重计时 / hide 失败永久降级 / hidden 记录不受影响 / idle 全局禁用 + autoHide 仍跑 / 延迟窗常量单一真源 / config 解析（默认 off、显式真值、非法 delay 回退）+ CONFIG_TEMPLATE 两键。

既有 `p1-visible-chrome-lifecycle.spec.ts` visible-continue 断言更新为块体形态（语义不变：continue 仍先于任何 kill 路径）。

## 3. INV-82 · 用户运行守则生命周期红线（新不变量，81 → 82）

`src/invariants/check-invariants.mjs` 新增 INV-82，六组断言：(a) exit 钩子 `modes:["hidden"]` + 同步版过滤同款 + 零 await；(b) C2 默认 off（CONFIG_TEMPLATE + 仅显式真值解析）；(c) autoHide 只挂 visible 分支且在 continue 前（永不进 kill 路径）；(d) 四重护栏存在性（见墙前置 return / wallClearSince + delay 门 / touchMap lastUse / probe_error + failed 永久降级）；(e) hide 走 chrome-hide PID 原语 + reaper 仍零 kill 原语；(f) 延迟窗默认单一真源（reaper 导出、config 引用）。

`scripts/inv-selftest.mjs` 注册 3 个违规样本（纪律：新增 INV 必须红过一次）：exit 钩子丢 modes（D-5 回潮形态）/ 默认翻 on（opt-in 破坏）/ 护栏①拆除——三样本注入后 INV-82 均由绿转红（`npm run inv-selftest` 23/23）。

## 4. 守则入文档

| 文档 | 改动 |
|---|---|
| `README.md` | ① 「隐私与安全」开篇新增**运行守则**一句（用户语言：「能后台静默干的就静默干……你处理完它自动转回后台静默，不需要你记着收尾」）；② §二登录三步后补自动收窗 opt-in 段 + D-5 修复说明（「窗口不再被 Claude 会话重启杀掉」）；③ 细节折叠区补两 env 键说明；④ 更新日志新增 v1.18.0 条目 |
| `doc/KEY-GUIDE.md` §B | 登录流转段按守则重写：守则引用块 + **姿势一（手动三步，永远可用）** / **姿势二（自动两步，opt-in）** 对照，含四关描述、保守失效方向、server 进程边界、D-5 修复说明 |
| `ARCHITECTURE.md` | ① §5 设计原则新增第 11 条「用户运行守则」（S1/S2/S3 三子句可判定拆解）；② §3.6 新增 v1.18 生命周期条目（D-5 + C2）；③ §11 不变量 81→82 + INV-82 行；④ §14 当前版本 1.18.0 + 门禁数字刷新 |

（多语言 README.*.md 未同步翻译——沿 G1 先例：chrome-hide 面此前即未进翻译面，翻译滞后不阻塞门禁。）

## 5. 版本与真源

- 1.18.0 三真源同步：`package.json` / `src/index.ts:LASSO_SERVER_VERSION` / `src/doctor/doctor.ts:LASSO_VERSION`（INV-63 约束；inv-selftest 的 INV-63 样本锚点 `__PKG_VERSION__` 动态取 package.json，bump 不失效）。

## 6. 门禁（终跑，两连跑一致；详见 review-03.md 头部）

- `npm run build` ✅
- `npm test`：**139 文件 2292 passed + 1 skipped**（基线 2267+1 不减；+20 为本轮两新 spec，另有 doctor 版本断言三文件随 bump 更新、p1 spec 锚形更新 + 台账隔离修复）✅
- `npm run check-invariants`：**82/82**（基线 81 + INV-82；不减）✅
- `npm run inv-selftest`：**23/23 样本全红验证**（+3 为 INV-82）✅

## 7. 真机验证（L3，自有端口 9230/9231 + 隔离台账/profile；9226/dedao 零触碰）

- **D-5**：launch visible 9230（pid 41930）→ 起 server → stdin EOF → server exit 0 后复测：**pid 存活 + visible:true + 台账条目保留 + 零 chrome_stop 事件**（修复前同流程 ~724ms 内被 SIGKILL——verify §6 三次复现对照）。
- **C2 全链**：launch visible 9231 AT github.com/login（pid 42835）→ server `LASSO_AUTO_HIDE_AFTER_LOGIN=1 DELAY_MS=3000` → CDP `/json` 实见 login tab → 模拟登录完成（开非登录 tab + 关 login tab）→ 日志 `chrome_auto_hidden_after_login port:9231 pid:42835` + **实测 visible:false + 进程活 + CDP 200 + 台账 launchMode 仍 "visible"** → `chrome-show` 恢复 → `chrome-stop` 清零。
- **护栏①野外实证**：同台账 9230（visible、从未见墙）全程未被 hide。
- **收尾**：自有 Chrome 全清、隔离台账 `[]`、真实共享台账恢复 `[]`（见 review-03 F-1）、dedao 85359/9226 验证前后存活一致。

## 8. 未实施项去向

见 `decisions.md` §0 总表：C1/C3 维持 DECISION（决策文档 §2/§3）；C4 现阶段 NO-GO（§4）；N1-N4 理由固化（§5）。D-2 的无 server 场景驻留边界如实文档化（§6）。
