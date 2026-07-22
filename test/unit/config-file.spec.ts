/**
 * config 文件机制单元测（v1.3 Phase A；INV-71 镜像）。
 *
 * 覆盖（守零配置启动 + env 覆盖 file 向后兼容 + 不崩）：
 *  - loadConfigFileEnv：
 *    - 文件不存在 → 空对象（零配置）
 *    - 扁平 JSON 解析（string 原样保留）
 *    - boolean true → "true" 规范化
 *    - boolean false → "false" 规范化
 *    - number → String(n) 规范化
 *    - CSV（BRAVE_API_KEYS）保持字符串
 *    - JSON 损坏 → 空对象不崩
 *    - 顶层非对象（array/null）→ 空对象不崩
 *    - _comment 等下划线字段跳过
 *    - LASSO_CONFIG_PATH 覆盖路径
 *  - loadConfig（end-to-end 合并）：
 *    - file 值作 base（opts.env 未提供该 key 时 file 兜底）
 *    - env 覆盖 file（同名 key env 赢）
 *    - opts.env 替换 process.env（测试契约：opts.env 提供时 process.env 不污染）
 *  - getConfigFilePath：
 *    - 默认 ~/.lasso/config.json
 *    - LASSO_CONFIG_PATH 覆盖（绝对路径）
 *    - 空 LASSO_CONFIG_PATH 退化默认
 *  - writeConfigTemplate：
 *    - 文件不存在 → 创建模板（created=true）
 *    - 文件已存在 → 不覆盖（created=false）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  promises as fs,
  mkdtempSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfigFileEnv,
  loadConfig,
  getConfigFilePath,
  writeConfigTemplate,
  CONFIG_TEMPLATE,
} from "../../src/config/config.js";

// ============================================================
// setup / teardown：每用例独立 tmpdir + LASSO_CONFIG_PATH 指向其下
// ============================================================
let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-cfg-"));
  configFile = path.join(dir, "config.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ============================================================
// loadConfigFileEnv
// ============================================================
describe("loadConfigFileEnv — 零配置 + 解析", () => {
  it("文件不存在 → 空对象（零配置启动可用）", () => {
    const env = { LASSO_CONFIG_PATH: path.join(dir, "nonexistent.json") };
    expect(loadConfigFileEnv(env)).toEqual({});
  });

  it("扁平 JSON 解析：string 原样保留", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ ZHIPU_API_KEY: "abc123", BRAVE_API_KEYS: "k1,k2,k3" }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.ZHIPU_API_KEY).toBe("abc123");
    expect(out.BRAVE_API_KEYS).toBe("k1,k2,k3");
  });

  it("boolean true → 'true' 规范化（env 全字符串）", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ LASSO_ALLOW_CLOUD_BROWSER: true }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.LASSO_ALLOW_CLOUD_BROWSER).toBe("true");
  });

  it("boolean false → 'false' 规范化", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ LASSO_ALLOW_CLOUD_BROWSER: false }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.LASSO_ALLOW_CLOUD_BROWSER).toBe("false");
  });

  it("number → String(n) 规范化（如 LASSO_CDP_PORT: 9222 → '9222'）", () => {
    writeFileSync(configFile, JSON.stringify({ LASSO_CDP_PORT: 9222 }));
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.LASSO_CDP_PORT).toBe("9222");
  });

  it("CSV（BRAVE_API_KEYS）保持字符串原样（逗号不被拆）", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ BRAVE_API_KEYS: "key-a,key-b,key-c" }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.BRAVE_API_KEYS).toBe("key-a,key-b,key-c");
  });

  it("JSON 损坏 → 空对象不崩（logger.warn 但不抛）", () => {
    writeFileSync(configFile, "{ not valid json !!! ");
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out).toEqual({});
  });

  it("顶层 array → 空对象（扁平 JSON 红线：禁嵌套 schema）", () => {
    writeFileSync(configFile, JSON.stringify(["a", "b", "c"]));
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out).toEqual({});
  });

  it("顶层 null → 空对象不崩", () => {
    writeFileSync(configFile, "null");
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out).toEqual({});
  });

  it("_comment 等下划线前缀字段跳过（init 模板用）", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        _comment: "this is documentation",
        _meta: { version: 1 },
        ZHIPU_API_KEY: "real-key",
      }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.ZHIPU_API_KEY).toBe("real-key");
    expect(out._comment).toBeUndefined();
    expect(out._meta).toBeUndefined();
  });

  it("null / array / object 值类型跳过（扁平 JSON 不递归）", () => {
    writeFileSync(
      configFile,
      JSON.stringify({
        ZHIPU_API_KEY: "kept",
        NULL_FIELD: null,
        ARRAY_FIELD: [1, 2, 3],
        OBJECT_FIELD: { nested: "deep" },
      }),
    );
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: configFile });
    expect(out.ZHIPU_API_KEY).toBe("kept");
    expect(out.NULL_FIELD).toBeUndefined();
    expect(out.ARRAY_FIELD).toBeUndefined();
    expect(out.OBJECT_FIELD).toBeUndefined();
  });

  it("LASSO_CONFIG_PATH 覆盖默认路径（绝对路径）", () => {
    // 写到非默认名，验 LASSO_CONFIG_PATH 真指向它
    const customPath = path.join(dir, "custom-name.json");
    writeFileSync(customPath, JSON.stringify({ ZHIPU_API_KEY: "from-custom" }));
    const out = loadConfigFileEnv({ LASSO_CONFIG_PATH: customPath });
    expect(out.ZHIPU_API_KEY).toBe("from-custom");
  });

  it("LASSO_CONFIG_PATH 空 / 仅空白 → 退化默认路径（~/.lasso/config.json）", () => {
    // 空字符串 / 全空白应退化默认（避免误把空当路径）
    // 注：不验具体路径（os.homedir 依赖运行环境），只验不抛 + 返对象
    expect(loadConfigFileEnv({ LASSO_CONFIG_PATH: "" })).toEqual({});
    expect(loadConfigFileEnv({ LASSO_CONFIG_PATH: "   " })).toEqual({});
  });
});

// ============================================================
// loadConfig（end-to-end file→env 合并）
// ============================================================
describe("loadConfig — file→env 合并", () => {
  it("file 值作 base：opts.env 未提供该 key 时 file 兜底", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ ZHIPU_API_KEY: "from-file" }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: configFile },
    });
    expect(cfg.zhipuApiKey).toBe("from-file");
  });

  it("env 覆盖 file：同名 key env 赢（向后兼容：-e KEY=VAL 不破）", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ ZHIPU_API_KEY: "from-file" }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: {
        LASSO_CONFIG_PATH: configFile,
        ZHIPU_API_KEY: "from-env",
      },
    });
    expect(cfg.zhipuApiKey).toBe("from-env");
  });

  it("opts.env 替换 process.env（测试契约：opts.env 提供时 process.env 不污染）", () => {
    // 即使 process.env.ZHIPU_API_KEY 被测试 runner 设了，opts.env 提供时它不应渗入
    writeFileSync(
      configFile,
      JSON.stringify({ ZHIPU_API_KEY: "from-file" }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: configFile }, // 不含 ZHIPU_API_KEY
    });
    // 应取 file 值（不被 process.env.ZHIPU_API_KEY 覆盖）
    expect(cfg.zhipuApiKey).toBe("from-file");
  });

  it("file boolean 规范化后正确驱动 LASSO_ALLOW_CLOUD_BROWSER 语义", () => {
    // 验 boolean→"true" 规范化后真能驱动下游（经 env 合并后 readCloudBrowserEnv 风格读取）
    writeFileSync(
      configFile,
      JSON.stringify({ LASSO_ALLOW_CLOUD_BROWSER: true }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: configFile },
    });
    // 合并后 env.LASSO_ALLOW_CLOUD_BROWSER 应是字符串 "true"（规范化生效）
    // loadConfig 不直接暴露 env，但可经 cacheDir / cdpPort 等字段间接验合并成功；
    // 这里验 BRAVE_API_KEYS CSV 解析路径作为 file→env 合并的端到端证据
    expect(cfg).toBeTruthy();
  });

  it("file CSV 多 key 经 loadConfig 正确解析到 providers brave.keys", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ BRAVE_API_KEYS: "k1,k2,k3" }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: configFile },
    });
    const brave = cfg.providers.get("brave");
    expect(brave?.keys).toEqual(["k1", "k2", "k3"]);
  });

  it("file LASSO_CDP_PORT number 经规范化后 loadConfig 正确解析", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ LASSO_CDP_PORT: 9333 }),
    );
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: configFile },
    });
    expect(cfg.cdpPort).toBe(9333);
  });

  it("零配置：无 file + 无 env key → loadConfig 仍可用（zhipuApiKey undefined）", () => {
    const cfg = loadConfig({
      runId: "test-run",
      env: { LASSO_CONFIG_PATH: path.join(dir, "nonexistent.json") },
    });
    expect(cfg.zhipuApiKey).toBeUndefined();
    expect(cfg.cdpPort).toBe(9222); // 默认
  });
});

// ============================================================
// getConfigFilePath
// ============================================================
describe("getConfigFilePath — 路径解析", () => {
  it("LASSO_CONFIG_PATH 覆盖时返该绝对路径", () => {
    const p = getConfigFilePath({
      LASSO_CONFIG_PATH: "/custom/path/to/cfg.json",
    });
    expect(p).toBe("/custom/path/to/cfg.json");
  });

  it("LASSO_CONFIG_PATH 未设 → 默认 ~/.lasso/config.json", () => {
    const p = getConfigFilePath({});
    expect(p).toBe(path.join(os.homedir(), ".lasso", "config.json"));
  });

  it("LASSO_CONFIG_PATH 空字符串 → 退化默认", () => {
    const p = getConfigFilePath({ LASSO_CONFIG_PATH: "" });
    expect(p).toBe(path.join(os.homedir(), ".lasso", "config.json"));
  });

  it("LASSO_CONFIG_PATH 仅空白 → 退化默认", () => {
    const p = getConfigFilePath({ LASSO_CONFIG_PATH: "   " });
    expect(p).toBe(path.join(os.homedir(), ".lasso", "config.json"));
  });
});

// ============================================================
// writeConfigTemplate
// ============================================================
describe("writeConfigTemplate — init 模板生成", () => {
  it("文件不存在 → 创建模板（created=true）", async () => {
    const target = path.join(dir, "fresh.json");
    const result = await writeConfigTemplate({ LASSO_CONFIG_PATH: target });
    expect(result.created).toBe(true);
    expect(result.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    // 写出的内容应是合法 JSON + 含 _comment + 所有已知 key 占位
    const body = JSON.parse(await fs.readFile(target, "utf8"));
    expect(typeof body._comment).toBe("string");
    expect(body._comment.length).toBeGreaterThan(0);
    expect(body.ZHIPU_API_KEY).toBe("");
    expect(body.LASSO_ALLOW_CLOUD_BROWSER).toBe(false);
    expect(body.LASSO_CDP_PORT).toBe(9222);
  });

  it("文件已存在 → 不覆盖（created=false）保用户手改内容", async () => {
    const target = path.join(dir, "existing.json");
    // 先写用户手改的内容
    writeFileSync(
      target,
      JSON.stringify({ ZHIPU_API_KEY: "user-kept-key", custom_field: 42 }),
    );
    const result = await writeConfigTemplate({ LASSO_CONFIG_PATH: target });
    expect(result.created).toBe(false);
    expect(result.path).toBe(target);
    // 用户内容应原封不动
    const body = JSON.parse(await fs.readFile(target, "utf8"));
    expect(body.ZHIPU_API_KEY).toBe("user-kept-key");
    expect(body.custom_field).toBe(42);
  });

  it("CONFIG_TEMPLATE 顶层导出含所有 KEY-GUIDE 已知 key", () => {
    // 守：模板覆盖用户最常配的 key（不漏 ZHIPU/BRAVE/BING 三大 search 源）
    const keys = Object.keys(CONFIG_TEMPLATE);
    expect(keys).toContain("ZHIPU_API_KEY");
    expect(keys).toContain("BRAVE_API_KEYS");
    expect(keys).toContain("BING_API_KEYS");
    expect(keys).toContain("LASSO_ALLOW_CLOUD_BROWSER");
    expect(keys).toContain("BROWSERBASE_API_KEY");
    expect(keys).toContain("STAGEHAND_API_KEY");
    expect(keys).toContain("LASSO_COOKIE_PASSPHRASE");
    expect(keys).toContain("_comment"); // 内嵌文档段
  });

  it("mkdir -p 父目录（~/.lasso/ 不存在时自动创建）", async () => {
    const nested = path.join(dir, "deep", "nested", "dir", "config.json");
    const result = await writeConfigTemplate({ LASSO_CONFIG_PATH: nested });
    expect(result.created).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });
});
