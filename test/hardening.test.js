import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptFriendInvite,
  activatePet,
  adminAudit,
  adminConsole,
  cancelMatchmakingTicket,
  createAuthChallenge,
  createPet,
  createPetAsset,
  draftTrainingReport,
  getTurnBattle,
  getAccountBySession,
  requireAdmin,
  startTurnBattle,
  submitTrainingReport,
  submitTurnBattleAction,
  updatePetLoadout,
  verifyAuthChallenge,
  joinMatchmakingQueue,
  moderateAsset,
  publicPetView,
  reportPetAsset,
  reviewTrainingReport,
  runServerAuthorityJob,
  seasonOperation,
  updateAccountEnforcement,
} from "../src/domain/state.js";
import { accountIntegrityStatus, appendRiskEvent } from "../src/domain/audit.js";
import { enforceRequestGuard, hashRequestBody } from "../src/domain/antiCheat.js";
import { createDefaultState } from "../src/storage/jsonStore.js";

test("auth challenge verification creates a signed League session", () => {
  const state = createDefaultState();
  const challenge = createAuthChallenge(state, {
    method: "email_magic_link",
    identifier: "new-player@example.test",
  });
  const verified = verifyAuthChallenge(state, {
    challenge_id: challenge.challenge_id,
    code: challenge.dev_code,
  });

  assert.equal(state.authChallenges[0].code, undefined);
  assert.match(state.authChallenges[0].code_hash, /^[a-f0-9]{64}$/);
  assert.equal(verified.account.verified, true);
  assert.match(verified.session_token, /^league_/);
  assert.equal(getAccountBySession(state, verified.session_token).id, verified.account.id);
});

test("loadout updates enforce four official skills and aliases", () => {
  const { state, pet } = createPetFixture();
  const skills = ["forge_offense", "forge_defense", "forge_status", "trace_offense"];
  const updated = updatePetLoadout(state, "acct_demo", pet.id, {
    skills,
    aliases: {
      forge_offense: "Hammer Time",
      forge_defense: "<Shield>",
    },
  });

  assert.deepEqual(updated.skills.map((skill) => skill.id), skills);
  assert.equal(updated.skills.find((skill) => skill.id === "forge_offense").alias, "Hammer Time");
  assert.equal(updated.skills.find((skill) => skill.id === "forge_defense").alias, "Shield");
  assert.throws(
    () => updatePetLoadout(state, "acct_demo", pet.id, { skills: ["logic_offense"] }),
    /exactly four skills/,
  );
});

test("one account has one active League pet selection", () => {
  const state = createDefaultState();
  const firstAsset = createPetAsset(state, "acct_demo", {});
  const secondAsset = createPetAsset(state, "acct_demo", { appearance: { variant: "second" } });
  const first = createPet(state, "acct_demo", {
    name: "First Pet",
    pet_asset_id: firstAsset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  const account = state.accounts.find((entry) => entry.id === "acct_demo");
  assert.equal(account.active_pet_id, first.id);
  assert.ok(account.active_pet_locked_at);

  const second = createPet(state, "acct_demo", {
    name: "Second Pet",
    pet_asset_id: secondAsset.id,
    primary_element: "Logic",
    secondary_element: "Patch",
  });
  assert.equal(account.active_pet_id, first.id);
  assert.equal(publicPetView(state, first).is_active, true);
  assert.equal(publicPetView(state, second).is_active, false);

  assert.throws(() => activatePet(state, "acct_demo", second.id), /permanent/);
  const activated = activatePet(state, "acct_demo", first.id);
  assert.equal(activated.active_pet_id, first.id);
  assert.equal(activated.active_pet_selection_locked, true);
  assert.equal(publicPetView(state, first).is_active, true);
});

test("risky Training Reports are held without XP", () => {
  const { state, pet } = createPetFixture();
  const result = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "risky-1",
    signals: {
      testsRun: 99,
      milestone: true,
      filesChangedBucket: "small",
    },
  });

  assert.equal(result.report.status, "review");
  assert.equal(result.report.pet_xp_delta, 0);
  assert.equal(state.xpLedger.length, 0);
  assert.equal(state.riskEvents[0].type, "training.report_held");
});

