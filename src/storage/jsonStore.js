import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_PATH = new URL("../../data/league-state.json", import.meta.url);
const STATE_FILE_PATH = fileURLToPath(STATE_PATH);
let writeQueue = Promise.resolve();

export async function loadState() {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return migrateState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return createDefaultState();
  }
}

export async function saveState(state) {
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

export function createDefaultState() {
  return {
    version: 1,
    accounts: [
      {
        id: "acct_demo",
        displayName: "Demo Coder",
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
    events: [],
  };
}

function migrateState(state) {
  const base = createDefaultState();
  return {
    ...base,
    ...state,
    accounts: state.accounts ?? base.accounts,
    assets: state.assets ?? [],
    pets: state.pets ?? [],
    trainingReports: state.trainingReports ?? [],
    xpLedger: state.xpLedger ?? [],
    lpLedger: state.lpLedger ?? [],
    battles: state.battles ?? [],
    events: state.events ?? [],
  };
}
