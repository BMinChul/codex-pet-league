#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { buildSignalsFromWorkspace } from "./signals.js";
import hatchPackage from "../hatchPackage.cjs";

const DEFAULT_BASE_URL = process.env.CODEX_PET_LEAGUE_URL ?? "http://localhost:4317";
const DEFAULT_ACCOUNT_ID = process.env.CODEX_PET_ACCOUNT_ID ?? "acct_demo";
const DEFAULT_SESSION_TOKEN = process.env.CODEX_PET_SESSION_TOKEN ?? process.env.LEAGUE_SESSION_TOKEN ?? "";
const DEFAULT_BRIDGE_SECRET = process.env.CODEX_PET_BRIDGE_SECRET ?? "";
const DEFAULT_BRIDGE_ATTESTATION_SECRET = process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET ?? "";
const { discoverHatchPetPackages, loadHatchPetPackage } = hatchPackage;

const [, , ...argv] = process.argv;

main(argv).catch((error) => {
  console.error(`codexpet: ${error.message}`);
  process.exitCode = 1;
});

async function main(args) {
  const parsed = parseArgs(args);
  const [area, action] = parsed.positionals;

  if (!area || area === "help" || parsed.flags.help) {
    printHelp();
    return;
  }

  const client = createApiClient(parsed.flags.url ?? DEFAULT_BASE_URL, {
    accountId: parsed.flags.account ?? DEFAULT_ACCOUNT_ID,
    sessionToken: parsed.flags.sessionToken ?? DEFAULT_SESSION_TOKEN,
  });

  if (area === "home" || area === "status") {
    const home = await buildLeagueHome(client, parsed.flags.pet);
    printLeagueHome(home);
    return;
  }

  if (area === "daily") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const status = await client.get(`/api/pets/${pet.id}/xp-status`);
    printDailyStatus(status);
    return;
  }

  if (area === "next" || area === "play") {
    const home = await buildLeagueHome(client, parsed.flags.pet);
    printNextAction(home);
    return;
  }

  if (area === "auth" && action === "challenge") {
    const result = await client.post("/api/auth/challenge", {
      method: parsed.flags.method ?? "email_magic_link",
      identifier: parsed.flags.identifier ?? parsed.flags.email ?? "local@example.test",
    });
    printObject(result);
    return;
  }

  if (area === "auth" && action === "verify") {
    if (!parsed.flags.challenge) throw new Error("Pass --challenge challenge_id");
    if (!parsed.flags.code) throw new Error("Pass --code verification_code");
    const result = await client.post("/api/auth/verify", {
      challenge_id: parsed.flags.challenge,
      code: String(parsed.flags.code),
    });
    printObject({
      account: result.account,
      session_token: result.session_token,
      export_hint: "Set CODEX_PET_SESSION_TOKEN to this value for official League requests.",
    });
    return;
  }

  if (area === "session") {
    if (action === "list") {
      const sessions = await client.get("/api/sessions");
      printObject(sessions);
      return;
    }
    if (action === "revoke") {
      const result = await client.post("/api/sessions/revoke", {
        token: parsed.flags.token ?? parsed.flags.sessionToken,
        session_id: parsed.flags.session,
      });
      printObject(result);
      return;
    }
    const session = await client.get("/api/session");
    printObject(session.account);
    return;
  }

  if (area === "rules") {
    const rules = await client.get("/api/rules");
    printObject({
      elements: rules.elements,
      skillCount: rules.skills.length,
      caps: rules.caps,
      matchmakingPolicy: rules.matchmakingPolicy,
      level100Xp: rules.level100Xp,
      level100FastestDaysAtCap: rules.level100FastestDaysAtCap,
    });
    return;
  }

  if (area === "league") {
    const league = await client.get("/api/league");
    printObject(league);
    return;
  }

  if (area === "pets" || (area === "pet" && action === "list")) {
    await listPets(client);
    return;
  }

  if (area === "pet" && action === "discover-hatch") {
    await discoverHatchPets(parsed.flags);
    return;
  }

  if (area === "pet" && (action === "create" || action === "import-hatch")) {
    await createPet(client, parsed.flags, { importHatch: action === "import-hatch" });
    return;
  }

  if (area === "pet" && action === "activate") {
    const petId = parsed.flags.pet ?? parsed.flags.id;
    if (!petId) throw new Error("Pass --pet pet_id");
    const result = await client.post(`/api/pets/${petId}/activate`, {});
    console.log(`Active pet: ${result.pet.name}`);
    printObject({ active_pet_id: result.active_pet_id, pet: summarizePet(result.pet) });
    return;
  }

  if (area === "pet" && action === "profile") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.get(`/api/public/pets/${pet.id}`);
    printObject(result);
    return;
  }

  if (area === "pet" && action === "loadout") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const skills = String(parsed.flags.skills ?? "")
      .split(",")
      .map((skill) => skill.trim())
      .filter(Boolean);
    const aliases = parseAliases(parsed.flags.aliases ?? "");
    const result = await client.put(`/api/pets/${pet.id}/loadout`, {
      skills: skills.length ? skills : pet.skills.map((skill) => skill.id),
      aliases,
    });
    printObject(result.pet);
    return;
  }

  if (area === "pet" && action === "replays") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.get(`/api/pets/${pet.id}/replays`);
    printObject(result);
    return;
  }

  if (area === "xp" && action === "status") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const status = await client.get(`/api/pets/${pet.id}/xp-status`);
    printXpStatus(status);
    return;
  }

  if (area === "report" && action === "draft") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const signals = buildSignalsFromWorkspace({ flags: signalFlags(parsed.flags) });
    const draft = await client.post(`/api/pets/${pet.id}/training-reports/draft`, { signals });
    printTrainingDraft(draft.draft);
    return;
  }

  if (area === "report" && action === "submit") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const signals = buildSignalsFromWorkspace({ flags: signalFlags(parsed.flags) });
    const draft = await client.post(`/api/pets/${pet.id}/training-reports/draft`, { signals });
    const result = await client.post(`/api/pets/${pet.id}/training-reports`, {
      client_report_id: parsed.flags.idempotencyKey ?? randomUUID(),
      draft_id: draft.draft.id,
      draft_nonce: draft.draft.nonce,
      signals,
    });
    printTrainingSubmit(result);
    return;
  }

  if (area === "battle" && action === "simulate") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.post(`/api/pets/${pet.id}/battles/simulate`, {
      mode: parsed.flags.mode ?? "casual",
      result: parsed.flags.result ?? "win",
      opponent_lp: Number(parsed.flags.opponentLp ?? parsed.flags["opponent-lp"] ?? 1500),
    });
    printObject({
      battle: result.battle,
      pet: summarizePet(result.pet),
      counters: result.counters,
    });
    return;
  }

  if (area === "battle" && action === "start") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.post(`/api/pets/${pet.id}/battles`, {
      mode: parsed.flags.mode ?? "casual",
      opponent_lp: Number(parsed.flags.opponentLp ?? parsed.flags["opponent-lp"] ?? 1500),
    });
    printTurnBattle(result.battle);
    return;
  }

  if (area === "battle" && action === "get") {
    if (!parsed.flags.battle) throw new Error("Pass --battle battle_room_id");
    const result = await client.get(`/api/battles/${parsed.flags.battle}`);
    printTurnBattle(result.battle);
    return;
  }

  if (area === "battle" && action === "actions") {
    if (!parsed.flags.battle) throw new Error("Pass --battle battle_room_id");
    const [result, rules] = await Promise.all([
      client.get(`/api/battles/${parsed.flags.battle}`),
      optional(client.get("/api/rules")),
    ]);
    printBattleActionOptions(result.battle, rules);
    return;
  }

  if (area === "battle" && action === "watch") {
    await watchBattle(client, parsed.flags);
    return;
  }

  if (area === "battle" && action === "play") {
    await playBattle(client, parsed.flags);
    return;
  }

  if (area === "battle" && action === "action") {
    if (!parsed.flags.battle) throw new Error("Pass --battle battle_room_id");
    const current = await client.get(`/api/battles/${parsed.flags.battle}`);
    const result = await client.post(`/api/battles/${parsed.flags.battle}/actions`, {
      kind: parsed.flags.kind ?? "strike",
      skill_id: parsed.flags.skill,
      turn_index: parsed.flags.turnIndex ?? current.battle.turn_index,
      turn_nonce: parsed.flags.turnNonce ?? current.battle.turn_nonce,
      source: "cli",
    });
    printTurnBattle(result.battle);
    return;
  }

  if (area === "queue" && action === "join") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.post(`/api/pets/${pet.id}/matchmaking/queue`, {
      mode: parsed.flags.mode ?? "ranked",
    });
    printMatchmaking(result);
    return;
  }

  if (area === "queue" && action === "status") {
    const query = parsed.flags.pet ? `?pet_id=${encodeURIComponent(parsed.flags.pet)}` : "";
    const result = await client.get(`/api/matchmaking/status${query}`);
    printObject(result);
    return;
  }

  if (area === "queue" && action === "cancel") {
    if (!parsed.flags.ticket) throw new Error("Pass --ticket ticket_id");
    const result = await client.post("/api/matchmaking/cancel", { ticket_id: parsed.flags.ticket });
    printObject(result);
    return;
  }

  if (area === "audit") {
    const result = await client.get("/api/admin/audit");
    printObject(result);
    return;
  }

  if (area === "invite" && action === "create") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const result = await client.post(`/api/pets/${pet.id}/friend-invites`, {});
    console.log(`Invite code: ${result.invite.code}`);
    printObject(result.invite);
    return;
  }

  if (area === "invite" && action === "accept") {
    const pet = await resolvePet(client, parsed.flags.pet);
    const code = parsed.flags.code;
    if (!code) throw new Error("Pass --code invite_code");
    const result = await client.post(`/api/pets/${pet.id}/friend-invites/accept`, { code });
    printMatchmaking(result);
    return;
  }

  if (area === "leaderboard") {
    const board = await client.get("/api/leaderboard");
    printLeaderboard(board.leaderboard);
    return;
  }

  throw new Error(`Unknown command: ${[area, action].filter(Boolean).join(" ")}`);
}

