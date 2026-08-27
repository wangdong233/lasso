# lasso/doc 导读

> Lasso（npm `lasso-mcp`）doc/ 目录索引。更新：2026-08-27（v1.18.5 · **结构深度重整**）。
> 规则：本文件只做导读与新鲜度对账，**不改写任何编号文档语义**；决策记录是不可变审计史（勘误上版，不回改）。

## 目录结构与编号规则（2026-08-27 重整确立）

```
doc/
├── usage/        使用向手册（npm 用户与日常操作）      01-03 组内序号
├── architecture/ 架构基线与排期（改代码前后必读）      01-02
├── testing/      功能测试清单                          01
├── governance/   审计与裁决档案（轻量 ADR，按时间线）   01-10
├── history/      执行记录（测试执行证据本体，原样冻结）  01
├── bugs/         BUG 档案                              01-02
├── archive/      历史快照（parse 36 件 + research 17 件，编号保留原样不回改）
└── assets/       图片资产（打赏二维码）
```

**编号规则**：编号 = 组内序号（每组从 01 重新计数），不再使用全仓连续大编号。旧全局编号（08/09/17-29）已在本次重整中全量映射到新路径——正文与 src/test 注释中的引用已同步重写；`archive/` 内部为冻结快照，保留旧编号原样。
**旧→新映射速查**：08→architecture/01 · 09→architecture/02 · 17(清单)→testing/01 · 17(执行记录)→history/01 · 19→governance/01 · 21→02 · 22→03 · 23→04 · 24→05 · 25→06 · 26→07 · 27→08 · 28→09 · 29→governance/10 · KEY-GUIDE→usage/01 · TROUBLESHOOTING→usage/02 · SELECTOR-MAINTENANCE→usage/03 · BUG×2→bugs/01-02。
**已删除**：`20-文档同步审计.md`（过期自指快照，独特内容已沉淀进 architecture/02 与 ARCHITECTURE.md §15，原文见 git 历史 2ca2c0b）；`23a-03清单建议-方法论检讨.md`（单用途碎片，整体并入 governance/04 作附录A）。
**私有应用域**：得到课程批量抓取等私有内容已迁 `.private/`（gitignored，不入库、不进发布包），本仓 doc/ 不再包含该目录。

## ① usage/ — 使用向手册

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`usage/01-KEY-GUIDE.md`](usage/01-KEY-GUIDE.md) | 每个 key 用在哪、去哪申请、免费额度口径（90 天时效标注制度） | 活（轻核对至 v1.18.4；下次重核 ≈2026-11） |
| [`usage/02-TROUBLESHOOTING.md`](usage/02-TROUBLESHOOTING.md) | FAQ + error_kind 释义 + 浏览器静默/看门狗/reaper 排障（§2.16 rust-helper 四态门、§9 chrome-hide/粘滞看门狗） | 活（对齐 v1.18.4） |
| [`usage/03-SELECTOR-MAINTENANCE.md`](usage/03-SELECTOR-MAINTENANCE.md) | selector 债维护手册（生命周期 + 改版检测 + 升级流程） | 活（内容债见 governance/07 §2.6） |

另有根级 [`../README.md`](../README.md)（用户手册：安装 / 配置 / 17 工具清单 / 隐私 / changelog，中英双语）。

## ② architecture/ — 架构基线与排期（改代码前后必读）

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`architecture/01-功能架构.md`](architecture/01-功能架构.md)（原 08） | F 编号定义域的权威架构基线（冻结 2026-07-21，头部现状横幅） | 冻结基线（不回改） |
| [`architecture/02-实施排期.md`](architecture/02-实施排期.md)（原 09） | v0.1→v1.18.4 全周期排期，每版本一行决策记录 | 活（2026-08-27 补 v1.17.2-v1.18.4 六行） |

另有根级 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（面向贡献者的架构概览入口；头部 v1.17.2、正文散见 v1.18.x 增补，见 governance/07 §8 遗留 P0）。

