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
import { accountIntegrityStatus, appendRiskEvent, auditState, riskTrainingReport } from "./audit.js";

const MAX_APPEARANCE_BYTES = 4096;
const MAX_ATLAS_BYTES = 6 * 1024 * 1024;

export function getAccount(state, accountId = "acct_demo") {
  const account = state.accounts.find((entry) => entry.id === accountId);
  if (!account || !account.verified) {
    throw httpError(401, "ACCOUNT_NOT_VERIFIED", "A verified League account is required.");
  }
  return account;
}

export function requireAdmin(state, accountId) {
  const account = getAccount(state, accountId);
  if (account.role !== "admin") {
    throw httpError(403, "ADMIN_REQUIRED", "An admin League account is required.");
  }
  return account;
}

export function leagueStatus(state) {
  const season = activeSeason(state);
  return {
    active_season: season,
    matchmaking_policy: MATCHMAKING_POLICY,
    queue_summary: queueSummary(state),
    live_ops: publicOpsStatus(state),
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
  const appearance = sanitizeAppearance(input.appearance ?? {});
  const canonicalInput = {
    owner_account_id: accountId,
    manifest,
    appearance,
    atlas_sha256: atlas?.sha256 ?? null,
    hatch_source: sanitizeHatchSource(input.hatch_source ?? "codex_app"),
  };
  const canonicalHash = hashJson(canonicalInput);
  state.assets ??= [];
  const duplicate = state.assets.find(
    (entry) =>
      entry.owner_account_id === accountId &&
      entry.canonical_hash === canonicalHash &&
      entry.asset_status === "active" &&
      entry.safety_status === "clear",
  );
  if (duplicate) return duplicate;

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
    appearance,
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
  syncCosmeticRewards(pet);
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

export function adminConsole(state) {
  const audit = auditState(state);
  return {
    audit,
    ops: publicOpsStatus(state),
    review_cases: reviewCases(state),
    held_training_reports: (state.trainingReports ?? [])
      .filter((report) => report.status === "review")
      .slice(-50)
      .reverse(),
    moderation_queue: moderationQueue(state),
    abuse_alerts: activeAbuseAlerts(state),
    recent_risk_events: (state.riskEvents ?? []).slice(0, 50),
    recent_enforcement_events: (state.events ?? []).filter((event) => event.type === "enforcement.updated").slice(0, 20),
    recent_moderation_events: (state.events ?? []).filter((event) => event.type === "asset.moderated").slice(0, 20),
    suspicious_accounts: (state.accounts ?? [])
      .map((account) => accountIntegrityStatus(state, account.id))
      .filter((status) => status.level !== "clear" || status.automatic_restrictions.ranked_locked),
    seasons: state.seasons ?? [],
    season_rewards: (state.seasonRewards ?? []).slice(-50).reverse(),
    auth_provider: authProviderStatus(),
    bridge_attestation: bridgeAttestationStatus(),
  };
}

export function runServerAuthorityJob(state, input = {}) {
  const now = new Date(input.now ?? new Date()).toISOString();
  const startedAt = new Date().toISOString();
  const matches = processMatchmakingQueues(state).matches.length;
  const reconciled = reconcileBattleSettlements(state);
  const alerts = generateAbuseAlerts(state, now);
  const audit = auditState(state);
  const job = {
    id: `ops_${randomUUID()}`,
    type: "server_authority_reconcile",
    status: audit.ok ? "ok" : "review",
    matches_processed: matches,
    settlements_reconciled: reconciled,
    abuse_alerts_created: alerts.length,
    high_findings: audit.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical").length,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  state.opsJobs ??= [];
  state.opsJobs.unshift(job);
  state.opsJobs = state.opsJobs.slice(0, 100);
  logEvent(state, "ops.server_authority_job", input.adminAccountId ?? null, {
    job_id: job.id,
    status: job.status,
    settlements_reconciled: reconciled,
    abuse_alerts_created: alerts.length,
  });
  return { job, audit, abuse_alerts: alerts, ops: publicOpsStatus(state) };
}

export function draftTrainingReport(state, accountId, petId, input = {}) {
  const pet = ownedPet(state, accountId, petId);
  const counters = dailyCounters(state, accountId, pet.id);
  const signals = input.signals ?? {};
  const baseClassification = classifyTrainingReport(signals);
  const riskContext = trainingRiskContext(state, accountId, pet.id, signals, baseClassification.reportType);
  const classification = { ...baseClassification, ...riskContext };
  const isFirstDailyReport = counters.trainingReportsUsed === 0;
  const award = calculateTrainingAward({
    reportType: classification.reportType,
    counters,
    isFirstDailyReport,
  });
  const risk = riskTrainingReport({
    signals,
    counters,
    classification,
    trust: input.server_trust ?? { trusted: false, reason: "draft_untrusted" },
  });

  return {
    id: `draft_${randomUUID()}`,
    pet_id: pet.id,
    report_type: classification.reportType,
    element_signal: classification.elementSignal,
    quality_score: classification.qualityScore,
    award_preview: award,
    risk_preview: {
      score: risk.score,
      flags: risk.flags,
      hold_for_review: risk.hold_for_review,
    },
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
  const signals = input.signals ?? {};
  const baseClassification = classifyTrainingReport(signals);
  const riskContext = trainingRiskContext(state, accountId, pet.id, signals, baseClassification.reportType);
  const classification = { ...baseClassification, ...riskContext };
  const isFirstDailyReport = counters.trainingReportsUsed === 0;
  const award = calculateTrainingAward({
    reportType: classification.reportType,
    counters,
    isFirstDailyReport,
  });
  const risk = riskTrainingReport({
    signals,
    counters,
    classification,
    trust: input.server_trust ?? { trusted: false, reason: "not_verified" },
  });
  const effectiveAward = risk.hold_for_review
    ? { ...award, petXpApplied: 0, styleXpApplied: 0, capped: true }
    : award;
  const now = new Date().toISOString();
  const report = {
    id: `report_${randomUUID()}`,
    account_id: accountId,
    pet_id: pet.id,
    client_report_id: clientReportId,
    summary_json: signals,
    summary_hash: riskContext.summaryHash,
    status: risk.hold_for_review ? "review" : "approved",
    report_type: classification.reportType,
    element_signal: classification.elementSignal,
    quality_score: classification.qualityScore,
    risk_score: risk.score,
    risk_flags: risk.flags,
    trust_reason: input.server_trust?.reason ?? "not_verified",
    review_reason: risk.flags.join(", ") || null,
    award_preview_json: award,
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
    const battleClassBefore = pet.battle_class;
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
    if (pet.battle_class !== battleClassBefore) cancelWaitingTicketsForPet(state, pet.id, "pet_progressed");
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

export function reviewTrainingReport(state, adminAccountId, input = {}) {
  requireAdmin(state, adminAccountId);
  const report = (state.trainingReports ?? []).find((entry) => entry.id === input.report_id);
  if (!report) throw httpError(404, "TRAINING_REPORT_NOT_FOUND", "Training Report not found.");
  if (report.status !== "review") {
    throw httpError(409, "TRAINING_REPORT_NOT_REVIEWABLE", "Only review-held Training Reports can be resolved.");
  }
  const decision = input.decision === "approve" ? "approve" : "reject";
  const now = new Date().toISOString();
  report.reviewed_by = adminAccountId;
  report.reviewed_at = now;
  report.review_note = sanitizeReviewNote(input.note);

  if (decision === "reject") {
    report.status = "rejected";
    report.rejected_at = now;
    logEvent(state, "training.rejected", report.account_id, { report_id: report.id, reviewed_by: adminAccountId });
    return { report };
  }

  const pet = ownedPet(state, report.account_id, report.pet_id);
  const counters = dailyCounters(state, report.account_id, report.pet_id);
  const award = calculateTrainingAward({
    reportType: report.report_type,
    counters,
    isFirstDailyReport: counters.trainingReportsUsed === 0,
  });
  const battleClassBefore = pet.battle_class;
  report.status = "approved";
  report.pet_xp_delta = award.petXpApplied;
  report.style_xp_delta = award.styleXpApplied;
  report.approved_at = now;
  report.approved_by = adminAccountId;
  appendXpLedger(state, {
    accountId: report.account_id,
    petId: report.pet_id,
    sourceType: "training_report",
    sourceId: report.id,
    petXpDelta: award.petXpApplied,
    styleXpDelta: award.styleXpApplied,
    capBuckets: ["pet_daily", "training_daily", "style_daily", "style_weekly"],
    metadata: {
      pet_eligible: award.petEligible,
      report_type: report.report_type,
      quality_score: report.quality_score,
      reviewed_by: adminAccountId,
    },
  });
  applyProgression(pet, award.petXpApplied, award.styleXpApplied);
  if (pet.battle_class !== battleClassBefore) cancelWaitingTicketsForPet(state, pet.id, "pet_progressed");
  logEvent(state, "training.review_approved", report.account_id, { report_id: report.id, reviewed_by: adminAccountId });
  return { report, award, pet };
}

export function updateAccountEnforcement(state, adminAccountId, input = {}) {
  requireAdmin(state, adminAccountId);
  const account = getAccount(state, input.account_id);
  account.enforcement ??= {};
  const action = input.action ?? "watch";
  const now = new Date().toISOString();
  if (action === "ranked_lock") {
    const days = Math.max(1, Math.min(30, Number(input.days ?? 1)));
    account.enforcement.ranked_locked_until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    account.enforcement.reason = sanitizeReviewNote(input.reason ?? "manual_review");
  } else if (action === "ranked_unlock") {
    account.enforcement.ranked_locked_until = null;
    account.enforcement.reason = sanitizeReviewNote(input.reason ?? "manual_unlock");
  } else {
    account.enforcement.watchlisted_at = now;
    account.enforcement.reason = sanitizeReviewNote(input.reason ?? "manual_watch");
  }
  account.enforcement.updated_by = adminAccountId;
  account.enforcement.updated_at = now;
  logEvent(state, "enforcement.updated", account.id, {
    action,
    ranked_locked_until: account.enforcement.ranked_locked_until ?? null,
    updated_by: adminAccountId,
  });
  return { account, integrity: accountIntegrityStatus(state, account.id) };
}

export function reportPetAsset(state, accountId, petId, input = {}) {
  getAccount(state, accountId);
  const pet = state.pets.find((entry) => entry.id === petId && entry.status === "active");
  if (!pet) throw httpError(404, "PET_NOT_FOUND", "Pet not found.");
  if (pet.owner_account_id === accountId) {
    throw httpError(409, "CANNOT_REPORT_OWN_PET", "You cannot report your own pet asset.");
  }
  const asset = petAsset(state, pet);
  const now = new Date().toISOString();
  state.assetReports ??= [];
  const duplicate = state.assetReports.find(
    (report) => report.asset_id === asset.id && report.reporter_account_id === accountId && report.status === "open",
  );
  if (duplicate) return { report: duplicate, asset };
  const report = {
    id: `asset_report_${randomUUID()}`,
    asset_id: asset.id,
    pet_id: pet.id,
    reporter_account_id: accountId,
    owner_account_id: pet.owner_account_id,
    reason: sanitizeReviewNote(input.reason ?? "user_report"),
    status: "open",
    created_at: now,
  };
  state.assetReports.unshift(report);
  const openCount = state.assetReports.filter((entry) => entry.asset_id === asset.id && entry.status === "open").length;
  if (openCount >= 3) {
    asset.safety_status = "reported";
    asset.visibility = "private";
    asset.moderation_reason = "report_threshold";
  }
  appendRiskEvent(state, {
    accountId: pet.owner_account_id,
    petId: pet.id,
    type: "asset.reported",
    severity: openCount >= 3 ? "medium" : "low",
    score: openCount >= 3 ? 35 : 10,
    metadata: { asset_id: asset.id, report_id: report.id, open_reports: openCount },
  });
  logEvent(state, "asset.reported", accountId, { asset_id: asset.id, pet_id: pet.id, report_id: report.id });
  return { report, asset };
}

export function moderateAsset(state, adminAccountId, input = {}) {
  requireAdmin(state, adminAccountId);
  const asset = (state.assets ?? []).find((entry) => entry.id === input.asset_id);
  if (!asset) throw httpError(404, "ASSET_NOT_FOUND", "Asset not found.");
  const action = input.action ?? "clear";
  const now = new Date().toISOString();
  if (action === "hide") {
    asset.safety_status = "blocked";
    asset.visibility = "private";
  } else if (action === "quarantine") {
    asset.safety_status = "review";
    asset.visibility = "private";
  } else {
    asset.safety_status = "clear";
    asset.visibility = "public";
  }
  asset.moderation_reason = sanitizeReviewNote(input.reason ?? action);
  asset.moderated_by = adminAccountId;
  asset.moderated_at = now;
  for (const report of state.assetReports ?? []) {
    if (report.asset_id === asset.id && report.status === "open") {
      report.status = action === "clear" ? "dismissed" : "resolved";
      report.resolved_at = now;
      report.resolved_by = adminAccountId;
    }
  }
  logEvent(state, "asset.moderated", asset.owner_account_id, { asset_id: asset.id, action, moderated_by: adminAccountId });
  return { asset, reports: (state.assetReports ?? []).filter((report) => report.asset_id === asset.id) };
}

export function seasonOperation(state, adminAccountId, input = {}) {
  requireAdmin(state, adminAccountId);
  const action = input.action ?? "status";
  if (action === "end_current") return endCurrentSeason(state, adminAccountId);
  if (action === "start_next") return startNextSeason(state, adminAccountId, input);
  return { active_season: activeSeason(state), seasons: state.seasons ?? [], rewards: state.seasonRewards ?? [] };
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
  if (mode === "ranked") {
    assertRankedAllowed(state, accountId);
    ensureActiveSeasonRating(pet, season);
  }
  assertPetAvailableForBattle(state, pet.id);
  state.matchTickets ??= [];

  const existing = state.matchTickets.find(
    (ticket) => ticket.status === "waiting" && ticket.account_id === accountId && ticket.pet_id === pet.id && ticket.mode === mode,
  );
  if (existing) {
    if (!ticketStillCurrent(state, existing)) {
      cancelTicket(existing, "ticket_stale");
    } else {
      const matched = matchWaitingTicket(state, existing);
      if (matched) return matchedResponse(state, matched.room, existing, matched.opponentTicket, accountId);
      return { status: "waiting", ticket: publicTicket(existing), season, policy: publicMatchmakingPolicy(mode) };
    }
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
  const remaining = {
    pet: Math.max(0, XP_CAPS.petDaily - counters.petDaily),
    training: Math.max(0, XP_CAPS.trainingDaily - counters.trainingDaily),
    battle: Math.max(0, XP_CAPS.battleDaily - counters.battleDaily),
    friend: Math.max(0, XP_CAPS.friendDaily - counters.friendDaily),
    style: Math.max(0, XP_CAPS.styleDaily - counters.styleDaily),
    weeklyStyle: Math.max(0, XP_CAPS.styleWeekly - counters.styleWeekly),
    trainingReports: Math.max(0, XP_CAPS.petEligibleTrainingReportsDaily - counters.trainingReportsUsed),
  };
  return {
    pet,
    counters,
    remaining,
    caps: XP_CAPS,
    status_text: statusText(counters),
    cosmetic_rewards: cosmeticRewardsFor(pet),
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
  const asset = petAsset(state, pet);
  return {
    ...pet,
    asset: {
      ...asset,
      is_visible: asset.visibility !== "private" && asset.safety_status !== "blocked",
    },
    cosmetic_rewards: cosmeticRewardsFor(pet),
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

function reconcileBattleSettlements(state) {
  let reconciled = 0;
  for (const room of state.battleRooms ?? []) {
    const before = Object.keys(room.settlement_battle_ids ?? {}).length;
    if (room.status === "in_progress") advanceBattleRoom(state, room);
    if (room.status === "finished") {
      settleFinishedTurnBattle(state, room);
      const after = Object.keys(room.settlement_battle_ids ?? {}).length;
      reconciled += Math.max(0, after - before);
    }
  }
  return reconciled;
}

function matchWaitingTicket(state, ticket) {
  if (!ticketStillCurrent(state, ticket)) {
    cancelTicket(ticket, "ticket_stale");
    return null;
  }
  const now = new Date();
  const candidate = (state.matchTickets ?? [])
    .filter((entry) => entry.status === "waiting" && entry.id !== ticket.id)
    .filter((entry) => {
      if (ticketStillCurrent(state, entry)) return true;
      cancelTicket(entry, "ticket_stale");
      return false;
    })
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

function ticketStillCurrent(state, ticket) {
  const pet = state.pets.find((entry) => entry.id === ticket.pet_id && entry.owner_account_id === ticket.account_id);
  if (!pet || pet.status !== "active") return false;
  if (pet.battle_class !== ticket.battle_class) return false;
  if (Number(pet.rating?.lp ?? 0) !== Number(ticket.lp ?? 0)) return false;
  if (ticket.mode === "ranked" && pet.rating?.season_id !== ticket.season_id) return false;
  return true;
}

function cancelTicket(ticket, reason) {
  ticket.status = "cancelled";
  ticket.cancel_reason = reason;
  ticket.cancelled_at = new Date().toISOString();
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

function endCurrentSeason(state, adminAccountId) {
  const season = activeSeason(state);
  if (season.status === "completed") {
    throw httpError(409, "SEASON_ALREADY_COMPLETED", "The active season is already completed.");
  }
  const now = new Date().toISOString();
  season.status = "completed";
  season.completed_at = now;
  season.completed_by = adminAccountId;
  state.seasonRewards ??= [];
  const ranked = leaderboard(state).slice(0, 100);
  for (const row of ranked) {
    state.seasonRewards.push({
      id: `season_reward_${randomUUID()}`,
      season_id: season.id,
      account_id: row.owner_account_id,
      pet_id: row.pet_id,
      rank: row.rank,
      tier_label: row.tier_label,
      title: seasonRewardTitle(row),
      status: "grantable",
      created_at: now,
    });
  }
  logEvent(state, "season.completed", adminAccountId, { season_id: season.id, rewards: ranked.length });
  return { season, rewards: state.seasonRewards.filter((reward) => reward.season_id === season.id) };
}

function startNextSeason(state, adminAccountId, input = {}) {
  const current = activeSeason(state);
  if (current.status !== "completed") {
    throw httpError(409, "SEASON_NOT_COMPLETED", "Complete the current season before starting the next one.");
  }
  const index = (state.seasons ?? []).length + 1;
  const startsAt = input.starts_at ?? new Date().toISOString();
  const endsAt =
    input.ends_at ?? new Date(new Date(startsAt).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const season = {
    id: `season_${index}`,
    name: sanitizeReviewNote(input.name ?? `Season ${index}`),
    status: "active",
    starts_at: startsAt,
    ends_at: endsAt,
    ranked_seed_lp: DEFAULT_SEASON.ranked_seed_lp,
    placement_matches: DEFAULT_SEASON.placement_matches,
    created_by: adminAccountId,
  };
  state.seasons.push(season);
  state.activeSeasonId = season.id;
  for (const pet of state.pets ?? []) ensureActiveSeasonRating(pet, season);
  logEvent(state, "season.started", adminAccountId, { season_id: season.id, name: season.name });
  return { season, seasons: state.seasons };
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

function assertRankedAllowed(state, accountId) {
  const account = getAccount(state, accountId);
  const lockedUntil = account.enforcement?.ranked_locked_until;
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    throw httpError(403, "RANKED_LOCKED", "Ranked matchmaking is locked for this account pending integrity review.");
  }
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

function publicOpsStatus(state) {
  const latest = (state.opsJobs ?? [])[0] ?? null;
  const openAlerts = activeAbuseAlerts(state).length;
  const openReviews = (state.trainingReports ?? []).filter((report) => report.status === "review").length;
  return {
    latest_job: latest,
    open_review_cases: openReviews,
    open_abuse_alerts: openAlerts,
    moderation_items: moderationQueue(state).length,
    live_battle_rooms: (state.battleRooms ?? []).filter((room) => room.status === "in_progress").length,
  };
}

function reviewCases(state) {
  const training = (state.trainingReports ?? [])
    .filter((report) => report.status === "review")
    .map((report) => ({
      id: `case_${report.id}`,
      kind: "training_report",
      priority: report.risk_score >= 90 ? "high" : "normal",
      account_id: report.account_id,
      pet_id: report.pet_id,
      subject_id: report.id,
      status: report.status,
      risk_score: report.risk_score ?? 0,
      risk_flags: report.risk_flags ?? [],
      report_type: report.report_type,
      quality_score: report.quality_score,
      reason: report.review_reason ?? report.risk_flags?.join(", ") ?? "review",
      created_at: report.created_at,
    }));
  const accounts = (state.accounts ?? [])
    .map((account) => accountIntegrityStatus(state, account.id))
    .filter((status) => status.level !== "clear")
    .map((status) => ({
      id: `case_integrity_${status.account_id}`,
      kind: "account_integrity",
      priority: status.level === "review" ? "high" : "normal",
      account_id: status.account_id,
      subject_id: status.account_id,
      status: status.level,
      integrity: status,
      reason: status.recommended_actions.join(", ") || "risk_score",
      created_at: new Date().toISOString(),
    }));
  const assets = moderationQueue(state).map((asset) => ({
    id: `case_asset_${asset.id}`,
    kind: "asset_moderation",
    priority: asset.safety_status === "reported" ? "high" : "normal",
    account_id: asset.owner_account_id,
    subject_id: asset.id,
    status: asset.safety_status,
    open_report_count: asset.open_report_count ?? 0,
    visibility: asset.visibility,
    reason: asset.moderation_reason ?? "asset_report",
    created_at: asset.created_at,
  }));
  return [...training, ...accounts, ...assets].slice(0, 100);
}

function moderationQueue(state) {
  const reportCounts = new Map();
  for (const report of state.assetReports ?? []) {
    if (report.status === "open") reportCounts.set(report.asset_id, (reportCounts.get(report.asset_id) ?? 0) + 1);
  }
  return (state.assets ?? [])
    .filter((asset) => asset.safety_status !== "clear" || reportCounts.has(asset.id))
    .map((asset) => ({
      ...asset,
      open_report_count: reportCounts.get(asset.id) ?? 0,
    }))
    .slice(-50)
    .reverse();
}

function activeAbuseAlerts(state) {
  return (state.abuseAlerts ?? []).filter((alert) => alert.status === "open").slice(0, 100);
}

function generateAbuseAlerts(state, nowIso) {
  state.abuseAlerts ??= [];
  const created = [];
  const recentEvents = (state.riskEvents ?? []).filter(
    (event) => new Date(nowIso).getTime() - new Date(event.created_at).getTime() <= 60 * 60 * 1000,
  );
  const byAccount = new Map();
  for (const event of recentEvents) {
    if (!event.account_id) continue;
    const current = byAccount.get(event.account_id) ?? { score: 0, events: 0 };
    current.score += Number(event.score ?? 0);
    current.events += 1;
    byAccount.set(event.account_id, current);
  }
  for (const [accountId, summary] of byAccount) {
    if (summary.score < 150 && summary.events < 5) continue;
    const dedupeKey = `risk_burst:${accountId}:${new Date(nowIso).toISOString().slice(0, 13)}`;
    if (state.abuseAlerts.some((alert) => alert.dedupe_key === dedupeKey)) continue;
    const alert = {
      id: `abuse_${randomUUID()}`,
      dedupe_key: dedupeKey,
      kind: "risk_burst",
      account_id: accountId,
      severity: summary.score >= 250 ? "high" : "medium",
      status: "open",
      summary,
      created_at: nowIso,
    };
    state.abuseAlerts.unshift(alert);
    created.push(alert);
  }
  const audit = auditState(state);
  for (const finding of audit.findings.filter((item) => item.severity === "high" || item.severity === "critical")) {
    const dedupeKey = `audit:${finding.code}:${createHash("sha256").update(finding.message).digest("hex").slice(0, 12)}`;
    if (state.abuseAlerts.some((alert) => alert.dedupe_key === dedupeKey && alert.status === "open")) continue;
    const alert = {
      id: `abuse_${randomUUID()}`,
      dedupe_key: dedupeKey,
      kind: "audit_integrity",
      account_id: null,
      severity: finding.severity,
      status: "open",
      summary: {
        code: finding.code,
        message: finding.message,
      },
      created_at: nowIso,
    };
    state.abuseAlerts.unshift(alert);
    created.push(alert);
  }
  state.abuseAlerts = state.abuseAlerts.slice(0, 500);
  return created;
}

function authProviderStatus() {
  const provider = process.env.CODEX_PET_AUTH_PROVIDER ?? "local_dev";
  return {
    provider,
    passkey: provider !== "local_dev" || process.env.CODEX_PET_PASSKEY_PROVIDER === "true" ? "configured" : "dev_stub",
    email_magic_link: process.env.CODEX_PET_EMAIL_PROVIDER ? "configured" : "dev_stub",
    oauth: process.env.CODEX_PET_OAUTH_ISSUER ? "configured" : "dev_stub",
    dev_codes_exposed: process.env.CODEX_PET_AUTH_DEV_CODE === "true",
  };
}

function bridgeAttestationStatus() {
  return {
    hmac_bridge_secret: process.env.CODEX_PET_BRIDGE_SECRET ? "configured" : "missing",
    codex_app_attestation_secret: process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET ? "configured" : "missing",
    official_openai_identity: "unconfirmed",
  };
}

function seasonRewardTitle(row) {
  if (row.rank === 1) return `${row.tier_label} Champion`;
  if (row.rank <= 10) return `${row.tier_label} Top 10`;
  return `${row.tier_label} Finisher`;
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
  syncCosmeticRewards(pet);
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

function trainingRiskContext(state, accountId, petId, signals, reportType) {
  const now = Date.now();
  const dayStart = now - 24 * 60 * 60 * 1000;
  const burstStart = now - 15 * 60 * 1000;
  const summaryHash = hashJson(signals ?? {});
  const recentReports = (state.trainingReports ?? []).filter(
    (report) => report.account_id === accountId && report.pet_id === petId && new Date(report.created_at).getTime() >= dayStart,
  );
  return {
    summaryHash,
    recentDuplicateEvidenceCount: recentReports.filter((report) => report.summary_hash === summaryHash).length,
    recentHighValueCount: recentReports.filter(
      (report) => ["major", "milestone"].includes(report.report_type) && new Date(report.created_at).getTime() >= dayStart,
    ).length,
    recentBurstCount: recentReports.filter((report) => new Date(report.created_at).getTime() >= burstStart).length,
    currentReportType: reportType,
  };
}

function sanitizeAppearance(appearance) {
  if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)) return {};
  const json = JSON.stringify(appearance);
  if (json.length > MAX_APPEARANCE_BYTES) {
    throw httpError(413, "APPEARANCE_TOO_LARGE", `Pet appearance metadata must be ${MAX_APPEARANCE_BYTES} bytes or smaller.`);
  }
  return JSON.parse(json);
}

function sanitizeReviewNote(value) {
  return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, 160) || "review";
}

function cosmeticRewardsFor(pet) {
  const level = Number(pet.level ?? 1);
  const rewards = [];
  if (level >= 5) rewards.push({ id: "title_first_steps", kind: "title", label: "First Steps" });
  if (level >= 10) rewards.push({ id: "aura_warm_boot", kind: "aura", label: "Warm Boot" });
  if (level >= 25) rewards.push({ id: "badge_steady_loop", kind: "badge", label: "Steady Loop" });
  if (level >= 50) rewards.push({ id: "trail_release_line", kind: "trail", label: "Release Line" });
  if (level >= 75) rewards.push({ id: "frame_deep_work", kind: "frame", label: "Deep Work" });
  if (level >= 100) rewards.push({ id: "title_level_100", kind: "title", label: "Level 100" });
  const mastery = Number(pet.mastery_level ?? 0);
  if (mastery > 0) rewards.push({ id: `mastery_${mastery}`, kind: "mastery", label: `Mastery ${mastery}` });
  return rewards;
}

function syncCosmeticRewards(pet) {
  const existing = new Set(pet.cosmetics_unlocked ?? []);
  for (const reward of cosmeticRewardsFor(pet)) existing.add(reward.id);
  pet.cosmetics_unlocked = [...existing];
}

function sanitizeHatchSource(source) {
  return String(source)
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 64) || "codex_app";
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
    role: "player",
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
  if (buffer.length > MAX_ATLAS_BYTES) {
    throw httpError(413, "ASSET_TOO_LARGE", `Atlas upload must be ${MAX_ATLAS_BYTES} bytes or smaller.`);
  }
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.length < 45 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas upload is not a valid PNG file.");
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas PNG is missing a valid IHDR chunk.");
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
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const compression = buffer.readUInt8(26);
  const filter = buffer.readUInt8(27);
  const interlace = buffer.readUInt8(28);
  if (bitDepth !== 8 || ![2, 3, 4, 6].includes(colorType) || compression !== 0 || filter !== 0 || interlace > 1) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas PNG uses unsupported image settings.");
  }
  if (!buffer.includes(Buffer.from("IEND", "ascii"), 8)) {
    throw httpError(400, "ASSET_FORMAT_INVALID", "Atlas PNG is missing an IEND chunk.");
  }

  return {
    width,
    height,
    byteLength: buffer.length,
    sha256: hashBuffer(buffer),
  };
}

function logEvent(state, type, accountId, payload) {
  state.events ??= [];
  const event = {
    id: `event_${randomUUID()}`,
    type,
    account_id: accountId,
    payload,
    previous_hash: state.events[0]?.hash ?? null,
    created_at: new Date().toISOString(),
  };
  event.hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  state.events.unshift(event);
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
