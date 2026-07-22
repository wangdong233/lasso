/**
 * CdpClient.ts（v0.8 parse9 §3.1）—— 极简 CDP-over-WebSocket 客户端
 *
 * 设计（parse9 §4.4 决策）：chrome-devtools-mcp@0.3.0 不暴露
 * `Network.getAllCookies` / `Network.setCookie`（不在其工具表），且
 * `evaluate_script` 跑在 page context 无法调 CDP `Network.*` 域。
 * 故 v0.8 cookie 操作走裸 CDP WebSocket 直连 :9222，本类只 3 个方法，
 * 不抽象第二层 MCP 子进程。
 *
 * 连接流程：
 *   1. GET http://localhost:<cdpPort>/json/version → webSocketDebuggerUrl
 *   2. new WebSocket(url)
 *   3. 帧格式：发 `{id, method, params}` / 收 `{id, result|error}`
 *
 * INV-7 衍生：本类**不渗** SubprocessManager —— CdpClient 是「向 Chrome 进程
 * 发 CDP 帧」的协议客户端，与 SubprocessManager（MCP 子进程 lifecycle）并列，
 * 不共享 spec 表。本类不读 JSON-RPC content-length 帧解析（那是 SDK transport 责任）。
 *
 * 借鉴：parse9 §3.1 接口签名 + CDP 官方 spec
 * （https://chromedevtools.github.io/devtools-protocol/tot/Network/）。
 */
import { WebSocket } from "undici";
import { logger } from "../util/logger.js";

// ============================================================
// CDP cookie 类型（CDP Network.getAllCookies 返回形状）
// ============================================================
/**
 * CDP Network.Cookie 形状（CDP spec 官方；含 httpOnly / secure / session 等）。
 *
 * 用于 CookieStore.export(cookies) 入参 + getAllCookies() 返参。
 */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "Secure" | "NonSecure";
  sourcePort?: number;
}

/**
 * CDP Network.setCookie 入参形状（CDP spec 官方）。
 *
 * 与 CdpCookie 区别：setCookie 不接受 size/session（Chrome 自算）。
 */
export type CdpSetCookieParams = Omit<CdpCookie, "size" | "session">;

// ============================================================
// CdpClient
// ============================================================
/**
 * 极简 CDP 客户端（3 个公开方法 + connect）。
 *
 * 使用：
 *   const cdp = new CdpClient(9222);
 *   const cookies = await cdp.getAllCookies();
 *   await cdp.setCookie({ name, value, domain, ... });
 *   await cdp.close();
 */
export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly cdpPort = 9222) {}

  // ============================================================
  // 连接（懒 + 复用）
  // ============================================================
  private async connect(): Promise<void> {
    if (this.ws) return;
    // 1. /json/version → webSocketDebuggerUrl
    const r = await fetch(`http://localhost:${this.cdpPort}/json/version`);
    if (!r.ok) throw new Error(`cdp_version_fetch_failed:${r.status}`);
    const info = (await r.json()) as { webSocketDebuggerUrl?: string };
    const url = info.webSocketDebuggerUrl;
    if (!url) throw new Error("cdp_no_websocket_url");
    // 2. WebSocket 连接
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (ev) => {
      // undici MessageEvent<any> 与 DOM lib MessageEvent 形状不同但 data 字段一致；
      // 用 { data: unknown } 形状读取避开类型冲突
      this.onMessage(ev as unknown as { data: unknown });
    });
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("cdp_ws_missing"));
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (err) =>
        reject(new Error(`cdp_ws_connect_failed:${String(err)}`)),
      );
    });
    logger.info({ evt: "cdp_connected", port: this.cdpPort });
  }

  /** 解析 CDP 帧 → pending Map dispatch。 */
  private onMessage(ev: { data: unknown }): void {
    try {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      const msg = JSON.parse(data) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`cdp_error:${JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
    } catch (e) {
      logger.warn({ evt: "cdp_parse_failed", error: String(e) });
    }
  }

  // ============================================================
  // 公开方法（parse9 §3.1）
  // ============================================================
  /** CDP Network.getAllCookies —— 返所有 cookie（含 httpOnly）。 */
  async getAllCookies(): Promise<CdpCookie[]> {
    await this.connect();
    const r = (await this.send("Network.getAllCookies", {})) as { cookies?: CdpCookie[] };
    return r.cookies ?? [];
  }

  /** CDP Network.setCookie —— 单条导入（参数对齐 CDP spec）。 */
  async setCookie(params: CdpSetCookieParams): Promise<boolean> {
    await this.connect();
    const r = (await this.send("Network.setCookie", params as unknown as Record<string, unknown>)) as {
      success?: boolean;
    };
    return r.success === true;
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    // 清残留 pending（防 mem leak；reject 让调用方知道中断）
    for (const [, p] of this.pending) p.reject(new Error("cdp_closed"));
    this.pending.clear();
  }

  // ============================================================
  // 内部
  // ============================================================
  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws) return reject(new Error("cdp_not_connected"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(new Error(`cdp_send_failed:${String(e)}`));
      }
    });
  }
}
