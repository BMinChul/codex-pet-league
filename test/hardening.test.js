import test from "node:test";
import assert from "node:assert/strict";
import {
  adminAudit,
  createAuthChallenge,
  createPet,
  createPetAsset,
  getTurnBattle,
  getAccountBySession,
  startTurnBattle,
  submitTrainingReport,
  updatePetLoadout,
  verifyAuthChallenge,
} from "../src/domain/state.js";
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

test("audit reports no high integrity findings for a clean state", () => {
  const { state } = createPetFixture();
  const audit = adminAudit(state);

  assert.equal(audit.ok, true);
  assert.equal(audit.findings.length, 0);
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
  return { state, pet };
}
