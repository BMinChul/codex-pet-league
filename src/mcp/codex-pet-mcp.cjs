#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const baseUrl = (process.env.CODEX_PET_LEAGUE_URL || "http://localhost:4317").replace(/\/$/, "");
const accountId = process.env.CODEX_PET_ACCOUNT_ID || "acct_demo";

const tools = [
  {
    name: "pet_status",
    title: "Pet Status",
    description: "Shows active pet, XP caps, Training Report count, rank, and Battle Class.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pet_create",
    title: "Create Official Pet",
    description: "Registers an optional Codex hatch atlas PNG and creates an official account-bound Pet League pet.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        primary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
        secondary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
        atlas_path: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "training_report_draft",
    title: "Draft Training Report",
    description: "Creates a Training Report preview. This does not submit or award XP.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        signals: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "training_report_submit",
    title: "Submit Training Report",
    description: "Submits a user-approved Training Report to the League server for official XP scoring.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        signals: { type: "object" },
        idempotency_key: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "battle_simulate",
    title: "Simulate Battle Result",
    description: "Developer prototype tool that resolves a server-authoritative battle result for the selected pet.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        mode: { type: "string", enum: ["ranked", "casual", "friend", "training"] },
        result: { type: "string", enum: ["win", "draw", "loss", "afk_loss", "complete"] },
        opponent_lp: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "leaderboard",
    title: "Leaderboard",
    description: "Shows the current server-derived leaderboard.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "codex-pet-league",
        version: "0.1.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    result(id, { tools });
    return;
  }

  if (method === "tools/call") {
    try {
      const payload = await callTool(params?.name, params?.arguments ?? {});
      result(id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      });
    } catch (err) {
      error(id, -32000, err.message || "Tool call failed.");
    }
    return;
  }

  error(id, -32601, `Method not found: ${method}`);
}

async function callTool(name, args) {
  if (name === "pet_status") {
    const pet = await resolvePet(args.pet_id);
    return apiGet(`/api/pets/${pet.id}/xp-status`);
  }

  if (name === "pet_create") {
    const atlasDataUrl = args.atlas_path ? await pngDataUrl(args.atlas_path) : null;
    const asset = await apiPost("/api/pet-assets/uploads", {
      appearance: {
        source: "codex_pet_mcp",
        file: args.atlas_path ? path.basename(args.atlas_path) : null,
      },
      atlas_data_url: atlasDataUrl,
    });
    return apiPost("/api/pets", {
      name: args.name ?? "Codex Pet",
      pet_asset_id: asset.asset.id,
      primary_element: args.primary_element ?? "Forge",
      secondary_element: args.secondary_element ?? "Trace",
    });
  }

  if (name === "training_report_draft") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/training-reports/draft`, {
      signals: args.signals ?? defaultSignals(),
    });
  }

  if (name === "training_report_submit") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/training-reports`, {
      client_report_id: args.idempotency_key ?? randomUUID(),
      signals: args.signals ?? defaultSignals(),
    });
  }

  if (name === "battle_simulate") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/battles/simulate`, {
      mode: args.mode ?? "casual",
      result: args.result ?? "win",
      opponent_lp: Number(args.opponent_lp ?? 1500),
    });
  }

  if (name === "leaderboard") {
    return apiGet("/api/leaderboard");
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function resolvePet(petId) {
  const result = await apiGet("/api/pets");
  if (petId) {
    const pet = result.pets.find((entry) => entry.id === petId);
    if (!pet) throw new Error(`Pet not found: ${petId}`);
    return pet;
  }
  if (!result.pets[0]) throw new Error("No pets registered. Create one with pet_create first.");
  return result.pets[0];
}

async function apiGet(route) {
  return request("GET", route);
}

async function apiPost(route, body) {
  return request("POST", route, body);
}

async function request(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-league-account-id": accountId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `${method} ${route} failed`);
  }
  return payload;
}

async function pngDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function defaultSignals() {
  return {
    implementationActivity: true,
    verificationActivity: true,
    filesChangedBucket: "medium",
    testsRun: 1,
  };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handleRequest(JSON.parse(line));
    } catch (err) {
      send({ jsonrpc: "2.0", error: { code: -32700, message: String(err?.message ?? err) } });
    }
  }
});
