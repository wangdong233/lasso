/**
 * tool-examples-truth.spec.ts（doc/usage/04 决议 E，2026-09-16 P1）
 *
 * 示例正典的防漂移四道闸（doc 是正典、代码是抄本，方向单一 doc→code）：
 *  闸 1a doc→code 逐字锚：读 doc/usage/04 §B 表格，提取 call-shape 示例行，
 *      断言对应 DESCRIPTION 逐字包含——删例/改写即红；
 *      E6 特例 = 既有 TIMEOUT 句的正典锚（零新增字符），E9/E14 非 call-shape
 *      行自然跳过（E9 由 bug09-r2 spec 钉，E14 走闸 4 的 L2 断言）；
 *  闸 1b consent 共现顺序锚（E8 专用）：示例行与 ASK THE USER FIRST 前提
 *      不得分离或倒序；
 *  闸 1c 合法值锚：descriptions 内所有 action:"X" ∈ BROWSE_ACTIONS
 *      （示例不得引用不存在的 action）；
 *  闸 1d call-shape ⊆ schema 锚（r1 新增）：手写递归下降解析 B 表示例
 *      （禁解析依赖——红线：禁项目外新组件），断言顶层参数名 + options 键
 *      （含一层嵌套：steps 项 / screenshot 子对象）⊆ 对应工具 zod schema 键。
 *
 * 预算帽（§E.1，chars 为法定机械单位，3.6 chars/tok 换算仅沟通口径）：
 *  per-Tier-1-constant ≤ 基线 + 650（取整到百）；fleet Σ19 ≤ 58,900；
 *  EXAMPLES 段 ≤5 行/工具；L2 schema describe 合计 ≤ 2,160。
 *
 * 闸 4 schema describe 派生一致（r1 扩展：作用域文本由消费表/白名单拼出，
 * 派生源变异必红——真锚非摆设）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as D from "../../src/tools/descriptions.js";
import {
  READ_TEXT_DESCRIPTION,
  readTextSchema,
} from "../../src/tools/read-text.js";
import { browseSchema } from "../../src/tools/browse.js";
import { screenshotSchema } from "../../src/tools/screenshot.js";
import { adminSchema } from "../../src/tools/admin.js";
import {
  BROWSE_ACTIONS,
  CONSUMED_OPTIONS,
  CURRENT_PAGE_ACTIONS,
  ENTRY_CONSUMED_OPTION_KEYS,
} from "../../src/channels/BrowseChannel.js";

// ============================================================
// 常量登记（19 个 descriptions.ts 常量 + read_text 金标准）
// ============================================================
const CONSTANTS: Record<string, string> = {
  SEARCH_DESCRIPTION: D.SEARCH_DESCRIPTION,
  WAYBACK_DESCRIPTION: D.WAYBACK_DESCRIPTION,
  BROWSE_HEADLESS_DESCRIPTION: D.BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION: D.BROWSE_LOGGED_IN_DESCRIPTION,
  BROWSE_HEADED_DESCRIPTION: D.BROWSE_HEADED_DESCRIPTION,
  DOCTOR_DESCRIPTION: D.DOCTOR_DESCRIPTION,
  DESKTOP_DESCRIPTION: D.DESKTOP_DESCRIPTION,
  INTERACT_ROOTS_DESCRIPTION: D.INTERACT_ROOTS_DESCRIPTION,
  INTERACT_OBSERVE_DESCRIPTION: D.INTERACT_OBSERVE_DESCRIPTION,
  INTERACT_ACT_DESCRIPTION: D.INTERACT_ACT_DESCRIPTION,
  BROWSERBASE_DESCRIPTION: D.BROWSERBASE_DESCRIPTION,
  STEEL_DESCRIPTION: D.STEEL_DESCRIPTION,
  FETCH_URL_DESCRIPTION: D.FETCH_URL_DESCRIPTION,
  SCREENSHOT_DESCRIPTION: D.SCREENSHOT_DESCRIPTION,
  PDF_DESCRIPTION: D.PDF_DESCRIPTION,
  NETWORK_DESCRIPTION: D.NETWORK_DESCRIPTION,
  ADMIN_DESCRIPTION: D.ADMIN_DESCRIPTION,
  FETCH_FEED_DESCRIPTION: D.FETCH_FEED_DESCRIPTION,
  SEARCH_LOCAL_DESCRIPTION: D.SEARCH_LOCAL_DESCRIPTION,
  READ_TEXT_DESCRIPTION,
};

const DOC_PATH = fileURLToPath(
  new URL("../../doc/usage/04-工具示例体系.md", import.meta.url),
);

/** B 表行 → 目标常量（放置列的机械化映射 + 「BROWSE 族」= 三兄弟）。 */
const ROW_TARGETS: Record<string, string[]> = {
  E1: ["SCREENSHOT_DESCRIPTION"],
  E2: ["BROWSE_HEADLESS_DESCRIPTION", "BROWSE_LOGGED_IN_DESCRIPTION"],
  E3: ["SCREENSHOT_DESCRIPTION"],
  E4: [
    "BROWSE_HEADLESS_DESCRIPTION",
    "BROWSE_LOGGED_IN_DESCRIPTION",
    "BROWSE_HEADED_DESCRIPTION",
  ],
  E5: ["BROWSE_HEADLESS_DESCRIPTION"],
  E6: ["BROWSE_HEADLESS_DESCRIPTION"], // 既有 TIMEOUT 句正典锚（零新增字符）
  E7: ["BROWSE_HEADLESS_DESCRIPTION"],
  E8: ["BROWSE_HEADED_DESCRIPTION"],
  E10: ["ADMIN_DESCRIPTION"],
  E15: ["BROWSE_HEADLESS_DESCRIPTION"],
  E16: ["BROWSE_HEADLESS_DESCRIPTION"],
  E11: ["READ_TEXT_DESCRIPTION"],
  E12: ["BROWSE_HEADLESS_DESCRIPTION"],
  E13: ["BROWSE_HEADLESS_DESCRIPTION"],
};

