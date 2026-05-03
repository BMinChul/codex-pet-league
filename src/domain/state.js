import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  DEFAULT_SEASON,
  MATCHMAKING_POLICY,
  XP_CAPS,
  calculateBattleAward,
  calculateTrainingAward,
  classifyTrainingReport,
  deriveStats,
  battleClassForTotalStats,
  elementModifier,
  lpDelta,
  matchmakingWindowFor,
  progressionFromXp,
  tierForLp,
  OFFICIAL_SKILLS,
  ELEMENTS,
} from "./rules.js";
import {
  createBattleRoomSnapshot,
  publicBattleRoom,
  resolveExpiredTurn,
  resolveTurnIfReady,
  resultForSide,
  sideKeyForAccount,
  submitAction,
  submitBotActionIfNeeded,
} from "./battleEngine.js";
import { appendRiskEvent, auditState, riskTrainingReport } from "./audit.js";

export function getAccount(state, accountId = "acct_demo") {
  const account = state.accounts.find((entry) => entry.id === accountId);
  if (!account || !account.verified) {
    throw httpError(401, "ACCOUNT_NOT_VERIFIED", "A verified League account is required.");
  }
  return account;
}

export function leagueStatus(state) {
  return {
    active_season: activeSeason(state),
    matchmaking_policy: MATCHMAKING_POLICY,
    queue_summary: queueSummary(state),
  };
}

export function createAuthChallenge(state, input = {}) {
  const method = ["passkey", "email_magic_link", "league_oauth"].includes(input.method)
    ? input.method
    : "email_magic_link";
  const identifier = sanitizeIdentifier(input.identifier ?? "demo@codexpet.local");
  const now = new Date();
  const id = `challenge_${randomUUID()}`;
  const code = randomCode(8);
  const challenge = {
    id,
    method,
    identifier,
    code_hash: hashAuthCode(id, code),
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };
  state.authChallenges ??= [];
  state.authChallenges.unshift(challenge);
  state.authChallenges = state.authChallenges.slice(0, 200);
  return {
    challenge_id: challenge.id,
    method,
    identifier,
    dev_code: code,
    expires_at: challenge.expires_at,
  };
}

export function verifyAuthChallenge(state, input = {}) {
  const challenge = (state.authChallenges ?? []).find((entry) => entry.id === input.challenge_id);
  if (!challenge || challenge.status !== "pending") {
    throw httpError(404, "AUTH_CHALLENGE_NOT_FOUND", "Auth challenge is not pending.");
  }
  if (new Date(challenge.expires_at) <= new Date()) {
    challenge.status = "expired";
    throw httpError(409, "AUTH_CHALLENGE_EXPIRED", "Auth challenge expired.");
  }
  const submittedCode = String(input.code ?? "").trim();
  const codeMatches = challenge.code_hash
    ? challenge.code_hash === hashAuthCode(challenge.id, submittedCode)
    : challenge.code === submittedCode;
  if (!codeMatches) {
    appendRiskEvent(state, {
      type: "auth.challenge_failed",
      severity: "medium",
      score: 35,
      metadata: { challenge_id: challenge.id, method: challenge.method },
    });
    throw httpError(401, "AUTH_CODE_INVALID", "Auth challenge code is invalid.");
  }

  const account = findOrCreateVerifiedAccount(state, challenge);
  const session = {
    id: `session_${randomUUID()}`,
    account_id: account.id,
    token: `league_${randomUUID().replaceAll("-", "")}`,
    method: challenge.method,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    revoked_at: null,
  };
  state.sessions ??= [];
  state.sessions.unshift(session);
  challenge.status = "used";
  challenge.used_at = new Date().toISOString();
  logEvent(state, "auth.session.created", account.id, { session_id: session.id, method: session.method });
  return {
    account,
    session: publicSession(session),
    session_token: session.token,
  };
}

export function getAccountBySession(state, token) {
  const session = (state.sessions ?? []).find(
    (entry) => entry.token === token && !entry.revoked_at && new Date(entry.expires_at) > new Date(),
  );
  if (!session) throw httpError(401, "SESSION_INVALID", "A valid League session is required.");
  return getAccount(state, session.account_id);
}

export function listSessions(state, accountId) {
  getAccount(state, accountId);
  return {
    sessions: (state.sessions ?? [])
      .filter((session) => session.account_id === accountId)
      .map(publicSession),
  };
}

export function revokeSession(state, accountId, input = {}) {
  getAccount(state, accountId);
  const session = (state.sessions ?? []).find(
    (entry) => entry.account_id === accountId && (entry.id === input.session_id || entry.token === input.token),
  );
  if (!session) throw httpError(404, "SESSION_NOT_FOUND", "Session not found.");
  session.revoked_at = new Date().toISOString();
  logEvent(state, "auth.session.revoked", accountId, { session_id: session.id });
  return { session: publicSession(session) };
}

export function createPetAsset(state, accountId, input = {}) {
  const manifest = validateManifest(input.manifest ?? defaultManifest());
  const atlas = validateAtlasDataUrl(input.atlas_data_url, manifest);
  const canonicalInput = {
    owner_account_id: accountId,
    manifest,
    appearance: input.appearance ?? {},
    atlas_sha256: atlas?.sha256 ?? null,
    hatch_source: input.hatch_source ?? "codex_app",
  };
  const canonicalHash = hashJson(canonicalInput);
  const now = new Date().toISOString();
  const asset = {
    id: `asset_${randomUUID()}`,
    owner_account_id: accountId,
    canonical_hash: canonicalHash,
    atlas_object_key: `local-dev/${canonicalHash}.png`,
    atlas_sha256: atlas?.sha256 ?? null,
    atlas_byte_length: atlas?.byteLength ?? null,
    manifest_json: manifest,
    width: manifest.width,
    height: manifest.height,
    cell_width: manifest.cell_width,
    cell_height: manifest.cell_height,
    columns: manifest.columns,
    rows: manifest.rows,
    asset_status: "active",
    safety_status: "clear",
    visibility: "public",
    appearance: canonicalInput.appearance,
    created_at: now,
    activated_at: now,
  };
  state.assets.push(asset);
  logEvent(state, "asset.active", accountId, { asset_id: asset.id, canonical_hash: canonicalHash });
  return asset;
}

