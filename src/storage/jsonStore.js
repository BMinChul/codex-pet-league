import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SEASON } from "../domain/rules.js";

export const STATE_PATH = process.env.CODEX_PET_STATE_PATH
  ? pathToFileURL(resolve(process.env.CODEX_PET_STATE_PATH))
  : new URL("../../data/league-state.json", import.meta.url);
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
  const tempPath = `${STATE_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, STATE_FILE_PATH);
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
    sessions: [],
    authChallenges: [],
    riskEvents: [],
    events: [],
  };
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
    sessions: state.sessions ?? [],
    authChallenges: state.authChallenges ?? [],
    riskEvents: state.riskEvents ?? [],
    events: state.events ?? [],
  };
}