test("untrusted high-value Training Reports are held without XP", () => {
  const { state, pet } = createPetFixture();
  const forged = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "forged-high-value",
    signals: {
      implementationActivity: true,
      verificationActivity: true,
      milestone: true,
      testsRun: 3,
      filesChangedBucket: "large",
    },
  });

  assert.equal(forged.report.status, "review");
  assert.equal(forged.report.pet_xp_delta, 0);
  assert.equal(forged.report.risk_flags.includes("untrusted_high_value_report"), true);

  const trusted = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "trusted-high-value",
    server_trust: { trusted: true, reason: "test_signature_valid" },
    signals: {
      implementationActivity: true,
      verificationActivity: true,
      milestone: true,
      testsRun: 3,
      filesChangedBucket: "large",
    },
  });

  assert.equal(trusted.report.status, "approved");
  assert.ok(trusted.report.pet_xp_delta > 0);
});

test("Training Reports require a fresh server draft for untrusted pet XP", () => {
  const { state, pet } = createPetFixture();
  const signals = {
    verificationActivity: true,
    testsRun: 1,
    filesChangedBucket: "small",
  };
  const direct = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "missing-draft",
    signals,
  });
  assert.equal(direct.report.status, "review");
  assert.equal(direct.report.risk_flags.includes("training_draft_missing"), true);

  const draft = draftTrainingReport(state, "acct_demo", pet.id, { signals });
  const approved = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "valid-draft",
    draft_id: draft.id,
    draft_nonce: draft.nonce,
    signals,
  });
  assert.equal(approved.report.status, "approved");
  assert.ok(approved.report.pet_xp_delta > 0);

  const reused = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "reused-draft",
    draft_id: draft.id,
    draft_nonce: draft.nonce,
    signals,
  });
  assert.equal(reused.report.status, "review");
  assert.equal(reused.report.risk_flags.includes("training_draft_already_used"), true);
});

test("expired active battles are advanced before availability checks", () => {
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });
  const room = state.battleRooms.find((entry) => entry.id === started.battle.id);

  for (let i = 0; i < 3; i += 1) {
    room.turn_deadline_at = "2000-01-01T00:00:00.000Z";
    getTurnBattle(state, "acct_demo", room.id);
  }

  assert.equal(room.status, "finished");
  const next = startTurnBattle(state, "acct_demo", pet.id, { mode: "training" });
  assert.equal(next.battle.status, "in_progress");
});

test("player battle actions require current turn freshness", () => {
  const { state, pet, asset } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });
  assert.equal(started.battle.sides.player.asset.id, asset.id);
  assert.equal(started.battle.sides.player.asset.source, "codex_app");

  assert.throws(
    () => submitTurnBattleAction(state, "acct_demo", started.battle.id, { kind: "strike" }),
    /current turn index/,
  );
  assert.throws(
    () =>
      submitTurnBattleAction(state, "acct_demo", started.battle.id, {
        kind: "strike",
        turn_index: started.battle.turn_index,
        turn_nonce: "stale",
      }),
    /turn nonce/,
  );
});

