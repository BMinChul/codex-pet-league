#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { buildSignalsFromWorkspace } from "./signals.js";

const DEFAULT_BASE_URL = process.env.CODEX_PET_LEAGUE_URL ?? "http://localhost:4317";
const DEFAULT_ACCOUNT_ID = process.env.CODEX_PET_ACCOUNT_ID ?? "acct_demo";

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

  const client = createApiClient(parsed.flags.url ?? DEFAULT_BASE_URL, parsed.flags.account ?? DEFAULT_ACCOUNT_ID);

  if (area === "session") {
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
      level100Xp: rules.level100Xp,
      level100FastestDaysAtCap: rules.level100FastestDaysAtCap,
    });
    return;
  }

  if (area === "pets" || (area === "pet" && action === "list")) {
    await listPets(client);
    return;
  }

  if (area === "pet" && action === "create") {
    await createPet(client, parsed.flags);
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
    const result = await client.post(`/api/pets/${pet.id}/training-reports`, {
      client_report_id: parsed.flags.idempotencyKey ?? randomUUID(),
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

  if (area === "battle" && action === "action") {
    if (!parsed.flags.battle) throw new Error("Pass --battle battle_room_id");
    const result = await client.post(`/api/battles/${parsed.flags.battle}/actions`, {
      kind: parsed.flags.kind ?? "strike",
      skill_id: parsed.flags.skill,
    });
    printTurnBattle(result.battle);
    return;
  }

  if (area === "leaderboard") {
    const board = await client.get("/api/leaderboard");
    printLeaderboard(board.leaderboard);
    return;
  }

  throw new Error(`Unknown command: ${[area, action].filter(Boolean).join(" ")}`);
}

async function listPets(client) {
  const result = await client.get("/api/pets");
  if (result.pets.length === 0) {
    console.log("No pets registered. Run: codexpet pet create --name Pebble");
    return;
  }
  for (const pet of result.pets) {
    console.log(`${pet.id}  ${pet.name}  Lv ${pet.level}  ${pet.battle_class}  ${pet.rating.label} ${pet.rating.lp} LP`);
  }
}

async function createPet(client, flags) {
  const atlasDataUrl = flags.atlas ? await pngDataUrl(flags.atlas) : null;
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
  if (!result.pets[0]) throw new Error("No pets registered. Run: codexpet pet create --name Pebble");
  return result.pets[0];
}

function createApiClient(baseUrl, accountId) {
  const root = baseUrl.replace(/\/$/, "");
  return {
    get(path) {
      return request(root, accountId, "GET", path);
    },
    post(path, body) {
      return request(root, accountId, "POST", path, body);
    },
  };
}

async function request(root, accountId, method, path, body) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-league-account-id": accountId,
    },
    body: body ? JSON.stringify(body) : undefined,
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

async function pngDataUrl(path) {
  const bytes = await readFile(path);
  return `data:image/png;base64,${bytes.toString("base64")}`;
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

function printTurnBattle(battle) {
  const player = battle.sides.player;
  const opponent = battle.sides.opponent;
  console.log(`${battle.id} · ${battle.mode} · ${battle.status} · turn ${battle.turn_index}`);
  console.log(`You: ${player.hp}/${player.max_hp} HP, energy ${player.energy}, AFK ${player.timeout_count}/3`);
  console.log(`${opponent.name}: ${opponent.hp}/${opponent.max_hp} HP, energy ${opponent.energy}`);
  if (battle.status === "in_progress") {
    console.log(`Deadline: ${new Date(battle.turn_deadline_at).toLocaleTimeString()}`);
    console.log("Action: codexpet battle action --battle <id> --kind strike");
  } else {
    console.log(`Result: ${battle.result.result} · replay ${battle.replay_hash}`);
  }
  if (battle.log.at(-1)) printObject({ latest_turn: battle.log.at(-1) });
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

function printHelp() {
  console.log(`Codex Pet League CLI

Usage:
  codexpet session
  codexpet rules
  codexpet pets
  codexpet pet create --name Pebble --primary Forge --secondary Trace [--atlas path.png]
  codexpet xp status [--pet pet_id]
  codexpet report draft [--pet pet_id] [--implementation] [--verification] [--tests-run 3]
  codexpet report submit [--pet pet_id] [--milestone] [--files large]
  codexpet battle simulate [--pet pet_id] --mode ranked --result win --opponent-lp 1500
  codexpet battle start [--pet pet_id] [--mode casual] [--opponent-lp 1500]
  codexpet battle action --battle battle_room_id --kind strike|guard|focus|skill [--skill skill_id]
  codexpet battle get --battle battle_room_id
  codexpet leaderboard

Environment:
  CODEX_PET_LEAGUE_URL=http://localhost:4317
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
