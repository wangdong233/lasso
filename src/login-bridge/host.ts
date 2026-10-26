/**
 * host.ts（v1.31 登录接力档）——relay 绑定地址与 allow-origins 推导（方案 §二 C3）
 *
 * 解析序（用户裁决「不过多限制、内网灵活可用」2026-10-17）：
 *  1. env LASSO_LOGIN_BRIDGE_HOST 显式 → 原样使用（含 0.0.0.0=全接口，用户自担——
 *     内网部署形态合法化）
 *  2. `tailscale ip -4`（darwin 无 PATH CLI 时退 /Applications/Tailscale.app 二进制）
 *     → 取 100.64.0.0/10 CGNAT 段内首个 IPv4
 *  3. 兜底：os.networkInterfaces 第一个私网 IPv4（en0/eth0 序），source="interface"
 *     如实标注（不静默冒充 tailscale）
 *
 * allow-origins（N2 结构性事实）：Chrome WS Origin 比对服务端绑定端点，浏览器侧
 * 链路必须 `--remote-allow-origins=http://<host>:<relayPort>` 精确字面量；host 为
 * 0.0.0.0 时无法预知来源 IP → 枚举全部接口 IPv4 逐一生成（Chrome 逗号分隔多值）。
 *
 * Host 头校验反直觉面（调研 §二-2）：IP 字面量放行、域名拒绝——本模块只产 IP，
 * 恒落放行侧；MagicDNS 主机名刻意不用。
 *
 * INV-64 精神：只 import node:* 内置。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import process from "node:process";

/** bootstrap.ts:29 同款先例（P31 形态：server 可达路径异步 execFile）。 */
const execFileP = promisify(execFile);

export interface BridgeHostResolution {
  host: string;
  /** `http://<host>:<relayPort>`（allow-origins 主值）。 */
  origin: string;
  /** allow-origins 全集（host=0.0.0.0 时=全接口 origins；否则 [origin]）。 */
  allowOrigins: string[];
  source: "env" | "tailscale" | "interface";
}

export interface ResolveBridgeHostOptions {
  relayPort: number;
  /** DI：env 读取（默认 process.env）。 */
  env?: Record<string, string | undefined>;
  /** DI：CLI 执行器（默认异步 execFile——P31 移交2，2026-10-26；测试注入桩，
   * 返回 Promise 或裸结果均可——launch-chrome.ts:153 P31 先例同款联合形态）。 */
  runFn?: (
    cmd: string,
    args: string[],
  ) => { status: number | null; stdout: string } | Promise<{ status: number | null; stdout: string }>;
  /** DI：网卡枚举（默认 os.networkInterfaces）。 */
  interfacesFn?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

/** tailscale CGNAT 段判定（100.64.0.0/10：第二字节 64-127）。 */
export function isTailscaleCgnatIPv4(ip: string): boolean {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip.trim());
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** 解析 `tailscale ip -4` 输出（纯函数）——取首个 CGNAT 段 IPv4。 */
export function parseTailscaleIps(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => isTailscaleCgnatIPv4(l));
}

/** 私网 IPv4（10/8、172.16/12、192.168/16）——interface 兜底与 0.0.0.0 origins 枚举用。 */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** P31 移交2（2026-10-26）：spawnSync → 异步 execFile（login_bridge start 与
 * doctor #43 双 server 路径可达，3s 同步冻结事件循环）。catch 映射 status:null
 * ——ENOENT/超时/非零退出统一走「本二进制 miss」语义，保 Tailscale.app 退路
 * 循环（审查 A3-D3）；killSignal 对齐 bootstrap.ts P31 家族先例。 */
async function defaultRunFn(
  cmd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string }> {
  try {
    const r = await execFileP(cmd, args, {
      encoding: "utf8",
      timeout: 3_000,
      killSignal: "SIGKILL",
    });
    return { status: 0, stdout: r.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}

function interfaceIpv4s(interfacesFn: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  const ifaces = interfacesFn();
  // 接口序稳定化（en0/eth0 先——对象键序在实践中已是插入序，再按名排序保确定）
  for (const name of Object.keys(ifaces).sort()) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && isPrivateIPv4(info.address)) out.push(info.address);
    }
  }
  return [...new Set(out)];
}

/**
 * 解析 relay 绑定地址（三序；全 miss 返回 null——调用方给可教学错误）。
 * 恒不返回 0.0.0.0 除非 env 显式（INV 红线：默认面永不全接口）。
 */
export async function resolveBridgeHost(
  opts: ResolveBridgeHostOptions,
): Promise<BridgeHostResolution | null> {
  const env = opts.env ?? process.env;
  const runFn = opts.runFn ?? defaultRunFn;
  const interfacesFn = opts.interfacesFn ?? (() => os.networkInterfaces());
  const make = (host: string, source: BridgeHostResolution["source"]): BridgeHostResolution => {
    const origin = `http://${host}:${opts.relayPort}`;
    const allowOrigins =
      host === "0.0.0.0"
        ? interfaceIpv4s(interfacesFn).map((ip) => `http://${ip}:${opts.relayPort}`)
        : [origin];
    return { host, origin, allowOrigins, source };
  };

  // 1. env 显式（含 0.0.0.0 合法化——内网部署形态，用户自担）
  const explicit = (env.LASSO_LOGIN_BRIDGE_HOST ?? "").trim();
  if (explicit !== "") {
    return make(explicit, "env");
  }

  // 2. tailscale CLI（darwin GUI 装机无 PATH CLI → app 二进制退路）
  const tsBinaries = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of tsBinaries) {
    const r = await runFn(bin, ["ip", "-4"]);
    if (r.status === 0) {
      const ips = parseTailscaleIps(r.stdout);
      if (ips.length > 0) return make(ips[0], "tailscale");
    }
  }

  // 3. 接口兜底（如实标注 source；不静默冒充 tailscale）
  const lanIps = interfaceIpv4s(interfacesFn);
  if (lanIps.length > 0) {
    return make(lanIps[0], "interface");
  }

  return null;
}
