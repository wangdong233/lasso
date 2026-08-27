# 28 · 静默守则审计 —— GO 项实施记录（fix.md）

- **日期**：2026-08-19
- **输入**：`audit.md`（矩阵 + D 清单 + 分级）
- **实施范围**：仅 GO 两项（G1 测试+文档 / G2 描述运行手册），**零行为变化**（D-1b/D-2/D-3 均为 DECISION 项，未动）；版本不 bump（无行为变更，与 doc/governance/08 fix.md 的 bump 惯例区分——本轮纯测试+文档+描述文案）。

## 1. G1 · chrome-hide/show 恢复出口的回归防护（D-4）

### 1.1 新增 `test/unit/chrome-hideshow.spec.ts`（8 用例，全 mock 注入零真机）

- **G1-1..G1-4 行为向**：`showChromeByPid` 脚本极性（`set visible of p to true`）+ `unix id` PID 定向（永不按进程名红线双向适用）；hide/show 极性互反对照；TCC 缺失（osascript 1743）降级不抛；非 darwin / 无 pid / 非法 pid 全 no-op（execFn 零调用）。
- **G1-5 白盒**：双出口共用 `setChromeVisibleByPid`，极性由 `visible` 三元单点决定（无双脚本漂移面）。
- **G1-6..G1-8 白盒（CLI 短命路径，沿用 p1-visible-chrome-lifecycle.spec.ts 源码锚定范式）**：归属验证红线（`verifyOwnership(rec.pid, rec.profileDir` + `pid_reused_skipped`）、`--port` 过滤、`chrome_show`/`chrome_hide` 结果标识、index.ts 子命令双出口路由。

### 1.2 用户文档补 P4 登录三步（README + KEY-GUIDE）

- **README.md §二「抓登录态页面」**：改写为「首次三步」（`--mode visible` 弹窗 → 登录 → `chrome-hide` 转静默）+「之后一行命令」；细节折叠区补 chrome-hide/show 只动台账在案 Chrome、hide 无损可逆（进程/登录态/CDP 保留）。修复 v1.8 语境残留「第一次在这个窗口登录」与 v1.10 hidden 默认的矛盾（audit D-4 文档面）。
- **doc/usage/01-KEY-GUIDE.md §B**：同款三步 + `chrome-show` 可逆说明 + v1.8 note 同步修正（「登录必须走 visible 档」）。

## 2. G2 · browse_logged_in 描述内嵌「Chrome not running」运行手册（D-1a）

- **src/tools/descriptions.ts `BROWSE_LOGGED_IN_DESCRIPTION`**：在 REQUIREMENTS 后新增失败签名→修复命令映射：`outcome=unknown + "Could not connect to Chrome ... /json/version: fetch failed"` → `lasso launch-chrome`（静默档）/ 首登 `--mode visible` → 登录 → `chrome-hide`（`chrome-show` 可逆）→ 重试即继承登录态。
- 依据：audit §2.2 真机锤点（initialize 9.1s 照常成功、navigate 57ms isError；错误串无 next_step，CC 只能靠描述回忆）——描述是 CC 在 tool-selection 面必读的单一入口，此处补手册使无 shell 的 MCP 客户端也知道转告用户什么。零行为变化（全树无描述快照测试，grep 证实）。

## 3. 未实施项去向（DECISION/NO-GO）

| 项 | 去向 |
|---|---|
| C1 admin `chrome_launch` action | 交用户裁决（新增 mutation action 面，独立轮次） |
| C2 visible 台账 Chrome 登录后自动 hide | 交用户裁决（opt-in 默认 off；依赖 C3 判定器） |
| C3 NEEDS_MANUAL_2FA 生产者实装 | 交用户裁决（worked→didnt 行为变化 + 假阳性判据需评审；描述承诺未实装的还债） |
| C4 无 Chrome 全自动恢复链 | 不本轮做（C1-C3 落地后自然成形） |
| N1-N4 | NO-GO（物理边界 / 铁律 / 红线 / P1 已裁决），见 audit §4 |

## 4. 门禁

- `npm run build` ✅
- `npm test`：**137 文件 2267 passed + 1 skipped**（基线 2259 passed + 1 skipped，+8 新测全为新增 spec，基线不减）✅
- `npm run check-invariants`：**81/81** ✅（不减）