async function buildLeagueHome(client, petId = null) {
  const [session, league, petsResult, boardResult] = await Promise.all([
    optional(client.get("/api/session")),
    optional(client.get("/api/league")),
    optional(client.get("/api/pets"), { pets: [] }),
    optional(client.get("/api/leaderboard"), { leaderboard: [] }),
  ]);
  const pets = petsResult?.pets ?? [];
  const pet = petId ? pets.find((entry) => entry.id === petId) : pets[0];
  if (petId && !pet) throw new Error(`Pet not found: ${petId}`);
  const [xpStatus, matchmaking] = await Promise.all([
    pet ? optional(client.get(`/api/pets/${pet.id}/xp-status`)) : null,
    optional(client.get(`/api/matchmaking/status${pet ? `?pet_id=${encodeURIComponent(pet.id)}` : ""}`)),
  ]);
  return {
    session,
    league,
    pets,
    pet,
    xpStatus,
    matchmaking,
    leaderboard: boardResult?.leaderboard ?? [],
  };
}

async function resolveBattleId(client, flags = {}) {
  if (flags.battle) return flags.battle;
  const pet = flags.pet ? await resolvePet(client, flags.pet) : null;
  const suffix = pet ? `?pet_id=${encodeURIComponent(pet.id)}` : "";
  const matchmaking = await client.get(`/api/matchmaking/status${suffix}`);
  const active = matchmaking.active_battles?.[0];
  if (active?.id) return active.id;
  throw new Error("No active battle found. Pass --battle battle_room_id or start/join a battle first.");
}

