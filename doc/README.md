# lasso/doc 导读

> Lasso（npm `lasso-mcp`）doc/ 目录索引。更新：2026-09-16（v1.27.0 预写态 · BUG-09 **尾款批 doc 收卷终态**——§7.2 移交项 1/2/3 三清偿核验落档〔§8.H〕+ 新鲜度对账至尾款轮+合并轮后；上轮 DocAudit 见 git `9ed9cfc`、上轮 doc 收卷见 `9b7ee97`，删除类处置见 [整理决议-2026-09-16.md](整理决议-2026-09-16.md) 先报后删）。
> 规则：本文件只做导读与新鲜度对账，**不改写任何编号文档语义**；决策记录是不可变审计史（勘误上版，不回改）。

## 目录结构与编号规则（2026-08-27 重整确立）

```
doc/
├── usage/        使用向手册（npm 用户与日常操作）      01-03 组内序号
├── architecture/ 架构基线与排期（改代码前后必读）      01-02
├── testing/      功能测试清单                          01
├── governance/   审计与裁决档案（轻量 ADR，按时间线）   01-12
├── history/      执行记录（测试执行证据本体，原样冻结）  01
├── bugs/         BUG 档案                              01-10（+04-附录E）
├── 根级 *.md     渲染档文档组（决议/需求/对接/配方/裁决/提案/登记，见 ⑦）
├── archive/      历史快照（parse 36 件 + research 17 件，编号保留原样不回改）
├── assets/       图片资产（打赏二维码）
└── 整理决议-2026-09-16.md（DocAudit 轮删除清单，先报后删，临时文件）
```

**编号规则**：编号 = 组内序号（每组从 01 重新计数），不再使用全仓连续大编号。旧全局编号（08/09/17-29）已在本次重整中全量映射到新路径——正文与 src/test 注释中的引用已同步重写；`archive/` 内部为冻结快照，保留旧编号原样。
**旧→新映射速查**：08→architecture/01 · 09→architecture/02 · 17(清单)→testing/01 · 17(执行记录)→history/01 · 19→governance/01 · 21→02 · 22→03 · 23→04 · 24→05 · 25→06 · 26→07 · 27→08 · 28→09 · 29→governance/10 · KEY-GUIDE→usage/01 · TROUBLESHOOTING→usage/02 · SELECTOR-MAINTENANCE→usage/03 · BUG×2→bugs/01-02。
**已删除**：`20-文档同步审计.md`（过期自指快照，独特内容已沉淀进 architecture/02 与 ARCHITECTURE.md §15，原文见 git 历史 2ca2c0b）；`23a-03清单建议-方法论检讨.md`（单用途碎片，整体并入 governance/04 作附录A）。
**私有应用域**：得到课程批量抓取等私有内容已迁 `.private/`（gitignored，不入库、不进发布包），本仓 doc/ 不再包含该目录。

## ① usage/ — 使用向手册

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`usage/01-KEY-GUIDE.md`](usage/01-KEY-GUIDE.md) | 每个 key 用在哪、去哪申请、免费额度口径（90 天时效标注制度） | 活（轻核对至 v1.18.4；下次重核 ≈2026-11） |
| [`usage/02-TROUBLESHOOTING.md`](usage/02-TROUBLESHOOTING.md) | FAQ + error_kind 释义 + 浏览器静默/看门狗/reaper 排障（§2.16 rust-helper 四态门、§9 chrome-hide/粘滞看门狗） | 活（对齐 v1.18.7；P2 轮修 §2.13 死链） |
| [`usage/03-SELECTOR-MAINTENANCE.md`](usage/03-SELECTOR-MAINTENANCE.md) | selector 债维护手册（生命周期 + 改版检测 + 升级流程） | 活（内容债见 governance/07 §2.6） |
| [`usage/04-工具示例体系.md`](usage/04-工具示例体系.md) | 工具示例体系设计决议（示例正典 B 表 = 全仓唯一真源；L1/L2/L3 分层放置 + truth spec 防漂移） | 决议（2026-09-16；实施分期 P0-P2 见文内） |

