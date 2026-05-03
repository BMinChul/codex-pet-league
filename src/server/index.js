import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ELEMENTS,
  OFFICIAL_SKILLS,
  XP_CAPS,
  totalXpForLevel100,
  tierForLp,
} from "../domain/rules.js";
import {
  createPet,
  createPetAsset,
  draftTrainingReport,
  getAccount,
  leaderboard,
  acceptFriendInvite,
  createFriendInvite,
  joinMatchmakingQueue,
  matchmakingStatus,
  publicPetView,
  simulateBattle,
  getTurnBattle,
  startTurnBattle,
  submitTurnBattleAction,
  submitTrainingReport,
  xpStatus,
} from "../domain/state.js";
import { loadState, saveState, updateState } from "../storage/jsonStore.js";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status ?? 500, {
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.status ? error.message : "Unexpected server error.",
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(`Codex Pet League dev server running at http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  const accountId = req.headers["x-league-account-id"]?.toString() || "acct_demo";
  const path = url.pathname;
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};

  if (req.method === "GET" && path === "/api/session") {
    const state = await loadState();
    const account = getAccount(state, accountId);
    sendJson(res, 200, { account });
    return;
  }

  if (req.method === "GET" && path === "/api/rules") {
    sendJson(res, 200, {
      elements: ELEMENTS,
      skills: OFFICIAL_SKILLS,
      caps: XP_CAPS,
      level100Xp: totalXpForLevel100(),
      level100FastestDaysAtCap: Math.round((totalXpForLevel100() / XP_CAPS.petDaily) * 10) / 10,
    });
    return;
  }

  if (req.method === "GET" && path === "/api/pets") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, {
      pets: state.pets.filter((pet) => pet.owner_account_id === accountId).map((pet) => publicPetView(state, pet)),
    });
    return;
  }

  if (req.method === "POST" && path === "/api/pet-assets/uploads") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return createPetAsset(state, accountId, body);
    });
    sendJson(res, 201, { asset: result });
    return;
  }

  if (req.method === "POST" && path === "/api/pets") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return createPet(state, accountId, body);
    });
    sendJson(res, 201, { pet: result });
    return;
  }

  const petMatch = path.match(/^\/api\/pets\/([^/]+)(?:\/(.+))?$/);
  if (petMatch) {
    const [, petId, subpath = ""] = petMatch;
    await handlePetApi(req, res, accountId, petId, subpath, body);
    return;
  }

  if (req.method === "GET" && path === "/api/matchmaking/status") {
    const state = await loadState();
    sendJson(res, 200, matchmakingStatus(state, accountId, url.searchParams.get("pet_id")));
    return;
  }

  const battleMatch = path.match(/^\/api\/battles\/([^/]+)(?:\/(.+))?$/);
  if (battleMatch) {
    const [, battleRoomId, subpath = ""] = battleMatch;
    await handleBattleApi(req, res, accountId, battleRoomId, subpath, body);
    return;
  }

  if (req.method === "GET" && path === "/api/leaderboard") {
    const state = await loadState();
    sendJson(res, 200, { leaderboard: leaderboard(state) });
    return;
  }

  if (req.method === "GET" && path === "/api/events") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, { events: state.events.slice(0, 80) });
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "API route not found." } });
}

async function handlePetApi(req, res, accountId, petId, subpath, body) {
  if (req.method === "GET" && subpath === "") {
    const state = await loadState();
    getAccount(state, accountId);
    const pet = state.pets.find((entry) => entry.id === petId && entry.owner_account_id === accountId);
    if (!pet) {
      sendJson(res, 404, { error: { code: "PET_NOT_FOUND", message: "Pet not found." } });
      return;
    }
    sendJson(res, 200, { pet: publicPetView(state, pet) });
    return;
  }

  if (req.method === "GET" && subpath === "xp-status") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, xpStatus(state, accountId, petId));
    return;
  }

  if (req.method === "POST" && subpath === "training-reports/draft") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, { draft: draftTrainingReport(state, accountId, petId, body) });
    return;
  }

  if (req.method === "POST" && subpath === "training-reports") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return submitTrainingReport(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "battles/simulate") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return simulateBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "battles") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return startTurnBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "matchmaking/queue") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return joinMatchmakingQueue(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return createFriendInvite(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites/accept") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return acceptFriendInvite(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Pet API route not found." } });
}

async function handleBattleApi(req, res, accountId, battleRoomId, subpath, body) {
  if (req.method === "GET" && subpath === "") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return getTurnBattle(state, accountId, battleRoomId);
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && subpath === "actions") {
    const result = await updateState((state) => {
      getAccount(state, accountId);
      return submitTurnBattleAction(state, accountId, battleRoomId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Battle API route not found." } });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: { code: "FORBIDDEN", message: "Forbidden path." } });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(content);
  } catch {
    const index = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(index);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    error.code = "BAD_JSON";
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}
