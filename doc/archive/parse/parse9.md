# Lasso v0.8 功能分析师 parse9 —— 文件/函数级执行计划（登录态持久化）

> 上游：[09 §2.9 v0.8](09-media-interact-实施排期.md) + [08 F3.3.9-12 / F3.5.13 / F3.6.12 + §5.1 cookie 隐私 + §7.3 v0.8+ 缓解](08-media-interact-功能架构.md) + [02 §5.5 抽象成本自检 + §6.3 review 三问](../../架构想法/02_简单检查清单.md)。
> v0.7 基线：**47 invariants + 1147 TS + 144 Rust tests**（零回归承诺；新 INV 编号 ≥48）。
> 简单性守门：cookie 落盘复用 `util/output-envelope.ts` mode 0o600 范式（INV-15 衍生 → 新 INV-48）；多 profile 复用 `SubprocessManager.registerSpec` 多 spec 范式（INV-7 衍生 → 新 INV-49）；tab LRU 复用 `util/state-store.ts` LRU(128) 范式（INV-12 衍生 → 新 INV-50）。
> **隐私红线**（08 §5.1 + §7.3）：cookie=身份（session token）。落盘必加密（AES-256-GCM）+ mode 0o600 + 用户显式 opt-in（admin action），doctor **永不清读 cookie 内容**（只检测 profile 存在 / Chrome 可达 / 加密包完整性，INV-51）。

---

## 1. v0.8 目标与范围（v0.7 增量）

### 1.1 能力跃升（09 §2.9 原文）
**v0.7（已交付）**：可观测完善 + 长熔断（指标/告警/资源监控 + 60min 长熔断 + SERP 改版检测）。
**v0.8（本 parse）**：从「每次重启重登」升到「登录态跨会话保留」——CC 能让 Lasso 把上次 browse_logged_in 的登录态存下来下次直接用，能在多账号场景（work/personal/test）切 profile 不互相污染，且 tab 不会爆炸。

### 1.2 范围矩阵（做 / 不做）

| 维度 | 做（v0.8） | 不做（推迟 / NO-GO） |
|---|---|---|
| **cookie 持久化** | CDP `Network.getAllCookies` 导出 → AES-256-GCM 加密落盘 mode 0o600 → import 回新会话恢复登录态（F3.3.9-10） | 跨设备同步（NO-GO，08 §5.1 cookie=身份不外传）；明文落盘（NO-GO）；自动上传云（NO-GO） |
| **多 profile** | 多 Chrome `--user-data-dir` profile（work/personal/test），每 profile 一个独立 logged_in 子进程（F3.3.11 + F3.5.13 + F3.6.12） | 自动 profile 推荐算法（推迟 v0.9+）；profile 跨主机同步（NO-GO） |
| **tab LRU** | 多 tab 管理 + LRU 淘汰（≤10 hard cap，F3.3.12） | tab 跨 profile 共享（NO-GO，profile 物理隔离）；tab 持久化跨重启（推迟 v0.9+） |
| **加密方案** | macOS Keychain（`security` CLI）→ Linux libsecret / Win credential-manager（v1.0+）→ passphrase env fallback | 硬编码 master key（NO-GO，INV-51）；明文（NO-GO） |
| **doctor** | profile 健康检查（profile 目录存在 / Chrome 可达 / 加密包完整性 sha256） | **清读 cookie 内容**（NO-GO，隐私红线 INV-51）；自动导入 cookie（NO-GO，必经用户 admin action） |
| **暴露** | admin tool 加 3 action（profile_list / profile_switch / cookie_restore）；browse_logged_in 自动 pick current profile | 新 `logged_in_state` tool（NO-GO，守 INV-46 admin action-enum 范式） |

### 1.3 隐私边界（08 §5.1 + §7.3 衍生）

| 红线 | 落地 |
|---|---|
| **cookie=身份** | 落盘前必 AES-256-GCM 加密；明文 cookie **永不出现在磁盘**（INV-48 衍生 INV-52） |
| **mode 0o600** | 加密包文件 mode 0o600，目录 mode 0o700（复用 output-envelope.ts `spillToDisk` 范式） |
| **用户显式 opt-in** | cookie export / import 必经 admin tool action；browse_logged_in 不自动 export（防 LLM 自行其是） |
| **doctor 不清读** | doctor 只 stat 加密包（大小 + sha256 + mtime），**永不解密 / 永不打印 cookie 字段**（INV-51） |
| **master key 不进 git** | key 从 OS keychain 取（首选）；fallback passphrase env（`LASSO_COOKIE_PASSPHRASE`）；**禁硬编码**（INV-51 红线） |
| **2FA 不解** | cookie 失效遇 2FA 仍返 NEEDS_MANUAL_2FA（08 §7.3）；cookie 持久化只是缓解不是破解 |

### 1.4 量化目标（验收锚点）
- v0.8 收尾 TS 行数 ≈ **1147 + ~1050**（≈ 2200），Rust 行数零改（v0.8 不动 Rust helper，守 INV-21/26/35）
- INV 总数 **47 → 53**（加 INV-48..53，全部为 v0.8 新加，不重写 v0.7 INV-41..47）
- CI 闸门：`npm run check-invariants` 报 **53 条全绿**；`npm test` 通过率 100%（v0.7 测试集零回归）
- cookie 真测需真登录态：CI mock CDP `Network.getAllCookies` 响应 + AES-GCM round-trip 单测；真登录态留手测清单（parse9-acceptance.md）

---

## 2. 文件结构（lasso/src/ 改动；零回归 v0.7 的 1147 TS + 144 Rust + 47 invariants）

### 2.1 新增文件（6 个；总 ≈ 850 行 TS）

