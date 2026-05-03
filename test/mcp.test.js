import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("MCP bridge initializes and lists Pet League tools", async () => {
  const child = spawn(process.execPath, ["src/mcp/codex-pet-mcp.cjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  await waitFor(() => messages.some((message) => message.id === 2), 2000);
  child.kill();

  const initialize = messages.find((message) => message.id === 1);
  const list = messages.find((message) => message.id === 2);

  assert.equal(initialize.result.serverInfo.name, "codex-pet-league");
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    [
      "pet_status",
      "pet_create",
      "training_report_draft",
      "training_report_submit",
      "battle_simulate",
      "battle_start",
      "battle_action",
      "battle_get",
      "leaderboard",
    ],
  );
});

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
