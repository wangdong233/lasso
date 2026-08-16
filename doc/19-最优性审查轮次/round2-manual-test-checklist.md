# 第 2 轮调优手测清单（round2 T2-1/T2-7/T2-8/T2-12 真机项）

> v1.12.0。CI/单测覆盖纯逻辑面；本清单是真机（macOS + TCC 授权 + 真浏览器）才能验的物理路径。
> 范式沿 round1-manual-test-checklist.md（每项：前置 / 步骤 / 预期 / 状态）。
> 跑前：`npm run build`（dist/ 最新）+ `cargo build --release`（rust-helper 最新）。

---

## A. T2-12 — stdin EOF 即时收尾（进程生命周期）

- **前置**：dist/index.js 已 build；另开终端准备 `ps`。
- **步骤**：
  1. `node dist/index.js < /dev/null &`（stdin 立即 EOF）或正常 `claude mcp` 挂载后 `kill -9 <CC 进程>`（父进程死亡 → stdin EOF）。
  2. `ps aux | grep -E "lasso|chrome-devtools-mcp|rust-helper" | grep -v grep`。
- **预期**：Lasso 进程秒级退出（stderr 末行 `lasso_shutdown` 含 `"sig":"stdin_eof"`）；无 lasso/cdp-mcp/rust-helper 孤儿残留（旧版最长挂 1h）。
- **自动化对位**：`test/integration/stdin-eof-shutdown.spec.ts`（spawn + 关写端 + 断言退出）已绿——本项补 kill CC 真场景。
- **状态**：pending

## B. T2-1 rider — macOS 指纹 OS 级一致（echo server）

- **前置**：本机已装 Chrome；`STEALTH` 默认装配（darwin → mac_chrome）。
- **步骤**：
  1. 起本地 echo server：`node -e "require('http').createServer((q,s)=>{s.end(JSON.stringify({'user-agent':q.headers['user-agent'],'accept-language':q.headers['accept-language']||'(absent)','sec-ch-ua-platform':q.headers['sec-ch-ua-platform']||'(absent)','sec-ch-ua':q.headers['sec-ch-ua']||'(absent)'}))}).listen(18080)"`。
  2. 让 CC 走 `browse_headless` 打开 `http://127.0.0.1:18080` 并读回 JSON（沿 round1-smoke-headless.mjs 范式）。
- **预期**：`user-agent` 含 `Macintosh; Intel Mac OS X` **且** `sec-ch-ua-platform` 为 `"macOS"`——两者同 OS（旧 windows profile 会出现「UA 说 Windows、hints 招供 macOS」矛盾）。
- **T3-1 扩展（v1.13 round3）**：`accept-language` 主 token 与 profile 一致——mac_chrome 档案期望 `en-US,en;q=0.9,...`（修复前发宿主真值 `zh-CN,zh;q=0.9`，与页面 JS 层 `navigator.languages=["en-US","en"]` 自相矛盾）；页面内 `evaluate` 读 `navigator.languages[0]` 应与头的首 token 同值。旁证：`ps aux | grep accept-lang` 可见启动 flag `--chromeArg=--accept-lang=en-US,en;q=0.9`。
- **doctor 旁证**：`node dist/index.js doctor` → `stealth_profile_self_check` detail 应含「宿主默认 mac_chrome」+ 版本 skew 行（|skew|<2 正常；≥2 提示刷新 profile 值域）。
- **状态**：pending

## C. T2-7 — Electron 输入框 type 兜底（AXFocus + 键盘合成）

- **前置**：TCC Accessibility 授权 rust-helper；开一个 Electron 应用（Slack / VSCode 搜索框均可）。
- **步骤**：
  1. CC 走 `desktop` snapshot（app="Slack" 或含窗口名），找到搜索/输入框 ref（AXValue 不可写的控件即目标——find 结果该节点通常无 settable 值）。
  2. `desktop act`：`{kind:"type", ref:"@eN", text:"hello"}`。
- **预期**：v1.11 此场景 `ax_action_unsupported` 全链死；v1.12 兜底后真实输入 "hello"（整值替换：先 cmd+a 全选再逐键）。actions_and_results 该项 `ok:true`。
- **非 ASCII 边界**：text 含中文 → 该项 `ok:false` + `ax_type_non_ascii`（诚实拒绝，不猜）。
- **自动化对位**：rust `t27_*` 三测（分支判定/ASCII 门/keymap 全表）已绿。
- **状态**：pending

## D. T2-8 — drag 物理轨迹（滑条 / 拖拽排序）

- **前置**：TCC 同上；macOS 系统设置任一滑条（如 Sound 音量）或 Finder 图标拖拽。
- **步骤**：CC 走 `desktop act` 坐标形态：`{kind:"drag", from_x, from_y, to_x, to_y}`。
- **预期**：滑条真实跟随（200ms 按住 + 12 点插值 + 100ms 沉淀；总时长 ~500ms）；拖拽排序类目标提交 drop。旧版单事件 drag 在此类目标大概率不动。
- **click 旁证**：坐标 click 后挑剔 app（如菜单条）单击判定稳定（clickState=1 + 10ms 间隔）。
- **自动化对位**：rust `t28_*` 四测（clickState=1 / 时序参数 / 步数 ≥4 / 轨迹形状单调含终点）已绿。
- **状态**：pending

## E. T2-9/T2-11 — find actions + snapshot truncated（顺带真机抽查）

- **步骤**：`desktop find`（where text="新建"）→ 命中项应含 `actions:["AXPress",…]`（可按节点）；`desktop snapshot` max_depth=2 对 dense app（Slack/IDE）→ 顶层 `truncated:true` 出现；浅窗口（记事本）无该字段。
- **状态**：pending

---

# 第 3 轮调优手测项（round3 T3-1/T3-2 追加；v1.13.0）

## F. T3-2 — VLM 档 screenshot_region 坐标补偿（真机抽查）

- **前置**：TCC Accessibility + Screen Recording + Event Synthesizing（macOS 15+）授权；`LASSO_VLM_ENDPOINT` 已配。
- **步骤**：CC 走 `desktop act` 带 `screenshot_region`（如 `{x:100,y:200,w:640,h:480}`）+ actions 指向区域内一个已知可点元素（如窗口右上角关闭按钮），语言描述「点击区域内的 X」。
- **预期**：真实点到该元素（v1.13 前落点系统性偏移 `(region.x, region.y)`——点到的是「全屏坐标 (x,y)」而非「区域内 (x,y)」）；`actions_and_results` 的 ref 标签是平移后全局坐标 `vlm_click@(150,260)` 形态。
- **自动化对位**：`test/unit/screenshot-vlm-t26.spec.ts` T3-2 describe（region(100,200)+click(50,60)→wire(150,260)）已绿——本项补真机 VLM 视觉推断链。
- **状态**：pending

## G. T3-6 — VLM 档 tcc_event_synthesis_denied → didnt（真机权限场景）

- **前置**：同 F 但 **撤销** Event Synthesizing / Accessibility 授权（或用一台未授权机器）。
- **步骤**：同 F 的 act 调用。
- **预期**：outcome=`didnt` + error 含「System Settings → Privacy & Security → Event Synthesizing」引导（v1.13 前是含糊 `unknown: vlm_inference_only:execution_failed`；CGEventProvider 档同判——双消费者一致）。
- **自动化对位**：`test/unit/screenshot-vlm-t26.spec.ts` T3-6 describe（fakeRust 注入 error_kind 断言 didnt/引导文案/其他 error_kind 不回归）已绿。
- **状态**：pending