export function createPet(state, accountId, input = {}) {
  const asset = state.assets.find((entry) => entry.id === input.pet_asset_id && entry.owner_account_id === accountId);
  if (!asset) throw httpError(404, "ASSET_NOT_FOUND", "Register a pet asset before creating a pet.");
  const season = activeSeason(state);

  const primaryElement = input.primary_element && ELEMENTS.includes(input.primary_element) ? input.primary_element : "Forge";
  const secondaryElement =
    input.secondary_element && ELEMENTS.includes(input.secondary_element) ? input.secondary_element : null;
  const progression = progressionFromXp(0);
  const stats = deriveStats({ primaryElement, secondaryElement, level: progression.level });
  const now = new Date().toISOString();
  const tier = tierForLp(season.ranked_seed_lp);
  const pet = {
    id: `pet_${randomUUID()}`,
    owner_account_id: accountId,
    bound_account_id: accountId,
    pet_asset_id: asset.id,
    name: sanitizeName(input.name ?? "Codex Pet"),
    status: "active",
    primary_element: primaryElement,
    secondary_element: secondaryElement,
    secondary_unlocked_at: secondaryElement ? now : null,
    level: progression.level,
    mastery_level: progression.masteryLevel,
    xp: 0,
    style_xp: 0,
    stats,
    battle_class: battleClassForTotalStats(stats.total),
    skills: defaultLoadout(primaryElement, secondaryElement),
    skill_aliases: {},
    rating: {
      season_id: season.id,
      lp: season.ranked_seed_lp,
      tier: tier.tier,
      division: tier.division,
      label: tier.label,
      wins: 0,
      losses: 0,
      draws: 0,
      placements_remaining: season.placement_matches,
    },
    created_at: now,
    updated_at: now,
  };
  state.pets.push(pet);
  logEvent(state, "pet.created", accountId, { pet_id: pet.id, asset_id: asset.id });
  return pet;
}

export function updatePetLoadout(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  assertPetAvailableForBattle(state, pet.id);
  const skillIds = Array.isArray(input.skills) ? input.skills : pet.skills;
  if (skillIds.length !== 4) {
    throw httpError(400, "LOADOUT_REQUIRES_FOUR_SKILLS", "A battle loadout must contain exactly four skills.");
  }
  if (new Set(skillIds).size !== 4) {
    throw httpError(400, "LOADOUT_DUPLICATE_SKILL", "A battle loadout cannot contain duplicate skills.");
  }

  const allowedElements = new Set([pet.primary_element, pet.secondary_element].filter(Boolean));
  const officialById = new Map(OFFICIAL_SKILLS.map((skill) => [skill.id, skill]));
  for (const skillId of skillIds) {
    const skill = officialById.get(skillId);
    if (!skill || !allowedElements.has(skill.element)) {
      throw httpError(400, "LOADOUT_SKILL_INVALID", `Skill ${skillId} is not valid for this pet.`);
    }
  }

  pet.skills = skillIds;
  pet.skill_aliases = sanitizeSkillAliases(input.aliases ?? pet.skill_aliases ?? {});
  pet.updated_at = new Date().toISOString();
  logEvent(state, "pet.loadout.updated", accountId, { pet_id: pet.id, skills: pet.skills });
  return publicPetView(state, pet);
}

export function petProfile(state, petId) {
  const pet = state.pets.find((entry) => entry.id === petId && entry.status === "active");
  if (!pet) throw httpError(404, "PET_NOT_FOUND", "Pet not found.");
  const battles = (state.battles ?? []).filter((battle) => battle.pet_id === pet.id);
  const recent = battles.slice(-10).reverse();
  return {
    pet: publicPetView(state, pet),
    record: {
      battles: battles.length,
      wins: battles.filter((battle) => battle.result === "win").length,
      losses: battles.filter((battle) => battle.result === "loss" || battle.result === "afk_loss").length,
      draws: battles.filter((battle) => battle.result === "draw").length,
    },
    recent_battles: recent,
  };
}

export function petReplays(state, accountId, petId) {
  const pet = ownedPet(state, accountId, petId);
  return {
    replays: (state.battles ?? [])
      .filter((battle) => battle.pet_id === pet.id && battle.replay_hash)
      .slice(-20)
      .reverse()
      .map((battle) => ({
        battle_id: battle.id,
        room_id: battle.battle_room_id,
        mode: battle.mode,
        result: battle.result,
        replay_hash: battle.replay_hash,
        turn_count: battle.turn_count,
        created_at: battle.created_at,
        log: battle.replay_log_json,
      })),
  };
}

export function adminAudit(state) {
  return auditState(state);
}

export function draftTrainingReport(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const counters = dailyCounters(state, accountId, pet.id);
  const classification = classifyTrainingReport(input.signals ?? {});
  const isFirstDailyReport = counters.trainingReportsUsed === 0;
  const award = calculateTrainingAward({
    reportType: classification.reportType,
    counters,
    isFirstDailyReport,
  });

  return {
    id: `draft_${randomUUID()}`,
    pet_id: pet.id,
    report_type: classification.reportType,
    element_signal: classification.elementSignal,
    quality_score: classification.qualityScore,
    award_preview: award,
    counters,
    status_text: statusText(counters),
  };
}

export function submitTrainingReport(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const clientReportId = input.client_report_id ?? `client_${randomUUID()}`;
  const duplicate = state.trainingReports.find(
    (entry) => entry.account_id === accountId && entry.client_report_id === clientReportId,
  );
  if (duplicate) {
    return {
      duplicate: true,
      report: duplicate,
      pet,
      counters: dailyCounters(state, accountId, petId),
    };
  }

  const counters = dailyCounters(state, accountId, pet.id);
  const classification = classifyTrainingReport(input.signals ?? {});
  const isFirstDailyReport = counters.trainingReportsUsed === 0;
  const award = calculateTrainingAward({
    reportType: classification.reportType,
    counters,
    isFirstDailyReport,
  });
  const risk = riskTrainingReport({ signals: input.signals ?? {}, counters, classification });
  const effectiveAward = risk.hold_for_review
    ? { ...award, petXpApplied: 0, styleXpApplied: 0, capped: true }
    : award;
  const now = new Date().toISOString();
  const report = {
    id: `report_${randomUUID()}`,
    account_id: accountId,
    pet_id: pet.id,
    client_report_id: clientReportId,
    summary_json: input.signals ?? {},
    status: risk.hold_for_review ? "review" : "approved",
    report_type: classification.reportType,
    element_signal: classification.elementSignal,
    quality_score: classification.qualityScore,
    risk_score: risk.score,
    risk_flags: risk.flags,
    pet_xp_delta: effectiveAward.petXpApplied,
    style_xp_delta: effectiveAward.styleXpApplied,
    created_at: now,
    approved_at: risk.hold_for_review ? null : now,
  };
  state.trainingReports.push(report);
  if (risk.score > 0) {
    appendRiskEvent(state, {
      accountId,
      petId: pet.id,
      type: risk.hold_for_review ? "training.report_held" : "training.report_risk",
      severity: risk.hold_for_review ? "high" : "low",
      score: risk.score,
      metadata: { report_id: report.id, flags: risk.flags },
    });
  }
  if (!risk.hold_for_review) {
    appendXpLedger(state, {
      accountId,
      petId: pet.id,
      sourceType: "training_report",
      sourceId: report.id,
      petXpDelta: effectiveAward.petXpApplied,
      styleXpDelta: effectiveAward.styleXpApplied,
      capBuckets: ["pet_daily", "training_daily", "style_daily", "style_weekly"],
      metadata: {
        pet_eligible: effectiveAward.petEligible,
        report_type: classification.reportType,
        quality_score: classification.qualityScore,
        risk_score: risk.score,
      },
    });
    applyProgression(pet, effectiveAward.petXpApplied, effectiveAward.styleXpApplied);
  }
  logEvent(state, risk.hold_for_review ? "training.review" : "training.approved", accountId, {
    pet_id: pet.id,
    report_id: report.id,
    pet_xp_delta: effectiveAward.petXpApplied,
    style_xp_delta: effectiveAward.styleXpApplied,
    risk_score: risk.score,
  });
  return { report, award: effectiveAward, pet, counters: dailyCounters(state, accountId, pet.id) };
}

