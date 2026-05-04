import { hashLedgerEntry } from "../src/domain/audit.js";
import { closeStorage, loadState, saveState, storageStatus } from "../src/storage/jsonStore.js";

const apply = process.argv.includes("--apply");

try {
  const state = await loadState();
  const working = JSON.parse(JSON.stringify(state));
  const summary = {
    generated_at: new Date().toISOString(),
    applied: apply,
    storage: storageStatus(),
    chains: {
      xpLedger: rehashForwardChain(working.xpLedger ?? []),
      lpLedger: rehashForwardChain(working.lpLedger ?? []),
      riskEvents: rehashReverseChain(working.riskEvents ?? []),
      events: rehashReverseChain(working.events ?? []),
    },
  };
  if (apply) {
    appendMigrationEvent(working, summary);
    await saveState(working);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await closeStorage();
}

function rehashForwardChain(entries) {
  let changed = 0;
  let previousHash = null;
  for (const entry of entries) {
    const beforeHash = entry.hash ?? null;
    const beforePrevious = entry.previous_hash ?? null;
    entry.previous_hash = previousHash;
    entry.hash = hashLedgerEntry({ ...entry, hash: undefined });
    if (entry.hash !== beforeHash || entry.previous_hash !== beforePrevious) changed += 1;
    previousHash = entry.hash;
  }
  return { entries: entries.length, changed };
}

function rehashReverseChain(entries) {
  let changed = 0;
  let previousHash = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const beforeHash = entry.hash ?? null;
    const beforePrevious = entry.previous_hash ?? null;
    entry.previous_hash = previousHash;
    entry.hash = hashLedgerEntry({ ...entry, hash: undefined });
    if (entry.hash !== beforeHash || entry.previous_hash !== beforePrevious) changed += 1;
    previousHash = entry.hash;
  }
  return { entries: entries.length, changed };
}

function appendMigrationEvent(state, summary) {
  state.events ??= [];
  const event = {
    id: `event_rehash_${Date.now()}`,
    type: "ops.hash_chains_rebased",
    account_id: null,
    payload: {
      reason: "stable_json_hash_migration",
      changed: summary.chains,
    },
    previous_hash: state.events[0]?.hash ?? null,
    created_at: new Date().toISOString(),
  };
  event.hash = hashLedgerEntry({ ...event, hash: undefined });
  state.events.unshift(event);
  state.events = state.events.slice(0, 200);
}