async function listPets(client) {
  const result = await client.get("/api/pets");
  if (result.pets.length === 0) {
    console.log("No pets registered. Run: codexpet pet import-hatch");
    return;
  }
  for (const pet of result.pets) {
    const marker = pet.is_active ? "*" : " ";
    console.log(`${marker} ${pet.id}  ${pet.name}  Lv ${pet.level}  ${pet.battle_class}  ${pet.rating.label} ${pet.rating.lp} LP`);
  }
}

async function discoverHatchPets(flags = {}) {
  const packages = await discoverHatchPetPackages({ root: flags.root ?? flags.path });
  if (!packages.length) {
    console.log("No hatch-pet packages found.");
    return;
  }
  printObject({
    count: packages.length,
    packages: packages.map((entry) => ({
      id: entry.manifest.id,
      display_name: entry.manifest.displayName,
      description: entry.manifest.description,
      package_dir: entry.package_dir,
      spritesheet: entry.spritesheet_path,
      format: entry.image.format,
      updated_at: entry.updated_at,
    })),
  });
}

async function createPet(client, flags, options = {}) {
  const hatchPath = flags.hatch ?? flags.hatchDir ?? flags.path ?? flags.package;
  if (options.importHatch || hatchPath) {
    const hatch = await loadHatchPetPackage(hatchPath, {
      root: flags.root,
    });
    const asset = await client.post("/api/pet-assets/uploads", {
      appearance: hatch.appearance,
      atlas_data_url: hatch.data_url,
      hatch_pet_manifest: hatch.manifest,
      hatch_source: "openai_hatch_pet",
    });
    const pet = await client.post("/api/pets", {
      name: flags.name ?? hatch.manifest.displayName,
      pet_asset_id: asset.asset.id,
      primary_element: flags.primary ?? "Forge",
      secondary_element: flags.secondary ?? "Trace",
    });
    console.log(`Imported hatch-pet ${hatch.manifest.displayName}`);
    printObject({
      pet_id: pet.pet.id,
      asset_id: asset.asset.id,
      hatch_pet_id: hatch.manifest.id,
      spritesheet: hatch.spritesheet_path,
      format: hatch.image.format,
      active: Boolean(pet.pet.is_active),
      level: pet.pet.level,
      battle_class: pet.pet.battle_class,
      rank: `${pet.pet.rating.label} ${pet.pet.rating.lp} LP`,
    });
    return;
  }

  const atlasDataUrl = flags.atlas ? await imageDataUrl(flags.atlas) : null;
  const asset = await client.post("/api/pet-assets/uploads", {
    appearance: {
      source: "codexpet_cli",
      file: flags.atlas ? basename(flags.atlas) : null,
    },
    atlas_data_url: atlasDataUrl,
  });
  const pet = await client.post("/api/pets", {
    name: flags.name ?? "Codex Pet",
    pet_asset_id: asset.asset.id,
    primary_element: flags.primary ?? "Forge",
    secondary_element: flags.secondary ?? "Trace",
  });
  console.log(`Created ${pet.pet.name}`);
  printObject({
    pet_id: pet.pet.id,
    asset_id: asset.asset.id,
    level: pet.pet.level,
    battle_class: pet.pet.battle_class,
    rank: `${pet.pet.rating.label} ${pet.pet.rating.lp} LP`,
  });
}

