/**
 * npm-tarball-package-form.spec.ts（v1.33.1，2026-10-28 白盒根因修复批）
 *
 * 守护点（两个独立缺陷，同一批修复）：
 *
 * A. **包形态 invariants 假阳性**（check-invariants.mjs 三态补全）：
 *    4 项 INV（76/77/101/103）的证据文件在 rust-helper/ 与 test/ 下，npm
 *    tarball 刻意不含两者（v1.31.1 设计）→ 包形态下 readFileSync 必抛 →
 *    旧代码 catch { return false } 把「证据文件缺席」误当「断言被证伪」→
 *    每个 npx 用户的 `lasso-mcp doctor` 恒报 ready:false + blockers:
 *    ['invariants']（假阳性）。修复 = SKIP 第三态：PKG_FORM 检测（rust-helper/
 *    src 与 test/helpers **两者同时缺席**，锚 checker 文件自身位置而非
 *    SRC_ROOT——inv-selftest 的 LASSO_INV_SRC_ROOT 临时副本免疫）。
 *
 * B. **工作区游离文件扫入 tarball**（.npmignore 白名单惯用法）：
 *    黑名单语义下根级新文件不命中任何忽略规则默认入包——dedao blob
 *    （git 历史）、1.18.4 tarball、1.33.0 tarball（用户私有事故记录
 *    `2026-10-28-*.md` 实发到 registry）三次复发的同一类根因。修复 =
 *    .npmignore 头部 `/*` 全忽略 + `!` 精确重入（gitignore 语义；重入
 *    目录仍受既有子树剪枝规则约束——得 到课程全量抓取/history/archive/
 *    verify-data 继续排除）。
 *
 * 测试策略（全部真 npm pack + 真 checker 运行——实证语义，不 mock）：
 *  1. tarball 根级条目 ⊆ 白名单（LICENSE/package.json/README.md/
 *     README.en.md/ARCHITECTURE.md + 四目录 src/dist/doc/fixtures）；
 *     无根级游离文件；得 到/history/archive/verify-data 零命中
 *  2. tarball 解包后跑 checker：exit 0 + 恰好 4 SKIP（76/77/101/103）
 *     + 0 FAIL + 汇总行 "All 106 invariants passed, 4 skipped"
 *  3. 防线削弱负测：解包目录补一个**空** rust-helper/src（只缺其一 =
 *     仓库损坏形态）→ PKG_FORM=false → 同 4 项必须 FAIL 而非 SKIP
 *     （防止 SKIP 静默吞掉仓库形态的回归红线）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_FORM_SKIP_IDS = [
  "INV-76-wave1-upstream-contract-and-wiring-regression-guard",
  "INV-77-browser-lifecycle-ownership-and-restore-safety",
  "INV-101-cgevent-landing-receipt",
  "INV-103-tcc-gate-version-honesty",
];
/** 白名单五文件 + 四目录（.npmignore `/*`+`!` 惯用法的镜像——两处须同步改） */
const ROOT_ALLOWED = new Set([
  "LICENSE",
  "package.json",
  "README.md",
  "README.en.md",
  "ARCHITECTURE.md",
  "src",
  "dist",
  "doc",
  "fixtures",
]);

let packDir: string;
let extractDir: string;
let tarEntries: string[];

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * tar 条目名八进制转义解码（GNU tar 对非 ASCII 文件名输出 `\NNN` 字节转义）。
 * 不解码则中文路径断言永久失明——「得到课程全量抓取」封禁检查曾全程假绿
 * （2026-10-28 实锤：octal 形态下 grep 中文零命中，python tarfile 复检才现形）。
 */
