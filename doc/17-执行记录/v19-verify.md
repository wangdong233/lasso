# v1.9.0 真机验证执行记录（三机制 + 每用例资源三采样）

- 验证日期：2026-08-15
- 验证环境：macOS Darwin 21.6.0 / node v24.12.0 / 本机（Chrome 150 真实安装）
- 验证脚本与原始采样：本目录 `v1-idle.mjs` / `v2-chrome-stop.mjs` / `v3-tab-restore.mjs` / `v4-shutdown.mjs` / `v5-perf.mjs` + `v19-v*.json`
- 纪律依据：doc/17-功能测试清单.md §0.2 第 6/7 条（resource-meter 三采样 + 串行 + 用例间 sleep 2s）
- **验证中发现并修复一个 P0（详见 §4）**；修复后门禁终跑：build ✓ / **1768 passed**（+1 回归测试）/ 77 invariants ✓

---

## 1. 三机制验证结果表

| # | 机制 | 操作（真机） | 证据 | Verdict |
|---|------|------------|------|---------|
| V1 | headless idle 关停 | `LASSO_HEADLESS_IDLE_MS=10000` 起 server → browse_headless navigate → 轮询至 90s | Chrome 树 9 procs/819MB → **58.2s 整树回收**（survivors=NONE）；日志 `zombie_reaped headless idle_ms=56151`；二次 browse 冷启动自愈 5.6s（vs 热态 226ms）；二次回收 54.1s（`idle_ms=51751`）；released=true | **PASS**（附 §3-Ⓐ 时延口径说明） |
| V2 | chrome-stop 收尾 | `launch-chrome --port 9225` → `chrome-stop --port 9225` | Chrome 5 procs → 0；端口释放；台账清空；复跑幂等 `stopped:[]` exit 0；峰值 657MB/8procs → after 0/0 released=true | **PASS**（修复 P0 后） |
| V2b | pid 复用防护 | 伪造台账（正确 schema）pid→无关 sleep 进程 | `action:"pid_reused_skipped"`，sleep 进程存活（红线：未验证归属绝不 kill），陈旧条目被清 | **PASS** |
| V3 | tab 快照恢复 | launch 9226 → 2 用户 tab → browse_logged_in navigate（首附着快照 3 tab）→ CDP 开 1 个快照后新 tab → `admin tab_restore`（带 reason） | `closed:["A0398F3A…"]`（仅 extra）；**快照 3 tab 全 intact、用户 2 tab 全 intact**；无 reason 被拒 `field required: reason`；日志 `tab_snapshot_taken tabs:3` | **PASS**（红线：关闭集只来自 diff，构造上不含快照内 target） |
| V4a | 停机清理（优雅） | server SIGTERM 退出（挂 9228 台账 Chrome + headless 树） | shutdown 日志序：`lasso_shutdown` → `chrome_stop_result 9228 killed`（先）→ `subproc_exit_kill`（后）；端口关、台账空、released=true | **PASS** |
| V4b | 停机清理（SIGKILL 边界） | SIGKILL server（挂 9229 台账 Chrome） | Chrome 存活（Node SIGKILL 不可达 exit 钩子——设计边界，诚实记录）；`chrome-stop --port 9229` 台账兜底 → `killed`、端口释放 | **PASS（边界+兜底出口）** |

## 2. 每用例资源占用表（before/peak/after，resource-meter 真采样）

| 用例 | 耗时 | before | peak | after | released | 备注 |
|------|------|--------|------|-------|----------|------|
| V1 browse#1（navigate+首启） | 5.4-6.1s | 1p/81MB | 11p/840MB | 1p/88MB | true | idle 回收后 |
| V2 launch-chrome+chrome-stop | ~6s | 0p | 8p/657MB | 0p/0MB | true | |
| V3 logged_in 全链+tab_restore | ~20s | 0p | 15p/1421MB | 0p/0MB | true | 见 §3-Ⓑ |
| V4a 停机清理 | ~1s | 0p | （含 headless 树） | 0p/0MB | true | |
| V5-1 navigate+extract markdown | 6.6s | 1p | 9p/834MB | 9p/844MB | false* | *idle 置 0 串行采样，驻留属预期 |
| V5-2 screenshot fullPage | 0.85s | 9p | 9p/851MB | 9p/857MB | true | PNG 15.7KB |
| V5-3 network | 3.9s | 9p | 9p/860MB | 9p/860MB | true | performance_observer |
| V5-4 search fallback_chain | 17ms | 9p | 9p/860MB | 9p/860MB | true | serp_scrape_baidu，0 结果（查询过窄，机制通） |
| V5-5 desktop snapshot | 60ms | 9p | 9p/860MB | 10p/864MB | false* | ax_snapshot worked，preview 空（AXAPI 权限受限） |
| V5 teardown：server 退出 | — | 10p/864MB | — | **0p/0MB** | **true** | 整树（含 headless Chrome）零残留 |

## 3. 超标清单与根因（阈值：单用例 peak RSS > 600MB 或 after 残留）

