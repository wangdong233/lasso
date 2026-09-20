/**
 * download-staging.spec.ts（doc/bugs/12 D7 归属标记 + staging 生命周期）
 *
 * mkdtemp 隔离（LASSO_DOWNLOADS_PATH 覆盖——绝不触碰真实 ~/.cache/lasso）。
 * 守护面：acquire/release rename 断言（单文件/BT 多文件嵌套/目标冲突后缀/
 * EXDEV 语义不可测则跳）/discard 幂等/taskId 路径穿越拒绝/cmdline 锚匹配。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStagingDir,
  releaseStaging,
  discardStaging,
  stagingDirForTask,
  stagingTaskMarker,
  engineCmdlineMatchesTask,
  stdioFileForTask,
  assertSafeTaskId,
  downloadsRootDir,
} from "../../src/download/engines/staging.js";

function tempEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "lasso-staging-"));
  return {
    env: { ...process.env, LASSO_DOWNLOADS_PATH: join(root, "downloads", "tasks") },
    root,
  };
}

describe("staging 目录布局", () => {
  it("LASSO_DOWNLOADS_PATH 指 tasks 根 → staging 同级（.../downloads/staging/<id>）", () => {
    const { env, root } = tempEnv();
    try {
      expect(downloadsRootDir(env)).toBe(join(root, "downloads"));
      expect(stagingDirForTask("abc", env)).toBe(
        join(root, "downloads", "staging", "abc"),
      );
      expect(stdioFileForTask("abc", env)).toBe(
        join(root, "downloads", "logs", "abc.log"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("taskId 路径穿越拒绝（../分隔符/超长）", () => {
    expect(() => assertSafeTaskId("../escape")).toThrow(/invalid_task_id/);
    expect(() => assertSafeTaskId("a/b")).toThrow(/invalid_task_id/);
    expect(() => assertSafeTaskId("")).toThrow(/invalid_task_id/);
    expect(() => assertSafeTaskId("ok-id_1")).not.toThrow();
  });
});

describe("acquire → release（rename 断言）", () => {
  it("单文件：staging 产物搬入最终目录+staging 清空", () => {
    const { env, root } = tempEnv();
    try {
      const staging = acquireStagingDir("t1", env);
      writeFileSync(join(staging, "a.bin"), "payload");
      const finalDir = join(root, "final");
      const moved = releaseStaging("t1", finalDir, env);
      expect(moved).toEqual([join(finalDir, "a.bin")]);
      expect(existsSync(join(finalDir, "a.bin"))).toBe(true);
      expect(existsSync(staging)).toBe(false); // staging 收尾删除
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("BT 多文件嵌套结构原样保留", () => {
    const { env, root } = tempEnv();
    try {
      const staging = acquireStagingDir("t2", env);
      mkdirSync(join(staging, "sub", "dir"), { recursive: true });
      writeFileSync(join(staging, "root.txt"), "r");
      writeFileSync(join(staging, "sub", "inner.bin"), "i");
      writeFileSync(join(staging, "sub", "dir", "deep.txt"), "d");
      const finalDir = join(root, "final");
      const moved = releaseStaging("t2", finalDir, env);
      expect(moved.sort()).toEqual(
        [
          join(finalDir, "root.txt"),
          join(finalDir, "sub", "inner.bin"),
          join(finalDir, "sub", "dir", "deep.txt"),
        ].sort(),
      );
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("目标已存在 → -1 后缀（绝不覆盖既有文件）", () => {
    const { env, root } = tempEnv();
    try {
      const staging = acquireStagingDir("t3", env);
      writeFileSync(join(staging, "a.txt"), "new");
      const finalDir = join(root, "final");
      mkdirSync(finalDir, { recursive: true });
      writeFileSync(join(finalDir, "a.txt"), "old");
      const moved = releaseStaging("t3", finalDir, env);
      expect(moved).toEqual([join(finalDir, "a-1.txt")]);
      expect(readdirSync(finalDir).sort()).toEqual(["a-1.txt", "a.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("空/不存在 staging → 空清单不炸", () => {
    const { env, root } = tempEnv();
    try {
      expect(releaseStaging("never-acquired", join(root, "final"), env)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discard 幂等", () => {
    const { env, root } = tempEnv();
    try {
      acquireStagingDir("t4", env);
      discardStaging("t4", env);
      discardStaging("t4", env); // 二次不炸
      expect(existsSync(stagingDirForTask("t4", env))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cmdline 归属锚（cancel 杀谓词第③④要素原语）", () => {
  it("argv 含 staging/<taskId> 子串 → 命中（--dir 与 -o 两种载体）", () => {
    const marker = stagingTaskMarker("task-xyz");
    expect(marker).toMatch(/staging/);
    expect(
      engineCmdlineMatchesTask(
        ["aria2c", "--dir", `/x/downloads/staging/task-xyz`, "https://a"],
        "task-xyz",
      ),
    ).toBe(true);
    expect(
      engineCmdlineMatchesTask(
        ["yt-dlp", "--paths", `/x/staging/task-xyz`, "-o", "%(title)s.%(ext)s"],
        "task-xyz",
      ),
    ).toBe(true);
  });

  it("不同 taskId 不命中（不可碰撞——UUID 路径子串）", () => {
    expect(
      engineCmdlineMatchesTask(
        ["aria2c", "--dir", `/x/downloads/staging/task-other`],
        "task-xyz",
      ),
    ).toBe(false);
    expect(engineCmdlineMatchesTask(["aria2c", "--dir", "/tmp"], "task-xyz")).toBe(false);
  });
});
