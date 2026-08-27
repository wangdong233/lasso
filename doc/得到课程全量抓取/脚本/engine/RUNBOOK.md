# RUNBOOK — 薛兆丰的经济学课 · 419 章全量生产 + 终局成书（路线 b′）【2026-08-20 终局更新】

> 全量启动准备官出具（2026-08-19）；2026-08-20 按实战终态重写：K=2 并发、批级熔断、backfill 补图、
> 终局四步 + 降级语义、config.mjs 参数化收敛。主循环（执行代理）**按本文件逐步执行**，不得跳步。
>
> **本轮已达成终态**：`status` done=419 failed=0（均值 14.8s/章，n=418）；成书
> `终局成书/薛兆丰的经济学课-全419讲.pdf`（1360 页 / 307MiB）已交付并经用户验收；
> 证据文件 `终局成书/merge-final-report.json`（六门禁结果与残余发现项如实留档）。
> 本文件同时作为**重跑/补跑手册**继续有效。

## 0. 环境事实（勿重验，除非故障）

| 项 | 值 |
|---|---|
| 引擎 | `.engine/engine.mjs`（engine 1.1 (v3) + P25/P26/P28 增量，零 LLM） |
| 课程配置 | **`.engine/config.mjs`（2026-08-20 收敛）**：COURSE_DIR/COURSE_NAME/TARGET/SIKAO/PROMO_MD5S/OUT_DIR/VENV_PY/LASSO_ROOT/CDP_PORT 唯一入口，四脚本（engine/merge/backfill-imgs/run-k2）共读，自带空值防呆 |
| 台账 | `.engine/state.json`：**done=419/419**，failed=0（均值 14.8s/章 n=418） |
| 共享规则 | `lasso/.dedao-extract/analyze.mjs` + `gapfill.mjs`（P23 修复 + P24 输入对齐，engine/merge 两管线同源） |
| 分母 | `.engine/manifest.json`：419 章/14 模块，序号全单调、无重名、declared 全对齐；期望图 1303 张 |
| Chrome | PID 85359 @ `127.0.0.1:9226`，dedao-profile 登录态有效，**全程隐藏**（chromeGuard PID 定向复隐 + lasso desired-hidden 粘滞）。PID 已换时以 `curl :9226/json/version` + pgrep 实测为准 |
| 依赖 | poppler 四件套（pdfimages/pdftotext/pdfinfo/pdftoppm）；`合并演示/.venv`（pypdf 6.16.1，路径入 config `VENV_PY`）；`lasso/dist/index.js`（MCP server） |
| lasso 门禁基线 | 改 lasso src 必跑：`cd lasso && npm run build && npm test && npm run check-invariants`（82 INV 基线；v1.18.1 时点 2308 passed + 1 skipped；v1.18.2 已发布，v1.18.3 增量在工作树）。build 必须在 lasso 根跑（曾错 cwd 静默失败——P27 复盘） |
| 成书冒烟基线 | `终局成书/冒烟-合并6章.pdf`（旧版式）+ `冒烟-合并6章-flow.pdf`（P29 连续流式版式，验收版） |

## 1. 启动前检查（30 秒，全过才点火）

```bash
CD=/Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学
# ① Chrome 活着且隐藏（期望 Browser 版本行 + false）
curl -s http://127.0.0.1:9226/json/version | head -2
osascript -e 'tell application "System Events" to get visible of (first process whose unix id is 85359)'   # → false
# ② 台账与分母
cd "$CD/.engine" && node engine.mjs status        # → done/failed/pending + 均值/ETA
# ③ 无并发 producer（期望空输出）
pgrep -fl "engine.mjs produce|run-k2" || echo OK
# ④ 台账归属核验（P13 教训：勿信共享台账，以实测为准）
```

任一不过：Chrome 死 → 见 §7；visible=true → `osascript … to false` 复隐；已有 producer 在跑 → 不要再启。

## 2. 主循环启动（正典 = K=2 并发；solo 为退化档）