另有根级 [`../README.md`](../README.md)（用户手册：安装 / 配置 / 17 工具清单 / 隐私 / changelog，中英双语）。

## ② architecture/ — 架构基线与排期（改代码前后必读）

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`architecture/01-功能架构.md`](architecture/01-功能架构.md)（原 08） | F 编号定义域的权威架构基线（冻结 2026-07-21，头部现状横幅） | 冻结基线（不回改） |
| [`architecture/02-实施排期.md`](architecture/02-实施排期.md)（原 09） | v0.1→v1.18.7 全周期排期，每版本一行决策记录 | 活（2026-08-31 P2 轮补 v1.18.5/6/7 三行） |

另有根级 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（面向贡献者的架构概览入口；P2 处置轮已刷新至 v1.18.7：头部版本/分层图/§9 计数——governance/07 §8 遗留 P0 销账）。

## ③ testing/ + history/ — 功能测试

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`testing/01-功能测试清单.md`](testing/01-功能测试清单.md)（原 17 清单） | 全量功能测试清单（ft-round1 ALL-CLEAN + §6 简单架构 38 条终判 + v1.18 增补记录） | 活（增补至 v1.18.4；计数基线另见 ../ARCHITECTURE.md §9 v1.18.7 行） |
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
| 2026-08-31 | [`governance/11-P2处置台账.md`](governance/11-P2处置台账.md)（1 件） | wf_c02ef3df 全量 P2（34+22 去重 46 项）三档裁决：20 修 / 25 留档 / 1 已偿（r3 已偿） | 已实施（v1.18.7 处置轮，单 commit） |
| 2026-09-09 | [`governance/12-回告收口与交付物测试载体决议.md`](governance/12-回告收口与交付物测试载体决议.md)（1 件） | cc-control 09-08 深检回告收口：附录E 样例回修三缺陷 + **交付物必须自带测试载体**制度（deny-browser-kill.mjs 落仓 + 14 向量测试 + 文档同步锚新机制） | 已实施（v1.22.1，单 commit） |