## ③ testing/ + history/ — 功能测试

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`testing/01-功能测试清单.md`](testing/01-功能测试清单.md)（原 17 清单） | 全量功能测试清单（ft-round1 ALL-CLEAN + §6 简单架构 38 条终判 + v1.18 增补记录） | 活（增补至 v1.18.4） |
| [`history/01-功能测试执行记录/`](history/01-功能测试执行记录/ft-00-总结.md)（原 17-执行记录，252 件执行证据本体） | ft-round1 四面板 ~170 用例独立裁决：**ALL-CLEAN**；6 缺陷修复（含 2🔴安全级）；INV-76 出处 | 已收敛（v1.17.1）；证据冻结原样（内部路径为当时记录，不回改） |

## ④ governance/ — 审计与裁决档案（按时间线读 = 轻量 ADR 索引）

| 时间 | 目录 | 裁决性质 | 状态 |
|---|---|---|---|
| 2026-08-15→17 | [`governance/01-最优性审查轮次/`](governance/01-最优性审查轮次/00-总结.md)（34 件五轮） | 四域五轮白盒复审：候选 16→14→7→1→0 收敛 ROUND-CLEAN；方法学（裁决官不采信文档 / L0-L3 证据阶梯 / mutation 即验收） | 38 项全实施（v1.10-v1.13） |
| 2026-08-17 | [`governance/02-搜索方案重审/`](governance/02-搜索方案重审/verdict.md) | 搜索重审：机制达标 / 运行时诚实度未达标——Brave 免费档取消 + Bing 退役的运营事实清偿（S-1..S-5） | 已实施（v1.14） |
| 2026-08-17 | [`governance/03-Bing清除与serp_http/`](governance/03-Bing清除与serp_http/parse22.md) | 死层代码级清除（INV-54 墓碑）+ serp_http 快探层 | 已实施（v1.15） |
| 2026-08-17/18 | [`governance/04-方法论检讨-搜索优化失效.md`](governance/04-方法论检讨-搜索优化失效.md)（含附录A = 原 23a） | 方法论检讨：搜索优化失效根因 = 只在既有方案内比较 → 零基视角制度化（L-ZB / L-COST / 红队豁免） | 已制度化（governance/05 首跑） |
| 2026-08-18 | [`governance/05-颠覆性调研/`](governance/05-颠覆性调研/verdict.md)（10 件） | 零基重设计 + 红队 + 成本表 → 分级裁决 D-GO 3 / D-DECISION 3 / D-WATCH 8 / D-NOGO 9 | D-GO 已实施（v1.16）；D-DECISION 3 项交 governance/06；NOGO 9 项触发条件被 testing/01 §6 R-CI-06 引用 |
| 2026-08-18 | [`governance/06-五项裁决实施/`](governance/06-五项裁决实施/parse24.md) | 五项用户裁决：A1 quality 轴 / A2′ content_blocks / A3 删 zhipu 直连 / B1 search_local / C1 elicitation + C2 include_refs | 已实施（v1.17，INV-80/81） |
| （2026-08-17） | ~~20-文档同步审计~~（已删） | v1.8→v1.13 文档同步审计快照；后继 = governance/07 | 已删（2026-08-27；git 历史 2ca2c0b 可考） |
| 2026-08-18→27 | [`governance/07-文档查缺补漏/`](governance/07-文档查缺补漏/gap-matrix.md) | 文档盘点矩阵 + **F 编号 ↔ 现实映射表（§4 真源）** + 续盘 §8（仓迁/结构重整处置台账） | 活（续盘至 v1.18.5 结构重整） |
| 2026-08-19 | [`governance/08-静默性全面审计/`](governance/08-静默性全面审计/)（4 件 + 38 份真机证据） | 六维打扰面白盒+真机：查询/裸HTTP/无头/连用户 Chrome 全零打扰（S-7 tab 劫持修复） | 已实施（v1.17.2） |
| 2026-08-19/20 | [`governance/09-静默守则审计/`](governance/09-静默守则审计/)（6 件） | 静默守则入宪（INV-82）+ 得到实战五修 + 问题集 13 条终裁 | 已实施（v1.18.0/1） |
| 2026-08-20 | [`governance/10-错配机制审计/`](governance/10-错配机制审计/)（3 件） | 守卫对准真实威胁模型：错配四修 + 默认放行（src 注释引用最密 ×54） | PASS 裁决，已实施（v1.18.2） |

