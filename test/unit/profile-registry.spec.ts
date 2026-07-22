/**
 * ProfileRegistry v0.8 单测（parse9 §3.2 + §5.1）
 *
 * 覆盖：
 *  - load：首次启动建 default / profiles.json 健全加载 / 损坏 JSON 重建 default
 *  - add：建 user-data-dir（mode 0o700）+ 写 profiles.json（mode 0o600）
 *  - switch：改 current + 更新 lastUsedAt + persist
 *  - getCurrent / list / currentName
 *  - 名校验：路径穿越攻击名（"../etc"）/ 特殊字符 / 过长 → profile_bad_name
 *  - 禁碰本机 Chrome 默认 user-data-dir（grep userDataDir 全在 cacheDir 下）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-profile-test-"));
});

afterEach(async () => {
  if (tmpDir) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================
// load（首次启动 + 已有配置）
// ============================================================
describe("ProfileRegistry — load", () => {
  it("首次启动（profiles.json 不存在）→ 自动建 default profile", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    expect(r.currentName()).toBe("default");
    expect(r.list().map((p) => p.name)).toContain("default");
  });

  it("已有 profiles.json → 加载所有 profile + current 指针", async () => {
    // 预写 profiles.json
    const profilesDir = path.join(tmpDir, "profiles");
    await fs.mkdir(profilesDir, { recursive: true });
    await fs.writeFile(
      path.join(profilesDir, "profiles.json"),
      JSON.stringify({
        current: "work",
        profiles: [
          {
            name: "default",
            userDataDir: path.join(tmpDir, "profiles", "default", "user-data"),
            createdAt: 1,
            lastUsedAt: 0,
          },
          {
            name: "work",
            userDataDir: path.join(tmpDir, "profiles", "work", "user-data"),
            createdAt: 2,
            lastUsedAt: 0,
          },
        ],
      }),
    );
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    expect(r.currentName()).toBe("work");
    expect(r.list()).toHaveLength(2);
  });

  it("profiles.json 损坏 → 重建 default（不抛错）", async () => {
    const profilesDir = path.join(tmpDir, "profiles");
    await fs.mkdir(profilesDir, { recursive: true });
    await fs.writeFile(
      path.join(profilesDir, "profiles.json"),
      "not-a-json{",
    );
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    expect(r.currentName()).toBe("default");
  });

  it("current 指向不存在的 profile → fallback 到 default", async () => {
    const profilesDir = path.join(tmpDir, "profiles");
    await fs.mkdir(profilesDir, { recursive: true });
    await fs.writeFile(
      path.join(profilesDir, "profiles.json"),
      JSON.stringify({
        current: "ghost",
        profiles: [
          {
            name: "default",
            userDataDir: path.join(tmpDir, "x"),
            createdAt: 1,
            lastUsedAt: 0,
          },
        ],
      }),
    );
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    expect(r.currentName()).toBe("default");
  });
});

// ============================================================
// add
// ============================================================
describe("ProfileRegistry — add", () => {
  it("add 新 profile → list 含 + user-data-dir mode 0o700", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    const cfg = await r.add("work");
    expect(cfg.name).toBe("work");
    expect(cfg.userDataDir).toContain("work");
    expect(r.list().map((p) => p.name)).toContain("work");
    // user-data-dir 实际生成 + mode 0o700
    const s = statSync(cfg.userDataDir);
    expect(s.mode & 0o777).toBe(0o700);
  });

  it("profiles.json mode 0o600", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work");
    const file = path.join(tmpDir, "profiles", "profiles.json");
    const s = statSync(file);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("add 重复名 → profile_exists", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work");
    await expect(r.add("work")).rejects.toThrow(/profile_exists:work/);
  });

  it("add 后再 load → 持久化数据回声一致", async () => {
    const r1 = new ProfileRegistry(tmpDir);
    await r1.load();
    await r1.add("work");
    await r1.add("personal");
    await r1.switch("personal");
    const r2 = new ProfileRegistry(tmpDir);
    await r2.load();
    expect(r2.currentName()).toBe("personal");
    expect(r2.list().map((p) => p.name).sort()).toEqual(["default", "personal", "work"]);
  });
});

// ============================================================
// 名校验（防路径穿越 / 特殊字符 / 过长）
// ============================================================
describe("ProfileRegistry — 名校验（路径穿越防御）", () => {
  it('"../etc" → profile_bad_name', async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.add("../etc")).rejects.toThrow(/profile_bad_name/);
  });

  it('"a/b" → profile_bad_name（含斜杠）', async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.add("a/b")).rejects.toThrow(/profile_bad_name/);
  });

  it('"with space" → profile_bad_name', async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.add("with space")).rejects.toThrow(/profile_bad_name/);
  });

  it('"UPPER" → profile_bad_name（大写禁）', async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.add("UPPER")).rejects.toThrow(/profile_bad_name/);
  });

  it("超过 32 字符 → profile_bad_name", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.add("a".repeat(33))).rejects.toThrow(/profile_bad_name/);
  });

  it("合法名 default / work-1 / test_profile → 全 OK", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work-1");
    await r.add("test_profile");
    await r.add("abc123");
    expect(r.list().map((p) => p.name).sort()).toEqual(["abc123", "default", "test_profile", "work-1"]);
  });
});

// ============================================================
// switch + getCurrent
// ============================================================
describe("ProfileRegistry — switch", () => {
  it("switch 改 current + 更新 lastUsedAt", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work");
    const before = Date.now();
    const cfg = await r.switch("work");
    expect(r.currentName()).toBe("work");
    expect(cfg.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it("switch 未知 profile → profile_unknown", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await expect(r.switch("ghost")).rejects.toThrow(/profile_unknown:ghost/);
  });

  it("getCurrent 返当前 profile 配置", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work");
    await r.switch("work");
    const cur = r.getCurrent();
    expect(cur.name).toBe("work");
    expect(cur.userDataDir).toContain("work");
  });
});

// ============================================================
// 隔离边界（parse9 §3.2：禁碰本机 Chrome 默认 dir）
// ============================================================
describe("ProfileRegistry — user-data-dir 落 cacheDir 内", () => {
  it("所有 profile userDataDir 都在 cacheDir 下（禁碰 ~/Library/Google/Chrome）", async () => {
    const r = new ProfileRegistry(tmpDir);
    await r.load();
    await r.add("work");
    await r.add("personal");
    for (const p of r.list()) {
      expect(p.userDataDir.startsWith(tmpDir)).toBe(true);
    }
  });
});
