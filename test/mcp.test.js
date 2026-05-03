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
      "auth_challenge",
      "auth_verify",
      "pet_status",
      "pet_create",
      "league_status",
      "pet_profile",
      "pet_loadout_update",
      "pet_replays",
      "training_report_draft",
      "training_report_submit",
      "battle_simulate",
      "battle_start",
      "battle_action",
      "battle_get",
      "matchmaking_join",
      "matchmaking_status",
      "matchmaking_cancel",
      "admin_audit",
      "friend_invite_create",
      "friend_invite_accept",
      "leaderboard",
    ],
  );
});

test("MCP bridge supports Content-Length stdio framing", async () => {
  const child = spawn(process.execPath, ["src/mcp/codex-pet-mcp.cjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let match;
    while ((match = buffer.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i))) {
      const headerLength = match[0].length;
      const contentLength = Number(match[1]);
      if (buffer.length < headerLength + contentLength) break;
      messages.push(JSON.parse(buffer.slice(headerLength, headerLength + contentLength)));
      buffer = buffer.slice(headerLength + contentLength);
    }
  });

  writeFramed(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  writeFramed(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await waitFor(() => messages.some((message) => message.id === 2), 2000);
  child.kill();

  assert.equal(messages.find((message) => message.id === 1).result.serverInfo.name, "codex-pet-league");
  assert.ok(messages.find((message) => message.id === 2).result.tools.some((tool) => tool.name === "admin_audit"));
});

function writeFramed(child, message) {
  const json = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