## ⑤ bugs/ — BUG 档案

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`bugs/01-rust-helper-relative-path.md`](bugs/01-rust-helper-relative-path.md) | rust-helper 相对路径致 desktop 通道全挂——根因/修复纪要/对抗复审/勘误制度示范（§9） | 已根治（v1.18.4） |
| [`bugs/02-chrome-idle-reaper-second-consumer.md`](bugs/02-chrome-idle-reaper-second-consumer.md) | idle reaper 误杀外部 CDP 消费者的 Chrome（R-INT-07 活案例；§9 闭环纪要） | 已根治（v1.18.6，§9 闭环纪要——fb4f790 §6 四条建议全落地 + 隐藏洞补全） |
| [`bugs/03-2026-09-07-hidden档劫持用户Chrome激活.md`](bugs/03-2026-09-07-hidden档劫持用户Chrome激活.md) | 事故级用户主权双违反（裸 kill 原生 Chrome + Dock 激活被 hidden 档压回）——停机三维谓词 / 端口占用归因 / user_taken_asset 永不代杀 | 已根治（v1.21.0，INV-85/86/87） |
| [`bugs/04-2026-09-08-选中页死锁与归属鉴定chrome-status.md`](bugs/04-2026-09-08-选中页死锁与归属鉴定chrome-status.md) | 选中页死锁自愈 + `chrome-status` 十分类归属鉴定（allowed_commands/must_report）+ `--zombie-gate` 唯一机器代杀出口 | 已根治（v1.22.0，INV-88/89） |
| [`bugs/04-附录E-cc-control答复与hook交付包.md`](bugs/04-附录E-cc-control答复与hook交付包.md) | PreToolUse hook 硬拦样例（deny-browser-kill.mjs）+ 文档同步锚（附录E ↔ 仓内权威副本逐字节一致，governance/12 制度） | 活（README v1.22.0 引用；样例本体在 scripts/hooks/） |
| [`bugs/05-2026-09-09-消费方台账L1-L3-navigate死参数-file白名单-console暴露面.md`](bugs/05-2026-09-09-消费方台账L1-L3-navigate死参数-file白名单-console暴露面.md) | novel-engine 消费方台账 L1-L3：navigate 死参数 / `LASSO_ALLOW_FILE_FROM` file 白名单 / console 暴露面 | 已根治（v1.23.0，INV-90/91/92/93） |
| [`bugs/06-2026-09-10-日常档idle0幽灵常驻-硬顶与配方治理决议.md`](bugs/06-2026-09-10-日常档idle0幽灵常驻-硬顶与配方治理决议.md) | 12h 幽灵常驻事故——`--idle-ms 0` 语义改「不自收 + 24h 硬顶」+ 跨进程活动真源 + 配方治理 | 已根治（v1.24.0，INV-94） |
| [`bugs/07-2026-09-10-消费方台账L4-截图必经重导航无法截当前页面状态.md`](bugs/07-2026-09-10-消费方台账L4-截图必经重导航无法截当前页面状态.md) | 消费方台账 L4：`action=screenshot` 省略 url = 截当前受管页（零导航） | 已根治（v1.25.0，INV-95） |
| [`bugs/08-2026-09-15-商标查询马拉松-五组修复决议.md`](bugs/08-2026-09-15-商标查询马拉松-五组修复决议.md) | 反爬马拉松 A-F 六组决议：evaluate 预算/超时类型化 + sidecar 治理 browser_recycle + freshProfile 逃生门 + hash 导航默认 reload + 端口三层解析/fetch 细分 + vitest threads/gate 追杀带 | 已实施（v1.26.0 预写，INV-96；§9 实施定稿 + §11 对抗复审 + §12 F 组） |
| [`bugs/09-2026-09-16-反爬根治通道与url语义统一决议.md`](bugs/09-2026-09-16-反爬根治通道与url语义统一决议.md) | 反爬根治通道（防御梯 L0/L1/L2 + `browse_headed` 有头档两态生命周期）+ url 语义统一（单一 ensure-navigation，假数据面根治）+ P2 批 C1-C5；r1 设计修订 + §5r2/§5r3 两轮对抗否定复审 + §7 实施定稿 + §8 尾款轮 | **定稿（尾款清偿+收卷终态，v1.27.0 预写）**：B/C1-C5/HeadedChannel 已合并三轮复审 clean；**§7.2 移交项 1/2/3 全清偿**——WT4 驱逐哨兵（§8.A/8.F，INV-98 真锚）+ steps 链真值化（§8.B/8.E.1，INV-100）+ macOS occlusion 定案（§8.C/8.E.2，A.4④ 终值闭合）；§8.H 收卷终态核验；遗留仅开放项 6、R-INT-06 触发登记（**二次触发**，testing/01 ④′）、分支 ref 卫生 |
| [`bugs/10-2026-09-17-商标站滑块批-cgEvent投递证伪与回执语义决议.md`](bugs/10-2026-09-17-商标站滑块批-cgEvent投递证伪与回执语义决议.md) | 商标站滑块批：cgEvent 投递断裂**证伪**（三路白盒 + 受控计数器页——真凶=并发物理输入竞争）→「修复」重定向为**消灭静默失败**（决议 A：landing 回执 / 物理竞争检测 / doctor 光标 wiggle 自检〔opt-in〕/ TCC 探测诚实化）+ 决议 B evaluate 表达式自动返回（P2 静默错值根治）+ 决议 C desktop 截图默认落盘（P3 token 爆炸）+ 决议 D 检测面文档（P1 拦截面位移——TROUBLESHOOTING §2.18）；§5 双 worktree 拆分（U-R rust+desktop / U-B browse+docs，文件域互斥） | 定稿（2026-09-17，双单元实施中——U-B 半已落地：evaluateFunctionArg 五形态 + js_form 教学回执 + §2.18 + 描述 NOTE；U-R 半见其 worktree） |