async function resolvePet(client, petId) {
  const result = await client.get("/api/pets");
  if (petId) {
    const pet = result.pets.find((entry) => entry.id === petId);
    if (!pet) throw new Error(`Pet not found: ${petId}`);
    return pet;
  }
  if (!result.pets[0]) throw new Error("No pets registered. Run: codexpet pet import-hatch");
  return result.pets.find((entry) => entry.id === result.active_pet_id) ?? result.pets.find((entry) => entry.is_active) ?? result.pets[0];
}

function createApiClient(baseUrl, auth) {
  const root = baseUrl.replace(/\/$/, "");
  return {
    get(path) {
      return request(root, auth, "GET", path);
    },
    post(path, body) {
      return request(root, auth, "POST", path, body);
    },
    put(path, body) {
      return request(root, auth, "PUT", path, body);
    },
  };
}

async function request(root, auth, method, path, body) {
  const headers = { "content-type": "application/json" };
  const guardedBody = body && method !== "GET" ? { ...body, request_id: body.request_id ?? body.idempotency_key ?? randomUUID() } : body;
  const bodyText = guardedBody ? JSON.stringify(guardedBody) : undefined;
  if (auth.sessionToken) {
    headers["x-league-session-token"] = auth.sessionToken;
  } else {
    headers["x-league-account-id"] = auth.accountId;
  }
  if (DEFAULT_BRIDGE_SECRET && bodyText) {
    headers["x-league-bridge-signature"] = createHmac("sha256", DEFAULT_BRIDGE_SECRET).update(bodyText).digest("hex");
  }
  if (DEFAULT_BRIDGE_ATTESTATION_SECRET && bodyText) {
    headers["x-codex-app-attestation"] = createHmac("sha256", DEFAULT_BRIDGE_ATTESTATION_SECRET).update(bodyText).digest("hex");
  }
  const response = await fetch(`${root}${path}`, {
    method,
    headers,
    body: bodyText,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `${method} ${path} failed`);
  }
  return payload;
}

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const [key, inlineValue] = raw.split("=", 2);
    if (inlineValue !== undefined) {
      flags[camel(key)] = coerce(inlineValue);
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[camel(key)] = coerce(next);
      i += 1;
    } else {
      flags[camel(key)] = true;
    }
  }
  return { flags, positionals };
}

function signalFlags(flags) {
  return {
    implementationActivity: flags.implementation,
    debuggingActivity: flags.debugging,
    verificationActivity: flags.verification,
    docsActivity: flags.docs,
    releaseActivity: flags.release,
    quickIterationActivity: flags.quick,
    milestone: flags.milestone,
    testsRun: flags.testsRun,
    filesChangedBucket: flags.files,
  };
}

