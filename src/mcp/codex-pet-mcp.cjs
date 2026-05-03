#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const baseUrl = (process.env.CODEX_PET_LEAGUE_URL || "http://localhost:4317").replace(/\/$/, "");
const accountId = process.env.CODEX_PET_ACCOUNT_ID || "acct_demo";
const sessionToken = process.env.CODEX_PET_SESSION_TOKEN || process.env.LEAGUE_SESSION_TOKEN || "";

const tools = [
  {
    name: "auth_challenge",
    title: "Create League Auth Challenge",
    description: "Starts a League account binding challenge for passkey, email magic link, or OAuth-shaped login.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["passkey", "email_magic_link", "league_oauth"] },
        identifier: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "auth_verify",
    title: "Verify League Auth Challenge",
    description: "Verifies a League auth challenge and returns a session token for official requests.",
    inputSchema: {
      type: "object",
      properties: {
        challenge_id: { type: "string" },
        code: { type: "string" },
      },
      required: ["challenge_id", "code"],
      additionalProperties: false,
    },
  },
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
    name: "league_status",
    title: "League Status",
    description: "Shows the active season and official matchmaking policy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pet_profile",
    title: "Pet Profile",
    description: "Shows a public pet profile with recent battles.",
    inputSchema: {
      type: "object",
      properties: { pet_id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "pet_loadout_update",
    title: "Update Pet Loadout",
    description: "Updates the four official skills and cosmetic skill aliases for a pet.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        skills: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
        aliases: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pet_replays",
    title: "Pet Replays",
    description: "Lists recent replay logs for the selected pet.",
    inputSchema: {
      type: "object",
      properties: { pet_id: { type: "string" } },
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
    name: "battle_start",
    title: "Start Turn Battle",
    description: "Starts a 30-second simultaneous turn battle room for the selected pet.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        mode: { type: "string", enum: ["ranked", "casual", "friend", "training"] },
        opponent_lp: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "battle_action",
    title: "Submit Battle Action",
    description: "Submits one locked action for the current turn in a server battle room.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
        kind: { type: "string", enum: ["strike", "guard", "focus", "skill"] },
        skill_id: { type: "string" },
      },
      required: ["battle_id"],
      additionalProperties: false,
    },
  },
  {
    name: "battle_get",
    title: "Get Turn Battle",
    description: "Gets the current server state for a turn battle room and advances expired turns.",
    inputSchema: {
      type: "object",
      properties: {
        battle_id: { type: "string" },
      },
      required: ["battle_id"],
      additionalProperties: false,
    },
  },
  {
    name: "matchmaking_join",
    title: "Join Random Matchmaking",
    description: "Queues the selected pet for a same-Battle-Class random ranked or casual match.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        mode: { type: "string", enum: ["ranked", "casual"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "matchmaking_status",
    title: "Matchmaking Status",
    description: "Shows waiting tickets and active PvP battle rooms for this League account.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "matchmaking_cancel",
    title: "Cancel Matchmaking",
    description: "Cancels a waiting matchmaking ticket.",
    inputSchema: {
      type: "object",
      properties: { ticket_id: { type: "string" } },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "admin_audit",
    title: "Admin Audit",
    description: "Runs local integrity and anti-cheat audit checks.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "friend_invite_create",
    title: "Create Friend Invite",
    description: "Creates a 10-minute Friend Duel invite code for the selected pet.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "friend_invite_accept",
    title: "Accept Friend Invite",
    description: "Accepts a Friend Duel invite code using the selected pet.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        code: { type: "string" },
      },
      required: ["code"],
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

let framing = "newline";

function send(message) {
  const json = JSON.stringify(message);
  if (framing === "content-length") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    return;
  }
  process.stdout.write(`${json}\n`);
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
  if (name === "auth_challenge") {
    return apiPost("/api/auth/challenge", {
      method: args.method ?? "email_magic_link",
      identifier: args.identifier ?? "local@example.test",
    });
  }

  if (name === "auth_verify") {
    if (!args.challenge_id) throw new Error("challenge_id is required.");
    if (!args.code) throw new Error("code is required.");
    return apiPost("/api/auth/verify", {
      challenge_id: args.challenge_id,
      code: String(args.code),
    });
  }

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

  if (name === "league_status") {
    return apiGet("/api/league");
  }

  if (name === "pet_profile") {
    const pet = await resolvePet(args.pet_id);
    return apiGet(`/api/public/pets/${pet.id}`);
  }

  if (name === "pet_loadout_update") {
    const pet = await resolvePet(args.pet_id);
    return apiPut(`/api/pets/${pet.id}/loadout`, {
      skills: args.skills ?? pet.skills.map((skill) => skill.id),
      aliases: args.aliases ?? {},
    });
  }

  if (name === "pet_replays") {
    const pet = await resolvePet(args.pet_id);
    return apiGet(`/api/pets/${pet.id}/replays`);
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

  if (name === "battle_start") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/battles`, {
      mode: args.mode ?? "casual",
      opponent_lp: Number(args.opponent_lp ?? 1500),
    });
  }

  if (name === "battle_action") {
    if (!args.battle_id) throw new Error("battle_id is required.");
    return apiPost(`/api/battles/${args.battle_id}/actions`, {
      kind: args.kind ?? "strike",
      skill_id: args.skill_id,
    });
  }

  if (name === "battle_get") {
    if (!args.battle_id) throw new Error("battle_id is required.");
    return apiGet(`/api/battles/${args.battle_id}`);
  }

  if (name === "matchmaking_join") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/matchmaking/queue`, {
      mode: args.mode ?? "ranked",
    });
  }

  if (name === "matchmaking_status") {
    const suffix = args.pet_id ? `?pet_id=${encodeURIComponent(args.pet_id)}` : "";
    return apiGet(`/api/matchmaking/status${suffix}`);
  }

  if (name === "matchmaking_cancel") {
    if (!args.ticket_id) throw new Error("ticket_id is required.");
    return apiPost("/api/matchmaking/cancel", { ticket_id: args.ticket_id });
  }

  if (name === "admin_audit") {
    return apiGet("/api/admin/audit");
  }

  if (name === "friend_invite_create") {
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/friend-invites`, {});
  }

  if (name === "friend_invite_accept") {
    if (!args.code) throw new Error("code is required.");
    const pet = await resolvePet(args.pet_id);
    return apiPost(`/api/pets/${pet.id}/friend-invites/accept`, { code: args.code });
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

async function apiPut(route, body) {
  return request("PUT", route, body);
}

async function request(method, route, body) {
  const headers = { "content-type": "application/json" };
  if (sessionToken) {
    headers["x-league-session-token"] = sessionToken;
  } else {
    headers["x-league-account-id"] = accountId;
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
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
  parseIncoming();
});

function parseIncoming() {
  while (buffer.length > 0) {
    const headerMatch = buffer.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (headerMatch) {
      framing = "content-length";
      const headerLength = headerMatch[0].length;
      const contentLength = Number(headerMatch[1]);
      if (buffer.length < headerLength + contentLength) return;
      const raw = buffer.slice(headerLength, headerLength + contentLength);
      buffer = buffer.slice(headerLength + contentLength);
      handleRawMessage(raw);
      continue;
    }

    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) return;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    handleRawMessage(line);
  }
}

function handleRawMessage(raw) {
  try {
    handleRequest(JSON.parse(raw));
  } catch (err) {
    send({ jsonrpc: "2.0", error: { code: -32700, message: String(err?.message ?? err) } });
  }
}
