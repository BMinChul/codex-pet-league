import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.argv[2] || `runs/backups/${timestamp}`);
const statePath = resolve(process.env.CODEX_PET_STATE_PATH || "data/league-state.json");
const sqlitePath = resolve(process.env.CODEX_PET_SQLITE_PATH || "data/league-state.sqlite");
const assetRoot = resolve(process.env.CODEX_PET_ASSET_ROOT || "data/assets");

await mkdir(outputRoot, { recursive: true });
const copied = [];

await copyIfExists(statePath, join(outputRoot, basename(statePath)));
await copyIfExists(sqlitePath, join(outputRoot, basename(sqlitePath)));
for (const suffix of ["-wal", "-shm"]) {
  await copyIfExists(`${sqlitePath}${suffix}`, join(outputRoot, `${basename(sqlitePath)}${suffix}`));
}
if ((process.env.CODEX_PET_STORAGE_DRIVER || "json") === "postgres" && process.env.CODEX_PET_POSTGRES_URL) {
  const store = await import(`../src/storage/jsonStore.js?backup=${Date.now()}`);
  try {
    const state = await store.loadState();
    const snapshotPath = join(outputRoot, "postgres-state-snapshot.json");
    await writeFile(snapshotPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    copied.push(snapshotPath);
  } finally {
    await store.closeStorage();
  }
}
await copyDirIfExists(assetRoot, join(outputRoot, "assets"));

const manifest = {
  created_at: new Date().toISOString(),
  state_path: statePath,
  sqlite_path: sqlitePath,
  asset_root: assetRoot,
  files: copied,
};
await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`backup written: ${outputRoot}`);

async function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  await mkdir(resolve(destination, ".."), { recursive: true });
  await cp(source, destination, { force: false });
  copied.push(destination);
}

async function copyDirIfExists(source, destination) {
  if (!existsSync(source)) return;
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) return;
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: false });
  for (const file of await walk(destination)) copied.push(file);
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const entryStat = await stat(path);
    if (entryStat.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}
