/**
 * staging.ts（doc/bugs/12 D7 归属标记 + D5 stdio 文件化的目录基座）
 *
 * ## marker 方案（本文件的核心存在理由）
 *
 * 决议 types.ts 常量 `LASSO_DOWNLOAD_ARGV_MARKER = "--lasso-download-task"` 在
 * aria2/yt-dlp 上**不可用**——两引擎对未知长参数一律拒绝（本机 aria2 1.37.0
 * 实测：`aria2c: unrecognized option '--lasso-download-task=xyz'`）。归属标记
 * 的替代锚点 = **staging 子目录路径**：
 *
 *  - 引擎一律先写 `<downloadsRoot>/staging/<taskId>/`（argv 里必然出现该路径
 *    ——aria2 `--dir` / yt-dlp `--paths`），完成后 rename 进最终 outDir；
 *  - cmdline 验证（cancel 杀谓词第③④要素）= argv 含 `staging/<taskId>` 子串
 *    （见 engineCmdlineMatchesTask——taskId 是 lasso 生成的 UUID，路径子串
 *    不可被 URL/文件名伪造碰撞）；
 *  - 双保险：spawn env 里同时放 `LASSO_DOWNLOAD_TASK=<taskId>`（Linux /proc
 *    可见；macOS ps 不显 env，cmdline 路径锚为主证据）。
 *
 * stdioFile（D5/H1）落 `<downloadsRoot>/logs/<taskId>.log`——**不在** staging
 * 内（staging 完成即删，日志须留档供 status tail）。
 *
 * 目录布局（与 types.ts DOWNLOADS_DIR_ENV / DEFAULT_DOWNLOADS_DIR_SUFFIX 对齐）：
 *  - LASSO_DOWNLOADS_PATH 显式覆盖时语义=任务表根（`.../downloads/tasks`），
 *    staging 取其父级下的 `staging/`（测试隔离用，见 stagingDirForTask 注）；
 *  - 默认 `<cacheDir>/downloads/{tasks,staging,logs}/`（cacheDir= LASSO_CACHE_DIR
 *    ?? ~/.cache/lasso，与 config.ts defaultCacheDir 同式）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DOWNLOADS_DIR_ENV } from "../types.js";

/** taskId 唯一合法形态校验（进路径前必过——防 `..`/分隔符注入路径穿越）。 */
export function assertSafeTaskId(taskId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(taskId) ||
    taskId.includes("..")
  ) {
    throw new Error(`invalid_task_id:${taskId}`);
  }
}

/** downloads 根（staging/logs/tasks 的共同父级；env 见文件头注）。 */
export function downloadsRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[DOWNLOADS_DIR_ENV] ?? "").trim();
  if (explicit) {
    // 显式覆盖指向 tasks 根 → 根=其父目录（.../downloads/tasks → .../downloads）
    return path.dirname(path.resolve(explicit));
  }
  const cache = (env.LASSO_CACHE_DIR ?? "").trim() || path.join(os.homedir(), ".cache", "lasso");
  return path.join(cache, "downloads");
}

/** 任务 stdio/进度日志文件（D5：引擎 stdout/stderr 重定向目标）。 */
export function stdioFileForTask(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertSafeTaskId(taskId);
  return path.join(downloadsRootDir(env), "logs", `${taskId}.log`);
}

/** 任务专属 staging 目录（= argv 归属标记本体）。 */
export function stagingDirForTask(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertSafeTaskId(taskId);
  return path.join(downloadsRootDir(env), "staging", taskId);
}

/** 建并取 staging 目录（幂等；返回绝对路径供 `--dir`/`--paths` 使用）。 */
export function acquireStagingDir(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = stagingDirForTask(taskId, env);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** cmdline 锚子串（`staging<sep><taskId>`）。 */
export function stagingTaskMarker(taskId: string): string {
  return path.join("staging", taskId);
}

/**
 * 杀谓词 cmdline 验证（D7 第③/④要素的引擎侧原语；kill.ts 复用）：
 * argv 任一参数含 `staging/<taskId>` 子串即认定归属。
 */
export function engineCmdlineMatchesTask(argv: string[], taskId: string): boolean {
  const marker = stagingTaskMarker(taskId);
  return argv.some((a) => a.includes(marker));
}

/**
 * staging → 最终目录交付（completed 后调用）：
 *  - 递归搬走全部产物（BT 多文件形态=嵌套目录原样保留相对结构）；
 *  - 目标已存在时加 `-1`/`-2` 后缀（绝不覆盖既有文件）；
 *  - EXDEV（跨设备）降级 copy+rm；
 *  - 收尾删除任务 staging 目录。
 * 返回搬入最终目录的绝对路径清单（= 任务表 files 字段真源）。
 */
export function releaseStaging(
  taskId: string,
  finalDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const staging = stagingDirForTask(taskId, env);
  if (!fs.existsSync(staging)) return [];
  fs.mkdirSync(finalDir, { recursive: true });
  const moved: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, ent.name);
      const relPath = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) {
        walk(src, relPath);
      } else if (ent.isFile()) {
        let dest = path.join(finalDir, relPath);
        if (fs.existsSync(dest)) {
          const ext = path.extname(ent.name);
          const base = path.join(
            path.dirname(dest),
            path.basename(ent.name, ext),
          );
          for (let i = 1; fs.existsSync(dest); i++) {
            dest = `${base}-${i}${ext}`;
          }
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.renameSync(src, dest);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EXDEV") {
            fs.copyFileSync(src, dest);
            fs.rmSync(src, { force: true });
          } else {
            throw e;
          }
        }
        moved.push(dest);
      }
    }
  };
  walk(staging, "");
  fs.rmSync(staging, { recursive: true, force: true });
  return moved;
}

/** 丢弃 staging（failed/cancelled 清理；幂等）。 */
export function discardStaging(taskId: string, env: NodeJS.ProcessEnv = process.env): void {
  fs.rmSync(stagingDirForTask(taskId, env), { recursive: true, force: true });
}
