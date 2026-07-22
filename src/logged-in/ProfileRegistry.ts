/**
 * ProfileRegistry.ts（v0.8 parse9 §3.2）—— 多 Chrome --user-data-dir profile 配置
 *
 * 设计（parse9 §3.2 + §4.2 决策）：
 *  - profile = Chrome user-data-dir（物理隔离）+ 名字 + 元数据
 *  - 每 profile 独立 user-data-dir（`<cacheDir>/profiles/<name>/user-data/`，mode 0o700）
 *  - 禁碰本机 Chrome 默认 user-data-dir（防污染用户日常浏览器；parse9 §4.2）
 *  - 默认预留 "default" profile（首次启动自动建）
 *
 * 隔离边界：
 *  - 每 profile 独立 subprocess spec name（`logged_in:<name>`）—— LoggedInChannel 切换用
 *  - 每 profile 独立 cookie 加密包（CookieStore 按 profileName 隔离）
 *
 * 不重写 SubprocessManager（parse9 §3.2 决策）：
 *  - 切 profile = `subproc.forgetSpec("logged_in:old") + registerSpec("logged_in:new", ...) + restart`
 *  - 本类只管 profile 配置 + 当前指针；子进程 lifecycle 由调用方（LoggedInChannel）联动
 *
 * 配置文件：`<cacheDir>/profiles/profiles.json`
 *   `{ current: "default", profiles: [{ name, userDataDir, createdAt, lastUsedAt }] }`
 *
 * 借鉴：parse9 §3.2 接口签名 + SubprocessManager 多 spec 范式（INV-7 衍生）。
 */
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

// ============================================================
// 类型
// ============================================================
/**
 * profile 配置（持久化到 profiles.json）。
 */
export interface ProfileConfig {
  /** profile 名（`[a-z0-9_-]{1,32}`；防路径穿越）。 */
  name: string;
  /** user-data-dir 绝对路径。 */
  userDataDir: string;
  /** 创建时间（ms）。 */
  createdAt: number;
  /** 最后切换时间（ms）；switch() 时更新。 */
  lastUsedAt: number;
}

/**
 * ProfileRegistry 公开接口（v0.8 LoggedInChannel / admin.ts 经手；parse9 §3.2）。
 *
 * 实装：`ProfileRegistry` 类（同文件）；测试可注入 stub 实现此接口。
 *
 * 不含 load()：load 仅 index.ts 启动期调一次（启动加载），运行时 read-only。
 */
export interface IProfileRegistry {
  /** 增 profile。 */
  add(name: string): Promise<ProfileConfig>;
  /** 切 profile（改 current）。 */
  switch(name: string): Promise<ProfileConfig>;
  /** 当前 profile（不可空）。 */
  getCurrent(): ProfileConfig;
  /** 列所有 profile。 */
  list(): ProfileConfig[];
  /** 当前 profile 名。 */
  currentName(): string;
}

// ============================================================
// 常量
// ============================================================
/** profile 名校验 regex（防路径穿越 / 特殊字符；parse9 §3.2）。 */
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** profile 配置文件名。 */
const PROFILES_FILENAME = "profiles.json";
/** 默认 profile 名。 */
const DEFAULT_PROFILE_NAME = "default";
/** profiles 子目录名。 */
const PROFILES_DIRNAME = "profiles";
/** user-data-dir 子目录名（profile 目录下）。 */
const USER_DATA_DIRNAME = "user-data";

// ============================================================
// ProfileRegistry（实装 IProfileRegistry）
// ============================================================
export class ProfileRegistry implements IProfileRegistry {
  private current: string = DEFAULT_PROFILE_NAME;
  private profiles = new Map<string, ProfileConfig>();

  constructor(private readonly cacheDir: string) {}

  // ============================================================
  // 启动加载（parse9 §3.2）
  // ============================================================
  /**
   * 启动时调一次：加载 profiles.json；缺失则建 "default" profile。
   */
  async load(): Promise<void> {
    const file = this.configFilePath;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
        current: string;
        profiles: ProfileConfig[];
      };
      if (typeof raw.current !== "string" || !Array.isArray(raw.profiles)) {
        throw new Error("profiles_json_bad_shape");
      }
      this.profiles.clear();
      for (const p of raw.profiles) {
        this.profiles.set(p.name, p);
      }
      if (!this.profiles.has(raw.current)) {
        // current 指向不存在的 profile → fallback 到 default
        this.current = DEFAULT_PROFILE_NAME;
        if (!this.profiles.has(this.current)) {
          await this.add(this.current);
        }
      } else {
        this.current = raw.current;
      }
    } catch {
      // 首次启动 / 文件损坏：建 default profile
      if (!this.profiles.has(DEFAULT_PROFILE_NAME)) {
        await this.add(DEFAULT_PROFILE_NAME);
      }
      this.current = DEFAULT_PROFILE_NAME;
    }
  }

  // ============================================================
  // 增 / 切 / 列（parse9 §3.2）
  // ============================================================
  /**
   * 增 profile：建 user-data-dir（mode 0o700）+ 写 profiles.json。
   * @throws profile_exists / profile_bad_name
   */
  async add(name: string): Promise<ProfileConfig> {
    this.validateName(name);
    if (this.profiles.has(name)) throw new Error(`profile_exists:${name}`);
    const userDataDir = path.join(
      this.cacheDir,
      PROFILES_DIRNAME,
      name,
      USER_DATA_DIRNAME,
    );
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const cfg: ProfileConfig = {
      name,
      userDataDir,
      createdAt: Date.now(),
      lastUsedAt: 0,
    };
    this.profiles.set(name, cfg);
    await this.persist();
    return cfg;
  }

  /**
   * 切 profile：改 current + 更新 lastUsedAt + persist。
   * 调用方（LoggedInChannel）负责 restart 子进程（forgetSpec + registerSpec）。
   * @throws profile_unknown
   */
  async switch(name: string): Promise<ProfileConfig> {
    if (!this.profiles.has(name)) throw new Error(`profile_unknown:${name}`);
    this.current = name;
    this.profiles.get(name)!.lastUsedAt = Date.now();
    await this.persist();
    return this.profiles.get(name)!;
  }

  /** 当前 profile（启动后必有 default，不会缺失）。 */
  getCurrent(): ProfileConfig {
    const c = this.profiles.get(this.current);
    if (!c) throw new Error(`profile_current_missing:${this.current}`);
    return c;
  }

  /** 列所有 profile（按插入序）。 */
  list(): ProfileConfig[] {
    return [...this.profiles.values()];
  }

  /** 当前 profile 名（subprocess spec name `logged_in:<current>` 拼接用）。 */
  currentName(): string {
    return this.current;
  }

  // ============================================================
  // 内部
  // ============================================================
  private get configFilePath(): string {
    return path.join(this.cacheDir, PROFILES_DIRNAME, PROFILES_FILENAME);
  }

  /** 校验 profile 名（防路径穿越 / 特殊字符；parse9 §3.2）。 */
  private validateName(name: string): void {
    if (!NAME_RE.test(name)) {
      throw new Error(`profile_bad_name:${name}`);
    }
  }

  /** 持久化 profiles.json（mode 0o600）。 */
  private async persist(): Promise<void> {
    const file = this.configFilePath;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify(
        {
          current: this.current,
          profiles: [...this.profiles.values()],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