**K=2 全量（正典，约 2× 速度；用户已授权并发，取代旧「全程单 producer」红线）：**

```bash
cd /Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学/.engine
nohup node run-k2.mjs >> logs/run-k2.nohup.log 2>&1 &
echo $! > logs/run-k2.pid
```

- 编排语义：启动**自动清理 `BREAKER.trip`**（上轮残留不阻断本轮）；worker0 即起、worker1 错峰 20s（并发建 tab 的 id-diff 归因不撞）；两 worker 按 manifest.idx 奇偶分片，`[K0]/[K1]` 前缀 + 独立日志 `logs/*-w0/-w1`。
- worker 档差异：章间 jitter；SPA 复位间隔 25→15；`--worker k/K` 由 wrapper 注入勿手跑。
- 指定章均分：`node run-k2.mjs --only "标题A,标题B"`；透传 `--retry`。

**solo 退化档（小批补跑/排障用）：**

```bash
nohup node engine.mjs produce >> logs/produce-full.nohup.log 2>&1 &   # 或 --retry 只重跑失败章
```

- **solo 不读 `BREAKER.trip`**（跨进程跳闸只在 K2 语义下存在）；solo 下熔断为进程内三阈值（§3）。
- 引擎自带 `logs/<RUN_TS>-produce[-wK].log`（每章一行 QC 证据）+ nohup 合流文件，双文件一致。
- 断点续跑幂等：done 章跳过；failed 且 attempts<3 自动重试；`--retry` 无视 3 次上限；`--force` 全部重跑（**禁用**）。
- 单章看门狗 10 min；每 25 章整页复位（worker 档 15）；state.json 每章原子写。
- P28 三层防御内建：JS 对话框事件层自动 accept + 15s 盲发兜底 + renderer 楔死换 tab 自愈（`[P28] dialog_auto_accepted` / `[P28] 楔死 tab … 已换新`）。
- **静默纪律**：引擎复用既有 tab，建 tab 一律 `Target.createTarget {background:true}`（P27：前台档会 activate 抢焦点），每章后 chromeGuard 定向复隐。执行代理**不得**对 9226 做任何 bringToFront/activate/截图整窗类操作。
- MCP 配额：transport 恒设 `LASSO_CALLER_CAP_DEFAULT=1000000`（P25：批量高频调用撞 anonymous 100/60s，192 章阵亡）；瞬态网络错（DNS/超时/RESET）调用级重试×3（2s/4s 退避）。

## 3. 运行中监控 + 批级熔断（每 15-20 min 一次）

```bash
cd /Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学/.engine
tail -5 "$(ls -t logs/*-produce*.log | head -1)"    # [OK]…| 进度 i/N…ETA（K2 兼看 -w0/-w1）
node engine.mjs status                             # done/failed 汇总 + 失败清单
osascript -e '…visible of (first process whose unix id is 85359)'   # 应 false
```

**熔断器（engine 内建，取代旧人工停止条件）：**

| 阈值 | 动作 |
|---|---|
| 连续 FAIL ≥5 章 | PAUSED_BATCH_BREAKER 暂停（台账已逐章落盘，断点续跑） |
| 本批累计 FAIL >15 章 | ABORT_BATCH_BREAKER 中止 |
| 20 min 无任何 [OK] | ABORT_BATCH_BREAKER 中止 |

K2 下任一 worker 触发 → 写 `.engine/BREAKER.trip` → 所有 worker 章边界停机（`run-k2` 结束汇总会打印 trip 原因）。处置：`status` 看失败清单 → 记 问题集 新 P 条目（附 fatal 串与 scratch 证据）→ 白盒修因后 `run-k2.mjs --retry`。`switch_failed`/`article-title 未出现` 密集 = 登录态/页面异常信号，同途处置。

## 4. 完成判定

