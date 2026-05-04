import { createHash } from "node:crypto";
import { appendRiskEvent } from "./audit.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RATE_LIMIT_POLICIES = {
  "auth.challenge": { limit: 1, windowMs: 10 * MINUTE, score: 25 },
  "auth.verify": { limit: 8, windowMs: 15 * MINUTE, score: 35 },
  "asset.upload": { limit: 8, windowMs: HOUR, score: 35 },
  "asset.report": { limit: 10, windowMs: HOUR, score: 25 },
  "pet.create": { limit: 12, windowMs: HOUR, score: 25 },
  "pet.loadout": { limit: 30, windowMs: 10 * MINUTE, score: 15 },
  "training.report.draft": { limit: 30, windowMs: 10 * MINUTE, score: 10 },
  "training.report.submit": { limit: 8, windowMs: 10 * MINUTE, score: 35 },
  "battle.start": { limit: 20, windowMs: 10 * MINUTE, score: 25 },
  "battle.action": { limit: 90, windowMs: MINUTE, score: 20 },
  "matchmaking.queue": { limit: 20, windowMs: 10 * MINUTE, score: 25 },
  "matchmaking.cancel": { limit: 30, windowMs: 10 * MINUTE, score: 15 },
  "friend_invite.create": { limit: 20, windowMs: HOUR, score: 20 },
  "friend_invite.accept": { limit: 30, windowMs: HOUR, score: 20 },
  "session.revoke": { limit: 20, windowMs: HOUR, score: 15 },
  "admin.ops.run": { limit: 10, windowMs: HOUR, score: 15 },
  "admin.training.review": { limit: 60, windowMs: HOUR, score: 10 },
  "admin.enforcement": { limit: 40, windowMs: HOUR, score: 15 },
  "admin.asset.moderation": { limit: 60, windowMs: HOUR, score: 10 },
  "admin.ranked.rollback": { limit: 20, windowMs: HOUR, score: 15 },
  "admin.season.action": { limit: 10, windowMs: DAY, score: 20 },
};

export const IDEMPOTENCY_REQUIRED_ROUTES = new Set([
  "asset.upload",
  "asset.report",
  "pet.create",
  "training.report.submit",
  "battle.start",
  "battle.action",
  "matchmaking.queue",
  "matchmaking.cancel",
  "friend_invite.create",
  "friend_invite.accept",
  "admin.ops.run",
  "admin.training.review",
  "admin.enforcement",
  "admin.asset.moderation",
  "admin.ranked.rollback",
  "admin.season.action",
]);

export function enforceRequestGuard(state, input = {}) {
  enforcePreparedRequestGuard(state, prepareRequestGuard(input));
}

export async function enforceRequestGuardWithDistributed(state, input = {}, distributedGuard) {
  const prepared = prepareRequestGuard(input);
  await distributedGuard?.enforce(prepared);
  enforcePreparedRequestGuard(state, prepared);
}

function prepareRequestGuard(input = {}) {
  const routeKey = input.routeKey ?? "unknown";
  const policy = RATE_LIMIT_POLICIES[routeKey] ?? { limit: 60, windowMs: MINUTE, score: 10 };
  const now = input.now ? new Date(input.now) : new Date();
  const actorHash = hashText(input.accountId ? `account:${input.accountId}` : `actor:${input.actorKey ?? "anonymous"}`);
  const requestId = sanitizeRequestId(input.requestId);

  return {
    accountId: input.accountId ?? null,
    actorHash,
    routeKey,
    policy,
    now,
    requestId,
    bodyHash: input.bodyHash,
    required: Boolean(input.requireIdempotency),
  };
}

function enforcePreparedRequestGuard(state, prepared) {
  pruneGuards(state, prepared.now);
  enforceRateLimit(state, prepared);
  enforceIdempotency(state, prepared);
}

export function hashRequestBody(body) {
  return hashText(JSON.stringify(stripVolatileRequestFields(body ?? {})));
}

