import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SEASON } from "../domain/rules.js";

export const STORAGE_DRIVER = process.env.CODEX_PET_STORAGE_DRIVER || "json";
export const STATE_PATH = process.env.CODEX_PET_STATE_PATH
  ? pathToFileURL(resolve(process.env.CODEX_PET_STATE_PATH))
  : new URL("../../data/league-state.json", import.meta.url);
export const SQLITE_PATH = process.env.CODEX_PET_SQLITE_PATH
  ? pathToFileURL(resolve(process.env.CODEX_PET_SQLITE_PATH))
  : new URL("../../data/league-state.sqlite", import.meta.url);
const STATE_FILE_PATH = fileURLToPath(STATE_PATH);
const SQLITE_FILE_PATH = fileURLToPath(SQLITE_PATH);
let writeQueue = Promise.resolve();
let sqliteHandle = null;

export async function loadState() {
  if (storageDriver() === "sqlite") return loadSqliteState();
  try {
    const raw = await retryTransientFileOperation(() => readFile(STATE_FILE_PATH, "utf8"));
    return migrateState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return createDefaultState();
  }
}

export async function saveState(state) {
  if (storageDriver() === "sqlite") return saveSqliteState(state);
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    await retryTransientFileOperation(() => rename(tempPath, STATE_FILE_PATH));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function updateState(mutator) {
  const next = writeQueue.then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await saveState(state);
    return result;
  });
  writeQueue = next.catch(() => {});
  return next;
}

export function storageStatus() {
  const driver = storageDriver();
  return {
    driver,
    json_path: STATE_FILE_PATH,
    sqlite_path: SQLITE_FILE_PATH,
    sqlite_snapshot_retention: sqliteSnapshotRetention(),
  };
}

export function closeStorage() {
  if (!sqliteHandle) return;
  sqliteHandle.close();
  sqliteHandle = null;
}

export function createDefaultState() {
  return {
    version: 1,
    activeSeasonId: DEFAULT_SEASON.id,
    seasons: [DEFAULT_SEASON],
    accounts: [
      {
        id: "acct_demo",
        displayName: "Demo Coder",
        role: "admin",
        identifier: "demo@codexpet.local",
        email: "demo@codexpet.local",
        verified: true,
        authMethods: ["passkey", "email_magic_link", "league_oauth"],
        createdAt: new Date().toISOString(),
      },
      {
        id: "acct_rival",
        displayName: "Demo Rival",
        role: "player",
        identifier: "rival@codexpet.local",
        email: "rival@codexpet.local",
        verified: true,
        authMethods: ["passkey", "email_magic_link", "league_oauth"],
        createdAt: new Date().toISOString(),
      },
    ],
    assets: [],
    pets: [],
    trainingReports: [],
    xpLedger: [],
    lpLedger: [],
    battles: [],
    battleRooms: [],
    matchTickets: [],
    friendInvites: [],
    assetReports: [],
    sessions: [],
    authChallenges: [],
    trainingReportDrafts: [],
    riskEvents: [],
    rateLimits: [],
    idempotencyKeys: [],
    inviteAttempts: [],
    queueAbuseEvents: [],
    abuseAlerts: [],
    opsJobs: [],
    seasonRewards: [],
    events: [],
  };
}

async function loadSqliteState() {
  const db = await sqliteDatabase();
  const row = db.prepare("SELECT state_json FROM league_snapshots ORDER BY id DESC LIMIT 1").get();
  if (!row) return createDefaultState();
  return migrateState(JSON.parse(row.state_json));
}

async function saveSqliteState(state) {
  await mkdir(dirname(SQLITE_FILE_PATH), { recursive: true });
  const db = await sqliteDatabase();
  const stateJson = JSON.stringify(state);
  const stateHash = createHash("sha256").update(stateJson).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO league_snapshots (state_json, state_hash, created_at) VALUES (?, ?, ?)").run(
      stateJson,
      stateHash,
      new Date().toISOString(),
    );
    db.prepare(
      "DELETE FROM league_snapshots WHERE id NOT IN (SELECT id FROM league_snapshots ORDER BY id DESC LIMIT ?)",
    ).run(sqliteSnapshotRetention());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function sqliteDatabase() {
  if (sqliteHandle) return sqliteHandle;
  await mkdir(dirname(SQLITE_FILE_PATH), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  sqliteHandle = new DatabaseSync(SQLITE_FILE_PATH);
  sqliteHandle.exec("PRAGMA journal_mode = WAL");
  sqliteHandle.exec("PRAGMA busy_timeout = 5000");
  sqliteHandle.exec(`
    CREATE TABLE IF NOT EXISTS league_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_json TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_league_snapshots_created_at ON league_snapshots(created_at);
  `);
  return sqliteHandle;
}

function storageDriver() {
  const driver = process.env.CODEX_PET_STORAGE_DRIVER || STORAGE_DRIVER || "json";
  if (driver === "json" || driver === "sqlite") return driver;
  throw new Error(`Unsupported CODEX_PET_STORAGE_DRIVER: ${driver}`);
}

function sqliteSnapshotRetention() {
  const value = Number(process.env.CODEX_PET_SQLITE_SNAPSHOT_RETENTION ?? 500);
  return Number.isInteger(value) && value >= 10 ? value : 500;
}

function migrateState(state) {
  const base = createDefaultState();
  const accounts = [...(state.accounts ?? [])];
  for (const account of base.accounts) {
    const existing = accounts.find((entry) => entry.id === account.id);
    if (existing) {
      existing.role ??= account.role;
      existing.identifier ??= account.identifier;
      existing.email ??= account.email;
    } else {
      accounts.push(account);
    }
  }
  return {
    ...base,
    ...state,
    activeSeasonId: state.activeSeasonId ?? base.activeSeasonId,
    seasons: state.seasons ?? base.seasons,
    accounts,
    assets: state.assets ?? [],
    pets: state.pets ?? [],
    trainingReports: state.trainingReports ?? [],
    xpLedger: state.xpLedger ?? [],
    lpLedger: state.lpLedger ?? [],
    battles: state.battles ?? [],
    battleRooms: state.battleRooms ?? [],
    matchTickets: state.matchTickets ?? [],
    friendInvites: state.friendInvites ?? [],
    assetReports: state.assetReports ?? [],
    sessions: state.sessions ?? [],
    authChallenges: state.authChallenges ?? [],
    trainingReportDrafts: state.trainingReportDrafts ?? [],
    riskEvents: state.riskEvents ?? [],
    rateLimits: state.rateLimits ?? [],
    idempotencyKeys: state.idempotencyKeys ?? [],
    inviteAttempts: state.inviteAttempts ?? [],
    queueAbuseEvents: state.queueAbuseEvents ?? [],
    abuseAlerts: state.abuseAlerts ?? [],
    opsJobs: state.opsJobs ?? [],
    seasonRewards: state.seasonRewards ?? [],
    events: state.events ?? [],
  };
}

async function retryTransientFileOperation(operation) {
  const delaysMs = [20, 50, 100, 200, 400];
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileError(error) || attempt === delaysMs.length) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}

function isTransientFileError(error) {
  return ["EBUSY", "EMFILE", "ENFILE", "EPERM"].includes(error?.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