## ⑤ bugs/ — BUG 档案

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`bugs/01-rust-helper-relative-path.md`](bugs/01-rust-helper-relative-path.md) | rust-helper 相对路径致 desktop 通道全挂——根因/修复纪要/对抗复审/勘误制度示范（§9） | 已根治（v1.18.4） |
| [`bugs/02-chrome-idle-reaper-second-consumer.md`](bugs/02-chrome-idle-reaper-second-consumer.md) | idle reaper 误杀外部 CDP 消费者的 Chrome（R-INT-07 活案例；`--idle-ms 0` 缓解在档） | **活档**（根治未做，修复建议 §6 四级待裁决） |

## ⑥ archive/ — 历史档案（快照性质，不回改，编号保留原样）

| 目录 | 一句话定位 | 状态 |
|---|---|---|
| [`archive/parse/`](archive/parse/)（36 件） | v0.1-v1.10 执行史全集（parse1-18 + 各 acceptance + v14 契约），src/index.ts、architecture/02、usage/02 Q5 的引用锚 | 快照（2026-08-27 自 cc-control-all/doc/parse/ 抢救迁入） |
| [`archive/research/`](archive/research/)（16 件 + `搜索mcp工具/`） | 立项与演进调研全集：00-06 七路白盒调研、07 可行性、10-18 各专项（爬虫/登录态/白盒审查/资源占用），archive/research/14 §4.2d、16 §5 等被 src 注释引用 ×14 | 快照（同期抢救迁入；architecture/01 头部「上游」五链指向此处） |

## ⑦ assets/ — 图片资产

`assets/support-alipay.jpg` / `assets/support-wechat.jpg`——2 个 README（中 + 英）`<img src="doc/assets/support-*.jpg">` 引用。

## 新鲜度表（下次盘点在此续行）

| 文档 | 写到版本 | 最后同步 |
|---|---|---|
| ../README.md | v1.18.x（changelog 齐） | 2026-08-23 |
| ../ARCHITECTURE.md | 头部 v1.17.2（正文散见 v1.18.x 增补） | 2026-08-20（**遗留 P0**：§9 测试规模行停在 2253、INV 计数混写 81/82、CI 未入，见 governance/07 §8） |
| usage/01（KEY-GUIDE） | v1.18.4（轻核对；90 天时效标注 2026-08-17/18） | 2026-08-27 |
| usage/02（TROUBLESHOOTING） | v1.18.4（§2.16 + §9 新故障面） | 2026-08-27 |
| usage/03（SELECTOR-MAINTENANCE） | v1.13 + v1.15 局部（http-serp 消费面待补，见 governance/07 §2.6） | 2026-08-27（仅修头部断链） |
| architecture/01（基线冻结） | v0.x 快照 + 仓迁注 | 2026-08-27 |
| architecture/02（排期） | v1.18.4 | 2026-08-27 |
| testing/01（功能测试清单） | v1.18.4（v1.18 增补记录节） | 2026-08-27 |
| governance/01 | v1.10-v1.13（快照性质） | 2026-08-17 |
| governance/02 / 03 | v1.14 / v1.15 | 2026-08-17 |
| governance/04（含附录A） | 方法论（版本无关） | 2026-08-18 |
| governance/05 / 06 | v1.16 / v1.17 | 2026-08-18 |
| governance/07（盘点矩阵） | v1.18.5（§8 续盘含结构重整行） | 2026-08-27 |
| governance/08 / 09 / 10 | v1.17.2 / v1.18.0-1 / v1.18.2 | 2026-08-19/20 |
| bugs/01 | v1.18.4（已根治） | 2026-08-23 |
| bugs/02 | v1.18.3（缓解在档，根治待裁决） | 2026-08-26 |
