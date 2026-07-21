/**
 * CIDR 工具（parse1 §3.10 cidr.ts）
 *
 * 用 `ip-cidr` 包做包含判定。ip-cidr v4 的 IPCIDR 构造器对非法 CIDR 字符串
 * 会抛 `Invalid CIDR address.`，且没有实例级 `isValid()` 方法——所以这里用
 * try/catch 包住，构造失败一律返回 false，对外保持 boolean 语义。
 *
 * 跨族判定（v4 CIDR vs v6 IP）由 ip-cidr 内部处理，返回 false（见实测）。
 */
import IPCIDR from "ip-cidr";
import { isIP } from "node:net";
import { PRIVATE_RANGES } from "./defaults.js";

/**
 * 判定 `ip` 是否落在 `cidr` 内。
 *  - 非法 IP（node:net.isIP 返回 0）→ false
 *  - 非法 CIDR（构造抛错）       → false
 *  - IP 族与 CIDR 族不匹配      → false（ip-cidr 自身行为）
 */
export function cidrContains(cidr: string, ip: string): boolean {
  if (isIP(ip) === 0) return false;
  try {
    const c = new IPCIDR(cidr);
    return c.contains(ip);
  } catch {
    return false;
  }
}

/**
 * 判定 `ip` 是否落在任一私网/保留段。
 * 默认对照 PRIVATE_RANGES，可传入自定义表（单测用）。
 */
export function isPrivateIp(
  ip: string,
  privateRanges: readonly string[] = PRIVATE_RANGES,
): boolean {
  return privateRanges.some((cidr) => cidrContains(cidr, ip));
}
