/**
 * CookieStore v0.8 单测（parse9 §3.1 + §5.1 + §1.3 隐私红线）
 *
 * 加密安全核心，覆盖全：
 *  - AES-256-GCM round-trip（export → import 字节级一致）
 *  - 篡改 auth tag 失败（密文改 / tag 改 / 错 key → cookie_auth_tag_failed）
 *  - IV 唯一性（两次 export 同明文密文不同）
 *  - mode 0o600 实测 stat（非 mock，实落盘 tmp 文件）+ 目录 0o700
 *  - stat() 只返元数据 + 密文 sha256（不解密 / 不读 cookie 字段）
 *  - 错误路径：bad magic / not found / bad length
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CookieStore } from "../../src/logged-in/CookieStore.js";
import {
  _internals,
  _clearKeyCacheForTests,
} from "../../src/logged-in/keychain.js";
import type { CdpCookie } from "../../src/logged-in/CdpClient.js";

// ============================================================
// helpers
// ============================================================
const TEST_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";

function makeCookie(name: string): CdpCookie {
  return {
    name,
    value: `value-${name}-1234567890abcdef`,
    domain: "example.com",
    path: "/",
    size: 24,
    httpOnly: true,
    secure: true,
    session: false,
  };
}

let tmpDir: string;

// ============================================================
// setup / teardown
// ============================================================
beforeEach(async () => {
  _clearKeyCacheForTests();
  // 测试默认走 Linux env fallback 路径（避开 macOS keychain 真调）
  _internals.platform = () => "linux";
  process.env.LASSO_COOKIE_PASSPHRASE = TEST_PASSPHRASE;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-cookie-test-"));
});

afterEach(async () => {
  _clearKeyCacheForTests();
  delete process.env.LASSO_COOKIE_PASSPHRASE;
  if (tmpDir) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================
// AES-256-GCM round-trip
// ============================================================
describe("CookieStore — AES-256-GCM round-trip", () => {
  it("export → import 字段级一致（含 httpOnly / secure / session 等所有字段）", async () => {
    const store = new CookieStore(tmpDir, "work");
    const cookies = [
      makeCookie("session"),
      makeCookie("csrf"),
      {
        name: "tracking",
        value: "v",
        domain: "sub.example.com",
        path: "/deep",
        expires: 1893456000,
        size: 1,
        httpOnly: false,
        secure: false,
        session: true,
        sameSite: "Lax" as const,
        priority: "High" as const,
      },
    ];
    const { sha256, bytes } = await store.export(cookies);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bytes).toBeGreaterThan(100);
    const imported = await store.import();
    expect(imported).toEqual(cookies);
  });

  it("空 cookies 数组也能 round-trip", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([]);
    const imported = await store.import();
    expect(imported).toEqual([]);
  });

  it("多 profile 隔离：work / personal 加密包互不干扰", async () => {
    const work = new CookieStore(tmpDir, "work");
    const personal = new CookieStore(tmpDir, "personal");
    await work.export([makeCookie("work-session")]);
    await personal.export([makeCookie("personal-session")]);
    expect(await work.import()).toEqual([makeCookie("work-session")]);
    expect(await personal.import()).toEqual([makeCookie("personal-session")]);
  });
});

// ============================================================
// GCM auth tag 防篡改（INV-48 衍生）
// ============================================================
describe("CookieStore — GCM auth tag 防篡改", () => {
  it("密文被改 1 字节 → import 抛 cookie_auth_tag_failed", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("session")]);
    const filePath = store._filePathForTests();
    const buf = await fs.readFile(filePath);
    // 翻转密文区一字节（offset 32 = magic+salt+iv 之后）
    buf[40] = buf[40]! ^ 0xff;
    await fs.writeFile(filePath, buf);
    await expect(store.import()).rejects.toThrow(/cookie_auth_tag_failed/);
  });

  it("auth tag 被改 → import 抛 cookie_auth_tag_failed", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("session")]);
    const filePath = store._filePathForTests();
    const buf = await fs.readFile(filePath);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    await fs.writeFile(filePath, buf);
    await expect(store.import()).rejects.toThrow(/cookie_auth_tag_failed/);
  });

  it("错误 master key → import 抛 cookie_auth_tag_failed（不静默返垃圾）", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("session")]);
    // 切 master key（清 cache + 改 env）
    _clearKeyCacheForTests();
    process.env.LASSO_COOKIE_PASSPHRASE = "another-also-very-long-passphrase-X";
    await expect(store.import()).rejects.toThrow(/cookie_auth_tag_failed/);
  });
});

// ============================================================
// IV 唯一性（INV-53）
// ============================================================
describe("CookieStore — IV 唯一性", () => {
  it("两次 export 同明文 → 密文 buffer 不同（IV 每次唯一）", async () => {
    const store = new CookieStore(tmpDir, "work");
    const cookies = [makeCookie("session")];
    await store.export(cookies);
    const buf1 = await fs.readFile(store._filePathForTests());
    await store.export(cookies);
    const buf2 = await fs.readFile(store._filePathForTests());
    expect(buf1.equals(buf2)).toBe(false);
    // 仍能正确解密
    expect(await store.import()).toEqual(cookies);
  });

  it("两次 export 同明文 → 文件 sha256 不同", async () => {
    const store = new CookieStore(tmpDir, "work");
    const cookies = [makeCookie("session")];
    const r1 = await store.export(cookies);
    const r2 = await store.export(cookies);
    expect(r1.sha256).not.toBe(r2.sha256);
  });
});

// ============================================================
// mode 0o600 / 0o700 实测（INV-49；task §11 要求非 mock 实落盘 stat）
// ============================================================
describe("CookieStore — mode 0o600 / 目录 0o700 实测（INV-49）", () => {
  it("加密包文件 mode === 0o600（实落盘 statSync）", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("session")]);
    const filePath = store._filePathForTests();
    const s = statSync(filePath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("cookies 目录 mode === 0o700（实落盘 statSync）", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("session")]);
    const dirPath = path.dirname(store._filePathForTests());
    const s = statSync(dirPath);
    expect(s.mode & 0o777).toBe(0o700);
  });

  it("覆盖写已存在文件后 mode 仍为 0o600", async () => {
    const store = new CookieStore(tmpDir, "work");
    await store.export([makeCookie("a")]);
    await store.export([makeCookie("b")]);
    const s = statSync(store._filePathForTests());
    expect(s.mode & 0o777).toBe(0o600);
  });
});

// ============================================================
// stat() 只读元数据（INV-51；doctor 不清读 cookie 内容）
// ============================================================
describe("CookieStore — stat() 只读元数据 + 密文 sha256（INV-51）", () => {
  it("stat 返 exists / bytes / mtimeMs / sha256；不返 cookie 字段", async () => {
    const store = new CookieStore(tmpDir, "work");
    const cookies = [makeCookie("session")];
    const { sha256 } = await store.export(cookies);
    const s = await store.stat();
    expect(s.exists).toBe(true);
    expect(typeof s.bytes).toBe("number");
    expect(s.bytes!).toBeGreaterThan(50);
    expect(typeof s.mtimeMs).toBe("number");
    expect(s.mtimeMs!).toBeGreaterThan(0);
    expect(s.sha256).toBe(sha256);
  });

  it("stat 不存在文件 → exists=false，无其他字段", async () => {
    const store = new CookieStore(tmpDir, "nope");
    const s = await store.stat();
    expect(s.exists).toBe(false);
    expect(s.bytes).toBeUndefined();
    expect(s.sha256).toBeUndefined();
  });

  it("stat 返的 sha256 与 export 返的 sha256 一致（密文哈希；非明文）", async () => {
    const store = new CookieStore(tmpDir, "work");
    const { sha256: exportSha } = await store.export([makeCookie("x")]);
    const s = await store.stat();
    expect(s.sha256).toBe(exportSha);
  });
});

// ============================================================
// 错误路径
// ============================================================
describe("CookieStore — 错误路径", () => {
  it("文件不存在 → cookie_store_not_found", async () => {
    const store = new CookieStore(tmpDir, "nope");
    await expect(store.import()).rejects.toThrow(/cookie_store_not_found/);
  });

  it("bad magic → cookie_bad_magic", async () => {
    const store = new CookieStore(tmpDir, "work");
    const filePath = store._filePathForTests();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // 写 4 字节错误 magic + 任意尾
    await fs.writeFile(filePath, Buffer.concat([Buffer.from("XXXX", "ascii"), Buffer.alloc(100)]));
    await expect(store.import()).rejects.toThrow(/cookie_bad_magic/);
  });

  it("文件过短（< magic+salt+iv+tag）→ cookie_bad_length", async () => {
    const store = new CookieStore(tmpDir, "work");
    const filePath = store._filePathForTests();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("LSCO-short", "ascii"));
    await expect(store.import()).rejects.toThrow(/cookie_bad_length/);
  });
});
