/**
 * rust-helper-path（BUG-rust-helper-relative-path §4.1 + §4.2 单一真源）
 *
 * 历史 BUG：DEFAULT 曾是 cwd 相对路径 `./rust-helper/target/release/lasso-rust-helper`，
 * 宿主（CC / 任意 MCP client）以 `node /abs/dist/index.js` 启动时 cwd = 宿主工作目录
 * ≠ lasso 仓库根 → spawn ENOENT → desktop 通道全挂（subproc_spawn_failed）。
 *
 * 修复铁律（本模块是 helper 路径的**唯一**真源，三处消费共用）：
 *  1. spawn 规格：index.ts 装配段 registerRustSpec("rust-helper", { command: ... })
 *  2. doctor 探测：desktop-doctor-checks.ts checkRustHelperSigned 默认路径
 *  3. 错误自诊断：SubprocessManager fail-fast / RustBridge onError 的提示文案
 *
 * 解析优先级（env 覆盖 > 绝对默认）：
 *  - env LASSO_RUST_HELPER_PATH（非空）→ path.resolve 成绝对路径（相对值锚定 process.cwd()）
 *  - 默认 → import.meta.url 相对解析（本文件在 src(subprocess|dist/subprocess)/ 下，
 *    `../../rust-helper/...` 恒指向仓库内 helper，**与宿主 cwd 完全解耦**）
 *
 * A1（对抗复审轮 1）补面：spawn 可行性门（rustSpawnGate）——existsSync 只判存在
 * 不判可 spawn，目录 / 丢 exec 位的文件漏过纯存在性门，到 spawn 阶段才 EACCES
 * 打到 RustBridge.onError 兜底分支，归因裸 `rust_helper_crashed:EACCES`（无路径/
 * 无修法），「一眼自诊断」对此态不成立。本模块同时供给 npm 布局适配（源码不在
 * 包内时 cargo build 修法不可行，仅 env 覆盖一条路）。
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessSync,
  constants,
  existsSync,
  statSync,
  type Stats,
} from "node:fs";

/** helper 路径覆盖 env 名（与 ~/.claude.json 临时缓解、README 一致）。 */
export const LASSO_RUST_HELPER_ENV = "LASSO_RUST_HELPER_PATH";

/**
 * 默认 helper 路径（绝对）。
 *
 * 本文件编译后位于 `<repo>/dist/subprocess/rust-helper-path.js`（测试态是
 * `<repo>/src/subprocess/rust-helper-path.ts`），`../../` 恒落 `<repo>/`，
 * 因此默认值与 server 进程 cwd 无关（BUG 根因 1 的根治点）。
 */
export const DEFAULT_RUST_HELPER_PATH = fileURLToPath(
  new URL("../../rust-helper/target/release/lasso-rust-helper", import.meta.url),
);

/** 路径来源（doctor detail / 日志归因用）。 */
export type RustHelperPathSource = "env" | "default";

export interface RustHelperPathResolution {
  /** 绝对路径（spawn / codesign 探测共用）。 */
  path: string;
  /** "env" = LASSO_RUST_HELPER_PATH 覆盖；"default" = 仓库内默认。 */
  source: RustHelperPathSource;
}

/**
 * 解析 rust helper binary 路径（env 覆盖 > 绝对默认；见模块头）。
 *
 * env 为空白串视为未设置（防御 host 侧注入空值的配置错误）。
 * DI：env 形参可注入（回归测试从非仓库 cwd 断言解析结果，CI 无 rust 环境可跑）。
 */
export function resolveRustHelperPath(
  env: Record<string, string | undefined> = process.env,
): RustHelperPathResolution {
  const override = env[LASSO_RUST_HELPER_ENV];
  if (override !== undefined && override.trim() !== "") {
    return { path: path.resolve(override), source: "env" };
  }
  return { path: DEFAULT_RUST_HELPER_PATH, source: "default" };
}

