/**
 * vitest 孤儿探针夹具配置（BUG-08 F）——只服务于嵌套探针运行（外层 spec 以本目录
 * 为 cwd 拉起 vitest；pool 由外层用 --pool 从生产 vitest.workspace.ts 运行时提取
 * 注入，保证夹具永远跟随生产池选择，防"夹具绿、生产红"的漂移）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["probe.ts"],
  },
});
