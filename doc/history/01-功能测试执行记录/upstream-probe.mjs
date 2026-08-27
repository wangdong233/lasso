import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "probe", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "npx", args: ["-y", "chrome-devtools-mcp@0.3.0", "--headless", "--isolated"], cwd: process.cwd() });
await client.connect(transport);
const res = await client.listTools();
for (const t of res.tools) {
  if (["take_screenshot", "evaluate_script", "wait_for", "navigate_page", "fill_form", "click", "take_snapshot"].includes(t.name)) {
    console.log("=== " + t.name);
    console.log(JSON.stringify(t.inputSchema.properties && Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, v]) => [k, v.type || JSON.stringify(v).slice(0, 80)]))));
  }
}
await client.close();