```
src/
├── logged-in/                        ★ 新目录（与 browse/ 平行；logged_in 专属 cookie/profile/tab）
│   ├── CdpClient.ts                  ★ 新（~140 行）极简 CDP-over-WebSocket 客户端（直连 :9222/json + WebSocket）
│   ├── CookieStore.ts                ★ 新（~210 行）AES-256-GCM 加密落盘 mode 0o600 + import/export round-trip
│   ├── ProfileRegistry.ts            ★ 新（~180 行）多 profile 配置 + user-data-dir 隔离 + 当前 profile 切换
│   ├── TabRegistry.ts                ★ 新（~150 行）多 tab 管理 + LRU 淘汰（≤10 hard cap）
│   └── keychain.ts                   ★ 新（~110 行）master key 提供者（macOS `security` / env fallback）
└── browse/
    └── (无新增；多 profile 经 LoggedInChannel 改造注入)
```

### 2.2 修改文件（6 个；增量改动，v0.7 行为零差异）

| 文件 | 改动要点 | 行数增量 |
|---|---|---|
| `src/channels/LoggedInChannel.ts` | 构造时按 ProfileRegistry 当前 profile 动态选择 spec name（`logged_in:<profile>`）；新增 `exportCookies()` / `importCookies()` 方法（包装 CookieStore） | +~80 |
| `src/subprocess/SubprocessManager.ts` | **零代码改**：`registerSpec` 已支持多 spec；profile 切换经新 `switchSpec()` helper（仅 facade，复用 `forgetSpec` + `registerSpec`） | +~25 |
| `src/runtime/runtime-types.ts` | `AdminAction` union 加 3 项（`profile_list` / `profile_switch` / `cookie_restore`） | +~6 |
| `src/tools/admin.ts` | `adminSchema.action` enum 加 3 项；handler switch 加 3 case（复用 v0.6 + v0.7 action-enum 范式；INV-46 衍生） | +~140 |
| `src/doctor/doctor.ts` | `runtime_state` section 扩 `profiles` 子节（profile 名 / 目录存在 / 加密包 sha256；**禁 cookie 字段**）；新增 #28-#30 三项 check（INV-51 红线） | +~80 |
| `src/index.ts` | 装配段：实例化 ProfileRegistry + CookieStore + TabRegistry + keychain；注入 LoggedInChannel 构造；admin handler 加 3 case 路由 | +~60 |
| `src/invariants/check-invariants.mjs` | 加 INV-48..53 共 6 条新 INV（不改 v0.7 INV-1..47） | +~140 |

**总增量**：新增 ~850 行 + 修改 ~530 行 ≈ **1380 行 TS + 140 行 INV 脚本**（落 §1.4 估算窗口内）。

### 2.3 Rust 改动
**零改**（`lasso/src/desktop/rust-helper/` 一行不动）。v0.8 是 logged_in 专属层，不渗 desktop 契约（守 INV-21/26/35）。tab LRU 在 TS 层（chrome-devtools-mcp 的 `list_pages` / `close_page` 经 McpClient 调），不需 Rust。

### 2.4 依赖改动
**零新依赖**（守简单性 R-CI-02）：
- AES-256-GCM 用 `node:crypto` built-in（`createCipheriv("aes-256-gcm", ...)`）
- CDP WebSocket 用 `WebSocket` built-in（Node 20+ 原生；engines `>=20` 已守）
- macOS keychain 用 `node:child_process.execFile` 调 `security` CLI（系统自带）
- 多 profile / tab / 加密都用纯 TS，无 npm dep

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 cookie export/import（CDP getAllCookies + AES-256-GCM 加密落盘 mode 0o600）

**借鉴源**：
- `src/util/output-envelope.ts` 行 158-180 `spillToDisk`（mode 0o600 + 目录 0o700 + INV-15）—— **复用 mode 范式 → INV-48**
- `src/util/state-store.ts` 行 41-54 `setStateStoreContext`（cacheDir 注入）—— **复用配置注入范式**
- `chrome-remote-interface` npm（不引，仅借鉴 CDP 帧格式：`{id, method, params}` / `{id, result}`）
- CDP spec `Network.getAllCookies` / `Network.setCookie` / `Network.canClearBrowserCookies`（Chrome DevTools Protocol 官方）

**关键决策（简单性 R-CI-02 / 02 §5.5 抽象成本）**：
- **不开第二个 MCP 子进程**。cookie 操作不走 chrome-devtools-mcp（其 v0.3.0 不暴露 `Network.getAllCookies`），而是开极简 CDP-over-WebSocket 直连 :9222（CdpClient ~140 行；只 3 个方法：`getAllCookies` / `setCookie` / `close`）。
- **不绕过 LoggedInChannel**。CdpClient 由 LoggedInChannel 持有；admin action `cookie_restore` 经 LoggedInChannel.importCookies → CookieStore.load → CdpClient.setCookie。
- **加密落盘必经用户 opt-in**。browse_logged_in 自动路径**不调** CookieStore.export；admin action 显式触发（防 LLM 在用户不知情时落盘 session token）。

**接口签名（src/logged-in/CdpClient.ts）**：

