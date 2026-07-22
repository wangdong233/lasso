/**
 * LoggedInChannel（parse1 §3.6 + §4.2 + 附录 B + parse9 §3.2/§3.3 v0.8 改造）
 *
 * spawn `chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION> --browser-url=http://localhost:<cdpPort>`。
 * 复用本机已登录的 Chrome（用户须先用 --remote-debugging-port=9222 启动 Chrome 并
 * 完成登录含 2FA）。
 *
 * 铁律：**不解 2FA / 不自动登录 / 不导 cookie**。如果检测到登录页或 2FA 表单 →
 * outcome=didnt + error="needs_manual_2fa"（fallback 引擎识别此信号后立即终止链，
 * 不浪费下一个 channel）。
 *
 * v0.8 改造（parse9 §3.2 + §3.3）：
 *  - 构造接 ProfileRegistry + CookieStore 工厂 + TabRegistry（DI）
 *  - 按当前 profile 动态选 spec name（`logged_in:<profile>`）
 *  - 加 exportCookies() / importCookies() 方法（admin action 入口，**显式 opt-in**）
 *  - getMcpClient 末尾调 TabRegistry.reconcile（守 ≤10 hard cap；INV-50）
 *
 * INV-52 守护：自动 browse 路径（getMcpClient / browse / executeStep）**永不调**
 *              exportCookies / importCookies / CookieStore.export / CookieStore.import；
 *              仅 admin action cookie_restore 显式 opt-in 才走 cookie 路径。
 *
 * 借鉴：08 §3.3（F3.3.1-8 复用 9222 / cookie 失效 / 2FA 检测）；附录 B
 * BROWSE_LOGGED_IN_DESCRIPTION（DOES NOT solve 2FA → NEEDS_MANUAL_2FA）；
 * parse9 §3.2 + §3.3 接口签名。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { logger } from "../util/logger.js";
import { HighRiskGate } from "../browse/HighRiskGate.js";
import type { HighRiskGateLike } from "../browse/StepEngine.js";
// v0.8：profile + cookie + tab（parse9 §3）
import type { IProfileRegistry } from "../logged-in/ProfileRegistry.js";
import type { CookieStore } from "../logged-in/CookieStore.js";
import { CdpClient, type CdpCookie } from "../logged-in/CdpClient.js";
import { TabRegistry } from "../logged-in/TabRegistry.js";

/** 2FA / 登录表单关键词集（粗筛，v0.3 升级 selector-based 探测）。 */
const TWOFA_KEYWORDS = [
  "two-factor",
  "2fa",
  "two factor",
  "verification code",
  "verify it",
  "enter the code",
  "authenticator",
];

export class LoggedInChannel extends BrowseChannel {
  readonly name = "browse_logged_in";
  /** 上次 probe 后的 2FA 状态；status() 把它回写到 ChannelStatus.note。 */
  private twoFaPending = false;

  /**
   * v0.8：当前已注册的 spec name（`logged_in:<profileName>`）；null = 尚未注册任何 spec。
   *
   * INV-52 守护：构造期**不**主动 registerSpec；改在 ensureProfileSpec() 懒注册。
   * profile 切换 = forgetSpec(old) + registerSpec(new)，由本类联动 SubprocessManager。
   */
  private lastSpecName: string | null = null;

  /** v0.8：TabRegistry（INV-50：≤10 hard cap；getMcpClient 末尾 reconcile）。 */
  private readonly tabs: TabRegistry;