async function imageDataUrl(path) {
  const bytes = await readFile(path);
  const mime = String(path).toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function printLeagueHome(home) {
  const account = home.session?.account;
  console.log("Codex Pet League");
  console.log(`Account: ${account?.display_name ?? account?.email ?? account?.id ?? "development fallback"}`);
  const season = home.league?.active_season ?? home.league?.season;
  if (season) {
    console.log(`Season: ${season.name ?? season.id} · ${season.status} · ends ${formatDate(season.ends_at)}`);
  }
  if (!home.pet) {
    console.log("Pet: none registered");
    console.log("Next: codexpet pet import-hatch --primary Forge --secondary Trace");
    return;
  }
  console.log(
    `Pet: ${home.pet.name} · Lv ${home.pet.level} · ${home.pet.battle_class} · ${home.pet.rating.label} ${home.pet.rating.lp} LP`,
  );
  if (home.xpStatus) {
    console.log(
      `Today XP: pet ${home.xpStatus.status_text.pet}, training ${home.xpStatus.status_text.training}, battle ${home.xpStatus.status_text.battle}`,
    );
    console.log(`Remaining: pet ${home.xpStatus.remaining.pet}, reports ${home.xpStatus.remaining.trainingReports}/3`);
  }
  const tickets = home.matchmaking?.tickets ?? [];
  const battles = home.matchmaking?.active_battles ?? [];
  if (battles.length) {
    console.log(`Active battle: ${battles[0].id} · turn ${battles[0].turn_index}`);
  } else if (tickets.length) {
    console.log(`Queue: ${tickets[0].mode} · ${tickets[0].battle_class} · window ±${tickets[0].search_window_lp}`);
  } else {
    console.log("Queue: idle");
  }
  const top = home.leaderboard?.[0];
  if (top) console.log(`Leaderboard #1: ${top.name} · ${top.tier_label} · ${top.lp} LP`);
  const next = recommendedNextAction(home);
  console.log(`Next: ${next.command}`);
}

function printXpStatus(status) {
  console.log(`${status.pet.name} · Lv ${status.pet.level} · ${status.pet.battle_class} · ${status.pet.rating.label}`);
  console.log(`Pet XP: ${status.status_text.pet}`);
  console.log(`Training XP: ${status.status_text.training}`);
  console.log(`Battle XP: ${status.status_text.battle}`);
  console.log(`Friend XP: ${status.status_text.friend}`);
  console.log(`Training Reports: ${status.status_text.reports}`);
  console.log(`Style XP: ${status.status_text.style}`);
  console.log(`Weekly Style XP: ${status.status_text.weeklyStyle}`);
  console.log(`Daily reset: ${new Date(status.reset_at).toLocaleString()}`);
}

function printDailyStatus(status) {
  console.log(`${status.pet.name} daily progress`);
  console.log(`Pet XP remaining: ${status.remaining.pet} / ${status.caps.petDaily}`);
  console.log(`Training XP remaining: ${status.remaining.training} / ${status.caps.trainingDaily}`);
  console.log(`Battle XP remaining: ${status.remaining.battle} / ${status.caps.battleDaily}`);
  console.log(`Friend XP remaining: ${status.remaining.friend} / ${status.caps.friendDaily}`);
  console.log(`Style XP remaining: ${status.remaining.style} today, ${status.remaining.weeklyStyle} this week`);
  console.log(`Training Reports left: ${status.remaining.trainingReports} / ${status.caps.petEligibleTrainingReportsDaily}`);
  console.log(`Reset: ${new Date(status.reset_at).toLocaleString()}`);
}

function printTrainingDraft(draft) {
  console.log(`Draft: ${draft.report_type} · ${draft.element_signal} · quality ${draft.quality_score}`);
  console.log(`Pet XP preview: ${draft.award_preview.petXpApplied}`);
  console.log(`Style XP preview: ${draft.award_preview.styleXpApplied}`);
  console.log(`Reports today: ${draft.status_text.reports}`);
  console.log("Submit with: codexpet report submit");
}

function printTrainingSubmit(result) {
  if (result.duplicate) {
    console.log(`Duplicate report ignored: ${result.report.id}`);
    return;
  }
  console.log(`Submitted ${result.report.report_type} report for ${result.pet.name}`);
  console.log(`Pet XP +${result.report.pet_xp_delta}, Style XP +${result.report.style_xp_delta}`);
  console.log(`Now Lv ${result.pet.level}, ${result.pet.battle_class}, total stats ${result.pet.stats.total}`);
  console.log(`Reports today: ${result.counters.trainingReportsUsed} / 3`);
}

function printLeaderboard(rows) {
  for (const row of rows) {
    console.log(`#${row.rank} ${row.name} · ${row.battle_class} · ${row.tier_label} · ${row.lp} LP · ${row.wins}/${row.losses}/${row.draws}`);
  }
}

function printNextAction(home) {
  const next = recommendedNextAction(home);
  console.log(next.title);
  console.log(next.reason);
  console.log(next.command);
}

function recommendedNextAction(home) {
  if (!home.pet) {
    return {
      title: "Create your first official pet",
      reason: "Official League actions need a server-registered pet.",
      command: "codexpet pet import-hatch --primary Forge --secondary Trace",
    };
  }
  const battle = home.matchmaking?.active_battles?.[0];
  if (battle?.status === "in_progress") {
    const recommendation = recommendBattleAction(battle);
    return {
      title: "Take the current battle turn",
      reason: recommendation.reason,
      command: `codexpet battle action --battle ${battle.id} --kind ${recommendation.kind}${recommendation.skillId ? ` --skill ${recommendation.skillId}` : ""}`,
    };
  }
  const ticket = home.matchmaking?.tickets?.find((entry) => entry.status === "waiting") ?? home.matchmaking?.tickets?.[0];
  if (ticket) {
    return {
      title: "Stay in queue",
      reason: `Waiting in ${ticket.mode} ${ticket.battle_class}; search window is ±${ticket.search_window_lp ?? "?"} LP.`,
      command: `codexpet queue status --pet ${home.pet.id}`,
    };
  }
  if (Number(home.xpStatus?.remaining?.trainingReports ?? 0) > 0 && Number(home.xpStatus?.remaining?.training ?? 0) > 0) {
    return {
      title: "Submit today's Codex work",
      reason: `${home.xpStatus.remaining.trainingReports} Training Report slot(s) and ${home.xpStatus.remaining.training} Training XP remain today.`,
      command: `codexpet report draft --pet ${home.pet.id} --implementation --verification --tests-run 3`,
    };
  }
  if (Number(home.xpStatus?.remaining?.battle ?? 0) > 0) {
    return {
      title: "Play a 30-second turn battle",
      reason: `${home.xpStatus.remaining.battle} Battle XP remains today.`,
      command: `codexpet queue join --pet ${home.pet.id} --mode ranked`,
    };
  }
  return {
    title: "Check profile and replays",
    reason: "Daily XP is mostly capped; profile/replays are the clean next review loop.",
    command: `codexpet pet profile --pet ${home.pet.id}`,
  };
}

function printTurnBattle(battle) {
  const ownSide = battle.viewer_side === "opponent" ? battle.sides.opponent : battle.sides.player;
  const otherSide = battle.viewer_side === "opponent" ? battle.sides.player : battle.sides.opponent;
  console.log(`${battle.id} · ${battle.mode} · ${battle.status} · turn ${battle.turn_index}`);
  console.log(`You: ${ownSide.hp}/${ownSide.max_hp} HP, energy ${ownSide.energy}, AFK ${ownSide.timeout_count}/3`);
  console.log(`${otherSide.name}: ${otherSide.hp}/${otherSide.max_hp} HP, energy ${otherSide.energy}`);
  if (battle.status === "in_progress") {
    console.log(`Deadline: ${new Date(battle.turn_deadline_at).toLocaleTimeString()}`);
    console.log("Action: codexpet battle action --battle <id> --kind strike");
  } else {
    console.log(`Result: ${battle.result.result} · replay ${battle.replay_hash}`);
  }
  if (battle.log.at(-1)) printObject({ latest_turn: battle.log.at(-1) });
}

function printBattleActionOptions(battle, rules = null) {
  const ownSide = battle.viewer_side === "opponent" ? battle.sides.opponent : battle.sides.player;
  const recommendation = recommendBattleAction(battle, rules);
  console.log(`${battle.id} · ${battle.status} · turn ${battle.turn_index}`);
  if (battle.status !== "in_progress") {
    console.log(`Finished: ${battle.result?.result ?? battle.status}`);
    return;
  }
  console.log(`Deadline: ${new Date(battle.turn_deadline_at).toLocaleTimeString()}`);
  console.log(`Recommended: ${recommendation.kind}${recommendation.skillId ? ` (${recommendation.skillId})` : ""} · ${recommendation.reason}`);
  console.log("Base actions:");
  console.log("  strike · damage, +1 energy");
  console.log("  guard  · reduce incoming damage, +1 energy");
  console.log("  focus  · +2 energy and focus stack");
  const skillsById = new Map((rules?.skills ?? []).map((skill) => [skill.id, skill]));
  console.log("Skills:");
  for (const skillId of ownSide.skills ?? []) {
    const skill = skillsById.get(skillId);
    const cost = skillCost(skill?.role);
    const alias = ownSide.skill_aliases?.[skillId];
    const label = alias ? `${alias} / ${skill?.officialName ?? skillId}` : skill?.officialName ?? skillId;
    const ready = Number(ownSide.energy ?? 0) >= cost ? "ready" : `needs ${cost} energy`;
    console.log(`  ${skillId} · ${label} · ${skill?.role ?? "skill"} · ${ready}`);
  }
  console.log(
    `Command: codexpet battle action --battle ${battle.id} --kind ${recommendation.kind}${recommendation.skillId ? ` --skill ${recommendation.skillId}` : ""}`,
  );
}

async function watchBattle(client, flags = {}) {
  const battleId = await resolveBattleId(client, flags);
  const intervalMs = Math.max(500, Number(flags.interval ?? 1000));
  if (!flags.once && !output.isTTY) {
    throw new Error("battle watch needs a TTY. Use --once for a single non-interactive snapshot.");
  }

  for (;;) {
    const [result, rules] = await Promise.all([
      client.get(`/api/battles/${battleId}`),
      optional(client.get("/api/rules")),
    ]);
    if (!flags.once) clearTerminal();
    printTerminalBattle(result.battle, rules);
    if (flags.once || result.battle.status === "finished") return;
    await sleep(intervalMs);
  }
}

async function playBattle(client, flags = {}) {
  const battleId = await resolveBattleId(client, flags);
  const rules = await optional(client.get("/api/rules"));
  if (flags.auto || !input.isTTY || !output.isTTY) {
    const result = await client.get(`/api/battles/${battleId}`);
    if (result.battle.status !== "in_progress") {
      printTerminalBattle(result.battle, rules);
      return;
    }
    const action = actionFromRecommendation(result.battle, rules);
    const submitted = await submitBattleTurn(client, result.battle, action);
    printTerminalBattle(submitted.battle, rules);
    console.log(`Submitted: ${action.kind}${action.skill_id ? ` ${action.skill_id}` : ""}`);
    if (!flags.auto && (!input.isTTY || !output.isTTY)) {
      console.log("Tip: run in a real terminal for interactive controls, or pass --auto from Codex sessions.");
    }
    return;
  }

  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const [result, latestRules] = await Promise.all([
        client.get(`/api/battles/${battleId}`),
        optional(client.get("/api/rules"), rules),
      ]);
      clearTerminal();
      printTerminalBattle(result.battle, latestRules);
      if (result.battle.status !== "in_progress") return;

      const answer = (await rl.question("Action [s]trike [g]uard [f]ocus s[k]ill [a]uto [r]efresh [q]uit > ")).trim().toLowerCase();
      if (["q", "quit", "exit"].includes(answer)) return;
      if (["", "r", "refresh"].includes(answer)) continue;

      const action = await actionFromInput(answer, result.battle, latestRules, rl);
      if (!action) continue;
      try {
        const submitted = await submitBattleTurn(client, result.battle, action);
        if (submitted.battle?.status === "finished") {
          clearTerminal();
          printTerminalBattle(submitted.battle, latestRules);
          return;
        }
      } catch (error) {
        console.log(`Action failed: ${error.message}`);
        await rl.question("Press Enter to refresh.");
      }
    }
  } finally {
    rl.close();
  }
}

