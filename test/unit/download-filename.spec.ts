/**
 * download-filename.spec.ts（doc/bugs/12 D12/H5——WT-core 落盘面守卫单测）
 *
 * 守护面：
 *  - resolveFilename：null/undefined 透传；`/`、`\`、`..` 段 → 抛
 *    filename_must_be_basename（Error.code 显式错误码）；`a..b` 合法放行
 *  - assertOutDirAllowed：白名单内 realpath 通过（返回规范化路径）；
 *    白名单外 / 目录不存在 → 抛 out_dir_not_allowed；
 *    path-boundary 语义（/allow 不得覆盖 /allowdev——前缀伪造负例）
 *  - loadDefaultOutDirAllowlist：~/Downloads 默认 + env 追加 + dropped 留痕
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, realpathSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveFilename,
  FilenameNotBasenameError,
  assertOutDirAllowed,
  loadDefaultOutDirAllowlist,
  DOWNLOAD_DIR_ALLOWLIST_ENV,
} from "../../src/download/filename.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-download-filename-"));
});

afterEach(async () => {
  delete process.env[DOWNLOAD_DIR_ALLOWLIST_ENV];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveFilename（D12/H5 basename 强制）", () => {
  it("null / undefined → null（引擎自命名档）", () => {
    expect(resolveFilename(null)).toBeNull();
    expect(resolveFilename(undefined)).toBeNull();
  });

  it("纯文件名透传", () => {
    expect(resolveFilename("corpus.tar")).toBe("corpus.tar");
    expect(resolveFilename("字幕.json3")).toBe("字幕.json3");
  });

  it("含 `/` → 抛 filename_must_be_basename（code 字段）", () => {
    for (const evil of ["../evil", "/etc/passwd", "a/b", "dir/"]) {
      expect(() => resolveFilename(evil)).toThrow(FilenameNotBasenameError);
      try {
        resolveFilename(evil);
      } catch (e) {
        expect((e as FilenameNotBasenameError).code).toBe("filename_must_be_basename");
      }
    }
  });

  it("含 `\\`（跨平台路径分隔防御）→ 抛", () => {
    expect(() => resolveFilename("..\\evil")).toThrow(FilenameNotBasenameError);
    expect(() => resolveFilename("a\\b")).toThrow(FilenameNotBasenameError);
  });

  it("`..` 段 → 抛；`a..b`（非段级 ..）合法放行", () => {
    expect(() => resolveFilename("..")).toThrow(FilenameNotBasenameError);
    expect(resolveFilename("a..b")).toBe("a..b");
    expect(resolveFilename("..hidden")).toBe("..hidden"); // 点前缀隐藏文件合法
  });
});

describe("assertOutDirAllowed（D12 白名单）", () => {
  it("白名单内 → 通过并返回 realpath 规范化路径", async () => {
    const allowed = path.join(tmpDir, "allow");
    const nested = path.join(allowed, "deep", "sub");
    await fs.mkdir(nested, { recursive: true });
    const real = realpathSync(nested);
    expect(assertOutDirAllowed(nested, [realpathSync(allowed)])).toBe(real);
    // 根本尊也通过
    expect(assertOutDirAllowed(allowed, [realpathSync(allowed)])).toBe(realpathSync(allowed));
  });

  it("白名单外 → 抛 out_dir_not_allowed（code 字段）", async () => {
    const allowed = path.join(tmpDir, "allow");
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    expect(() => assertOutDirAllowed(outside, [realpathSync(allowed)])).toThrow(
      /out_dir_not_allowed/,
    );
  });

  it("path-boundary 语义：/allow 不得覆盖 /allowdev（前缀伪造负例）", async () => {
    const allow = path.join(tmpDir, "allow");
    const allowdev = path.join(tmpDir, "allowdev"); // 朴素前缀匹配会误中
    await fs.mkdir(allow, { recursive: true });
    await fs.mkdir(allowdev, { recursive: true });
    expect(() => assertOutDirAllowed(allowdev, [realpathSync(allow)])).toThrow(
      /out_dir_not_allowed/,
    );
  });

  it("目录不存在 → 抛（fail-closed：不可规范化路径不进判定）", () => {
    expect(() =>
      assertOutDirAllowed(path.join(tmpDir, "no-such-dir"), [tmpDir]),
    ).toThrow(/out_dir_not_allowed/);
  });

  it("realpath 双侧：outDir 经符号链接进入白名单也通过（归一后匹配）", async () => {
    const real = path.join(tmpDir, "real-target");
    const link = path.join(tmpDir, "link-in"); // 符号链接路径
    await fs.mkdir(real, { recursive: true });
    symlinkSync(real, link);
    // 白名单收录 realpath 后的 real；经 link 访问的 outDir 也能命中（双侧归一）
    expect(assertOutDirAllowed(link, [realpathSync(real)])).toBe(realpathSync(real));
  });
});

describe("loadDefaultOutDirAllowlist（默认白名单装载）", () => {
  it("env 追加目录装载 + 不存在条目进 dropped（不静默含糊）", async () => {
    const extra = path.join(tmpDir, "extra-dl");
    await fs.mkdir(extra, { recursive: true });
    const nope = path.join(tmpDir, "no-such-dl");
    process.env[DOWNLOAD_DIR_ALLOWLIST_ENV] = `${extra}:${nope}`;
    const r = loadDefaultOutDirAllowlist();
    expect(r.dirs).toContain(realpathSync(extra));
    expect(r.dropped).toContain(nope); // ~/Downloads 缺席的机器上 dropped 还会多一条——不锁死
    // 装载结果直接可用于 assertOutDirAllowed
    expect(assertOutDirAllowed(extra, r.dirs)).toBe(realpathSync(extra));
  });

  it("无 env → 至少装载默认 ~/Downloads（存在时）或如实 dropped", () => {
    delete process.env[DOWNLOAD_DIR_ALLOWLIST_ENV];
    const r = loadDefaultOutDirAllowlist();
    const downloadsReal = (() => {
      try {
        return realpathSync(path.join(os.homedir(), "Downloads"));
      } catch {
        return null;
      }
    })();
    if (downloadsReal !== null) {
      expect(r.dirs).toContain(downloadsReal);
    } else {
      expect(r.dropped.length).toBeGreaterThanOrEqual(1);
    }
  });
});
