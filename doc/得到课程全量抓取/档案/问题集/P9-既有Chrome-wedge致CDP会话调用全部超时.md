# P2-既有Chrome-wedge致CDP会话调用全部超时

## 现象
探察第一轮（UTC 05:10-05:14）连接时，目标 Chrome（9226，主循环启动的 hidden 档）HTTP 层活着（`/json/list` 返回 2 tabs，TabSession 快照成功），但 chrome-devtools-mcp 的**所有**页级 CDP 会话调用全部 60s 超时：
- `logged_in_2fa_probe_failed`（05:12:04）
- `logged_in_tab_reconcile_failed`（05:13:04）
- `browse_action_error navigate`（05:14:04）
- 每个 evaluate 返回的错误文本均为 `Network.enable timed out. Increase the 'protocolTimeout' setting ...`
随后约 05:14:05 起 `/json/list` 也变为不可解析（fetch 失败），Chrome 彻底不可达。

## 复现
未复现。后续每次全新 launch-chrome（05:17 起 pid 78801/80834/85359 三代）均一切正常：同一 mcp 版本、同一 profile、同一页面秒级建会话。差异仅在「Chrome 已被上一代 server 长时间使用过 + 期间发生过一次 server 停机收尾（SIGTERM 树杀未遂，见 P3 证据链）」。

## 白盒证据
- lasso stderr（`.dedao-scout/server-stderr.log`）：
  - `05:11:04.827 tab_snapshot_taken tabs:2`（HTTP CDP 可用）
  - `05:12:04.829 logged_in_2fa_probe_failed McpError:-32001`（首个会话级调用即超时）
  - `05:14:06.983 起连续 24× tab_reconcile_unparseable_list`（HTTP /json/list 亦失守）
- `Network.enable timed out` 出现在 evaluate 的 preview 文本中——该字符串是 chrome-devtools-mcp/puppeteer 侧 protocolTimeout 的产物（puppeteer 默认 protocolTimeout 180s，lasso McpClient callTool 层 60s 先到，故表现为 -32001）。
- 无 `chrome_idle_reaped` / `chrome_stop_result` 日志 → 本 server 的 idle reaper 未触发（排除 reaper 中途杀 Chrome 的假设）。

## 判断
**环境限制 → 结论**：Chrome browser 进程在长时间运行 + 一次未完成的停机收尾后 wedge（会话级 CDP 无响应→HTTP 亦失守），根因在 Chrome 侧、lasso 之外，且未再复现。结论：
1. 工作流遇此形态（HTTP 活但所有会话调用超时）直接判死：`chrome-stop` 或重启 Chrome（`launch-chrome` 同 profile），登录态在磁盘 profile，无损；
2. 与 P3 叠加：此时即使只退出 server，exit 钩子也会对残余进程补刀（`killTreeSync` SIGKILL），最终态一致；
3. 若后续高频复现，再升级为产品级排查（profile 锁文件 / Chrome 150 hidden 模式 --no-startup-window 会话残留）。