async function actionFromInput(answer, battle, rules, rl) {
  if (["s", "strike"].includes(answer)) return { kind: "strike" };
  if (["g", "guard"].includes(answer)) return { kind: "guard" };
  if (["f", "focus"].includes(answer)) return { kind: "focus" };
  if (["a", "auto"].includes(answer)) return actionFromRecommendation(battle, rules);
  if (["k", "skill"].includes(answer)) {
    const ownSide = viewerSide(battle);
    const skills = ownSide.skills ?? [];
    if (!skills.length) {
      console.log("No equipped skills.");
      return null;
    }
    const skillsById = new Map((rules?.skills ?? []).map((skill) => [skill.id, skill]));
    console.log("Skills:");
    skills.forEach((skillId, index) => {
      const skill = skillsById.get(skillId) ?? inferSkillFromId(skillId);
      const alias = ownSide.skill_aliases?.[skillId];
      const label = alias ? `${alias} / ${skill?.officialName ?? skillId}` : skill?.officialName ?? skillId;
      const ready = Number(ownSide.energy ?? 0) >= skillCost(skill?.role) ? "ready" : `needs ${skillCost(skill?.role)} energy`;
      console.log(`  ${index + 1}. ${skillId} · ${label} · ${skill?.role ?? "skill"} · ${ready}`);
    });
    const choice = (await rl.question("Skill number or id > ")).trim();
    const selected = /^\d+$/.test(choice) ? skills[Number(choice) - 1] : choice;
    if (!skills.includes(selected)) {
      console.log("Skill not equipped.");
      return null;
    }
    return { kind: "skill", skill_id: selected };
  }
  console.log("Unknown action.");
  return null;
}

