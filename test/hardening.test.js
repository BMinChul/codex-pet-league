import test from "node:test";
import assert from "node:assert/strict";
import {
  adminAudit,
  createAuthChallenge,
  createPet,
  createPetAsset,
  getTurnBattle,
  getAccountBySession,
  requireAdmin,
  startTurnBattle,
  submitTrainingReport,
  submitTurnBattleAction,
  updatePetLoadout,
  verifyAuthChallenge,
  joinMatchmakingQueue,
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
  const { state, pet } = createPetFixture();
  const started = startTurnBattle(state, "acct_demo", pet.id, { mode: "casual" });

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
  assert.equal(asset.width, 1536);
  assert.match(asset.atlas_sha256, /^[a-f0-9]{64}$/);
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

function pngDataUrl(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
