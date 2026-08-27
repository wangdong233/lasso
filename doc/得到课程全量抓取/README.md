# 得到课程全量抓取 —— 可复用项目模板（内部自洽）

> 薛兆丰的经济学课 419 讲实战全量交付后沉淀的模板。**本目录自洽**：文档中提到的任何脚本/文件/示例都收录在本目录之内，可独立照做，不依赖目录外路径。后续新书按 README → 01 → 02 → 07 的顺序上手。

## 一句话方案

**登录态复用（隐藏 Chrome + CDP）→ 引擎逐章抽取（PDF+MD+images 三件套正典）→ 分片连续流式渲染 → 合并成书（TOC/页码/书签 + 六门禁 QC）**。

## 目录（按使用顺序读）

| 文档 | 内容 | 状态 |
|---|---|---|
| [01-方案.md](01-方案.md) | 整体架构与路线裁决（混合=引擎+薄壳；终局路线 b′：MD 正典+分片渲染+合并；K=2 并发裁决） | 已就 |
| [02-操作手册.md](02-操作手册.md) | 端到端操作：登录→枚举→produce→监控→merge 四步→交付（源：RUNBOOK 实战终态 + config.mjs 参数化） | 已就 |
| [03-skill使用说明.md](03-skill使用说明.md) | `skill/dedao-course-extract` 的安装、调用、参数化点 | 已就 |
| [04-脚本资产清单.md](04-脚本资产清单.md) | 每个脚本：职责/参数/依赖关系图 + 还原到可运行布局的说明 | 已就 |
| [05-注意事项与教训.md](05-注意事项与教训.md) | P1-P32 问题档案精华：静默纪律/激活与焦点/超时与守卫/视频课/虚拟列表/压缩阶梯 | 已就 |
| [06-质量门禁.md](06-质量门禁.md) | 章级五门禁 + 全书六门禁 + 零丢失红线 + 降级语义 + 门禁 FAIL 逐门归因到底（P32 铁律） | 已就 |
| [07-新书上路checklist.md](07-新书上路checklist.md) | 从登录到交付 10 步清单（换书只改 config.mjs） | 已就 |

## 核心资产（全部在本目录内）

| 资产 | 位置 | 说明 |
|---|---|---|
| 生产侧脚本 | [脚本/engine/](脚本/engine/) | config.mjs（课程配置唯一入口）/ engine.mjs / run-k2.mjs / backfill-imgs.mjs + probe 探察件×6 + selftest-gapfill.mjs + sweep-tail.mjs/watch-flicker.sh 收尾取证件 + RUNBOOK.md 原件 + manifest.json 分母示例 |
| 终局合并脚本 | [脚本/合并/](脚本/合并/) | merge.mjs（四步终局+裁决留痕两旗）/ merge-assemble.py（pypdf 组装）/ img-opt.mjs（影子目录压缩）+ merge-final-report.json / end-imgs-dropped.json 产物示例 |
| 共享分析件 | [脚本/共享/](脚本/共享/) | analyze.mjs（零丢失 diff/洞检测/墨迹终检）+ gapfill.mjs（缩图/删图单一规则权威）——两管线同源引用 |
| skill | [skill/dedao-course-extract/SKILL.md](skill/dedao-course-extract/SKILL.md) | 薄壳：环境宪法/换课适配/QC 红线/10 步 checklist |
| 问题全集 | [档案/问题集/](档案/问题集/README.md) | P1-P32 全录（34 个 P 条目）+ 产品升级登记 + 探察总报告，白盒裁决档案 |

> **脚本**收录件均为实战终态**原样拷贝**（含注释——注释就是文档；字节级与源一致）。**SKILL.md** 收录件 = 实战快照 + 模板侧增补（增补清单见 [03-skill使用说明.md](03-skill使用说明.md) §7）。**产物示例**两件（merge-final-report.json / end-imgs-dropped.json）为交付版快照，不参与运行。换书部署时按 [04-脚本资产清单.md](04-脚本资产清单.md) §6 还原到「课程 `.engine/` + lasso `.dedao-extract/`」两个运行目录。

## 三条铁律（先记这三条再开工）

1. **静默零激活**：一切建 tab 走 `Target.createTarget {background:true}`；禁 `/json/new`（前台语义会 activate Chrome 抢用户焦点，事后守卫还不回焦点）。见 05 §1。
2. **文字零丢失**：每章词级 diff 必须为空（pdftotext vs 清理后 DOM innerText）——不可妥协红线，图可缩可删，字不可丢；门禁 FAIL 必须逐门归因到底才放行（06 §4）。
3. **批量必自保**：脚本自跑必须内建熔断（连续失败≥5 暂停 / 累计>15 中止 / 20min 无 OK 中止）+ 外部 5 分钟监控双保险；断点续跑的「跳过已存在」必须对照计划校验内容完整性（P31/P32）。
