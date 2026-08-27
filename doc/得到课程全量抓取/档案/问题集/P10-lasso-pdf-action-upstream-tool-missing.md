# P10 — lasso `pdf` action 全灭：上游 chrome-devtools-mcp@1.7.0 根本没有 `pdf` 工具

- 时间：2026-08-19 13:40（抽取首批 3 子章节，extract-batch1.mjs）
- 影响面：`browse_logged_in` / `browse_headless` 的 `pdf` action（含 steps 链内 pdf step、独立 pdf 工具）在本机全部不可用。

## 现象

清理+打印按白盒设计走 `action:"evaluate" + options.steps:[{evaluate 清理},{pdf}]` 链（规避 NAV_FIRST 重导航，见 00-探察报告 §4.1），3 讲全部失败：

```
chain_failed:unknown:Error: upstream_pdf_error:is_error:MCP error -32602: Tool pdf not found
```

（DOM 侧全部成功：click 切讲、稳定、断言、清理 step 均正常，仅 pdf step 死。）

## 复现

任何一次 `browse_logged_in {action:"pdf"}` 或 steps 内 `{action:"pdf"}`。100% 复现。

## 白盒证据

1. `src/browse/cdp-actions.ts` L45-48：`CDP_UPSTREAM_TOOL_NAMES = { pdf: "pdf", ... }` —— 工具名硬编码为 `pdf`。
2. `src/subprocess/SubprocessManager.ts` L49：`LOCKED_CDP_MCP_VERSION = "1.7.0"` —— 上游锁死 1.7.0。
3. 上游实物（npx 缓存 `/private/tmp/npm-cache/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/build/src/tools/`）：目录只有 console / emulation / extensions / input / lighthouse / memory / network / pages / performance / screencast / screenshot / script / slim / snapshot / thirdPartyDeveloper / tools / webmcp —— **无 pdf 工具文件**。`Page.printToPDF` 字符串仅出现在 `third_party/index.js`（vendored puppeteer 代码），未被包装成 MCP tool。
4. 运行证据：`MCP error -32602: Tool pdf not found`（上游 zod/tool 注册表拒绝）。
5. lasso 自知此风险但未拦：`src/doctor/doctor.ts` L2030-2036 有 #26 `cdp_mcp_pdf_tool_available` Go/No-Go 探测注释；`cdp-actions.ts` L95-97 注释也写明上游缺失时包成 `upstream_unsupported:pdf`——但实测错误路径落 `outcome:unknown`（classifyBrowseError 不识别 `upstream_pdf_error` 前缀），且单 action `pdf` 还会先走一次 NAV_FIRST 白导航。

## 判断

**产品缺陷 → 修复优化（须跑门禁）**。锁定的上游版本与硬编码工具名不匹配，「上游工具名漂移只改一张 Map」的 INV 设计（cdp-actions.ts 头注释）没有兑现到版本锁定层。修复方向三选一：

- a) 升级 `LOCKED_CDP_MCP_VERSION` 到暴露 `pdf` 工具的版本（先核上游 CHANGELOG）；
- b) `doPdf` 绕开上游工具、直发 CDP `Page.printToPDF`（lasso 场景本就持有 CDP 端口）；
- c) 最小修：启动时探测工具缺失 → `pdf` action 直接 `didnt + retrieval_method:"upstream_unsupported:pdf"`（把注释里承诺的语义真正落地，别再先 NAV_FIRST 白导航一次）。

## 对本任务的处置（已绕过，未改产品代码）

打印改由抽取脚本直连 `http://127.0.0.1:9226` CDP：`/json/list` 选 dedao tab → WebSocket → `Page.printToPDF`（A4、printBackground:true、margin 0.4in）。清理仍走 lasso evaluate；清理 evaluate 返回后到打印之间无任何导航，清理态保持。参考实现：`/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/extract-batch2.mjs` 的 `cdpPrint()`。

## 修复记录（v1.18.1，已修复——采纳方向 c 最小修；a/b 另立后续）

裁决：方向 a（升级 LOCKED 版本）需全工具面契约回归，风险不成比例；方向 b（doPdf 直发 CDP）在 headless 通道无已知端口（上游自管浏览器），架构性改造。**本轮落地方向 c**，另补一条分类修复：

1. **前置门**（`src/browse/cdp-actions.ts` 新 `ACTION_TO_UPSTREAM_TOOL` 查表 + `src/channels/BrowseChannel.ts` `isUpstreamToolMissing`）：pdf/network/console 三 action 在 browseSingle **导航之前**经 `listTools` 判工具缺失 → `didnt + retrieval_method:"upstream_unsupported:<action>"`——单 action 白导航（logged_in 场景还会换掉当前页）被消除；per-client WeakMap 缓存（每上游子进程只探一次）；listTools 探测失败 → 放行（不猜，让真调用浮出真错误）。
2. **分类修复**（`classifyBrowseError`）：`upstream_unsupported:` / `/tool \S+ not found/` / `unknown tool` → `didnt`（确定性缺失，重试/fallback 无济于事）——steps 链 pdf step 死后不再 `chain_failed:unknown` 假可重试（实测错误 "Tool pdf not found" 含工具名，宽签名 `tool not found` 匹配不上，已用正则覆盖）。
3. 既有 `pdf` 工具层 `isUpstreamPdfUnsupported`（didnt + next_step）不动，语义贯通。

测试：`test/unit/browse-upstream-contract.spec.ts` P10 describe 5 用例（缺失→didnt+零导航 / 在列→放行 / 探测失败→放行 / per-client 缓存 / -32602 直传→didnt）+ mock 升级为 1.7.0 真实工具面（含 network/console、不含 pdf）。门禁：build ✅ / 2308 passed / 82 INV。

后续（未实施，记录去向）：若上游某版本重新暴露 pdf 工具，前置门自动放行、零代码改动；届时再评估方向 a。