## ⑥ archive/ — 历史档案（快照性质，不回改，编号保留原样）

| 目录 | 一句话定位 | 状态 |
|---|---|---|
| [`archive/parse/`](archive/parse/)（36 件） | v0.1-v1.10 执行史全集（parse1-18 + 各 acceptance + v14 契约），src/index.ts、architecture/02、usage/02 Q5 的引用锚 | 快照（2026-08-27 自 cc-control-all/doc/parse/ 抢救迁入） |
| [`archive/research/`](archive/research/)（16 件 + `搜索mcp工具/`） | 立项与演进调研全集：00-06 七路白盒调研、07 可行性、10-18 各专项（爬虫/登录态/白盒审查/资源占用），archive/research/14 §4.2d、16 §5 等被 src 注释引用 ×14 | 快照（同期抢救迁入；architecture/01 头部「上游」五链指向此处） |

## ⑦ 根级渲染档文档组（doc/*.md，2026-09-01~10 渲染档与 perf/acc 轮产物）

| 文档 | 一句话定位 | 状态 |
|---|---|---|
| [`渲染档设计决议.md`](渲染档设计决议.md) | 渲染档三项裁决定案（detached guardian / 冻结旗标 / 12 条细节收口；r2/r3 修订在档）——src/render/ 实施唯一依据，src ×8 引用 | 生效决议（v1.19.0 落地） |
| [`需求-渲染档浏览器治理.md`](需求-渲染档浏览器治理.md) | media-gen-mcp 提的 R1-R7 需求真源（P0 Chrome 泄漏事故背景） | 活（R7 重开条件仍被引用） |
| [`对接实施说明-渲染档x-media-gen-mcp.md`](对接实施说明-渲染档x-media-gen-mcp.md) | 消费方接口契约（ensure 协议逐字段 / 退出码 0-5 / 时序 / 双方义务） | 活（消费方 attach 依据） |
| [`渲染档-并行验收隔离配方.md`](渲染档-并行验收隔离配方.md) | 同机多 agent 并行验收三 env 命名空间隔离配方（排程车道表） | 活（README 中英双语链接） |
| [`性能准确率优化裁决表.md`](性能准确率优化裁决表.md) | perf/acc 专项轮裁决（PERF-1 npx registry 税 / PERF-2a 看门狗双宿主 / ACC-1①② 等） | 已实施（v1.19.0 立即修批） |
| [`提案-render-stop端口作用域化.md`](提案-render-stop端口作用域化.md) | `--stop` 端口作用域化提案 + §6 裁决落款（已实施 v1.20.0）——该行为唯一裁决依据 | 历史里程碑（保留原位：被 并行验收隔离配方 §0 引用） |
| [`登记问题-timing假红与退出契约与通用化.md`](登记问题-timing假红与退出契约与通用化.md) | 登记级开项台账：#8 timing 假红 / #9 独立脚本退出契约 / #10 R7 通用化重开条件 | 活（三项全开） |

## ⑧ assets/ — 图片资产

`assets/support-alipay.jpg` / `assets/support-wechat.jpg`——2 个 README（中 + 英）`<img src="doc/assets/support-*.jpg">` 引用。

## 新鲜度表（下次盘点在此续行）

