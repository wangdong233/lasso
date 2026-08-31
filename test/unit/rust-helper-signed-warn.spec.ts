/**
 * #4（2026-08-31 用户裁决）：doctor #15 rust_helper_signed 的 ad-hoc 分支
 * FAIL → warn——ad-hoc 是官方免费合法签名，功能正常（唯一代价 rebuild 后 TCC
 * 重授权），FAIL 语义把正常配置判成 ready:false 属噪音。
 *
 * 测试（注入式 execProbe，零真实 codesign 调用）：
 *  1. ad-hoc 形态输出（CodeSignature/Identifier= 有、Authority=Developer ID 无）
 *     → status=warn + detail 含「功能正常」「重新系统授权」+ next_step 含 LASSO_DEV_ID
 *  2. Developer ID 形态 → pass（回归锚：降级不误伤正道）
 *  3. 完全无签名输出 + binary 存在 → 仍 warn（诚实分支不回归）
 */
import { describe, it, expect } from "vitest";
import { checkRustHelperSigned } from "../../src/desktop/desktop-doctor-checks.js";

const ADHOC_OUT = `Executable=/x/lasso-rust-helper
Identifier=lasso-rust-helper-1700
Format=Mach-O thin (x86_64)
CodeDirectory v=20400 size=... flags=0x2(adhoc) hashes=1+...
Signature=adhoc
TeamIdentifier=not set`;

const DEVID_OUT = `Executable=/x/lasso-rust-helper
Identifier=lasso-rust-helper-1700
Authority=Developer ID Application: Wang Dong (TEAM12345)
Signature size=9025`;

describe("doctor #15 rust_helper_signed — ad-hoc FAIL→warn（用户裁决 2026-08-31）", () => {
  it("ad-hoc 形态 → warn + 诚实代价描述 + Developer ID 长期方案 next_step", async () => {
    const c = await checkRustHelperSigned("/x/helper", async () => ({
      stdout: ADHOC_OUT,
      stderr: "",
    }));
    expect(c.name).toBe("rust_helper_signed");
    expect(c.status).toBe("warn"); // 原 fail —— 裁决核心
    expect(c.detail).toContain("ad-hoc");
    expect(c.detail).toContain("功能正常");
    expect(c.detail).toContain("重新系统授权");
    expect(c.next_step ?? "").toContain("LASSO_DEV_ID");
  });

  it("Developer ID 形态 → pass（降级不误伤正道）", async () => {
    const c = await checkRustHelperSigned("/x/helper", async () => ({
      stdout: DEVID_OUT,
      stderr: "",
    }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("Developer ID Application");
  });

  it("codesign 无输出（未签 binary 存在）→ warn 诚实分支保持", async () => {
    const c = await checkRustHelperSigned("/x/helper", async () => ({
      stdout: "",
      stderr: "code object is not signed at all",
    }));
    // stderr 拼入 stdout 检测串（实现把两者拼接），无 CodeSignature/Identifier/Authority
    // → 落到「无任何关键字」分支：binary 存在 → warn（诚实语义）
    expect(c.status).toBe("warn");
  });
});
