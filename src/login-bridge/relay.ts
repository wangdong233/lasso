/**
 * relay.ts（v1.31 登录接力档）——哑 TCP 转发（方案 §二 C2）
 *
 * 设计定谳（F2 反方裁决，doc/方案-login_bridge §一）：Chrome /json/* 的 ws URL
 * 从请求 Host 头生成——**哑字节透传**使 discovery 页/ws 全链自洽（Chrome 直接看到
 * `ip:relay端口` 的 Host，生成的 ws URL 自动指回同一条管道）；任何「聪明」的中继
 * （token 剥离/Host 改写）都会撞结构性矛盾。本模块刻意不解析 HTTP。
 *
 * 生命周期：独立于 Chrome；「活跃 TCP 连接=活着」；无连接且超 idleMs → 自关。
 * lasso 首个入站监听（posture 变化）——只在 login_bridge start 后存在。
 *
 * INV-64 精神：只 import node:* 内置。
 */
import * as Net from "node:net";

export interface LoginRelayState {
  active: boolean;
  /** 当前活跃 TCP 连接数（client↔relay↔cdp 对计 1）。 */
  connections: number;
  host: string;
  port: number;
  cdpPort: number;
  /** 最近一次连接建立/数据时刻（epoch ms）。 */
  lastActivityAt: number;
}

export interface LoginRelayHandle {
  state(): LoginRelayState;
  stop(): Promise<void>;
}

export interface LoginRelayOptions {
  /** 绑定地址（resolveBridgeHost 的产物；显式 env 可为 0.0.0.0——用户自担）。 */
  host: string;
  port: number;
  /** 转发目标（Chrome CDP，恒 127.0.0.1）。 */
  cdpPort: number;
  /** 空闲自关阈值（默认 loginRelayIdleMs()；≤0=不自关）。 */
  idleMs?: number;
  /** 空闲检查周期（默认 15s；测试可调小）。 */
  checkIntervalMs?: number;
  /** DI：net 模块面（测试注入桩）。 */
  net?: Pick<typeof Net, "createServer" | "connect">;
  nowFn?: () => number;
  /** 空闲自关回调（工具层清 bridge state 用）。 */
  onIdleClose?: () => void;
}

export interface LoginRelayError {
  code: "login_relay_port_in_use" | "login_relay_bind_failed";
  message: string;
}

/**
 * 创建哑 TCP 转发（listen 失败 reject LoginRelayError——EADDRINUSE 给可教学错误）。
 * 每个入连接：连 127.0.0.1:cdpPort，双向 pipe；任一侧断开即双侧销毁。
 */
export function createLoginRelay(opts: LoginRelayOptions): Promise<LoginRelayHandle> {
  const net = opts.net ?? Net;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const idleMs = opts.idleMs ?? 600_000;
  const checkIntervalMs = opts.checkIntervalMs ?? 15_000;
  let lastActivityAt = nowFn();
  let active = true;
  const sockets = new Set<Net.Socket>();
  let timer: NodeJS.Timeout | null = null;

  return new Promise<LoginRelayHandle>((resolve, reject) => {
    const server = net.createServer((client: Net.Socket) => {
      lastActivityAt = nowFn();
      const upstream = net.connect(opts.cdpPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      const teardown = () => {
        for (const s of [client, upstream]) {
          try {
            s.destroy();
          } catch {
            /* best-effort */
          }
          sockets.delete(s);
        }
      };
      client.on("data", () => {
        lastActivityAt = nowFn();
      });
      upstream.on("data", () => {
        lastActivityAt = nowFn();
      });
      client.on("error", teardown);
      upstream.on("error", teardown);
      client.on("close", teardown);
      upstream.on("close", teardown);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      const code = err.code === "EADDRINUSE" ? "login_relay_port_in_use" : "login_relay_bind_failed";
      reject({
        code,
        message:
          code === "login_relay_port_in_use"
            ? `login_relay_port_in_use: port ${opts.port} occupied — set LASSO_LOGIN_BRIDGE_PORT to a free port`
            : `login_relay_bind_failed:${String(err.message).slice(0, 120)}`,
      });
    });

    server.listen(opts.port, opts.host, () => {
      // 空闲自关：无连接 && 距最近活动超阈值（timer 只在「无连接」时判超时）
      if (idleMs > 0) {
        timer = setInterval(() => {
          if (!active) return;
          const idleFor = nowFn() - lastActivityAt;
          const noConnections = sockets.size === 0;
          if (noConnections && idleFor > idleMs) {
            shutdown().catch(() => {});
          }
        }, checkIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      resolve(handle);
    });

    async function shutdown(): Promise<void> {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* best-effort */
        }
      }
      sockets.clear();
      await new Promise<void>((r) => {
        try {
          server.close(() => r());
        } catch {
          r();
        }
      });
      opts.onIdleClose?.();
    }

    const handle: LoginRelayHandle = {
      state(): LoginRelayState {
        return {
          active,
          connections: sockets.size,
          host: opts.host,
          port: opts.port,
          cdpPort: opts.cdpPort,
          lastActivityAt,
        };
      },
      stop: shutdown,
    };
  });
}
