import { createHash } from "node:crypto";

const DEFAULT_CHANNEL = "codex-pet-league:events";

export async function createPostgresSnapshotStore(env = process.env, options = {}) {
  const pool = options.pool ?? new (options.Pool ?? (await importPgPool()))(postgresPoolOptions(env));
  const store = new PostgresSnapshotStore(pool, env);
  await store.ensureReady();
  return store;
}

export class PostgresSnapshotStore {
  constructor(pool, env = process.env) {
    this.pool = pool;
    this.env = env;
    this.ready = false;
    this.retention = postgresSnapshotRetention(env);
  }

  async ensureReady() {
    if (this.ready) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS league_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS league_state_snapshots (
        id BIGSERIAL PRIMARY KEY,
        state_json JSONB NOT NULL,
        state_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_league_state_snapshots_created_at
        ON league_state_snapshots(created_at);
    `);
    this.ready = true;
  }

  async load() {
    await this.ensureReady();
    const result = await this.pool.query(
      "SELECT state_json FROM league_state_snapshots ORDER BY id DESC LIMIT 1",
    );
    if (!result.rows?.length) return null;
    const value = result.rows[0].state_json;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async save(state) {
    await this.ensureReady();
    const stateJson = JSON.stringify(state);
    const stateHash = createHash("sha256").update(stateJson).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO league_state_snapshots (state_json, state_hash) VALUES ($1::jsonb, $2)",
        [stateJson, stateHash],
      );
      await client.query(
        "DELETE FROM league_state_snapshots WHERE id NOT IN (SELECT id FROM league_state_snapshots ORDER BY id DESC LIMIT $1)",
        [this.retention],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  status() {
    return {
      driver: "postgres",
      postgres_url: redactConnectionString(this.env.CODEX_PET_POSTGRES_URL || ""),
      postgres_snapshot_retention: this.retention,
      realtime_channel: this.env.CODEX_PET_REALTIME_CHANNEL || DEFAULT_CHANNEL,
    };
  }

  async close() {
    await this.pool.end();
    this.ready = false;
  }
}

export function postgresPoolOptions(env = process.env) {
  const connectionString = env.CODEX_PET_POSTGRES_URL;
  if (!connectionString) {
    throw new Error("CODEX_PET_POSTGRES_URL is required when CODEX_PET_STORAGE_DRIVER=postgres.");
  }
  const options = { connectionString };
  if (env.CODEX_PET_POSTGRES_SSL === "true") {
    options.ssl = { rejectUnauthorized: env.CODEX_PET_POSTGRES_SSL_REJECT_UNAUTHORIZED !== "false" };
  }
  return options;
}

export function postgresSnapshotRetention(env = process.env) {
  const value = Number(env.CODEX_PET_POSTGRES_SNAPSHOT_RETENTION ?? 500);
  return Number.isInteger(value) && value >= 10 ? value : 500;
}

export function redactConnectionString(value) {
  if (!value) return "missing";
  try {
    const url = new URL(value);
    if (url.password) url.password = "REDACTED";
    if (url.username) url.username = "REDACTED";
    return url.toString();
  } catch {
    return "invalid";
  }
}

async function importPgPool() {
  const pg = await import("pg");
  return pg.Pool;
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Keep the original database error as the actionable failure.
  }
}
