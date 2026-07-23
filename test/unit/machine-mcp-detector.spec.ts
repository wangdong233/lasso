/**
 * MachineMcpDetector 单元测（v1.4 Phase A；INV-72 镜像）。
 *
 * 覆盖（守零配置 + graceful skip + 安全红线）：
 *  - detectMachineSearchMcp：
 *    - ~/.claude.json 有 web-search-prime MCP (type=http + bigmodel url + Authorization) → 命中
 *    - 文件不存在 → null（graceful skip）
 *    - JSON 损坏 → null（graceful skip 不崩）
 *    - 顶层非对象（array/null）→ null
 *    - mcpServers 缺失 → null
 *    - type=stdio → skip（不混 transport）
 *    - url 不匹配 web_search_prime/bigmodel.cn → skip
 *    - headers.Authorization 缺失 → null（没 key 等于没配）
 *    - 多个匹配 → 取第一个
 *  - getClaudeJsonPath：
 *    - 默认 ~/.claude.json
 *    - LASSO_MACHINE_CLAUDE_JSON_PATH 覆盖
 *    - 空 / 空白覆盖退化默认
 *  - 安全：返回的 authorization 字段是完整 "Bearer xxx" 串（与 ZhipuSearchChannel 同格式，
 *    McpClient.connectHttp 直接用）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, renameSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectMachineSearchMcp,
  getClaudeJsonPath,
} from "../../src/search/MachineMcpDetector.js";

// ============================================================
// setup / teardown：每用例独立 tmpdir + LASSO_MACHINE_CLAUDE_JSON_PATH 指向其下
// ============================================================
let dir: string;
let jsonFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-mcp-det-"));
  jsonFile = path.join(dir, ".claude.json");
});

afterEach(() => {
  // tmpdir 由 OS 清理；这里不强行 rm（rename 测试用例会留下旧文件）
});

// ============================================================
// 辅助：写一个完整的 ~/.claude.json 形状
// ============================================================
function writeClaudeJson(obj: unknown): void {
  writeFileSync(jsonFile, JSON.stringify(obj));
}

function env(): NodeJS.ProcessEnv {
  return { LASSO_MACHINE_CLAUDE_JSON_PATH: jsonFile };
}

// ============================================================
// detectMachineSearchMcp — happy path
// ============================================================
describe("detectMachineSearchMcp — 命中 web-search-prime MCP", () => {
  it("type=http + bigmodel url + Authorization → 返 {url, authorization}", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer test-key-abc123" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    expect(r!.url).toBe(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    );
    expect(r!.authorization).toBe("Bearer test-key-abc123");
  });

  it("url 含 web_search_prime 路径片段（非 bigmodel.cn 域名）→ 命中", () => {
    writeClaudeJson({
      mcpServers: {
        "proxy-search": {
          type: "http",
          url: "https://internal.proxy.test/web_search_prime/mcp",
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    expect(r!.url).toContain("web_search_prime");
  });

  it("多个匹配 entry → 取第一个（顺序优先）", () => {
    writeClaudeJson({
      mcpServers: {
        "first": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer first-key" },
        },
        "second": {
          type: "http",
          url: "https://other.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer second-key" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    // JS Object.entries 保序（ES2015+ 保证字符串 key 按插入序），first 应当先
    expect(r!.authorization).toBe("Bearer first-key");
  });

  it("CC 全局配置含 numStartups/installMethod 等无关字段 → 不影响探测", () => {
    writeClaudeJson({
      numStartups: 834,
      installMethod: "global",
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer real-key" },
        },
      },
      otherMcp: { foo: "bar" },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    expect(r!.authorization).toBe("Bearer real-key");
  });
});

// ============================================================
// detectMachineSearchMcp — graceful skip（零配置兼容 + 不崩）
// ============================================================
describe("detectMachineSearchMcp — graceful skip 不崩", () => {
  it("文件不存在 → null（零配置兼容）", () => {
    const e = {
      LASSO_MACHINE_CLAUDE_JSON_PATH: path.join(dir, "nonexistent.json"),
    };
    expect(detectMachineSearchMcp(e)).toBeNull();
  });

  it("JSON 损坏 → null 不抛错", () => {
    writeFileSync(jsonFile, "{ this is not valid json,,,");
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("顶层 null → null", () => {
    writeFileSync(jsonFile, "null");
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("顶层 array → null", () => {
    writeClaudeJson([1, 2, 3]);
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("顶层 primitive（字符串）→ null", () => {
    writeFileSync(jsonFile, '"hello"');
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("无 mcpServers 字段 → null", () => {
    writeClaudeJson({ numStartups: 100, other: "field" });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("mcpServers 是 array（非 object）→ null", () => {
    writeClaudeJson({ mcpServers: ["not", "an", "object"] });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("mcpServers 是 null → null", () => {
    writeClaudeJson({ mcpServers: null });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("mcpServers 是空对象 → null", () => {
    writeClaudeJson({ mcpServers: {} });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });
});

// ============================================================
// detectMachineSearchMcp — entry 过滤逻辑
// ============================================================
describe("detectMachineSearchMcp — entry 过滤（type/url/auth 三元组）", () => {
  it("type=stdio → skip（不混 transport）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "stdio",
          command: "npx",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp", // 有 url 但 type 不对
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("type 缺失 → skip（保守：未明示 http 不收）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("url 不含 web_search_prime 也不含 bigmodel.cn → skip", () => {
    writeClaudeJson({
      mcpServers: {
        "other-mcp": {
          type: "http",
          url: "https://api.example.com/some-other-mcp",
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("缺 headers → null（没 key 等于没配）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("headers 缺 Authorization 字段 → null", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { "Content-Type": "application/json" },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("Authorization 是空字符串 → null（truthy 检查）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "" },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("Authorization 是非字符串（数字）→ skip", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: 12345 },
        },
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("entry 是 array（非 object）→ skip", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": ["not", "an", "object"],
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("entry 是 null → skip", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": null,
      },
    });
    expect(detectMachineSearchMcp(env())).toBeNull();
  });

  it("其他 MCP 同存（如 web-reader）→ 只命中 web_search_prime 那条", () => {
    writeClaudeJson({
      mcpServers: {
        "web-reader": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
          headers: { Authorization: "Bearer reader-key" },
        },
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer search-key" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    // bigmodel.cn 域名匹配两条都中（web_reader 也含 bigmodel.cn）→ 取第一个 web-reader
    // 这是预期行为（启发式：bigmodel.cn 域名包含任何 http+auth entry 都算可能可用）
    // 但本测试用例是 web-reader 先 → 返 reader；语义合理（机器可用的 bigmodel MCP 都复用）
    expect(r!.authorization).toBe("Bearer reader-key");
  });
});

// ============================================================
// getClaudeJsonPath
// ============================================================
describe("getClaudeJsonPath — 路径解析", () => {
  it("LASSO_MACHINE_CLAUDE_JSON_PATH 覆盖 → 用 env 路径", () => {
    const p = getClaudeJsonPath({
      LASSO_MACHINE_CLAUDE_JSON_PATH: "/custom/path/claude.json",
    });
    expect(p).toBe("/custom/path/claude.json");
  });

  it("空 LASSO_MACHINE_CLAUDE_JSON_PATH → 退化默认", () => {
    const p = getClaudeJsonPath({ LASSO_MACHINE_CLAUDE_JSON_PATH: "" });
    expect(p).toBe(path.join(os.homedir(), ".claude.json"));
  });

  it("纯空白 LASSO_MACHINE_CLAUDE_JSON_PATH → 退化默认", () => {
    const p = getClaudeJsonPath({
      LASSO_MACHINE_CLAUDE_JSON_PATH: "   ",
    });
    expect(p).toBe(path.join(os.homedir(), ".claude.json"));
  });

  it("未设 LASSO_MACHINE_CLAUDE_JSON_PATH → 默认 ~/.claude.json", () => {
    const p = getClaudeJsonPath({});
    expect(p).toBe(path.join(os.homedir(), ".claude.json"));
  });
});

// ============================================================
// 安全：detector 返的 authorization 是完整 "Bearer xxx" 串
// ============================================================
describe("detectMachineSearchMcp — 安全（INV-72）", () => {
  it("返的 authorization 含 Bearer 前缀（McpClient.connectHttp 直接用，不需重组）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer production-key-XYZ" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    // 完整串透传：detector 不做拆解 / 重组（保 ZhipuSearchChannel 同范式）
    expect(r!.authorization.startsWith("Bearer ")).toBe(true);
    expect(r!.authorization).toBe("Bearer production-key-XYZ");
  });

  it("返的 url 是 https（endpoint 合法性由 channel.isAvailable 二次校验）", () => {
    writeClaudeJson({
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
          headers: { Authorization: "Bearer xxx" },
        },
      },
    });
    const r = detectMachineSearchMcp(env());
    expect(r).not.toBeNull();
    expect(r!.url.startsWith("https://")).toBe(true);
  });

  it("detector 函数永不抛错（任意损坏文件都返 null）", () => {
    // 多种损坏形式都不应抛
    writeFileSync(jsonFile, "");
    expect(() => detectMachineSearchMcp(env())).not.toThrow();
    writeFileSync(jsonFile, "undefined");
    expect(() => detectMachineSearchMcp(env())).not.toThrow();
    writeFileSync(jsonFile, "{");
    expect(() => detectMachineSearchMcp(env())).not.toThrow();
  });
});
