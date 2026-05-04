import { RedisConnection, connectRedisSocket } from "../realtime/bus.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";

export function createDistributedRequestGuard(env = process.env, options = {}) {
  const provider = env.CODEX_PET_REQUEST_GUARD || "local";
  if (provider === "local") return new LocalRequestGuard(env);
  if (provider === "redis") return new RedisRequestGuard(env, options.connect);
  throw new Error(`Unsupported CODEX_PET_REQUEST_GUARD: ${provider}`);
}

export class LocalRequestGuard {
  constructor(env = process.env) {
    this.provider = "local";
    this.namespace = env.CODEX_PET_REQUEST_GUARD_NAMESPACE || "codex-pet-league";
  }

  async enforce() {
    return { provider: this.provider, enforced: false };
  }

  status() {
    return {
      provider: this.provider,
      namespace: this.namespace,
      connected: true,
    };
  }

  async close() {}
}

export class RedisRequestGuard {
  constructor(env = process.env, connect = connectRedisSocket) {
    this.provider = "redis";
    this.namespace = env.CODEX_PET_REQUEST_GUARD_NAMESPACE || "codex-pet-league";
    this.url = env.CODEX_PET_REDIS_URL || DEFAULT_REDIS_URL;
    this.connect = connect;
    this.connection = null;
    this.connected = false;
  }

  async enforce(input) {
    const connection = await this.redis();
    await enforceRedisRateLimit(connection, this.rateKey(input), input.policy, input.now, input.routeKey);
    if (!input.requestId) return { provider: this.provider, enforced: true };
    await enforceRedisIdempotency(connection, this.idempotencyKey(input), input.bodyHash, input.routeKey);
    return { provider: this.provider, enforced: true };
  }

  status() {
    return {
      provider: this.provider,
      namespace: this.namespace,
      connected: this.connected,
      redis_url: redactRedisUrl(this.url),
    };
  }

  async close() {
    this.connection?.close();
    this.connection = null;
    this.connected = false;
  }

  async redis() {
    if (this.connection) return this.connection;
    this.connection = new RedisConnection(this.url, this.connect);
    await this.connection.open();
    await this.connection.command("PING");
    this.connected = true;
    return this.connection;
  }

  rateKey(input) {
    return `${this.namespace}:guard:rate:${input.routeKey}:${input.actorHash}`;
  }

  idempotencyKey(input) {
    return `${this.namespace}:guard:idempotency:${input.routeKey}:${input.actorHash}:${input.requestId}`;
  }
}

async function enforceRedisRateLimit(redis, key, policy, now, routeKey) {
  const count = Number(await redis.command("INCR", key));
  if (count === 1) await redis.command("PEXPIRE", key, String(policy.windowMs));
  if (count <= policy.limit) return;

  const ttlMs = Number(await redis.command("PTTL", key));
  throw guardedError(429, "RATE_LIMITED", `Too many ${routeKey} requests. Retry later.`, {
    retry_after_seconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : policy.windowMs) / 1000)),
    count,
    limit: policy.limit,
    checked_at: now.toISOString(),
  });
}

async function enforceRedisIdempotency(redis, key, bodyHash, routeKey) {
  const setResult = await redis.command("SET", key, bodyHash, "NX", "PX", String(DAY_MS));
  if (setResult === "OK") return;

  const existingHash = await redis.command("GET", key);
  if (existingHash !== bodyHash) {
    throw guardedError(409, "IDEMPOTENCY_KEY_CONFLICT", "This request_id was already used with different request content.", {
      route_key: routeKey,
    });
  }
  throw guardedError(409, "REQUEST_REPLAYED", "This request_id was already used.", { route_key: routeKey });
}

function guardedError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, details);
  return error;
}

function redactRedisUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "REDACTED";
    return url.toString();
  } catch {
    return "invalid";
  }
}
