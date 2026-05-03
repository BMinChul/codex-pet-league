import { createHash, randomUUID } from "node:crypto";
import { XP_CAPS } from "./rules.js";

export function hashLedgerEntry(entry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function auditState(state) {
  const findings = [];
  const activePetIds = new Set(state.pets.filter((pet) => pet.status === "active").map((pet) => pet.id));
  const battleRoomIds = new Set((state.battleRooms ?? []).map((room) => room.id));

  verifyChronologicalChain(state.xpLedger ?? [], "xp_ledger", findings);
  verifyChronologicalChain(state.lpLedger ?? [], "lp_ledger", findings);
  verifyReverseChain(state.events ?? [], "event_log", findings);
  verifyReverseChain(state.riskEvents ?? [], "risk_event", findings);

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
    verifyReplayHash(room, findings);
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
    risk_summary: (state.accounts ?? []).map((account) => accountIntegrityStatus(state, account.id)).filter((entry) => entry.level !== "clear"),
    enforcement_policy: {
      automatic_ranked_lock: "manual_or_tamper_only",
      risk_scores: "review_recommendations_only",
    },
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
    previous_hash: state.riskEvents[0]?.hash ?? null,
    created_at: new Date().toISOString(),
  };
  event.hash = hashLedgerEntry(event);
  state.riskEvents.unshift(event);
  state.riskEvents = state.riskEvents.slice(0, 1000);
  return event;
}

export function accountIntegrityStatus(state, accountId) {
  const account = (state.accounts ?? []).find((entry) => entry.id === accountId);
  const dayStart = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (state.riskEvents ?? []).filter(
    (event) => event.account_id === accountId && new Date(event.created_at).getTime() >= dayStart,
  );
  const score = recent.reduce((total, event) => total + Number(event.score ?? 0), 0);
  const highEvents = recent.filter((event) => event.severity === "high" || event.severity === "critical").length;
  const rankedLockedUntil = account?.enforcement?.ranked_locked_until ?? null;
  const rankedLocked = Boolean(rankedLockedUntil && new Date(rankedLockedUntil) > new Date());
  let level = "clear";
  if (score >= 250 && highEvents >= 2) level = "review";
  else if (score >= 120 || highEvents >= 1) level = "watch";

  const recommendedActions = [];
  if (level === "watch") recommendedActions.push("review_recent_events");
  if (level === "review") recommendedActions.push("manual_review_before_penalty");
  if (rankedLocked) recommendedActions.push("ranked_locked_by_manual_or_tamper_flag");

  return {
    account_id: accountId,
    level,
    risk_score_24h: score,
    high_events_24h: highEvents,
    risk_events_24h: recent.length,
    recommended_actions: recommendedActions,
    automatic_restrictions: {
      ranked_locked: rankedLocked,
      ranked_locked_until: rankedLockedUntil,
    },
  };
}

export function riskTrainingReport({ signals, counters, classification, trust = {} }) {
  const flags = [];
  let score = 0;
  const testsRun = Number(signals.testsRun ?? 0);
  const highValue = ["major", "milestone"].includes(classification.reportType);

  if (!trust.trusted && highValue) {
    score += 70;
    flags.push("untrusted_high_value_report");
  }

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
  if (classification.recentDuplicateEvidenceCount > 0) {
    score += 35;
    flags.push("repeated_training_evidence");
  }
  if (highValue && classification.recentHighValueCount >= 3) {
    score += 60;
    flags.push("high_value_report_spam");
  } else if (highValue && classification.recentHighValueCount >= 1) {
    score += 20;
    flags.push("repeated_high_value_report");
  }
  if (classification.recentBurstCount >= 5) {
    score += 35;
    flags.push("training_report_burst");
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

function verifyChronologicalChain(entries, codePrefix, findings) {
  let previousHash = null;
  for (const entry of entries) {
    if (entry.hash) {
      const expected = hashLedgerEntry({ ...entry, hash: undefined });
      if (entry.hash !== expected) {
        findings.push(finding(`${codePrefix}_hash_invalid`, "critical", `${codePrefix} entry ${entry.id} hash is invalid.`));
      }
      if (entry.previous_hash !== previousHash) {
        findings.push(finding(`${codePrefix}_chain_broken`, "critical", `${codePrefix} entry ${entry.id} does not link to the prior entry.`));
      }
    }
    previousHash = entry.hash ?? previousHash;
  }
}

function verifyReverseChain(entries, codePrefix, findings) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.hash) continue;
    const expected = hashLedgerEntry({ ...entry, hash: undefined });
    if (entry.hash !== expected) {
      findings.push(finding(`${codePrefix}_hash_invalid`, "critical", `${codePrefix} entry ${entry.id} hash is invalid.`));
    }
    const next = entries[index + 1];
    if (next?.hash && entry.previous_hash !== next.hash) {
      findings.push(finding(`${codePrefix}_chain_broken`, "critical", `${codePrefix} entry ${entry.id} does not link to the previous head.`));
    }
  }
}

function verifyReplayHash(room, findings) {
  if (room.status !== "finished" || !room.replay_hash) return;
  let previousHash = null;
  for (const entry of room.log ?? []) {
    if (!entry.hash) {
      findings.push(finding("battle_replay_entry_missing_hash", "medium", `Room ${room.id} has an unhashed replay entry.`));
      return;
    }
    if (entry.previous_hash !== previousHash) {
      findings.push(finding("battle_replay_chain_broken", "critical", `Room ${room.id} replay chain is broken at turn ${entry.turn}.`));
      return;
    }
    const expected = createHash("sha256").update(JSON.stringify({ room_id: room.id, ...withoutHash(entry) })).digest("hex");
    if (entry.hash !== expected) {
      findings.push(finding("battle_replay_entry_hash_invalid", "critical", `Room ${room.id} replay entry ${entry.turn} hash is invalid.`));
      return;
    }
    previousHash = entry.hash;
  }
  const expectedReplayHash = createHash("sha256")
    .update(JSON.stringify({ room_id: room.id, last_turn_hash: previousHash, result: room.result }))
    .digest("hex");
  if (room.replay_hash !== expectedReplayHash) {
    findings.push(finding("battle_replay_hash_invalid", "critical", `Room ${room.id} final replay hash is invalid.`));
  }
}

function withoutHash(entry) {
  const { hash, ...rest } = entry;
  return rest;
}
