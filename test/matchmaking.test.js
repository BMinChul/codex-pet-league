import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptFriendInvite,
  adminConsole,
  createFriendInvite,
  createPet,
  createPetAsset,
  joinMatchmakingQueue,
  matchmakingStatus,
  runServerAuthorityJob,
  rollbackRankedBattle,
  simulateBattle,
  startTurnBattle,
  submitTurnBattleAction,
  updateAccountEnforcement,
} from "../src/domain/state.js";
import { createDefaultState } from "../src/storage/jsonStore.js";

test("random matchmaking pairs same-class pets from different verified accounts", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();

  const waiting = joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  assert.equal(waiting.status, "waiting");

  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(matched.status, "matched");
  assert.equal(matched.battle.mode, "ranked");
  assert.equal(matched.battle.source, "random_matchmaking");
  assert.equal(matched.battle.viewer_side, "opponent");

  const status = matchmakingStatus(state, "acct_demo", demoPet.id);
  assert.equal(status.active_battles.length, 1);
  assert.equal(status.active_battles[0].viewer_side, "player");
});

test("ranked matchmaking widens LP range after queue time", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  rivalPet.rating.lp = 1750;

  const first = joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const second = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(first.status, "waiting");
  assert.equal(second.status, "waiting");
  assert.equal(second.ticket.search_window_lp, 150);

  const demoTicket = state.matchTickets.find((ticket) => ticket.account_id === "acct_demo");
  demoTicket.created_at = new Date(Date.now() - 31_000).toISOString();

  const widened = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(widened.status, "matched");
  assert.equal(widened.opponent_ticket.search_window_lp, 300);
});

test("ranked LP only changes for official random matchmaking battles", () => {
  const { state, demoPet } = createTwoPetFixture();

  assert.throws(
    () => startTurnBattle(state, "acct_demo", demoPet.id, { mode: "ranked" }),
    /Ranked battles must be created through random matchmaking/,
  );

  const result = simulateBattle(state, "acct_demo", demoPet.id, {
    mode: "ranked",
    result: "win",
    opponent_lp: 1800,
  });

  assert.equal(result.pet.rating.lp, 1500);
  assert.equal(result.battle.pet_xp_delta, 0);
  assert.equal(state.xpLedger.length, 0);
});

test("friend invite code creates a PvP Friend Duel room", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();

  const created = createFriendInvite(state, "acct_demo", demoPet.id);
  assert.equal(created.invite.status, "open");
  assert.match(created.invite.code, /^[A-Z0-9]{6}$/);

  const accepted = acceptFriendInvite(state, "acct_rival", rivalPet.id, { code: created.invite.code });
  assert.equal(accepted.status, "matched");
  assert.equal(accepted.battle.mode, "friend");
  assert.equal(accepted.battle.source, "friend_invite");
  assert.equal(accepted.battle.viewer_side, "opponent");
});

test("friend pair daily duel limit blocks repeated farming rooms", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  for (let i = 0; i < 5; i += 1) {
    const created = createFriendInvite(state, "acct_demo", demoPet.id);
    const accepted = acceptFriendInvite(state, "acct_rival", rivalPet.id, { code: created.invite.code });
    const room = state.battleRooms.find((entry) => entry.id === accepted.battle.id);
    room.status = "finished";
  }
  const next = createFriendInvite(state, "acct_demo", demoPet.id);
  assert.throws(() => acceptFriendInvite(state, "acct_rival", rivalPet.id, { code: next.invite.code }), /duel limit/);
});

test("PvP battle actions and settlement are recorded for both participants", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "casual" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "casual" });
  const roomId = matched.battle.id;

  let room = state.battleRooms.find((entry) => entry.id === roomId);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", roomId, actionFor(room, "strike"));
    submitTurnBattleAction(state, "acct_rival", roomId, actionFor(room, "strike"));
    room = state.battleRooms.find((entry) => entry.id === roomId);
  }

  assert.equal(room.status, "finished");
  assert.equal(state.battles.length, 2);
  assert.deepEqual(new Set(state.battles.map((battle) => battle.account_id)), new Set(["acct_demo", "acct_rival"]));
  assert.equal(room.settlement_battle_ids.player.startsWith("battle_"), true);
  assert.equal(room.settlement_battle_ids.opponent.startsWith("battle_"), true);
});

