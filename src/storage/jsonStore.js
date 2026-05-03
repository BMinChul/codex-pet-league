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
      {
        id: "acct_rival",
        displayName: "Demo Rival",
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
    events: [],
  };
}

function migrateState(state) {
  const base = createDefaultState();
  const accounts = [...(state.accounts ?? [])];
  for (const account of base.accounts) {
    if (!accounts.some((entry) => entry.id === account.id)) accounts.push(account);
  }
  return {
    ...base,
    ...state,
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
    events: state.events ?? [],
  };
}
