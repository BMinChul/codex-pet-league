import test from "node:test";
import assert from "node:assert/strict";
import {
  createPet,
  createPetAsset,
  getTurnBattle,
  startTurnBattle,
  submitTurnBattleAction,
} from "../src/domain/state.js";
import { createDefaultState } from "../src/storage/jsonStore.js";

test("turn battle resolves simultaneous player and server actions", () => {
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });

  assert.equal(started.battle.turn_seconds, 30);
  assert.equal(started.battle.pending.opponent, true);

  const result = submitTurnBattleAction(state, "acct_demo", started.battle.id, { kind: "strike" });

  assert.equal(result.submitted, true);
  assert.equal(result.battle.log.length, 1);
  assert.equal(result.battle.turn_index, 2);
  assert.ok(result.battle.sides.opponent.hp < result.battle.sides.opponent.max_hp);
  assert.equal(result.battle.status, "in_progress");
});

test("skill actions require server-side energy", () => {
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });
  const skillId = started.battle.sides.player.skills[0];

  assert.throws(
    () => submitTurnBattleAction(state, "acct_demo", started.battle.id, { kind: "skill", skill_id: skillId }),
    /requires 2 energy/,
  );

  const focused = submitTurnBattleAction(state, "acct_demo", started.battle.id, { kind: "focus" });
  const afterSkill = submitTurnBattleAction(state, "acct_demo", focused.battle.id, {
    kind: "skill",
    skill_id: skillId,
  });

  assert.equal(afterSkill.battle.log.length, 2);
  assert.equal(afterSkill.battle.log[1].actions.player.skill_id, skillId);
});

test("three missed turns produce an official AFK loss and settlement", () => {
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "ranked" });
  const room = state.battleRooms.find((entry) => entry.id === started.battle.id);

  for (let i = 0; i < 3; i += 1) {
    room.turn_deadline_at = "2000-01-01T00:00:00.000Z";
    getTurnBattle(state, "acct_demo", room.id);
  }

  assert.equal(room.status, "finished");
  assert.equal(room.result.result, "afk_loss");
  assert.equal(room.sides.player.timeout_count, 3);
  assert.equal(state.battles.length, 1);
  assert.equal(state.battles[0].result, "afk_loss");
  assert.equal(state.battles[0].pet_xp_delta, 0);
  assert.equal(state.pets[0].rating.losses, 1);
});

function createPetFixture() {
  const state = createDefaultState();
  const asset = createPetAsset(state, "acct_demo", {});
  const pet = createPet(state, "acct_demo", {
    name: "Test Pet",
    pet_asset_id: asset.id,
    primary_element: "Forge",
    secondary_element: "Trace",
  });
  return { state, pet };
}
