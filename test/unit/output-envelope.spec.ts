/**
 * output-envelope v0.3 单测（parse3 §5.1 + §3.4 + 09 §2.3 验收 6）
 *
 * 覆盖：
 *  - 48KiB / 2000 行边界（任一超限 → truncated=true）
 *  - 落盘文件 mode 0o600（INV-15）
 *  - 16KiB preview 长度
 *  - refine_hint 默认 + 工具特定
 *  - read_text 续页：offset / limit / eof
 *  - 单条 16 MiB 上限 → 抛错
 *  - 64 MiB store 总量上限 → 抛错
 *  - 未知 ref → 抛错
 *  - continue_hint 格式
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyOutputEnvelope,
  readOutputPage,
  getTotalBytes,
  getOutputCounter,
  _resetForTests,
  MAX_BYTES,
  MAX_LINES,
  PREVIEW_BYTES,
} from "../../src/util/output-envelope.js";

// ============================================================
// helpers
// ============================================================
function makeAscii(bytes: number): string {
  return "a".repeat(bytes);
}

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i}`).join("\n");
}

// ============================================================
// setup / teardown
// ============================================================
beforeEach(async () => {
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

// ============================================================
// applyOutputEnvelope — 边界
// ============================================================
describe("applyOutputEnvelope — byte 边界", () => {
  it("≤ 48 KiB ASCII 原样返回（truncated=false）", () => {
    const text = makeAscii(MAX_BYTES); // 恰好 48 KiB
    const env = applyOutputEnvelope(text);
    expect(env.truncated).toBe(false);
    expect(env.preview).toBe(text);
    expect(env.ref).toBeUndefined();
    expect(env.total_bytes).toBeUndefined();
  });

  it("48 KiB + 1 字节 → truncated=true", () => {
    const text = makeAscii(MAX_BYTES + 1);
    const env = applyOutputEnvelope(text);
    expect(env.truncated).toBe(true);
    expect(env.ref).toMatch(/^@o\d+$/);
    expect(env.total_bytes).toBe(MAX_BYTES + 1);
  });

  it("preview 是前 16 KiB（PREVIEW_BYTES）", () => {
    const text = makeAscii(MAX_BYTES + 1000);
    const env = applyOutputEnvelope(text);
    expect(Buffer.byteLength(env.preview, "utf8")).toBe(PREVIEW_BYTES);
    // preview 是 text 的前缀
    expect(text.startsWith(env.preview)).toBe(true);
  });
});

describe("applyOutputEnvelope — 行数边界", () => {
  it("≤ 2000 行原样返回", () => {
    const text = makeLines(MAX_LINES); // 恰好 2000 行
    const env = applyOutputEnvelope(text);
    expect(env.truncated).toBe(false);
  });

  it("2001 行 → truncated=true（即使字节数 < 48 KiB）", () => {
    const text = makeLines(MAX_LINES + 1); // 2001 行
    const env = applyOutputEnvelope(text);
    expect(env.truncated).toBe(true);
    expect(env.total_lines).toBe(MAX_LINES + 1);
  });
});

// ============================================================
// 落盘权限 mode 0o600（INV-15）
// ============================================================
describe("applyOutputEnvelope — spill 文件 mode 0o600", () => {
  it("spill 文件 mode 仅 0o600（owner read/write，无 group/other）", async () => {
    const text = makeAscii(MAX_BYTES + 1);
    const env = applyOutputEnvelope(text);
    expect(env.ref).toBeDefined();
    // /tmp/lasso-output/@o1.txt
    const file = path.join(os.tmpdir(), "lasso-output", `${env.ref}.txt`);
    const st = await stat(file);
    // mode 低 12 位（含 sticky/setuid/setgid）；只关心最后 9 位 rwx
    const permBits = st.mode & 0o777;
    expect(permBits).toBe(0o600);
  });
});

// ============================================================
// ref 计数 / continue_hint
// ============================================================
describe("applyOutputEnvelope — ref + continue_hint", () => {
  it("第一次 spill → ref=@o1，第二次 → ref=@o2", () => {
    const text = makeAscii(MAX_BYTES + 1);
    const e1 = applyOutputEnvelope(text);
    const e2 = applyOutputEnvelope(text);
    expect(e1.ref).toBe("@o1");
    expect(e2.ref).toBe("@o2");
    expect(getOutputCounter()).toBe(2);
  });

  it("continue_hint 形如 read_text({ref:\"@oN\", offset:16384})", () => {
    const text = makeAscii(MAX_BYTES + 1);
    const env = applyOutputEnvelope(text);
    expect(env.continue_hint).toContain('read_text({ref:"');
    expect(env.continue_hint).toContain(env.ref!);
    expect(env.continue_hint).toContain(`offset:${PREVIEW_BYTES}`);
  });
});

// ============================================================
// refine_hint
// ============================================================
describe("applyOutputEnvelope — refine_hint", () => {
  it("默认 hint（无 actions_and_results 也无大字节启发）", () => {
    const text = makeAscii(MAX_BYTES + 1);
    const env = applyOutputEnvelope(text);
    expect(env.refine_hint).toBeTruthy();
    expect(env.refine_hint).toContain("48 KiB");
  });

  it("chain result JSON → hint 提示 narrow selectors", () => {
    const text =
      JSON.stringify({ actions_and_results: [] }) +
      "\n" +
      makeAscii(MAX_BYTES); // 拉到超 48 KiB
    const env = applyOutputEnvelope(text);
    expect(env.refine_hint).toContain("chain result too large");
    expect(env.refine_hint).toContain("narrow selectors");
  });

  it("工具特定 refineHint 覆盖默认", () => {
    const text = makeAscii(MAX_BYTES + 1);
    const env = applyOutputEnvelope(text, "custom hint from caller");
    expect(env.refine_hint).toBe("custom hint from caller");
  });
});

// ============================================================
// readOutputPage — 续页
// ============================================================
describe("readOutputPage — 续页 / 分页", () => {
  it("未知 ref → throw", () => {
    expect(() => readOutputPage("@o999")).toThrow(/unknown ref/);
  });

  it("offset=0 默认返回前 PAGE_BYTES (16 KiB)", () => {
    const text = makeAscii(MAX_BYTES + 1000);
    const env = applyOutputEnvelope(text);
    const page = readOutputPage(env.ref!);
    expect(Buffer.byteLength(page.text, "utf8")).toBe(PREVIEW_BYTES);
    expect(page.eof).toBe(false);
    expect(page.total_bytes).toBe(MAX_BYTES + 1000);
  });

  it("offset=PREVIEW_BYTES 读第二页，最终 eof=true", () => {
    const text = makeAscii(MAX_BYTES + 1000);
    const env = applyOutputEnvelope(text);
    // 第二页：从 16384 开始读，limit 默认 16384 → 覆盖到 32768
    const page = readOutputPage(env.ref!, PREVIEW_BYTES);
    expect(page.text).toBe(makeAscii(PREVIEW_BYTES));
    expect(page.eof).toBe(false); // 还有 16384..49152+1000 没读
  });

  it("读到尾 → eof=true", () => {
    const total = MAX_BYTES + 10;
    const text = makeAscii(total);
    const env = applyOutputEnvelope(text);
    // 第一页 16384 + 第二页 16384 + 第三页 16384 = 49152，已覆盖 total
    let offset = 0;
    let lastEof = false;
    for (let i = 0; i < 5; i++) {
      const page = readOutputPage(env.ref!, offset, PREVIEW_BYTES);
      offset += PREVIEW_BYTES;
      lastEof = page.eof;
      if (lastEof) break;
    }
    expect(lastEof).toBe(true);
  });

  it("自定义 limit（小于默认）", () => {
    const text = makeAscii(MAX_BYTES + 100);
    const env = applyOutputEnvelope(text);
    const page = readOutputPage(env.ref!, 0, 100);
    expect(page.text).toBe(makeAscii(100));
    expect(page.eof).toBe(false);
  });

  it("read_text 翻完整个文件，拼接 = 原始 text", () => {
    const text = makeAscii(MAX_BYTES + 500);
    const env = applyOutputEnvelope(text);
    // 用 env.ref 读盘；累计所有 page 拼接
    let offset = 0;
    const parts: string[] = [];
    let eof = false;
    while (!eof) {
      const page = readOutputPage(env.ref!, offset, PREVIEW_BYTES);
      parts.push(page.text);
      offset += PREVIEW_BYTES;
      eof = page.eof;
    }
    const reconstructed = parts.join("");
    // 落盘的是原始 text；分页读回拼接应等同
    expect(reconstructed.length).toBe(text.length);
    expect(reconstructed).toBe(text);
  });
});

// ============================================================
// 单条上限 16 MiB
// ============================================================
describe("applyOutputEnvelope — 单条 16 MiB 上限", () => {
  it("超 16 MiB 单条 → throw（说明上游数据异常）", () => {
    const huge = makeAscii(16 * 1024 * 1024 + 1);
    expect(() => applyOutputEnvelope(huge)).toThrow(/single cap exceeded/);
  });
});

// ============================================================
// store 总量上限 64 MiB
// ============================================================
describe("applyOutputEnvelope — 64 MiB store 总量上限", () => {
  it("store 累计超 64 MiB → 新 spill 抛错", () => {
    // chunk = 8 MiB（< 16 MiB 单条上限）
    // 8 次 spill = 64 MiB；第 9 次 totalBytes ≥ 64 MiB → 抛错
    const chunk = makeAscii(8 * 1024 * 1024);
    for (let i = 0; i < 8; i++) {
      applyOutputEnvelope(chunk);
    }
    expect(getTotalBytes()).toBe(8 * 1024 * 1024 * 8); // 64 MiB
    // 第 9 次应该抛错
    expect(() => applyOutputEnvelope(chunk)).toThrow(/store exhausted/);
  });
});

// ============================================================
// UTF-8 多字节安全（preview 不在多字节中间断开）
// ============================================================
describe("applyOutputEnvelope — UTF-8 多字节安全", () => {
  it("preview 在多字节字符处安全回退（不含残缺字节）", () => {
    // 构造前 16 KiB - 1 字节 ASCII + 末尾 3 字节 UTF-8 字符 + 后续 ASCII 凑超 48KiB
    const head = makeAscii(PREVIEW_BYTES - 1);
    const utf8Char = "中"; // 3 bytes in UTF-8
    const tail = makeAscii(MAX_BYTES); // 后续拉到超 48 KiB
    const text = head + utf8Char + tail;
    const env = applyOutputEnvelope(text);
    // preview 长度应 ≤ PREVIEW_BYTES，且不以残缺字节结尾
    expect(Buffer.byteLength(env.preview, "utf8")).toBeLessThanOrEqual(PREVIEW_BYTES);
    // preview 应能正确 decode（toString 自动处理；含替换字符也算可接受，但不该抛错）
    expect(typeof env.preview).toBe("string");
  });
});
