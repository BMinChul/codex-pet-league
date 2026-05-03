import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ELEMENTS,
  OFFICIAL_SKILLS,
  XP_CAPS,
  MATCHMAKING_POLICY,
  totalXpForLevel100,
} from "../domain/rules.js";
import {
  adminAudit,
  cancelMatchmakingTicket,
  createAuthChallenge,
  createPet,
  createPetAsset,
  draftTrainingReport,
  getAccount,
  getAccountBySession,
  leaderboard,
  acceptFriendInvite,
  createFriendInvite,
  joinMatchmakingQueue,
  leagueStatus,
  matchmakingStatus,
  petProfile,
  petReplays,
  processMatchmakingQueues,
  publicPetView,
  requireAdmin,
  revokeSession,
  simulateBattle,
  getTurnBattle,
  startTurnBattle,
  listSessions,
  submitTurnBattleAction,
  submitTrainingReport,
  updatePetLoadout,
  verifyAuthChallenge,
  xpStatus,
} from "../domain/state.js";
import { loadState, updateState } from "../storage/jsonStore.js";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOW_DEV_ACCOUNT_HEADER = process.env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER === "true";
const EXPOSE_AUTH_DEV_CODE = process.env.CODEX_PET_AUTH_DEV_CODE === "true";
const BRIDGE_SECRET = process.env.CODEX_PET_BRIDGE_SECRET ?? "";
const SESSION_COOKIE = "league_session";
const liveClients = new Set();

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

setInterval(async () => {
  try {
    const result = await updateState((state) => processMatchmakingQueues(state));
    if (result.matches.length > 0) broadcast("matchmaking.background_matched", { matches: result.matches.length });
  } catch (error) {
    console.error(`background matcher failed: ${error.message}`);
  }
}, 3000).unref();

