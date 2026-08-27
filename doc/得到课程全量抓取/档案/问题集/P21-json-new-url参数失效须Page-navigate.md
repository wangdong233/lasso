# P21 — 新版 Chrome /json/new 忽略 url 参数（tab 停在 about:blank）

- 日期：2026-08-19（架构师轮，合并演示）
- 组件：路线 b 渲染器 `合并演示/render-merge-b.mjs`（CDP 直连 9226）

## 现象

`PUT http://127.0.0.1:9226/json/new?<url 参数>` 建的 tab **不导航**到给定 URL：4s 后 `tab.url` 与 `location.href` 仍为 `about:blank`（readyState=complete、images=0）。首版就绪条件 `rs==complete && bad==0` 被「空页零图」空真满足 → 直接 printToPDF 出 1 页 5.7KB 空白 PDF。

## 根因

新版 Chrome（150.0.7871.182）的 `/json/new` 端点已不消费 url 查询参数（实测；旧版行为是建 tab 即导航）。导航必须走 CDP 会话内 `Page.navigate`。

## 修复（已落地 render-merge-b.mjs）

1. 建 tab 不带参数 → WS 连接 → `Page.navigate({url})`；
2. 就绪门收紧：`href.startsWith("file:") && rs==complete && n>=期望图数 && bad==0`（期望图数=各章 MD `![](images/` 计数）——空页空真被结构性堵死；
3. 超时 dump 最后态（href/n/bad 明细）供归因。

## 关联纪律

- 建 tab 的焦点激活会解除 App 隐藏（与 P19 同源）：**创建后立即 chromeGuard() 定向复隐**，收尾再核验（实测 guard-pre/pre 各一次 rehidden，末态 hidden）。
- 静默合规：tab 在既有隐藏窗口内创建，未开新窗；print 后 `/json/close` 即关。
