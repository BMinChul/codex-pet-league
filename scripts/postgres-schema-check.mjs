import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationDir = join(repoRoot, "db", "migrations");
const requiredTables = [
  "league_schema_migrations",
  "league_state_snapshots",
  "accounts",
  "sessions",
  "auth_challenges",
  "seasons",
  "assets",
  "pets",
  "training_report_drafts",
  "training_reports",
  "xp_ledger",
  "lp_ledger",
  "battle_rooms",
  "battles",
  "match_tickets",
  "friend_invites",
  "asset_reports",
  "risk_events",
  "rate_limits",
  "idempotency_keys",
  "abuse_alerts",
  "ops_jobs",
  "season_rewards",
  "events",
  "realtime_outbox",
];

const files = (await readdir(migrationDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
assert(files.length > 0, "at least one migration is required");

const seenTables = new Set();
for (const file of files) {
  const path = join(migrationDir, file);
  const sql = await readFile(path, "utf8");
  const upIndex = sql.indexOf("-- migrate:up");
  const downIndex = sql.indexOf("-- migrate:down");
  assert(upIndex >= 0, `${file} is missing -- migrate:up`);
  assert(downIndex > upIndex, `${file} is missing a down migration after up`);

  const upSql = sql.slice(upIndex, downIndex);
  const downSql = sql.slice(downIndex);
  assert.match(upSql, /\bBEGIN;\s*/i, `${file} up migration must begin a transaction`);
  assert.match(upSql, /\bCOMMIT;\s*$/i, `${file} up migration must commit`);
  assert.doesNotMatch(upSql, /\bDROP\s+TABLE\b/i, `${file} up migration must not drop tables`);
  assert.match(downSql, /\bBEGIN;\s*/i, `${file} down migration must begin a transaction`);
  assert.match(downSql, /\bCOMMIT;\s*$/i, `${file} down migration must commit`);
  assert.match(downSql, /\bDROP\s+TABLE\s+IF\s+EXISTS\b/i, `${file} down migration must be reversible`);

  for (const match of upSql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)) {
    seenTables.add(match[1]);
  }
  assert.match(upSql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i, `${file} should define supporting indexes`);
  console.log(`${file} checksum=${createHash("sha256").update(sql).digest("hex")}`);
}

for (const table of requiredTables) {
  assert(seenTables.has(table), `migration set is missing required table: ${table}`);
}

console.log(`postgres schema check ok (${files.length} migration, ${seenTables.size} tables)`);
