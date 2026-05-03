import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CODEX_PET_STORAGE_DRIVER = "sqlite";

const tempRoot = await mkdtemp(join(tmpdir(), "codexpet-storage-"));
process.env.CODEX_PET_SQLITE_PATH = join(tempRoot, "league-state.sqlite");
let store;

try {
  store = await import(`../src/storage/jsonStore.js?storage-smoke=${Date.now()}`);
  const state = store.createDefaultState();
  state.accounts.push({
    id: "acct_storage_smoke",
    displayName: "Storage Smoke",
    role: "player",
    identifier: "storage@example.test",
    email: "storage@example.test",
    verified: true,
    authMethods: ["email_magic_link"],
    createdAt: new Date().toISOString(),
  });

  await store.saveState(state);
  const loaded = await store.loadState();
  assert.equal(loaded.accounts.some((account) => account.id === "acct_storage_smoke"), true);

  const result = await store.updateState((nextState) => {
    nextState.events.unshift({
      id: "event_storage_smoke",
      type: "storage.sqlite_smoke",
      account_id: "acct_storage_smoke",
      payload: {},
      previous_hash: null,
      hash: "storage-smoke",
      created_at: new Date().toISOString(),
    });
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });

  const updated = await store.loadState();
  assert.equal(updated.events[0].id, "event_storage_smoke");
  assert.equal(store.storageStatus().driver, "sqlite");
  console.log("storage smoke ok");
} finally {
  await store?.closeStorage();
  await rm(tempRoot, { recursive: true, force: true });
}