```ts
/**
 * 极简 CDP-over-WebSocket 客户端（v0.8 新增）。
 *
 * 设计：chrome-devtools-mcp@0.3.0 不暴露 Network.getAllCookies / setCookie，
 *       故 cookie 操作走裸 CDP（WebSocket）。本类只 3 个方法，不抽象第二层。
 *
 * 连接：GET http://localhost:<cdpPort>/json/version 拿 webSocketDebuggerUrl →
 *       new WebSocket(url) → 走 CDP 协议（{id, method, params} / {id, result}）。
 *
 * INV-7 衍生：本类不渗 SubprocessManager（那是 MCP 子进程 lifecycle）；
 *             本类是「向 Chrome 进程发 CDP 帧」，与 SubprocessManager 并列。
 */
export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();

  constructor(private readonly cdpPort = 9222) {}

  private async connect(): Promise<void> {
    if (this.ws) return;
    // 1. /json/version → webSocketDebuggerUrl
    const r = await fetch(`http://localhost:${this.cdpPort}/json/version`);
    const { webSocketDebuggerUrl } = (await r.json()) as {
      webSocketDebuggerUrl: string;
    };
    if (!webSocketDebuggerUrl) throw new Error("cdp_no_websocket_url");
    // 2. WebSocket 连接 + onmessage dispatch
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`cdp_error:${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    };
    await new Promise((res, rej) => {
      this.ws!.once("open", res);
      this.ws!.once("error", rej);
    });
  }

  /** CDP Network.getAllCookies —— 返所有 cookie（含 httpOnly）。 */
  async getAllCookies(): Promise<CdpCookie[]> {
    await this.connect();
    return (await this.send("Network.getAllCookies", {})).cookies as CdpCookie[];
  }

  /** CDP Network.setCookie —— 单条导入（参数对齐 CDP spec）。 */
  async setCookie(params: CdpSetCookieParams): Promise<boolean> {
    await this.connect();
    const r = await this.send("Network.setCookie", params);
    return r.success === true;
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  private send(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }
}

export interface CdpCookie {
  name: string; value: string; domain: string; path: string;
  expires?: number; size: number; httpOnly: boolean; secure: boolean;
  session: boolean; sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High"; sameParty?: boolean;
  sourceScheme?: "Unset" | "Secure" | "NonSecure"; sourcePort?: number;
}

export type CdpSetCookieParams = Omit<CdpCookie, "size" | "session">;
```

**接口签名（src/logged-in/CookieStore.ts）**：

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { getKeychainKey } from "./keychain.js";

/**
 * cookie 加密落盘（v0.8 F3.3.9-10）。
 *
 * 隐私铁律（INV-48 衍生 INV-52）：
 *  - 明文 cookie **永不出现在磁盘**。落盘前必 AES-256-GCM 加密。
 *  - 加密包文件 mode 0o600，目录 mode 0o700（复用 output-envelope.ts INV-15 范式）。
 *  - master key 从 OS keychain / passphrase env 取；**禁硬编码**（INV-51）。
 *  - doctor 永不解密 / 永不读 cookie 字段（INV-51）；只 stat 加密包元数据。
 *
 * 加密格式：
 *   file := magic (4B "LSCO") || salt (16B) || iv (12B) || ciphertext || tag (16B)
 *   key  := scryptSync(masterKey, salt, 32, { N: 2^14, r: 8, p: 1 })
 *
 * 落盘位置：~/.cache/lasso/cookies/<profileName>.cookies
 */
const MAGIC = "LSCO"; // Lasso Cookie
const COOKIES_DIRNAME = "cookies";

export class CookieStore {
  constructor(
    private readonly cacheDir: string,           // ~/.cache/lasso
    private readonly profileName: string,         // "work" / "personal" / ...
  ) {}

  private get filePath(): string {
    return path.join(this.cacheDir, COOKIES_DIRNAME, `${this.profileName}.cookies`);
  }

  /** 导出：cookies → 加密落盘（mode 0o600）。返加密包 sha256（doctor 校验用）。 */
  async export(cookies: CdpCookie[]): Promise<{ sha256: string; bytes: number }> {
    const plaintext = JSON.stringify({ version: 1, exportedAt: Date.now(), cookies });
    const masterKey = await getKeychainKey();          // INV-51：master key 不硬编码
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(masterKey, salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const buf = Buffer.concat([
      Buffer.from(MAGIC, "ascii"), salt, iv, ct, tag,
    ]);
    // 目录 mode 0o700 + 文件 mode 0o600（INV-15 衍生 INV-48）
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, buf, { mode: 0o600 });
    return { sha256: buf.subarray(0, 32).toString("hex") /* simplified */, bytes: buf.length };
  }

  /** 导入：解密 → 返 cookie 数组（不直接灌回 CDP；由 admin action 经 CdpClient.setCookie）。 */
  async import(): Promise<CdpCookie[]> {
    if (!existsSync(this.filePath)) throw new Error("cookie_store_not_found");
    const buf = await fs.readFile(this.filePath);
    if (buf.subarray(0, 4).toString("ascii") !== MAGIC) throw new Error("cookie_bad_magic");
    const salt = buf.subarray(4, 20);
    const iv = buf.subarray(20, 32);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(32, buf.length - 16);
    const masterKey = await getKeychainKey();
    const key = scryptSync(masterKey, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return (JSON.parse(plain) as { cookies: CdpCookie[] }).cookies;
  }

  /** doctor 探测用：返加密包 stat（不解密、不读内容；INV-51）。 */
  async stat(): Promise<{ exists: boolean; bytes?: number; mtimeMs?: number }> {
    if (!existsSync(this.filePath)) return { exists: false };
    const s = await fs.stat(this.filePath);
    return { exists: true, bytes: s.size, mtimeMs: s.mtimeMs };
  }
}
```

### 3.2 多 profile（profile 配置 + user-data-dir 隔离 + 子进程 per profile）

**借鉴源**：
- `src/subprocess/SubprocessManager.ts` 行 121-130 `registerSpec/forgetSpec`（spec 注册/卸载）—— **复用多 spec 范式**
- `src/channels/LoggedInChannel.ts` 行 47-57 构造时 `registerSpec("logged_in", ...)` —— **当前单 profile 入口**
- `src/channels/HeadlessChannel.ts` 行 22-33（同类 spawn 范式）

**关键决策（简单性 R-CI-02）**：
- **不重写 SubprocessManager**。ProfileRegistry 只是Logged InChannel 的配置层；切换 profile = `subproc.forgetSpec("logged_in:old") + registerSpec("logged_in:new", ...) + restart`。
- **不改 BrowseChannel**。actionDispatch Map、executeStep、runChain 一行不动；profile 是子进程层概念，BrowseChannel 不感知（守 INV-6）。
- **不改 HeadlessChannel**。headless 仍是单 spec（无登录态，profile 无意义）；守 v0.7 测试零回归。

**接口签名（src/logged-in/ProfileRegistry.ts）**：

```ts
import { promises as fs, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * 多 profile 配置（F3.3.11 + F3.6.12）。
 *
 * 设计：profile = Chrome user-data-dir（物理隔离）+ 名字 + 元数据。
 *       work / personal / test 三 profile 默认预留；用 admin action 增删。
 *
 * 隔离边界：
 *  - 每 profile 独立 user-data-dir（~/.cache/lasso/profiles/<name>/）
 *  - 每 profile 独立 subprocess spec name（logged_in:work / logged_in:personal / ...）
 *  - 每 profile 独立 cookie 加密包（CookieStore 按名字隔离）
 *  - **禁**用本机 Chrome 默认 user-data-dir（防污染用户日常浏览器；INV-49 红线）
 *
 * 配置文件：~/.cache/lasso/profiles/profiles.json
 *   { current: "work", profiles: [{ name, userDataDir, createdAt }] }
 */
export interface ProfileConfig {
  name: string;                              // "work" / "personal" / "test"（[a-z0-9_-]+，≤32 字符）
  userDataDir: string;                       // 绝对路径
  createdAt: number;
  lastUsedAt: number;
}

export class ProfileRegistry {
  private current: string = "default";
  private profiles = new Map<string, ProfileConfig>();

  constructor(private readonly cacheDir: string) {}

  /** 启动时调一次：加载 profiles.json；缺失则建 "default" profile。 */
  async load(): Promise<void> {
    const file = path.join(this.cacheDir, "profiles", "profiles.json");
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
        current: string; profiles: ProfileConfig[];
      };
      this.current = raw.current;
      for (const p of raw.profiles) this.profiles.set(p.name, p);
    } catch {
      // 首次启动：建 default profile
      await this.add("default");
      this.current = "default";
    }
  }

