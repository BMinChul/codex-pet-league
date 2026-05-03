import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
import { authProviderStatus } from "../domain/authConfig.js";
import {
  adminAudit,
  adminConsole,
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
  reportPetAsset,
  revokeSession,
  rollbackRankedBattle,
  runServerAuthorityJob,
  reviewTrainingReport,
  simulateBattle,
  getTurnBattle,
  startTurnBattle,
  listSessions,
  submitTurnBattleAction,
  submitTrainingReport,
  moderateAsset,
  seasonOperation,
  updateAccountEnforcement,
  updatePetLoadout,
  verifyAuthChallenge,
  xpStatus,
} from "../domain/state.js";
import { IDEMPOTENCY_REQUIRED_ROUTES, enforceRequestGuard, hashRequestBody } from "../domain/antiCheat.js";
import { deliverAuthChallenge, verifyExternalAuth } from "./authProviders.js";
import { assetStorageStatus, readAssetObject, saveAtlasObject } from "../storage/assetStore.js";
import { loadState, storageStatus, updateState } from "../storage/jsonStore.js";

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));
const SERVER_STARTED_AT = Date.now();
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOW_DEV_ACCOUNT_HEADER = process.env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER === "true";
const EXPOSE_AUTH_DEV_CODE = process.env.CODEX_PET_AUTH_DEV_CODE === "true";
const BRIDGE_SECRET = process.env.CODEX_PET_BRIDGE_SECRET ?? "";
const BRIDGE_ATTESTATION_SECRET = process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET ?? "";
const OPS_JOB_INTERVAL_MS = Number(process.env.CODEX_PET_OPS_JOB_INTERVAL_MS ?? 60_000);
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
        retry_after_seconds: error.retry_after_seconds,
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