export function simulateBattle(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const mode = ["ranked", "casual", "friend", "training"].includes(input.mode) ? input.mode : "casual";
  const result = ["win", "draw", "loss", "afk_loss", "complete"].includes(input.result) ? input.result : "win";
  const opponentLp = Number(input.opponent_lp ?? pet.rating.lp);
  const opponent = input.opponent ?? defaultOpponentFor(pet, opponentLp);
  return settleBattleResult(state, accountId, pet, {
    mode,
    result,
    opponentLp,
    opponent,
    source: "simulated",
    official: false,
  });
}

export function startTurnBattle(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const mode = ["ranked", "casual", "friend", "training"].includes(input.mode) ? input.mode : "casual";
  if (mode === "ranked") {
    throw httpError(409, "RANKED_REQUIRES_MATCHMAKING", "Ranked battles must be created through random matchmaking.");
  }
  assertPetAvailableForBattle(state, pet.id);
  cancelWaitingTicketsForPet(state, pet.id, "direct_battle");
  cancelOpenInvitesForPet(state, pet.id, "direct_battle");
  const opponentLp = Number(input.opponent_lp ?? pet.rating.lp);
  const opponent = input.opponent ?? defaultTurnOpponentFor(pet, opponentLp);
  const room = createBattleRoomSnapshot({
    id: `battle_room_${randomUUID()}`,
    accountId,
    pet,
    mode,
    opponent,
    assetHash: petAsset(state, pet).canonical_hash,
  });
  submitBotActionIfNeeded(room, room.created_at);
  state.battleRooms ??= [];
  state.battleRooms.unshift(room);
  logEvent(state, "battle.room.started", accountId, {
    pet_id: pet.id,
    battle_room_id: room.id,
    mode,
    opponent: opponent.name,
  });
  return { battle: publicBattleRoom(room, accountId) };
}

export function getTurnBattle(state, accountId, battleRoomId) {
  const room = ownedBattleRoom(state, accountId, battleRoomId);
  advanceBattleRoom(state, room);
  return { battle: publicBattleRoom(room, accountId) };
}

export function submitTurnBattleAction(state, accountId, battleRoomId, input = {}) {
  const room = ownedBattleRoom(state, accountId, battleRoomId);
  advanceBattleRoom(state, room);
  if (room.status === "finished") return { battle: publicBattleRoom(room, accountId), submitted: false };

  const now = new Date().toISOString();
  const sideKey = sideKeyForAccount(room, accountId);
  if (!sideKey) throw httpError(403, "BATTLE_NOT_PARTICIPANT", "This account is not a participant in the battle.");
  const submission = submitAction(room, sideKey, input, now);
  if (submission.duplicate) {
    appendRiskEvent(state, {
      accountId,
      petId: room.sides[sideKey].pet_id,
      type: "battle.duplicate_action",
      severity: "low",
      score: 10,
      metadata: { battle_room_id: room.id, turn_index: room.turn_index },
    });
  }
  submitBotActionIfNeeded(room, now);
  resolveTurnIfReady(room, now);
  settleFinishedTurnBattle(state, room);
  return { battle: publicBattleRoom(room, accountId), submitted: submission.submitted, duplicate: submission.duplicate };
}

export function joinMatchmakingQueue(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const mode = ["ranked", "casual"].includes(input.mode) ? input.mode : "ranked";
  const season = activeSeason(state);
  if (mode === "ranked") ensureActiveSeasonRating(pet, season);
  assertPetAvailableForBattle(state, pet.id);
  state.matchTickets ??= [];

  const existing = state.matchTickets.find(
    (ticket) => ticket.status === "waiting" && ticket.account_id === accountId && ticket.pet_id === pet.id && ticket.mode === mode,
  );
  if (existing) {
    const matched = matchWaitingTicket(state, existing);
    if (matched) return matchedResponse(state, matched.room, existing, matched.opponentTicket, accountId);
    return { status: "waiting", ticket: publicTicket(existing), season, policy: publicMatchmakingPolicy(mode) };
  }

  const ticket = createMatchTicket(accountId, pet, mode, season);
  state.matchTickets.unshift(ticket);
  const matched = matchWaitingTicket(state, ticket);
  if (matched) return matchedResponse(state, matched.room, ticket, matched.opponentTicket, accountId);

  logEvent(state, "matchmaking.waiting", accountId, {
    ticket_id: ticket.id,
    pet_id: pet.id,
    mode,
    battle_class: pet.battle_class,
    lp: pet.rating.lp,
    season_id: ticket.season_id,
    search_window_lp: ticketSearchWindow(ticket),
  });
  return { status: "waiting", ticket: publicTicket(ticket), season, policy: publicMatchmakingPolicy(mode) };
}

export function matchmakingStatus(state, accountId, petId = null) {
  getAccount(state, accountId);
  const season = activeSeason(state);
  const tickets = (state.matchTickets ?? [])
    .filter((ticket) => ticket.account_id === accountId && (!petId || ticket.pet_id === petId))
    .slice(0, 10)
    .map(publicTicket);
  const activeBattles = (state.battleRooms ?? [])
    .filter((room) => room.status === "in_progress" && sideKeyForAccount(room, accountId))
    .map((room) => publicBattleRoom(room, accountId));
  return { season, policy: MATCHMAKING_POLICY, tickets, active_battles: activeBattles };
}