  /** 增 profile：建 user-data-dir（mode 0o700）+ 写 profiles.json。 */
  async add(name: string): Promise<ProfileConfig> {
    this.validateName(name);
    if (this.profiles.has(name)) throw new Error(`profile_exists:${name}`);
    const userDataDir = path.join(this.cacheDir, "profiles", name, "user-data");
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const cfg: ProfileConfig = {
      name, userDataDir, createdAt: Date.now(), lastUsedAt: 0,
    };
    this.profiles.set(name, cfg);
    await this.persist();
    return cfg;
  }

  /** 切 profile：改 current + persist；调用方（LoggedInChannel）负责 restart 子进程。 */
  async switch(name: string): Promise<ProfileConfig> {
    if (!this.profiles.has(name)) throw new Error(`profile_unknown:${name}`);
    this.current = name;
    this.profiles.get(name)!.lastUsedAt = Date.now();
    await this.persist();
    return this.profiles.get(name)!;
  }

  getCurrent(): ProfileConfig {
    const c = this.profiles.get(this.current);
    if (!c) throw new Error(`profile_current_missing:${this.current}`);
    return c;
  }

  list(): ProfileConfig[] {
    return [...this.profiles.values()];
  }

  /** 校验 profile 名（防路径穿越 / 特殊字符）。 */
  private validateName(name: string): void {
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      throw new Error(`profile_bad_name:${name}`);
    }
  }

  private async persist(): Promise<void> {
    const file = path.join(this.cacheDir, "profiles", "profiles.json");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({
      current: this.current,
      profiles: [...this.profiles.values()],
    }, null, 2), { mode: 0o600 });
  }
}
```

**LoggedInChannel 改造点（src/channels/LoggedInChannel.ts）**：

```ts
// 改造前（v0.7）：
//   constructor(subproc, cdpPort = 9222) { subproc.registerSpec("logged_in", { ... --browser-url ... }); }
// 改造后（v0.8）：
constructor(
  private readonly subproc: SubprocessManager,
  private readonly cdpPort = 9222,
  private readonly profiles: ProfileRegistry,    // ★ 新
) {
  super();
  // 不在此 registerSpec —— 改在 ensureProfileLoaded() 懒注册当前 profile
}

/** ensureRunning 前调：按当前 profile 注册 spec。 */
private async ensureProfileSpec(): Promise<void> {
  const p = this.profiles.getCurrent();
  const specName = `logged_in:${p.name}`;
  // 已注册且未变 → no-op
  if (this.lastSpecName === specName) return;
  // 切 profile：forget 旧 + register 新
  if (this.lastSpecName) await this.subproc.forgetSpec(this.lastSpecName);
  this.subproc.registerSpec(specName, {
    command: "npx",
    args: [
      "-y",
      `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
      // v0.8 关键：切到独立 user-data-dir（不再 --browser-url 复用本机 Chrome）
      // 副作用：profile 切换需先 lasso launch-chrome --profile <name> 启动独立 Chrome 实例
      `--browser-url=http://localhost:${this.cdpPort}`,
      `--user-data-dir=${p.userDataDir}`,
    ],
    mcpClientName: `lasso-browse-logged-in-${p.name}`,
  });
  this.lastSpecName = specName;
}
private lastSpecName: string | null = null;

protected async getMcpClient(): Promise<McpClient> {
  await this.ensureProfileSpec();
  const c = await this.subproc.ensureRunning(this.lastSpecName!);
  await this._detect2FA(c);
  return c;
}

/** admin action 入口：导出当前 profile 的 cookie。 */
async exportCookies(store: CookieStore): Promise<{ sha256: string; bytes: number }> {
  const cdp = new CdpClient(this.cdpPort);
  try {
    const cookies = await cdp.getAllCookies();
    return await store.export(cookies);
  } finally {
    await cdp.close();
  }
}

