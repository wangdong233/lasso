# 07 新书上路 checklist（10 步，从登录到交付）

> 每本书开工先过一遍。**换书只改 `config.mjs`**（TARGET/COURSE_DIR/COURSE_NAME/PROMO_MD5S/SIKAO 等）——这是整套脚手架的设计承诺；站点级常量（DOM 选择器/CDN 模式）只在换站点时才动。详细操作见 [02-操作手册.md](02-操作手册.md)，坑位速查见 [05-注意事项与教训.md](05-注意事项与教训.md)。

## 清单

- [ ] **1. 起专用隐藏 Chrome 并登录**：lasso launch-chrome（专用 profile、9226、隐藏档、反节流三件套恒加）→ 人工登录一次。日常浏览器不可复用（无 CDP 端口不可附加）；登录态持久在磁盘 profile。
- [ ] **2. 建课程目录 + 拷脚手架**：按 [04-脚本资产清单.md](04-脚本资产清单.md) §6 还原布局——engine 组+合并组平铺进 `<新课程>/.engine/`，共享两件进 lasso 的 `.dedao-extract/`，`node_modules` 符号链接，pypdf venv 自建或复用。
- [ ] **3. 改 `.engine/config.mjs`（唯一必改文件）**：`COURSE_DIR` / `COURSE_NAME` / `TARGET` / `SIKAO` / `PROMO_MD5S` / `END_IMG_KEEP_MODULES` / `OUT_DIR` / `VENV_PY`（键义与取证法见 02 §1.5）。`END_IMG_KEEP_MODULES` 按新课模块清单逐个裁决（哪些模块的章末图属课程身份要保留）；无豁免模块也不能留空数组（断言即炸），填占位串。**确认台账 `state.json / manifest.json / .production-state.json / scratch/ / logs/` 为空——绝不复用旧书目录跑新书**（enumerate 会覆写 manifest，produce 会复用旧 state 跳过全部章）。
- [ ] **4. 探察 1 章 DOM（换书适配主战场，机械三步——探察件用法见 04 §2）**：
  ① `node probe-dom.mjs "<某章标题>"` dump 页面/栏目结构 → 核对选择器组 + 定 `SIKAO` 锚：引擎按 header 文本 trim 后**全等匹配**删段；无「课后思考」栏目的课保留占位锚（引擎 found=false 不删任何段，门④按 0/0 对账），有其它尾部噪音栏目按 P20 白盒重定锚文本；
  ② `node probe-figs.mjs "<该章>"` dump 全部 figure（nat 尺寸 + md5 前 12 位 + 字节数）→ 尾部 `nat=1080x607` 即 promo 候选 → 全量 md5 入 `PROMO_MD5S`（`curl -s "<图完整URL>" | md5`；视频课 promo 常为**非 figure 裸 img**、1080×607 同尺寸不同图，须逐模块采样）；
  ③ 产 1 章后若 `qc_failed:+promo-present`：scratch meta `promoMd5s[]` 已存全部候选**全量 md5**（match:false 即缺的指纹）→ 入集 → `--retry` 该章。
- [ ] **5. `node engine.mjs selftest` 全绿**（内嵌 JS 片段语法闸 + titleMatches）。
- [ ] **6. `node engine.mjs enumerate` → `status` 核对分母**：章数/模块数/序号单调/零重名。侧栏是虚拟列表，靠慢滚多 pass 合并（一次抓不全属预期，见 05 §4）。
- [ ] **7. `node engine.mjs produce --limit 2` 试跑** → 三层质检（词级零丢失 / pdfimages 无指纹图 / 墨迹抽检）；**有视频课模块再抽 1 章试**——视频课五病（零 timer 切换/标题回退/时长前缀/后缀剥离/播放器删除）见 05 §4，提前引爆好过全量期炸批。
- [ ] **8. `node run-k2.mjs` 全量**：监控三件（status / 最新 log / Chrome visible=false）每 15-20 min 一轮 + **外部 5 分钟监控**双保险；熔断三阈值（连续 5 暂停 / 累计>15 中止 / 20min 无 OK 中止）触发 → 记档案新 P 条目 → 白盒修因 → `--retry`。个别章 3 次仍败不盲目第 4 次。
- [ ] **9. `node backfill-imgs.mjs` 补图 + MD 引用本地化改写 → `node merge.mjs plan` 全绿**（全章/全图；缺图 FATAL，故 backfill 必须在 plan 前）。体积目标紧张时按 05 §7 压缩阶梯评估（默认 ①+② 已内建）。
- [ ] **10. 终局**：冒烟验收版式（`render --partial --tag-suffix smoke --out-name 冒烟-…`，人工过目）→ 四步 `plan → render → assemble → qc` → `sample` 抽查 → 交付。**QC 六门禁逐门归因到底才放行**（06 §4：G1 missing 非空必真阳性、G3 批量 no_start_page 是缺章警报、degraded ≠ pass）。归因后仍有结构性豁免未覆盖的 G2 空白类残留、或经 06 §3.4 失配定位定性的 inOrder 提取序伪影 → **用户拍板**后带裁决留痕旗重跑：`node merge.mjs qc --waive-blanks [--adjudicate-inorder]`（留痕落 report.waivedBlanks/adjudications；G1 missing 零丢失红线不可豁免；语义见 06 §4.1）。

## 交付核对

成书 PDF + `merge-final-report.json`（六门禁证据）+ `end-imgs-dropped.json`（阶梯②删除清单）+ `shard*-meta.json` 台账 + 单章三件套 + 问题档案归档。QC pass=false 的成品会被自动隔离为 `*-QC-FAIL.pdf`——此时回 02 §5.1/§6 排障，不得取走隔离件。**带豁免的 pass=true 报告必须同时含 `waivedBlanks`/`adjudications` 留痕与用户裁决记录（谁拍板、何日、为何）**——完整形态示例见 [脚本/合并/merge-final-report.json](脚本/合并/merge-final-report.json)（本书交付版：pass=true + 5 页空白豁免 + 1 条 inOrder 伪影裁决）。
