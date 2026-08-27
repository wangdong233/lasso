# P6-零tab-hidden-Chrome首navigate报No-page-selected

## 现象
hidden 档 Chrome 以 `--no-startup-window` 启动后**没有任何 page target**；此时连接 lasso `browse_logged_in action:"navigate"` 直接失败：`nav_error:No page selected`（chrome-devtools-mcp 侧无当前页可导航）。此后所有 evaluate 同样返回 `No page selected`（并经 P5 假成功路径呈现为 worked）。

注意：该失败**非必现**——同一流程此前三轮（scout/scout2/scout3）都能由 navigate 自动建页成功，第四轮（scout4）起失败，chrome-devtools-mcp 冷启动时的页面选择时序存在竞态。

## 复现
```
node dist/index.js launch-chrome --port 9226 --profile <dedao-profile> --mode hidden --idle-ms 3600000  # ok:true
curl -s http://127.0.0.1:9226/json/list   # → [ ]   （零 page）
# 立刻连 server 调 browse_logged_in navigate → nav_error:No page selected
```
规避后恢复：
```
curl -s -X PUT "http://127.0.0.1:9226/json/new?about:blank"   # 建一个 page target
# 再 navigate → 正常（scout5 实测全链路通过）
```

## 白盒证据
- `server4-stderr.log`：`05:26:04 tab_snapshot_taken`（快照 0 tab）→ 同秒 `browse_action_error Error: nav_error:No page selected`；其后 24× `tab_reconcile_unparseable_list`（`/json/list` 为 `[]`，`parseUpstreamPageEntries` 视空/异常为 skip）。
- `/json/list` 实测返回 `[ ]`；`/json/new` 需要 **PUT**（GET 会被 Chrome 拒）。
- 上游行为：chrome-devtools-mcp（LOCKED 1.7.0）attach `--browser-url` 后若有 page 则选首个；无 page 时 `navigate_page` 的落点为「当前选中页」，无页即报 `No page selected`。lasso 层 `LoggedInChannel` 未在 0-page 状态预建页。

## 判断
**上游边界 + lasso 未兜底（产品缺陷，轻量可修）**：
- 环境事实：hidden 档 Chrome 天然 0 page 起步，属预期；
- lasso 侧缺陷：`browse_logged_in` 对 `No page selected` 无自动恢复（可在 LoggedInChannel 首次 getMcpClient 或 navigate 失败分支检测该错误串 → 经 CDP `/json/new` 预建 about:blank 页重试一次）。

修复建议（若修）：错误签名 `No page selected` → 预建 page 重试一次 → 仍败才落 didnt；门禁补 0-page mock 单测。工作流侧现阶段统一先 `PUT /json/new` 即可（已写入探察报告 §4.8）。

## 修复记录（v1.18.1，已修复——采用「错误签名 → 自愈重试一次」方向）

白盒定位（比原判断更精确的失效链，server4-stderr.log 05:26:04 实证）：零页 + 台账空时**两条既有预建路径全漏**——

- `precreateBackgroundTabIfHidden` 判定门 `readLedgerSync().find(port)` 要求台账记录，上一代 server 停机清账后的遗留 Chrome 不命中 → 跳过；
- `ensureOwnPageSelected`（v1.17.2 S-7，无台账 Chrome 反而进）因 `list_pages` 零页列表被 `parseUpstreamPageEntries` 解析为 null 而 **silent bail**（该函数 `if (before === null) return;` 无日志——日志中无任何 own_page 事件即此洞）。

修复（两层，`src/channels/BrowseChannel.ts` + `LoggedInChannel.ts`）：

1. `browseSingle` 把 NAV_FIRST + handler 抽成 `dispatchAction`；catch 到 `NO_PAGE_SELECTED_RE`（上游 McpContext.js:250 Error 文本）且 `recoverNoPageSelected(c)` 返 true → **原样重试一次**；默认钩子 false（HeadlessChannel 零变化）；失败/不命中 → 原错误路径（unknown 可重试）。
2. `LoggedInChannel.recoverNoPageSelected`：`CdpClient.createBackgroundTarget`（Target.createTarget {background:true}，E7 零抢焦）预建 about:blank → `list_pages` id-diff 归因（2 轮 × 300ms；上游 targetCreated 只建 McpPage **不选中**，必须显式 select_page）→ `select_page {pageId}`（不带 bringToFront）。归因不唯一/预建失败 → false（宁失败不误选）。永不 throw。

测试：`test/unit/p6-no-page-selfheal.spec.ts` 8 用例（重试编排 4 + 自愈原语 3 + 源码锚 1；CdpClient vi.hoisted mock）。门禁：build ✅ / 2308 passed / 82 INV。
