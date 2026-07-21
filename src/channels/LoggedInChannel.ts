/**
 * LoggedInChannel（parse1 §3.6 + §4.2 + 附录 B）
 *
 * spawn `chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION> --browser-url=http://localhost:<cdpPort>`。
 * 复用本机已登录的 Chrome（用户须先用 --remote-debugging-port=9222 启动 Chrome 并
 * 完成登录含 2FA）。
 *
 * 铁律：**不解 2FA / 不自动登录 / 不导 cookie**。如果检测到登录页或 2FA 表单 →
 * outcome=didnt + error="needs_manual_2fa"（fallback 引擎识别此信号后立即终止链，
 * 不浪费下一个 channel）。
 *
 * v0.1 简化：2FA 检测走「首次 ensureRunning 时 navigate 一个 about:blank + take_snapshot
 * 看页面文本」的占位；命中关键词标 status.note=NEEDS_MANUAL_2FA。v0.3 升级为
 * LoggedInChannel 自有 page-state probe（含 URL pattern + 表单 selector）。
 *
 * 借鉴：08 §3.3（F3.3.1-8 复用 9222 / cookie 失效 / 2FA 检测）；附录 B
 * BROWSE_LOGGED_IN_DESCRIPTION（DOES NOT solve 2FA → NEEDS_MANUAL_2FA）。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { logger } from "../util/logger.js";
import { HighRiskGate } from "../browse/HighRiskGate.js";
import type { HighRiskGateLike } from "../browse/StepEngine.js";

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

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly cdpPort = 9222,
  ) {
    super();
    subproc.registerSpec("logged_in", {
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        `--browser-url=http://localhost:${cdpPort}`,
      ],
      mcpClientName: "lasso-browse-logged-in",
    });
  }

  protected async getMcpClient(): Promise<McpClient> {
    const c = await this.subproc.ensureRunning("logged_in");
    // 首次拿到 client 后探一次 2FA（不阻塞太久；失败不影响 browse，只影响 status）。
    await this._detect2FA(c);
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
}
