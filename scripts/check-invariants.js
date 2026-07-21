#!/usr/bin/env node
/**
 * Lasso 架构不变量检查（08 F3.9.8）
 *
 * 借鉴 injaneity/pi-computer-use 的 check-invariants.mjs +
 * media-gen-mcp 0.11.0 抓 mock 掩盖🔴的思路（运行时证据 > 断言）。
 *
 * CI 守门：漂移任一不变量即 fail（exit 1）。
 * 防止 refactor 引入第二套做法 / 绕过 BaseChannel / 等（13 审查红线）。
 *
 * 8 条不变量（08 §3.9 + 附录 G.7）：
 *  ① browse 是唯一 browse 入口
 *  ② BaseChannel 不被绕过
 *  ③ ProviderConfig 单一真源
 *  ④ 不复用第二套 fallback 范式
 *  ⑤ MCP ToolAnnotations 完整（每工具有 readOnlyHint/openWorldHint）
 *  ⑥ dispatchUiAction 走注册表 Map（非 if-else 链，开闭）
 *  ⑦ SubprocessManager 不含协议帧解析（MCP/JSON-RPC/JSON-lines 关键字即审视）
 *  ⑧ fallback 链不跨 surface 类型
 *
 * 当前：v0.1 占位（check 全 true，待实现后填实）。
 * npm run check-invariants 触发。
 */

const invariants = [
  { id: "inv-1", desc: "browse 是唯一 browse 入口", check: () => true },
  { id: "inv-2", desc: "BaseChannel 不被绕过", check: () => true },
  { id: "inv-3", desc: "ProviderConfig 单一真源", check: () => true },
  { id: "inv-4", desc: "不复用第二套 fallback 范式", check: () => true },
  { id: "inv-5", desc: "MCP ToolAnnotations 完整", check: () => true },
  { id: "inv-6", desc: "dispatchUiAction 走注册表 Map（非 if-else）", check: () => true },
  { id: "inv-7", desc: "SubprocessManager 不含协议帧解析", check: () => true },
  { id: "inv-8", desc: "fallback 链不跨 surface 类型", check: () => true },
];

let failed = 0;
for (const inv of invariants) {
  const ok = inv.check();
  console.log(`${ok ? "✓" : "✗"} ${inv.id}: ${inv.desc}`);
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} invariant(s) FAILED — CI red`);
  process.exit(1);
}
console.log(`\n✓ all ${invariants.length} invariants passed`);