export function cancelMatchmakingTicket(state, accountId, input = {}) {
  getAccount(state, accountId);
  const ticket = (state.matchTickets ?? []).find(
    (entry) => entry.id === input.ticket_id && entry.account_id === accountId && entry.status === "waiting",
  );
  if (!ticket) throw httpError(404, "MATCH_TICKET_NOT_FOUND", "Waiting match ticket not found.");
  ticket.status = "cancelled";
  ticket.cancel_reason = "user_cancelled";
  ticket.cancelled_at = new Date().toISOString();
  logEvent(state, "matchmaking.cancelled", accountId, { ticket_id: ticket.id, pet_id: ticket.pet_id });
  return { ticket: publicTicket(ticket) };
}

export function processMatchmakingQueues(state) {
  advanceAllBattleRooms(state);
  const matches = [];
  const waiting = (state.matchTickets ?? [])
    .filter((ticket) => ticket.status === "waiting")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const ticket of waiting) {
    if (ticket.status !== "waiting") continue;
    if (petHasActiveBattle(state, ticket.pet_id)) {
      ticket.status = "cancelled";
      ticket.cancel_reason = "pet_active_battle";
      ticket.cancelled_at = new Date().toISOString();
      continue;
    }
    const matched = matchWaitingTicket(state, ticket);
    if (matched) {
      matches.push({
        battle_room_id: matched.room.id,
        ticket_id: ticket.id,
        opponent_ticket_id: matched.opponentTicket.id,
      });
    }
  }

  return { matches, queue_summary: queueSummary(state) };
}

export function createFriendInvite(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  assertPetAvailableForBattle(state, pet.id);
  state.friendInvites ??= [];
  expireOldInvites(state);

  const existing = state.friendInvites.find(
    (invite) => invite.status === "open" && invite.host_account_id === accountId && invite.host_pet_id === pet.id,
  );
  if (existing) return { invite: publicInvite(existing) };

  const now = new Date();
  const invite = {
    id: `invite_${randomUUID()}`,
    code: createInviteCode(state),
    host_account_id: accountId,
    host_pet_id: pet.id,
    mode: "friend",
    battle_class: pet.battle_class,
    lp: pet.rating.lp,
    status: "open",
    battle_room_id: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };
  state.friendInvites.unshift(invite);
  logEvent(state, "friend_invite.created", accountId, {
    invite_id: invite.id,
    code: invite.code,
    pet_id: pet.id,
    battle_class: pet.battle_class,
  });
  return { invite: publicInvite(invite) };
}

export function acceptFriendInvite(state, accountId, petId, input = {}) {
  const guestPet = ownedPet(state, accountId, petId);
  assertPetAvailableForBattle(state, guestPet.id);
  state.friendInvites ??= [];
  expireOldInvites(state);

  const code = normalizeInviteCode(input.code);
  const invite = state.friendInvites.find((entry) => entry.code === code && entry.status === "open");
  if (!invite) throw httpError(404, "INVITE_NOT_FOUND", "Friend invite code is not open.");
  if (invite.host_account_id === accountId) {
    throw httpError(409, "INVITE_SELF_MATCH_BLOCKED", "A League account cannot accept its own invite.");
  }

  const hostPet = ownedPet(state, invite.host_account_id, invite.host_pet_id);
  assertPetAvailableForBattle(state, hostPet.id);
  if (hostPet.battle_class !== guestPet.battle_class) {
    throw httpError(409, "BATTLE_CLASS_MISMATCH", "Friend Duel requires both pets to be in the same Battle Class.");
  }

  const room = createPvpBattleRoom(state, {
    mode: "friend",
    source: "friend_invite",
    playerAccountId: invite.host_account_id,
    playerPet: hostPet,
    opponentAccountId: accountId,
    opponentPet: guestPet,
    metadata: { invite_id: invite.id, invite_code: invite.code },
  });
  invite.status = "accepted";
  invite.guest_account_id = accountId;
  invite.guest_pet_id = guestPet.id;
  invite.battle_room_id = room.id;
  invite.accepted_at = new Date().toISOString();
  cancelWaitingTicketsForPet(state, hostPet.id, "friend_invite");
  cancelWaitingTicketsForPet(state, guestPet.id, "friend_invite");
  cancelOpenInvitesForPet(state, hostPet.id, "friend_invite", [invite.id]);
  cancelOpenInvitesForPet(state, guestPet.id, "friend_invite");
  logEvent(state, "friend_invite.accepted", accountId, {
    invite_id: invite.id,
    code: invite.code,
    battle_room_id: room.id,
  });
  return { status: "matched", invite: publicInvite(invite), battle: publicBattleRoom(room, accountId) };
}

export function xpStatus(state, accountId, petId) {
  const pet = ownedPet(state, accountId, petId);
  const counters = dailyCounters(state, accountId, pet.id);
  return {
    pet,
    counters,
    caps: XP_CAPS,
    status_text: statusText(counters),
    reset_at: nextUtcMidnight().toISOString(),
  };
}

export function leaderboard(state) {
  return [...state.pets]
    .filter((pet) => pet.status === "active")
    .sort((a, b) => b.rating.lp - a.rating.lp)
    .map((pet, index) => ({
      rank: index + 1,
      pet_id: pet.id,
      name: pet.name,
      owner_account_id: pet.owner_account_id,
      battle_class: pet.battle_class,
      primary_element: pet.primary_element,
      secondary_element: pet.secondary_element,
      level: pet.level,
      lp: pet.rating.lp,
      tier_label: pet.rating.label,
      wins: pet.rating.wins,
      losses: pet.rating.losses,
      draws: pet.rating.draws,
    }));
}

export function ownedPet(state, accountId, petId) {
  const pet = state.pets.find((entry) => entry.id === petId && entry.owner_account_id === accountId);
  if (!pet) throw httpError(404, "PET_NOT_FOUND", "Pet not found for this account.");
  return pet;
}

export function ownedBattleRoom(state, accountId, battleRoomId) {
  const room = (state.battleRooms ?? []).find(
    (entry) => entry.id === battleRoomId && sideKeyForAccount(entry, accountId),
  );
  if (!room) throw httpError(404, "BATTLE_ROOM_NOT_FOUND", "Battle room not found for this account.");
  return room;
}

export function petAsset(state, pet) {
  return state.assets.find((asset) => asset.id === pet.pet_asset_id);
}

export function publicPetView(state, pet) {
  return {
    ...pet,
    asset: petAsset(state, pet),
    skills: pet.skills
      .map((skillId) => OFFICIAL_SKILLS.find((skill) => skill.id === skillId))
      .filter(Boolean)
      .map((skill) => ({
        ...skill,
        alias: pet.skill_aliases?.[skill.id] ?? null,
      })),
  };
}

