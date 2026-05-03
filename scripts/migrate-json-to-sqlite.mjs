import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const jsonPath = resolve(process.argv[2] ?? process.env.CODEX_PET_STATE_PATH ?? "data/league-state.json");
const sqlitePath = resolve(process.argv[3] ?? process.env.CODEX_PET_SQLITE_PATH ?? "data/league-state.sqlite");

if (!existsSync(jsonPath)) {
  throw new Error(`JSON state file not found: ${jsonPath}`);
}

const state = JSON.parse(await readFile(jsonPath, "utf8"));
process.env.CODEX_PET_STORAGE_DRIVER = "sqlite";
process.env.CODEX_PET_SQLITE_PATH = sqlitePath;

const store = await import(`../src/storage/jsonStore.js?db-migrate=${Date.now()}`);
await store.saveState(state);

console.log(`migrated ${jsonPath} -> ${sqlitePath}`);
