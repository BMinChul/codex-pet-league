import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptFriendInvite,
  createFriendInvite,
  createPet,
  createPetAsset,
  joinMatchmakingQueue,
  matchmakingStatus,
  simulateBattle,
  startTurnBattle,
  submitTurnBattleAction,
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

test("PvP battle actions and settlement are recorded for both participants", () => {
  const { state, demoPet, rivalPet } = createTwoPetFixture();
  joinMatchmakingQueue(state, "acct_demo", demoPet.id, { mode: "casual" });
  const matched = joinMatchmakingQueue(state, "acct_rival", rivalPet.id, { mode: "casual" });
  const roomId = matched.battle.id;

  let room = state.battleRooms.find((entry) => entry.id === roomId);
  while (room.status === "in_progress") {
    submitTurnBattleAction(state, "acct_demo", roomId, { kind: "strike" });
    submitTurnBattleAction(state, "acct_rival", roomId, { kind: "strike" });
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
    submitTurnBattleAction(state, "acct_demo", roomId, { kind: "strike" });
    submitTurnBattleAction(state, "acct_rival", roomId, { kind: "strike" });
    room = state.battleRooms.find((entry) => entry.id === roomId);
  }

  assert.equal(state.lpLedger.length, 2);
  assert.equal(state.lpLedger.every((entry) => entry.season_id === "season_1"), true);
  assert.equal(state.battles.every((battle) => battle.season_id === "season_1"), true);
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
