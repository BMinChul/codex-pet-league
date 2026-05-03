import { createHash, randomUUID } from "node:crypto";
import { XP_CAPS } from "./rules.js";

export function hashLedgerEntry(entry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function auditState(state) {
  const findings = [];
  const activePetIds = new Set(state.pets.filter((pet) => pet.status === "active").map((pet) => pet.id));
  const battleRoomIds = new Set((state.battleRooms ?? []).map((room) => room.id));

  for (const entry of state.xpLedger ?? []) {
    if (!activePetIds.has(entry.pet_id)) {
      findings.push(finding("xp_orphan_pet", "high", `XP ledger references missing pet ${entry.pet_id}.`));
    }
    if (entry.pet_xp_delta < 0 || entry.style_xp_delta < 0) {
      findings.push(finding("xp_negative_delta", "high", `XP ledger ${entry.id} contains a negative delta.`));
    }
    if (entry.pet_xp_delta > XP_CAPS.petDaily) {
      findings.push(finding("xp_delta_exceeds_daily_cap", "medium", `XP ledger ${entry.id} exceeds daily pet cap.`));
    }
  }

  for (const entry of state.lpLedger ?? []) {
    if (!activePetIds.has(entry.pet_id)) {
      findings.push(finding("lp_orphan_pet", "high", `LP ledger references missing pet ${entry.pet_id}.`));
    }
    if (Math.abs(entry.lp_delta) > 90) {
      findings.push(finding("lp_delta_exceeds_clamp", "high", `LP ledger ${entry.id} exceeds placement clamp.`));
    }
    if (entry.lp_after < 0) {
      findings.push(finding("lp_negative_after", "high", `LP ledger ${entry.id} has negative LP.`));
    }
  }

  for (const battle of state.battles ?? []) {
    if (battle.battle_room_id && !battleRoomIds.has(battle.battle_room_id)) {
      findings.push(finding("battle_missing_room", "medium", `Battle ${battle.id} references missing room.`));
    }
    if (battle.mode === "ranked" && battle.battle_source !== "random_matchmaking" && battle.lp) {
      findings.push(finding("ranked_unofficial_lp", "critical", `Battle ${battle.id} has LP outside official matchmaking.`));
    }
  }

  for (const room of state.battleRooms ?? []) {
    if (room.status === "finished" && !room.replay_hash) {
      findings.push(finding("battle_missing_replay_hash", "medium", `Finished room ${room.id} has no replay hash.`));
    }
    if (room.mode === "ranked" && room.source !== "random_matchmaking") {
      findings.push(finding("ranked_room_source_invalid", "critical", `Ranked room ${room.id} was not made by matchmaking.`));
    }
  }

  return {
    ok: findings.filter((item) => item.severity === "critical" || item.severity === "high").length === 0,
    counts: {
      accounts: state.accounts.length,
      pets: state.pets.length,
      assets: state.assets.length,
      battles: state.battles.length,
      battleRooms: (state.battleRooms ?? []).length,
      xpLedger: state.xpLedger.length,
      lpLedger: state.lpLedger.length,
      riskEvents: (state.riskEvents ?? []).length,
    },
    findings,
    checked_at: new Date().toISOString(),
  };
}

export function appendRiskEvent(state, input) {
  state.riskEvents ??= [];
  const event = {
    id: `risk_${randomUUID()}`,
    account_id: input.accountId ?? null,
    pet_id: input.petId ?? null,
    type: input.type,
    severity: input.severity ?? "low",
    score: input.score ?? 0,
    metadata: input.metadata ?? {},
    created_at: new Date().toISOString(),
  };
  event.hash = hashLedgerEntry(event);
  state.riskEvents.unshift(event);
  state.riskEvents = state.riskEvents.slice(0, 1000);
  return event;
}

export function riskTrainingReport({ signals, counters, classification }) {
  const flags = [];
  let score = 0;
  const testsRun = Number(signals.testsRun ?? 0);

  if (testsRun > 20) {
    score += testsRun > 50 ? 60 : 35;
    flags.push("tests_run_unusually_high");
  }
  if (signals.milestone && classification.qualityScore < 70) {
    score += 25;
    flags.push("milestone_claim_low_signal");
  }
  if (counters.trainingReportsUsed >= XP_CAPS.petEligibleTrainingReportsDaily) {
    score += 10;
    flags.push("training_pet_xp_slots_exhausted");
  }
  if (!signals.implementationActivity && !signals.verificationActivity && !signals.debuggingActivity) {
    score += 20;
    flags.push("low_evidence_report");
  }

  return {
    score: Math.min(100, score),
    flags,
    hold_for_review: score >= 70,
  };
}

function finding(code, severity, message) {
  return { code, severity, message };
}
