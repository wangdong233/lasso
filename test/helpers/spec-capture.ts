/**
 * spec-capture（v1.11 round1 T1/T2 测试 helper）
 *
 * 捕获 SubprocessManager.registerSpec 调用的最小 mock——验证通道构造期注册的
 * spawn 规格（command/args）含期望 flag（--no-usage-statistics / --chromeArg / …）。
 * 不触网、不 spawn 真子进程（ensureRunning 返 stub client）。
 */
import { vi } from "vitest";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";

export interface CapturedSpec {
  command: string;
  args: string[];
  mcpClientName: string;
  env?: Record<string, string>;
}

export class LockedInSpecCapture {
  readonly specs = new Map<string, CapturedSpec>();
  readonly ensureRunningCalls: string[] = [];
  readonly subproc: object;

  constructor() {
    this.subproc = {
      registerSpec: vi.fn((name: string, spec: CapturedSpec) => {
        this.specs.set(name, spec);
      }),
      forgetSpec: vi.fn(async (name: string) => {
        this.specs.delete(name);
      }),
      ensureRunning: vi.fn(async (name: string) => {
        this.ensureRunningCalls.push(name);
        return {
          callTool: async () => ({ content: [] }),
          listTools: async () => [],
          close: async () => {},
          pid: 99999,
        } as unknown as McpClient;
      }),
      touch: vi.fn(),
      healthProbe: vi.fn(async () => "healthy" as const),
    };
  }

  /** cast 便捷方法（测试里 as unknown as SubprocessManager 的替代）。 */
  asSubprocessManager(): SubprocessManager {
    return this.subproc as unknown as SubprocessManager;
  }

  get(name: string): CapturedSpec {
    const s = this.specs.get(name);
    if (!s) {
      throw new Error(`spec not registered: ${name} (got: ${[...this.specs.keys()].join(", ")})`);
    }
    return s;
  }
}
