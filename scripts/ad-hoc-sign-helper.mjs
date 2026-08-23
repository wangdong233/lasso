#!/usr/bin/env node
/**
 * ad-hoc-sign-helper.mjs（BUG-rust-helper-relative-path §4.4）
 *
 * build 链的 ad-hoc 兜底签名步骤（package.json "build" 末段调用）：
 *  - 无 Apple Developer 账号（$99/年）时，至少 `codesign --force --sign -` ad-hoc 签名——
 *    无签名 binary 在 macOS 上无稳定 code identity，TCC 归因更脆；
 *    长期方案（Developer ID + notarization）见 rust-helper/build/sign.sh 既有说明。
 *  - 幂等安全：
 *      · binary 不存在（未 cargo build）→ 静默跳过（exit 0，不炸构建）
 *      · 环境无 codesign（Linux/CI/无 CLT）→ 静默跳过（exit 0，不炸构建）
 *      · 已签 Developer ID → 跳过（绝不降级覆盖）
 *      · 其余（未签 / linker-signed / 旧 ad-hoc）→ ad-hoc 重签
 *  - 纯 node:* 内置（与 launcher/*.ts 同约束）；无输出成功、单行说明性输出。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// scripts/ad-hoc-sign-helper.mjs → ../rust-helper/target/release/lasso-rust-helper
// （scripts/ 在仓库根下**一层**；src|dist/subprocess/ 是两层——深度不同别混用）
const HELPER = fileURLToPath(
  new URL("../rust-helper/target/release/lasso-rust-helper", import.meta.url),
);

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
}

if (!existsSync(HELPER)) {
  process.exit(0); // 未构建：留给 cargo build + sign.sh
}

const probe = run("codesign", ["-dvvv", HELPER]);
if (probe.error) {
  // codesign 命令不存在（非 macOS / 无 Command Line Tools）→ 降级跳过
  process.exit(0);
}
const probeOut = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
if (/Authority=Developer ID Application:/i.test(probeOut)) {
  process.exit(0); // 已有正式签名：绝不降级
}

const r = run("codesign", ["--force", "--sign", "-", HELPER]);
if (r.status !== 0) {
  // 签名失败不炸构建（build 主链是 TS 编译；签名是 best-effort 兜底）
  console.error(
    `[ad-hoc-sign] codesign 失败（忽略，不阻断构建）：${r.stderr ?? r.error ?? ""}`.trim(),
  );
  process.exit(0);
}
console.log(
  `[ad-hoc-sign] lasso-rust-helper ad-hoc 已签：${HELPER}（Developer ID 长期方案见 rust-helper/build/sign.sh）`,
);