test("official ranked PvP settlements are season-scoped", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  const roomId = matched.battle.id;

  let room = state.battleRooms.find((entry) => entry.id === roomId);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", roomId, actionFor(room, "strike"));
    submitTurnBattleAction(state, "acct_rival", roomId, actionFor(room, "strike"));
    room = state.battleRooms.find((entry) => entry.id === roomId);
  }

  assert.equal(state.lpLedger.length, 2);
  assert.equal(state.lpLedger.every((entry) => entry.season_id === "season_1"), true);
  assert.equal(state.battles.every((battle) => battle.season_id === "season_1"), true);
});

test("ranked rematch cooldown avoids recent opponents", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  finishRankedMatch(state, demoPet, rivalPet);

  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const blocked = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(blocked.status, "waiting");
  assert.equal(
    state.riskEvents.some((event) => event.type === "matchmaking.integrity_candidate_skipped" && event.metadata?.link_reason === "recent_ranked_rematch_cooldown"),
    true,
  );
});

test("repeated one-sided ranked pairs create competitive integrity review cases", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  for (let index = 0; index < 3; index += 1) {
    finishRankedMatch(state, demoPet, rivalPet);
    agePairBattles(state, 20 + index);
  }

  const consoleState = adminConsole(state);
  const competitiveCase = consoleState.review_cases.find((entry) => entry.kind === "competitive_integrity");
  assert.ok(competitiveCase);
  assert.equal(competitiveCase.evidence.ranked_pair_matches, 3);
  assert.ok(competitiveCase.recommended_actions.includes("ranked_lp_suppress"));

  const job = runServerAuthorityJob(state, { adminAccountId: "acct_demo" });
  assert.ok(job.job.competitive_events_created >= 0);
});

test("ranked matchmaking avoids linked client context pairs before play", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  const sharedIpHash = "a".repeat(64);
  state.sessions.push(
    linkedSession("acct_demo", { client_ip_hash: sharedIpHash }),
    linkedSession("acct_rival", { client_ip_hash: sharedIpHash }),
  );

  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(matched.status, "waiting");
  assert.equal(state.battleRooms.length, 0);
  assert.equal(state.riskEvents.some((event) => event.type === "matchmaking.integrity_candidate_skipped"), true);

  const linkedCase = adminConsole(state).review_cases.find((entry) => entry.kind === "linked_accounts");
  assert.ok(linkedCase);
  assert.deepEqual(new Set(linkedCase.account_ids), new Set(["acct_demo", "acct_rival"]));
  assert.equal(linkedCase.evidence.context, "network");
  assert.ok(linkedCase.recommended_actions.includes("ranked_lp_suppress"));
});

test("ranked settlement suppresses LP if accounts become linked after match start", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(matched.status, "matched");

  const sharedIpHash = "b".repeat(64);
  state.sessions.push(
    linkedSession("acct_demo", { client_ip_hash: sharedIpHash }),
    linkedSession("acct_rival", { client_ip_hash: sharedIpHash }),
  );

  let room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", room.id, actionFor(room, "strike"));
    submitTurnBattleAction(state, "acct_rival", room.id, actionFor(room, "strike"));
    room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  }

  assert.equal(state.lpLedger.length, 0);
  assert.equal(state.battles.length, 2);
  assert.equal(state.battles.every((battle) => battle.lp?.suppressed === true), true);
  assert.equal(state.battles.every((battle) => battle.pet_xp_delta === 0), true);
  assert.equal(state.xpLedger.every((entry) => entry.pet_xp_delta === 0), true);
  assert.equal(state.riskEvents.some((event) => event.type === "pvp.shared_context_reward_suppressed"), true);
  assert.equal(state.riskEvents.some((event) => event.type === "ranked.shared_context_lp_suppressed"), true);
  const linkedCase = adminConsole(state).review_cases.find((entry) => entry.kind === "linked_accounts");
  assert.ok(linkedCase);
  assert.deepEqual(new Set(linkedCase.account_ids), new Set(["acct_demo", "acct_rival"]));
  assert.equal(linkedCase.evidence.context, "network");
  assert.equal(linkedCase.evidence.ranked_lp_suppressed_count, 2);
  assert.ok(linkedCase.recommended_actions.includes("ranked_lp_suppress"));
});

