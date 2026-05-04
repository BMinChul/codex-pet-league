import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
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
      "league_setup",
      "league_home",
      "next_action",
      "league_play",
      "pet_status",
      "pet_create",
      "pet_discover_hatch",
      "pet_import_hatch",
      "pet_activate",
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
      "battle_action_options",
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
  const hatch = await makeHatchPackage();
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

    const home = await client.callTool("league_home", { pet_id: petId });
    assert.equal(home.structuredContent.pet.id, petId);

    const next = await client.callTool("next_action", { pet_id: petId });
    assert.ok(next.structuredContent.command);

    const setupReady = await client.callTool("league_setup", {});
    assert.equal(setupReady.structuredContent.state, "ready");
    assert.equal(setupReady.structuredContent.pet.id, petId);

    const discovered = await client.callTool("pet_discover_hatch", {
      root_path: hatch.root,
    });
    assert.equal(discovered.structuredContent.count, 1);
    assert.equal(discovered.structuredContent.packages[0].id, "mcp-hatch");

    const imported = await client.callTool("pet_import_hatch", {
      root_path: hatch.root,
      primary_element: "Patch",
      secondary_element: "Logic",
    });
    assert.equal(imported.structuredContent.pet.name, "MCP Hatch");
    assert.equal(imported.structuredContent.pet.is_active, false);

    const blockedSwitch = await client.callToolError("pet_activate", { pet_id: imported.structuredContent.pet.id });
    assert.match(blockedSwitch.error.message, /permanent|locked/i);

    const reactivated = await client.callTool("pet_activate", { pet_id: petId });
    assert.equal(reactivated.structuredContent.active_pet_id, petId);
    assert.equal(reactivated.structuredContent.active_pet_selection_locked, true);

    const loop = await client.callTool("league_play", { pet_id: petId });
    assert.equal(loop.structuredContent.state, "idle");
    assert.equal(loop.structuredContent.pet.id, petId);

    const battle = await client.callTool("battle_start", { pet_id: petId, mode: "training" });
    const options = await client.callTool("battle_action_options", { battle_id: battle.structuredContent.battle.id });
    assert.equal(options.structuredContent.battle_id, battle.structuredContent.battle.id);
    assert.ok(options.structuredContent.recommendation.kind);

    const played = await client.callTool("league_play", {
      battle_id: battle.structuredContent.battle.id,
      submit_recommended_action: true,
    });
    assert.equal(played.structuredContent.state, "action_submitted");

    const audit = await client.callTool("admin_audit", {});
    assert.equal(audit.structuredContent.ok, true);

    const failed = await client.callToolError("matchmaking_cancel", { ticket_id: "missing" });
    assert.match(failed.error.message, /Waiting match ticket/);
  } finally {
    child?.kill();
    await hatch.close();
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
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ["src/server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      CODEX_PET_STATE_PATH: join(tempRoot, "league-state.json"),
      CODEX_PET_ASSET_ROOT: join(tempRoot, "assets"),
      CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER: "false",
      CODEX_PET_AUTH_DEV_CODE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => logs.push(`stdout: ${chunk.trim()}`));
  child.stderr.on("data", (chunk) => logs.push(`stderr: ${chunk.trim()}`));
  try {
    await waitForServer(baseUrl, child, logs);
  } catch (error) {
    child.kill();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    baseUrl,
    async close() {
      child.kill();
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function makeHatchPackage() {
  const root = await mkdtemp(join(tmpdir(), "codexpet-hatch-root-"));
  const dir = join(root, "mcp-hatch");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pet.json"),
    JSON.stringify(
      {
        id: "mcp-hatch",
        displayName: "MCP Hatch",
        description: "A test pet package from hatch-pet.",
        spritesheetPath: "spritesheet.webp",
      },
      null,
      2,
    ),
  );
  await writeFile(join(dir, "spritesheet.webp"), webpHeader(1536, 1872));
  return {
    root,
    dir,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function webpHeader(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  writeUInt24LE(bytes, width - 1, 24);
  writeUInt24LE(bytes, height - 1, 27);
  return bytes;
}

function writeUInt24LE(bytes, value, offset) {
  bytes.writeUInt8(value & 0xff, offset);
  bytes.writeUInt8((value >> 8) & 0xff, offset + 1);
  bytes.writeUInt8((value >> 16) & 0xff, offset + 2);
}

async function reservePort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await freePort();
    } catch {
      // Retry with a fresh OS-assigned port.
    }
  }
  return randomInt(49_001, 54_000);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not reserve a TCP port."));
        }
      });
    });
  });
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

async function waitForServer(baseUrl, child, logs) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) {
      throw new Error(`Temp League server exited with code ${child.exitCode}.\n${logs.join("\n")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/rules`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Temp League server did not start at ${baseUrl}.\n${logs.join("\n")}`);
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