function enforceRateLimit(state, input) {
  state.rateLimits ??= [];
  const windowStartedAt = new Date(input.now.getTime() - input.policy.windowMs);
  const bucket = `${input.routeKey}:${input.actorHash}`;
  let entry = state.rateLimits.find((item) => item.bucket === bucket);

  if (!entry || new Date(entry.window_started_at) <= windowStartedAt) {
    entry = {
      bucket,
      route_key: input.routeKey,
      actor_hash: input.actorHash,
      account_id: input.accountId,
      count: 0,
      limit: input.policy.limit,
      window_ms: input.policy.windowMs,
      window_started_at: input.now.toISOString(),
      expires_at: new Date(input.now.getTime() + input.policy.windowMs).toISOString(),
    };
    state.rateLimits = state.rateLimits.filter((item) => item.bucket !== bucket);
    state.rateLimits.push(entry);
  }

  entry.count += 1;
  entry.last_seen_at = input.now.toISOString();
  if (entry.count <= input.policy.limit) return;

  appendRiskEvent(state, {
    accountId: input.accountId,
    type: "request.rate_limited",
    severity: "medium",
    score: input.policy.score,
    metadata: {
      route_key: input.routeKey,
      count: entry.count,
      limit: input.policy.limit,
      window_ms: input.policy.windowMs,
    },
  });

  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(entry.expires_at).getTime() - input.now.getTime()) / 1000));
  throw guardedError(429, "RATE_LIMITED", `Too many ${input.routeKey} requests. Retry later.`, {
    retry_after_seconds: retryAfterSeconds,
  });
}

function enforceIdempotency(state, input) {
  state.idempotencyKeys ??= [];
  const requestId = input.requestId;
  if (!requestId) {
    if (input.required) {
      appendRiskEvent(state, {
        accountId: input.accountId,
        type: "request.idempotency_missing",
        severity: "low",
        score: 10,
        metadata: { route_key: input.routeKey },
      });
      throw guardedError(400, "REQUEST_ID_REQUIRED", "This action requires a unique request_id or Idempotency-Key header.");
    }
    return;
  }

  const keyHash = hashText(`${input.actorHash}:${input.routeKey}:${requestId}`);
  const existing = state.idempotencyKeys.find((entry) => entry.key_hash === keyHash);
  if (!existing) {
    state.idempotencyKeys.push({
      key_hash: keyHash,
      account_id: input.accountId,
      actor_hash: input.actorHash,
      route_key: input.routeKey,
      body_hash: input.bodyHash,
      created_at: input.now.toISOString(),
      expires_at: new Date(input.now.getTime() + DAY).toISOString(),
    });
    return;
  }

  appendRiskEvent(state, {
    accountId: input.accountId,
    type: existing.body_hash === input.bodyHash ? "request.replayed" : "request.idempotency_conflict",
    severity: existing.body_hash === input.bodyHash ? "medium" : "high",
    score: existing.body_hash === input.bodyHash ? 30 : 70,
    metadata: { route_key: input.routeKey, created_at: existing.created_at },
  });

  if (existing.body_hash !== input.bodyHash) {
    throw guardedError(409, "IDEMPOTENCY_KEY_CONFLICT", "This request_id was already used with different request content.");
  }
  throw guardedError(409, "REQUEST_REPLAYED", "This request_id was already used.");
}

function pruneGuards(state, now) {
  state.rateLimits = (state.rateLimits ?? []).filter((entry) => new Date(entry.expires_at) > now).slice(-5000);
  state.idempotencyKeys = (state.idempotencyKeys ?? []).filter((entry) => new Date(entry.expires_at) > now).slice(-5000);
}

function stripVolatileRequestFields(value) {
  if (Array.isArray(value)) return value.map(stripVolatileRequestFields);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "request_id" || key === "idempotency_key") continue;
    result[key] = stripVolatileRequestFields(entry);
  }
  return result;
}

function sanitizeRequestId(value) {
  const clean = String(value ?? "").trim();
  if (!clean) return "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clean)) {
    throw guardedError(400, "REQUEST_ID_INVALID", "request_id must be 8-128 safe characters.");
  }
  return clean;
}

function hashText(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function guardedError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, details);
  return error;
}