1. `node engine.mjs status` → **done=419 failed=0**（本轮已达成；重跑时以最新 log 末尾 `BATCH DONE` 为准）。
2. 若 failed>0：处置序 `produce --retry`（或 `run-k2.mjs --retry`）；个别章 3 次仍败 → **不盲目第 4 次**：记 问题集 新 P 条目，人工白盒后再 `--only <该章>`。
3. 产物抽数：每章三件套 `<模块dir>/<title>.pdf + .md + images/`（标题含 `/` 落盘全角化，P26-①）；§5 的 plan 门禁会全量机械核对，不必手点。
4. **补图收尾**：`node backfill-imgs.mjs` 盘点 MD 引用但未落盘的图（下载失败远程保底章）→ 自动按 `piccdn3.umiwi.com/img/YYYY/MM/NAME` 反推补下载 → **手工把对应 MD 远程引用改写为本地** `images/…` → `merge.mjs plan` 复验图全在（本书实操 3 张：第039讲/第050讲/第32周问答，P26 §3）。

## 5. 终局合并（路线 b′；done=419 且 plan 全绿后执行）

**脚本**：`.engine/merge.mjs`（分片渲染器）+ `.engine/merge-assemble.py`（pypdf 组装，venv 走 config `VENV_PY`）。**正典四步 + 抽查**：

```bash
cd /Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学/.engine

# ① 完整性门禁：419/419 MD 齐 + 引用图片全在（缺任一 FATAL 退出，不产半本）
node merge.mjs plan

# ② 14 模块分片渲染（每片 pass1→flow 决策→pass2→gapfill 闭环≤3轮；已存在片自动跳过）
node merge.mjs render
#    单片失败重渲：node merge.mjs render --module 7 --force

# ③ 前言两遍 TOC 回填 + pypdf 合并 + 页码统一盖章(跳过封面) + 模块/章两级书签 + 六门禁 + 墨迹终扫
node merge.mjs assemble

# ④（独立复核，不重渲染）对成品重跑全部门禁
node merge.mjs qc

# ⑤ 视觉抽查 PNG（页号按成品页数取：封面/目录/各模块首章/随机/末页）
node merge.mjs sample --pages 1,2,3,20,120,400,900,1300,1360
```

一键等价：`node merge.mjs all`（plan→render→assemble 连跑；建议分步，便于片级定位）。

**冒烟三件套**（重排版式/机制验证用，不落正式分片名）：`--partial`（仅纳入 done 章）/ `--titles <file>`（钉死章集同输入重渲对照）/ `--tag-suffix <s>`（分片产物后缀，防全量误判「已渲染」跳过）；`--out-name <name>` 定成品/report 基名。

- **版式（P29 连续流式）**：章级零强制分页，同页紧接下一章章头；模块题头块（通栏粗线+大标题）不整页分隔；封面/目录独立分页；G2 收紧为「除结构性边界（前言页/各模块末页）外任何页尾墨迹空白 ≥40% 失败」。
- **降级语义（P27 终局加固）**：三重全本扫描（gap 断言/洞报告/墨迹终扫）单项超时/异常**不弃报告**——如实记 `report.degradedScans[]`，对应门标注 degraded，pass 不因降级假阳。QC 失败要降级记 degraded，不丢报告。
- **超时按全本规模校准**：pdftoppm 对 307MiB/1360 页全本扫描单次可 >9.5 min——sample 单页 timeout 570s、assemble 子进程 5700s 已按此设；新书页数/体量差异大时先校准再跑全本。
- **成品与证据**：`终局成书/薛兆丰的经济学课-全419讲.pdf` + `终局成书/merge-final-report.json`（体量+六门禁+删图/缩图清单）。本书终局报告（2026-08-20 09:56 落盘）G4 全过（images 957==957、promo=0），G1/G2/G3 含残余发现项（罕字提取伪影/流式版式尾部空白清单/流式章 no_start_page）均如实留档于 `report.gates`——交付验收以人工过目 + 报告留档为准。
- **预计**：分片渲染 ~15-40 min（14 片 × 2-5 遍 CDP 渲染）+ 组装/QC ~8-20 min（pdftotext 全书一次 + pdftoppm 36dpi 墨迹终扫是大头）。
- **中断恢复**：render 按片幂等（重跑跳过已成片）；assemble 可整体重跑（`.work/` 中间件自动重建）；qc/sample 只读。
- **兜底（路线 a，仅 b′ 渲染故障）**：单章 PDF 已全在产，用 venv pypdf 按 manifest 顺序拼接（无统一 TOC/页码，保底成品）：
  ```bash
  cd /Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学
  合并演示/.venv/bin/python - <<'EOF'
  import json, pathlib
  from pypdf import PdfReader, PdfWriter
  base = pathlib.Path('.')
  flat = json.load(open('.engine/manifest.json'))['flat']
  w = PdfWriter()
  for f in flat:
      t = str(f['title']).replace('/', '／').replace('\\', '＼')   # P26-① safeName 同款
      w.append(PdfReader(str(base / f['dirName'] / (t + '.pdf'))))
  with open('终局成书/兜底-路线a-全419讲.pdf', 'wb') as fh:
      w.write(fh)
  EOF
  ```

