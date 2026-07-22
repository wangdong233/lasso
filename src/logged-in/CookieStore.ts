/**
 * CookieStore.ts（v0.8 parse9 §3.1 + §3.4）—— cookie AES-256-GCM 加密落盘
 *
 * 隐私铁律（parse9 §1.3 红线 + INV-48/49/51/52/53 衍生）：
 *  - 明文 cookie **永不出现在磁盘**。落盘前必 AES-256-GCM 加密（INV-48）。
 *  - 加密包文件 mode 0o600，目录 mode 0o700（复用 output-envelope.ts INV-15 范式 → INV-49）。
 *  - IV 每次加密唯一（crypto.randomBytes(12)）；解密必验 GCM auth tag（防篡改）（INV-53）。
 *  - master key 从 OS keychain / passphrase env 取；禁硬编码（INV-51）。
 *  - doctor 永不解密 / 永不读 cookie 字段（INV-51）；stat() 只返元数据 + sha256(ciphertext)。
 *  - export/import 必经 admin action opt-in；LoggedInChannel 自动路径不调（INV-52）。
 *
 * 加密格式（parse9 §3.1）：
 *   file := magic (4B "LSCO") || salt (16B) || iv (12B) || ciphertext || tag (16B)
 *   key  := scryptSync(masterKey, salt, 32, { N: 2^14, r: 8, p: 1 })
 *
 * 落盘位置：`<cacheDir>/cookies/<profileName>.cookies`
 *
 * 借鉴：parse9 §3.1 接口签名 + util/output-envelope.ts mode 0o600 + INV-15 范式
 *       + node:crypto built-in（scryptSync / createCipheriv aes-256-gcm）。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from "node:crypto";
import { promises as fs, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { getKeychainKey } from "./keychain.js";
import type { CdpCookie } from "./CdpClient.js";

// ============================================================
// 常量
// ============================================================
/** 文件 magic（Lasso Cookie）。 */
const MAGIC = "LSCO";
/** 加密包子目录名（cacheDir 下）。 */
const COOKIES_DIRNAME = "cookies";
/** scrypt N 参数（2^14，parse9 §3.1；~100ms/call）。 */
const SCRYPT_N = 16384;
/** scrypt r 参数。 */
const SCRYPT_R = 8;
/** scrypt p 参数。 */
const SCRYPT_P = 1;
/** IV 长度（GCM 标准 96-bit / 12 字节）。 */
const IV_LEN = 12;
/** salt 长度。 */
const SALT_LEN = 16;
/** GCM auth tag 长度（128-bit / 16 字节）。 */
const TAG_LEN = 16;

/**
 * CookieStore —— per-profile cookie 加密包管理器。
 *
 * 一个 CookieStore 实例对应一个 profile（profileName）；多 profile 场景
 * 每 profile 一个独立 CookieStore 实例（文件名按 profile 隔离）。
 */
export class CookieStore {
  constructor(
    private readonly cacheDir: string,
    private readonly profileName: string,
  ) {}

  /** 加密包落盘路径：`<cacheDir>/cookies/<profile>.cookies`。 */
  private get filePath(): string {
    return path.join(this.cacheDir, COOKIES_DIRNAME, `${this.profileName}.cookies`);
  }

  // ============================================================
  // export（admin opt-in 入口；parse9 §3.1）
  // ============================================================
  /**
   * 导出：cookies → AES-256-GCM 加密 → 落盘 mode 0o600。
   *
   * 返加密包 sha256（全 buffer 哈希，doctor 完整性校验用）+ 字节数。
   *
   * INV-48：必经 createCipheriv aes-256-gcm；明文 cookie 永不写盘。
   * INV-49：文件 mode 0o600 + 目录 mode 0o700。
   * INV-51：master key 从 keychain 取，禁硬编码。
   * INV-53：IV 每次唯一 randomBytes(12)。
   */
  async export(cookies: CdpCookie[]): Promise<{ sha256: string; bytes: number }> {
    const plaintext = JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      cookies,
    });
    const masterKey = await getKeychainKey(); // INV-51：master key 不硬编码
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN); // INV-53：每次唯一 IV
    const key = scryptSync(masterKey, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const buf = Buffer.concat([Buffer.from(MAGIC, "ascii"), salt, iv, ct, tag]);
    // 目录 mode 0o700 + 文件 mode 0o600（INV-49：复用 output-envelope INV-15 范式）
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, buf, { mode: 0o600 });
    return {
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
    };
  }

  // ============================================================
  // import（admin opt-in 入口；parse9 §3.1）
  // ============================================================
  /**
   * 导入：读加密包 → 解密（**验 GCM auth tag**）→ 返 cookie 数组。
   *
   * 不直接灌回 CDP；由 admin action `cookie_restore` 经 CdpClient.setCookie 灌回。
   *
   * INV-48：解密必经 createDecipheriv aes-256-gcm + setAuthTag（验签）。
   * auth tag 失败（被篡改 / key 错）→ 抛 `cookie_auth_tag_failed`，绝不静默返垃圾。
   */
  async import(): Promise<CdpCookie[]> {
    if (!existsSync(this.filePath)) throw new Error("cookie_store_not_found");
    const buf = await fs.readFile(this.filePath);
    if (buf.length < 4 + SALT_LEN + IV_LEN + TAG_LEN) {
      throw new Error("cookie_bad_length");
    }
    if (buf.subarray(0, 4).toString("ascii") !== MAGIC) {
      throw new Error("cookie_bad_magic");
    }
    const salt = buf.subarray(4, 4 + SALT_LEN);
    const iv = buf.subarray(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(4 + SALT_LEN + IV_LEN, buf.length - TAG_LEN);
    const masterKey = await getKeychainKey();
    const key = scryptSync(masterKey, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag); // 验 GCM auth tag（防篡改）
    let plain: string;
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      // auth tag 验证失败（key 错 / 密文被篡改 / IV 错）
      throw new Error("cookie_auth_tag_failed");
    }
    const parsed = JSON.parse(plain) as { cookies?: CdpCookie[] };
    if (!Array.isArray(parsed.cookies)) throw new Error("cookie_bad_format");
    return parsed.cookies;
  }

  // ============================================================
  // stat（doctor 探测用；parse9 §3.4；INV-51 红线）
  // ============================================================
  /**
   * 返加密包元数据（不解密 / 不读 cookie 字段；INV-51 红线）。
   *
   * 返 sha256 是**加密包 buffer 的哈希**（密文哈希），不是明文哈希；
   * doctor 用此检测加密包完整性（落盘后被改 / 跨重启一致）。
   *
   * doctor 路径永不接触 master key / 明文 cookie / CookieStore.import()。
   */
  async stat(): Promise<{
    exists: boolean;
    bytes?: number;
    mtimeMs?: number;
    sha256?: string;
  }> {
    if (!existsSync(this.filePath)) return { exists: false };
    const s = await fs.stat(this.filePath);
    // 读密文 buffer 算 sha256（不解密；密文哈希安全）
    const buf = await fs.readFile(this.filePath);
    return {
      exists: true,
      bytes: s.size,
      mtimeMs: s.mtimeMs,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }

  // ============================================================
  // 测试辅助（仅 vitest 单测调）
  // ============================================================
  /** 测试用：暴露 filePath 让单测 stat / chmod 验证。 */
  _filePathForTests(): string {
    return this.filePath;
  }
}
