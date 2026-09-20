/**
 * start.ts（doc/bugs/12 §三——spawn 时 detect/降级编排；路由层只标引擎，
 * 「aria2c 缺失→undici 降级」的判定点在本文件）
 *
 * 职责边界（与 WT-tools 分工）：本文件**不碰任务表**——只做 引擎选择
 * （detect/降级/bootstrap lazy）+ spawn（detached）或 in-process 句柄
 * 交付。任务记录/status/wait/cancel/kill 归 tools+core。
 *
 * 生命周期两形态：
 *  - detached（aria2c/yt-dlp）：spawn 即返 pid+spec；进度=tail stdioFile
 *    解析；完成检测=pid 轮询（tools 层）；产物=releaseStaging 搬运。
 *  - inprocess（undici）：返回 AbortController+eager promise；进度=onProgress
 *    回调；产物直写 outDir（无 staging——无归属标记需求，不 spawn）。
 */
import type { DownloadKind, EngineSpawnSpec } from "../types.js";
import { resolveProxy, type ProxyInput } from "./proxy.js";
import { routeKind } from "./route.js";
import { spawnDetachedEngine } from "./spawn.js";
import { planAria2Spawn } from "./aria2.js";
import { planYtDlpSpawn, resolveYtDlpPath } from "./ytdlp.js";
import { detectAria2, bootstrapYtDlp, manualYtDlpHint } from "./bootstrap.js";
import {
  undiciDownload,
  type UndiciDownloadResult,
} from "./undici-fallback.js";
import type { SsrfConfig } from "../../ssrf/ssrf-guard.js";

export interface DownloadStartOptions {
  taskId: string;
  /** resolved kind（auto 已由 routeKind 展开——start 层不吃 auto）。 */
  kind: DownloadKind;
  source: string;
  outDir: string;
  filename: string | null;
  maxConn?: number;
  proxy?: ProxyInput;
  subs?: boolean;
  audioOnly?: boolean;
  maxBytes?: number;
  ssrfConfig?: SsrfConfig;
  /** 进度回调（undici in-process 路径）。 */
  onProgress?: Parameters<typeof undiciDownload>[0]["onProgress"];
  /** 测试隔离注入（staging/bin 根覆盖）。 */
  env?: NodeJS.ProcessEnv;
}

export type EngineStartResult =
  | {
      status: "detached";
      engine: "aria2c" | "yt-dlp";
      command: string;
      spec: EngineSpawnSpec;
      pid: number;
      stagingDir: string;
      proxyUsed: string | null;
      /**
       * 引擎子进程句柄（审查修复批 P0-1：deps.runSpawnPipeline 挂 exit 回调
       * 的定谳入口——detached+unref 不影响 exit 事件派发，lasso 活着即可即
       * 时终态化；lasso 死后由 maybeFinalizeOnPoll 轮询兜底）。
       */
      child: import("node:child_process").ChildProcess;
    }
  | {
      status: "inprocess";
      engine: "undici";
      proxyUsed: string | null;
      controller: AbortController;
      promise: Promise<UndiciDownloadResult>;
    }
  | {
      status: "unavailable";
      message: string;
      hint: string;
    };

/** 校验 resolved kind 合法（auto 在此 fail-closed——上泽 routeKind 已展开）。 */
function assertResolvedKind(kind: DownloadKind): void {
  if (kind !== "http" && kind !== "stream" && kind !== "torrent") {
    throw new Error(`invalid_download_kind:${kind}`);
  }
}

/**
 * 引擎启动编排。kind 与路由真源对齐（重入 routeKind 的引擎映射断言——
 * 防调用方手搓 kind/engine 组合漂移）。
 */
export async function startEngineDownload(
  opts: DownloadStartOptions,
): Promise<EngineStartResult> {
  assertResolvedKind(opts.kind);
  const env = opts.env ?? process.env;
  const proxyUsed = resolveProxy(opts.proxy, env);

  if (opts.kind === "http" || opts.kind === "torrent") {
    const aria2 = detectAria2(env);
    if (aria2.path) {
      const plan = planAria2Spawn(
        {
          taskId: opts.taskId,
          source: opts.source,
          kind: opts.kind,
          outDir: opts.outDir,
          filename: opts.filename,
          maxConn: opts.maxConn ?? 4,
          proxy: proxyUsed,
          env,
        },
        aria2.path,
      );
      const handle = spawnDetachedEngine(plan.command, plan.spec, env);
      return {
        status: "detached",
        engine: "aria2c",
        command: plan.command,
        spec: plan.spec,
        pid: handle.pid,
        stagingDir: plan.stagingDir,
        proxyUsed,
        child: handle.child,
      };
    }
    if (opts.kind === "torrent") {
      // BT 无降级引擎（undici 不懂 torrent）——显式不可用+手动引导
      return {
        status: "unavailable",
        message: "aria2c 缺失且 torrent kind 无降级引擎",
        hint: "brew install aria2（conda-forge 亦可；见 bootstrap.ts bootstrapAria2 提示）",
      };
    }
    // http kind → undici 降级（D9 引擎栈第三层）
  }

  if (opts.kind === "stream") {
    let ytdlp = resolveYtDlpPath(env);
    if (!ytdlp) {
      // D10 lazy opt-in：首 download 调用才拉（网络走 proxy 解析）
      try {
        const bootstrapped = await bootstrapYtDlp({ proxy: proxyUsed, env });
        ytdlp = bootstrapped.path;
      } catch (e) {
        return {
          status: "unavailable",
          message: `yt-dlp 缺失且 lazy 引导失败：${e instanceof Error ? e.message : String(e)}`,
          hint: manualYtDlpHint(env),
        };
      }
    }
    const plan = planYtDlpSpawn(
      {
        taskId: opts.taskId,
        source: opts.source,
        outDir: opts.outDir,
        filename: opts.filename,
        subs: opts.subs ?? false,
        audioOnly: opts.audioOnly ?? false,
        proxy: proxyUsed,
        env,
      },
      ytdlp,
    );
    const handle = spawnDetachedEngine(plan.command, plan.spec, env);
    return {
      status: "detached",
      engine: "yt-dlp",
      command: plan.command,
      spec: plan.spec,
      pid: handle.pid,
      stagingDir: plan.stagingDir,
      proxyUsed,
      child: handle.child,
    };
  }

  // kind=http 且 aria2c 缺失 → undici 单流降级（in-process）
  const controller = new AbortController();
  const promise = undiciDownload({
    url: opts.source,
    outDir: opts.outDir,
    filename: opts.filename,
    maxBytes: opts.maxBytes ?? 5 * 1024 * 1024 * 1024,
    proxy: proxyUsed,
    ssrfConfig: opts.ssrfConfig,
    signal: controller.signal,
    onProgress: opts.onProgress,
  });
  return { status: "inprocess", engine: "undici", proxyUsed, controller, promise };
}

// routeKind 再导出（tools 层单 import 面；映射真源唯一）
export { routeKind };
