# P28 — beforeunload/JS 弹窗自动接受看门狗 + renderer 楔死自愈

> 2026-08-20 用户指出的自动化完整性缺口：全量中脚本导航/刷新触发 Chrome「离开此页面？」
> beforeunload 确认弹窗，卡住页面等人工点。修复期白盒另发现**renderer 楔死**形态
> （连 Page.enable 都超时）——一并设防。全部在 `.engine/engine.mjs`（标记 `P28`）。

## 病理两种形态（白盒实证）

1. **JS 对话框**：beforeunload 确认框打开 → renderer 阻塞等人工 → 全部 evaluate 挂死。
2. **renderer 楔死**（修复期两次撞上，触发源疑似裸 CDP Page.navigate 与页面加载竞态）：
   `Runtime.evaluate`/`Page.enable` 全部超时，但浏览器级 Target 命令与
   `Page.handleJavaScriptDialog`（回 "No dialog is showing"）秒回——页面级会话整体不可用，
   lasso navigate 连烧 3×3min MCP 超时（`Network.enable timed out`）。

## 三层防御（engine.mjs）

| 层 | 机制 | 实证 |
|---|---|---|
| ① 事件层 | 每个 dedao page tab 常驻 WS + Page.enable，`Page.javascriptDialogOpening` → 立即 `handleJavaScriptDialog({accept:true})` + 日志 `[P28] dialog_auto_accepted`；tab 增删自动重挂（30s 轮询） | 注入 `onbeforeunload` → 触发导航 → 事件 1 次、accept 即发、evaluate 3s 内恢复 ✅ |
| ② 兜底层 | 同批常驻 WS 每 15s 盲发 `handleJavaScriptDialog({accept:true})`——无对话框时报错响应无人认领（无害），正是「探测挂起对话框并接受」（覆盖事件丢失/他会话打开的弹窗） | 命令通路同①（早前 /tmp/dialog-clear2 实证秒回） |
| ③ 自愈层 | `ensurePagesResponsive()`：章前+**冷启动**对每个 dedao tab 发 8s 限时的 `Runtime.evaluate("1")`，超时=楔死 → 浏览器级 `Target.createTarget(about:blank)+closeTarget` 换 tab（lasso P6 自愈重新选中/预建） | 生产流实测：`[P28] 楔死 tab 58EFE892 已换新` → 章节随后全绿 ✅ |

接受离开的正当性：导航意图全部由引擎发起（navigateOnce/SPA 复位/switch 兜底），接受
beforeunload 即执行我们自己的决定；不会有引擎之外的未保存编辑场景（页面为只读采集态）。

## 关键边界

- 自愈必须覆盖**冷启动**（最初只挂在章循环内——白盒撞上楔死 tab 时首次 navigateOnce 连烧
  9min 超时后 exit(1)，已补 `await ensurePagesResponsive()` 于启动 navigate 之前）。
- 换 tab 用浏览器级 `Target.*`（页面级 WS 全挂时唯一通路）。

## 验证记录（2026-08-20）

- ①：`/tmp/p28-dialog-test.mjs` 注入 onbeforeunload → Page.navigate →
  `[事件层] javascriptDialogOpening: beforeunload` → accept → evaluate 恢复（同 URL）。
- ③：引擎冷启动遇昨日楔死 tab → 自动换新 → `预告丨认识社会成本` 全绿 28.2s。
- ②：与①同命令通路，作为事件丢失时的保险（15s 粒度）。
