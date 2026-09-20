/**
 * bin-dir.ts（doc/bugs/12 D10——引擎二进制缓存目录单一真源）
 *
 * `LASSO_BIN_DIR` env 覆盖（types.ts LASSO_BIN_CACHE_ENV）→ 默认
 * `<cacheDir>/bin`（cacheDir = LASSO_CACHE_DIR ?? ~/.cache/lasso，与
 * config.ts defaultCacheDir 同式）。yt-dlp_macos（bootstrap 落地）与未来
 * conda-forge aria2 都住这里。
 */
import * as os from "node:os";
import * as path from "node:path";
import { LASSO_BIN_CACHE_ENV } from "../types.js";

export function ytDlpBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env[LASSO_BIN_CACHE_ENV] ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const cache = (env.LASSO_CACHE_DIR ?? "").trim() || path.join(os.homedir(), ".cache", "lasso");
  return path.join(cache, "bin");
}
