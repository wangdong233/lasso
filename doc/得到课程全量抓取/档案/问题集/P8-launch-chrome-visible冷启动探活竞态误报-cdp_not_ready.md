# P1-launch-chrome-visible冷启动探活竞态误报-cdp_not_ready

## 现象
`lasso launch-chrome --mode visible`（或经 chrome-show 后的可见档冷启动）后工具返回 `ok:false, error:"cdp_not_ready"`，但 Chrome 实际已成功启动并在随后可正常访问 CDP。（主循环在本项目得到任务中亲历；探察员在源码层复核确认机制。）

## 复现
visible 档冷启动（重 profile / 低速盘 / 系统负载高时更易）：
```
node dist/index.js launch-chrome --port 9226 --profile <dir> --mode visible
# → { ok:false, error:"cdp_not_ready", pid:<活着的pid> }
# 稍后 curl http://127.0.0.1:<port>/json/version → 200 正常
```

## 白盒证据（源码）
- `src/launcher/launch-chrome.ts:155-157`：
  `CDP_PROBE_ATTEMPTS = 10`，`CDP_PROBE_INTERVAL_MS = 300`，`CDP_PROBE_FETCH_TIMEOUT_MS = 1000` → 探活窗口合计仅 3s（spawn 后 3 秒内 /json/version 必须通）。
- `src/launcher/launch-chrome.ts:379-395`：探活轮询循环，窗口耗尽即判 `outcome !== "ok"`。
- `src/launcher/launch-chrome.ts:497-524`：非 exited 时返 `error:"cdp_not_ready"`；代码注释自认「cdp_not_ready 时 Chrome 可能仍在慢启动——launch 时刻仍不代 kill（wave2 U-04-1 实证 pid 74620）」——即作者已知该形态是误报而非真失败。
- 佐证：探察员本次 hidden 档多次 launch 均在 3s 内通过（约 1.7s，见 `chrome_ledger_recorded` 与 `chrome_hide_fuse_ok` 时间差），visible 档冷启动首次窗口创建更慢，易超 3s。

## 判断
**产品缺陷 → 修复优化（跑门禁）**。探活窗口对可见档冷启动不充分，把「慢启动」误报为「未就绪」，调用方若据 ok:false 走清理/重试逻辑会误事（Chrome 活着且稍后可用）。

修复建议（任一，需过 `npm test` 门禁与 invariants 校验）：
1. 探活窗口按 launchMode 分档：visible 冷启动给 10-15s（或 attempts=10→40 / interval 自适应退避）；
2. 窗口耗尽后追加一次延迟复核（如 +2s 再探一轮）再定性 cdp_not_ready；
3. 返回体中显式标注 `mayStillBeStarting:true`，让调用方可选择等待复探而非判死。

回归注意：`launch-chrome` 的探活有测试注入点（`probeFetch` / `probeAttempts` / `probeIntervalMs`，W1-DEF-7），改窗口参数需同步 mock 时序断言。

## 修复记录（v1.18.1，已修复——采纳建议 1+3 合并）

`src/launcher/launch-chrome.ts`：

1. **窗口分档**：新 `CDP_PROBE_ATTEMPTS_VISIBLE = 40`（12s，300ms × 40）；hidden 维持 `CDP_PROBE_ATTEMPTS = 10`（3s，实测 1.7s 即通）。`LaunchChromeOptions` 新增 `probeAttempts` 测试注入（缺省按 launchMode 分档取）——补齐了建议里说的注入点（此前只有 interval 没有 attempts）。
2. **`mayStillBeStarting: true`**：cdp_not_ready 返回体显式标注「可能仍在慢启动，可等待复探再判」（LaunchChromeResult 新字段；chrome_exited 不带——真失败与慢启动可区分）。

测试：`test/unit/launch-chrome.spec.ts` 更新 1 + 新增 3 用例（visible 41 fetch + mayStillBeStarting / hidden 维持 11 fetch / probeAttempts 覆盖 / chrome_exited 无标记）。门禁：build ✅ / 2308 passed / 82 INV（INV-76 (f) 只锚 token 不锚次数，无回潮）。
