import { createHash, createHmac, randomUUID } from "node:crypto";
import { battleClassForTotalStats, DEFAULT_SEASON, deriveStats, progressionFromXp, XP_CAPS } from "./rules.js";
import { resultForSide } from "./battleEngine.js";

export function hashLedgerEntry(entry) {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function auditState(state) {
  const findings = [];
  const accounts = state.accounts ?? [];
  const pets = state.pets ?? [];
  const accountIds = new Set(accounts.map((account) => account.id));
  const petById = new Map(pets.map((pet) => [pet.id, pet]));
  const activePetIds = new Set(pets.filter((pet) => pet.status === "active").map((pet) => pet.id));
  const battleRoomIds = new Set((state.battleRooms ?? []).map((room) => room.id));
  const activeBattlePets = new Map();

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
    if (room.status === "in_progress") {
      for (const side of [room.sides?.player, room.sides?.opponent]) {
        if (!side?.pet_id) continue;
        activeBattlePets.set(side.pet_id, (activeBattlePets.get(side.pet_id) ?? 0) + 1);
      }
    }
    if (room.status === "finished" && !room.replay_hash) {
      findings.push(finding("battle_missing_replay_hash", "medium", `Finished room ${room.id} has no replay hash.`));
    }
    verifyReplayHash(room, findings);
    if (room.mode === "ranked" && room.source !== "random_matchmaking") {
      findings.push(finding("ranked_room_source_invalid", "critical", `Ranked room ${room.id} was not made by matchmaking.`));
    }
  }
  for (const [petId, count] of activeBattlePets) {
    if (count > 1) {
      findings.push(finding("pet_multiple_active_battles", "critical", `Pet ${petId} is in ${count} active battle rooms.`));
    }
  }

  verifyMatchmakingIntegrity(state, { accountIds, activePetIds, petById }, findings);
  verifyPetDerivedState(state, findings);
  verifyReviewAndReportIntegrity(state, { accountIds, petById }, findings);
  verifyAssetIntegrity(state, findings);
  verifyBattleSettlementIntegrity(state, findings);

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

function verifyPetDerivedState(state, findings) {
  const xpByPet = new Map();
  for (const entry of state.xpLedger ?? []) {
    const bucket = xpByPet.get(entry.pet_id) ?? { pet: 0, style: 0 };
    bucket.pet += Number(entry.pet_xp_delta ?? 0);
    bucket.style += Number(entry.style_xp_delta ?? 0);
    xpByPet.set(entry.pet_id, bucket);
  }

  const lpByPetSeason = new Map();
  for (const entry of state.lpLedger ?? []) {
    if (!entry.pet_id || !entry.season_id) continue;
    lpByPetSeason.set(`${entry.pet_id}:${entry.season_id}`, Number(entry.lp_after ?? 0));
  }

  for (const pet of state.pets ?? []) {
    if (pet.status !== "active") continue;
    const expectedXp = xpByPet.get(pet.id) ?? { pet: 0, style: 0 };
    if (Number(pet.xp ?? 0) !== expectedXp.pet) {
      findings.push(finding("pet_xp_state_mismatch", "high", `Pet ${pet.id} XP does not match the XP ledger.`));
    }
    if (Number(pet.style_xp ?? 0) !== expectedXp.style) {
      findings.push(finding("pet_style_xp_state_mismatch", "medium", `Pet ${pet.id} Style XP does not match the XP ledger.`));
    }

    const progression = progressionFromXp(expectedXp.pet);
    if (Number(pet.level ?? 0) !== progression.level || Number(pet.mastery_level ?? 0) !== progression.masteryLevel) {
      findings.push(finding("pet_level_state_mismatch", "high", `Pet ${pet.id} level does not match ledger-derived XP.`));
    }
    const expectedStats = deriveStats({
      primaryElement: pet.primary_element,
      secondaryElement: pet.secondary_element,
      level: progression.level,
    });
    if (!statsEqual(pet.stats, expectedStats)) {
      findings.push(finding("pet_stats_state_mismatch", "high", `Pet ${pet.id} stats do not match ledger-derived level and elements.`));
    }
    const expectedClass = battleClassForTotalStats(expectedStats.total);
    if (pet.battle_class !== expectedClass) {
      findings.push(finding("pet_battle_class_state_mismatch", "high", `Pet ${pet.id} Battle Class does not match ledger-derived stats.`));
    }

    const seasonId = pet.rating?.season_id ?? state.activeSeasonId ?? DEFAULT_SEASON.id;
    const season = (state.seasons ?? []).find((entry) => entry.id === seasonId) ?? DEFAULT_SEASON;
    const ledgerLp = lpByPetSeason.get(`${pet.id}:${seasonId}`);
    const expectedLp = ledgerLp ?? Number(season.ranked_seed_lp ?? DEFAULT_SEASON.ranked_seed_lp);
    if (Number(pet.rating?.lp ?? 0) !== expectedLp) {
      findings.push(finding("pet_lp_state_mismatch", "high", `Pet ${pet.id} LP does not match ranked LP ledger state.`));
    }
  }
}

function statsEqual(left = {}, right = {}) {
  for (const key of ["power", "guard", "speed", "focus", "recovery", "insight", "total"]) {
    if (Number(left[key] ?? 0) !== Number(right[key] ?? 0)) return false;
  }
  return true;
}

function verifyAssetIntegrity(state, findings) {
  const sourceBuckets = new Map();
  for (const asset of state.assets ?? []) {
    if (asset.hatch_source === "openai_hatch_pet" && !asset.hatch_pet_json) {
      findings.push(finding("hatch_asset_missing_manifest", "high", `Asset ${asset.id} is marked hatch-pet without pet.json metadata.`));
    }
    if (asset.hatch_pet_json && !asset.atlas_sha256) {
      findings.push(finding("hatch_asset_missing_atlas_hash", "high", `Asset ${asset.id} has hatch metadata without an atlas hash.`));
    }
    const extension = String(asset.hatch_pet_json?.spritesheetPath ?? "").split(".").at(-1).toLowerCase();
    if (extension && asset.atlas_format && extension !== asset.atlas_format) {
      findings.push(finding("hatch_asset_extension_mismatch", "high", `Asset ${asset.id} hatch manifest extension does not match atlas format.`));
    }
    if (asset.provenance?.atlas_sha256 && asset.atlas_sha256 && asset.provenance.atlas_sha256 !== asset.atlas_sha256) {
      findings.push(finding("asset_provenance_atlas_hash_mismatch", "critical", `Asset ${asset.id} provenance atlas hash was tampered.`));
    }
    if (
      asset.provenance?.source_fingerprint &&
      asset.source_fingerprint &&
      asset.provenance.source_fingerprint !== asset.source_fingerprint
    ) {
      findings.push(finding("asset_provenance_fingerprint_mismatch", "critical", `Asset ${asset.id} provenance fingerprint was tampered.`));
    }
    if (asset.hatch_source === "openai_hatch_pet" && asset.official_contract !== "openai-hatch-pet@8x9-192x208-v1") {
      findings.push(finding("hatch_asset_contract_missing", "medium", `Asset ${asset.id} is missing the official hatch-pet contract marker.`));
    }
    if (asset.source_fingerprint && asset.asset_status === "active" && asset.safety_status === "clear") {
      const bucket = sourceBuckets.get(asset.source_fingerprint) ?? { accounts: new Set(), assetIds: [] };
      bucket.accounts.add(asset.owner_account_id);
      bucket.assetIds.push(asset.id);
      sourceBuckets.set(asset.source_fingerprint, bucket);
    }
  }

  for (const [fingerprint, bucket] of sourceBuckets) {
    if (bucket.accounts.size <= 1) continue;
    findings.push(
      finding(
        "asset_cross_account_duplicate_source",
        "medium",
        `Source fingerprint ${fingerprint.slice(0, 12)} appears on ${bucket.accounts.size} accounts (${bucket.assetIds.slice(0, 4).join(", ")}).`,
      ),
    );
  }
}

function verifyMatchmakingIntegrity(state, context, findings) {
  const waitingKeys = new Map();
  const now = Date.now();
  for (const ticket of state.matchTickets ?? []) {
    if (!context.accountIds.has(ticket.account_id)) {
      findings.push(finding("ticket_missing_account", "high", `Waiting ticket ${ticket.id} references missing account.`));
    }
    const pet = context.petById.get(ticket.pet_id);
    if (!pet || !context.activePetIds.has(ticket.pet_id)) {
      findings.push(finding("ticket_missing_pet", "high", `Ticket ${ticket.id} references missing or inactive pet.`));
      continue;
    }
    if (ticket.status !== "waiting") continue;
    const key = `${ticket.account_id}:${ticket.pet_id}:${ticket.mode}`;
    waitingKeys.set(key, (waitingKeys.get(key) ?? 0) + 1);
    if (pet.battle_class !== ticket.battle_class) {
      findings.push(finding("ticket_battle_class_stale", "high", `Ticket ${ticket.id} has stale Battle Class.`));
    }
    if (Number(pet.rating?.lp ?? 0) !== Number(ticket.lp ?? 0)) {
      findings.push(finding("ticket_lp_stale", "medium", `Ticket ${ticket.id} has stale LP.`));
    }
  }
  for (const [key, count] of waitingKeys) {
    if (count > 1) findings.push(finding("duplicate_waiting_ticket", "high", `Duplicate waiting ticket bucket ${key}.`));
  }

  for (const invite of state.friendInvites ?? []) {
    if (!context.accountIds.has(invite.host_account_id)) {
      findings.push(finding("invite_missing_account", "high", `Invite ${invite.id} references missing host account.`));
    }
    if (!context.activePetIds.has(invite.host_pet_id)) {
      findings.push(finding("invite_missing_pet", "high", `Invite ${invite.id} references missing or inactive host pet.`));
    }
    if (invite.status === "open" && new Date(invite.expires_at).getTime() <= now) {
      findings.push(finding("invite_open_after_expiry", "medium", `Invite ${invite.id} is still open after expiry.`));
    }
  }
}

function verifyReviewAndReportIntegrity(state, context, findings) {
  const openAssetReportKeys = new Set();
  for (const report of state.trainingReports ?? []) {
    if (report.status === "review" && (Number(report.pet_xp_delta ?? 0) > 0 || Number(report.style_xp_delta ?? 0) > 0)) {
      findings.push(finding("held_report_awarded_xp", "critical", `Held Training Report ${report.id} awarded XP.`));
    }
    if (!context.petById.has(report.pet_id)) {
      findings.push(finding("training_report_missing_pet", "medium", `Training Report ${report.id} references missing pet.`));
    }
  }

  for (const report of state.assetReports ?? []) {
    if (report.reporter_account_id === report.owner_account_id) {
      findings.push(finding("asset_self_report", "high", `Asset report ${report.id} is a self-report.`));
    }
    if (!context.accountIds.has(report.reporter_account_id) || !context.accountIds.has(report.owner_account_id)) {
      findings.push(finding("asset_report_missing_account", "medium", `Asset report ${report.id} references missing account.`));
    }
    if (report.status !== "open") continue;
    const key = `${report.asset_id}:${report.reporter_account_id}`;
    if (openAssetReportKeys.has(key)) {
      findings.push(finding("duplicate_open_asset_report", "high", `Asset ${report.asset_id} has duplicate open report by one account.`));
    }
    openAssetReportKeys.add(key);
  }
}

function verifyBattleSettlementIntegrity(state, findings) {
  const battlesById = new Map((state.battles ?? []).map((battle) => [battle.id, battle]));
  const roomsById = new Map((state.battleRooms ?? []).map((room) => [room.id, room]));

  for (const room of state.battleRooms ?? []) {
    if (room.status !== "finished") continue;
    for (const sideKey of ["player", "opponent"]) {
      const side = room.sides?.[sideKey];
      if (side?.kind !== "player" || !side.account_id || !side.pet_id) continue;
      const battleId = room.settlement_battle_ids?.[sideKey];
      if (!battleId) {
        findings.push(finding("battle_settlement_missing", "medium", `Room ${room.id} is missing settlement for ${sideKey}.`));
        continue;
      }
      const battle = battlesById.get(battleId);
      if (!battle) {
        findings.push(finding("battle_settlement_orphan", "high", `Room ${room.id} references missing settlement ${battleId}.`));
        continue;
      }
      const expectedResult = resultForSide(room, sideKey);
      if (battle.result !== expectedResult) {
        findings.push(finding("battle_settlement_result_mismatch", "high", `Settlement ${battle.id} result does not match room ${room.id}.`));
      }
      if (battle.replay_hash !== room.replay_hash) {
        findings.push(finding("battle_settlement_replay_mismatch", "critical", `Settlement ${battle.id} replay hash does not match room ${room.id}.`));
      }
      verifyRecordSignature(
        "battle_result",
        battle.result_signature,
        {
          account_id: battle.account_id,
          pet_id: battle.pet_id,
          battle_room_id: battle.battle_room_id ?? null,
          result: battle.result,
          replay_hash: battle.replay_hash ?? null,
          lp: battle.lp,
        },
        "battle_result_signature_invalid",
        `Settlement ${battle.id} result signature is invalid.`,
        findings,
      );
      if (Number(battle.turn_count ?? 0) !== Number((room.log ?? []).length)) {
        findings.push(finding("battle_settlement_turn_mismatch", "medium", `Settlement ${battle.id} turn count does not match room ${room.id}.`));
      }
    }
    verifyRecordSignature(
      "battle_replay",
      room.replay_signature,
      { room_id: room.id, replay_hash: room.replay_hash, result: room.result },
      "battle_replay_signature_invalid",
      `Room ${room.id} replay signature is invalid.`,
      findings,
    );
  }

  for (const battle of state.battles ?? []) {
    if (!battle.battle_room_id) continue;
    const room = roomsById.get(battle.battle_room_id);
    if (!room) continue;
    if (battle.replay_hash && room.replay_hash && battle.replay_hash !== room.replay_hash) {
      findings.push(finding("battle_replay_cross_reference_mismatch", "critical", `Battle ${battle.id} replay hash differs from room ${room.id}.`));
    }
  }
}

function verifyRecordSignature(kind, signature, payload, code, message, findings) {
  if (!signature) {
    findings.push(finding(code.replace("_invalid", "_missing"), "medium", message.replace("invalid", "missing")));
    return;
  }
  const secret = process.env.CODEX_PET_REPLAY_SIGNING_SECRET ?? "local-dev-replay-signing-key";
  const expected = `hmac-sha256:${createHmac("sha256", secret).update(JSON.stringify({ kind, payload })).digest("hex")}`;
  if (signature !== expected) findings.push(finding(code, "critical", message));
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
  const rankedLpSuppressedUntil = account?.enforcement?.ranked_lp_suppressed_until ?? null;
  const rankedLpSuppressed = Boolean(rankedLpSuppressedUntil && new Date(rankedLpSuppressedUntil) > new Date());
  let level = "clear";
  if (score >= 250 && highEvents >= 2) level = "review";
  else if (score >= 120 || highEvents >= 1 || rankedLpSuppressed) level = "watch";

  const recommendedActions = [];
  if (level === "watch") recommendedActions.push("review_recent_events");
  if (level === "review") recommendedActions.push("manual_review_before_penalty");
  if (rankedLocked) recommendedActions.push("ranked_locked_by_manual_or_tamper_flag");
  if (rankedLpSuppressed) recommendedActions.push("ranked_lp_suppressed_by_manual_review");

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
      ranked_lp_suppressed: rankedLpSuppressed,
      ranked_lp_suppressed_until: rankedLpSuppressedUntil,
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
  const draftStatus = classification.draftCheck?.status ?? "missing";
  if (!trust.trusted && draftStatus !== "valid") {
    score += draftStatus === "summary_mismatch" || draftStatus === "nonce_invalid" ? 85 : 75;
    flags.push(`training_draft_${draftStatus}`);
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