/** admin action 入口：导入 cookie 到当前 profile。 */
async importCookies(store: CookieStore): Promise<{ imported: number; failed: number }> {
  const cookies = await store.import();
  const cdp = new CdpClient(this.cdpPort);
  let imported = 0, failed = 0;
  try {
    for (const c of cookies) {
      const ok = await cdp.setCookie({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, expires: c.expires,
      });
      ok ? imported++ : failed++;
    }
    return { imported, failed };
  } finally {
    await cdp.close();
  }
}
```

### 3.3 tab LRU（多 tab 管理 + LRU 淘汰 ≤10）

**借鉴源**：
- `src/util/state-store.ts` 行 89-188 `StateStore<T>` LRU(128) Map（delete + set → MRU 提升；keys().next().value 取最老删）—— **复用 LRU 范式 → INV-50**
- `src/channels/BrowseChannel.ts` 行 494-512 `listRoots`（已调 `list_pages` 拿 tabs）—— **tab 源自既有 upstream**
- chrome-devtools-mcp `list_pages` / `new_page` / `close_page` / `select_page`（既有工具）

**关键决策（简单性 R-CI-02）**：
- **不渗 BrowseChannel.actionDispatch**。tab 管理是横切关注点，新 TabRegistry 类独立；BrowseChannel 一行不改。
- **不渗 StateStore**。StateStore 是「页面状态」LRU；TabRegistry 是「Chrome tab」LRU —— 概念不混（避免概念完整性失守，02 §5）。
- **复用 list_pages**。tab 入口 = chrome-devtools-mcp `list_pages`（既有）；淘汰出口 = `close_page`（既有）。

**接口签名（src/logged-in/TabRegistry.ts）**：

```ts
import type { McpClient } from "../subprocess/McpClient.js";

/**
 * tab LRU 管理（F3.3.12 ≤10 hard cap）。
 *
 * 防爆炸场景：CC 反复 navigate 不同 URL，chrome-devtools-mcp 默认每 URL 留一个 tab；
 *             100 次后 Chrome 内存爆。本类守 ≤10，超限 LRU 淘汰最老 tab。
 *
 * 复用范式（INV-50）：
 *  - LRU Map<tabId, { lastUsedAt }>（同 state-store.ts StateStore LRU(128)）
 *  - 触达 = get + delete + set（MRU 提升）
 *  - 淘汰 = while size > cap: keys().next().value + close_page
 *
 * 不渗 BaseChannel（INV-7 衍生）：tab 是 chrome-devtools-mcp 概念，desktop 通道无 tab。
 */
const TAB_CAP_DEFAULT = 10;

export class TabRegistry {
  private tabs = new Map<string, { url: string; lastUsedAt: number }>();
  private cap: number;

  constructor(cap: number = TAB_CAP_DEFAULT) {
    this.cap = Math.min(Math.max(cap, 1), 20);  // hard clamp [1, 20]
  }

