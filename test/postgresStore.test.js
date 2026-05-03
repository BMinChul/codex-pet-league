import test from "node:test";
import assert from "node:assert/strict";
import { PostgresSnapshotStore, redactConnectionString } from "../src/storage/postgresStore.js";
import { runPostgresMigrations, stripTransaction } from "../src/storage/postgresMigrations.js";

test("postgres snapshot store saves and loads state through a transaction", async () => {
  const rows = [];
  const queries = [];
  let released = false;
  let ended = false;
  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      if (/INSERT INTO league_state_snapshots/i.test(sql)) rows.push(JSON.parse(params[0]));
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (/SELECT state_json FROM league_state_snapshots/i.test(sql)) {
        return { rows: rows.length ? [{ state_json: rows.at(-1) }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    },
  };
  const store = new PostgresSnapshotStore(pool, {
    CODEX_PET_POSTGRES_URL: "postgres://user:secret@example.test:5432/league",
    CODEX_PET_POSTGRES_SNAPSHOT_RETENTION: "25",
  });

  await store.save({ version: 1, accounts: [{ id: "acct_pg" }] });
  const loaded = await store.load();

  assert.deepEqual(loaded.accounts, [{ id: "acct_pg" }]);
  assert.equal(released, true);
  assert.equal(store.status().postgres_snapshot_retention, 25);
  assert.match(queries.join("\n"), /BEGIN/);
  assert.match(queries.join("\n"), /COMMIT/);
  assert.match(queries.join("\n"), /DELETE FROM league_state_snapshots/);

  await store.close();
  assert.equal(ended, true);
});

test("postgres connection strings are redacted in status output", () => {
  assert.equal(
    redactConnectionString("postgres://league_user:league_secret@db.example.test:5432/league"),
    "postgres://REDACTED:REDACTED@db.example.test:5432/league",
  );
  assert.equal(redactConnectionString(""), "missing");
});

test("postgres migration dry-run parses unapplied migrations", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (/SELECT id, checksum FROM league_schema_migrations/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const result = await runPostgresMigrations(pool, { dryRun: true });

  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied.includes("001_initial_postgres_schema.sql"), true);
  assert.match(queries.join("\n"), /CREATE TABLE IF NOT EXISTS league_schema_migrations/);
});

test("postgres migration runner strips file-level transaction wrappers", () => {
  assert.equal(stripTransaction("BEGIN;\nCREATE TABLE example(id TEXT);\nCOMMIT;"), "CREATE TABLE example(id TEXT);");
});
