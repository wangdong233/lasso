# P4-exit钩子stopLaunchedChromesSync无modes过滤

## 现象
v1.17.3 的 P1 修复宣称「visible Chrome 已免疫 server 退出的停机关闭」，但该免疫只覆盖**异步优雅停机路径**；`process.on("exit")` 同步钩子路径对台账 Chrome **不区分 hidden/visible 一律树杀**。即 visible 档在 server 走到 exit 钩子时（如 3s race 超时、异步路径异常、killAllSync 前的兜底时序）仍会被杀，用户正在里面登录/查看的可见窗口也会被关掉。

## 复现（代码路径推演 + 本轮日志佐证机制存在）
- 优雅路径（index.ts shutdown）：
  `stopLaunchedChromes({ all:true, modes:["hidden"] })`——`chrome-stop.ts:143-144` 按 `opts.modes` 过滤 `launchMode`，visible 被放过 ✅
- exit 钩子路径（index.ts:1348-1352）：
  `stopLaunchedChromesSync(logFn)`——`chrome-stop.ts:202` 起的同步版**全签名无 modes 参数**，循环内 `killTreeSync(rec.pid,"chrome-stop-exit")` 不看 launchMode ❌
- 本轮 05:14:29 的日志可见该同步路径确实会执行并逐个 SIGKILL Chrome 树（`subproc_exit_kill name="chrome-stop-exit"` ×10，pids 64128-64523 为 Chrome 主进程树）。

## 白盒证据
- `src/index.ts:1303-1310`（async，带 `modes:["hidden"]`）vs `src/index.ts:1347-1352`（exit 钩子，调 `stopLaunchedChromesSync`）。
- `src/launcher/chrome-stop.ts:141-144`（modes 过滤只在 async 版）与 `:202-216`（Sync 版无过滤）。
- `chrome-idle-reaper.ts:117-120`：idle reaper 侧同样有 visible 豁免（`if (rec.launchMode === "visible") continue`）——三处收口，唯独 exit 钩子漏。

## 判断
**产品缺陷 → 修复优化（跑门禁）**。P1（v1.17.3）修复不完整：同一致死语义存在第二出口，破坏「visible = 用户拥有，永不代关」的红线承诺。

修复建议：
1. `stopLaunchedChromesSync` 增加 `modes` 参数（默认 `["hidden"]` 与 async 对齐），exit 钩子传 `modes:["hidden"]`；
2. 需过门禁：`npm test`（chrome-stop 相关单测需补 visible 记录在 Sync 路径不被杀的断言）+ `node src/invariants/check-invariants.mjs`；
3. 顺手核对 CLI `chrome-stop`（用户显式出口）保持全模式杀（那是用户点名要关，语义不变，勿被本次修改波及）。

## 修复记录（终裁：已修复，v1.18.0 / 工作树未提交态）

本条缺陷由并行工作流（doc/28-静默守则审计 fix-2.md D-5，同日本仓库）实施，质检官验证收尾：

- `src/launcher/chrome-stop.ts`：`stopLaunchedChromesSync(logFn?)` → `stopLaunchedChromesSync(opts: ChromeStopSyncOptions)`——`modes` 过滤与 async 版同款（`opts.modes.includes(r.launchMode ?? "hidden")`），另补 `aliveFn/psFn/killTreeFn/logFn` 测试注入面；`verifyOwnership` 守卫仍先于 kill（红线顺序不变）。
- `src/index.ts` exit 钩子：`stopLaunchedChromesSync({ modes: ["hidden"], logFn })`——visible 豁免 + 台账条目保留（进程活着，清账即孤儿化）。
- CLI 缺省 modes 不过滤（用户显式操作 = 最高权限，语义不变）——修复建议第 3 条核对通过。
- 测试：`test/unit/d5-exit-hook-visible-survival.spec.ts` 6 用例（含 index.ts 装配源码锚 + 零 await 纪律锚）；INV-82 (a) 机械化守护 + inv-selftest 3 违规样本红过。
- 门禁（v1.18.1 终跑，含本修复）：build ✅ / npm test 2308 passed +1 skipped / check-invariants 82/82。
