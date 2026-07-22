/**
 * keychain.ts（v0.8 parse9 §3.4）—— cookie 加密 master key 提供者
 *
 * 隐私铁律（parse9 §1.3 + INV-51 红线）：
 *  - master key 永不落盘 / 永不进 git / 永不被 doctor 打印
 *  - macOS Keychain 首选（security CLI 系统自带）；Linux/Win 走 env fallback（v1.0+ 接 libsecret）
 *  - 禁硬编码（INV-51 红线）：key 必从 OS keychain 或 LASSO_COOKIE_PASSPHRASE 取，禁字面量
 *
 * 加密强度（parse9 §3.4 决策表）：
 *  - OS keychain（macOS）：用户解锁才取；抗离机攻击
 *  - passphrase env：≥16 字符；用户负责强度
 *  - 首次 macOS 无 key → 自动生成 32B random → 写 keychain
 *
 * 性能（parse9 §7.1 R-v08-6）：scryptSync ~100ms/call → 60s in-memory cache
 *
 * 借鉴：parse9 §3.4 接口签名 + macOS `man security`（add/find-generic-password）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import * as os from "node:os";

const execFileP = promisify(execFile);

/** keychain service / account 标识（macOS Keychain Access 中可见）。 */
const SERVICE = "lasso-cookie";
const ACCOUNT = "master";

/** env passphrase 名（Linux/Win fallback）。 */
const ENV_PASSPHRASE = "LASSO_COOKIE_PASSPHRASE";

/** env passphrase 最短长度（强度下界）。 */
const MIN_PASSPHRASE_LEN = 16;

/** 模块级 cache TTL（parse9 §7.1 R-v08-6 缓解 scrypt 性能）。 */
const CACHE_TTL_MS = 60_000;

// ============================================================
// Test seam（EAM 模式）：测试覆写而不触 prod 路径
// ============================================================
/**
 * 内部 hook 点 —— 单测通过覆写 `platform` / `execFileP` 模拟 macOS keychain
 * 或 Linux env 分支，无需 vi.mock 整个 node:child_process。
 * 生产代码只读 `_internals.platform()` / `_internals.execFileP`。
 */
export const _internals = {
  execFileP,
  platform: (): NodeJS.Platform => os.platform(),
};

// ============================================================
// master key cache
// ============================================================
let cachedKey: string | null = null;
let cachedAt = 0;

/**
 * 取 master key（优先级：macOS Keychain > env LASSO_COOKIE_PASSPHRASE > 抛错）。
 *
 * INV-51 红线：master key 永不落盘 / 永不进 git / 永不被 doctor 打印。
 *
 * 首次 macOS 调用若无 key：自动生成 32B 随机 + 写 keychain（用户在 Keychain
 * Access 可见 `lasso-cookie` 条目）。
 *
 * 60s 内重复调用走 cache（parse9 §7.1 R-v08-6 scryptSync 性能缓解）。
 */
export async function getKeychainKey(): Promise<string> {
  if (cachedKey !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedKey;
  }
  const key = await fetchKey();
  cachedKey = key;
  cachedAt = Date.now();
  return key;
}

/** 实际取 key（无 cache）。 */
async function fetchKey(): Promise<string> {
  // 1. macOS keychain 分支
  if (_internals.platform() === "darwin") {
    return fetchFromDarwinKeychain();
  }
  // 2. env fallback（Linux/Win v0.8；v1.0+ 接 libsecret / credential-manager）
  return fetchFromEnv();
}

async function fetchFromDarwinKeychain(): Promise<string> {
  try {
    const { stdout } = await _internals.execFileP("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
    ]);
    const k = stdout.trim();
    if (!k) throw new Error("keychain_empty_value");
    return k;
  } catch {
    // 不存在 → 自动生成 + 写 keychain（首次自动配置）
    const newKey = randomBytes(32).toString("base64");
    await _internals.execFileP("security", [
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
      newKey,
      "-U",
    ]);
    return newKey;
  }
}

async function fetchFromEnv(): Promise<string> {
  const env = process.env[ENV_PASSPHRASE];
  if (!env || env.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `master_key_unavailable: configure macOS Keychain (auto) or set ${ENV_PASSPHRASE} (>=${MIN_PASSPHRASE_LEN} chars)`,
    );
  }
  return env;
}

// ============================================================
// 测试辅助（不入 dist 的 production 调用路径）
// ============================================================
/**
 * 清 master key cache（仅 vitest 单测调用；生产路径 60s TTL 自然过期）。
 */
export function _clearKeyCacheForTests(): void {
  cachedKey = null;
  cachedAt = 0;
}
