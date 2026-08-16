# round1 手测清单（真机验证归档）

> 归属：round1-verdict T1 / T2 / T7 / T11 验收项（CI 无 GUI / 无 TCC 弹窗，
> 真机行为按项目「uia/atspi 诚实 pending」先例归档，不伪造已验证）。
> 本机环境：macOS 12（Darwin 21.6.0）。日期：2026-08-17。
> 状态图例：✅ 已验证 / ⏳ 待真机验证 / N/A 本机不可验（版本门槛）。

---

## A. T1 chrome-devtools-mcp 0.3.0 → 1.7.0 迁移

| # | 项 | 命令/方法 | 状态 |
|---|---|---|---|
| A1 | npx 拉 1.7.0 启动 banner 正常（--headless --isolated --no-usage-statistics） | `npx -y chrome-devtools-mcp@1.7.0 --headless --isolated --no-usage-statistics` | ⏳ |
| A2 | 启动 banner 无 "Google collects usage statistics" 提示行（遥测关） | 同上，看 stderr | ⏳ |
| A3 | 四通道 smoke：headless navigate example.com → worked | `npx -y lasso-mcp` 会话内 browse_headless | ⏳ |
| A4 | 四通道 smoke：logged_in attach localhost:9222 | 用户 Chrome --remote-debugging-port=9222 起 + browse_logged_in | ⏳ |
| A5 | Steel mock 契约（--browser-url=http://host:9223 + --no-usage-statistics） | 单测已覆盖（cdp-mcp-170-migration.spec.ts） | ✅ mock 层 |
| A6 | Browserbase mock 契约（--wsEndpoint=wss://... + --no-usage-statistics） | 同上 | ✅ mock 层 |
| A7 | wait_for 数组契约真实上游 zod 接受（-32602 不出现） | browse_headless action=wait expect.text=任意 | ⏳ |
| A8 | evaluate_script 函数表达式契约 1.7.0 保持（markdown 抽取可用） | browse_headless action=extract extract_mode=markdown | ⏳ |

## B. T2 launch 级 UA / viewport（sannysoft）

| # | 项 | 方法 | 状态 |
|---|---|---|---|
| B1 | bot.sannysoft.com UA 行绿（UA 非 HeadlessChrome） | browse_headless → https://bot.sannysoft.com/ → snapshot 看 "User Agent" 行 | ⏳ |
| B2 | navigator.webdriver 行绿 | 同上页 "WebDriver" 行 | ⏳ |
| B3 | HTTP 头 UA 与 navigator.userAgent 一致（httpbin 回显） | browse_headless → https://httpbin.org/user-agent → snapshot 比对 UA 值 = profile UA | ✅ review03（服务器端回显逐字节 = profile UA，Chrome/151） |
| B4 | viewport 生效（--viewport=1920x1080） | browse_headless evaluate `() => [innerWidth, innerHeight]` | ✅ review03（真机 1.7.0 冒烟 innerWidth/Height=1920/1080） |
| B5 | profile=mac_safari_17 时 UA flag 跟随（Safari UA） | 同 B3 换 profile | ⏳ |

## C. T7 CGEvent 鼠标（真机 macOS 12）

| # | 项 | 方法 | 状态 |
|---|---|---|---|
| C1 | cgevent leftclick @(x,y) 真点击（计算器按数字） | 打开 Calculator，desktop act click ref → 档3 坐标点击 | ⏳ |
| C2 | scroll wheel 方向正确 | 记事本/长页面滚动 | ⏳ |
| C3 | drag from→to（拖窗口） | 拖 TextEdit 标题栏 | ⏳ |
| C4 | move 不点击（悬停语义） | 悬停菜单展开项 | ⏳ |
| C5 | INV-28 风格：无 raw button code 字面量 | rust 单测 + check-invariants | ✅ 静态层 |

## D. T11 Event Synthesizing TCC（macOS 15+）

| # | 项 | 方法 | 状态 |
|---|---|---|---|
| D1 | macOS 15+ tcc 探测返 event_synthesizing 维度 | doctor --json | N/A（本机 12；<15 路径返 not_required 已单测） |
| D2 | 拒绝时 error_kind=tcc_event_synthesis_denied 引导文案 | 单测已覆盖错误映射 | ✅ 映射层 |

## E. T3 ax_act（真机 macOS 12 AXAPI）

| # | 项 | 方法 | 状态 |
|---|---|---|---|
| E1 | click 经 AXPress（计算器按钮） | desktop observe → act click @eN | ⏳ |
| E2 | type 经 AXSetValue + 写后读回（TextEdit 输入） | desktop act type | ⏳ |
| E3 | scroll 经 AXScrollToVisible | 长列表 | ⏳ |
| E4 | stale_ref：observe 后 UI 变化再 act → didnt + stale_ref | observe → 关窗 → act | ⏳ |
| E5 | secure 字段豁免读回比对（密码框 type 不比对） | 密码框输入 | ⏳ |

---

> 纪律：真机验证完成后回填本表并打 ✅；CI 可验部分全部落在 vitest / check-invariants，
> 本清单只收 CI 不可验项（守 INV-30 anti-gaming 与 tri-state 诚实红线）。

## review03 增补验证（2026-08-17，第 1 轮 03 审查测试员）

以下项由 review03 在真机（macOS 12 + chrome-devtools-mcp@1.7.0 实跑）关闭或推进：

- **B3 / B4 ✅**（见上表；服务器端 httpbin 回显 = launch flag 真到网络层）
- **T1 核心 ✅**：1.7.0 以 v1.11 全套 spec flags 实跑成功（--no-usage-statistics /
  --chromeArg×2 / --viewport / --headless / --isolated）；`wait_for {text:[array]}`
  被接受、`{text:string}` 被拒（契约翻转实锤）；list_network_requests 真实行
  `reqid=1 GET https://example.com/ [200]` 被 dist 端 parseNetworkRequestLines
  正确解析（T5 解析器 L2 证据）。冒烟脚本：`round1-smoke-headless.mjs`（14/14 PASS）。
- **T3 部分推进**：真机验 find/act 编号一致性（review03 F2 修复后 12==12 / 24==24）、
  out-of-range→stale_ref、press→ax_unsupported_action、bad-ref→invalid_params。
  E1-E5 的真实 AXPress/AXSetValue/AXScrollToVisible 执行仍在活跃用户会话上不可
  无害执行，保持 ⏳（不伪造）。
