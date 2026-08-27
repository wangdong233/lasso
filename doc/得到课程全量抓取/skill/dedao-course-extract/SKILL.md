---
name: dedao-course-extract
description: 得到专栏课程全量抽取成书的薄壳 skill——环境宪法与静默纪律、单配置文件换课（.engine/config.mjs）、engine/run-k2 正典命令、批级熔断与 K2 并发、backfill 补图、视频课页分支、merge.mjs 终局四步与降级语义、每章五门禁+全书六门禁、新书上路 checklist。引擎逻辑全部在确定性脚本（.engine/*.mjs）内，本 skill 禁止重新实现引擎任何逻辑（全量处理方案 §1.3 裁决边界）。
---

# 得到课程全量抽取与成书（薄壳）

## 何时用

- 把某门得到专栏课程（或其一批子章节）抽成本地 PDF + Markdown + images 正典库，并合并为整书。
- 已有课程增量补跑 / 重跑失败章 / 补图 / 校验产物完整性 / 重出成书。

## 第 0 步：环境宪法（不可跳过）

1. `curl -s http://127.0.0.1:9226/json/version` 确认专用隐藏 Chrome 活着；**绝不碰用户日常 Chrome**（P2：无 CDP 端口不可附加）。
2. 一切脚本/MCP 连接必须带 `LASSO_CDP_PORT=9226`；lasso-mcp 从 `dist/index.js` 起，cwd=lasso 仓库根（engine 已内置 transport；只有手挂 MCP 才需要自己设）。
3. **静默纪律（P16/P19/P27）**：全程复用既有 tab；**建 tab 一律 `Target.createTarget {background:true}`**——`/json/new` 与前台档会 activate Chrome 抢用户焦点（P27 定案），且 `/json/new` 的 url 参数失效须 WS `Page.navigate`（P21）；每章后 `chromeGuard()` **按 PID 定向复隐**（禁按进程名全量——会误伤用户日常 Chrome）。
4. **P28 三层防御引擎自带，勿手工处理弹窗**：① 每个课程 tab 常驻 WS，`Page.javascriptDialogOpening` 立即 accept；② 15s 盲发 `handleJavaScriptDialog` 兜底；③ `ensurePagesResponsive()` 章前探活，renderer 楔死（evaluate/Page.enable 全超时）→ 浏览器级换 tab 自愈。
5. 先读 `问题集/README.md` 与 `全量处理方案.md` 再动手；新问题记 `问题集/P<n>-*.md` 续排（当前用到 P29）。

## 换课程 = 改一个文件（.engine/config.mjs）

2026-08-20 起，engine/merge/backfill-imgs/run-k2 四个脚本的**全部课程相关常量收敛到 `.engine/config.mjs` 唯一入口**（F1 整改；此前 10+ 处绝对路径/课程名散落四文件，照旧 skill 改三参数位会覆写旧书台账）。

| 键 | 含义 | 本书值（示例） |
|---|---|---|
| `COURSE_DIR` | 课程根绝对路径 | `…/lasso/output/得到_薛兆丰的经济学` |
| `COURSE_NAME` | 成书命名/书签前缀 | `薛兆丰的经济学课`（→ `薛兆丰的经济学课-全419讲.pdf`） |
| `TARGET` | 课程主页 URL（侧栏枚举起点） | `https://www.dedao.cn/course/article?id=…` |
| `SIKAO` | 课后思考整段删除锚文本 | `课后思考` |
| `PROMO_MD5S` | 宣传图 md5 指纹集 | 经典版 + 视频课变体两枚（全量取证后入集） |
| `END_IMG_KEEP_MODULES` | 章末删图豁免模块（dirName/label 子串匹配；开篇模块章末图属课程身份保留） | `["课前必读"]`（新课按模块清单裁决；无豁免也不能空数组——断言即炸，填占位串） |
| `OUT_DIR` | 成书输出目录名 | `终局成书` |
| `VENV_PY` | pypdf venv python 绝对路径 | `…/合并演示/.venv/bin/python` |
| `LASSO_ROOT` / `CDP_PORT` | 共享基础设施（跨课程恒定） | `…/lasso` / `9226` |

config.mjs 自带空值防呆断言（缺键在 selftest 阶段即炸，不在 produce 深处炸）。

**仍属站点级**（换一门得到课通常不动；换站点必须白盒重定）：
- `engine.mjs` 各 `JS_*` 片段里的 DOM 选择器组（`div.article-body-wrap .article-body .editor-show` 等）与 `dedao.cn` URL 前缀过滤；
- `backfill-imgs.mjs` 的 `piccdn3.umiwi.com/img/YYYY/MM/NAME` CDN 反推模式；
- 两文件头部的 `lasso/.dedao-extract/{analyze,gapfill}.mjs` 绝对 import（跨课程共享库）。

**改完 config 必做（防覆写旧书）**：新课程须用**新课程目录**；启动前确认 `.engine/{state.json, manifest.json, .production-state.json, scratch/, logs/}` 是空的或属于本课程——`enumerate` 会直接覆写 manifest，`produce` 会复用旧 state（done 章全跳）。绝不在旧课程目录里改 config 跑新书。

## 引擎调用（正典路径，零 LLM token）

```bash
cd <课程目录>/.engine
node engine.mjs selftest                        # 16 内嵌 JS 片段语法闸 + 11 titleMatches（改完必过）
node engine.mjs enumerate                       # 侧栏慢滚合并 → manifest.json（P7/P18 虚拟列表）
node engine.mjs produce                         # 断点续跑：done 跳过、failed attempts<3 自动重试
node engine.mjs produce --only "第003讲,第004讲"  # 定向补跑
node engine.mjs produce --retry                 # 只重跑失败章（无视 3 次上限）
node engine.mjs produce --limit 2               # 新课试跑
node engine.mjs produce --force --only "标题"    # 强制重产（慎用）
node engine.mjs status                          # 进度/均值/ETA/失败清单（只读）
```

每章产出三件套：`<模块目录>/<章标题>.pdf/.md` + `<模块目录>/images/*`（标题含 `/` 时 safeName 全角化，P26-①）。台账：`.engine/state.json` + `.production-state.json`。
内建防护：单章看门狗 10 min；每 25 章整页复位（worker 档 15）；瞬态网络错 2s/4s 退避重试×3（P25-③）；MCP 配额 `LASSO_CALLER_CAP_DEFAULT=1000000`（P25 限流，批量高频调用撞 anonymous 100/60s 会整批阵亡）。

## K=2 并发全量（正典全量路径，约 2× 速度）

```bash
cd <课程目录>/.engine
node run-k2.mjs                          # 全量：两 worker 按 manifest.idx 奇偶分片
node run-k2.mjs --only "标题A,标题B,…"    # 指定章 round-robin 均分
# 透传 --retry / --force；--worker k/K 由 wrapper 注入，勿手跑
```

- 启动**自动清理 `BREAKER.trip`**（上轮残留不阻断本轮）；solo `produce` **不读**跳闸文件——跨进程跳闸只在 K2 语义下存在。
- worker0 即起、worker1 **错峰 20s**（并发建 tab 的 id-diff 归因不撞，避免互选对方 tab）。
- worker 档差异：日志前缀 `[Kk]` / 独立日志与 server-stderr / 章间 jitter / SPA 复位 25→15。
- 前置：Chrome 9226 反节流三件套由 lasso launch 恒加，后台 tab 不劣化。

## 批级熔断器（engine 内建）

| 阈值 | 动作 |
|---|---|
| 连续 FAIL ≥5 章 | PAUSED_BATCH_BREAKER（暂停，台账已落盘，断点续跑） |
| 本批累计 FAIL >15 | ABORT_BATCH_BREAKER（中止） |
| 20 min 无任何 [OK] | ABORT_BATCH_BREAKER（中止） |

K2 下任一 worker 触发 → 写 `.engine/BREAKER.trip` → 所有 worker 章边界停机。处置：`status` 看失败清单 → 记 问题集 新 P 条目（附 fatal 串）→ 白盒修因后 `node run-k2.mjs --retry`（或 solo `produce --retry`）。个别章 3 次仍败不盲目第 4 次。

## 运行监控（每 15-20 min）

```bash
tail -5 "$(ls -t logs/*-produce*.log | head -1)"   # [OK]/进度 i/N/ETA（K2 看两份 -w0/-w1）
node engine.mjs status
osascript -e '…get visible of (first process whose unix id is <PID>)'   # 应 false
```

## 补图（backfill-imgs.mjs，P26 收官件）

下载失败、MD 留远程引用的图，终局前必须补齐：

```bash
node backfill-imgs.mjs   # 盘点 MD 引用但未落盘的图 → 按 piccdn3.umiwi.com/img/YYYY/MM/NAME 反推补下载 → 落对应章 images/
```

补完把对应 MD 的远程引用改写为本地 `images/…`（本书 3 张：第039讲/第050讲/第32周问答），再 `merge.mjs plan` 验证图全在。

## 视频课页分支（P26-③m/n/p，实战模块 12）

- promo 常为**非 figure 裸 img**（1080×607 同尺寸不同图）→ 新课须取证 md5 入 `PROMO_MD5S`；引擎对全部 1080×607 候选 md5 裁决后删（非末位也删）。
- manifest 章名带「12:27 」时长前缀 → 引擎 NORM_T 剥前缀再匹配。
- 播放器 UI（倍速/全屏等 leaf 文本 + `video` 节点）删除——实时时间码会炸「图操作前后 innerText 不变」门。
- 页加载慢：轮询窗 30s；后台 timer 深度节流 → 零 timer 切换路径；`.article-title` 为空 → `document.title` 回退剥「- 得到」后缀。

## 合并终局（正典 = `.engine/merge.mjs`；旧 `合并演示/render-merge-b.mjs` 是本书一次性演示件，新书勿用）

```bash
cd <课程目录>/.engine
node merge.mjs plan                              # ① 完整性门禁：全章 MD 齐 + 引用图全在（缺任一 FATAL，不产半本）
node merge.mjs render                            # ② 按模块分片渲染（pass1→flow 决策→pass2→gapfill 闭环≤MAX_ROUNDS=6 轮+严格递减守卫；已成片跳过）
node merge.mjs render --module 7 --force         #     单片失败重渲
node merge.mjs assemble                          # ③ 前言两遍 TOC 回填 + pypdf 合并 + 页码盖章(跳封面) + 两级书签 + 六门禁
node merge.mjs qc                                # ④ 独立复核（对成品重跑全部门禁，不重渲染）
node merge.mjs sample --pages 1,2,3,50,200,900   # ⑤ 抽查页 PNG（页号按成品页数取）
node merge.mjs all                               # 一键 plan→render→assemble（建议分步，便于片级定位）
# 裁决留痕两旗（assemble/qc；先逐门归因后豁免，留痕≠门禁变绿——06-质量门禁 §4.1）：
node merge.mjs qc --waive-blanks                 #   G2 空白类残留人工豁免 → report.waivedBlanks（含 authority）
node merge.mjs qc --adjudicate-inorder           #   inOrder 经失配定位定性为提取序伪影后放行 → report.adjudications
```

- **冒烟三件套**（全量前机制验证，**不落正式分片名**）：`--partial`（仅纳入 done 章）/ `--titles <file>`（钉死章集，同输入重渲对照）/ `--tag-suffix <s>`（分片产物后缀）；`--out-name <name>` 定成品与 report 基名。
- 压缩阶梯②`--keep-end-imgs`（对照实验用；默认开 end-img-drop，豁免模块走 `config.END_IMG_KEEP_MODULES`）。
- 版式：**连续流式**（P29）——章级零强制分页，同页紧接下一章章头；模块题头块不整页；封面/目录独立分页；G2 收紧为「除结构性边界（前言页/模块末页/模块界首页前页——自动豁免集）外任何页尾墨迹空白 ≥40% 失败」。
- **降级语义**（P27 终局加固）：三重全本扫描（gap 断言/洞报告/墨迹终扫）单项超时/异常**不弃报告**——如实记 `report.degradedScans[]`、对应门标注 degraded，pass 不因降级假阳。QC 失败要降级记 degraded，不丢报告。
- 报告：`<OUT_DIR>/merge-final-report.json`（体量 + 六门禁 + 删图/缩图清单 = 证据文件）。**超时按全本规模校准**：pdftoppm 对 300MiB/1360 页单次可达 9.5 min+（sample 单页 timeout 570s、assemble 5700s）。
- 依赖：pypdf venv（本书 6.16.1，在 `合并演示/.venv`；新书可复用 `VENV_PY` 绝对路径，或 `python3 -m venv .venv && .venv/bin/pip install pypdf`——PEP 668 禁系统安装）。
- 兜底（路线 a，仅 b′ 渲染故障）：单章 PDF 已全在产，用 venv pypdf 按 `manifest.flat` 顺序拼接（无统一 TOC/页码，保底成品）。

## 两条用户红线（机械化，不靠自觉）

- **文字绝对不可丢**：每章门禁①（pdftotext vs cleanup+课后思考删除态 innerText，字符多重集+保序双 diff，missing 必空）；全书 G1 同源复验。
- **尾部宣传图不进产物**：M2(1080×607)∧M3(src 时间窗)∧M4(其后无正文)位置门控 + md5 金标裁决，**永不全文档扫删**。

## 质检门禁（出厂口径）

- **每章五门禁**（engine 自动，失败不落产物、state=failed 后继续）：①文字零丢失 ②宣传图零出现 ③图操作前后 innerText 逐字节不变 ④课后思考零残留 ⑤MD 图片全本地化（失败记 WARN 不静默丢图）。
- **全书六门禁**（merge assemble/qc）：G1 文字零丢失 / G2 页尾空白+图空缺（结构性豁免自动集：前言/模块末页/模块界首页前页）/ G3 TOC 页码全对 / G4 图片计数（期望=独立全集直数：独立 img 块+段内联 ![]() 图，减规则删除；promo=0）/ G5 洞报告全豁免 / G6 墨迹终扫。**归因后人工豁免走两旗留痕**（--waive-blanks/--adjudicate-inorder；missing 零丢失红线不可豁免）。
- 墨迹/视觉抽检（慢通道，批后抽样）：pdftoppm 渲 PNG + VLM 问询（P12 两段式替代法）；条带化页（超页高图）pdftoppm 分钟级超时属预期，跳该页改 PNG 核验（P15 §4）。

## 新书上路 checklist（10 步，从登录到交付）

1. **起专用隐藏 Chrome 并登录**：lasso launch-chrome（dedao-profile、9226、隐藏档、反节流三件套恒加）→ 人工登录一次（P2：日常 Chrome 不可复用；登录态在磁盘 profile）。
2. **建课程目录 + 拷脚手架**：`.engine/{config.mjs, engine.mjs, merge.mjs, backfill-imgs.mjs, run-k2.mjs, merge-assemble.py}`（+ probe-*.mjs 探察件）；pypdf venv 自建或复用。
3. **改 `.engine/config.mjs`**（COURSE_DIR/COURSE_NAME/TARGET/SIKAO/PROMO_MD5S/END_IMG_KEEP_MODULES/OUT_DIR/VENV_PY；后三键取证/裁决法见模板 02 §1.5）；确认台账 `state.json/manifest.json/.production-state.json/scratch/logs` 为空——**绝不复用旧书目录跑新书**（F1）。
4. **探察 1 章 DOM**（`node probe-dom.mjs "<章>"` / `node probe-figs.mjs "<章>"`，用法见模板 04 §2）：核对选择器组、课后思考锚 `SIKAO`（无此栏目保留占位锚，found=false 不删段）、宣传图取证（nat=1080×607 候选全量 md5 入 `PROMO_MD5S`，含视频课裸 img 变体；产 1 章后 scratch `promoMd5s[]` 的 match:false 即缺的指纹）。
5. `node engine.mjs selftest` 全绿（16 片段 + 11 匹配）。
6. `node engine.mjs enumerate` → `status` 核对分母（章数/模块数/countsSanity；P7 虚拟列表 pathology 靠慢滚合并）。
7. `node engine.mjs produce --limit 2` 试跑 → 三层质检（词级零丢失 / pdfimages 无指纹图 / 墨迹抽检）；有视频课模块再抽 1 章试。
8. `node run-k2.mjs` 全量（监控 status/最新 log/Chrome visible=false；熔断三阈值处置见上）。
9. `node backfill-imgs.mjs` 补图 + MD 引用本地化改写 → `node merge.mjs plan` 全绿（全章/全图）。
10. **终局**：冒烟验收版式（`render --partial --tag-suffix smoke --out-name 冒烟-…`，人工过目）→ 四步 `plan → render → assemble → qc` → `sample` 抽查 → 交付（成书 PDF + `merge-final-report.json` + `end-imgs-dropped.json` + `shard*-meta.json` 台账 + 问题集归档）。QC 六门禁**逐门归因到底**才放行；归因后仍有空白类残留或已定性的 inOrder 伪影 → 用户拍板后 `qc --waive-blanks [--adjudicate-inorder]` 留痕放行（missing 零丢失红线不可豁免）。

## 已知边界（勿重复踩）

- 分页洞修复唯一杠杆 = DOM 几何 + 打印产物反馈（scale/margins 实测无效，P14 §2.3）。
- 课程表类超页高图条带化处理，不丢图（S-D 裁决）；末页尾空是自然文档结束，非病态。
- server 进程内禁 spawnSync 长阻塞（曾致事件循环阻塞 5.7× 降速）；`Map.get` 可能 undefined，直喂 CLI 前必须守卫。
- 同一问题两次纠错失败 → 停，记 问题集 新 P 条目，换路径重述；不第三盲试。