export function dailyCounters(state, accountId, petId, now = new Date()) {
  const dayStart = startOfUtcDay(now);
  const weekStart = startOfUtcWeek(now);
  const ledger = state.xpLedger.filter((entry) => entry.account_id === accountId && entry.pet_id === petId);
  const today = ledger.filter((entry) => new Date(entry.applied_at) >= dayStart);
  const week = ledger.filter((entry) => new Date(entry.applied_at) >= weekStart);

  return {
    petDaily: sum(today, "pet_xp_delta"),
    trainingDaily: sum(today.filter((entry) => entry.source_type === "training_report"), "pet_xp_delta"),
    battleDaily: sum(today.filter((entry) => entry.source_type.endsWith("_battle") || entry.source_type === "friend_duel"), "pet_xp_delta"),
    friendDaily: sum(today.filter((entry) => entry.source_type === "friend_duel"), "pet_xp_delta"),
    styleDaily: sum(today, "style_xp_delta"),
    styleWeekly: sum(week, "style_xp_delta"),
    trainingReportsUsed: today.filter(
      (entry) => entry.source_type === "training_report" && entry.metadata?.pet_eligible,
    ).length,
  };
}

export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function appendXpLedger(state, input) {
  const duplicate = state.xpLedger.find(
    (entry) =>
      entry.account_id === input.accountId &&
      entry.pet_id === input.petId &&
      entry.source_type === input.sourceType &&
      entry.source_id === input.sourceId,
  );
  if (duplicate) return duplicate;
  const previous = state.xpLedger.at(-1);
  state.xpLedger.push({
    id: `xp_${randomUUID()}`,
    account_id: input.accountId,
    pet_id: input.petId,
    source_type: input.sourceType,
    source_id: input.sourceId,
    pet_xp_delta: input.petXpDelta,
    style_xp_delta: input.styleXpDelta,
    cap_buckets_json: input.capBuckets,
    metadata: input.metadata ?? {},
    previous_hash: previous?.hash ?? null,
    applied_at: new Date().toISOString(),
  });
  const entry = state.xpLedger.at(-1);
  entry.hash = createHash("sha256").update(JSON.stringify({ ...entry, hash: undefined })).digest("hex");
  return entry;
}

function appendLpLedger(state, input) {
  const duplicate = state.lpLedger.find(
    (entry) => entry.account_id === input.accountId && entry.pet_id === input.petId && entry.battle_room_id === input.battleRoomId,
  );
  if (duplicate) return duplicate;
  const previous = state.lpLedger.at(-1);
  const entry = {
    id: `lp_${randomUUID()}`,
    account_id: input.accountId,
    pet_id: input.petId,
    season_id: input.seasonId,
    battle_room_id: input.battleRoomId ?? null,
    source_type: "ranked_battle",
    lp_delta: input.lpDelta,
    lp_before: input.lpBefore,
    lp_after: input.lpAfter,
    opponent_lp: input.opponentLp,
    previous_hash: previous?.hash ?? null,
    applied_at: input.appliedAt,
  };
  entry.hash = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
  state.lpLedger.push(entry);
  return entry;
}

function settleBattleResult(state, accountId, pet, input) {
  const mode = input.mode;
  const result = input.result;
  const opponentLp = Number(input.opponentLp ?? pet.rating.lp);
  const opponent = input.opponent ?? defaultOpponentFor(pet, opponentLp);
  const counters = dailyCounters(state, accountId, pet.id);
  const official = input.official !== false;
  let award = official ? calculateBattleAward({ mode, result, counters }) : { rawPetXp: 0, petXpApplied: 0, capped: false };
  if (official && mode === "friend") {
    const pairCount = friendPairDailyCount(state, accountId, pet.id, opponent.pet_id);
    const meaningfulTurns = Number(input.turnCount ?? 0) >= 2;
    if (!meaningfulTurns || pairCount >= 3) {
      award = { ...award, petXpApplied: 0, capped: true };
      appendRiskEvent(state, {
        accountId,
        petId: pet.id,
        type: "friend.reward_suppressed",
        severity: pairCount >= 3 ? "medium" : "low",
        score: pairCount >= 3 ? 35 : 10,
        metadata: { pair_pet_id: opponent.pet_id, pair_count: pairCount, turn_count: input.turnCount ?? 0 },
      });
    }
  }
  const now = input.now ?? new Date().toISOString();
  let lp = null;
  const season = activeSeason(state);
  if (mode === "ranked") ensureActiveSeasonRating(pet, season);

  if (official && mode === "ranked" && input.source === "random_matchmaking") {
    const normalizedResult = result === "complete" ? "draw" : result;
    const delta = lpDelta({
      result: normalizedResult,
      playerLp: pet.rating.lp,
      opponentLp,
      placement: pet.rating.placements_remaining > 0,
    });
    const before = pet.rating.lp;
    pet.rating.lp = Math.max(0, pet.rating.lp + delta);
    const tier = tierForLp(pet.rating.lp);
    pet.rating.tier = tier.tier;
    pet.rating.division = tier.division;
    pet.rating.label = tier.label;
    if (normalizedResult === "win") pet.rating.wins += 1;
    if (normalizedResult === "loss" || normalizedResult === "afk_loss") pet.rating.losses += 1;
    if (normalizedResult === "draw") pet.rating.draws += 1;
    pet.rating.placements_remaining = Math.max(0, pet.rating.placements_remaining - 1);
    lp = { before, after: pet.rating.lp, delta, opponent_lp: opponentLp, placement: pet.rating.placements_remaining };
    appendLpLedger(state, {
      accountId,
      petId: pet.id,
      seasonId: season.id,
      battleRoomId: input.battleRoomId,
      lpDelta: delta,
      lpBefore: before,
      lpAfter: pet.rating.lp,
      opponentLp,
      appliedAt: now,
    });
  }

  const battle = {
    id: `battle_${randomUUID()}`,
    account_id: accountId,
    pet_id: pet.id,
    season_id: mode === "ranked" ? season.id : input.seasonId ?? null,
    mode,
    result,
    opponent,
    pet_xp_delta: award.petXpApplied,
    lp,
    stats_snapshot_json: input.statsSnapshot ?? pet.stats,
    battle_class_at_start: input.battleClass ?? pet.battle_class,
    asset_hash_at_start: input.assetHash ?? petAsset(state, pet).canonical_hash,
    battle_source: input.source ?? "server_turn",
    battle_room_id: input.battleRoomId ?? null,
    replay_hash: input.replayHash ?? null,
    turn_count: input.turnCount ?? null,
    replay_log_json: input.replayLog ?? null,
    created_at: now,
  };
  state.battles.push(battle);
  if (official) {
    appendXpLedger(state, {
      accountId,
      petId: pet.id,
      sourceType: mode === "friend" ? "friend_duel" : `${mode}_battle`,
      sourceId: battle.id,
      petXpDelta: award.petXpApplied,
      styleXpDelta: 0,
      capBuckets: mode === "friend" ? ["pet_daily", "battle_daily", "friend_daily"] : ["pet_daily", "battle_daily"],
      metadata: { mode, result, source: battle.battle_source, battle_room_id: input.battleRoomId ?? null },
    });
    applyProgression(pet, award.petXpApplied, 0);
  }
  logEvent(state, "battle.finished", accountId, {
    pet_id: pet.id,
    battle_id: battle.id,
    battle_room_id: input.battleRoomId ?? null,
    mode,
    result,
    pet_xp_delta: award.petXpApplied,
    lp_delta: lp?.delta ?? 0,
  });

  return { battle, award, pet, counters: dailyCounters(state, accountId, pet.id) };
}