function actionFromRecommendation(battle, rules = null) {
  const recommendation = recommendBattleAction(battle, rules);
  return { kind: recommendation.kind, skill_id: recommendation.skillId };
}

async function submitBattleTurn(client, battle, action) {
  return client.post(`/api/battles/${battle.id}/actions`, {
    kind: action.kind,
    skill_id: action.skill_id,
    turn_index: battle.turn_index,
    turn_nonce: battle.turn_nonce,
    source: "cli",
  });
}

function printTerminalBattle(battle, rules = null) {
  const ownSide = viewerSide(battle);
  const otherSide = battle.viewer_side === "opponent" ? battle.sides.player : battle.sides.opponent;
  const recommendation = recommendBattleAction(battle, rules);
  console.log("=".repeat(72));
  console.log(`Codex Pet Battle · ${battle.id}`);
  console.log(`${battle.mode} · ${battle.status} · turn ${battle.turn_index}/${battle.max_turns}`);
  if (battle.status === "in_progress") {
    console.log(`Timer: ${secondsLeft(battle.turn_deadline_at)}s · ${pendingLine(battle)}`);
  } else {
    console.log(`Result: ${battle.result?.result ?? battle.status} · ${battle.result?.reason ?? "complete"}`);
  }
  console.log("-".repeat(72));
  console.log(sideConsoleLine("YOU", ownSide));
  console.log(sideConsoleLine("FOE", otherSide));
  console.log("-".repeat(72));
  console.log(`Recommended: ${recommendation.kind}${recommendation.skillId ? ` ${recommendation.skillId}` : ""}`);
  console.log(`Reason: ${recommendation.reason}`);
  if (battle.status === "in_progress") {
    console.log("Controls: s=strike, g=guard, f=focus, k=skill, a=auto, r=refresh, q=quit");
  }
  const latest = battle.log?.at(-1);
  if (latest) {
    console.log("-".repeat(72));
    console.log(`Last: Turn ${latest.turn} · ${actionConsoleLabel(latest.actions?.player)} vs ${actionConsoleLabel(latest.actions?.opponent)}`);
  }
  console.log("=".repeat(72));
}

function viewerSide(battle) {
  return battle.viewer_side === "opponent" ? battle.sides.opponent : battle.sides.player;
}

function sideConsoleLine(label, side) {
  const hp = `${side.hp}/${side.max_hp}`;
  const energy = `${Number(side.energy ?? 0)}/6`;
  return `${label.padEnd(3)} ${String(side.name ?? "Unknown").padEnd(18)} HP ${hp.padEnd(9)} ${bar(side.hp, side.max_hp)}  EN ${energy}  AFK ${side.timeout_count ?? 0}/3`;
}

function bar(value, cap, width = 18) {
  const filled = cap > 0 ? Math.round((Math.max(0, value) / cap) * width) : 0;
  return `[${"#".repeat(Math.min(width, filled))}${".".repeat(Math.max(0, width - filled))}]`;
}

function pendingLine(battle) {
  const player = battle.pending?.player ? "player locked" : "player waiting";
  const opponent = battle.pending?.opponent ? "opponent locked" : "opponent waiting";
  return `${player}, ${opponent}`;
}

function actionConsoleLabel(action) {
  if (!action) return "pending";
  if (action.kind === "skill") return action.skill_alias ?? action.skill_name ?? action.skill_id ?? "skill";
  return action.kind ?? "action";
}