  /**
   * 从 list_pages 同步 tab 列表 → 触达所有 → 淘汰超限。
   * 调用方：LoggedInChannel.getMcpClient() 末尾，每次 ensureRunning 后调一次。
   */
  async reconcile(client: McpClient): Promise<{ reaped: string[]; kept: number }> {
    const r = (await client.callTool("list_pages", {})) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (r.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    // 触达（MRU 提升）
    for (const url of urls) {
      const id = urlToTabId(url);
      const existing = this.tabs.get(id);
      if (existing) {
        this.tabs.delete(id);
        this.tabs.set(id, { url, lastUsedAt: Date.now() });
      } else {
        this.tabs.set(id, { url, lastUsedAt: Date.now() });
      }
    }
    // 淘汰（LRU：最老）
    const reaped: string[] = [];
    while (this.tabs.size > this.cap) {
      const oldest = this.tabs.keys().next().value;
      if (!oldest) break;
      const meta = this.tabs.get(oldest)!;
      try {
        await client.callTool("close_page", { url: meta.url });
        reaped.push(oldest);
      } catch {
        // close 失败（tab 已自然关闭）→ 仍从 Map 删
      }
      this.tabs.delete(oldest);
    }
    return { reaped, kept: this.tabs.size };
  }

  size(): number {
    return this.tabs.size;
  }
}

function urlToTabId(url: string): string {
  // sha1 短哈希（与 BrowseChannel.parseListPages djb2 同档；不引 crypto 重负载）
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
```

### 3.4 隐私边界（加密方案选型 + doctor profile 健康不清读 cookie）

**借鉴源**：
- macOS `security` CLI（系统自带；`man security`）—— `security add-generic-password -s lasso-cookie -a <profile> -w <masterKey>`
- `node:crypto` `scryptSync` / `createCipheriv("aes-256-gcm", ...)` —— built-in
- `src/doctor/doctor.ts` 行 414-432 `checkStealthProfileSelfCheck`（doctor shape 自检范式）—— **复用做 profile check**

**加密方案选型（决策表）**：

| 方案 | 优点 | 缺点 | v0.8 选 |
|---|---|---|---|
| OS keychain（macOS Keychain / Linux libsecret / Win CredManager） | OS 级保护；用户解锁才取；抗离线攻击 | 平台差异（macOS 用 `security`，Linux 需 `secret-tool`，Win 需 PowerShell）；CI 难 mock | **首选**（macOS 实装，Linux/Win v1.0+） |
| passphrase env（`LASSO_COOKIE_PASSPHRASE`） | 跨平台；简单 | 用户须自己管；passphrase 弱则加密弱 | **fallback**（未配 keychain 时） |
| 明文 mode 0o600 | 最简 | 同主机任何 root 可读；进程被读 fs 直接拿到 session token | **NO-GO**（违 INV-51） |
| 硬编码 master key | 最简 | 进 git = 公开；任何拿到 dist 的人可解密 | **NO-GO**（违 INV-51 红线） |

**接口签名（src/logged-in/keychain.ts）**：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import * as os from "node:os";

const execFileP = promisify(execFile);
const SERVICE = "lasso-cookie";
const ACCOUNT = "master";

/**
 * 取 master key（优先级：macOS Keychain > env LASSO_COOKIE_PASSPHRASE > 抛错）。
 *
 * 首次调用若无 key：自动生成 32B 随机 + 写 keychain（macOS）或返 env（要求用户已配）。
 *
 * INV-51 红线：master key 永不落盘 / 永不进 git / 永不被 doctor 打印。
 */
export async function getKeychainKey(): Promise<string> {
  // 1. macOS keychain
  if (os.platform() === "darwin") {
    try {
      const { stdout } = await execFileP("security", [
        "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
      ]);
      return stdout.trim();
    } catch {
      // 不存在 → 自动生成 + 写 keychain（首次自动配置；用户可在 Keychain Access 看到 lasso-cookie）
      const newKey = randomBytes(32).toString("base64");
      await execFileP("security", [
        "add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", newKey, "-U",
      ]);
      return newKey;
    }
  }
  // 2. env fallback（Linux/Win v0.8 暂用；v1.0+ 接 libsecret / credential-manager）
  const env = process.env.LASSO_COOKIE_PASSPHRASE;
  if (!env || env.length < 16) {
    throw new Error(
      "master_key_unavailable: configure macOS Keychain (auto) or set LASSO_COOKIE_PASSPHRASE (>=16 chars)",
    );
  }
  return env;
}
```

**doctor 改造（src/doctor/doctor.ts）—— profile 健康不清读 cookie**：

```ts
// 新增 check #28-#30（v0.8）：
//   28. profile_registry_loadable     — ProfileRegistry.load() 不抛 + 至少 1 个 profile
//   29. profile_user_data_dir_exists  — 当前 profile 的 userDataDir 存在且 mode 0o700
//   30. cookie_store_stat_only        — CookieStore.stat() 返 exists+bytes+mtime（**禁**调 import / **禁**打印 cookies 字段）
//
// 关键：doctor #30 必须只调 stat()，**不调** getKeychainKey / 不调 CookieStore.import。
//       INV-51 红线：doctor 路径永不接触 master key / 明文 cookie。
function checkCookieStoreStatOnly(store: CookieStore): DoctorCheck {
  return {
    name: "cookie_store_stat_only",
    status: "pass",  // 默认 pass；有加密包则报 sha256，无则报 "no_encrypted_package"
    detail: "...",
  };
}
```

---

## 4. 不明确点调研结论

### 4.1 cookie 加密方案 → 决策：macOS Keychain 首选，env fallback
**调研**：08 §5.1「cookie=身份」+ 09 §2.9「cookie 持久」存在表面张力。08 line 243「不导出用户 cookie」是 v0.1 立场（无加密基础设施）；08 line 295「v0.8+ cookie export 缓解」是 v0.8 决策（已有 output-envelope mode 0o600 范式可复用）。
**结论**：v0.8 允许 export，但落盘必 AES-256-GCM + master key 走 OS keychain（INV-51 红线）。doctor 永不解密（仅 stat）。

### 4.2 user-data-dir 多 profile → 决策：专用 `~/.cache/lasso/profiles/<name>/`，禁碰本机 Chrome 默认 dir
**调研**：直接复用本机 Chrome `~/Library/Application Support/Google/Chrome` 风险高——污染用户日常浏览器、与用户已开 Chrome 实例冲突（Chrome 单实例锁）、TCC 权限边界混乱。
**结论**：每 profile 独立 user-data-dir 落 `~/.cache/lasso/profiles/<name>/user-data/`（mode 0o700）。需配套 `lasso launch-chrome --profile <name>` 启动独立 Chrome 实例（chrome-devtools-mcp 仍 `--browser-url :9222` 复用，但 Chrome 本体独立）。
**已知偏离**：profile 切换需用户重启 Chrome 实例（lasso 不自动启停 Chrome，只管 user-data-dir 路径）；09 §2.9 v0.8 验收未含「无缝切换」，故手测清单标 pending。

### 4.3 tab LRU 容量与淘汰策略 → 决策：hard cap 10，LRU（与 StateStore(128) 同范式）
**调研**：chrome-devtools-mcp 默认无 tab 上限（每 navigate 留一 tab）；100+ tab Chrome 内存 1.5GB+。Browser-use / stagehand 类项目用 cap 8-15；injaneity `StateStore` 用 cap 128（不同概念，page state vs Chrome tab）。
**结论**：v0.8 cap 10（09 §2.9 原文「≤10」），clamp [1, 20]，LRU 淘汰最老 tab（close_page）。tab id = url djb2 短哈希（与 BrowseChannel.parseListPages 同档；同 url 不同 tab 误复用概率接受）。

### 4.4 chrome-devtools-mcp 是否暴露 cookie 工具 → 决策：不开第二套 MCP，自写极简 CdpClient
**调研**：chrome-devtools-mcp@0.3.0 工具表（LOCKED_CDP_MCP_VERSION）含 navigate_page / take_snapshot / take_screenshot / click / fill_form / wait_for / evaluate_script / pdf / list_pages / new_page / close_page / select_page，**不含** `Network.getAllCookies` / `setCookie`。evaluate_script 跑在 page context，**无法**调 CDP `Network.*` 域。
**结论**：cookie 操作走裸 CDP WebSocket（CdpClient ~140 行；直连 `http://localhost:<port>/json/version` → `webSocketDebuggerUrl`）。**不渗** SubprocessManager（INV-7 衍生：CdpClient 是协议客户端，不是子进程）。

---

## 5. 测试计划

### 5.1 CI 单测（vitest，纯 mock）

| 测试文件 | 覆盖 | 断言 |
|---|---|---|
| `test/unit/cdp-client.spec.ts` ★ 新 | CdpClient WebSocket 帧编解码 | mock WebSocket；id 自增；pending Map 解析；error 帧抛 `cdp_error:*` |
| `test/unit/cookie-store.spec.ts` ★ 新 | AES-GCM round-trip + mode 0o600 | export → import 字节级一致；mode 校验 `0o600`；目录 `0o700`；bad magic 抛错；key 错抛错（auth tag 验证失败） |
| `test/unit/keychain.spec.ts` ★ 新 | master key 优先级 | mock `security` CLI 返固定 key；env fallback 长度 <16 抛错；platform=darwin 走 keychain 分支 |
| `test/unit/profile-registry.spec.ts` ★ 新 | profile 增/切/校验 | add → list 含；switch current 改；bad_name 抛错；路径穿越攻击名（`../etc`）抛错 |
| `test/unit/tab-registry.spec.ts` ★ 新 | LRU ≤10 | mock 15 个 url → reconcile 后 size=10；最老 5 个 close_page 被调；再触达老 url 提 MRU |
| `test/unit/logged-in-channel-profile.spec.ts` ★ 新 | LoggedInChannel profile 切换 | mock ProfileRegistry；switch 后 lastSpecName 改；forgetSpec + registerSpec 被调 |
| `test/unit/invariants-v08.spec.ts` ★ 新 | INV-48..53 静态校验 | mode 0o600 字面量在 CookieStore.ts；master key 禁硬编码；doctor 不调 import；CdpClient 不在 SubprocessManager.ts |

**CI 总数预期**：v0.7 1147 → v0.8 ≈ **1147 + ~280 ≈ 1430**（每模块 ~40 测试）。

### 5.2 集成测（test/integration/，mock CDP）

| 测试 | 覆盖 | 备注 |
|---|---|---|
| `cookie-round-trip.spec.ts` ★ 新 | export → 加密 → import → CdpClient.setCookie 全链 | mock CDP WebSocket server（ws 包）返 `Network.getAllCookies` 假数据；断 import 后 setCookie 调用次数 |
| `profile-isolation.spec.ts` ★ 新 | profile A 的 cookie 加密包不被 profile B 的 key 解密 | 每 profile 独立 master key？决策：**同 master key**（keychain 单 master），但不同文件名 → 仍隔离；断 A.export 不能被 B.import 误读 |

### 5.3 手测清单（parse9-acceptance.md，CI 无法代劳）

| # | 测项 | 触发 | 预期 |
|---|---|---|---|
| 1 | 真登录态 export | 本机 Chrome 登录 GitHub → `admin({action:"cookie_restore", profile:"work", op:"export"})` | 加密包 `~/.cache/lasso/cookies/work.cookies` 生成，mode 0o600 |
| 2 | 重启后 import | 关 Chrome → 重启 → `admin({action:"cookie_restore", profile:"work", op:"import"})` → browse_logged_in(GitHub private) | 不需重新登录，能读 private repo |
| 3 | macOS Keychain 首次自动建 | 删 Keychain `lasso-cookie` → export | 首次调 `security add-generic-password` 自动建；Keychain Access 可见 |
| 4 | doctor 不清读 cookie | `lasso doctor` | #30 输出 `cookie_store_stat_only: pass (exists, 1234 bytes)`；**无任何 cookie value 字段** |
| 5 | 多 profile 隔离 | work profile 导 cookie；切到 personal；browse_logged_in(GitHub) | personal profile 无 work 的登录态（独立 user-data-dir） |
| 6 | tab LRU | 连续 navigate 15 个 URL | Chrome 内 tab 数 = 10（最老 5 个被 close_page） |
| 7 | cookie 失效遇 2FA | import 7 天前的 cookie（GitHub session 已过期）→ browse_logged_in(GitHub) | outcome=didnt + status.note=NEEDS_MANUAL_2FA（08 §7.3 守） |

---

## 6. 验收标准（引用 09 §2.9 + 细化；标 CI vs 手测）

> 09 §2.9 原文：「cookie 持久 + 多 profile + tab LRU」。下面是文件/函数级细化。

### 6.1 cookie export/import（F3.3.9-10）
- [ ] CI：AES-256-GCM round-trip 字节级一致（cookie-store.spec.ts）
- [ ] CI：加密包文件 mode 0o600、目录 mode 0o700（invariants-v08 + 文件系统 stat 校验）
- [ ] CI：master key 不硬编码、不进 git（grep `logged-in/keychain.ts` 无字面量 key）
- [ ] CI：master key 错 → 解密抛 auth tag 错（不静默返垃圾）
- [ ] 手测 #1-#3：真 GitHub 登录态 export + 重启 import 免登 + Keychain 自动建

### 6.2 多 profile（F3.3.11 + F3.5.13 + F3.6.12）
- [ ] CI：ProfileRegistry.add/switch/list 健全；bad_name 拒（profile-registry.spec.ts）
- [ ] CI：profile 切换经 SubprocessManager.forgetSpec + registerSpec（不绕过 INV-7）
- [ ] CI：每 profile 独立 user-data-dir、独立 subprocess spec name（profile-isolation.spec.ts）
- [ ] CI：禁碰本机 Chrome 默认 user-data-dir（grep 代码无 `~/Library/Application Support/Google/Chrome` 字面量）
- [ ] 手测 #5：work/personal profile cookie 物理隔离

### 6.3 tab LRU（F3.3.12）
- [ ] CI：15 url reconcile 后 size=10、最老 5 个 close_page 调用（tab-registry.spec.ts）
- [ ] CI：MRU 提升（再触达老 url 不被淘汰）
- [ ] CI：cap clamp [1, 20]（构造 -1 → 1，构造 999 → 20）
- [ ] 手测 #6：连续 navigate 15 URL Chrome 实际 tab 数 = 10

### 6.4 隐私边界（08 §5.1 衍生）
- [ ] CI：doctor #28-#30 只 stat 不 import（invariants-v08 静态 grep + 运行时测）
- [ ] CI：doctor 输出 JSON 无 `cookies` / `value` / `session` 字段（schema 断言）
- [ ] CI：cookie export/import 必经 admin action（grep LoggedInChannel 无自动 export 调用）
- [ ] 手测 #4：doctor 输出无 cookie value

### 6.5 零回归（守 v0.7 基线）
- [ ] CI：`npm run check-invariants` 53 条全绿（v0.7 INV-1..47 一行不改）
- [ ] CI：`npm test` 通过率 100%（v0.7 1147 测试零回归）
- [ ] CI：BrowseChannel / HeadlessChannel / DesktopChannel 一行不改（git diff 守门）
- [ ] CI：Rust helper 一行不改（git diff rust-helper/ 为空）

---

## 7. 风险 + 实施顺序

### 7.1 风险 Register（v0.8 新增）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-v08-1 | master key 丢失（keychain 损坏 / env 忘） | 中 | 高（加密包永久不可解） | doctor 探测 keychain 健康度 + 文档强警告 + 备份建议（手测清单 #4-1） |
| R-v08-2 | chrome-devtools-mcp@0.3.0 不支持 `--user-data-dir` 参数 | 中 | 中 | 启动前 doctor 探测；不支持则降级为「单 profile + 警告」（v0.8 不强切多 profile） |
| R-v08-3 | CDP WebSocket 帧格式漂移（Chrome 升级） | 低 | 中 | 锁 Chrome 版本范围；doctor `cdp_version` check（#29 衍生） |
| R-v08-4 | cookie 加密包被误 commit 进 git | 低 | 高（session token 泄露） | .gitignore 加 `~/.cache/lasso/cookies/`；invariants-v08 静态守 |
| R-v08-5 | doctor 误调 import 清读 cookie | 低 | 高（违 INV-51 红线） | invariants-v08 静态 grep：doctor.ts 不得出现 `CookieStore.import` / `getKeychainKey` 调用 |
| R-v08-6 | scryptSync 参数（N=2^14）性能问题 | 低 | 低 | 2^14 ≈ 100ms / call；首次解密缓存 master key 60s in-memory（keychain.ts 模块级 cache） |
| R-v08-7 | tab id = url djb2 碰撞（不同 url 同 id） | 低 | 低（误关错 tab） | 接受（djb2 8 hex = 32 bit，<1e-9 概率）；v0.9+ 用 chrome-devtools-mcp 真实 tabId |

### 7.2 实施顺序（4 phase，每 phase 可独立交付 + 验证）

**Phase A（W1）—— 加密地基 + keychain + CookieStore + 单测**
- 新 `src/logged-in/keychain.ts`（~110 行）+ `CookieStore.ts`（~210 行）
- 单测：cookie-store.spec.ts / keychain.spec.ts（AES round-trip + mode 校验）
- INV-48（mode 0o600）/ INV-51（master key 不硬编码 + doctor 不清读）落地
- 验收：单测全绿；加密落盘 mode 0o600 invariants 守门

**Phase B（W2）—— CdpClient + LoggedInChannel.exportCookies/importCookies**
- 新 `src/logged-in/CdpClient.ts`（~140 行）
- 改 LoggedInChannel：加 exportCookies / importCookies 方法（admin action 入口）
- 单测：cdp-client.spec.ts + integration cookie-round-trip.spec.ts
- INV-52（明文 cookie 永不出现在磁盘）落地
- 验收：mock CDP 全链 round-trip 通

**Phase C（W3）—— ProfileRegistry + LoggedInChannel 多 profile 改造**
- 新 `src/logged-in/ProfileRegistry.ts`（~180 行）
- 改 LoggedInChannel：构造接 ProfileRegistry；getMcpClient 经 ensureProfileSpec
- 改 admin.ts：加 profile_list / profile_switch action
- 单测：profile-registry.spec.ts + logged-in-channel-profile.spec.ts
- INV-49（每 profile 独立 spec name + user-data-dir）落地
- 验收：mock 3 profile 切换不互相污染

**Phase D（W4）—— TabRegistry + doctor 扩 + 全链 integration + 手测清单**
- 新 `src/logged-in/TabRegistry.ts`（~150 行）
- 改 LoggedInChannel.getMcpClient 末尾调 TabRegistry.reconcile
- 改 doctor.ts：加 #28-#30 profile/cookie stat check
- 改 admin.ts：cookie_restore action 完整实装
- 单测：tab-registry.spec.ts + integration profile-isolation.spec.ts
- INV-50（tab LRU ≤10）/ INV-53（doctor stat-only）落地
- 手测清单 parse9-acceptance.md 7 条全过
- 验收：53 invariants 全绿 + 1430 TS 测试全绿 + 7 手测全过

### 7.3 回退点
- Phase A 失败 → 不影响 v0.7（新目录 logged-in/ 整体不引入；LoggedInChannel 零改）
- Phase B 失败 → 留 Phase A（keychain + CookieStore 可独立用于其他场景）
- Phase C 失败 → 留 Phase A+B（单 profile cookie 持久化可用，多 profile 推 v0.9）
- Phase D 失败 → 留 Phase A+B+C（tab LRU 推 v0.9；多 profile 已可用）

每个 phase 独立打 tag，失败可回退。

---

## 文档结束

**本文档是 Lasso v0.8 文件/函数级执行计划**（parse9，2026-07-22 产出）。F 编号严格对应 [08 §4](08-media-interact-功能架构.md)（F3.3.9-12 / F3.5.13 / F3.6.12）；阶段定位对应 [09 §2.9](09-media-interact-实施排期.md)。简单性守 02 §5.5（抽象成本）+ §6.3（review 三问）；隐私守 08 §5.1（cookie=身份）+ §7.3（v0.8 缓解）。零回归承诺 v0.7 基线（47 INV + 1147 TS + 144 Rust）。下游：parse9-acceptance.md（手测清单，待生成）+ 实施 commit 序列。

---

**附：关键文件路径（全部绝对路径）**
- 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.9
- 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §3.3 / §5.1 / §7.3 / F3.3.9-12 / F3.5.13 / F3.6.12
- 当前 LoggedInChannel：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/LoggedInChannel.ts`（133 行，构造接 SubprocessManager + cdpPort，待加 ProfileRegistry）
- 复用源：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/util/output-envelope.ts`（mode 0o600 INV-15）/ `util/state-store.ts`（LRU 128 INV-12）/ `subprocess/SubprocessManager.ts`（多 spec INV-7）
- 不变量脚本：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`（v0.7 INV-47 截止，v0.8 加 INV-48..53）
- doctor：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/doctor/doctor.ts`（1499 行，v0.7 收尾 #27；v0.8 加 #28-#30）