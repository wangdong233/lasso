# P1：用户登录中的 visible Chrome 被 server 退出关闭

## 现象
用户在 lasso 起的 visible Chrome（dedao-profile，9222）完成得到登录后，窗口被关闭（进程 0、台账清空 `[]`）。

## 白盒证据
- src/index.ts 停机路径（v1.9 机制二）：`stopLaunchedChromes({all:true})`——**每个 server 进程退出时无条件关台账全部 Chrome**
- 时间线吻合：登录期间无 server 运行（无人杀）；工作流 agent 的短命 MCP server 脚本结束退出 → 停机钩子杀 Chrome
- 非 idle reaper：reaper 需 server 存活 60s 闲置；杀手是退出钩子（瞬时）

## 判断：产品缺陷（设计级）
「server 退出=会话结束」语义只对 hidden 档成立；visible 档是**用户拥有的窗口**（登录/查看中），短命 server 退出无权关闭。调大空闲时长（如 5min）**不能**修复——杀手与空闲无关。

## 修复（v1.17.3）
chrome-stop 增 `modes` 过滤；index.ts 停机传 `modes:["hidden"]`；idle reaper 对 visible 记录直接 continue。**visible 档唯一关闭出口 = 显式 chrome-stop**；hidden 档维持用完即关。回归测试 test/unit/p1-visible-chrome-lifecycle.spec.ts（4 测）。

## 终裁注记（v1.18.1）
已修复并验证（commit 72712df）。**但该修复只覆盖优雅 shutdown 路径**——exit 钩子同步路径仍有同一致死语义，即 P4（由 doc/28 工作流补修，v1.18.0）。两修合并后 visible 档三口（优雅停机 / exit 钩子 / idle reaper）全豁免，红线完整成立。
