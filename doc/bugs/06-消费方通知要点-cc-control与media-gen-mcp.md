# BUG-06 消费方通知要点（cc-control + media-gen-mcp）

> 落档日期：2026-09-10 · 决议来源：[06-2026-09-10-日常档idle0幽灵常驻-硬顶与配方治理决议.md](06-2026-09-10-日常档idle0幽灵常驻-硬顶与配方治理决议.md) 决议 C · 两侧 owner 均为用户本人——本文件是「通知已落档」的档案凭证（发版时随 changelog 显著位一并触达）。
>
> 一句话：**lasso v1.24.0 起 `--idle-ms 0` 不再是「永不回收」，而是「无活动 24 小时硬顶回收」**——在用（touch 续命）永不触发；真·无限常驻须 `--idle-ms 0 --no-hard-cap` 双旗或部署级 `LASSO_LAUNCH_HARD_CAP_MS=0`。

## ① cc-control（flow / 会话配方使用方）

- 现存配方 `node dist/index.js launch-chrome --port 9223 --idle-ms 0`（doc/bugs/02 首创 → TROUBLESHOOTING「推荐」→ 会话固化）：**无需改代码**。
  - flow 会话为分钟级，远低于 24h 硬顶；且 lasso browse 活动现自动落盘 touch 文件（决议 A-7），在用永不触发。
  - 就算某次真被硬顶回收：下次 `ensure` 自动重拉（既有生命周期不变），损失 ≈ 一次冷启动（~1.5s）。
- **升级瞬间的一次性行为**：存量超龄 idle-0 记录（若有）会被首个收割 tick（≤15s）回收——属预期（即本次事故的幽灵形态）。
- 若未来出现真·无限常驻需求 → 改用 `--idle-ms 0 --no-hard-cap`（双意图）或 `LASSO_LAUNCH_HARD_CAP_MS=0`（部署级）。

## ② media-gen-mcp（FlowProvider / 渲染档消费方）

- `doc/flow-api-contract.md` 的启动命令（`launch-chrome --port 9223 --idle-ms 0`）**旁注一句新边界**：
  > 注（2026-09-10，lasso BUG-06）：`--idle-ms 0` 现语义 = 无活动 24h 硬顶回收（分钟级 flow 会话不受影响；ensure 会自动重拉）；真·无限须 `--idle-ms 0 --no-hard-cap`。
- 渲染档（render-chrome / `LASSO_RENDER_IDLE_MS`）**零变化**——本批刻意不动渲染档（决议 D3 红线豁免，INV-94 tripwire 钉死三文件零 hard-cap 符号）。
- 消费方自管池 `MEDIA_GEN_BROWSER_IDLE_MS` 已随 legacy 退役（D5，N/A）。

## ③ 验收口径（发版前用户自查一条命令）

```bash
# 看某口的硬顶状态（超龄过半会出 hard_cap_watch 咨询块 + 预期回收时刻）
lasso-mcp chrome-status --port 9223 --json | grep -A5 hard_cap_watch
```
