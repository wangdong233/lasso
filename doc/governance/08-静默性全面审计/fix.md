# 27 · 静默性全面审计 —— 修复与文档轮（fix.md）

- **日期**：2026-08-19
- **输入**：`verify.md`（真机矩阵 + 非静默点清单）+ `audit.md`（白盒理论矩阵）
- **版本**：v1.17.1 → **v1.17.2**（有代码修复，bump）
- **门禁**：`npm run build` ✅ / `npm test` **135 文件 2253 passed + 1 skipped**（基线 2240，+13 补测，不减；两轮全绿在档）✅ / `npm run check-invariants` **81/81** ✅
  - flake 记录（与本轮改动无关，如实声明）：满载并行下偶发 `expect-poll.spec.ts`（`|timing-sensitive|` 项目）/ `profile-switch.test.ts` 各 1 次抖动——两测试单独复跑恒绿（4/4、43/43），模块本轮零触碰；满载时序敏感为既有特性。
- **修复机制 L3 真机复核**：`verify-data/s7fix-l3.mjs` + `s7fix-l3-result.json`（隔离临时 profile + `--no-startup-window` + `--mute-audio` 零打扰跑通）——真实 Chrome 150 + 真实上游 cdm 1.7.0 下：`select_page{pageId}` 不带 bringToFront **frontmost 恒不变**（立即+1s 双采）；lasso 流程后 **pages[0]（替身用户首 tab）URL 前后不变**（S-7 修复核心断言）；自建 tab 被 navigate 至目标 URL 且上游选中=自建页；窗口恒 0、mute flag 在位、结束端口释放/进程零残留/前台还原。**id-diff 第 2 轮才命中（`id_diff_attempts:2`）——实装里的有界重试被真实需要**。

## 1. 修复清单（判据：低风险 + 明确收益）

### F-1 · S-7 修复 —— 连「用户自开 Chrome」不再劫持 pages[0]（src/channels/LoggedInChannel.ts）

- **缺陷**（verify.md §5c 两轮复现）：上游 chrome-devtools-mcp@1.7.0 连接即 `selectPage(pages[0])`，lasso 的 navigate 改写**用户第一个 tab** 的内容（零焦点、用户无感 = 最重隐性打扰面）。
- **机制**（全部只用已实证零打扰原语）：
  1. `CdpClient.createBackgroundTarget`（`Target.createTarget {background:true}`，E7 两次复测零抢焦）自建后台 tab；
  2. 上游 `list_pages` 前后 **id-diff 唯一归因**（上游 pageId 是进程内单调计数器；diff 而非取最大 id，防与用户同刻手开 tab 竞态误归因；两轮 300ms 重试容 targetCreated 事件异步）；
  3. `select_page {pageId}` **不带 bringToFront**（上游 pages.js：激活严格 opt-in，省略 = 纯上下文指针切换；verify.md §5b 真机实证 select_page 不抢 OS frontmost）。
- **生命周期**：自建 tab 晚于 `TabSession.takeSnapshotIfAbsent` → 属快照后新增 → 会话收尾 restore 关它（用户 tab 栏零残留）。幂等（同上游生命周期 ownPageId + lastClient 实例判 respawn 重置）。
- **判定门**：只对**非台账** Chrome（= 用户自开可见 Chrome）生效——hidden 台账走既有 precreate；visible 台账是「看着干」语义不动。
- **降级**：列表不可解析 / 归因不唯一 / CDP 不可达 / select 拒绝 → warn 维持旧行为（S-7 边界如旧），永不阻断 browse。

### F-2 · S-10 修复 —— close_page 契约 + 所有权机械化（src/logged-in/TabRegistry.ts）

- **缺陷**：① 旧 `close_page {url}` 在 1.7.0 wire 级必被 zod 拒（-32602，verify.md §5e）→ LRU 淘汰从未生效；② 旧 reconcile 把 list_pages 全部 URL 入册（含用户 tab）——契约一旦修好，「淘汰」将关用户 tab（audit.md S-10 预言的事故面）。
- **修复**：① 按 `{pageId}` 关（新增 `parseUpstreamPageEntries` 解析 1.7.0 真实文本格式 `<id>: <title> (<url>) [selected]`）；② **登记制所有权**：`noteOwnPage` 只由 F-1 成功路径登记，reconcile 只触达已登记页——「close_page 只可能落在 lasso 自己开的 tab 上」由集合定义保证（红线机械化，同 TabSession diff 守卫范式）；陈旧条目按列表修剪（页已关 / 上游 respawn id 重置）。
- **联动**：上游 respawn（lastClient 变更）→ `resetOwnPages()` 清登记。