function decodeTarName(s: string): string {
  if (!s.includes("\\")) return s;
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    const m = /^\\([0-7]{3})/.exec(s.slice(i));
    if (m) {
      bytes.push(parseInt(m[1], 8));
      i += 4;
    } else {
      bytes.push(...Buffer.from(s[i], "utf8"));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

beforeAll(() => {
  packDir = mkdtempSync(join(tmpdir(), "lasso-pkg-gate-"));
  extractDir = mkdtempSync(join(tmpdir(), "lasso-pkg-extract-"));
  // npm pack 不跑 build（无 prepack）——秒级；产物名取 version 字段
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const pack = run("npm", ["pack", "--pack-destination", packDir], REPO_ROOT);
  if (pack.code !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const tarball = join(packDir, `lasso-mcp-${pkg.version}.tgz`);
  const tar = run("tar", ["-xzf", tarball, "-C", extractDir]);
  if (tar.code !== 0) throw new Error(`tar extract failed: ${tar.stderr}`);
  const list = run("tar", ["-tzf", tarball]);
  if (list.code !== 0) throw new Error(`tar list failed: ${list.stderr}`);
  tarEntries = list.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("package/"))
    .map((l) => decodeTarName(l).replace(/^package\//, ""))
    .filter((l) => l.length > 0);
}, 180_000);

afterAll(() => {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
});

describe("npm tarball 白名单门（防游离文件第三次复发）", () => {
  it("根级条目 ⊆ 白名单（五文件 + 四目录）——根级游离文件零容忍", () => {
    const rootEntries = new Set(tarEntries.map((e) => e.split("/")[0]));
    const strays = [...rootEntries].filter((e) => !ROOT_ALLOWED.has(e));
    expect(strays).toEqual([]);
    // 白名单成员必须真实在包（防白名单条目写错悄悄空转）
    for (const e of ROOT_ALLOWED) expect(rootEntries.has(e)).toBe(true);
  });

  it("私有资产子树零命中（得 到课程全量抓取 / history / archive / verify-data）", () => {
    const banned =
      tarEntries.filter((e) =>
        /得到课程全量抓取|doc\/history\/|doc\/archive\/|verify-data/.test(e),
      );
    expect(banned).toEqual([]);
  });

  it("src 与 dist 均在包（check-invariants 证据面 + bin 运行面不缺）", () => {
    expect(tarEntries.some((e) => e.startsWith("src/invariants/check-invariants.mjs"))).toBe(true);
    expect(tarEntries.some((e) => e.startsWith("dist/index.js"))).toBe(true);
    expect(tarEntries.some((e) => e.startsWith("fixtures/serp-baseline/"))).toBe(true);
  });
});

describe("包形态 invariants 三态（SKIP 非假阳性 FAIL）", () => {
  it("tarball 内跑 checker：exit 0 + 恰好 4 SKIP + 0 FAIL + 诚实汇总行", () => {
    const r = run("node", [
      join(extractDir, "package", "src", "invariants", "check-invariants.mjs"),
    ]);
    expect(r.code).toBe(0);
    const skipIds = [...r.stdout.matchAll(/^SKIP\s+(\S+)/gm)].map((m) => m[1]);
    expect(skipIds.sort()).toEqual([...PKG_FORM_SKIP_IDS].sort());
    expect(r.stdout.match(/^FAIL\s+/gm) ?? []).toEqual([]);
    expect(r.stdout.trim().split("\n").slice(-1)[0]).toMatch(
      /All \d+ invariants passed, 4 skipped \(package form\)\./,
    );
  });

  it("防线削弱负测：只缺其一（补空 rust-helper/src）→ 同 4 项 FAIL 而非 SKIP", () => {
    // 仓库损坏形态模拟：rust-helper/src 存在（空）+ test/helpers 仍缺 →
    // PKG_FORM=false（两者同时缺席才成立）→ 4 处 catch 走 return false
    mkdirSync(join(extractDir, "package", "rust-helper", "src"), { recursive: true });
    const r = run("node", [
      join(extractDir, "package", "src", "invariants", "check-invariants.mjs"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout.match(/^SKIP\s+/gm) ?? []).toEqual([]);
    const failIds = [...r.stdout.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
    for (const id of PKG_FORM_SKIP_IDS) expect(failIds).toContain(id);
  });
});