function advanceBattleRoom(state, room) {
  const now = new Date().toISOString();
  resolveExpiredTurn(room, now);
  submitBotActionIfNeeded(room, now);
  resolveTurnIfReady(room, now);
  settleFinishedTurnBattle(state, room);
}

function advanceAllBattleRooms(state) {
  for (const room of state.battleRooms ?? []) {
    if (room.status === "in_progress") advanceBattleRoom(state, room);
  }
}

function settleFinishedTurnBattle(state, room) {
  if (room.status !== "finished") return [];
  room.settlement_battle_ids ??= {};
  const settlements = [];
  for (const sideKey of ["player", "opponent"]) {
    const side = room.sides[sideKey];
    if (side.kind !== "player" || !side.account_id || !side.pet_id || room.settlement_battle_ids[sideKey]) continue;
    const opponentSide = room.sides[sideKey === "player" ? "opponent" : "player"];
    const pet = ownedPet(state, side.account_id, side.pet_id);
    const settlement = settleBattleResult(state, side.account_id, pet, {
      mode: room.mode,
      result: resultForSide(room, sideKey),
      opponentLp: opponentSide.lp ?? pet.rating.lp,
      opponent: {
        name: opponentSide.name,
        lp: opponentSide.lp,
        primary_element: opponentSide.primary_element,
        secondary_element: opponentSide.secondary_element,
        kind: opponentSide.kind,
        pet_id: opponentSide.pet_id ?? null,
      },
      statsSnapshot: side.stats,
      battleClass: side.battle_class,
      assetHash: side.asset_hash,
      source: room.source ?? "server_turn",
      seasonId: room.season_id ?? null,
      battleRoomId: room.id,
      replayHash: room.replay_hash,
      turnCount: room.log.length,
      replayLog: room.log,
      now: room.result.finished_at,
    });
    room.settlement_battle_ids[sideKey] = settlement.battle.id;
    if (!room.settlement_battle_id && sideKey === "player") room.settlement_battle_id = settlement.battle.id;
    settlements.push(settlement);
  }
  room.updated_at = new Date().toISOString();
  return settlements;
}

function matchWaitingTicket(state, ticket) {
  const now = new Date();
  const candidate = (state.matchTickets ?? [])
    .filter((entry) => entry.status === "waiting" && entry.id !== ticket.id)
    .filter((entry) => entry.account_id !== ticket.account_id)
    .filter((entry) => entry.mode === ticket.mode)
    .filter((entry) => entry.battle_class === ticket.battle_class)
    .filter((entry) => ticket.mode !== "ranked" || entry.season_id === ticket.season_id)
    .filter((entry) => Math.abs(entry.lp - ticket.lp) <= effectiveMatchWindow(ticket, entry, now))
    .filter((entry) => !petHasActiveBattle(state, entry.pet_id))
    .sort((a, b) => Math.abs(a.lp - ticket.lp) - Math.abs(b.lp - ticket.lp) || a.created_at.localeCompare(b.created_at))[0];

  if (!candidate) return null;
  const playerPet = ownedPet(state, candidate.account_id, candidate.pet_id);
  const opponentPet = ownedPet(state, ticket.account_id, ticket.pet_id);
  assertPetAvailableForBattle(state, playerPet.id);
  assertPetAvailableForBattle(state, opponentPet.id);
  const room = createPvpBattleRoom(state, {
    mode: ticket.mode,
    source: "random_matchmaking",
    playerAccountId: candidate.account_id,
    playerPet,
    opponentAccountId: ticket.account_id,
    opponentPet,
    metadata: {
      player_ticket_id: candidate.id,
      opponent_ticket_id: ticket.id,
      lp_gap: Math.abs(candidate.lp - ticket.lp),
    },
  });
  for (const matchedTicket of [candidate, ticket]) {
    matchedTicket.status = "matched";
    matchedTicket.matched_at = room.created_at;
    matchedTicket.battle_room_id = room.id;
  }
  cancelWaitingTicketsForPet(state, playerPet.id, "matched", [candidate.id, ticket.id]);
  cancelWaitingTicketsForPet(state, opponentPet.id, "matched", [candidate.id, ticket.id]);
  cancelOpenInvitesForPet(state, playerPet.id, "matched");
  cancelOpenInvitesForPet(state, opponentPet.id, "matched");
  return { room, opponentTicket: candidate };
}

function matchedResponse(state, room, ticket, opponentTicket, accountId) {
  logEvent(state, "matchmaking.matched", accountId, {
    ticket_id: ticket.id,
    opponent_ticket_id: opponentTicket.id,
    battle_room_id: room.id,
    mode: room.mode,
  });
  return {
    status: "matched",
    ticket: publicTicket(ticket),
    opponent_ticket: publicTicket(opponentTicket),
    battle: publicBattleRoom(room, accountId),
    season: activeSeason(state),
    policy: publicMatchmakingPolicy(room.mode),
  };
}