// ============================================================
// A1（对抗复审轮 1）：spawn 可行性门 + 不可 spawn 自诊断
// ============================================================
/**
 * spawn 前可行性门结果。
 *  - "ok"       可 spawn（存在 + 普通文件 + 有执行位）
 *  - "missing"  路径不存在（含 existsSync 后消失的竞态）
 *  - "not_file" 存在但不是普通文件（目录 / FIFO / socket——spawn 必败）
 *  - "no_exec"  普通文件但缺执行位（env 配错 / exec 位丢失——spawn EACCES）
 */
export type RustSpawnGateResult = "ok" | "missing" | "not_file" | "no_exec";

/**
 * spawn 前可行性门（A1 单一真源）。
 *
 * 判齐三态：存在 → statSync().isFile() → accessSync(X_OK)。
 * 注意顺序不可换：目录在 POSIX 上 access(X_OK) 语义是「可穿越」通常为真，
 * 必须先 isFile() 再查执行位，否则目录会被误判 "ok"。
 */
export function rustSpawnGate(command: string): RustSpawnGateResult {
  if (!existsSync(command)) return "missing";
  let st: Stats;
  try {
    st = statSync(command);
  } catch {
    return "missing"; // 竞态：存在性探测后路径消失 / 不可 stat
  }
  if (!st.isFile()) return "not_file";
  try {
    accessSync(command, constants.X_OK);
  } catch {
    return "no_exec";
  }
  return "ok";
}

/**
 * 包根（本文件在 src|dist 的 subprocess/ 下，`../../` 恒落包根）。
 * 用于判断 rust-helper 源码是否随包分发（npm tgz 布局适配）。
 */
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 包内是否含 rust-helper 源码。
 * 发行 tgz 经 .npmignore 排除 rust-helper/ → false：`cd rust-helper && cargo
 * build` 修法不可行，只剩 env 覆盖一条路（A1 顺带修法：hint/doctor 的 cargo
 * 建议按此条件化，npm 安装布局下不再给不可执行的修法）。
 * DI：opts.hasSource 供回归测试注入 npm 布局分支（真布局恒走 existsSync）。
 */
export function hasRustHelperSource(
  opts: { hasSource?: boolean } = {},
): boolean {
  if (opts.hasSource !== undefined) return opts.hasSource;
  return existsSync(path.join(PKG_ROOT, "rust-helper", "Cargo.toml"));
}

/**
 * 缺 binary 时的自诊断提示（SubprocessManager fail-fast 与 RustBridge onError
 * 共用同一文案——错误里说清楚「解析到了哪 / 怎么修」，把环境问题从 30s 重试
 * 变成一眼自修）。
 *
 * A1：修法按布局条件化——源码在包内（仓库 checkout）给 cargo build + env 双
 * 修法；npm 安装布局（源码被 .npmignore 排除）仅 env 覆盖可行，不再误导。
 */
export function rustHelperMissingHint(
  resolvedPath: string,
  opts: { hasSource?: boolean } = {},
): string {
  const fix = hasRustHelperSource(opts)
    ? `修复: cd rust-helper && cargo build --release，` +
      `或用 env ${LASSO_RUST_HELPER_ENV}=<绝对路径> 覆盖`
    : `修复: npm 包不含 rust-helper 源码（无法 cargo build），` +
      `仅可用 env ${LASSO_RUST_HELPER_ENV}=<已构建 helper 的绝对路径> 覆盖`;
  return `helper binary 不存在: ${resolvedPath}（cwd=${process.cwd()}）；${fix}`;
}

/**
 * 「存在但不可 spawn」自诊断（A1）：目录 / 丢 exec 位的文件——纯存在性门
 * 拦不住的态。错误附路径 + 修法，不裸归因。
 *
 * @param why 人类可读原因（"路径是目录" / "存在但缺执行权限" / spawn errno 等）
 */
export function rustHelperNotSpawnableHint(
  resolvedPath: string,
  why: string,
): string {
  return (
    `helper binary 不可 spawn（${why}）: ${resolvedPath}（cwd=${process.cwd()}）；` +
    `修复: chmod +x ${resolvedPath}（缺执行位时）/ 改指 binary 文件（误指目录时），` +
    `或用 env ${LASSO_RUST_HELPER_ENV}=<绝对路径> 覆盖`
  );
}
