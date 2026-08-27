# P7-得到侧栏虚拟列表-远端回收与DOM顺序不稳定

## 现象
得到课程页左侧目录是虚拟列表（perfect-scrollbar + 按需渲染），静态 DOM 永远拿不到全量章节/子章节：
1. 初始只渲染视口附近章节（首轮仅见 课前必读 + 01 章 29/110 li）；
2. 滚动展开后**远端内容被回收**：慢滚一轮后 01 章渲染满 110 li，但其余章节从 DOM 消失（`div.ps` scrollHeight 从 38606 缩回 11038）；
3. **DOM 顺序不稳定**：实测「11 | 线下活动…」的 chapter-mod 出现在「12｜【视频】…」之后；
4. 存在无 header 的占位 `div.chapter-mod`（虚拟列表 spacer，按 offsetTop 顶位，`querySelector('.chapterp-header')` 为 null）。

## 复现
同一页面两次不同滚动策略得到不同结果：
- 快滚到底循环（`scout4` 40-all-chapters.json）：14 个具名章节全现身，但各章 li 计数为部分值（01:29/03:26/06:27…）；
- 慢滚步进合并（`scout6` 60-chapter-tree.json）：仅 3 章现身，但 01 章 li=110 全量、02 章 first3 完整。

## 白盒证据（DOM 实测）
- 滚动容器：`div.course-nav div.ps`（clientHeight≈383；scrollHeight 随滚动在 2800/11038/38606 间变化）；
- 章节节点：`div.chapter-mod > div.chapterp-header`（具名）与占位 mod（无 header）混排于同一 viewport div 下；
- 子项：`ul.course-module > li.iget-common-f5`，文本 `{标题} {时长} | {N}人学过 | 已学完`；
- 两次 probe 原始 JSON：`.dedao-scout/40-all-chapters.json`、`.dedao-scout/60-chapter-tree.json`。

## 判断
**预期行为（SPA 虚拟列表设计）→ 结论（枚举方法论约束）**：
1. 任何「一次 querySelectorAll 拿全树」的方案都必然漏章/漏项；
2. 正确枚举 = **慢滚动 + 每步快照 + 按章节名合并去重**（首见顺序保序），终止条件 = 连续 N 步无新章节且 scrollHeight 稳定；参考实现 `scout6.mjs`；
3. 幂等键用 chapterp-header 文本（占位 mod 无文本自动跳过）；DOM 顺序不可信，逻辑顺序按合并时首见序；
4. 对本任务（每章前 3 子章节）影响有限但必须走合并法；抽取阶段照探察报告 §2.4 执行即可。