interface DocRow {
  id: string;
  cell: string;
  placement: string;
}

function readDocRows(): DocRow[] {
  const doc = readFileSync(DOC_PATH, "utf8");
  const rows: DocRow[] = [];
  for (const m of doc.matchAll(/^\| (E\d+) \| ([^|]+) \| ([^|]+) \|/gm)) {
    rows.push({ id: m[1], cell: m[2], placement: m[3] });
  }
  return rows;
}

/** cell 内反引号 span 中挑出 call-shape 示例（含 name({ 形态）。 */
function callShapeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((s) => /[a-z_]\(\{/.test(s));
}

// ============================================================
// 闸 1d 解析器（手写递归下降——正典语法受限：串/数/布尔/标识符键/对象/数组）
// ============================================================
interface ParsedValue {
  kind: "obj" | "arr" | "scalar";
  keys?: string[];
  children?: Map<string, ParsedValue>;
  items?: ParsedValue[];
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function parseValue(s: string, i: number): { v: ParsedValue; next: number } | null {
  i = skipWs(s, i);
  if (s[i] === "{") return parseObj(s, i);
  if (s[i] === "[") {
    let j = skipWs(s, i + 1);
    const items: ParsedValue[] = [];
    if (s[j] === "]") return { v: { kind: "arr", items }, next: j + 1 };
    for (;;) {
      const r = parseValue(s, j);
      if (!r) return null;
      items.push(r.v);
      j = skipWs(s, r.next);
      if (s[j] === ",") {
        j = skipWs(s, j + 1);
        continue;
      }
      if (s[j] === "]") return { v: { kind: "arr", items }, next: j + 1 };
      return null;
    }
  }
  if (s[i] === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j++;
    if (j >= s.length) return null;
    return { v: { kind: "scalar" }, next: j + 1 };
  }
  const m = /^[A-Za-z0-9_.\-/]+/.exec(s.slice(i));
  if (m) return { v: { kind: "scalar" }, next: i + m[0].length };
  return null;
}

function parseObj(s: string, i: number): { v: ParsedValue; next: number } | null {
  let j = skipWs(s, i + 1);
  const keys: string[] = [];
  const children = new Map<string, ParsedValue>();
  if (s[j] === "}") return { v: { kind: "obj", keys, children }, next: j + 1 };
  for (;;) {
    j = skipWs(s, j);
    let key: string;
    // 2026-09-18：uid 键（"1_23"/"@uid" 形态）是 type/selectors 的真实调用形态——
    // 解析器须支持带引号键（与标识符键并存），否则真实示例无法进正典。
    if (s[j] === '"') {
      const kEnd = s.indexOf('"', j + 1);
      if (kEnd < 0) return null;
      key = s.slice(j + 1, kEnd);
      j = skipWs(s, kEnd + 1);
    } else {
      const km = /^[A-Za-z_$][\w$]*/.exec(s.slice(j));
      if (!km) return null;
      key = km[0];
      j = skipWs(s, j + key.length);
    }
    if (s[j] !== ":") return null;
    const r = parseValue(s, j + 1);
    if (!r) return null;
    keys.push(key);
    if (r.v.kind !== "scalar") children.set(key, r.v);
    j = skipWs(s, r.next);
    if (s[j] === ",") {
      j++;
      continue;
    }
    if (s[j] === "}") return { v: { kind: "obj", keys, children }, next: j + 1 };
    return null;
  }
}

function parseCallShape(span: string): { tool: string; top: ParsedValue } | null {
  const m = /([a-z_]+)\(\{/.exec(span);
  if (!m) return null;
  const r = parseObj(span, m.index + m[0].length - 1);
  if (!r) return null;
  if (span.slice(r.next).trim() !== ")") return null;
  return { tool: m[1], top: r.v };
}

// ============================================================
// zod 侧键提取（经 .default()/.optional() 解包；browse 三兄弟共用 browseSchema）
// ============================================================
const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  browse_headless: browseSchema as unknown as Record<string, unknown>,
  browse_logged_in: browseSchema as unknown as Record<string, unknown>,
  browse_headed: browseSchema as unknown as Record<string, unknown>,
  screenshot: screenshotSchema as unknown as Record<string, unknown>,
  admin: adminSchema as unknown as Record<string, unknown>,
  read_text: readTextSchema as unknown as Record<string, unknown>,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function unwrap(z: any): any {
  let f = z;
  while (
    f &&
    f._def &&
    (f._def.typeName === "ZodOptional" ||
      f._def.typeName === "ZodDefault" ||
      f._def.typeName === "ZodNullable")
  ) {
    f = f._def.innerType;
  }
  return f;
}
function objShape(f: any): Record<string, any> | null {
  const u = unwrap(f);
  return u && typeof u.shape === "object" ? u.shape : null;
}
function arrItemShape(f: any): Record<string, any> | null {
  const u = unwrap(f);
  if (!u || u._def?.typeName !== "ZodArray") return null;
  return objShape(u.element ?? u._def.element);
}

// ============================================================
// 闸 1a：doc→code 逐字锚
// ============================================================
describe("闸 1a · doc→code 示例正典锚（doc/usage/04 §B 表 = 唯一真源）", () => {
  const rows = readDocRows();

  it("B 表可解析（≥10 行；文档重整致锚失效应在此显形，而非静默通过）", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it("每个 call-shape 行已登记目标常量（新行无映射即红——禁静默跳过）", () => {
    for (const row of rows) {
      const spans = callShapeSpans(row.cell);
      if (spans.length === 0) continue;
      expect(
        ROW_TARGETS[row.id],
        `${row.id} 有 call-shape 示例但未登记 ROW_TARGETS`,
      ).toBeTruthy();
    }
  });

  it("放置列映射诚实：placement 提到的 *_DESCRIPTION 常量 ∈ 目标集；「BROWSE 族」⇒三兄弟全在", () => {
    for (const row of rows) {
      const targets = ROW_TARGETS[row.id] ?? [];
      for (const tok of row.placement.match(/[A-Z_]+_DESCRIPTION/g) ?? []) {
        expect(targets, `${row.id} placement 提到 ${tok}`).toContain(tok);
      }
      if (row.placement.includes("BROWSE 族")) {
        for (const c of [
          "BROWSE_HEADLESS_DESCRIPTION",
          "BROWSE_LOGGED_IN_DESCRIPTION",
          "BROWSE_HEADED_DESCRIPTION",
        ]) {
          expect(targets, `${row.id} 「BROWSE 族」须含 ${c}`).toContain(c);
        }
      }
    }
  });

  it("每个 call-shape 示例在目标 DESCRIPTION 中逐字在场（删例/改写即红）", () => {
    for (const row of rows) {
      for (const span of callShapeSpans(row.cell)) {
        for (const target of ROW_TARGETS[row.id] ?? []) {
          expect(
            CONSTANTS[target],
            `${row.id} 示例须逐字出现在 ${target}`,
          ).toContain(span);
        }
      }
    }
  });

  it("E6 既有 TIMEOUT 句正典锚：budget_ms:300000 在场（零新增字符的正典收编）", () => {
    expect(CONSTANTS.BROWSE_HEADLESS_DESCRIPTION).toContain(
      "budget_ms:300000",
    );
  });
});

// ============================================================
// 闸 1b：consent 共现顺序锚（E8 专用）
// ============================================================
describe("闸 1b · consent 前提与示例不得分离/倒序（browse_headed）", () => {
  it("ASK THE USER FIRST 在示例 call 前且 ≤120 字符内（决议 E 闸 1b 原文正则）", () => {
    expect(CONSTANTS.BROWSE_HEADED_DESCRIPTION).toMatch(
      /ASK THE USER FIRST[\s\S]{0,120}browse_headed\(\{/,
    );
  });

  it("E8 示例行自身携带 consent 前缀（红线：consent 必须内嵌在示例行内）", () => {
    expect(CONSTANTS.BROWSE_HEADED_DESCRIPTION).toContain(
      '// ONLY after ASK THE USER FIRST: browse_headed({url:"https://example.com", action:"snapshot"})',
    );
  });
});

// ============================================================
// 闸 1c：合法值锚
// ============================================================
describe("闸 1c · 示例引用的 action ∈ 合法词汇表", () => {
  it("browse 族示例的 action:\"X\" ∈ BROWSE_ACTIONS；admin 示例的 ∈ adminSchema.action 枚举（admin 的 action 词汇表与 browse 分立——E10 的 browser_recycle 不是 browse action）", () => {
    const legalBrowse = new Set(BROWSE_ACTIONS);
    const legalAdmin = new Set(
      (adminSchema as any).action._def.values as readonly string[],
    );
    for (const [name, text] of Object.entries(CONSTANTS)) {
      const legal = name === "ADMIN_DESCRIPTION" ? legalAdmin : legalBrowse;
      for (const m of text.matchAll(/action:"([a-z_-]+)"/g)) {
        expect(
          legal.has(m[1]),
          `${name} 示例引用了不存在的 action '${m[1]}'`,
        ).toBe(true);
      }
    }
  });
});

// ============================================================
// 闸 1d：call-shape ⊆ schema（顶层参数名 + options 键含一层嵌套）
// ============================================================
describe("闸 1d · call-shape ⊆ 对应工具 zod schema 键", () => {
  it("每个正典示例可被解析（解析器失败即红——示例语法超界须回正典修订）", () => {
    for (const row of readDocRows()) {
      for (const span of callShapeSpans(row.cell)) {
        expect(parseCallShape(span), `${row.id} 解析失败: ${span}`).toBeTruthy();
      }
    }
  });

  it("顶层参数名 + options 键（含一层嵌套）⊆ schema 键（E1 类参数键误植必红）", () => {
    for (const row of readDocRows()) {
      for (const span of callShapeSpans(row.cell)) {
        const parsed = parseCallShape(span)!;
        const schema = TOOL_SCHEMAS[parsed.tool];
        expect(schema, `${row.id} 工具 ${parsed.tool} 无 schema 登记`).toBeTruthy();
        const topKeys = Object.keys(schema);
        for (const k of parsed.top.keys ?? []) {
          expect(
            topKeys.includes(k),
            `${row.id}: 顶层参数 '${k}' ⊄ ${parsed.tool} schema ${JSON.stringify(topKeys)}`,
          ).toBe(true);
        }
        const opts = parsed.top.children?.get("options");
        if (opts && opts.kind === "obj") {
          const optShape = objShape((schema as Record<string, any>).options);
          expect(optShape, `${row.id}: ${parsed.tool} 无 options 对象`).toBeTruthy();
          const optKeys = Object.keys(optShape!);
          for (const k of opts.keys ?? []) {
            expect(
              optKeys.includes(k),
              `${row.id}: options 键 '${k}' ⊄ ${parsed.tool} options ${JSON.stringify(optKeys)}`,
            ).toBe(true);
          }
          // 一层嵌套：steps 项 / screenshot 子对象（selectors/expect 等 record
          // 或更深层次不属本闸范围——doc/usage/04 §E.1 闸 1d 边界）
          for (const [ck, cv] of opts.children ?? []) {
            const field = optShape![ck];
            if (cv.kind === "arr") {
              const itemShape = arrItemShape(field);
              if (itemShape) {
                for (const k of cv.items ?? []) {
                  if (k.kind !== "obj") continue;
                  for (const kk of k.keys ?? []) {
                    expect(
                      Object.keys(itemShape).includes(kk),
                      `${row.id}: steps 项键 '${kk}' ⊄ ${parsed.tool} steps item ${JSON.stringify(Object.keys(itemShape))}`,
                    ).toBe(true);
                  }
                }
              }
            } else if (cv.kind === "obj") {
              const sub = objShape(field);
              if (sub) {
                for (const kk of cv.keys ?? []) {
                  expect(
                    Object.keys(sub).includes(kk),
                    `${row.id}: 子对象键 '${kk}' ⊄ ${parsed.tool}.${ck} ${JSON.stringify(Object.keys(sub))}`,
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });
});

// ============================================================
// 预算帽（§A.3/§E.1——chars 法定单位，先验定值）
// ============================================================
describe("预算帽 · L1 chars / EXAMPLES 行数 / L2 describe chars", () => {
  const PER_CONSTANT_CHAR_CAPS: Record<string, number> = {
    // 基线实测（v1.27.0 @ 0cbd950 dist）+ 650 chars 增量帽，取整到百
    BROWSE_HEADLESS_DESCRIPTION: 13_900, // bug11 决议 §5.1-3 显式提帽（+900）：type/press 两 action 行 + input_guard_suspected RETURNS 句（决议 mandated 文本，紧缩后 13,862；等量裁剪已做——evaluate 块 URL SEMANTICS 与 UNIFIED 段重复 body 收敛为指针，bug10 B.3+D 先例：提帽是一次显式决策）
    BROWSE_LOGGED_IN_DESCRIPTION: 6_000, // 5,273 + 650 → 5,923
    BROWSE_HEADED_DESCRIPTION: 2_500, // 1,830 + 650 → 2,480（bug10 D NOTE 后 2,464）
    SCREENSHOT_DESCRIPTION: 3_500, // 2,830 + 650 → 3,480
    ADMIN_DESCRIPTION: 4_600, // 3,903 + 650 → 4,553
  };

  it("Tier-1 常量 ≤ 基线 + 650 chars（取整到百）", () => {
    for (const [name, cap] of Object.entries(PER_CONSTANT_CHAR_CAPS)) {
      expect(
        CONSTANTS[name].length,
        `${name} = ${CONSTANTS[name].length} > 帽 ${cap}（膨胀红线——裁剪另立单主题）`,
      ).toBeLessThanOrEqual(cap);
    }
  });

  it("L1 fleet：descriptions.ts 19 常量 Σ ≤ 62,250 chars（v1.30 提帽 +2,400：download 工具族入驻[红队红 A4/预算复核 2026-09-20]——单主题提帽先行，描述实写 ≤2,200 留 slack；bug11 §5.1-3 先例 +950）", () => {
    const fleet = Object.entries(CONSTANTS)
      .filter(([k]) => k !== "READ_TEXT_DESCRIPTION")
      .reduce((n, [, v]) => n + v.length, 0);
    expect(
      fleet,
      `fleet = ${fleet}（19 常量，read_text 不计）`,
    ).toBeLessThanOrEqual(62_250);
  });

  it("EXAMPLES 段 ≤5 行/工具（只数 EXAMPLES 块内非头行；内联段落不计）", () => {
    for (const name of Object.keys(PER_CONSTANT_CHAR_CAPS)) {
      const block = CONSTANTS[name]
        .split("\n\n")
        .find((b) => b.startsWith("EXAMPLES"));
      expect(block, `${name} 缺 EXAMPLES 段`).toBeTruthy();
      const lines = block!.split("\n").length - 1;
      expect(
        lines,
        `${name} EXAMPLES 段 ${lines} 行 > 5`,
      ).toBeLessThanOrEqual(5);
    }
  });

  // bug11 决议 D-θ/§5.1-3（doc/bugs/11，2026-09-17）：L2 帽重定基线 2,160 → 2,300。
  // 实测基线（HEAD=b20e23e，v1.28.0）：L2 = 2,157（browse 1,715 + screenshot 214
  // + admin 228），余量 3。bug11 决议 D-2 mandated 文本（no_reload 语义澄清句
  // 「this is NOT a skip-navigation flag — …」~133 chars，语义载荷全在——下午
  // 实机报告 P3 的用户误会本体）远超余量；等量裁剪可行性核尽：action describe
  // 被 (c) 项 exact toBe 模板钉死、freshProfile 开头被 (c) 项字面钉、filePath
  // 被 (d) 项钉——可安全裁的既有冗余仅 ~31 chars（no_reload 句内 "on hash-only
  // targets" 重复 + filePath 主语），缺口 ~80+ 只能靠删真语义或跨 worker 冲突
  // 补。按 §5.1-3 走「显式提帽」先例（bug10 B.3+D 同款）：本 commit 只提帽，
  // 功能文本在后续单主题 commit 落（净增 +113：133 mandated − 20 句内去重）。
  // 〔U-D 半 4c05f64 提帽理由如上；U-T 半 ed72eda 的 +140 派生项见下行 it 标题。〕
  // 并树重定（合并线单主题 commit，2026-09-17）：U-D 与 U-T 两单元并行各自把
  // 本帽从 2,160 提到 2,300（各自单边绿：2,157+113=2,270 / 2,157+132=2,289），
  // 但两单元的 mandated 文本同入一个 fleet——并树实测 L2 = 2,402（基线 2,157
  // + U-D no_reload 语义句 113 + U-T type/press 派生 132），超单边帽 102。
  // §5.1-3 纪律适用：并树并值是双单元显式决策的复合结果（两段文本语义载荷
  // 全在，无一可裁），由合并线另立本单主题提帽 2,300 → 2,450（余 48），不在
  // 功能 commit 里顺手改数字——帽是膨胀红线，不是橡皮筋。
  it("L2 fleet：browse+screenshot+admin schema describe Σ ≤ 2,450 chars（bug11 §5.1-3 提帽：U-D +113 与 U-T +132 并树并值 2,402——BROWSE_ACTIONS 扩员派生/selectors 派生/press key/no_reload 语义句）", () => {
    const l2 =
      describeChars(browseSchema) +
      describeChars(screenshotSchema) +
      describeChars(adminSchema);
    expect(l2, `L2 = ${l2}`).toBeLessThanOrEqual(2_450);
  });
});

function describeChars(obj: Record<string, unknown>): number {
  let n = 0;
  for (const f of Object.values(obj)) n += describeLen(f as any);
  return n;
}
function describeLen(f: any): number {
  if (!f || typeof f !== "object") return 0;
  let n = typeof f.description === "string" ? f.description.length : 0;
  // wrapper（Optional/Default）与 unwrap 后的 inner 是同一棵子树——早退防双计
  const inner = f._def?.innerType;
  if (inner) return n + describeLen(inner);
  if (f.shape) {
    for (const v of Object.values(f.shape)) n += describeLen(v);
  }
  if (f._def?.typeName === "ZodArray") {
    n += describeLen(f.element ?? f._def.element);
  }
  return n;
}

// ============================================================
// 闸 4：schema describe 派生一致（作用域由真源拼出——变异可见）
// ============================================================
describe("闸 4 · schema describe 派生一致（drift-free by construction 的测试面）", () => {
  const describeOf = (f: any): string => (f && typeof f.description === "string" ? f.description : "");

  it("(a) budget_ms describe 含「steps」+「evaluate」双语义词，且 per-action 消费集由 CONSUMED_OPTIONS 派生（摘除 evaluate 表项的 budget_ms 即红）", () => {
    const d = describeOf(
      (unwrap((browseSchema as any).options) as any).shape.budget_ms,
    );
    const derived = Object.entries(CONSUMED_OPTIONS)
      .filter(([, keys]) => keys.includes("budget_ms"))
      .map(([a]) => a)
      .join(" | ");
    expect(d).toContain("steps");
    // 字面钉（真锚非摆设）：重算式断言在真源同变异时会同值漂移（vacuous），
    // 必须另有当日派生值的字面锚——摘 budget_ms 出 CONSUMED_OPTIONS.evaluate
    // 时 describe 变 "for: "，此断言红。
    expect(d).toContain("for: evaluate");
    expect(d).toContain(derived); // 与字面钉一致（模板完整性）
    expect(d).toContain("ignored_options"); // 其余单 action 的诚实回显语义
  });

  it("(b) js describe 三形态关键词 + 与 L1 描述同 claim 双层一致", () => {
    const d = describeOf(
      (unwrap((browseSchema as any).options) as any).shape.js,
    );
    expect(d).toContain("function expression");
    expect(d).toContain("IIFE");
    expect(d).toContain("statement body");
    // L1 同 claim（tool-descriptions-no-leak 三方一致模式的同款双层锚）
    expect(CONSTANTS.BROWSE_HEADLESS_DESCRIPTION).toContain(
      "THREE forms accepted",
    );
    expect(CONSTANTS.BROWSE_HEADLESS_DESCRIPTION).toMatch(
      /statement\s+body like `return document\.title` is wrapped and invoked\. All work\./,
    );
  });

  it("(c) 派生源变异可见：action describe === BROWSE_ACTIONS/CURRENT_PAGE_ACTIONS 模板拼装（手写漂移即红）；no_reload/freshProfile 作用域文本含真源派生片段", () => {
    // action describe 的每一分片都来自真源（格式模板 + 派生清单）
    const actionD = describeOf((browseSchema as any).action);
    expect(actionD).toBe(
      `one of: ${BROWSE_ACTIONS.join(" | ")}. url-optional (current-page) actions: ${[...CURRENT_PAGE_ACTIONS].join(" | ")}`,
    );
    // steps[].action 同源同文（browse 三兄弟共用 schema——单点）
    const optionsShape = (unwrap((browseSchema as any).options) as any).shape;
    const stepsArr = unwrap(optionsShape.steps);
    const stepsItem = unwrap(stepsArr.element); // ZodArray.element → ZodObject
    const stepsActionD = describeOf(stepsItem.shape.action);
    expect(stepsActionD).toBe(actionD);

    // no_reload 作用域 = CONSUMED_OPTIONS 反查（字面钉：今日七 action——真源
    // 摘任一项，describe 随派生变化，此断言红；重算式仅锁模板完整性）
    const noReloadD = describeOf(
      (unwrap((browseSchema as any).options) as any).shape.no_reload,
    );
    const derivedNoReload = Object.entries(CONSUMED_OPTIONS)
      .filter(([, keys]) => keys.includes("no_reload"))
      .map(([a]) => a)
      .join(" | ");
    expect(noReloadD).toContain("consumed by: navigate | snapshot | screenshot | extract | evaluate | pdf | network");
    expect(noReloadD).toContain(derivedNoReload);

    // freshProfile 作用域 = ENTRY_CONSUMED_OPTION_KEYS（字面钉：今日唯一入口级键）
    const freshD = describeOf(
      (unwrap((browseSchema as any).options) as any).shape.freshProfile,
    );
    expect(freshD).toContain("entry-level option (freshProfile");
    expect(freshD).toContain(
      `entry-level option (${[...ENTRY_CONSUMED_OPTION_KEYS].join(" | ")}`,
    );
  });

  it("(d) screenshot.filePath describe 半行：仅 screenshot 消费 + 其余 action 回显 ignored_options（E14 的 L2 面）", () => {
    const shotObj = unwrap(
      (unwrap((browseSchema as any).options) as any).shape.screenshot,
    );
    const d = describeOf(shotObj.shape.filePath);
    expect(d).toContain("consumed only by: screenshot");
    expect(d).toContain("ignored_options");
  });
});