| 文档 | 写到版本 | 最后同步 |
|---|---|---|
| ../README.md | v1.28.0 预写（BUG-10 U-B 半 changelog 双语齐——evaluate 契约 + §2.18；版本行仍 v1.27.1 随 package.json，发版时再升） | 2026-09-17 |
| ../ARCHITECTURE.md | v1.27.0 预写态（尾款轮+合并轮增补：§7/§10/§11/§14/§15/§16.7——尾款三件〔哨兵/链真值/occlusion〕+ 计数 **3120 passed + 1 skipped / 192 文件 / 100 INV 实装**；§14 v1.27.0 要点补齐 ⑧⑨） | 2026-09-16 |
| usage/01（KEY-GUIDE） | v1.27.0 预写（BUG-09 W2 批补 `LASSO_HEADED_IDLE_MS` / `LASSO_HEADED_HARD_CAP_MS` / `LASSO_FALLBACK_CROSS_CHANNEL` + file-from 三工具） | 2026-09-16 |
| usage/02（TROUBLESHOOTING） | v1.28.0 预写（BUG-10 决议 D：新增 §2.18 tm.aliyun.com 分层拦截面实测 + 「click worked ≠ 提交被接受」通则；v1.27.0 批 §2.17 驱逐释义；v1.26.0 批 §10 四配方） | 2026-09-17 |
| usage/03（SELECTOR-MAINTENANCE） | v1.13 + v1.15 局部（http-serp 消费面待补，见 governance/07 §2.6） | 2026-08-27（仅修头部断链） |
| architecture/01（基线冻结） | v0.x 快照 + 仓迁注 | 2026-08-27 |
| architecture/02（排期） | v1.27.0 预写（BUG-09 收卷轮：v1.26.0 行转 ✅ 已发布 + 新增 v1.27.0 ⏳ 行） | 2026-09-16 |
| testing/01（功能测试清单） | v1.27.0 预写（BUG-09 收卷轮补 R-INT-06 后记④触发登记——url 语义统一批触发「抽导航语义模块」义务未执行，顺延；**尾款批收卷轮补 ④′ 二次触发登记**〔S/T 双单元触碰 BrowseChannel.ts 2679 行，触发计数 2 次未执行〕） | 2026-09-16 |
| governance/01 | v1.10-v1.13（快照性质） | 2026-08-17 |
| governance/02 / 03 | v1.14 / v1.15 | 2026-08-17 |
| governance/04（含附录A） | 方法论（版本无关） | 2026-08-18 |
| governance/05 / 06 | v1.16 / v1.17 | 2026-08-18 |
| governance/07（盘点矩阵） | v1.18.5（§8 续盘含结构重整行） | 2026-08-27 |
| governance/08 / 09 / 10 | v1.17.2 / v1.18.0-1 / v1.18.2 | 2026-08-19/20 |
| governance/11 / 12 | v1.18.7 / v1.22.1 | 2026-08-31 / 2026-09-09 |
| bugs/01-02 | v1.18.4 / v1.18.6（已根治） | 2026-08-23/31 |
| bugs/03-10 | v1.21.0 / v1.22.0+附录E / v1.23.0 / v1.24.0 / v1.25.0 / v1.26.0 已发布 / v1.27.0 预写（**定稿·尾款清偿**，§7.2 移交项 1/2/3 全清 + §8.0-8.H）/ v1.28.0 预写（bugs/10，双单元实施中） | 2026-09-07~17 |
| 根级渲染档文档组（7 件） | v1.19-v1.20 落地面 + 登记开项 | 2026-09-10（登记 #10 最新核） |

## 历史遗漏盘点（BUG-09 尾款批 doc 收卷轮，2026-09-16）

上轮 doc 收卷（`9b7ee97`）之后 doc/ **零新增文件**（`git log --diff-filter=A -- doc/` 实测为空）——bugs/09 的 §8 尾款轮扩容（8.0-8.G 设计定稿/实施/合并记录 + 本轮 8.H）与 整理决议的对抗轮 2 勘误均为**既有文件内增长**，无未归位新文件、无未跟踪残屑（`git status --porcelain` 零输出）。**本轮无删除项**（先报后删原则下零候选）。分支 ref 卫生维持登记：`bug09-w1/w2/w3/wt4-a/wt4-b` 五条零未合并提交，`git branch -d` 均安全，归用户处置。src/test 侧尾款批新增 spec（eviction-sentinel / bug09-chain-truth / bug09-r2-description-truth 扩容）属代码树测试载体，不属 doc/ 归档面。
