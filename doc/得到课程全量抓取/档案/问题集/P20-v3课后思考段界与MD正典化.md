# P20 — v3 轮：课后思考删除的段界裁决 + MD 正典化的三个工程教训

- 时间：2026-08-19（v3 管线 extract-v3.mjs → engine 1.1，3/3 章全绿）
- 用户令：①课后思考整段删除（标题与内容全去）；②每章 PDF 之外同步产出 .md + 本地 images/（正典中间产物，供全量合并）。
- 方法：全程白盒（s9-sikao.json 三章结构探察 → 删前断言审计 → 刻意删除差验证）。

## 1. 课后思考段界裁决（判据 + 两个含糊点的处置）

### 1.1 结构实证（s9-sikao.json，三章）

- 位置：`.editor-show` **顶层** `div.article-header.header-2`，内含 `span` 叶子文本**恰为**「课后思考」。
- 章节标题全用同构 header（001 章 10 个：`1. 有人的地方就有交易`…`课堂小结`、`课后思考`）——`data-module-type` 无区分度（P14 §1.3 同结论），**文本精确等值匹配**是唯一安全判据。
- 发刊词无任何 article-header（found=false，零删除，符合预期）。

### 1.2 段范围机械规则（已入管线 JS_SIKAO_DEL）

从目标 header 起删后随兄弟，遇三类停止界即停：①下一 `article-header`；②任意 `figure`（含宣传图，位置门控删 promo 在其后独立进行）；③无文本无图的空 junk（空 div/svg）。

### 1.3 含糊点处置（记录在案，用户可否决）

| 含糊点 | 处置 | 依据 |
|---|---|---|
| 「欢迎你给我留言，我们下次再见。」（001 章问题后签名句） | **删**（计入段内容） | 它是 课后思考 段的最后一块（其后即 figure 停止界）；若保留会变成无上下文的悬空句。审计有原文可回滚 |
| `div.tips`（002 章注释：Thomas Haslem v. Lockwood 判例引证） | **保留** | 注释/引证属全讲内容而非思考题；文字红线保守侧。保留后悬于文末呈脚注形态，视觉抽检正常 |
| 正文合法提及「课后思考」四字（未见章可能） | 不阻断，otherHits 记录 | 删除是位置门控的；门禁④按「PDF 计数==基准残留计数」而非绝对零 |

### 1.4 刻意删除差验证法（新证明技术，复用价值）

v3 与 v2 PDF 的 pdftotext 字符多重集差 = **恰好** header 4 字 + 段内容字数：
- l001：100 = 96（问题 81 + 签名句 15）+ 4（「课后思考」标题）；l002：44 = 40 + 4；fk：0。
- 即：删除面被证明为「不多不少正好是用户点名的那一段」——刻意删除 ≠ 文字丢失，差值可机审。

## 2. MD 正典化的工程教训

### 2.1 浮层泄漏（MD 首版缺陷，已修）

- 现象：MD 尾部混入「写笔记划线删除划线复制」（注释浮层）。PDF 与 innerText 均无此文本（v2/v3 零丢失门禁证明）。
- 根因：MD 构建器直接走 DOM 子树，未对齐 innerText/print 的可见性语义（display:none 与 fixed/absolute 排除）。
- 修复：JS_MD_BUILD 顶层子元素加双门（display==='none' ‖ position fixed/absolute → skip），unknown 计数归零。
- 教训：**正典中间产物的生成器必须与消费通道（innerText/print）共享同一可见性谓词**，否则「清理」只清理了打印而泄漏进正典。

### 2.2 QC 自伤（qc 脚本假阳，已修）

- MD frontmatter 的 pipeline 字串自含「课后思考」、发刊词标题天然含「地道的经济学思维」→ mdNoSikao/mdNoPromoPhrase 假阳。
- 修复：断言前剥离 frontmatter 与 H1 标题行。
- 教训：**对生成物做关键词断言时，先剥离生成器自身的元数据与标题**（自指文本是关键词断言的天敌）。

### 2.3 描述符当元素引用（eval 上游错误，fatal 门禁拦截）

- 首版 JS_SIKAO_DEL 把审计描述对象收进 `del` 后直接 `n.remove()` → `n.remove is not a function`。
- 001/002 两章当场 fatal（`sikao_eval_error`），未污染任何产物——P14 §7.3「evaluate 返回异常必须 fatal」门禁的再次实证。
- 修复：`delInfo`（审计）与 `delEls`（元素）双数组。

## 3. MD/images 产物契约（正典格式，全量合并的基础）

- 位置：`<模块目录>/<章标题>.md` + `<模块目录>/images/<cdn-basename>`；MD 内相对引用 `images/...`。
- frontmatter：title/module/source(章 articleId URL)/producedAt/pipeline。
- 块映射：article-header→`##`、p→段落（strong/em/br/内联图保留）、ol/ul→列表、figure→图（条带化 figure 折叠回单图，src 不变）、div.tips/blockquote→引用块、table→管道表；display:none 与浮层不入。
- 图片落地：md5 去重复用；同 basename 异内容回退 `<tag>-<basename>` 前缀并记 collision；下载失败该图保底远程 URL + failed 清单（不阻断出厂，WARN 可见）。

## 4. 门禁增补（engine 1.1 硬门禁 ④⑤）

- ④课后思考零残留：pdftotext 计数 == 基准 innerText 残留计数（正常 both=0；正文合法提及时 both=N）。
- ⑤MD 图片本地化：failed 清单为空为目标态，非空降级 WARN（保底远程引用），不入 fatal——图可降级、文字不可（红线不对称是有意的）。

## 5. 遗留观察

- fk 尾页 p14 墨迹尾空 56.1%（v2 同页同量级）：文档自然结束，非病态；用户投诉样（中部 30%+ 洞）全课程 0 复发。
- v3 三章 sha256 与 v2 不同属 PDF CreationDate 元数据差异（页数/QC 全同，fk 无删除内容页数 14=14）。
