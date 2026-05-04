import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { enforceRequestGuard, hashRequestBody } from "../src/domain/antiCheat.js";
import {
  createPet,
  createPetAsset,
  reportPetAsset,
  runServerAuthorityJob,
  submitTrainingReport,
} from "../src/domain/state.js";
import { createDefaultState } from "../src/storage/jsonStore.js";

const state = createDefaultState();

enforceRequestGuard(state, {
  actorKey: "192.0.2.10:abuse@example.test",
  routeKey: "auth.challenge",
  bodyHash: hashRequestBody({ identifier: "abuse@example.test" }),
});
assert.throws(
  () =>
    enforceRequestGuard(state, {
      actorKey: "192.0.2.10:abuse@example.test",
      routeKey: "auth.challenge",
      bodyHash: hashRequestBody({ identifier: "abuse@example.test" }),
    }),
  /Too many auth.challenge/,
);

enforceRequestGuard(state, {
  accountId: "acct_demo",
  routeKey: "battle.action",
  requestId: "abuse_replay_1",
  bodyHash: hashRequestBody({ kind: "strike", turn_index: 1, turn_nonce: "nonce" }),
  requireIdempotency: true,
});
assert.throws(
  () =>
    enforceRequestGuard(state, {
      accountId: "acct_demo",
      routeKey: "battle.action",
      requestId: "abuse_replay_1",
      bodyHash: hashRequestBody({ kind: "guard", turn_index: 1, turn_nonce: "nonce" }),
      requireIdempotency: true,
    }),
  /different request content/,
);

const ownerAsset = createPetAsset(state, "acct_demo", {});
const ownerPet = createPet(state, "acct_demo", {
  name: "Reported Asset",
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
  reportPetAsset(state, accountId, ownerPet.id, { reason: `spam_asset_${randomUUID()}` });
}
assert.equal(ownerAsset.visibility, "private");
assert.equal(ownerAsset.safety_status, "reported");

const riskyReport = submitTrainingReport(state, "acct_demo", ownerPet.id, {
  client_report_id: "abuse-risky-report",
  signals: { testsRun: 99, milestone: true, filesChangedBucket: "large" },
});
assert.equal(riskyReport.report.status, "review");

const job = runServerAuthorityJob(state);
assert.ok(job.job.abuse_alerts_created >= 1 || state.riskEvents.length >= 1);

console.log("abuse smoke ok");
