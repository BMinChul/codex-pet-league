import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("MCP bridge calls League tools against a strict temp server", async () => {
  const server = await startTempServer();
  let child;
  try {
    const session = await createSession(server.baseUrl, "demo@codexpet.local");
    child = spawn(process.execPath, ["src/mcp/codex-pet-mcp.cjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_PET_LEAGUE_URL: server.baseUrl,
        CODEX_PET_SESSION_TOKEN: session.session_token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const client = lineRpcClient(child);
    await client.request("initialize", {});
    const created = await client.callTool("pet_create", {
      name: "MCP Smoke",
      primary_element: "Forge",
      secondary_element: "Trace",
    });
    const petId = created.structuredContent.pet.id;

    const status = await client.callTool("pet_status", { pet_id: petId });
    assert.equal(status.structuredContent.pet.id, petId);

    const audit = await client.callTool("admin_audit", {});
    assert.equal(audit.structuredContent.ok, true);

    const failed = await client.callToolError("matchmaking_cancel", { ticket_id: "missing" });
    assert.match(failed.error.message, /Waiting match ticket/);
  } finally {
    child?.kill();
    await server.close();
  }
});

function writeFramed(child, message) {
  const json = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function lineRpcClient(child) {
  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  let id = 0;
  return {
    async request(method, params) {
      id += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      await waitFor(() => messages.some((message) => message.id === id), 2000);
      const message = messages.find((entry) => entry.id === id);
      if (message.error) throw new Error(message.error.message);
      return message.result;
    },
    async callTool(name, args) {
      return this.request("tools/call", { name, arguments: args });
    },
    async callToolError(name, args) {
      id += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      await waitFor(() => messages.some((message) => message.id === id), 2000);
      const message = messages.find((entry) => entry.id === id);
      assert.ok(message.error);
      return message;
    },
  };
}

async function startTempServer() {
  const tempRoot = await mkdtemp(join(tmpdir(), "codexpet-mcp-"));
  const port = randomInt(49_001, 54_000);
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["src/server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      CODEX_PET_STATE_PATH: join(tempRoot, "league-state.json"),
      CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER: "false",
      CODEX_PET_AUTH_DEV_CODE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await waitForServer(baseUrl);
  return {
    baseUrl,
    async close() {
      child.kill();
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function createSession(baseUrl, identifier) {
  const challenge = await postJson(baseUrl, "/api/auth/challenge", { method: "email_magic_link", identifier });
  return postJson(baseUrl, "/api/auth/verify", {
    challenge_id: challenge.challenge_id,
    code: challenge.dev_code,
  });
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForServer(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(`${baseUrl}/api/rules`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Temp League server did not start.");
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
