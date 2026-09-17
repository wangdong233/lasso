/**
 * bug10-b-description-truth.spec.ts（doc/bugs/10 决议 B.3 + D，2026-09-17）
 *
 * U-B【browse+docs】描述真值钉——描述与钉它的断言同 commit（INV-92 族）：
 *  - B.3：evaluate 段「All work.」后的 RETURNS 契约句（实机报告 P2 的描述
 *    缺口即本体——「THREE forms … All work」对裸表达式/对象字面量形态为假，
 *    D-δ）；
 *  - D：browse_headless/headed 的「click worked ≠ 提交被接受」标注（tm.aliyun.com
 *    分层拦截面实测——提交层静默吞掉，doc/usage/02-TROUBLESHOOTING.md §2.18
 *    与描述互为指针）；
 *  - 描述 claim ↔ 运行时真源交叉锚：描述说「single-line EXPRESSION 自动返回值」
 *    → evaluateJsForm（BrowseChannel 单一真源）的形态判定必须与之一致（描述
 *    漂移或实现漂移任一侧都红）。
 *
 * 摘除任一句（删句/改写/移段）即红。DESKTOP/其余工具零触碰（U-R 域）。
 */
import { describe, it, expect } from "vitest";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_HEADED_DESCRIPTION,
} from "../../src/tools/descriptions.js";
import { evaluateJsForm } from "../../src/channels/BrowseChannel.js";

describe("bug10 决议 B.3 — evaluate RETURNS 契约句（P2 描述缺口本体）", () => {
  it("① 「All work.」旧句保持完整（闸 4(b) 正则锚不破坏——新句是追加不是改写）", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
      /statement\s+body like `return document\.title` is wrapped and invoked\. All work\./,
    );
  });

  it("② RETURNS 句在场：单行表达式自动包裹 + 值返回（摘除即红）", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "any other single-line EXPRESSION",
    );
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "is auto-wrapped and its VALUE returned",
    );
    // 决议 B.3 原文三个示例形态（`JSON.stringify({...})`、`({a:1})`、`document.title`）
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain("(`JSON.stringify({...})`,");
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain("`({a:1})`, `document.title`)");
  });

  it("③ 诚实边界句在场：多语句体不 return 恒 undefined + 一表达式一调偏好", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
      /multi-statement bodies \(declarations \/ `;` \/ multiple lines\) return\s+undefined unless you `return`/,
    );
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "prefer one expression per call",
    );
  });

  it("④ B.2 回执面同步披露：js_form 教学回执在描述中有名有姓", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "echoes data.js_form + hint",
    );
  });

  it("⑤ 描述 claim ↔ 运行时真源交叉锚：描述承诺的三个示例形态在 evaluateJsForm 单一真源全部命中表达式路由", () => {
    // 描述说它们「auto-wrapped and its VALUE returned」——实现侧必须同为
    // 表达式路由（任一侧漂移：改描述不改实现 / 改实现不改描述，都红）。
    expect(evaluateJsForm("JSON.stringify({a:1})")).toBe("single_expression");
    expect(evaluateJsForm("({a:1})")).toBe("paren_expression");
    expect(evaluateJsForm("document.title")).toBe("single_expression");
    // 诚实边界同步：多行/声明在实现侧确为语句体（undefined 语义的来源）
    expect(evaluateJsForm("const a = 1")).toBe("statement_body");
    expect(evaluateJsForm("JSON.stringify({\na:1\n})")).toBe("statement_body");
  });
});

describe("bug10 决议 D — 「click worked ≠ 提交被接受」标注（P1 拦截面位移）", () => {
  it("① browse_headless Returns 段 NOTE：静默吞提交 + 判定法（wait/extract）+ §2.18 指针", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "form submissions may be silently swallowed by anti-bot",
    );
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "click worked means 'event delivered', NOT 'accepted'",
    );
    expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(
      /verify\s+with wait url_contains\/text or extract — never trust click worked alone/,
    );
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain(
      "doc/usage/02-TROUBLESHOOTING.md §2.18",
    );
  });

  it("② browse_headed NOTE：提交层弹滑块 + captcha iframe 跨域 evaluate/AX 双盲 + 组合配方指针", () => {
    expect(BROWSE_HEADED_DESCRIPTION).toContain(
      "on sites whose submission layer challenges",
    );
    expect(BROWSE_HEADED_DESCRIPTION).toContain("cross-origin");
    expect(BROWSE_HEADED_DESCRIPTION).toMatch(
      /evaluate and AX are both blind to it/,
    );
    expect(BROWSE_HEADED_DESCRIPTION).toMatch(
      /see the desktop tool\s+description/,
    );
    expect(BROWSE_HEADED_DESCRIPTION).toContain(
      "doc/usage/02-TROUBLESHOOTING.md §2.18",
    );
  });

  it("③ 两处 NOTE 均指向 §2.18（与 TROUBLESHOOTING 文档互为指针——描述侧锚）", () => {
    // §2.18 标题本体在 doc 侧（不进本 spec 的 markdown 解析面）；描述侧的双
    // 指针在此钉死——§2.18 改号/改名时两处 NOTE 必须同 commit 更新。
    const headlessHits = BROWSE_HEADLESS_DESCRIPTION.match(/§2\.18/g) ?? [];
    const headedHits = BROWSE_HEADED_DESCRIPTION.match(/§2\.18/g) ?? [];
    expect(headlessHits.length).toBe(1); // headless 恰一处（NOTE 内）
    expect(headedHits.length).toBe(1); // headed 恰一处（NOTE 内）
  });
});
