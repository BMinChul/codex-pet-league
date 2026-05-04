#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHmac, randomUUID } = require("node:crypto");
const { discoverHatchPetPackages, loadHatchPetPackage } = require("../hatchPackage.cjs");

const baseUrl = (process.env.CODEX_PET_LEAGUE_URL || "http://localhost:4317").replace(/\/$/, "");
const accountId = process.env.CODEX_PET_ACCOUNT_ID || "acct_demo";
const sessionToken = process.env.CODEX_PET_SESSION_TOKEN || process.env.LEAGUE_SESSION_TOKEN || "";
const bridgeSecret = process.env.CODEX_PET_BRIDGE_SECRET || "";
const bridgeAttestationSecret = process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET || "";

const tools = [
  {
    name: "league_doctor",
    title: "League Doctor",
    description: "Checks server health, auth provider status, bridge attestation, storage, realtime, and rule counts for Codex App play.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
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
    name: "league_setup",
    title: "League Setup",
    description: "Runs the Codex App onboarding loop: verify League session, discover hatch-pet candidates, require permanent-selection confirmation, import the first official pet, and return the next play action.",
    inputSchema: {
      type: "object",
      properties: {
        package_path: { type: "string" },
        root_path: { type: "string" },
        confirm_permanent: { type: "boolean" },
        name: { type: "string" },
        primary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
        secondary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "league_home",
    title: "League Home",
    description: "Returns a combined League account, active pet, daily XP, matchmaking, and leaderboard snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "next_action",
    title: "Recommend Next League Action",
    description: "Recommends the next useful pet, Training Report, queue, or battle command from current server state.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "league_play",
    title: "Codex App Play Loop",
    description: "Runs the Codex App-first loop: inspect active pet, active battle, queue state, and optionally submit the requested or recommended turn action.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
        battle_id: { type: "string" },
        mode: { type: "string", enum: ["ranked", "casual", "training"] },
        join_queue: { type: "boolean" },
        submit_recommended_action: { type: "boolean" },
        kind: { type: "string", enum: ["strike", "guard", "focus", "skill"] },
        skill_id: { type: "string" },
      },
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
    description: "Registers an optional Codex hatch atlas PNG/WebP and creates an official account-bound Pet League pet.",
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
    name: "pet_discover_hatch",
    title: "Discover hatch-pet Packages",
    description: "Scans the local Codex pets folder for official hatch-pet packages that can be imported into League.",
    inputSchema: {
      type: "object",
      properties: {
        root_path: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pet_inspect_hatch",
    title: "Inspect hatch-pet Package",
    description: "Validates one local official hatch-pet package and returns manifest, atlas dimensions, hashes, package fingerprint, and import guidance without uploading it.",
    inputSchema: {
      type: "object",
      properties: {
        package_path: { type: "string" },
        root_path: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pet_import_hatch",
    title: "Import hatch-pet Package",
    description: "Imports an official hatch-pet package folder containing pet.json and spritesheet.webp, then creates the League pet. It becomes active only if the account has no permanent active pet yet.",
    inputSchema: {
      type: "object",
      properties: {
        package_path: { type: "string" },
        root_path: { type: "string" },
        name: { type: "string" },
        primary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
        secondary_element: { type: "string", enum: ["Logic", "Patch", "Trace", "Forge", "Pulse", "Deploy"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pet_activate",
    title: "Activate League Pet",
    description: "Sets the one permanent official active League pet for this account. Re-selecting the same pet is allowed; switching to another pet is blocked.",
    inputSchema: {
      type: "object",
      properties: {
        pet_id: { type: "string" },
      },
      required: ["pet_id"],
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
        turn_index: { type: "number" },
        turn_nonce: { type: "string" },
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
    name: "battle_action_options",
    title: "Battle Action Options",
    description: "Shows valid base actions, equipped skill options, energy readiness, and a safe action recommendation.",
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
  if (name === "league_doctor") {
    const [health, providers, bridge, rules] = await Promise.all([
      optional(apiGet("/api/health")),
      optional(apiGet("/api/auth/providers")),
      optional(apiGet("/api/bridge/status")),
      optional(apiGet("/api/rules")),
    ]);
    return {
      state: health?.status === "ok" ? "ok" : "review",
      health,
      auth_provider: providers ?? health?.auth_provider ?? null,
      bridge,
      rules: rules
        ? {
            elements: rules.elements,
            skill_count: rules.skills?.length ?? 0,
            level100_xp: rules.level100Xp,
            fastest_days_at_cap: rules.level100FastestDaysAtCap,
          }
        : null,
      warnings: doctorWarnings({ health, providers, bridge }),
    };
  }

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

  if (name === "league_setup") {
    return leagueSetup(args);
  }

  if (name === "league_home") {
    return buildLeagueHome(args.pet_id);
  }

  if (name === "next_action") {
    const home = await buildLeagueHome(args.pet_id);
    return {
      ...home.next_action,
      pet: home.pet,
      daily_remaining: home.daily?.remaining ?? null,
      queue: home.matchmaking,
    };
  }

  if (name === "league_play") {
    return leaguePlay(args);
  }

  if (name === "pet_status") {
    const pet = await resolvePet(args.pet_id);
    return apiGet(`/api/pets/${pet.id}/xp-status`);
  }

  if (name === "pet_create") {
    const atlasDataUrl = args.atlas_path ? await imageDataUrl(args.atlas_path) : null;
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

  if (name === "pet_discover_hatch") {
    const packages = await discoverHatchPetPackages({ root: args.root_path });
    return {
      count: packages.length,
      packages: packages.map(summarizeHatchPackage),
    };
  }

  if (name === "pet_inspect_hatch") {
    const hatch = await loadHatchPetPackage(args.package_path, {
      root: args.root_path,
    });
    return summarizeLoadedHatchPackage(hatch);
  }

  if (name === "pet_import_hatch") {
    const hatch = await loadHatchPetPackage(args.package_path, {
      root: args.root_path,
    });
    const asset = await apiPost("/api/pet-assets/uploads", {
      appearance: hatch.appearance,
      atlas_data_url: hatch.data_url,
      hatch_pet_manifest: hatch.manifest,
      hatch_source: "openai_hatch_pet",
    });
    const created = await apiPost("/api/pets", {
      name: args.name ?? hatch.manifest.displayName,
      pet_asset_id: asset.asset.id,
      primary_element: args.primary_element ?? "Forge",
      secondary_element: args.secondary_element ?? "Trace",
    });
    created.asset_import = summarizeAssetImport(asset.asset, hatch);
    return created;
  }

  if (name === "pet_activate") {
    if (!args.pet_id) throw new Error("pet_id is required.");
    return apiPost(`/api/pets/${args.pet_id}/activate`, {});
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
    const signals = args.signals ?? defaultSignals();
    const draft = await apiPost(`/api/pets/${pet.id}/training-reports/draft`, { signals });
    return apiPost(`/api/pets/${pet.id}/training-reports`, {
      client_report_id: args.idempotency_key ?? randomUUID(),
      draft_id: draft.draft.id,
      draft_nonce: draft.draft.nonce,
      signals,
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
    const current = await apiGet(`/api/battles/${args.battle_id}`);
    return apiPost(`/api/battles/${args.battle_id}/actions`, {
      kind: args.kind ?? "strike",
      skill_id: args.skill_id,
      turn_index: args.turn_index ?? current.battle.turn_index,
      turn_nonce: args.turn_nonce ?? current.battle.turn_nonce,
      source: "mcp",
    });
  }

  if (name === "battle_get") {
    if (!args.battle_id) throw new Error("battle_id is required.");
    return apiGet(`/api/battles/${args.battle_id}`);
  }

  if (name === "battle_action_options") {
    if (!args.battle_id) throw new Error("battle_id is required.");
    const [result, rules] = await Promise.all([apiGet(`/api/battles/${args.battle_id}`), optional(apiGet("/api/rules"), {})]);
    return battleActionOptions(result.battle, rules);
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

async function buildLeagueHome(petId = null) {
  const [session, league, petsResult, boardResult] = await Promise.all([
    optional(apiGet("/api/session")),
    optional(apiGet("/api/league")),
    optional(apiGet("/api/pets"), { pets: [] }),
    optional(apiGet("/api/leaderboard"), { leaderboard: [] }),
  ]);
  const pets = petsResult?.pets ?? [];
  const activePet = activePetFromResult(petsResult);
  const pet = petId ? pets.find((entry) => entry.id === petId) : activePet;
  if (petId && !pet) throw new Error(`Pet not found: ${petId}`);
  const [xpStatus, matchmaking] = await Promise.all([
    pet ? optional(apiGet(`/api/pets/${pet.id}/xp-status`)) : null,
    optional(apiGet(`/api/matchmaking/status${pet ? `?pet_id=${encodeURIComponent(pet.id)}` : ""}`)),
  ]);
  const next = recommendedNextAction({ pet, xpStatus, matchmaking });
  return {
    account: session?.account ?? null,
    season: league?.active_season ?? league?.season ?? null,
    pet: pet ? summarizePet(pet) : null,
    pets: pets.map(summarizePet),
    daily: xpStatus
      ? {
          remaining: xpStatus.remaining,
          caps: xpStatus.caps,
          reset_at: xpStatus.reset_at,
          status_text: xpStatus.status_text,
        }
      : null,
    matchmaking: summarizeMatchmaking(matchmaking),
    leaderboard_top: (boardResult?.leaderboard ?? []).slice(0, 5),
    next_action: next,
  };
}

async function leagueSetup(args = {}) {
  const [session, petsResult] = await Promise.all([
    optional(apiGet("/api/session")),
    optional(apiGet("/api/pets"), { pets: [] }),
  ]);
  const identityPolicy = {
    codex_chatgpt_login: "Codex CLI/App can sign in with ChatGPT, but no public server-verifiable OpenAI identity claim is exposed to this League server.",
    league_account: "Use League passkey, email magic link, or League OAuth session for official ownership.",
  };
  const activePet = activePetFromResult(petsResult);
  if (activePet) {
    const home = await buildLeagueHome(activePet.id);
    return {
      state: "ready",
      identity_policy: identityPolicy,
      account: session?.account ?? null,
      active_pet_locked: true,
      pet: summarizePet(activePet),
      next_action: home.next_action,
    };
  }

  let packagePath = args.package_path;
  const packages = await discoverHatchPetPackages({ root: args.root_path });
  if (!packagePath) {
    if (packages.length === 0) {
      return {
        state: "needs_hatch_package",
        identity_policy: identityPolicy,
        message: "No local hatch-pet packages were found. Create one with the official OpenAI hatch-pet skill, then run setup again.",
        packages: [],
      };
    }
    if (packages.length > 1) {
      return {
        state: "needs_package_choice",
        identity_policy: identityPolicy,
        message: "Multiple hatch-pet candidates were found. Choose package_path explicitly because the first active League pet is permanent.",
        packages: packages.map(summarizeHatchPackage),
      };
    }
    packagePath = packages[0].package_dir;
  }

  const selected = packages.find((entry) => entry.package_dir === packagePath || entry.manifest.id === packagePath) ?? null;
  if (!args.confirm_permanent) {
    return {
      state: "needs_confirmation",
      identity_policy: identityPolicy,
      message: "Confirm that this hatch-pet package should become the permanent official active League pet for this account.",
      selected_package: selected ? summarizeHatchPackage(selected) : { package_dir: packagePath },
      confirm_with: { confirm_permanent: true, package_path: packagePath },
    };
  }

  const hatch = await loadHatchPetPackage(packagePath, {
    root: args.root_path,
  });
  const asset = await apiPost("/api/pet-assets/uploads", {
    appearance: hatch.appearance,
    atlas_data_url: hatch.data_url,
    hatch_pet_manifest: hatch.manifest,
    hatch_source: "openai_hatch_pet",
  });
  const created = await apiPost("/api/pets", {
    name: args.name ?? hatch.manifest.displayName,
    pet_asset_id: asset.asset.id,
    primary_element: args.primary_element ?? "Forge",
    secondary_element: args.secondary_element ?? "Trace",
  });
  const home = await buildLeagueHome(created.active_pet_id ?? created.pet.id);
  return {
    state: created.pet.is_active ? "ready" : "imported_inactive",
    identity_policy: identityPolicy,
    account: session?.account ?? null,
    pet: summarizePet(created.pet),
    asset: summarizeAssetImport(asset.asset, hatch),
    active_pet_id: created.active_pet_id ?? null,
    active_pet_locked: Boolean(created.active_pet_selection_locked),
    next_action: home.next_action,
  };
}

function activePetFromResult(petsResult) {
  const pets = petsResult?.pets ?? [];
  return pets.find((entry) => entry.id === petsResult?.active_pet_id) ?? pets.find((entry) => entry.is_active) ?? null;
}

async function resolvePet(petId) {
  const result = await apiGet("/api/pets");
  if (petId) {
    const pet = result.pets.find((entry) => entry.id === petId);
    if (!pet) throw new Error(`Pet not found: ${petId}`);
    return pet;
  }
  if (!result.pets[0]) throw new Error("No pets registered. Import one with pet_import_hatch first.");
  return result.pets.find((entry) => entry.id === result.active_pet_id) ?? result.pets.find((entry) => entry.is_active) ?? result.pets[0];
}

async function leaguePlay(args = {}) {
  const home = await buildLeagueHome(args.pet_id);
  if (!home.pet?.id) {
    return {
      state: "needs_pet",
      next_action: home.next_action,
      message: "Import an official hatch-pet package before playing.",
    };
  }

  const activeBattleId = args.battle_id ?? home.matchmaking?.active_battles?.[0]?.id;
  if (activeBattleId) {
    const [result, rules] = await Promise.all([apiGet(`/api/battles/${activeBattleId}`), optional(apiGet("/api/rules"), {})]);
    const options = battleActionOptions(result.battle, rules);
    const requestedKind = args.kind;
    if (requestedKind || args.submit_recommended_action) {
      const action = requestedKind
        ? { kind: requestedKind, skill_id: args.skill_id }
        : { kind: options.recommendation.kind, skill_id: options.recommendation.skill_id };
      const submitted = await apiPost(`/api/battles/${activeBattleId}/actions`, {
        kind: action.kind,
        skill_id: action.skill_id,
        turn_index: result.battle.turn_index,
        turn_nonce: result.battle.turn_nonce,
        source: "mcp_play_loop",
      });
      return {
        state: "action_submitted",
        submitted_action: action,
        battle: submitted.battle,
        options: battleActionOptions(submitted.battle, rules),
      };
    }
    return {
      state: "battle_ready",
      battle: result.battle,
      options,
    };
  }

  if (args.join_queue) {
    const queued = await apiPost(`/api/pets/${home.pet.id}/matchmaking/queue`, {
      mode: args.mode ?? "ranked",
    });
    return {
      state: queued.status === "matched" ? "matched" : "queued",
      result: queued,
    };
  }

  return {
    state: "idle",
    pet: home.pet,
    daily: home.daily,
    matchmaking: home.matchmaking,
    next_action: home.next_action,
  };
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
  const guardedBody = body && method !== "GET" ? { ...body, request_id: body.request_id || body.idempotency_key || randomUUID() } : body;
  const bodyText = guardedBody ? JSON.stringify(guardedBody) : undefined;
  if (sessionToken) {
    headers["x-league-session-token"] = sessionToken;
  } else {
    headers["x-league-account-id"] = accountId;
  }
  if (bridgeSecret && bodyText) {
    headers["x-league-bridge-signature"] = createHmac("sha256", bridgeSecret).update(bodyText).digest("hex");
  }
  if (bridgeAttestationSecret && bodyText) {
    headers["x-codex-app-attestation"] = createHmac("sha256", bridgeAttestationSecret).update(bodyText).digest("hex");
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: bodyText,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `${method} ${route} failed`);
  }
  return payload;
}

async function imageDataUrl(filePath) {
  const bytes = await fs.readFile(filePath);
  const mime = String(filePath).toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function battleActionOptions(battle, rules = {}) {
  const side = viewerSide(battle);
  const skillsById = new Map((rules.skills ?? []).map((skill) => [skill.id, skill]));
  const recommendation = recommendBattleAction(battle, rules);
  const skills = (side?.skills ?? []).map((skillId) => {
    const skill = skillsById.get(skillId) ?? inferSkillFromId(skillId);
    const cost = skillCost(skill?.role);
    return {
      id: skillId,
      official_name: skill?.officialName ?? skillId,
      alias: side?.skill_aliases?.[skillId] ?? null,
      role: skill?.role ?? "skill",
      energy_cost: cost,
      ready: Number(side?.energy ?? 0) >= cost,
    };
  });
  return {
    battle_id: battle.id,
    status: battle.status,
    turn_index: battle.turn_index,
    turn_deadline_at: battle.turn_deadline_at,
    viewer_side: battle.viewer_side,
    vitals: side
      ? {
          hp: side.hp,
          max_hp: side.max_hp,
          energy: side.energy,
          focus_stack: side.focus_stack,
          timeout_count: side.timeout_count,
        }
      : null,
    base_actions: [
      { kind: "strike", effect: "damage, +1 energy" },
      { kind: "guard", effect: "damage reduction, +1 energy" },
      { kind: "focus", effect: "+2 energy and focus stack" },
    ],
    skills,
    recommendation,
    command: `battle_action with kind=${recommendation.kind}${recommendation.skill_id ? ` skill_id=${recommendation.skill_id}` : ""}`,
  };
}

function recommendedNextAction(home) {
  if (!home.pet) {
    return {
      title: "Create your first official pet",
      reason: "Official League actions need a server-registered pet.",
      command: "pet_import_hatch with package_path",
    };
  }
  const battle = home.matchmaking?.active_battles?.[0];
  if (battle?.status === "in_progress") {
    const recommendation = recommendBattleAction(battle);
    return {
      title: "Take the current battle turn",
      reason: recommendation.reason,
      command: "battle_action",
      battle_id: battle.id,
      kind: recommendation.kind,
      skill_id: recommendation.skill_id ?? null,
    };
  }
  const ticket = home.matchmaking?.tickets?.find((entry) => entry.status === "waiting") ?? home.matchmaking?.tickets?.[0];
  if (ticket) {
    return {
      title: "Stay in queue",
      reason: `Waiting in ${ticket.mode} ${ticket.battle_class}; search window is ±${ticket.search_window_lp ?? "?"} LP.`,
      command: "matchmaking_status",
    };
  }
  if (Number(home.xpStatus?.remaining?.trainingReports ?? 0) > 0 && Number(home.xpStatus?.remaining?.training ?? 0) > 0) {
    return {
      title: "Submit today's Codex work",
      reason: `${home.xpStatus.remaining.trainingReports} Training Report slot(s) and ${home.xpStatus.remaining.training} Training XP remain today.`,
      command: "training_report_draft",
    };
  }
  if (Number(home.xpStatus?.remaining?.battle ?? 0) > 0) {
    return {
      title: "Play a 30-second turn battle",
      reason: `${home.xpStatus.remaining.battle} Battle XP remains today.`,
      command: "matchmaking_join",
      mode: "ranked",
    };
  }
  return {
    title: "Check profile and replays",
    reason: "Daily XP is mostly capped; profile/replays are the clean next review loop.",
    command: "pet_profile",
  };
}

function recommendBattleAction(battle, rules = {}) {
  const side = viewerSide(battle);
  const opponent = battle?.viewer_side === "opponent" ? battle.sides?.player : battle?.sides?.opponent;
  if (!side) return { kind: "strike", reason: "No viewer side was present, so strike is the safest default." };
  const hpRatio = Number(side.hp ?? 0) / Math.max(1, Number(side.max_hp ?? 1));
  const opponentRatio = Number(opponent?.hp ?? 0) / Math.max(1, Number(opponent?.max_hp ?? 1));
  const skillsById = new Map((rules.skills ?? []).map((skill) => [skill.id, skill]));
  const skill = bestReadySkill(side, opponentRatio, skillsById);
  if (hpRatio <= 0.32) return { kind: "guard", reason: "Your HP is low; guard reduces damage and still gains energy." };
  if (skill) return { kind: "skill", skill_id: skill.id, reason: `${skill.role} skill is available with enough energy.` };
  if (Number(side.energy ?? 0) < 2) return { kind: "focus", reason: "Energy is low; focus builds energy fastest." };
  return { kind: "strike", reason: "No urgent defensive or energy need; strike is reliable damage and gains energy." };
}

function bestReadySkill(side, opponentHpRatio, skillsById) {
  const ready = (side.skills ?? [])
    .map((id) => skillsById.get(id) ?? inferSkillFromId(id))
    .filter((skill) => skill && Number(side.energy ?? 0) >= skillCost(skill.role));
  return (
    ready.find((skill) => skill.role === "finisher" && opponentHpRatio <= 0.38) ??
    ready.find((skill) => skill.role === "offense") ??
    ready.find((skill) => skill.role === "tempo") ??
    ready.find((skill) => skill.role === "status") ??
    null
  );
}

function inferSkillFromId(id) {
  const role = String(id ?? "").split("_").at(-1);
  if (!role) return null;
  return { id, role };
}

function skillCost(role) {
  return role === "finisher" ? 4 : 2;
}

function viewerSide(battle) {
  if (!battle?.sides) return null;
  return battle.viewer_side === "opponent" ? battle.sides.opponent : battle.sides.player;
}

function summarizePet(pet) {
  return {
    id: pet.id,
    name: pet.name,
    is_active: Boolean(pet.is_active),
    level: pet.level,
    battle_class: pet.battle_class,
    primary_element: pet.primary_element,
    secondary_element: pet.secondary_element,
    rank: pet.rating?.label,
    lp: pet.rating?.lp,
    stats_total: pet.stats?.total,
    asset: pet.asset
      ? {
          id: pet.asset.id,
          source: pet.asset.hatch_source ?? pet.asset.asset_kind ?? null,
          hatch_pet_id: pet.asset.hatch_pet_json?.id ?? null,
          source_fingerprint: pet.asset.source_fingerprint ?? null,
          atlas_url: pet.asset.atlas_url ?? null,
        }
      : null,
  };
}

function summarizeHatchPackage(entry) {
  return {
    id: entry.manifest.id,
    display_name: entry.manifest.displayName,
    description: entry.manifest.description,
    package_dir: entry.package_dir,
    spritesheet: entry.spritesheet_path,
    format: entry.image.format,
    dimensions: `${entry.image.width}x${entry.image.height}`,
    manifest_sha256: entry.manifest_sha256,
    spritesheet_sha256: entry.spritesheet_sha256,
    package_fingerprint: entry.package_fingerprint,
    updated_at: entry.updated_at,
  };
}

function summarizeLoadedHatchPackage(hatch) {
  return {
    id: hatch.manifest.id,
    display_name: hatch.manifest.displayName,
    description: hatch.manifest.description,
    package_dir: hatch.package_dir,
    spritesheet: hatch.spritesheet_path,
    format: hatch.image.format,
    dimensions: `${hatch.image.width}x${hatch.image.height}`,
    contract: hatch.atlas_contract,
    manifest_sha256: hatch.manifest_sha256,
    spritesheet_sha256: hatch.spritesheet_sha256,
    package_fingerprint: hatch.package_fingerprint,
    server_source: "openai_hatch_pet",
    import_with: {
      tool: "pet_import_hatch",
      package_path: hatch.package_dir,
      primary_element: "Forge",
      secondary_element: "Trace",
    },
  };
}

function summarizeAssetImport(asset, hatch) {
  return {
    id: asset.id,
    hatch_pet_id: hatch.manifest.id,
    source: asset.hatch_source,
    atlas_sha256: asset.atlas_sha256,
    hatch_manifest_sha256: asset.hatch_manifest_sha256,
    source_fingerprint: asset.source_fingerprint,
    package_fingerprint: hatch.package_fingerprint,
    duplicate_source_accounts: asset.duplicate_source_accounts ?? [],
  };
}

function doctorWarnings({ health, providers, bridge }) {
  const warnings = [];
  if (!health || health.status !== "ok") warnings.push("server health is not ok");
  if ((providers?.provider ?? health?.auth_provider?.provider) === "local_dev") {
    warnings.push("auth is local_dev; configure real passkey, email, or OAuth before production");
  }
  if (bridge?.hmac_bridge_secret === "missing") warnings.push("CODEX_PET_BRIDGE_SECRET is missing");
  if (bridge?.codex_app_attestation_secret === "missing") warnings.push("CODEX_PET_BRIDGE_ATTESTATION_SECRET is missing");
  if (bridge?.replay_signing_secret === "local_dev") warnings.push("CODEX_PET_REPLAY_SIGNING_SECRET is using the local dev fallback");
  if (health?.storage?.driver === "json") warnings.push("JSON storage is for local development; keep Postgres for production last");
  if (health?.realtime?.provider === "local") warnings.push("local realtime bus is single-instance only");
  if (health?.request_guard?.provider === "local") warnings.push("local request guard does not share rate limits across server instances");
  if (health?.locks?.provider === "local") warnings.push("local locks do not serialize multiple server instances");
  return warnings;
}

function summarizeMatchmaking(matchmaking) {
  return {
    tickets: matchmaking?.tickets ?? [],
    active_battles: (matchmaking?.active_battles ?? []).map((battle) => ({
      id: battle.id,
      mode: battle.mode,
      status: battle.status,
      viewer_side: battle.viewer_side,
      turn_index: battle.turn_index,
      turn_deadline_at: battle.turn_deadline_at,
    })),
  };
}

async function optional(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
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
