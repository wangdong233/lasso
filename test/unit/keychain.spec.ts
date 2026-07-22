/**
 * keychain v0.8 单测（parse9 §3.4 + §5.1）
 *
 * 覆盖：
 *  - macOS keychain 分支（mock _internals.execFileP）：find 现有 / not found → 生成 + add
 *  - env fallback（Linux/Win）：LASSO_COOKIE_PASSPHRASE ≥16 chars OK / <16 抛错 / 缺失抛错
 *  - INV-51 红线：master key 不硬编码（randomBytes 生成）
 *  - 60s cache：重复调用不重复触发 execFile
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getKeychainKey,
  _internals,
  _clearKeyCacheForTests,
} from "../../src/logged-in/keychain.js";

const origPlatform = _internals.platform;
const origExecFileP = _internals.execFileP;

beforeEach(() => {
  _clearKeyCacheForTests();
  delete process.env.LASSO_COOKIE_PASSPHRASE;
});

afterEach(() => {
  _clearKeyCacheForTests();
  _internals.platform = origPlatform;
  _internals.execFileP = origExecFileP;
  delete process.env.LASSO_COOKIE_PASSPHRASE;
});

// ============================================================
// env fallback（Linux/Win 路径）
// ============================================================
describe("keychain — env fallback (Linux)", () => {
  beforeEach(() => {
    _internals.platform = () => "linux";
  });

  it("LASSO_COOKIE_PASSPHRASE ≥16 chars → 返 env 值", async () => {
    process.env.LASSO_COOKIE_PASSPHRASE = "a-very-long-passphrase-12345";
    const key = await getKeychainKey();
    expect(key).toBe("a-very-long-passphrase-12345");
  });

  it("LASSO_COOKIE_PASSPHRASE 恰好 16 chars → OK（边界）", async () => {
    process.env.LASSO_COOKIE_PASSPHRASE = "0123456789abcdef"; // 16 chars
    const key = await getKeychainKey();
    expect(key).toBe("0123456789abcdef");
  });

  it("LASSO_COOKIE_PASSPHRASE <16 chars → master_key_unavailable", async () => {
    process.env.LASSO_COOKIE_PASSPHRASE = "short";
    await expect(getKeychainKey()).rejects.toThrow(/master_key_unavailable/);
  });

  it("LASSO_COOKIE_PASSPHRASE 未设 → master_key_unavailable", async () => {
    await expect(getKeychainKey()).rejects.toThrow(/master_key_unavailable/);
  });

  it("错误消息含 env 变量名 + 最短长度提示", async () => {
    try {
      await getKeychainKey();
      throw new Error("should have thrown");
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("LASSO_COOKIE_PASSPHRASE");
      expect(msg).toContain(">=16");
    }
  });
});

// ============================================================
// macOS keychain 分支（mock execFileP）
// ============================================================
describe("keychain — macOS keychain 分支（mock security CLI）", () => {
  beforeEach(() => {
    _internals.platform = () => "darwin";
  });

  it("find-generic-password 命中 → 返 keychain 存的 key（trim 换行）", async () => {
    _internals.execFileP = vi.fn().mockResolvedValue({
      stdout: "keychain-stored-key-base64==\n",
      stderr: "",
    }) as any;
    const key = await getKeychainKey();
    expect(key).toBe("keychain-stored-key-base64==");
    // 校验调 security CLI 正确参数
    expect(_internals.execFileP).toHaveBeenCalledWith("security", [
      "find-generic-password",
      "-s",
      "lasso-cookie",
      "-a",
      "master",
      "-w",
    ]);
  });

  it("find 失败（keychain 未配）→ 自动生成 32B 随机 + add-generic-password", async () => {
    const calls: any[] = [];
    _internals.execFileP = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "find-generic-password") {
        throw new Error("The specified item could not be found");
      }
      if (args[0] === "add-generic-password") {
        return { stdout: "", stderr: "" };
      }
      throw new Error("unexpected");
    }) as any;

    const key = await getKeychainKey();
    // 生成的 key 解 base64 后应恰好 32 字节（AES-256 派生源）
    const decoded = Buffer.from(key, "base64");
    expect(decoded.length).toBe(32);
    // add 调用参数含 -U（update if exists）
    const addCall = calls.find((a) => a[0] === "add-generic-password");
    expect(addCall).toBeDefined();
    expect(addCall).toContain("-U");
    expect(addCall).toContain("lasso-cookie");
    // 同一 key 不会重复生成（cache 内）
    const key2 = await getKeychainKey();
    expect(key2).toBe(key);
  });

  it("find 返空 stdout → 视为未配 → 生成新 key", async () => {
    _internals.execFileP = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "find-generic-password") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as any;
    const key = await getKeychainKey();
    expect(Buffer.from(key, "base64").length).toBe(32);
  });

  it("find 命中 + add 不可达时不被调（happy path）", async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: "existing-key\n",
      stderr: "",
    }) as any;
    _internals.execFileP = execMock;
    await getKeychainKey();
    // 只 find 被调一次
    expect(execMock).toHaveBeenCalledTimes(1);
    const args = execMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe("find-generic-password");
  });

  it("INV-51：生成的 key 是随机的（两次生成不同）", async () => {
    let findCallCount = 0;
    _internals.execFileP = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "find-generic-password") {
        findCallCount++;
        // 每次都未配 → 触发两次生成
        throw new Error("not found");
      }
      return { stdout: "", stderr: "" };
    }) as any;
    const key1 = await getKeychainKey();
    _clearKeyCacheForTests();
    const key2 = await getKeychainKey();
    expect(findCallCount).toBe(2);
    expect(key1).not.toBe(key2);
  });
});

// ============================================================
// 60s cache（parse9 §7.1 R-v08-6）
// ============================================================
describe("keychain — 60s cache（性能）", () => {
  beforeEach(() => {
    _internals.platform = () => "linux";
    process.env.LASSO_COOKIE_PASSPHRASE = "cached-passphrase-sufficient-length";
  });

  it("60s 内重复调用返同实例（无重复 execFile / env 读）", async () => {
    const k1 = await getKeychainKey();
    const k2 = await getKeychainKey();
    expect(k1).toBe(k2);
  });

  it("清 cache 后再调 → 重读 env", async () => {
    const k1 = await getKeychainKey();
    _clearKeyCacheForTests();
    process.env.LASSO_COOKIE_PASSPHRASE = "changed-passphrase-also-long-enough";
    const k2 = await getKeychainKey();
    expect(k1).not.toBe(k2);
  });
});
