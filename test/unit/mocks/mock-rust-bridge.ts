/**
 * Mock RustBridge（parse4 §5.3 mock AX 策略）
 *
 * 用 scripts Record<method, fn> 注册每个 method 的应答脚本；
 * AxProvider / ScreenshotVlmProvider / 后续 DesktopChannel 测试用本 mock，
 * 不拉真 Rust helper 进程。
 *
 * 设计：与 RustBridge 同 method surface（call + ensureStarted 形状），
 * 让被测代码无感切换。可调记录便于断言（calls 数组）。
 */
import type { RustResponse } from "../../../src/subprocess/RustBridge.js";

export type ScriptFn = (params: unknown) => unknown;

/**
 * Mock RustBridge —— 既是 class 又是 callable。
 * 与真实 RustBridge 同 call() 签名，但内部走 scripts 表分发。
 */
export class MockRustBridge {
  /** 每次 call 的记录（method, params），便于断言调用次数 + 入参。 */
  readonly calls: Array<{ method: string; params: unknown }> = [];

  constructor(
    private readonly scripts: Record<string, ScriptFn> = {},
  ) {}

  /** 运行时改 scripts（同一 mock instance 多 case 复用）。 */
  setScript(method: string, fn: ScriptFn): void {
    this.scripts[method] = fn;
  }

  /** removeScript：让某 method 走 default 拒绝（unscripted）。 */
  removeScript(method: string): void {
    delete this.scripts[method];
  }

  /**
   * 与 RustBridge.call 同签名，但同步走 scripts 表：
   *  - 命中 script → { id, ok:true, result: script(params) }
   *  - 未命中     → { id, ok:false, error:"unscripted:<method>", error_kind:"unknown_method" }
   *
   * 默认同步返回（async 仅为了 shape 兼容）；单测需要异步行为可在 script 内返 Promise。
   */
  async call(
    method: string,
    params: unknown,
    _timeoutMs?: number,
  ): Promise<RustResponse> {
    this.calls.push({ method, params });
    const fn = this.scripts[method];
    if (!fn) {
      return {
        id: "mock",
        ok: false,
        error: `unscripted:${method}`,
        error_kind: "unknown_method",
      };
    }
    try {
      const result = await Promise.resolve(fn(params));
      return { id: "mock", ok: true, result };
    } catch (e) {
      return {
        id: "mock",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        error_kind: "script_error",
      };
    }
  }

  /** 与真实 RustBridge 同 ensureStarted 形状（no-op）。 */
  async ensureStarted(): Promise<void> {
    /* no-op for mock */
  }

  /** 与真实 RustBridge 同 pendingCount 形状（mock 始终 0）。 */
  pendingCount(): number {
    return 0;
  }
}
