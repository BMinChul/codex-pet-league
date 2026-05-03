import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function runPostgresMigrations(pool, options = {}) {
  const migrationDir = options.migrationDir ?? join(repoRoot, "db", "migrations");
  const migrations = await loadPostgresMigrations(migrationDir);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT NOT NULL
    );
  `);
  const appliedRows = await pool.query("SELECT id, checksum FROM league_schema_migrations");
  const applied = new Map((appliedRows.rows ?? []).map((row) => [row.id, row.checksum]));
  const result = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const existingChecksum = applied.get(migration.id);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(`Postgres migration checksum mismatch for ${migration.id}.`);
      }
      result.skipped.push(migration.id);
      continue;
    }
    if (options.dryRun) {
      result.applied.push(migration.id);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.upSql);
      await client.query("INSERT INTO league_schema_migrations (id, checksum) VALUES ($1, $2)", [
        migration.id,
        migration.checksum,
      ]);
      await client.query("COMMIT");
      result.applied.push(migration.id);
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  return result;
}

export async function loadPostgresMigrations(migrationDir = join(repoRoot, "db", "migrations")) {
  const files = (await readdir(migrationDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  const migrations = [];
  for (const file of files) {
    const path = join(migrationDir, file);
    const sql = await readFile(path, "utf8");
    const upIndex = sql.indexOf("-- migrate:up");
    const downIndex = sql.indexOf("-- migrate:down");
    if (upIndex < 0 || downIndex <= upIndex) throw new Error(`${file} must include migrate:up and migrate:down sections.`);
    const rawUpSql = sql.slice(upIndex + "-- migrate:up".length, downIndex).trim();
    migrations.push({
      id: file,
      checksum: createHash("sha256").update(sql).digest("hex"),
      upSql: stripTransaction(rawUpSql),
    });
  }
  return migrations;
}

export function stripTransaction(sql) {
  return sql
    .replace(/^\s*BEGIN;\s*/i, "")
    .replace(/\s*COMMIT;\s*$/i, "")
    .trim();
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}
