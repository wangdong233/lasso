/**
 * rust-helper-path.spec.ts（BUG-rust-helper-relative-path §4.1/§4.2/§4.3/§4.5 回归）
 *
 * 守护 2026-08-22 桌面通道全挂 BUG 的修复面：
 *  1. 默认路径 = import.meta.url 绝对解析（与宿主 cwd 解耦——根因 1 根治）
 *  2. env LASSO_RUST_HELPER_PATH 覆盖优先（既有契约：env > DEFAULT）
 *  3. spawn（index.ts）与 doctor（desktop-doctor-checks）共用同一 resolver
 *     （根因 2：诊断与故障源不再脱节）
 *  4. 确定性缺文件 fail fast：不进 5×backoff（~30s），错误附绝对路径 + env 覆盖提示
 *
 * 测试策略：DI 注入（env 形参 / 临时 chdir），CI 无 rust 环境可跑——
 * 不 spawn 真 helper，只断言路径解析与失败语义。
 */
import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_RUST_HELPER_PATH,
  LASSO_RUST_HELPER_ENV,
  hasRustHelperSource,
  resolveRustHelperPath,
  rustHelperMissingHint,
  rustHelperNotSpawnableHint,
  rustSpawnGate,
} from "../../src/subprocess/rust-helper-path.js";
import { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { RustBridge } from "../../src/subprocess/RustBridge.js";

describe("BUG §4.1 — 默认路径 import.meta.url 绝对解析（与 cwd 解耦）", () => {
  it("默认解析为绝对路径，恒指仓库内 helper", () => {
    const r = resolveRustHelperPath({});
    expect(r.source).toBe("default");
    expect(path.isAbsolute(r.path)).toBe(true);
    expect(r.path.endsWith("rust-helper/target/release/lasso-rust-helper")).toBe(
      true,
    );
    // 独立复算：本 spec 在 test/unit/（仓库根下两层），与 src|dist/subprocess/ 同深度
    const expected = fileURLToPath(
      new URL("../../rust-helper/target/release/lasso-rust-helper", import.meta.url),
    );
    expect(r.path).toBe(expected);
    expect(DEFAULT_RUST_HELPER_PATH).toBe(expected);
  });

  it("从非仓库 cwd（os.tmpdir）解析 → 路径不变（cwd 解耦，BUG 根因 1）", () => {
    const before = resolveRustHelperPath({}).path;
    const origCwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const after = resolveRustHelperPath({}).path;
      expect(after).toBe(before);
      expect(path.isAbsolute(after)).toBe(true);
    } finally {
      process.chdir(origCwd); // 恢复，不污染同 worker 内其他 spec
    }
  });
});

describe("BUG §4.1 — env 覆盖契约（env > DEFAULT，既有缓解路径不回归）", () => {
  it("LASSO_RUST_HELPER_PATH 绝对路径覆盖 → source=env", () => {
    const custom = "/opt/custom/lasso-rust-helper";
    const r = resolveRustHelperPath({ [LASSO_RUST_HELPER_ENV]: custom });
    expect(r).toEqual({ path: custom, source: "env" });
  });

  it("相对覆盖 → path.resolve 锚定 process.cwd() 成绝对", () => {
    const r = resolveRustHelperPath({ [LASSO_RUST_HELPER_ENV]: "rel/helper" });
    expect(r.source).toBe("env");
    expect(r.path).toBe(path.resolve("rel/helper"));
  });

  it("空串/空白串 env 视为未设置 → 回落默认", () => {
    expect(resolveRustHelperPath({ [LASSO_RUST_HELPER_ENV]: "" }).source).toBe(
      "default",
    );
    expect(
      resolveRustHelperPath({ [LASSO_RUST_HELPER_ENV]: "   " }).source,
    ).toBe("default");
  });
});

