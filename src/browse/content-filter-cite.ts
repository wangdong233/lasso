/**
 * content-filter-cite（parse12 §3.4 v1.1 新增）
 *
 * markdown_cited 档的 ⟨N⟩ 引用角标 —— Crawl4AI convert_links_to_citations
 * 算法的纯 TS reimplement（~50 行）。
 *
 * 借鉴源（守 INV-69：只借鉴算法不引依赖）：
 *  - Crawl4AI markdown_generation_strategy.py（Apache-2.0；convert_links_to_citations
 *    的核心思路：扫 inline link → URL 去重分配角标 → 替换为 text ⟨N⟩ → 末尾 References 段）
 *  - 守 INV-69：不 import crawl4ai（Python 包不可作 JS 依赖）；本文件是纯 TS reimplement
 *
 * 算法（parse12 §3.4）：
 *  1. 扫 markdown 中所有 [text](url) 形式的 inline 链接
 *  2. URL 去重（Map<url, n>），首次出现分配 ⟨N⟩ 角标（1-based）
 *  3. 替换 inline 链接为 `text ⟨N⟩`（保留链接文字，去 URL 本体）
 *  4. 末尾追加 `\n\n## References\n[1] url\n[2] url\n...`
 *
 * 不做（parse12 §3.4 推迟 v1.2）：
 *  - PruningContentFilter（DOM 节点 text-density 评分，~200 行 port）
 *  - BM25ContentFilter（BM25 相似度过滤，~100 行 port）
 */

// ============================================================
// 类型
// ============================================================
/**
 * 单条引用记录（角标编号 + URL）。
 * 角标编号是 1-based（⟨1⟩、⟨2⟩、…）。
 */
export interface CitationResult {
  /** 角标编号（1-based，与 References 段 [N] 对应） */
  n: number;
  /** 去重后的 URL */
  url: string;
}

// ============================================================
// 常量
// ============================================================
/**
 * markdown inline link 正则：[text](url)
 *  - text 组：除 ] 外的任意字符（含空格、中文等 Unicode）
 *  - url 组：http(s):// 开头，不含空格/右括号（容忍 URL 末尾的 . , ; 等标点
 *    会被 markdown 语法归入 url 组；这是 [text](url) inline link 的标准边界）
 *
 * 注意：用 g flag 支持全局替换；replace callback 逐个匹配处理。
 */
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

// ============================================================
// 核心 API：applyCitations（纯函数，无副作用，可单测）
// ============================================================
/**
 * 把 markdown 中的 inline link `[text](url)` 替换为 `text ⟨N⟩` 角标形式，
 * 并在末尾追加去重的 References 段。
 *
 * @param markdown  原始 markdown 文本（可能含 0 个或多个 inline link）
 * @returns         { markdown: 加角标后的文本 + References 段, citations: 去重引用表 }
 *                  无链接时返回 { markdown: 原文不变, citations: [] }（不加 References 段）
 */
export function applyCitations(markdown: string): {
  markdown: string;
  citations: CitationResult[];
} {
  const urlToN = new Map<string, number>();
  const citations: CitationResult[] = [];
  let nextN = 1;

  const transformed = markdown.replace(
    MD_LINK_RE,
    (_full: string, text: string, url: string) => {
      let n = urlToN.get(url);
      if (n === undefined) {
        n = nextN++;
        urlToN.set(url, n);
        citations.push({ n, url });
      }
      // 保留链接文字 + 追加 ⟨N⟩ 角标（去 URL 本体）
      // 角标用 unicode mathematical angle brackets ⟨ ⟩（U+27E8 / U+27E9）
      // 与既有 @oN 续页 ref 不重叠（parse12 R21）
      return `${text} ⟨${n}⟩`;
    },
  );

  // 末尾 References 段（仅当有 citation 时）
  if (citations.length === 0) {
    return { markdown: transformed, citations: [] };
  }

  const refs = citations.map((c) => `[${c.n}] ${c.url}`).join("\n");
  return {
    markdown: `${transformed}\n\n## References\n${refs}\n`,
    citations,
  };
}