function createPvpBattleRoom(state, input) {
  const room = createBattleRoomSnapshot({
    id: `battle_room_${randomUUID()}`,
    accountId: input.playerAccountId,
    pet: input.playerPet,
    mode: input.mode,
    assetHash: petAsset(state, input.playerPet).canonical_hash,
    opponent: opponentFromPet(state, input.opponentAccountId, input.opponentPet),
  });
  room.source = input.source;
  room.season_id = input.mode === "ranked" ? activeSeason(state).id : null;
  room.metadata = input.metadata ?? {};
  room.participant_account_ids = [input.playerAccountId, input.opponentAccountId];
  room.participant_pet_ids = [input.playerPet.id, input.opponentPet.id];
  state.battleRooms ??= [];
  state.battleRooms.unshift(room);
  logEvent(state, "battle.room.started", input.playerAccountId, {
    pet_id: input.playerPet.id,
    battle_room_id: room.id,
    mode: input.mode,
    source: input.source,
    opponent_pet_id: input.opponentPet.id,
  });
  logEvent(state, "battle.room.started", input.opponentAccountId, {
    pet_id: input.opponentPet.id,
    battle_room_id: room.id,
    mode: input.mode,
    source: input.source,
    opponent_pet_id: input.playerPet.id,
  });
  return room;
}

function createMatchTicket(accountId, pet, mode, season) {
  return {
    id: `ticket_${randomUUID()}`,
    account_id: accountId,
    pet_id: pet.id,
    mode,
    season_id: mode === "ranked" ? season.id : null,
    status: "waiting",
    battle_class: pet.battle_class,
    lp: pet.rating.lp,
    tier_label: pet.rating.label,
    created_at: new Date().toISOString(),
    matched_at: null,
    battle_room_id: null,
  };
}

function publicTicket(ticket) {
  const waitSeconds = ticketWaitSeconds(ticket);
  return {
    id: ticket.id,
    pet_id: ticket.pet_id,
    mode: ticket.mode,
    season_id: ticket.season_id ?? null,
    status: ticket.status,
    battle_class: ticket.battle_class,
    lp: ticket.lp,
    tier_label: ticket.tier_label,
    wait_seconds: waitSeconds,
    search_window_lp: ticketSearchWindow(ticket, waitSeconds),
    battle_room_id: ticket.battle_room_id,
    created_at: ticket.created_at,
    matched_at: ticket.matched_at,
  };
}

function publicInvite(invite) {
  return {
    id: invite.id,
    code: invite.code,
    host_pet_id: invite.host_pet_id,
    mode: invite.mode,
    status: invite.status,
    battle_class: invite.battle_class,
    battle_room_id: invite.battle_room_id,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    accepted_at: invite.accepted_at ?? null,
  };
}

function opponentFromPet(state, accountId, pet) {
  return {
    kind: "player",
    account_id: accountId,
    pet_id: pet.id,
    name: pet.name,
    lp: pet.rating.lp,
    level: pet.level,
    battle_class: pet.battle_class,
    primary_element: pet.primary_element,
    secondary_element: pet.secondary_element,
    stats: pet.stats,
    skills: pet.skills,
    asset_hash: petAsset(state, pet).canonical_hash,
  };
}

function assertPetAvailableForBattle(state, petId) {
  advanceAllBattleRooms(state);
  const activeRoom = petHasActiveBattle(state, petId);
  if (activeRoom) {
    throw httpError(409, "PET_ALREADY_IN_BATTLE", "This pet already has an active battle room.");
  }
}

function petHasActiveBattle(state, petId) {
  return (state.battleRooms ?? []).find(
    (room) => room.status === "in_progress" && [room.sides.player.pet_id, room.sides.opponent.pet_id].includes(petId),
  );
}

function cancelWaitingTicketsForPet(state, petId, reason, preserveIds = []) {
  const preserve = new Set(preserveIds);
  for (const ticket of state.matchTickets ?? []) {
    if (ticket.pet_id === petId && ticket.status === "waiting" && !preserve.has(ticket.id)) {
      ticket.status = "cancelled";
      ticket.cancel_reason = reason;
      ticket.cancelled_at = new Date().toISOString();
    }
  }
}

function cancelOpenInvitesForPet(state, petId, reason, preserveIds = []) {
  const preserve = new Set(preserveIds);
  for (const invite of state.friendInvites ?? []) {
    if (invite.host_pet_id === petId && invite.status === "open" && !preserve.has(invite.id)) {
      invite.status = "cancelled";
      invite.cancel_reason = reason;
      invite.cancelled_at = new Date().toISOString();
    }
  }
}

function activeSeason(state) {
  state.seasons ??= [DEFAULT_SEASON];
  state.activeSeasonId ??= DEFAULT_SEASON.id;
  return state.seasons.find((season) => season.id === state.activeSeasonId) ?? DEFAULT_SEASON;
}

function ensureActiveSeasonRating(pet, season) {
  if (pet.rating?.season_id === season.id) return;
  pet.season_history ??= [];
  if (pet.rating) {
    pet.season_history.push({
      ...pet.rating,
      archived_at: new Date().toISOString(),
    });
  }
  const tier = tierForLp(season.ranked_seed_lp);
  pet.rating = {
    season_id: season.id,
    lp: season.ranked_seed_lp,
    tier: tier.tier,
    division: tier.division,
    label: tier.label,
    wins: 0,
    losses: 0,
    draws: 0,
    placements_remaining: season.placement_matches,
  };
}

function effectiveMatchWindow(ticket, candidate, now = new Date()) {
  return Math.max(ticketSearchWindow(ticket, ticketWaitSeconds(ticket, now)), ticketSearchWindow(candidate, ticketWaitSeconds(candidate, now)));
}

function ticketSearchWindow(ticket, waitSeconds = ticketWaitSeconds(ticket)) {
  return matchmakingWindowFor(ticket.mode, waitSeconds);
}

function ticketWaitSeconds(ticket, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - new Date(ticket.created_at).getTime()) / 1000));
}

function publicMatchmakingPolicy(mode) {
  return MATCHMAKING_POLICY[mode] ?? MATCHMAKING_POLICY.casual;
}

function queueSummary(state) {
  const waiting = (state.matchTickets ?? []).filter((ticket) => ticket.status === "waiting");
  return {
    waiting_total: waiting.length,
    ranked_waiting: waiting.filter((ticket) => ticket.mode === "ranked").length,
    casual_waiting: waiting.filter((ticket) => ticket.mode === "casual").length,
  };
}

function friendPairDailyCount(state, accountId, petId, opponentPetId) {
  if (!opponentPetId) return 0;
  const dayStart = startOfUtcDay(new Date());
  return (state.battles ?? []).filter(
    (battle) =>
      battle.account_id === accountId &&
      battle.pet_id === petId &&
      battle.mode === "friend" &&
      battle.opponent?.pet_id === opponentPetId &&
      new Date(battle.created_at) >= dayStart,
  ).length;
}