setInterval(async () => {
  try {
    const result = await updateState((state) => runServerAuthorityJob(state));
    if (result.abuse_alerts.length > 0 || result.job.high_findings > 0) {
      broadcast("ops.review_needed", { alerts: result.abuse_alerts.length, findings: result.job.high_findings });
    }
  } catch (error) {
    console.error(`ops authority job failed: ${error.message}`);
  }
}, Math.max(15_000, OPS_JOB_INTERVAL_MS)).unref();

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const health = await healthStatus();
    sendJson(res, health.status === "ok" ? 200 : 503, health);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics") {
    sendText(res, 200, await metricsText(), "text/plain; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/live") {
    await handleLive(req, res);
    return;
  }

  const path = url.pathname;
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
  let accountId = null;

  if (req.method === "POST" && path === "/api/auth/challenge") {
    const result = await updateState((state) => {
      applyRequestGuard(state, req, "auth.challenge", null, body);
      return createAuthChallenge(state, body);
    });
    const delivery = await deliverAuthChallenge(result);
    sendJson(res, 201, publicAuthChallenge({ ...result, ...delivery }));
    broadcast("auth.challenge.created", { method: result.method });
    return;
  }

  if (req.method === "POST" && path === "/api/auth/verify") {
    await updateState((state) => {
      applyRequestGuard(state, req, "auth.verify", null, body);
      return null;
    });
    const snapshot = await loadState();
    const challenge = (snapshot.authChallenges ?? []).find((entry) => entry.id === body.challenge_id);
    const externalVerification = await verifyExternalAuth(challenge, body);
    const result = await updateState((state) => {
      return verifyAuthChallenge(state, {
        challenge_id: body.challenge_id,
        code: body.code,
        provider_verified: externalVerification?.verified === true,
        provider_reason: externalVerification?.provider_reason,
        provider_subject: externalVerification?.provider_subject,
        client_context: requestClientContext(req),
      });
    });
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

  if (req.method === "GET" && path === "/api/auth/providers") {
    sendJson(res, 200, authProviderStatus());
    return;
  }

  if (req.method === "GET" && path === "/api/bridge/status") {
    sendJson(res, 200, bridgeStatus());
    return;
  }

  const assetAtlasMatch = path.match(/^\/api\/assets\/([^/]+)\/atlas$/);
  if (req.method === "GET" && assetAtlasMatch) {
    await handleAssetAtlas(res, assetAtlasMatch[1]);
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
    const result = await mutate("auth.session.revoked", (state) => {
      applyRequestGuard(state, req, "session.revoke", accountId, body);
      return revokeSession(state, accountId, body);
    });
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
    const result = await mutate("asset.active", async (state) => {
      applyRequestGuard(state, req, "asset.upload", accountId, body);
      getAccount(state, accountId);
      const asset = createPetAsset(state, accountId, body);
      await saveAtlasObject(asset.atlas_object_key, body.atlas_data_url);
      return asset;
    });
    sendJson(res, 201, { asset: result });
    return;
  }

  if (req.method === "POST" && path === "/api/pets") {
    const result = await mutate("pet.created", (state) => {
      applyRequestGuard(state, req, "pet.create", accountId, body);
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
    const result = await mutate("matchmaking.cancelled", (state) => {
      applyRequestGuard(state, req, "matchmaking.cancel", accountId, body);
      return cancelMatchmakingTicket(state, accountId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  const publicPetMatch = path.match(/^\/api\/public\/pets\/([^/]+)(?:\/(.+))?$/);
  if (req.method === "GET" && publicPetMatch && !publicPetMatch[2]) {
    const state = await loadState();
    sendJson(res, 200, petProfile(state, publicPetMatch[1]));
    return;
  }

  if (req.method === "POST" && publicPetMatch && publicPetMatch[2] === "report") {
    const result = await mutate("asset.reported", (state) => {
      applyRequestGuard(state, req, "asset.report", accountId, body);
      return reportPetAsset(state, accountId, publicPetMatch[1], body);
    });
    sendJson(res, 201, result);
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

  if (req.method === "GET" && path === "/api/admin/console") {
    const state = await loadState();
    requireAdmin(state, accountId);
    sendJson(res, 200, adminConsole(state));
    return;
  }

  if (req.method === "POST" && path === "/api/admin/ops/run") {
    const result = await mutate("ops.manual_run", (state) => {
      applyRequestGuard(state, req, "admin.ops.run", accountId, body);
      requireAdmin(state, accountId);
      return runServerAuthorityJob(state, { adminAccountId: accountId });
    });
    sendJson(res, 201, result);
    return;
  }

  const adminTrainingMatch = path.match(/^\/api\/admin\/training-reports\/([^/]+)\/review$/);
  if (req.method === "POST" && adminTrainingMatch) {
    const result = await mutate("admin.training.reviewed", (state) => {
      applyRequestGuard(state, req, "admin.training.review", accountId, body);
      return reviewTrainingReport(state, accountId, { ...body, report_id: adminTrainingMatch[1] });
    });
    sendJson(res, 201, result);
    return;
  }

  const adminAccountMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/enforcement$/);
  if (req.method === "POST" && adminAccountMatch) {
    const result = await mutate("admin.enforcement.updated", (state) => {
      applyRequestGuard(state, req, "admin.enforcement", accountId, body);
      return updateAccountEnforcement(state, accountId, { ...body, account_id: adminAccountMatch[1] });
    });
    sendJson(res, 201, result);
    return;
  }

  const adminAssetMatch = path.match(/^\/api\/admin\/assets\/([^/]+)\/moderation$/);
  if (req.method === "POST" && adminAssetMatch) {
    const result = await mutate("admin.asset.moderated", (state) => {
      applyRequestGuard(state, req, "admin.asset.moderation", accountId, body);
      return moderateAsset(state, accountId, { ...body, asset_id: adminAssetMatch[1] });
    });
    sendJson(res, 201, result);
    return;
  }

  const adminBattleRollbackMatch = path.match(/^\/api\/admin\/battles\/([^/]+)\/rollback$/);
  if (req.method === "POST" && adminBattleRollbackMatch) {
    const result = await mutate("admin.ranked.rollback", (state) => {
      applyRequestGuard(state, req, "admin.ranked.rollback", accountId, body);
      return rollbackRankedBattle(state, accountId, { ...body, battle_room_id: adminBattleRollbackMatch[1] });
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && path === "/api/admin/seasons/action") {
    const result = await mutate("admin.season.action", (state) => {
      applyRequestGuard(state, req, "admin.season.action", accountId, body);
      return seasonOperation(state, accountId, body);
    });
    sendJson(res, 201, result);
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
      applyRequestGuard(state, req, "pet.loadout", accountId, body);
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
    const result = await mutate("training.report.drafted", (state) => {
      applyRequestGuard(state, req, "training.report.draft", accountId, body);
      getAccount(state, accountId);
      return { draft: draftTrainingReport(state, accountId, petId, body) };
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && subpath === "training-reports") {
    const result = await mutate("training.report.submitted", (state) => {
      applyRequestGuard(state, req, "training.report.submit", accountId, body);
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
      applyRequestGuard(state, req, "battle.simulate", accountId, body);
      getAccount(state, accountId);
      return simulateBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "battles") {
    const result = await mutate("battle.room.started", (state) => {
      applyRequestGuard(state, req, "battle.start", accountId, body);
      getAccount(state, accountId);
      return startTurnBattle(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "matchmaking/queue") {
    const result = await mutate("matchmaking.queue", (state) => {
      applyRequestGuard(state, req, "matchmaking.queue", accountId, body);
      getAccount(state, accountId);
      return joinMatchmakingQueue(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites") {
    const result = await mutate("friend_invite.created", (state) => {
      applyRequestGuard(state, req, "friend_invite.create", accountId, body);
      getAccount(state, accountId);
      return createFriendInvite(state, accountId, petId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && subpath === "friend-invites/accept") {
    const result = await mutate("friend_invite.accepted", (state) => {
      applyRequestGuard(state, req, "friend_invite.accept", accountId, body);
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
      applyRequestGuard(state, req, "battle.action", accountId, body);
      getAccount(state, accountId);
      return submitTurnBattleAction(state, accountId, battleRoomId, body);
    });
    sendJson(res, 201, result);
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Battle API route not found." } });
}

async function handleAssetAtlas(res, assetId) {
  const state = await loadState();
  const asset = (state.assets ?? []).find((entry) => entry.id === assetId);
  if (
    !asset ||
    asset.asset_status !== "active" ||
    asset.visibility === "private" ||
    asset.safety_status === "blocked" ||
    !asset.atlas_object_key
  ) {
    sendJson(res, 404, { error: { code: "ASSET_NOT_FOUND", message: "Asset atlas not found." } });
    return;
  }
  try {
    const content = await readAssetObject(asset.atlas_object_key);
    const headers = {
      ...securityHeaders(),
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    };
    if (asset.atlas_sha256) headers.etag = `"${asset.atlas_sha256}"`;
    res.writeHead(200, headers);
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: { code: "ASSET_OBJECT_MISSING", message: "Asset atlas object is missing." } });
      return;
    }
    throw error;
  }
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

function applyRequestGuard(state, req, routeKey, accountId, body) {
  enforceRequestGuard(state, {
    accountId,
    actorKey: requestActorKey(req, accountId, body),
    routeKey,
    requestId: requestId(req, body),
    bodyHash: hashRequestBody(body),
    requireIdempotency: IDEMPOTENCY_REQUIRED_ROUTES.has(routeKey),
  });
}

function requestClientContext(req) {
  return {
    client_ip_hash: clientIpHash(req),
    device_hash: clientDeviceHash(req),
    user_agent_hash: clientUserAgentHash(req),
  };
}

function requestId(req, body) {
  return req.headers["idempotency-key"]?.toString() || body?.request_id || body?.idempotency_key || "";
}

function requestActorKey(req, accountId, body) {
  if (accountId) return `account:${accountId}`;
  const subject = body?.identifier || body?.challenge_id || "anonymous";
  return `${clientIpHash(req)}:${subject}`;
}

function clientIpHash(req) {
  const forwarded = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim();
  const raw = forwarded || req.socket.remoteAddress || "unknown";
  return createHash("sha256").update(raw).digest("hex");
}

function clientDeviceHash(req) {
  const raw = req.headers["x-league-device-id"]?.toString().trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{12,128}$/.test(raw)) return null;
  return createHash("sha256").update(raw).digest("hex");
}

function clientUserAgentHash(req) {
  const raw = req.headers["user-agent"]?.toString().slice(0, 512) ?? "";
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}

async function handleLive(req, res) {
  const accountId = await resolveAccountId(req);
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const client = { res, accountId };
  liveClients.add(client);
  res.write("retry: 3000\n");
  res.write(`event: ready\ndata: ${JSON.stringify({ connected_at: new Date().toISOString() })}\n\n`);
  req.on("close", () => liveClients.delete(client));
}

function broadcast(type, payload) {
  const event = `event: ${type}\ndata: ${JSON.stringify({ type, payload, created_at: new Date().toISOString() })}\n\n`;
  for (const client of liveClients) {
    try {
      client.res.write(event);
    } catch {
      liveClients.delete(client);
    }
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
  const attestation = bridgeAttestationTrust(req, body);
  return {
    trusted: true,
    reason: attestation.trusted ? "bridge_signature_and_attestation_valid" : "bridge_signature_valid",
    attestation,
  };
}

function bridgeAttestationTrust(req, body) {
  if (!BRIDGE_ATTESTATION_SECRET) return { trusted: false, reason: "attestation_secret_not_configured" };
  const signature = req.headers["x-codex-app-attestation"]?.toString() ?? "";
  const expected = createHmac("sha256", BRIDGE_ATTESTATION_SECRET).update(JSON.stringify(body)).digest("hex");
  if (!safeEqual(signature, expected)) return { trusted: false, reason: "attestation_invalid" };
  return { trusted: true, reason: "attestation_valid" };
}

function bridgeStatus() {
  return {
    hmac_bridge_secret: BRIDGE_SECRET ? "configured" : "missing",
    codex_app_attestation_secret: BRIDGE_ATTESTATION_SECRET ? "configured" : "missing",
    replay_signing_secret: process.env.CODEX_PET_REPLAY_SIGNING_SECRET ? "configured" : "local_dev",
    official_openai_identity: "unconfirmed",
    asset_storage: assetStorageStatus(),
  };
}

async function healthStatus() {
  try {
    const state = await loadState();
    return {
      status: "ok",
      service: "codex-pet-league",
      uptime_seconds: uptimeSeconds(),
      storage: storageStatus(),
      auth_provider: authProviderStatus(),
      bridge: bridgeStatus(),
      counts: stateCounts(state),
      live_clients: liveClients.size,
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "degraded",
      service: "codex-pet-league",
      uptime_seconds: uptimeSeconds(),
      error: error.message,
      checked_at: new Date().toISOString(),
    };
  }
}

async function metricsText() {
  const state = await loadState();
  const counts = stateCounts(state);
  const storage = storageStatus();
  const auth = authProviderStatus();
  const lines = [
    "# HELP codex_pet_info Static Codex Pet League runtime labels.",
    "# TYPE codex_pet_info gauge",
    `codex_pet_info{storage_driver="${metricLabel(storage.driver)}",auth_provider="${metricLabel(auth.provider)}"} 1`,
    "# HELP codex_pet_uptime_seconds League server uptime in seconds.",
    "# TYPE codex_pet_uptime_seconds gauge",
    `codex_pet_uptime_seconds ${uptimeSeconds()}`,
    "# HELP codex_pet_live_clients Connected SSE clients.",
    "# TYPE codex_pet_live_clients gauge",
    `codex_pet_live_clients ${liveClients.size}`,
  ];
  for (const [name, value] of Object.entries(counts)) {
    lines.push(`# TYPE codex_pet_${name}_total gauge`);
    lines.push(`codex_pet_${name}_total ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function stateCounts(state) {
  return {
    accounts: (state.accounts ?? []).length,
    pets: (state.pets ?? []).length,
    assets: (state.assets ?? []).length,
    active_battles: (state.battleRooms ?? []).filter((room) => room.status === "active").length,
    match_tickets: (state.matchTickets ?? []).filter((ticket) => ticket.status === "waiting").length,
    held_training_reports: (state.trainingReports ?? []).filter((report) => report.status === "review").length,
    abuse_alerts: (state.abuseAlerts ?? []).filter((alert) => alert.status === "open").length,
  };
}

function uptimeSeconds() {
  return Math.max(0, Math.round((Date.now() - SERVER_STARTED_AT) / 1000));
}

function metricLabel(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    res.writeHead(200, { ...securityHeaders(), "content-type": contentType(filePath) });
    res.end(content);
  } catch {
    const index = await readFile(join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { ...securityHeaders(), "content-type": "text/html; charset=utf-8" });
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
  res.writeHead(status, { ...securityHeaders(), "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, payload, contentType) {
  res.writeHead(status, { ...securityHeaders(), "content-type": contentType });
  res.end(payload);
}

function securityHeaders() {
  return {
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
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