### F-3 · INV-78(d) 精化（src/invariants/check-invariants.mjs，81 条不减）

- `bringToFront` **token 级零命中**（作用域内任何 select_page 调用都不可能携带激活开关——机械化闭环）；
- 新增 `"new_page"` quoted 禁令（1.7.0 默认 background:false = 前台开页）；
- `select_page` 禁令精化为**实装锚**（必须存在于 LoggedInChannel + 护栏日志事件 `logged_in_own_page_selected`）。

## 2. 不可修边界固化（诚实文档，零代码）

| 边界 | 为什么不可修 | 固化位置 |
|---|---|---|
| desktop 物理键鼠占用 | CGEvent 物理合成 + AXFocused 是功能本体 | README 矩阵 / KEY-GUIDE |
| launch-chrome hidden 的 Dock 图标 | 有头 Chrome 注册 Foreground ASN（lsappinfo 实证）；LSUIElement 由 Info.plist 控制、lasso 无法改用户 Chrome 的包 | KEY-GUIDE v1.10 note（补机制说明 + headless 无此问题实证） |
| visible 档抢焦点/弹窗 | 用户显式选择「看着干」= 语义 | README 矩阵 / KEY-GUIDE |
| 用户 Chrome 不静音 | 零注入铁律（谁的 Chrome 听谁的） | README 矩阵 / TROUBLESHOOTING §8.1（自配三件套指引） |
| 后台 tab hasFocus 仿真 | 上游 multi-agent 设计（McpPage.emulateFocusedPage）；真机证明不抢 OS 焦点 | README 矩阵脚注 |
| CLI 起 Chrome 无 idle 回收 | 回收器活在 server 进程 | KEY-GUIDE（既有） |

## 3. 文档四件

1. **README.md**：隐私与安全新增「静默性矩阵」（用户语言，通道 × 六维 + 连用户 Chrome 三条边界）；诚实边界行升级（删「个别操作可能抢一次焦点」旧表述——真机未复现，换 S-7 已修复后的新边界）；changelog v1.17.2。
2. **doc/usage/01-KEY-GUIDE.md**：B 节边界表述按 verify.md §7 建议重写 + v1.17.2 精修 note。
3. **doc/usage/02-TROUBLESHOOTING.md**：新增 §8.0 速查（指向 doc/governance/08 + 用户向矩阵）+「第一个 tab 被导走」症状条目（版本判定 + 降级态日志锚 `logged_in_own_page_*`）。
4. **ARCHITECTURE.md**：§9 安全面新增「静默性」条目（S-7/S-10 机制 + 边界 + 守卫）；§12.2 browse_logged_in 数据流补 getMcpClient 全序；版本/测试数对齐 v1.17.2 / 2253。

## 4. 测试（+13 净增）

- `test/unit/tab-registry.spec.ts` 重订：1.7.0 真实文本格式 parser 4 例；所有权边界 4 例（未登记页即使 selected 也不入册不 close / 登记-重置 / 空响应保守 no-op）；`close_page {pageId}` wire 契约 + 11 页超 cap 淘汰 + MRU 提升 + 已关页修剪。
- `test/integration/logged-in-own-page.spec.ts`（新，7 例）：S7-1 happy path（select_page 精确 `{pageId}` 无 bringToFront）/ S7-2 快照先于建塔 / S7-3 幂等 / S7-4 台账判定门（hidden 建塔来自既有 precreate、select 零调用）/ S7-5 归因不唯一降级 / S7-6 空响应降级 / S7-7 respawn 重置重归因。
- 版本对齐测试三处 1.17.1 → 1.17.2（INV-63 三处锚 + 两处 doctor 断言）。

## 5. 03 审查（六维）结论

见本目录 `review-03.md`。