  /**
   * v0.8：CookieStore 工厂（按 profile 名新建实例；多 profile 隔离用）。
   *
   * 守 INV-52：自动 browse 路径 getMcpClient **不调** store.export / store.import；仅
   * exportCookies / importCookies（admin opt-in 入口）经手 CookieStore。
   */
  private readonly cookieStoreFactory: (profileName: string) => CookieStore;

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly cdpPort: number = 9222,
    /**
     * v0.8 新增（parse9 §3.2）：多 profile 注册表。
     * 必传（index.ts 装配段实例化真 ProfileRegistry + load() 后注入）。
     */
    private readonly profiles: IProfileRegistry,
    /** v0.8：CookieStore 工厂（admin.ts export/import 经手）。 */
    cookieStoreFactory: (profileName: string) => CookieStore,
    /** v0.8：tab LRU cap（生产默认 10；测试可传更小值）。 */
    tabCap?: number,
  ) {
    super();
    this.cookieStoreFactory = cookieStoreFactory;
    this.tabs = new TabRegistry(tabCap);
  }

  /**
   * v0.8：按当前 profile 注册/切换 spec（parse9 §3.2 接口签名）。
   *
   * 流程：
   *  1. 取当前 profile → spec name `logged_in:<name>`
   *  2. 若 lastSpecName === 新 name → no-op（避免重复 register）
   *  3. 否则：forgetSpec(lastSpecName)（若存在）+ registerSpec(新 name)
   *
   * 副作用：profile 切换 → forgetSpec 旧 profile 的子进程被 kill。
   * chrome-devtools-mcp@0.3.0 不接 --user-data-dir（parse9 §4.2 已知偏离）；
   * v0.8 user-data-dir 隔离由用户配 Chrome 启动参数（lasso launch-chrome --profile，
   * parse9-acceptance.md 手测清单标 pending）。
   */
  private async ensureProfileSpec(): Promise<void> {
    const p = this.profiles.getCurrent();
    const specName = `logged_in:${p.name}`;
    if (this.lastSpecName === specName) return;
    if (this.lastSpecName) {
      try {
        await this.subproc.forgetSpec(this.lastSpecName);
      } catch (e) {
        logger.warn({
          evt: "logged_in_forget_old_spec_failed",
          old_spec: this.lastSpecName,
          error: String(e),
        });
      }
    }
    this.subproc.registerSpec(specName, {
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        `--browser-url=http://localhost:${this.cdpPort}`,
      ],
      mcpClientName: `lasso-browse-logged-in-${p.name}`,
    });
    this.lastSpecName = specName;
  }

  protected async getMcpClient(): Promise<McpClient> {
    // v0.8：按当前 profile 注册/切 spec（parse9 §3.2）
    await this.ensureProfileSpec();
    const c = await this.subproc.ensureRunning(this.lastSpecName!);
    // 首次拿到 client 后探一次 2FA（不阻塞太久；失败不影响 browse，只影响 status）。
    await this._detect2FA(c);
    // v0.8：tab LRU reconcile（parse9 §3.3 + INV-50）。
    // INV-52 守护：reconcile 内部走 list_pages / close_page，不落盘 cookie；自动路径合规。
    // 失败不算致命（list_pages 偶发空响应；tab 管理是 best-effort）。
    try {
      await this.tabs.reconcile(c);
    } catch (e) {
      logger.warn({ evt: "logged_in_tab_reconcile_failed", error: String(e) });
    }
    return c;
  }

  /**
   * 简化版 2FA 探测（v0.1）：
   *  - 拿当前 tab 的 snapshot 文本，grep TWOFA_KEYWORDS。
   *  - 命中 → twoFaPending=true，后续 status().note = "NEEDS_MANUAL_2FA"。
   *  - 任何异常 → 静默（不能让 probe 阻断 browse）。
   *
   * v0.3 升级：URL pattern + 表单 selector + cookie 过期检测。
   */
  private async _detect2FA(c: McpClient): Promise<void> {
    try {
      const r = (await c.callTool("take_snapshot", {})) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (r.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .toLowerCase();
      if (!text) return;
      const hit = TWOFA_KEYWORDS.find((k) => text.includes(k));
      if (hit) {
        this.twoFaPending = true;
        logger.warn({
          evt: "logged_in_2fa_detected",
          keyword: hit,
          cdp_port: this.cdpPort,
        });
      } else {
        this.twoFaPending = false;
      }
    } catch (e) {
      // probe 失败不算致命——保留旧 twoFaPending 值。
      logger.warn({
        evt: "logged_in_2fa_probe_failed",
        error: String(e),
        cdp_port: this.cdpPort,
      });
    }
  }

  /** 重载 status：附加 NEEDS_MANUAL_2FA 标记。 */
  override async status() {
    const s = await super.status();
    if (this.twoFaPending) {
      return { ...s, note: "NEEDS_MANUAL_2FA" };
    }
    return s;
  }

  // ============================================================
  // v0.3 Phase D（parse3 §3.5）：high-risk pattern gate 注入点
  // ============================================================
  /**
   * 仅 logged_in 启用 HighRiskGate（携带身份 → 风险高，parse3 §3.5）。
   *
   * 设计：
   *  - HeadlessChannel 不重写此方法 → 走默认 null（公开页风险低 + 无身份）
   *  - gate 懒获取 McpClient（每次 assessStep 调一次，避免 channel 未起时绑定失败）
   *  - HIGH_RISK_PATTERNS 表在 HighRiskGate 模块顶级 const（INV-14 anti-gaming），
   *    不从 config / env 读
   *
   * 命中 high-risk pattern（drag-drop / RTE / tree-view / data-grid / toast）→
   * StepEngine 立即 stop("manual_abort")，不进 fallback chain。
   */
  protected override createHighRiskGate(): HighRiskGateLike | null {
    return new HighRiskGate(() => this.getMcpClient());
  }

  // ============================================================
  // v0.8：cookie export/import（admin opt-in 入口；parse9 §3.1 + §3.2 + INV-52）
  // ============================================================
  /**
   * 导出当前 profile 的 cookie（admin action `cookie_restore op=export` 入口）。
   *
   * INV-52 守护：**仅** admin action 经手此方法；browse_logged_in 自动路径
   * (getMcpClient / browse / executeStep) **永不调** exportCookies。
   *
   * 流程：
   *  1. 取当前 profile
   *  2. CdpClient.getAllCookies（裸 CDP；chrome-devtools-mcp@0.3.0 不暴露此工具）
   *  3. CookieStore.export（AES-256-GCM 加密落盘 mode 0o600；INV-48/49）
   *  4. 关 CdpClient（释放 WebSocket）
   *
   * @returns sha256 + bytes + profile（doctor 用 sha256 校验加密包完整性）
   */
  async exportCookies(): Promise<{
    sha256: string;
    bytes: number;
    profile: string;
  }> {
    const profile = this.profiles.getCurrent().name;
    const cdp = new CdpClient(this.cdpPort);
    try {
      const cookies = await cdp.getAllCookies();
      const store = this.cookieStoreFactory(profile);
      const { sha256, bytes } = await store.export(cookies);
      logger.info({
        evt: "logged_in_cookie_exported",
        profile,
        bytes,
        cookie_count: cookies.length,
      });
      return { sha256, bytes, profile };
    } finally {
      await cdp.close();
    }
  }

  /**
   * 导入 cookie 到当前 profile（admin action `cookie_restore op=import` 入口）。
   *
   * INV-52 守护：同 exportCookies，仅 admin 路径调；自动 browse 路径不调。
   *
   * 流程：
   *  1. 取当前 profile
   *  2. CookieStore.import（AES-256-GCM 解密 + **验 auth tag**；INV-48/53）
   *  3. 遍历 cookie → CdpClient.setCookie（逐条导入；失败计入 failed 不中止）
   *  4. 关 CdpClient
   *
   * @returns imported + failed + profile（部分失败不抛错）
   */
  async importCookies(): Promise<{
    imported: number;
    failed: number;
    profile: string;
  }> {
    const profile = this.profiles.getCurrent().name;
    const store = this.cookieStoreFactory(profile);
    const cookies = await store.import();
    const cdp = new CdpClient(this.cdpPort);
    let imported = 0;
    let failed = 0;
    try {
      for (const c of cookies) {
        const params = toSetCookieParams(c);
        try {
          const ok = await cdp.setCookie(params);
          ok ? imported++ : failed++;
        } catch {
          failed++;
        }
      }
      logger.info({
        evt: "logged_in_cookie_imported",
        profile,
        imported,
        failed,
        total: cookies.length,
      });
      return { imported, failed, profile };
    } finally {
      await cdp.close();
    }
  }

  // ============================================================
  // v0.8：profile 句柄 getter（admin.ts 路由用）
  // ============================================================
  /** admin.ts profile_list / profile_switch 路由用。 */
  getProfileRegistry(): IProfileRegistry {
    return this.profiles;
  }
}

// ============================================================
// helpers
// ============================================================
/**
 * CdpCookie → CdpSetCookieParams（剥 size/session；parse9 §3.1）。
 *
 * 模块级 helper（非实例方法）便于单测；同时让 LoggedInChannel 类体保持紧凑。
 */
function toSetCookieParams(c: CdpCookie): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "Secure" | "NonSecure";
  sourcePort?: number;
} {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    priority: c.priority,
    sameParty: c.sameParty,
    sourceScheme: c.sourceScheme,
    sourcePort: c.sourcePort,
  };
}
