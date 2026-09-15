import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
it("hang probe", async () => {
  writeFileSync(process.env.PROBE_MARKER!, String(process.pid));
  await new Promise((r) => setTimeout(r, 120_000));
  expect(1).toBe(1);
}, 120_000);