test("manual ranked LP suppression allows play while holding only the reviewed account LP", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  const beforeDemoLp = demoPet.rating.lp;

  const suppressed = updateAccountEnforcement(state, "acct_demo", {
    account_id: "acct_demo",
    action: "ranked_lp_suppress",
    days: 7,
    reason: "linked_review_pending",
  });
  assert.equal(suppressed.integrity.automatic_restrictions.ranked_lp_suppressed, true);

  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  let room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", room.id, actionFor(room, "strike"));
    submitTurnBattleAction(state, "acct_rival", room.id, actionFor(room, "strike"));
    room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  }

  assert.equal(demoPet.rating.lp, beforeDemoLp);
  assert.equal(state.lpLedger.some((entry) => entry.account_id === "acct_demo"), false);
  const demoBattle = state.battles.find((battle) => battle.account_id === "acct_demo" && battle.mode === "ranked");
  assert.equal(demoBattle.lp.suppressed, true);
  assert.equal(demoBattle.lp.suppression_source, "manual_enforcement");

  const cleared = updateAccountEnforcement(state, "acct_demo", {
    account_id: "acct_demo",
    action: "clear",
    reason: "false_positive",
  });
  assert.equal(cleared.integrity.automatic_restrictions.ranked_lp_suppressed, false);
});

test("admin can rollback ranked LP without corrupting signed settlements", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  const beforeDemo = demoPet.rating.lp;
  const beforeRival = rivalPet.rating.lp;
  const room = finishRankedMatch(state, demoPet, rivalPet);
  assert.equal(state.lpLedger.length, 2);
  assert.notEqual(demoPet.rating.lp, beforeDemo);

  const rollback = rollbackRankedBattle(state, "acct_demo", {
    battle_room_id: room.id,
    reason: "test_rollback",
  });

  assert.equal(rollback.rollbacks.length, 2);
  assert.equal(demoPet.rating.lp, beforeDemo);
  assert.equal(rivalPet.rating.lp, beforeRival);
  assert.equal(state.lpLedger.filter((entry) => entry.source_type === "ranked_rollback").length, 2);
  assert.equal(state.battles.every((battle) => battle.result_signature?.startsWith("hmac-sha256:")), true);
  assert.equal(adminConsole(state).audit.ok, true);
});

function createTwoPetFixture() {
  const state = createDefaultState();
  const demoAsset = createPetAsset(state, "acct_demo", {});
  const rivalAsset = createPetAsset(state, "acct_rival", {});
  const demoPet = createPet(state, "acct_demo", {
    name: "Demo Pet",
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
  return { state, demoPet, rivalPet };
}

function linkedSession(accountId, context) {
  return {
    id: `session_${accountId}`,
    account_id: accountId,
    token: `token_${accountId}`,
    method: "email_magic_link",
    client_ip_hash: context.client_ip_hash ?? null,
    device_hash: context.device_hash ?? null,
    user_agent_hash: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    revoked_at: null,
  };
}

function finishRankedMatch(state, demoPet, rivalPet) {
  demoPet.rating.lp = 1500;
  rivalPet.rating.lp = 1500;
  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "ranked" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "ranked" });
  assert.equal(matched.status, "matched");
  let room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", room.id, actionFor(room, "strike"));
    submitTurnBattleAction(state, "acct_rival", room.id, actionFor(room, "strike"));
    room = state.battleRooms.find((entry) => entry.id === matched.battle.id);
  }
  return room;
}

function agePairBattles(state, minutesAgo) {
  const iso = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (const battle of state.battles) {
    battle.created_at = iso;
  }
}

function actionFor(room, kind) {
  return {
    kind,
    turn_index: room.turn_index,
    turn_nonce: room.turn_nonce,
  };
}