setInterval(() => {
  broadcast("heartbeat", { live_clients: liveClients.size });
}, 15000).unref();

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/live") {
    await handleLive(req, res);
    return;
  }

  const path = url.pathname;
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
  let accountId = null;

  if (req.method === "POST" && path === "/api/auth/challenge") {
    const result = await updateState((state) => createAuthChallenge(state, body));
    sendJson(res, 201, publicAuthChallenge(result));
    broadcast("auth.challenge.created", { method: result.method });
    return;
  }

  if (req.method === "POST" && path === "/api/auth/verify") {
    const result = await updateState((state) => verifyAuthChallenge(state, body));
    sendJson(res, 201, result, { "set-cookie": sessionCookie(result.session_token, result.session.expires_at) });
    broadcast("auth.session.created", { account_id: result.account.id });
    return;
  }

  if (req.method === "GET" && path === "/api/rules") {
    sendJson(res, 200, {
      elements: ELEMENTS,
      skills: OFFICIAL_SKILLS,
      caps: XP_CAPS,
      matchmakingPolicy: MATCHMAKING_POLICY,
      level100Xp: totalXpForLevel100(),
      level100FastestDaysAtCap: Math.round((totalXpForLevel100() / XP_CAPS.petDaily) * 10) / 10,
    });
    return;
  }

  accountId = await resolveAccountId(req);

  if (req.method === "GET" && path === "/api/session") {
    const state = await loadState();
    const account = getAccount(state, accountId);
    sendJson(res, 200, { account });
    return;
  }

  if (req.method === "GET" && path === "/api/sessions") {
    const state = await loadState();
    sendJson(res, 200, listSessions(state, accountId));
    return;
  }

  if (req.method === "POST" && path === "/api/sessions/revoke") {
    const currentToken = getSessionToken(req);
    const result = await mutate("auth.session.revoked", (state) => revokeSession(state, accountId, body));
    const headers =
      currentToken && (result.session.id === body.session_id || currentToken === body.token)
        ? { "set-cookie": clearSessionCookie() }
        : {};
    sendJson(res, 201, result, headers);
    return;
  }

  if (req.method === "GET" && path === "/api/league") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, leagueStatus(state));
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
    const result = await mutate("asset.active", (state) => {
      getAccount(state, accountId);
      return createPetAsset(state, accountId, body);
    });
    sendJson(res, 201, { asset: result });
    return;
  }

  if (req.method === "POST" && path === "/api/pets") {
    const result = await mutate("pet.created", (state) => {
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

  if (req.method === "POST" && path === "/api/matchmaking/cancel") {
    const result = await mutate("matchmaking.cancelled", (state) => cancelMatchmakingTicket(state, accountId, body));
    sendJson(res, 201, result);
    return;
  }

  const publicPetMatch = path.match(/^\/api\/public\/pets\/([^/]+)$/);
  if (req.method === "GET" && publicPetMatch) {
    const state = await loadState();
    sendJson(res, 200, petProfile(state, publicPetMatch[1]));
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
    sendJson(res, 200, { events: state.events.filter((event) => event.account_id === accountId).slice(0, 80).map(redactEvent) });
    return;
  }

  if (req.method === "GET" && path === "/api/admin/audit") {
    const state = await loadState();
    requireAdmin(state, accountId);
    sendJson(res, 200, adminAudit(state));
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

  if (req.method === "PUT" && subpath === "loadout") {
    const result = await mutate("pet.loadout.updated", (state) => {
      getAccount(state, accountId);
      return updatePetLoadout(state, accountId, petId, body);
    });
    sendJson(res, 200, { pet: result });
    return;
  }

  if (req.method === "GET" && subpath === "replays") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, petReplays(state, accountId, petId));
    return;
  }

  if (req.method === "POST" && subpath === "training-reports/draft") {
    const state = await loadState();
    getAccount(state, accountId);
    sendJson(res, 200, { draft: draftTrainingReport(state, accountId, petId, body) });
    return;
  }

  if (req.method === "POST" && subpath === "training-reports") {
    const result = await mutate("training.report.submitted", (state) => {
      getAccount(state, accountId);
      return submitTrainingReport(state, accountId, petId, {
        ...body,
        server_trust: trainingReportTrust(req, body),
      });
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "battles/simulate") {
    const result = await mutate("battle.simulated", (state) => {
      getAccount(state, accountId);
      return simulateBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "battles") {
    const result = await mutate("battle.room.started", (state) => {
      getAccount(state, accountId);
      return startTurnBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "matchmaking/queue") {
    const result = await mutate("matchmaking.queue", (state) => {
      getAccount(state, accountId);
      return joinMatchmakingQueue(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites") {
    const result = await mutate("friend_invite.created", (state) => {
      getAccount(state, accountId);
      return createFriendInvite(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites/accept") {
    const result = await mutate("friend_invite.accepted", (state) => {
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
    const result = await mutate("battle.room.viewed", (state) => {
      getAccount(state, accountId);
      return getTurnBattle(state, accountId, battleRoomId);
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && subpath === "actions") {
    const result = await mutate("battle.action.submitted", (state) => {
      getAccount(state, accountId);
      return submitTurnBattleAction(state, accountId, battleRoomId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Battle API route not found." } });
}

async function resolveAccountId(req) {
  const sessionToken = getSessionToken(req);
  if (sessionToken) {
    const state = await loadState();
    return getAccountBySession(state, sessionToken).id;
  }
  if (!ALLOW_DEV_ACCOUNT_HEADER) {
    const error = new Error("League session token is required.");
    error.status = 401;
    error.code = "SESSION_REQUIRED";
    throw error;
  }
  return req.headers["x-league-account-id"]?.toString() || "acct_demo";
}

async function mutate(eventType, mutator) {
  const result = await updateState(mutator);
  broadcast(eventType, { changed: true });
  return result;
}

async function handleLive(req, res) {
  await resolveAccountId(req);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const client = { res };
  liveClients.add(client);
  res.write(`event: ready\ndata: ${JSON.stringify({ connected_at: new Date().toISOString() })}\n\n`);
  req.on("close", () => liveClients.delete(client));
}

function broadcast(type, payload) {
  const event = `event: ${type}\ndata: ${JSON.stringify({ type, payload, created_at: new Date().toISOString() })}\n\n`;
  for (const client of liveClients) {
    client.res.write(event);
  }
}

function redactEvent(event) {
  const payload = { ...(event.payload ?? {}) };
  if (payload.code) payload.code = "REDACTED";
  if (payload.invite_code) payload.invite_code = "REDACTED";
  return { ...event, payload };
}

function publicAuthChallenge(result) {
  if (EXPOSE_AUTH_DEV_CODE) return result;
  const { dev_code, ...safeResult } = result;
  return safeResult;
}

function getSessionToken(req) {
  return req.headers["x-league-session-token"]?.toString() || parseCookies(req.headers.cookie)[SESSION_COOKIE] || "";
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader ?? "").split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || valueParts.length === 0) continue;
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function trainingReportTrust(req, body) {
  if (!BRIDGE_SECRET) return { trusted: false, reason: "bridge_secret_not_configured" };
  const signature = req.headers["x-league-bridge-signature"]?.toString() ?? "";
  const expected = createHmac("sha256", BRIDGE_SECRET).update(JSON.stringify(body)).digest("hex");
  if (!safeEqual(signature, expected)) return { trusted: false, reason: "bridge_signature_invalid" };
  return { trusted: true, reason: "bridge_signature_valid" };
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
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

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
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