function createInviteCode(state) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += alphabet[randomInt(alphabet.length)];
    }
    if (!(state.friendInvites ?? []).some((invite) => invite.code === code && invite.status === "open")) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function normalizeInviteCode(code) {
  return String(code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function expireOldInvites(state) {
  const now = new Date();
  for (const invite of state.friendInvites ?? []) {
    if (invite.status === "open" && new Date(invite.expires_at) <= now) {
      invite.status = "expired";
    }
  }
}

function applyProgression(pet, petXpDelta, styleXpDelta) {
  pet.xp += petXpDelta;
  pet.style_xp += styleXpDelta;
  const progression = progressionFromXp(pet.xp);
  pet.level = progression.level;
  pet.mastery_level = progression.masteryLevel;
  pet.stats = deriveStats({
    primaryElement: pet.primary_element,
    secondaryElement: pet.secondary_element,
    level: pet.level,
  });
  pet.battle_class = battleClassForTotalStats(pet.stats.total);
  pet.updated_at = new Date().toISOString();
}

function defaultLoadout(primaryElement, secondaryElement) {
  const primarySkills = OFFICIAL_SKILLS.filter((skill) => skill.element === primaryElement).slice(0, 3);
  const secondarySkills = secondaryElement
    ? OFFICIAL_SKILLS.filter((skill) => skill.element === secondaryElement).slice(0, 1)
    : OFFICIAL_SKILLS.filter((skill) => skill.element === primaryElement).slice(3, 4);
  return [...primarySkills, ...secondarySkills].map((skill) => skill.id).slice(0, 4);
}

function defaultOpponentFor(pet, opponentLp) {
  return {
    name: "Queue Rival",
    lp: opponentLp,
    primary_element: "Logic",
    secondary_element: "Pulse",
    element_modifier_against_pet: elementModifier(
      { primaryElement: "Logic", secondaryElement: "Pulse" },
      { primaryElement: pet.primary_element, secondaryElement: pet.secondary_element },
    ),
  };
}

function defaultTurnOpponentFor(pet, opponentLp) {
  const primaryElement = "Logic";
  const secondaryElement = "Pulse";
  const stats = deriveStats({
    primaryElement,
    secondaryElement,
    level: pet.level,
  });
  return {
    kind: "bot",
    name: "Queue Rival",
    lp: opponentLp,
    level: pet.level,
    battle_class: battleClassForTotalStats(stats.total),
    primary_element: primaryElement,
    secondary_element: secondaryElement,
    stats,
    skills: defaultLoadout(primaryElement, secondaryElement),
    asset_hash: "server-bot-queue-rival",
  };
}

function validateManifest(manifest) {
  const expected = defaultManifest();
  for (const key of ["width", "height", "cell_width", "cell_height", "columns", "rows"]) {
    if (Number(manifest[key]) !== expected[key]) {
      throw httpError(400, "ASSET_FORMAT_INVALID", `Expected ${key} to be ${expected[key]}.`);
    }
  }
  if (!Array.isArray(manifest.states) || manifest.states.join("|") !== expected.states.join("|")) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Sprite state rows do not match the Codex pet hatch layout.");
  }
  return expected;
}

function defaultManifest() {
  return {
    width: 1536,
    height: 1872,
    cell_width: 192,
    cell_height: 208,
    columns: 8,
    rows: 9,
    chroma_key: "#FF00FF",
    states: ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"],
  };
}

function sanitizeName(name) {
  return String(name).trim().replace(/[<>]/g, "").slice(0, 32) || "Codex Pet";
}

function sanitizeIdentifier(identifier) {
  return String(identifier).trim().toLowerCase().slice(0, 128) || "demo@codexpet.local";
}

function sanitizeSkillAliases(aliases) {
  const sanitized = {};
  for (const [skillId, alias] of Object.entries(aliases ?? {})) {
    if (!OFFICIAL_SKILLS.some((skill) => skill.id === skillId)) continue;
    const clean = String(alias ?? "").trim().replace(/[<>]/g, "").slice(0, 24);
    if (clean) sanitized[skillId] = clean;
  }
  return sanitized;
}

function findOrCreateVerifiedAccount(state, challenge) {
  const existing = state.accounts.find(
    (account) => account.identifier === challenge.identifier || account.email === challenge.identifier,
  );
  if (existing) {
    existing.verified = true;
    existing.authMethods = Array.from(new Set([...(existing.authMethods ?? []), challenge.method]));
    existing.identifier = existing.identifier ?? challenge.identifier;
    return existing;
  }

  const account = {
    id: `acct_${randomUUID()}`,
    displayName: challenge.identifier.split("@")[0] || "League Player",
    identifier: challenge.identifier,
    email: challenge.method === "email_magic_link" ? challenge.identifier : null,
    verified: true,
    authMethods: [challenge.method],
    createdAt: new Date().toISOString(),
  };
  state.accounts.push(account);
  return account;
}

function publicSession(session) {
  return {
    id: session.id,
    account_id: session.account_id,
    method: session.method,
    created_at: session.created_at,
    expires_at: session.expires_at,
    revoked_at: session.revoked_at,
  };
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i += 1) code += alphabet[randomInt(alphabet.length)];
  return code;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashAuthCode(challengeId, code) {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateAtlasDataUrl(dataUrl, manifest) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas upload must be a PNG data URL.");
  }

  const buffer = Buffer.from(match[1], "base64");
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas upload is not a valid PNG file.");
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== manifest.width || height !== manifest.height) {
    throw httpError(
      400,
      "ASSET_FORMAT_INVALID",
      `Atlas PNG must be ${manifest.width}x${manifest.height}; received ${width}x${height}.`,
    );
  }

  return {
    width,
    height,
    byteLength: buffer.length,
    sha256: hashBuffer(buffer),
  };
}

function logEvent(state, type, accountId, payload) {
  state.events.unshift({
    id: `event_${randomUUID()}`,
    type,
    account_id: accountId,
    payload,
    created_at: new Date().toISOString(),
  });
  state.events = state.events.slice(0, 200);
}

function statusText(counters) {
  return {
    pet: `${counters.petDaily} / ${XP_CAPS.petDaily}`,
    training: `${counters.trainingDaily} / ${XP_CAPS.trainingDaily}`,
    battle: `${counters.battleDaily} / ${XP_CAPS.battleDaily}`,
    friend: `${counters.friendDaily} / ${XP_CAPS.friendDaily}`,
    reports: `${counters.trainingReportsUsed} / ${XP_CAPS.petEligibleTrainingReportsDaily}`,
    style: `${counters.styleDaily} / ${XP_CAPS.styleDaily}`,
    weeklyStyle: `${counters.styleWeekly} / ${XP_CAPS.styleWeekly}`,
  };
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date) {
  const day = startOfUtcDay(date);
  const weekday = day.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

function nextUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
