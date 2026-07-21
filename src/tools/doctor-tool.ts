/**
 * doctor tool 注册（parse1 §3.12 + §3.11）
 *
 * 把 runDoctor(report) 暴露成 MCP tool。CC 在排障时可直接调 doctor() 拿
 * 同样的 JSON 报告，CLI 模式（`lasso doctor`）走同一份 runDoctor 实现。
 *
 * 不变量：doctor 是 readOnly + 非 openWorld（自检不触外网，但部分 check
 * 会触网探测——openWorld=false 是按 Lasso 边界标注，让 CC 不把它当
 * "向用户不可控的外部世界写入"对待）。
 *
 * v0.6 M0.6（parse7 §2.2 + §6.2）：doctor 选项加 runtimeState provider；
 * 由 index.ts 装配时注入（CapabilityBag.snapshot + CallerTierTracker.snapshot
 * + ToolManager.listByChannel），doctor 报告新增 runtime_state section。
 *
 * 借鉴：parse1 §3.12 registerDoctorTool；附录 B DOCTOR_DESCRIPTION。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runDoctor, type DoctorOptions } from "../doctor/doctor.js";
import { DOCTOR_DESCRIPTION } from "./descriptions.js";
import { doctorAnnotations } from "./annotations.js";

export function registerDoctorTool(
  server: McpServer,
  opts: DoctorOptions = {},
): void {
  server.tool("doctor", DOCTOR_DESCRIPTION, {}, doctorAnnotations, async () => {
    const report = await runDoctor(opts);
    return {
      content: [
        { type: "text", text: JSON.stringify(report, null, 2) },
      ],
    };
  });
}