## 6. 质量红线清单

### 6.1 每章五门禁（engine 自动，失败**不落产物**、state=failed 后继续）
1. **文字零丢失**：pdftotext vs cleanup+课后思考删除态 innerText，字符多重集 missing 必空 + 保序（inOrder）。
2. **宣传图零出现**：出厂 pdfimages 无 1080×607（删前 M2∧M3∧M4 位置门控 + md5 金标裁决——全部 1080×607 候选取 md5 后与 `PROMO_MD5S` 全等才删，含非末位裸 img，P26-②/③m）。
3. **图操作不变量**：图删除/缩放前后 innerText 逐字节不变（含 gap 删除档再验；视频课播放器实时时间码节点同门炸出即删，P26-③p）。
4. **课后思考零残留**：PDF 出现次数 == 基准残留次数（正常 0/0）。
5. **MD 图片全本地化**：下载失败进 failed 清单记 WARN，MD 保底远程引用（不静默丢图；终局前 backfill 补齐）。
加分项（自动）：分页 gapfill 闭环（P23/P24 规则：大空缺≥35% 且次页顶有图→等比缩入下限 200css；缩后仍溢出→删图记日志；cosmetic 12-35% 只缩不删；**文字块永不动**）。

### 6.2 全书六门禁（merge.mjs assemble/qc 自动；降级项如实标注）
1. **G1 文字零丢失**：全书 pdftotext vs 全部 MD 基准，CJK 多重集 missing=0 + 词级保序。
2. **G2 页尾空白 + 图空缺**：非结构性边界页尾墨迹空白 ≥40% 失败（P29 收紧档）；`assertNoUnfilledGaps` ≥40% 空缺且次页顶有图必被处理（章尾/目录页豁免可查）。
3. **G3 TOC 页码全对**：章哨兵页 == TOC 回填页码（连续流式版式下随上一章同页起的章记 no_start_page，见 report 明细）。
4. **G4 图片完整**：pdfimages 计数 == ΣMD 引用 − 规则删除数；promo=0。
5. **G5 洞报告**：holeReport 残洞全部为豁免类（封面/目录/章尾/末页）。
6. **G6 墨迹终扫**：36dpi 灰度内容区尾部空白 ≥40% 的非豁免页 = 0。

### 6.3 人工纪律（执行代理红线）
- **单 Chrome 9226 全程隐藏；≤2 个 engine worker（只经 run-k2.mjs）；0 个并发 merge 渲染**（merge 与 produce 不并行；render/assemble/qc 串行）。
- 建 tab 一律 `Target.createTarget {background:true}`；禁 bringToFront/activate/新窗口/`/json/new`。
- server 进程内禁 `spawnSync` 长阻塞（同步看门狗曾阻塞事件循环 5.7× 降速，P27 复盘）；`Map.get` 可能 undefined，直喂 CLI 前必须守卫。
- 任何问题两次纠错失败 → 停，记 问题集 新 P 条目，换路径重述；不第三盲试。
- 删图只能走 gapfill big 档规则（日志留痕）；任何「为了排版删文字」的操作一律禁止。