describe("BUG §4.2 — spawn 与 doctor 路径单一真源（源码级断言）", () => {
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    "utf8",
  );
  const doctorSrc = readFileSync(
    fileURLToPath(
      new URL("../../src/desktop/desktop-doctor-checks.ts", import.meta.url),
    ),
    "utf8",
  );

  it("index.ts spawn 规格经 resolveRustHelperPath()（不再自带相对路径常量）", () => {
    expect(indexSrc).toMatch(/resolveRustHelperPath\(\)\.path/);
    expect(indexSrc).toMatch(
      /registerRustSpec\("rust-helper",\s*\{\s*command: rustHelperPath/,
    );
    // 相对路径字面量（BUG 根因）不得回归
    expect(indexSrc).not.toMatch(/["']\.{1,2}\/rust-helper\/target\//);
  });

  it("doctor 探测与 spawn 同源（resolver 默认；双相对路径列表不得回归）", () => {
    expect(doctorSrc).toMatch(/resolveRustHelperPath\(\)\.path/);
    expect(doctorSrc).not.toMatch(/["']\.{1,2}\/rust-helper\/target\//);
  });

  it("doctor 误导性「可能未构建」文案已移除（改为存在性二分 + 绝对路径）", () => {
    expect(doctorSrc).not.toContain("binary 可能未构建");
    expect(doctorSrc).toContain("binary 不存在");
    expect(doctorSrc).toContain("binary 存在但无签名输出");
  });
});

describe("BUG §4.3 — 确定性缺文件 fail fast（不吃 5×backoff）", () => {
  it("ensureRustRunning：binary 不存在 → 快速抛错，附绝对路径 + env 覆盖提示", async () => {
    const mgr = new SubprocessManager();
    const missing = path.join(os.tmpdir(), "nonexistent-lasso-helper", "x");
    mgr.registerRustSpec("missing-helper", { command: missing });

    const started = Date.now();
    await expect(mgr.ensureRustRunning("missing-helper")).rejects.toThrow(
      /rust_helper_crashed:subproc_spawn_failed/,
    );
    // fail fast：远小于 5×backoff 的首拍 2s（无重试睡眠）
    expect(Date.now() - started).toBeLessThan(1_000);
    // 自诊断：绝对路径 + env 覆盖提示 + cwd
    let err: unknown;
    try {
      await mgr.ensureRustRunning("missing-helper");
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain(missing);
    expect(msg).toContain(LASSO_RUST_HELPER_ENV);
    expect(msg).toContain(process.cwd());
    await mgr.shutdown();
  }, 10_000);

  it("RustBridge.call：缺 binary → reject 语义保持（W1-DEF-9 契约 + 自诊断增强）", async () => {
    const mgr = new SubprocessManager();
    const missing = path.join(os.tmpdir(), "nonexistent-lasso-helper-2", "x");
    mgr.registerRustSpec("missing-helper-2", { command: missing });
    const bridge = new RustBridge(mgr, "missing-helper-2");

    await expect(bridge.call("ping", {}, 3_000)).rejects.toThrow(
      /rust_helper_crashed:subproc_spawn_failed/,
    );
    expect(bridge.pendingCount()).toBe(0);
    await mgr.shutdown();
  }, 10_000);
});

// ============================================================
// A1（对抗复审轮 1）——仲裁确证缺陷回归：existsSync 门只判存在不判可
// spawn → 目录 / 丢 exec 位的文件漏过门，spawn EACCES 打到 onError
// 兜底分支，归因裸 `rust_helper_crashed:EACCES`（无路径/无修法）。
// ============================================================
describe("A1 — rustSpawnGate：存在 ≠ 可 spawn（三态判齐）", () => {
  it("目录 → not_file（纯存在性门漏过的态）", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "lasso-gate-dir-"));
    try {
      // 先自证目录确实存在，再断言门判 not_file（防断言建立在路径缺失上——
      // A1 首次复现时 mkdtempSync 追加随机后缀导致误测 nonexistent 的教训）
      expect(existsSync(d)).toBe(true);
      expect(rustSpawnGate(d)).toBe("not_file");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("chmod 644 普通文件 → no_exec；chmod 755 → ok", () => {
    const f = path.join(os.tmpdir(), `lasso-gate-f-${process.pid}`);
    writeFileSync(f, "#!/bin/sh\n");
    try {
      chmodSync(f, 0o644);
      expect(rustSpawnGate(f)).toBe("no_exec");
      chmodSync(f, 0o755);
      expect(rustSpawnGate(f)).toBe("ok");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("不存在 → missing", () => {
    expect(
      rustSpawnGate(path.join(os.tmpdir(), "lasso-gate-missing-nope")),
    ).toBe("missing");
  });
});

describe("A1 — ensureRustRunning：不可 spawn 态 fail fast + 自诊断（不再裸 EACCES）", () => {
  it("command 是目录 → 快速抛错，附路径 + 修法 + env 覆盖提示（仲裁复现态 1）", async () => {
    const mgr = new SubprocessManager();
    const dir = mkdtempSync(path.join(os.tmpdir(), "lasso-a1-dir-"));
    mgr.registerRustSpec("dir-helper", { command: dir });

    const started = Date.now();
    let err: unknown;
    try {
      await mgr.ensureRustRunning("dir-helper");
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toMatch(/rust_helper_crashed:subproc_spawn_failed/);
    expect(msg).toContain("不可 spawn");
    expect(msg).toContain("路径是目录");
    expect(msg).toContain(dir);
    expect(msg).toContain(LASSO_RUST_HELPER_ENV);
    expect(msg).toContain(process.cwd());
    // fail fast：远小于 5×backoff 首拍 2s（无重试睡眠）
    expect(Date.now() - started).toBeLessThan(1_000);
    await mgr.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("command 是无执行位文件 → 同样 fail fast 自诊断（仲裁复现态 2）", async () => {
    const mgr = new SubprocessManager();
    const f = path.join(os.tmpdir(), `lasso-a1-noexec-${process.pid}`);
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o644);
    mgr.registerRustSpec("noexec-helper", { command: f });

    const started = Date.now();
    let err: unknown;
    try {
      await mgr.ensureRustRunning("noexec-helper");
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toMatch(/rust_helper_crashed:subproc_spawn_failed/);
    expect(msg).toContain("不可 spawn");
    expect(msg).toContain("缺执行权限");
    expect(msg).toContain("chmod +x");
    expect(msg).toContain(f);
    expect(Date.now() - started).toBeLessThan(1_000);
    await mgr.shutdown();
    rmSync(f, { force: true });
  }, 10_000);

  it("RustBridge.call：dir command → reject 附自诊断（不再裸 rust_helper_crashed:EACCES）", async () => {
    const mgr = new SubprocessManager();
    const dir = mkdtempSync(path.join(os.tmpdir(), "lasso-a1-dir2-"));
    mgr.registerRustSpec("dir-helper-2", { command: dir });
    const bridge = new RustBridge(mgr, "dir-helper-2");

    await expect(bridge.call("ping", {}, 3_000)).rejects.toThrow(
      /rust_helper_crashed:subproc_spawn_failed — helper binary 不可 spawn/,
    );
    expect(bridge.pendingCount()).toBe(0);
    await mgr.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("RustBridge onError spawn 码兜底：门后竞态漏网的 EACCES 也附路径（A1 纵深）", async () => {
    const mgr = new SubprocessManager();
    // /bin/sleep 过 spawn 门（存在+文件+可执行）但不响应 stdin → pending 挂起，
    // 手工 emit EACCES 模拟「exec 位在门与 spawn 之间被夺走」的门后竞态。
    mgr.registerRustSpec("sleep-helper", {
      command: "/bin/sleep",
      args: ["30"],
    });
    const bridge = new RustBridge(mgr, "sleep-helper");
    const pending = bridge.call("ping", {}, 3_000);
    await new Promise((r) => setTimeout(r, 300)); // 等 ensureStarted 完成接线
    const proc = await mgr.ensureRustRunning("sleep-helper");
    proc.emit(
      "error",
      Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    );
    await expect(pending).rejects.toThrow(
      /rust_helper_crashed:EACCES — .*\/bin\/sleep/,
    );
    expect(bridge.pendingCount()).toBe(0);
    await mgr.shutdown();
  }, 10_000);
});

describe("A1 — npm 布局适配（cargo build 修法条件化，不再给不可执行的修法）", () => {
  it("hasRustHelperSource：仓库 checkout 默认 true；DI false → npm 分支", () => {
    expect(hasRustHelperSource()).toBe(true); // 本 spec 在仓库内跑
    expect(hasRustHelperSource({ hasSource: false })).toBe(false);
  });

  it("rustHelperMissingHint：源码在包内 → cargo build + env 双修法（原契约不回归）", () => {
    const msg = rustHelperMissingHint("/x/lasso-rust-helper", {
      hasSource: true,
    });
    expect(msg).toContain("/x/lasso-rust-helper");
    expect(msg).toContain("cd rust-helper && cargo build --release");
    expect(msg).toContain(LASSO_RUST_HELPER_ENV);
    expect(msg).toContain(process.cwd());
  });

  it("rustHelperMissingHint：npm 布局（无源码）→ 仅 env 覆盖，不误导 cargo build", () => {
    const msg = rustHelperMissingHint("/x/lasso-rust-helper", {
      hasSource: false,
    });
    expect(msg).toContain("npm 包不含 rust-helper 源码");
    expect(msg).toContain(LASSO_RUST_HELPER_ENV);
    expect(msg).not.toContain("cd rust-helper && cargo build");
  });

  it("rustHelperNotSpawnableHint：附路径 + chmod/改指/env 修法", () => {
    const msg = rustHelperNotSpawnableHint("/x/h", "存在但缺执行权限");
    expect(msg).toContain("/x/h");
    expect(msg).toContain("chmod +x /x/h");
    expect(msg).toContain(LASSO_RUST_HELPER_ENV);
    expect(msg).toContain(process.cwd());
  });

  it("doctor cargo build 修法经 hasRustHelperSource 条件化（源码级断言，单一真源纪律）", () => {
    const doctorSrc = readFileSync(
      fileURLToPath(
        new URL("../../src/desktop/desktop-doctor-checks.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(doctorSrc).toMatch(/hasRustHelperSource\(\)/);
    expect(doctorSrc).toContain("npm 包不含 rust-helper 源码");
    // 相对路径字面量（BUG 根因）不得回归
    expect(doctorSrc).not.toMatch(/["']\.{1,2}\/rust-helper\/target\//);
  });
});
