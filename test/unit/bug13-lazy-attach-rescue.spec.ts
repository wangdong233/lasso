/**
 * bug13-lazy-attach-rescue.spec.ts（media-gen-mcp lovart 评估阻塞-1/2 +
 * bugs/13+14 审查条件 F2/F3 清偿，2026-09-23）
 *
 * 覆盖面：
 *  1. 阻塞-1：isConnectPhaseError 签名表（连接期失败识别——惰性 attach 形态
 *     的 browse 包装层路由判据；非连接错误必须 false 不污染）
 *  2. 阻塞-1/2 实施锚：LoggedInChannel 的 browse 包装 + config 热读自救链
 *     源码形态在案（源码锚范式——bug09-c5 5e 先例：回退即红）
 *  3. F2：index.ts 判显式收紧锚（Boolean(trim)——回退键存在性即毒化复活且
 *     全绿，审查变异 B 实锤的守卫补钉）
 *  4. F3：错误可诊断性文本 + doctor next_step 前缀 + descriptions 头部三锚
 *     （审查变异 C 实锤的守卫补钉）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isConnectPhaseError } from "../../src/channels/LoggedInChannel.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string): string =>
  readFileSync(`${HERE}/../../${rel}`, "utf8");

// ============================================================
// 1. isConnectPhaseError 签名表（阻塞-1 路由判据——mutation-killer）
// ============================================================
describe("isConnectPhaseError —— 连接期失败签名（阻塞-1）", () => {
  const TRUE_CASES: Array<[string, string]> = [
    // [说明, 错误串]——全部来自消费方实测形态（lovart 评估 2026-09-23）
    [
      "nav_error + 9222 /json/version HTTP Not Found（lovart 实测逐字形态）",
      'nav_error:Could not connect to Chrome http://localhost:9222/json/version: HTTP Not Found',
    ],
    [
      "裸 chrome-devtools-mcp 连接失败（spawn 期同款文案在调用期复现）",
      "Could not connect to Chrome ws endpoint",
    ],
    [
      "fetch failed 形态（marathon 形态在调用期复现）",
      "Error: http://localhost:9222/json/version: fetch failed",
    ],
    [
      "ECONNREFUSED 形态",
      "navigate failed: connect ECONNREFUSED 127.0.0.1:9222 /json/version",
    ],
  ];
  const FALSE_CASES: Array<[string, string]> = [
    ["页面 JS 错误（与连接无关）", "ReferenceError: xyz is not defined"],
    ["超时（连接已建立后的事务超时）", "mcp_request_timeout: evaluate budget exceeded"],
    ["选择器未找到", 'selector_not_found: uid @x1 expired'],
    ["站点 5xx（浏览器活着）", "net::ERR_HTTP_RESPONSE_CODE_FAILURE (500)"],
  ];

  for (const [name, msg] of TRUE_CASES) {
    it(`连接失败形态识别 → true（${name.slice(0, 22)}…）`, () => {
      expect(isConnectPhaseError(new Error(msg))).toBe(true);
      expect(isConnectPhaseError(msg)).toBe(true); // 裸串同判
    });
  }
  for (const [name, msg] of FALSE_CASES) {
    it(`非连接错误 → false（${name}）`, () => {
      expect(isConnectPhaseError(new Error(msg))).toBe(false);
    });
  }
});

// ============================================================
// 2. 阻塞-1/2 实施锚（源码形态——回退即红）
// ============================================================
describe("bugs/13+14 批实施锚（源码形态在案）", () => {
  it("阻塞-1：browse 包装层 + 重试恰一次 + 签名外零干预", () => {
    const src = read("src/channels/LoggedInChannel.ts");
    expect(src).toContain("override async browse(");
    expect(src).toContain("if (!isConnectPhaseError(e)) throw e;");
    expect(src).toContain("const rescued = await this.respawnWithConfigOrDiscovery();");
    expect(src).toContain("if (rescued === null) throw e;");
    // 重试恰一次：包装层内第二次 super.browse 之后无第三次
    const wrap = src.slice(
      src.indexOf("override async browse("),
      src.indexOf("override async browse(") + 900,
    );
    expect(wrap.match(/super\.browse\(/g)?.length).toBe(2); // 初次 + 重试恰一次
  });

  it("阻塞-2：config 热读优先于台账发现（file 键非空 + 合法 + ≠当前口 + 非 env 显式）", () => {
    const src = read("src/channels/LoggedInChannel.ts");
    expect(src).toContain("respawnWithConfigOrDiscovery");
    expect(src).toContain('this.respawnOnPort(parsed, "config_hot_reload_port")');
    expect(src).toContain("if (!this.cdpPortExplicit) {");
  });

  it("阻塞-1/2：换口体共用（respawnOnPort 单一真源）+ retrieval 双标注", () => {
    const src = read("src/channels/LoggedInChannel.ts");
    expect(src).toContain('private async respawnOnPort(');
    expect(src).toContain('"auto_discovered_port" | "config_hot_reload_port"');
    expect(src).toContain("this.noteRetrieval(`${tag}:${newPort}`)");
  });

  // ---- F2（index 判显式收紧——变异 B 实锤的守卫）----
  it("F2：index.ts 判显式 = 键在且非空（Boolean(trim)——键存在性回退即红）", () => {
    const src = read("src/index.ts");
    expect(src).toContain('Boolean((doctorServerEnv.LASSO_CDP_PORT ?? "").trim())');
    // 键存在性旧形态禁回潮
    expect(src).not.toMatch(/"LASSO_CDP_PORT" in doctorServerEnv/);
  });

  // ---- F3（可诊断性/doctor 前缀/descriptions——变异 C 实锤的守卫）----
  it("F3-①：连接失败错误附已试端口+发现状态+版本（可诊断性锚）", () => {
    const src = read("src/channels/LoggedInChannel.ts");
    expect(src).toContain("logged_in attach failed: tried port ${this.effectiveCdpPort}");
    expect(src).toContain("ledger auto-discovery disabled");
    expect(src).toContain("lasso ${LASSO_VERSION}");
  });

  it("F3-②：doctor cdp_9222 失败分支 next_step 带 BUG-13 hint 前缀", () => {
    const src = read("src/doctor/doctor.ts");
    expect(src).toContain("BUG-13 hint: browse_logged_in auto-discovers a live ledger Chrome");
    expect(src).toContain("pin a non-default instance via LASSO_CDP_PORT");
  });

  it("F3-③：descriptions 头部端口可配语义（与正文 E-1 不再矛盾）", () => {
    const src = read("src/tools/descriptions.ts");
    expect(src).toContain("override with LASSO_CDP_PORT");
    expect(src).toContain("auto-discovered from the ledger when 9222 fails");
    // 旧硬编码双行禁回潮（头部形态）
    expect(src).not.toContain('"Reuses your already-logged-in local Chrome via CDP port 9222",');
  });

  it("F1 配套：模板毒化守卫（config 模板 LASSO_CDP_PORT 禁预填数值）", () => {
    const src = read("src/config/config.ts");
    expect(src).toContain('LASSO_CDP_PORT: "",');
    // 守卫范围 = CONFIG_TEMPLATE 区段（模板字面量）——注释里的示例值（:327
    // number→String 规范化示例）不在守卫面
    const tpl = src.slice(
      src.indexOf("CONFIG_TEMPLATE"),
      src.indexOf("CONFIG_TEMPLATE") + 1600,
    );
    expect(tpl).not.toMatch(/LASSO_CDP_PORT:\s*9222/);
  });
});