## 7. 故障速查

| 症状 | 处置 |
|---|---|
| `curl 9226` 不通 | Chrome 死。按 lasso 台账流程以 dedao-profile 重启隐藏 Chrome（9226），`osascript` 置 visible=false，回 §1 重查后重启 producer（断点续跑，不丢进度） |
| 9226 活但全部页级调用超时 | renderer 楔死（P28-②）：引擎 `ensurePagesResponsive` 自动换 tab 自愈；若整 Chrome wedge（P9）→ 判死重启（profile 登录态无损） |
| `BREAKER.trip` 存在 | 上轮熔断残留。看内容（worker+原因）→ 修因 → `run-k2.mjs --retry`（启动自动清）；solo 模式不读此文件，无需手清 |
| `switch_failed:notfound` 密集 | 虚拟列表病理（P7）：引擎自带整页重导航兜底；仍失败 → `--retry`；再失败 → 记 P 条目 |
| `qc_failed:+promo-present` | promo 指纹未入集（P25-①/P26-③m 形态）：取证该章图 md5 → 入 config `PROMO_MD5S` → `--retry` 该章 |
| `assert_failed:title-mismatch` | 章名归一化问题（P25-②/P26-③n 时长前缀）：核 manifest 章名 vs 页面标题，记 P 条目 |
| `ssrf_blocked:dns_failed` 阵亡 | TUN 间歇 DNS（P25-③）：已内建调用级重试×3；仍批量阵亡 → 查网络代理/TUN 路由后 `--retry` |
| `ready-timeout(expectImgs=N)`（merge） | 该模块 images/ 有 404/缺失（P22 类）：核 `merge-plan.json.missingImgs` → `backfill-imgs.mjs` 补图（或重产该章）→ 该片 `render --module K --force` |
| MD 远程引用图 | `node backfill-imgs.mjs` 补下载 + MD 改写本地 → `plan` 复验（P26 §3 实操） |
| pypdf `overlay pages != book` | `.work/page-numbers.pdf` 生成态过期：重跑 `assemble`（自动重建） |
| 章失败 `qc_failed:+sikao-residual` | 课后思考段界变化（P20 类）：看 scratch/e****-meta.json 的 sikao 审计块，记 P 条目后人工定段界 |
| QC 全本扫描超时 | 降级记 `degradedScans`（不弃报告）；重跑 `qc` 前先按全书页数/体量校准 pdftoppm 超时 |
| 磁盘紧张 | 单章 PDF ~0.7MiB×419 ≈ 300MiB + 成书 ~300-400MiB + 片件；确保卷余量 >2GB |

## 8. 交付物清单（终局核对；本轮已交付）

- 单章三件套 ×419：`<模块dir>/<title>.{pdf,md}` + `<模块dir>/images/`
- 台账：`.engine/state.json`、`.production-state.json`、`logs/`、`config.mjs`（课程配置正典）
- 成书：`终局成书/薛兆丰的经济学课-全419讲.pdf`（1360 页/307MiB）、`merge-final-report.json`（六门禁证据）、14 个 `shardNN-*.pdf(+meta.json)`
- 冒烟基线：`冒烟-合并6章.pdf` + `冒烟-合并6章-flow.pdf`（P29 流式版式验收版）
- 问题集：P1-P29 全录（全量期新增 P20-P29：v3 正典化 / 图径 / 洞检测 / 决策输入 / 410 失败三模式 / K2 三组失败+视频课五连病 / 浏览器闪现 / 对话框自愈 / 章界流式）
- 复用资产：`skill/dedao-course-extract/SKILL.md`（换课 checklist）；`.engine/.backup-pre-config-20260820/`（config.mjs 收敛前四脚本原件，留档）
