// config.mjs — 课程配置唯一入口（2026-08-20 F1 整改：engine/merge/backfill-imgs/run-k2 四件共读）
//
// 换课程 = 新建课程目录 + 拷贝 .engine/ 脚手架 + **只改本文件** + 清空旧台账后 enumerate。
// 旧课程的 state.json / manifest.json / .production-state.json / scratch/ / logs/ 绝不能被
// 新课程复用或覆写（enumerate 会直接覆写 manifest/state——先清空或换目录，F1 教训）。
//
// 仍属**站点级**常量（换一门得到课通常不动；换站点必须动）：
//   - engine.mjs `JS_*` 片段里的 DOM 选择器组（div.article-body-wrap …）与 dedao.cn URL 前缀过滤
//   - backfill-imgs.mjs 的 piccdn3.umiwi.com/img/YYYY/MM/NAME CDN 反推模式
//   - engine/merge 头部的 lasso/.dedao-extract/{analyze,gapfill}.mjs 绝对 import（共享库）
import * as path from "node:path";

export const CFG = {
  // —— 课程身份（每课必改）——
  COURSE_NAME: "薛兆丰的经济学课", // 成书命名 `<COURSE_NAME>-全N讲.pdf` / assemble 书签
  COURSE_DIR: "/Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学", // 课程根（章节产物 + .engine 所在）
  TARGET: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz", // 课程主页（侧栏枚举起点）
  SIKAO: "课后思考", // 课后思考整段删除的锚文本（v3①；无此栏目的课须白盒重定段界）
  // 宣传图 md5 指纹集：P26-③m 经典版 + 视频课页变体（1080×607 同尺寸不同图，全量取证后入集）
  PROMO_MD5S: ["7127ed550d5aeb9b75697030579c9aa4", "e074df4b71076e1bee130ae6d6f09859"],
  // 章末删图豁免模块（2026-08-20 用户更正：这些模块的章末图片**保留**——发刊词等
  // 开篇图是课程身份的一部分；按模块 dirName/label 子串匹配）
  END_IMG_KEEP_MODULES: ["课前必读"],
  OUT_DIR: "终局成书", // 成书输出目录名（COURSE_DIR 相对）
  VENV_PY: "/Users/wangdong/Documents/Project/claude技能/lasso/output/得到_薛兆丰的经济学/合并演示/.venv/bin/python", // pypdf venv（PEP 668 禁系统安装；新书可复用此绝对路径）

  // —— 共享基础设施（跨课程恒定）——
  LASSO_ROOT: "/Users/wangdong/Documents/Project/claude技能/lasso",
  CDP_PORT: 9226,
};

// 防呆断言：缺键/空值在加载刻大声失败（宁可在 selftest 阶段炸，不在 produce 深处炸）
for (const [k, v] of Object.entries(CFG)) {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) throw new Error(`config.mjs: ${k} 为空——换课程适配必填`);
}

// —— 派生导出（与原四文件 const 逐一同名同值，纯机械收敛，禁漂移）——
export const LASSO_ROOT = CFG.LASSO_ROOT;
export const BASE = CFG.COURSE_DIR;
export const ENGINE = path.join(BASE, ".engine");
export const TARGET = CFG.TARGET;
export const CDP = `http://127.0.0.1:${CFG.CDP_PORT}`;
export const PROMO_MD5S = new Set(CFG.PROMO_MD5S);
export const SIKAO = CFG.SIKAO;
export const OUT = path.join(BASE, CFG.OUT_DIR);
export const COURSE = CFG.COURSE_NAME;
export const VENV_PY = CFG.VENV_PY;