test("stale matchmaking tickets are cancelled before matching", () => {
  const state = createDefaultState();
  const demoAsset = createPetAsset(state, "acct_demo", {});
  const rivalAsset = createPetAsset(state, "acct_rival", {});
  const demoPet = createPet(state, "acct_demo", {
    name: "Queued Pet",
    pet_asset_id: demoAsset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  const rivalPet = createPet(state, "acct_rival", {
    name: "Rival Pet",
    pet_asset_id: rivalAsset.id,
    primary_element: "Logic",
    secondary_element: "Pulse",
  });

  const waiting = joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  assert.equal(waiting.status, "waiting");
  demoPet.rating.lp = 2000;

  const result = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(result.status, "waiting");
  assert.equal(state.matchTickets.find((ticket) => ticket.id === waiting.ticket.id).status, "cancelled");
});

test("queue dodge and invite brute force guards create lockouts", () => {
  const { state, pet } = createPetFixture();
  for (let i = 0; i < 5; i += 1) {
    const queued = joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" });
    cancelMatchmakingTicket(state, "acct_demo", { ticket_id: queued.ticket.id });
  }
  assert.throws(() => joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" }), /Too many queue cancels/);

  const rivalAsset = createPetAsset(state, "acct_rival", {});
  const rivalPet = createPet(state, "acct_rival", {
    name: "Invite Guess Pet",
    pet_asset_id: rivalAsset.id,
    primary_element: "Logic",
    secondary_element: "Pulse",
  });
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => acceptFriendInvite(state, "acct_rival", rivalPet.id, { code: `BAD00${i}` }), /Friend invite code/);
  }
  assert.throws(() => acceptFriendInvite(state, "acct_rival", rivalPet.id, { code: "BAD999" }), /Too many failed invite/);
});

test("admin actions require admin role", () => {
  const state = createDefaultState();

  assert.equal(requireAdmin(state, "acct_demo").id, "acct_demo");
  assert.throws(() => requireAdmin(state, "acct_rival"), /admin League account/);
});

test("asset validation rejects invalid atlas uploads", () => {
  const state = createDefaultState();

  assert.throws(
    () => createPetAsset(state, "acct_demo", { atlas_data_url: "data:image/png;base64,bm90LXBuZw==" }),
    /valid PNG/,
  );
  assert.throws(
    () => createPetAsset(state, "acct_demo", { atlas_data_url: pngDataUrl(128, 64) }),
    /1536x1872/,
  );

  const asset = createPetAsset(state, "acct_demo", { atlas_data_url: pngDataUrl(1536, 1872) });
  const duplicate = createPetAsset(state, "acct_demo", { atlas_data_url: pngDataUrl(1536, 1872) });
  assert.equal(asset.width, 1536);
  assert.equal(duplicate.id, asset.id);
  assert.match(asset.atlas_sha256, /^[a-f0-9]{64}$/);

  assert.throws(
    () => createPetAsset(state, "acct_demo", { atlas_data_url: webpDataUrl(128, 64) }),
    /1536x1872/,
  );
  const hatchAsset = createPetAsset(state, "acct_demo", {
    atlas_data_url: webpDataUrl(1536, 1872),
    hatch_pet_manifest: {
      id: "official-hatch",
      displayName: "Official Hatch",
      description: "A packaged hatch-pet asset.",
      spritesheetPath: "spritesheet.webp",
    },
  });
  assert.equal(hatchAsset.atlas_format, "webp");
  assert.equal(hatchAsset.atlas_content_type, "image/webp");
  assert.match(hatchAsset.atlas_object_key, /\.webp$/);
  assert.equal(hatchAsset.hatch_pet_json.id, "official-hatch");
  assert.equal(hatchAsset.asset_kind, "official_hatch_pet");
  assert.equal(hatchAsset.official_contract, "openai-hatch-pet@8x9-192x208-v1");
  assert.match(hatchAsset.hatch_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(hatchAsset.source_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(hatchAsset.provenance.hatch_pet_id, "official-hatch");

  assert.throws(
    () =>
      createPetAsset(state, "acct_demo", {
        atlas_data_url: webpDataUrl(1536, 1872),
        hatch_source: "openai_hatch_pet",
      }),
    /pet\.json manifest/,
  );
  assert.throws(
    () =>
      createPetAsset(state, "acct_demo", {
        atlas_data_url: webpDataUrl(1536, 1872),
        hatch_pet_manifest: {
          id: "spoofed-format",
          displayName: "Spoofed Format",
          description: "Mismatched extension should fail.",
          spritesheetPath: "spritesheet.png",
        },
      }),
    /extension must match/,
  );
});

test("cross-account hatch asset reuse is allowed but flagged for review", () => {
  const state = createDefaultState();
  const manifest = {
    id: "shared-hatch",
    displayName: "Shared Hatch",
    description: "Same local package uploaded by two accounts.",
    spritesheetPath: "spritesheet.webp",
  };
  const first = createPetAsset(state, "acct_demo", {
    atlas_data_url: webpDataUrl(1536, 1872),
    hatch_pet_manifest: manifest,
  });
  const second = createPetAsset(state, "acct_rival", {
    atlas_data_url: webpDataUrl(1536, 1872),
    hatch_pet_manifest: manifest,
  });

  assert.notEqual(second.id, first.id);
  assert.equal(second.source_fingerprint, first.source_fingerprint);
  assert.deepEqual(second.duplicate_source_accounts, ["acct_demo"]);
  assert.equal(state.riskEvents[0].type, "asset.cross_account_duplicate");
  const audit = adminAudit(state);
  assert.equal(audit.ok, true);
  assert.equal(audit.findings.some((finding) => finding.code === "asset_cross_account_duplicate_source"), true);
});

test("request guards rate-limit abusive traffic and reject replayed mutation ids", () => {
  const state = createDefaultState();
  const body = { kind: "strike", turn_index: 1, turn_nonce: "nonce" };

  enforceRequestGuard(state, {
    accountId: "acct_demo",
    routeKey: "battle.action",
    requestId: "req_first_123",
    bodyHash: hashRequestBody(body),
    requireIdempotency: true,
  });
  assert.throws(
    () =>
      enforceRequestGuard(state, {
        accountId: "acct_demo",
        routeKey: "battle.action",
        requestId: "req_first_123",
        bodyHash: hashRequestBody(body),
        requireIdempotency: true,
      }),
    /already used/,
  );

  enforceRequestGuard(state, {
    actorKey: "ip:test@example.test",
    routeKey: "auth.challenge",
    bodyHash: hashRequestBody({ identifier: "test@example.test" }),
  });
  assert.throws(
    () =>
      enforceRequestGuard(state, {
        actorKey: "ip:test@example.test",
        routeKey: "auth.challenge",
        bodyHash: hashRequestBody({ identifier: "test@example.test" }),
      }),
    /Too many auth.challenge/,
  );
});

test("risk score recommends review without auto-locking ranked", () => {
  const state = createDefaultState();
  appendRiskEvent(state, {
    accountId: "acct_demo",
    type: "training.report_held",
    severity: "high",
    score: 90,
  });
  appendRiskEvent(state, {
    accountId: "acct_demo",
    type: "request.replayed",
    severity: "medium",
    score: 40,
  });

  const status = accountIntegrityStatus(state, "acct_demo");
  assert.equal(status.level, "watch");
  assert.equal(status.automatic_restrictions.ranked_locked, false);

  const asset = createPetAsset(state, "acct_demo", {});
  const pet = createPet(state, "acct_demo", {
    name: "False Positive Safe",
    pet_asset_id: asset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  const queued = joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" });
  assert.equal(queued.status, "waiting");
});

test("manual enforcement workflow locks and unlocks ranked without risk-score auto punishment", () => {
  const { state, pet } = createPetFixture();
  const locked = updateAccountEnforcement(state, "acct_demo", {
    account_id: "acct_demo",
    action: "ranked_lock",
    days: 1,
    reason: "confirmed_tamper",
  });
  assert.equal(locked.integrity.automatic_restrictions.ranked_locked, true);
  assert.throws(() => joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" }), /Ranked matchmaking is locked/);

  updateAccountEnforcement(state, "acct_demo", {
    account_id: "acct_demo",
    action: "ranked_unlock",
    reason: "appeal_accepted",
  });
  const queued = joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" });
  assert.equal(queued.status, "waiting");
});

test("moderated assets block ranked first and hidden assets block all battles", () => {
  const { state, pet, asset } = createPetFixture();
  moderateAsset(state, "acct_demo", {
    asset_id: asset.id,
    action: "quarantine",
    reason: "asset_review_pending",
  });
  assert.throws(() => joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" }), /under review/);
  const training = startTurnBattle(state, "acct_demo", pet.id, { mode: "training" });
  assert.equal(training.battle.status, "in_progress");

  const privateOnly = createPetFixture();
  privateOnly.asset.visibility = "private";
  assert.throws(() => joinMatchmakingQueue(privateOnly.state, "acct_demo", privateOnly.pet.id, { mode: "ranked" }), /private/);
  const privateTraining = startTurnBattle(privateOnly.state, "acct_demo", privateOnly.pet.id, { mode: "training" });
  assert.equal(privateTraining.battle.status, "in_progress");

  const blocked = createPetFixture();
  moderateAsset(blocked.state, "acct_demo", {
    asset_id: blocked.asset.id,
    action: "hide",
    reason: "confirmed_asset_violation",
  });
  assert.throws(() => startTurnBattle(blocked.state, "acct_demo", blocked.pet.id, { mode: "training" }), /hidden by moderation/);
  assert.throws(() => joinMatchmakingQueue(blocked.state, "acct_demo", blocked.pet.id, { mode: "ranked" }), /hidden by moderation/);
});

test("audit flags forged XP, level, stat, and LP state", () => {
  const { state, pet } = createPetFixture();
  const signals = {
    verificationActivity: true,
    testsRun: 1,
    filesChangedBucket: "small",
  };
  const draft = draftTrainingReport(state, "acct_demo", pet.id, { signals });
  const approved = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "audit-derived-state",
    draft_id: draft.id,
    draft_nonce: draft.nonce,
    signals,
  });
  assert.equal(approved.report.status, "approved");
  assert.equal(adminAudit(state).ok, true);

  pet.xp += 1000;
  pet.level = 20;
  pet.stats.total += 1;
  pet.rating.lp += 400;

  const audit = adminAudit(state);
  assert.equal(audit.ok, false);
  const codes = new Set(audit.findings.map((finding) => finding.code));
  assert.equal(codes.has("pet_xp_state_mismatch"), true);
  assert.equal(codes.has("pet_level_state_mismatch"), true);
  assert.equal(codes.has("pet_stats_state_mismatch"), true);
  assert.equal(codes.has("pet_lp_state_mismatch"), true);
});

test("admin can resolve held Training Reports and ops job records authority checks", () => {
  const { state, pet } = createPetFixture();
  const held = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "admin-review-me",
    signals: { testsRun: 99, milestone: true, filesChangedBucket: "large" },
  });
  assert.equal(held.report.status, "review");

  const resolved = reviewTrainingReport(state, "acct_demo", {
    report_id: held.report.id,
    decision: "approve",
    note: "verified externally",
  });
  assert.equal(resolved.report.status, "approved");
  assert.ok(resolved.report.pet_xp_delta >= 0);

  const job = runServerAuthorityJob(state, { adminAccountId: "acct_demo" });
  assert.match(job.job.id, /^ops_/);
  assert.ok(adminConsole(state).ops.latest_job);
});

test("asset reports feed moderation queue and admin can clear or hide assets", () => {
  const state = createDefaultState();
  const ownerAsset = createPetAsset(state, "acct_demo", {});
  const pet = createPet(state, "acct_demo", {
    name: "Moderation Pet",
    pet_asset_id: ownerAsset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  for (let i = 0; i < 3; i += 1) {
    const accountId = `acct_reporter_${i}`;
    state.accounts.push({
      id: accountId,
      displayName: `Reporter ${i}`,
      role: "player",
      identifier: `reporter-${i}@example.test`,
      email: `reporter-${i}@example.test`,
      verified: true,
      authMethods: ["email_magic_link"],
      createdAt: new Date().toISOString(),
    });
    reportPetAsset(state, accountId, pet.id, { reason: "bad_asset" });
  }

  assert.equal(ownerAsset.visibility, "private");
  assert.equal(adminConsole(state).moderation_queue.length, 1);
  const cleared = moderateAsset(state, "acct_demo", { asset_id: ownerAsset.id, action: "clear" });
  assert.equal(cleared.asset.visibility, "public");
  assert.equal(cleared.asset.safety_status, "clear");
});

test("season operation creates rewards and rolls pets into next season", () => {
  const { state, pet } = createPetFixture();
  pet.rating.lp = 2200;
  const ended = seasonOperation(state, "acct_demo", { action: "end_current" });
  assert.equal(ended.season.status, "completed");
  assert.ok(ended.rewards.some((reward) => reward.pet_id === pet.id));

  const next = seasonOperation(state, "acct_demo", { action: "start_next", name: "Season 2" });
  assert.equal(next.season.status, "active");
  assert.equal(state.activeSeasonId, next.season.id);
  assert.equal(pet.rating.season_id, next.season.id);
});

test("audit detects tampered event and replay hash chains", () => {
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });
  let battle = started.battle;
  for (let i = 0; i < 20 && battle.status === "in_progress"; i += 1) {
    battle = submitTurnBattleAction(state, "acct_demo", battle.id, actionFor(battle, "strike")).battle;
  }

  assert.equal(adminAudit(state).ok, true);
  state.events[0].payload.tampered = true;
  state.battleRooms[0].log[0].actions.player.kind = "guard";
  const audit = adminAudit(state);
  assert.equal(audit.ok, false);
  assert.equal(audit.findings.some((finding) => finding.code === "event_log_hash_invalid"), true);
  assert.equal(audit.findings.some((finding) => finding.code === "battle_replay_entry_hash_invalid"), true);
});

test("audit reports no high integrity findings for a clean state", () => {
  const { state } = createPetFixture();
  const audit = adminAudit(state);

  assert.equal(audit.ok, true);
  assert.equal(audit.findings.length, 0);
});

test("audit flags stale or duplicated matchmaking state", () => {
  const { state, pet } = createPetFixture();
  joinMatchmakingQueue(state, "acct_demo", pet.id, { mode: "ranked" });
  const ticket = state.matchTickets[0];
  state.matchTickets.push({
    ...ticket,
    id: "ticket_duplicate_tamper",
    created_at: new Date(Date.now() + 1000).toISOString(),
  });
  ticket.battle_class = "wrong";

  const audit = adminAudit(state);
  assert.equal(audit.ok, false);
  assert.equal(audit.findings.some((finding) => finding.code === "duplicate_waiting_ticket"), true);
  assert.equal(audit.findings.some((finding) => finding.code === "ticket_battle_class_stale"), true);
});

test("ops job raises abuse alert for audit integrity findings without auto-punishment", () => {
  const { state, pet } = createPetFixture();
  const held = submitTrainingReport(state, "acct_demo", pet.id, {
    client_report_id: "tamper-held-award",
    signals: { testsRun: 99, milestone: true, filesChangedBucket: "large" },
  });
  held.report.pet_xp_delta = 10;

  const job = runServerAuthorityJob(state, { adminAccountId: "acct_demo" });
  assert.equal(job.abuse_alerts.some((alert) => alert.kind === "audit_integrity"), true);
  assert.equal(
    job.abuse_alerts.some((alert) => alert.summary?.code === "held_report_awarded_xp"),
    true,
  );
  assert.equal(accountIntegrityStatus(state, "acct_demo").automatic_restrictions.ranked_locked, false);
});

function createPetFixture() {
  const state = createDefaultState();
  const asset = createPetAsset(state, "acct_demo", {});
  const pet = createPet(state, "acct_demo", {
    name: "Hardening Pet",
    pet_asset_id: asset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  return { state, pet, asset };
}

function pngDataUrl(width, height) {
  const bytes = Buffer.alloc(45);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  bytes.writeUInt8(6, 25);
  bytes.writeUInt8(0, 26);
  bytes.writeUInt8(0, 27);
  bytes.writeUInt8(0, 28);
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function webpDataUrl(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  writeUInt24LE(bytes, width - 1, 24);
  writeUInt24LE(bytes, height - 1, 27);
  return `data:image/webp;base64,${bytes.toString("base64")}`;
}

function writeUInt24LE(bytes, value, offset) {
  bytes.writeUInt8(value & 0xff, offset);
  bytes.writeUInt8((value >> 8) & 0xff, offset + 1);
  bytes.writeUInt8((value >> 16) & 0xff, offset + 2);
}

function actionFor(battle, kind) {
  return {
    kind,
    turn_index: battle.turn_index,
    turn_nonce: battle.turn_nonce,
    request_id: `req_${battle.turn_index}_${kind}`,
  };
}