function secondsLeft(value) {
  return value ? Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000)) : "?";
}

function clearTerminal() {
  output.write("\x1Bc");
}

function parseAliases(value) {
  const aliases = {};
  for (const pair of String(value ?? "").split(",")) {
    const [skillId, alias] = pair.split("=", 2);
    if (skillId && alias) aliases[skillId.trim()] = alias.trim();
  }
  return aliases;
}

function printMatchmaking(result) {
  if (result.status === "waiting") {
    console.log(`Waiting for ${result.ticket.mode} match · ${result.ticket.battle_class} · ${result.ticket.lp} LP`);
    console.log(`Search window: ±${result.ticket.search_window_lp} LP after ${result.ticket.wait_seconds}s`);
    console.log(`Ticket: ${result.ticket.id}`);
    return;
  }
  if (result.status === "matched" && result.battle) {
    console.log(`Matched: ${result.battle.id} · ${result.battle.mode} · ${result.battle.source}`);
    console.log(`Your side: ${result.battle.viewer_side}`);
    console.log("Action: codexpet battle action --battle <id> --kind strike");
    return;
  }
  printObject(result);
}

function recommendBattleAction(battle, rules = null) {
  const side = battle.viewer_side === "opponent" ? battle.sides.opponent : battle.sides.player;
  const opponent = battle.viewer_side === "opponent" ? battle.sides.player : battle.sides.opponent;
  if (!side) return { kind: "strike", reason: "No viewer side was present, so strike is the safest default." };
  if (side.is_you === false && battle.viewer_side) return { kind: "strike", reason: "Viewer side is ambiguous; strike keeps the turn valid." };
  const hpRatio = Number(side.hp ?? 0) / Math.max(1, Number(side.max_hp ?? 1));
  const opponentRatio = Number(opponent?.hp ?? 0) / Math.max(1, Number(opponent?.max_hp ?? 1));
  const skillsById = new Map((rules?.skills ?? []).map((skill) => [skill.id, skill]));
  const skill = bestReadySkill(side, opponentRatio, skillsById);
  if (hpRatio <= 0.32) return { kind: "guard", reason: "Your HP is low; guard reduces damage and still gains energy." };
  if (skill) return { kind: "skill", skillId: skill.id, reason: `${skill.role} skill is available with enough energy.` };
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

function summarizePet(pet) {
  return {
    name: pet.name,
    level: pet.level,
    mastery_level: pet.mastery_level,
    battle_class: pet.battle_class,
    xp: pet.xp,
    style_xp: pet.style_xp,
    stats_total: pet.stats.total,
    rank: pet.rating.label,
    lp: pet.rating.lp,
  };
}

function printObject(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function optional(promise, fallback = null) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(value) {
  if (!value) return "unknown";
  return new Date(value).toISOString().slice(0, 10);
}

function printHelp() {
  console.log(`Codex Pet League CLI

Usage:
  codexpet home
  codexpet next
  codexpet daily [--pet pet_id]
  codexpet session
  codexpet session list
  codexpet session revoke --session session_id|--token league_session_token
  codexpet auth challenge --method email_magic_link --identifier you@example.com
  codexpet auth verify --challenge auth_challenge_id --code 123456
  codexpet league
  codexpet rules
  codexpet pets
  codexpet pet discover-hatch
  codexpet pet import-hatch [--path C:\\Users\\you\\.codex\\pets\\pebble] --primary Forge --secondary Trace
  codexpet pet create --name Pebble --primary Forge --secondary Trace [--atlas path.png|path.webp]
  codexpet pet activate --pet pet_id
  codexpet pet profile [--pet pet_id]
  codexpet pet loadout --skills skill1,skill2,skill3,skill4 [--aliases skill_id=Alias]
  codexpet pet replays [--pet pet_id]
  codexpet xp status [--pet pet_id]
  codexpet report draft [--pet pet_id] [--implementation] [--verification] [--tests-run 3]
  codexpet report submit [--pet pet_id] [--milestone] [--files large]
  codexpet battle simulate [--pet pet_id] --mode ranked --result win --opponent-lp 1500
  codexpet battle start [--pet pet_id] [--mode casual] [--opponent-lp 1500]
  codexpet battle action --battle battle_room_id --kind strike|guard|focus|skill [--skill skill_id]
  codexpet battle actions --battle battle_room_id
  codexpet battle watch [--battle battle_room_id] [--once] [--interval 1000]
  codexpet battle play [--battle battle_room_id] [--auto]
  codexpet battle get --battle battle_room_id
  codexpet queue join [--pet pet_id] [--mode ranked|casual]
  codexpet queue status [--pet pet_id]
  codexpet queue cancel --ticket ticket_id
  codexpet invite create [--pet pet_id]
  codexpet invite accept --code ABC123 [--pet pet_id]
  codexpet audit
  codexpet leaderboard

Environment:
  CODEX_PET_LEAGUE_URL=http://localhost:4317
  CODEX_PET_SESSION_TOKEN=league_session_token
  CODEX_PET_ACCOUNT_ID=acct_demo
`);
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
