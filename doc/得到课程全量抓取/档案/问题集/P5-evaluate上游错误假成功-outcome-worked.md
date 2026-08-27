# P5-evaluate上游错误假成功-outcome-worked

## 现象
`browse_logged_in action="evaluate"` 在上游 chrome-devtools-mcp 执行失败（协议超时 / 无页面 / 脚本异常）时，lasso 返回 `outcome:"worked"`，错误字符串被当作正常返回值塞进 `data.preview`。调用方若只检查 outcome 会误判成功。

## 复现
两种实测形态（本轮亲历）：
1. Chrome wedge 时：每个 evaluate 返回
   `{"outcome":"worked","data":{"preview":"Network.enable timed out. Increase the 'protocolTimeout' ..."},"...}`（见 `.dedao-scout/02-ready.json`、`03-sidebar-hits.json` 等 6 个文件）；
2. 脚本自身抛错时：`{"outcome":"worked","data":{"preview":"Error: t is not defined\npptr:evaluateHandle;..."}}`（`42-audio-article-structure.json`）。
3. 0 页面时：`{"outcome":"worked","data":{"preview":"No page selected"}}`（`40/41`）。

## 白盒证据
`src/channels/BrowseChannel.ts` `doEvaluate`（约 L1058-1080）：
```ts
const r = (await c.callTool("evaluate_script", {...})) as EvaluateResult;
const v = parseEvalResult(r);            // 解析失败 → undefined
const preview = v == null
  ? extractEvalPreview(r)               // ← 直接把上游文本（含错误文本）当 preview
  : ...;
return { preview: truncatePreview(preview) };   // 无 throw → browseSingle 判 worked
```
- 对比同文件 `doWait`（v1.17.1 已修的同类问题）：`if (r.isError) throw wait_timeout`——wait 有 isError 检查，evaluate 没有；上游错误页文本（"Network.enable timed out" / "No page selected" / JS 堆栈）都会落进 `extractEvalPreview` 的兜底分支。
- 与历史修法同款先例：W-DEF-R11-1 注释明言「上游超时以 isError 响应返回……此前不检 → 假成功」并在 wait 上修复——evaluate 是同一病未治。

## 判断
**产品缺陷 → 修复优化（跑门禁）**。tri-state 诚实性破坏：错误被包装成 worked，正是一系列「页面没动还在傻等」工作流事故的温床（本次 wedge 期间探察脚本就多烧了 3 分钟空转）。

修复建议：
1. `doEvaluate` 检查 `r.isError` → `throw new Error("eval_upstream_error:" + detail)`（classifyBrowseError 落 unknown，可重试）；
2. `extractEvalPreview` 兜底分支对已知错误签名（`Network.enable timed out` / `No page selected` / `pptr:` 前缀堆栈）显式 throw，避免依赖 isError 标志不全的上游形态；
3. 脚本自身异常（`Error: xxx\npptr:evaluateHandle` 文本形态）也应转 didnt/unknown 而非 worked；
4. 门禁：`npm test` 补 evaluate isError → 非 worked 的单测（mock callTool 返 isError 即可，与 doWait 的既有测试同范式）。

调用方临时规避：解析 `data.preview` 前先检 `/^(Error:|Network\.enable|No page selected|Script ran)/` 前缀。

## 修复记录（v1.18.1，已修复）

`src/channels/BrowseChannel.ts` `doEvaluate`（与 doWait W-DEF-R11-1 同范式）：

1. `r.isError` → `throw eval_upstream_error:<preview 前 120 字>`（白盒核实：上游 script.js `performEvaluation` catch 后经 `__disposeResources` 重抛 → SDK isError 响应——实测三形态全走此路，主修）；
2. 兜底签名：`v == null`（无 ```json 围栏 = 响应非脚本值形态）时窄匹配三条正则（`timed out. Increase the 'protocolTimeout'` / `^Error:…\bpptr:` / `^No page selected$`）→ 同 throw（isError 标志不全的形态防御；窄锚定防误伤页面文案）；
3. classifyBrowseError 落 unknown（可重试语义保持）。

测试：`test/unit/browse-upstream-contract.spec.ts` P5 describe 5 用例（三形态不再 worked / 围栏内同文案字符串不误伤 / 正常路径回归）。门禁：build ✅ / 2308 passed / 82 INV。
