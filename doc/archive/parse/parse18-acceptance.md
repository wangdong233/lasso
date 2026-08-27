# parse18-acceptance — v1.10.0 实施验收记录

> 日期：2026-08-15。实施按 parse18.md Phase A-D 全量落地。
> 基线 v1.9.0（1768 tests + 77 INV）→ **v1.10.0：1801 tests（+33）+ 78 INV 全绿，零回归；rust-helper/ 零改动（git status 确认）。**

## 门禁输出（真实跑）

```
npm run build            → tsc 零错误
npm test                 → Test Files 111 passed (111)；Tests 1801 passed | 1 skipped (1802)
npm run check-invariants → All 78 invariants passed.（INV-78 新增，INV-1..77 原样全绿）
```

## 真机验收（macOS 12 Intel 本机，2026-08-15）

| # | 场景 | 结果 |
|---|---|---|
| A1 | 前台 VS Code → `node dist/index.js launch-chrome --port 9225`（默认 hidden） | ✅ ok:true pid 53529；**frontmost 保持 Code**；System Events 数 Chrome 窗口 = **0**；`/json/version` 通（Chrome/150.0.7871.182）；台账含 `launchMode:"hidden"` + `idleMs:60000`（config 默认层生效） |
| A2-lite | hidden Chrome `/json/list` → 零 target；`CdpClient.createBackgroundTarget("https://example.com")` | ✅ 初始 targets **空数组**（E7 结论复现）；background tab 建成（page target 加载 example.com）；**frontmost 仍 Code**；建 tab 后窗口数仍 0。完整 A2（chrome-devtools-mcp 0.3.0 connect 后是否把既有 background page target 纳入页集合，V-18-1）需 server 级真机会话，**留 pending**——last resort 方案（首建 tab 一次性 activateTarget）按设计不进默认路径，未启用 |
| A3-lite | `--idle-ms 2000` launch → 起 reaper（defaultIdleMs=2000, intervalMs=1000） | ✅ `chrome_stop_result {action:"killed", tree_kill:false}`（SIGTERM 优雅步即死，无需树杀）→ `chrome_idle_reaped {idle_for_ms:2183}`；台账清空；`pgrep -f remote-debugging-port=9225` = NONE（零残留）。**kill 路径 100% 走 chrome-stop 的 ps 归属验证**（profileDir marker 匹配才杀） |
| A5-lite | per-record idle 覆盖 | ✅ 首轮 reaper 冒烟用 defaultIdleMs=2000 但台账记录 `idleMs:60000` → **8s 内不杀**（per-record 覆盖全局默认，长会话放行语义实证）；改 `--idle-ms 2000` 后正常回收 |
| config 层 | `LASSO_CONFIG_PATH=/tmp/x.json`（`{"LASSO_LAUNCH_IDLE_MS":123456}`）→ launch-chrome | ✅ 台账记录 `idleMs:123456`——**~/.lasso/config.json 文件层对 CLI 生效**（index.ts loadConfig → defaults → argv 优先级链实证）；argv/env 覆盖由单测 28/28b 守 |
| A6/A7-A10 | 未在本轮跑 | 留待用户环境观察（A6 禁用日志路径由单测 5 + index.ts 接线守；A7 visible 档由单测 11 守 shape；A9 TCC 保险丝由 chrome-hide 单测 18-20 守 mock 面，真机 TCC 授权机器复验 pending） |
| W1 | Windows | #W-pending（CI shape 断言已有：单测 12 验 win 档 args 含 `--start-minimized` + `--no-startup-window`；运行时行为不可本机验证，TROUBLESHOOTING §8.2 文档化两段式 ShowWindow 方案） |

## 红线复核

- **绝不动用户无标记 Chrome**：杀路径唯一 = chrome-stop（探活 → ps `--user-data-dir` marker 归属验证 → SIGTERM → 树杀 → 删账）；reaper 只是消费者（INV-78c + 单测 9 双面守：源码零 `killTreeSync`/`process.kill`）。
- **永不按进程名 hide**（E8 事故）：chrome-hide.ts 只做 PID（unix id）定向；INV-78e 禁按名裸 hide 字面量。
- 台账 schema 两可选字段前向兼容：v1.9 旧台账文件读取不变（chrome-ledger 既有测试全绿 + INV-78f）。

## 已知残留（诚实边界，parse18 §5）

1. CLI 单独 launch-chrome 无 idle reaper（短命进程；出口 chrome-stop）——README/KEY-GUIDE 已明示。
2. browse_logged_in 连用户自己开的可见 Chrome = 「低打扰，非零打扰」（上游 #1254 平台级）——文档如实表述，未承诺绝对静默。
3. `--no-startup-window` 是未文档化开关——fallback 链（离屏 `--window-position=-32000,-32000` 重试一次）+ macOS PID 定向 hide 保险丝已落地；本机 Chrome 150 实测 primary 档有效。
4. V-18-1（MCP 0.3.0 对「仅 background tab」Chrome 的页集合行为）真机 server 会话级验证 pending。
