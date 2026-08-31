/**
 * 工具描述反泄漏守卫（P2 处置轮新增，archA 路发现）
 *
 * 背景：fetch_url 描述曾写「SubprocessManager.acquireHttpClient」——内部类名+
 * 方法名进入 CC 可见的工具描述（R-DEP-05 字面命中：>0 跨边界泄漏）。review-r1
 * 池迁 util/http-pool 后残留的是内部模块路径「util/http-pool acquireHttpClient」。
 *
 * 守卫面（机械可判，防回潮）：
 *  1. FETCH_URL_DESCRIPTION / NETWORK_DESCRIPTION 不含内部实现锚
 *     （src/ 路径片段、acquireHttpClient 类/函数名）；
 *  2. network include_bodies 口径三方一致（schema/描述/头注释同说「值被忽略」——
 *     cdp-actions.ts doNetwork 白盒结论为单一真源）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { FETCH_URL_DESCRIPTION, NETWORK_DESCRIPTION } from "../../src/tools/descriptions.js";

const INTERNAL_LEAK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /acquireHttpClient/, label: "内部池函数名 acquireHttpClient" },
  { re: /SubprocessManager/, label: "内部类名 SubprocessManager" },
  { re: /src\/[a-z-]+\//, label: "src/ 内部模块路径" },
  { re: /util\/http-pool/, label: "内部模块路径 util/http-pool" },
];

describe("工具描述反泄漏（R-DEP-05；P2 处置轮守卫）", () => {
  it("FETCH_URL_DESCRIPTION 零内部实现锚（类名/函数名/模块路径）", () => {
    const text: string = FETCH_URL_DESCRIPTION; // 模块导出即 join("\n") 后的字符串
    for (const { re, label } of INTERNAL_LEAK_PATTERNS) {
      expect(text, `不得泄漏 ${label}`).not.toMatch(re);
    }
    // 语义保留：keep-alive 池的对外表述仍在（不牺牲信息量）
    expect(text).toMatch(/keep-alive/);
  });

  it("NETWORK_DESCRIPTION include_bodies 口径 = 值被忽略（与 cdp-actions doNetwork 单一真源一致）", () => {
    const text: string = NETWORK_DESCRIPTION;
    expect(text).toMatch(/include_bodies[^]*?value is ignored/);
    // 过时的「推 v0.6 实装」承诺与误导性的「detail via upstream tool」清除
    expect(text).not.toMatch(/detail via upstream tool/);
    expect(text).not.toMatch(/推 v0\.6/);
  });

  it("network.ts 头注释口径同步（三方一致：schema 转发 + 描述 + 注释）", () => {
    const src = readFileSync("src/tools/network.ts", "utf8");
    expect(src).toMatch(/include_bodies 接受但值被忽略/);
    expect(src).not.toMatch(/include_bodies 接受但不实装/);
  });
});
