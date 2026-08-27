# P3-server停机收尾杀hidden台账Chrome

## 现象
lasso server 进程一退出（stdin EOF / SIGTERM），它台账里 hidden 档的 Chrome 就被树杀。本工作流「每个 .mjs 探察脚本 spawn 一个短命 server」→ 每跑完一脚本 Chrome 就死一次，必须重新 launch-chrome。

## 复现（本轮两次实测）
```
# 1) launch-chrome（ok:true, pid 78801，台账落盘 status:ready）
# 2) node scout.mjs（连 server 干活，脚本尾部 transport.close() → server stdin EOF）
# 3) 脚本退出后：
curl http://127.0.0.1:9226/json/version   # 空响应
ps -p 78801                                # DEAD
```

## 白盒证据
- `server-stderr.log`（05:20:03）：
  `lasso_shutdown sig:stdin_eof` →
  `chrome_stop_result {"port":9226,"pid":78801,"action":"killed","tree_kill":true}` →
  `tab_restore_result ok:false reason:cdp_unreachable`（先杀后 restore，顺序使 restore 永远失败）→
  `subproc_exit_kill logged_in:default/lifecycle ...`
- 台账文件 `~/.cache/lasso/launched-chromes.json` 被清为 `[]`。
- 源码：`src/index.ts:1303-1310`——停机路径无条件调用
  `stopLaunchedChromes({ all:true, modes:["hidden"] })`（3s race 上界）。
- `src/launcher/chrome-idle-reaper.ts:117-120` 注释同样确认语义：visible 档永不 idle 收割，**hidden 档维持「用完即关」**——server 停机即关是 v1.10 起的设计行为。

## 判断
**预期行为 → 结论（工作流约束）**：
「用完即关」对单次 CC 会话是合理默认，但对「多个短命 MCP 客户端脚本顺序接力操作同一登录 Chrome」的工作流是硬约束。结论与对策：
1. **每个脚本批次的正确模式**：`launch-chrome`（同 profile，登录态在磁盘不丢，实测两代重启后仍登录）→ 单 server 进程内完成本批全部动作 → 退出 → 下批重来；
2. 不要假设上一进程留下的 Chrome 一定还在（台账空则存活、台账有则被杀——本轮交接态：pid 85359 存活且台账为空，server 退出不会误杀）；
3. 顺带的优化机会（非缺陷）：shutdown 序列里 chrome-stop 在 `restoreTabs` **之前**执行，导致 restore 恒报 cdp_unreachable；若先 restore 再 stop，停机日志更干净（低优先级）。