- **Ⓐ 驻留窗口时延口径**：reaper tick 固定 60s（`startZombieReaper(60_000, idleMs)`），有效回收时延 = tick 相位 + idle 阈值（实测 58.2s @ idle=10s）。默认 5min 配置下最坏持有 ≈ 6min。**非缺陷**（v1.9 设计即 5min 窗口），但「等 15s 验证」这类用例口径不成立——验证/文档若引用「10s 必收」需按 tick+idle 口径改写。调研摘要中「6.1s/6.8s 回收」与本实现不符（本机白盒：无其他 cleanupZombies 调用点）。
- **Ⓑ V3 peak 1421MB**：根因 = 真实（可见窗口）Chrome 树（~700MB+helpers）+ logged_in 的 chrome-devtools-mcp node 树 + server 本身三者并存。属 Chromium 多进程 RSS 本征，机制出口即 V1 的 idle 回收 + V4 停机清理；无可砍的 lasso 侧冗余（每进程均必要）。
- **Ⓒ V5 全系 peak ~860MB**：同 Ⓑ 根因（headless Chrome 树驻留，idle 置 0 便于串行采样所致）。released=false 仅 V5-1/V5-5，为「驻留树跨用例」预期，teardown 全灭证明无泄漏。
- **Ⓓ minor（不超标，记录）**：台账形状不对的条目（readLedgerSync 丢弃）永不被清理，残留在磁盘——建议 doctor 或 chrome-stop `--all` 时顺带重写过滤。

## 4. 验证中发现并修复的缺陷（P0，白盒根因）

**现象**：V2 首跑 `chrome-stop` 对刚 launch 的 Chrome 报 `pid_reused_skipped` 不杀，但台账被清 → **孤儿 Chrome**（机制二在真机完全失效，wave2 残留两个 Chrome 窗口的同类复现源）。

**根因**（源码锚点）：`src/launcher/chrome-stop.ts` `verifyOwnership()` 要求 marker `--user-data-dir=<profileDir>` 后跟空白或行尾；真机 `ps -p <pid> -o command=` 输出**恒带行尾 `\n`**，而 lasso 注入的 user-data-dir 是 Chrome cmdline 最后一参 → `after === "\n"` → 恒 false。单测注入的 `psFn` 无换行（手造 fixture = 03 §0.3 L0'），掩盖该路径。

**修复**：`verifyOwnership` 入口统一 `.replace(/[\r\n]+$/,"")` 剥行尾换行（只剥行尾——换行后仍有内容的前缀拼接种仍拒绝）；`test/unit/chrome-ledger.spec.ts` 增真机形状回归测试（marker 行尾带 `\n` 通过；`\n` 后拼接内容仍拒）。孤儿 Chrome 经「重新登记 + chrome-stop」机制出口清理（顺带即修复的活体验证：`action:"killed"`、端口释放）。

**03 回溯**（§3.2 缺陷分类）：data handling / producer 契约类 → **1.2 项 1**（外部命令输出形状 = producer，必须 L3 真机验证；注释/手造 fixture 不是证据）。建议 checklist 增补项：「`ps`/`pgrep` 等外部命令输出契约（行尾换行、列截断）必须真机采样钉 fixture」。

## 5. 附带事实澄清（非缺陷，防误用）

- `browse_headless/browse_logged_in` 的 `snapshot`/`extract` action **不导航**（NAV_FIRST_ACTIONS 仅 network/screenshot/pdf），对当前 tab 操作——单调用 `extract` 会抽到 about:blank/新标签页。正确用法：先 `action:"navigate"` 再 `action:"extract"`（本记录 V5-1 实证：navigate+extract 得到 "Example Domain" 正文 markdown）。
- lasso 自身不开新 tab（chrome-devtools-mcp 导航当前 tab）；TabSession diff 语义保护的是「快照后出现的任何 page target」。

## 6. 03 审查结论（§1 六维度过 v1.9 改动）

| 维度 | 结论 |
|------|------|
| 1.1 规范 | 通过（tsc/vitest/INV 全绿；注释 WHY 风格） |
| 1.2 数据逻辑 | **修复后通过**——§4 P0 即本维度失守案例；ps 契约已 L3 真机验证 + fixture 钉死；/json/list、台账字段均有真机值级证据（V2/V3）；Ⓓ 为 🟡 |
| 1.3 业务逻辑 | 通过——restore 三守卫、reap hook 3s 上界、mutation 强制 reason 均真机/单测覆盖 |
| 1.4 端到端 | 通过——V1-V4 值级 trace 到 pid/port/台账/tab-id 粒度；§5 澄清 NAV_FIRST 语义防后续误用 |
| 1.5 性能+PRR | 通过——§2 表；feature switch（IDLE_MS=0）、rollback（chrome-stop 台账）、可观测（结构化日志）齐备 |
| 1.6 简单架构 | 通过——树杀单一真源（INV-77a），chrome-stop 消费共享原语（INV-64b 显式豁免，登记在案）；TabSession/TabRegistry 两语义分离正确 |
| 1.7 冗余 | 通过——sync/async 双路径为零 await 纪律的 intentional 重复（W1-DEF-6 先例）；无死代码 |

**总 verdict：PASS（P0 已修 + 回归守护 + 门禁全绿）**。

## 7. 门禁输出（终跑，修复后）

```
npm run build           → 通过
npm test                → Test Files 107 passed (107)
                          Tests 1768 passed | 1 skipped (1769)   [基线 1711 → +57；本验证 +1 真机形状回归]
npm run check-invariants → All 77 invariants passed
```

## 8. 验证后清理核查（自 spawn 的一切浏览器/tab）

- 9225/9226/9227/9228/9229：端口全部释放（V4b 经 chrome-stop 兜底）
- `~/.cache/lasso/launched-chromes.json` = `[]`
- resource-meter 终采样：**0 procs / 0MB**（lasso 特征树零残留）
- /tmp/lasso-screenshot-*.png 已删
- 伪造台账条目已随机制清理
