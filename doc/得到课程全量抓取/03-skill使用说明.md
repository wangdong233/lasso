# 03 skill 使用说明 —— dedao-course-extract（薄壳）

> skill 原件全文收录：[skill/dedao-course-extract/SKILL.md](skill/dedao-course-extract/SKILL.md)（原样拷贝为基底 + 2026-08-20 模板侧增补，增补清单见 §7；其内部命令示例中的课程路径按实际部署替换）。

## 1. 定位与边界（先立规矩）

skill 是**薄壳**：只承载「环境宪法 + 静默纪律 + 换课适配表 + 引擎正典命令 + QC 红线 + 新书 checklist」，**禁止重新实现引擎任何逻辑**；引擎（`.engine/*.mjs`）**禁止内嵌 LLM 调用**（保持零 token）。这是方案裁决 c 的边界条款（见 [01-方案.md](01-方案.md) §1）——违反边界的形态（agent 逐章现场重写 JS）已被实测否决：更慢、更贵、更不可复现。

## 2. 安装

skill 目录只有一个文件 `SKILL.md`（frontmatter `name: dedao-course-extract`）：

```bash
# 项目级（推荐，随仓库走）
mkdir -p <项目>/.claude/skills
cp -R skill/dedao-course-extract <项目>/.claude/skills/

# 或用户级（跨项目可见）
cp -R skill/dedao-course-extract ~/.claude/skills/
```

装好后 Claude Code 会话中 skill 自动可被发现；无需其它依赖——skill 里引用的引擎/合并器按 [04-脚本资产清单.md](04-脚本资产清单.md) §6 的还原布局部署到课程目录。

## 3. 触发与调用

**触发场景**（skill description 已内置）：

- 把某门得到专栏课程（或一批子章节）抽成本地 PDF + MD + images 正典库并合并整书；
- 已有课程增量补跑 / 重跑失败章 / 补图 / 校验产物完整性 / 重出成书。

调用方式：直接对 Claude 说「抽取这门课 / 补跑失败章 / 重出成书」类需求，skill 自动挂载；或显式 `/dedao-course-extract`。挂载后 agent 按 skill 的步骤执行——**执行主体是确定性脚本，agent 只负责点火、监控、归因**（熔断触发后记 P 条目、白盒修因，不逐章手工代跑）。

## 4. skill 内容地图（SKILL.md 章节速览）

| SKILL.md 章节 | 一句话 |
|---|---|
| 第 0 步：环境宪法 | Chrome 9226 存活检查、`LASSO_CDP_PORT`、静默纪律三条、P28 三层防御勿手工处理弹窗 |
| 换课程 = 改一个文件 | config.mjs 键表 + 站点级常量清单 + 防覆写旧书台账 |
| 引擎调用 | selftest / enumerate / produce / status 正典命令与内建防护 |
| K=2 并发全量 | run-k2 编排语义（错峰/分片/跳闸清理） |
| 批级熔断器 | 三阈值表 + BREAKER.trip 处置序 |
| 运行监控 | 15-20 min 三条命令 |
| 补图 | backfill-imgs + MD 引用本地化改写 |
| 视频课页分支 | promo 裸 img 变体 / NORM_T 时长前缀 / 播放器 UI 删除 / 零 timer 切换 |
| 合并终局 | merge 四步 + 冒烟三件套 + 版式/降级语义 |
| 两条用户红线 | 文字绝对不可丢；尾部宣传图仅按门控判据删 |
| 质检门禁 | 每章五门禁 + 全书六门禁（详见本目录 [06-质量门禁.md](06-质量门禁.md)） |
| 新书上路 checklist | 10 步（详见 [07-新书上路checklist.md](07-新书上路checklist.md)） |
| 已知边界 | 分页洞唯一杠杆 / 条带化 / spawnSync 禁令 / 两次纠错失败即停 |

## 5. 参数化点（换课时 agent 要动的全部东西）

### 5.1 课程级（config.mjs，机械替换）

`COURSE_DIR` / `COURSE_NAME` / `TARGET` / `SIKAO` / `PROMO_MD5S` / `END_IMG_KEEP_MODULES` / `OUT_DIR` / `VENV_PY` ——键义与示例值见 [02-操作手册.md](02-操作手册.md) §1.5。其中三键有取证/裁决动作，不是照抄：

- `PROMO_MD5S`：**不同课程宣传图不同，必须重新采样**——机械两路：`node probe-figs.mjs "<章>"` 现场采样（nat=1080×607 即候选，全量 md5 `curl -s "<图URL>" | md5`），或产 1 章后读 scratch meta `promoMd5s[]`（match:false 即缺的指纹）；视频课模块的 promo 常为非 figure 裸 img、1080×607 同尺寸不同图，需逐模块取证。
- `SIKAO`：无「课后思考」栏目的课保留占位锚（引擎 found=false 不删段，门④按 0/0 对账）；有其它尾部噪音栏目须白盒重定段界（P20 范式，`probe-dom.mjs` dump 结构定锚）。
- `END_IMG_KEEP_MODULES`：章末删图豁免模块（子串匹配）——按新课模块清单逐个裁决哪些模块的章末图属课程身份保留；无豁免也不能留空数组（断言即炸，填占位串）。

### 5.2 站点级（换站点才动，白盒重定）

- engine.mjs 各 `JS_*` 片段的 DOM 选择器组（`div.article-body-wrap .article-body .editor-show` 等）与 `dedao.cn` URL 前缀过滤；
- backfill-imgs.mjs 的 `piccdn3.umiwi.com/img/YYYY/MM/NAME` CDN 反推模式；
- engine/merge 头部对共享件（analyze.mjs / gapfill.mjs）的绝对 import 路径。

### 5.3 防覆写铁律

新课程必须用**新课程目录**；启动前确认 `.engine/{state.json, manifest.json, .production-state.json, scratch/, logs/}` 为空或属于本课程——`enumerate` 会直接覆写 manifest，`produce` 会复用旧 state（done 章全跳）。绝不在旧课程目录里改 config 跑新书。

## 6. 已知坑的 skill 内引用（视频课等）

skill 的「视频课页分支」章对应实战五病（详见 [05-注意事项与教训.md](05-注意事项与教训.md) §4）：后台 timer 深度节流 → **零 timer 切换**；标题回退 document.title；时长前缀剥离；「- 得到APP」后缀剥离；播放器实时时间码删除。新书 checklist 第 7 步要求「有视频课模块再抽 1 章试跑」，即提前引爆这类章型。

## 7. skill 维护纪律

- skill 里的命令必须与引擎实际 CLI 保持一致——引擎加参数（如 merge 的 `--tag-suffix`、`--waive-blanks`/`--adjudicate-inorder`）时同步回 SKILL.md；
- 新问题归档后，把可复用结论回写 skill「已知边界」章（skill 是给下次开书的 agent 读的第一入口）；
- 本目录收录的 SKILL.md 是实战终态快照**＋模板侧增补**：源 skill 快照晚于 merge.mjs 12:33 终态生成，五处滞后已由模板侧补齐——①键表增 `END_IMG_KEEP_MODULES` 行；②合并终局命令块增两裁决旗与 MAX_ROUNDS=6 修正；③G2 结构性豁免集补「模块界首页前页」；④G4 期望口径改「独立全集直数（独立 img 块+段内联图）」；⑤步骤 3/4/10 补三键取证、probe 机械步骤与裁决出口。引擎/skill 若继续演进，以最新实战版为准做增量同步回写本目录（快照与演进版 diff 后择要合并，**合并时保留上述增补语义**）。
