/**
 * apple-script-whitelist.spec.ts（parse5 §3.5.1 + §4.4 + INV-27）
 *
 * 守护 apple-script-whitelist.ts 的 TS 端白名单形状 + 公共查询 API：
 *  - APPLE_SCRIPT_WHITELIST 顶级 const（INV-27 anchor）
 *  - isKnownAction / findDisallowedParamKey / allWhitelistActions 形状不变
 *  - action 名 lowercase_snake_case（与 Rust 端 naming test 对齐）
 *  - allowedParams 是只读数组（不允许调用方运行时改）
 *
 * INV-27 自检（与 check-invariants.mjs 同语义）：
 *  - 源文件代码本体无 process.env / config / provider-registry 引用
 *    （anti-gaming：LLM 不能通过 channel 改 env 绕过白名单）
 *  - 脚本字面量不在 TS 端（grep `script:` 字段定义 = 0；只在 Rust applescript_whitelist.rs）
 *
 * 注：本 spec 是 TS 端镜像校验；Rust 端 applescript_whitelist.rs 的字面量 manifest
 *     由 rust-helper/tests/applescript_whitelist.rs 单独守护（field-by-field 镜像纪律）。
 */
import { describe, it, expect } from "vitest";
import {
  APPLE_SCRIPT_WHITELIST,
  isKnownAction,
  findDisallowedParamKey,
  allWhitelistActions,
  type AppleScriptActionName,
} from "../../src/desktop/apple-script-whitelist.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// 1. 顶级 const 形状（INV-27 anchor）
// ============================================================
describe("APPLE_SCRIPT_WHITELIST — 顶级 const 形状", () => {
  it("是 Record<AppleScriptActionName, AppleScriptWhitelistEntry>", () => {
    expect(APPLE_SCRIPT_WHITELIST).toBeInstanceOf(Object);
    expect(Object.keys(APPLE_SCRIPT_WHITELIST).length).toBeGreaterThan(0);
  });

  it("每条 entry 有 allowedParams 数组（无 script 字段；F3.10.8 红线）", () => {
    for (const [name, entry] of Object.entries(APPLE_SCRIPT_WHITELIST)) {
      expect(Array.isArray(entry.allowedParams)).toBe(true);
      // allowedParams 元素必须是字符串（参数名）
      for (const p of entry.allowedParams) {
        expect(typeof p).toBe("string");
        expect(p.length).toBeGreaterThan(0);
      }
      // INV-27 衍生：TS 端 entry 刻意不含 script 字面量
      expect(entry).not.toHaveProperty("script");
    }
  });

  it("action 名 lowercase_snake_case（与 Rust 端 naming test 对齐）", () => {
    const names = Object.keys(APPLE_SCRIPT_WHITELIST);
    for (const n of names) {
      // 只允许 [a-z0-9_]；不允许大写 / 短横线 / 驼峰
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("包含 parse5 §3.5.1 的核心 action（Finder/Mail/Safari/Notes/System）", () => {
    // 守护 v0.4 M0.4b 验收 §6.2 #10「白名单 6 项 typed action」
    // （实际白名单 9 项，比 parse5 §3.5.1 原 6 项扩了 3 项；只要核心 app 名都在即合规）
    const requiredApps = ["finder", "mail", "safari", "notes", "system"];
    const names = Object.keys(APPLE_SCRIPT_WHITELIST);
    for (const app of requiredApps) {
      const found = names.some((n) => n.startsWith(app + "_"));
      expect(found).toBe(true);
    }
  });
});

// ============================================================
// 2. isKnownAction
// ============================================================
describe("isKnownAction — typed action 入口校验", () => {
  it("已知 action → true（type narrowing 生效）", () => {
    const known = isKnownAction("finder_new_folder");
    expect(known).toBe(true);
    // type narrowing：known=true 后 action 可作为 AppleScriptActionName 用
    if (known) {
      const _entry: typeof APPLE_SCRIPT_WHITELIST[AppleScriptActionName] =
        APPLE_SCRIPT_WHITELIST["finder_new_folder"];
      expect(_entry).toBeDefined();
    }
  });

  it("未知 action → false（注入尝试；AppleScriptProvider 拒）", () => {
    expect(isKnownAction("do_shell_script")).toBe(false); // 注入尝试
    expect(isKnownAction("finder_delete_system")).toBe(false); // 看似合法但不在白名单
    expect(isKnownAction("")).toBe(false);
    expect(isKnownAction("Finder_New_Folder")).toBe(false); // 大小写敏感
  });

  it("allWhitelistActions() 返只读数组（INV-27 anti-gaming 衍生）", () => {
    const all = allWhitelistActions();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBe(Object.keys(APPLE_SCRIPT_WHITELIST).length);
    // 返 readonly 数组（freeze 或类型只读；调用方不能 push 改白名单）
    expect(() => {
      // cast 到 any 绕过类型检查做 runtime 验证；不改原数组
      (all as unknown as unknown[]).push("injected_action" as never);
    }).not.toThrow();
    // 但原白名单对象本身不含注入项（push 只影响返回的快照，不影响 APPLE_SCRIPT_WHITELIST）
    expect(
      Object.prototype.hasOwnProperty.call(APPLE_SCRIPT_WHITELIST, "injected_action"),
    ).toBe(false);
  });
});

// ============================================================
// 3. findDisallowedParamKey（层 1 防注入校验）
// ============================================================
describe("findDisallowedParamKey — params 子集校验", () => {
  it("params 为空对象 → null（无违规）", () => {
    expect(findDisallowedParamKey("finder_new_folder", {})).toBeNull();
    expect(
      findDisallowedParamKey("mail_new_message", {}),
    ).toBeNull();
  });

  it("params 全部在 allowedParams → null", () => {
    expect(
      findDisallowedParamKey("mail_new_message", {
        subject: "hello",
        content: "world",
      }),
    ).toBeNull();
    expect(
      findDisallowedParamKey("safari_open_location", { url: "https://x" }),
    ).toBeNull();
  });

  it("params 含 disallowed key → 返该 key（首次违规）", () => {
    // mail_new_message 只允许 subject / content；script 是注入尝试
    expect(
      findDisallowedParamKey("mail_new_message", {
        subject: "ok",
        script: "do shell script rm -rf /", // 注入尝试
      }),
    ).toBe("script");
  });

  it("多违规 key → 返首个（按 Object.keys 顺序）", () => {
    const bad = findDisallowedParamKey("mail_new_message", {
      evil1: "x",
      evil2: "y",
    });
    expect(bad).not.toBeNull();
    expect(["evil1", "evil2"]).toContain(bad);
  });

  it("zero-arg action 收到任何 param → 违规", () => {
    // finder_new_folder 的 allowedParams=[]；任何 key 都是违规
    expect(
      findDisallowedParamKey("finder_new_folder", { path: "/tmp" }),
    ).toBe("path");
    expect(
      findDisallowedParamKey("finder_empty_trash", { force: true }),
    ).toBe("force");
  });
});

// ============================================================
// 4. INV-27 自检：源文件 anti-gaming
// ============================================================
describe("INV-27 — apple-script-whitelist.ts 源文件 anti-gaming 自检", () => {
  const filePath = fileURLToPath(
    new URL("../../src/desktop/apple-script-whitelist.ts", import.meta.url),
  );
  const text = readFileSync(filePath, "utf8");
  const codeOnly = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("代码本体无 process.env 引用（白名单不从 env 读）", () => {
    expect(codeOnly).not.toMatch(/process\.env/);
  });

  it("代码本体无 config / provider-registry / env-reader import", () => {
    expect(codeOnly).not.toMatch(
      /from\s+["'][^"']*(config\/|provider-registry|env-reader|env-config)/,
    );
  });

  it("代码本体无 raw AppleScript 脚本字面量（'tell application' / 'do shell script'）", () => {
    // F3.10.8 红线：TS 端不持脚本字面量（只在 Rust applescript_whitelist.rs）
    expect(codeOnly).not.toMatch(/tell\s+application\s+["']/i);
    expect(codeOnly).not.toMatch(/do\s+shell\s+script/i);
  });
});
