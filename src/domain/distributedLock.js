import { randomUUID } from "node:crypto";
import { RedisConnection, connectRedisSocket } from "../realtime/bus.js";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const DEFAULT_LOCK_TTL_MS = 30_000;

export function createDistributedLockManager(env = process.env, options = {}) {
  const provider = env.CODEX_PET_DISTRIBUTED_LOCK || "local";
  if (provider === "local") return new LocalDistributedLockManager(env);
  if (provider === "redis") return new RedisDistributedLockManager(env, options.connect);
  throw new Error(`Unsupported CODEX_PET_DISTRIBUTED_LOCK: ${provider}`);
}

export class LocalDistributedLockManager {
  constructor(env = process.env) {
    this.provider = "local";
    this.namespace = env.CODEX_PET_LOCK_NAMESPACE || "codex-pet-league";
    this.defaultTtlMs = lockTtlMs(env);
    this.locks = new Map();
  }

  async acquire(name, options = {}) {
    const ttlMs = ttlFor(options, this.defaultTtlMs);
    const key = this.key(name);
    const now = Date.now();
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > now) return localLease(false, this, key, name, "", existing.expiresAt);

    const token = randomUUID();
    const expiresAt = now + ttlMs;
    this.locks.set(key, { token, expiresAt });
    return localLease(true, this, key, name, token, expiresAt);
  }

  release(key, token) {
    const existing = this.locks.get(key);
    if (existing?.token === token) this.locks.delete(key);
  }

  status() {
    this.prune();
    return {
      provider: this.provider,
      namespace: this.namespace,
      connected: true,
      active_locks: this.locks.size,
      default_ttl_ms: this.defaultTtlMs,
    };
  }

  async close() {
    this.locks.clear();
  }

  key(name) {
    return `${this.namespace}:lock:${name}`;
  }

  prune() {
    const now = Date.now();
    for (const [key, lock] of this.locks.entries()) {
      if (lock.expiresAt <= now) this.locks.delete(key);
    }
  }
}

export class RedisDistributedLockManager {
  constructor(env = process.env, connect = connectRedisSocket) {
    this.provider = "redis";
    this.namespace = env.CODEX_PET_LOCK_NAMESPACE || "codex-pet-league";
    this.url = env.CODEX_PET_REDIS_URL || DEFAULT_REDIS_URL;
    this.defaultTtlMs = lockTtlMs(env);
    this.connect = connect;
    this.connection = null;
    this.connected = false;
  }

  async acquire(name, options = {}) {
    const ttlMs = ttlFor(options, this.defaultTtlMs);
    const key = this.key(name);
    const token = randomUUID();
    const redis = await this.redis();
    const result = await redis.command("SET", key, token, "NX", "PX", String(ttlMs));
    if (result !== "OK") return redisLease(false, this, key, name, "", ttlMs);
    return redisLease(true, this, key, name, token, ttlMs);
  }

  async release(key, token) {
    if (!token) return;
    const redis = await this.redis();
    await redis.command(
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      key,
      token,
    );
  }

  status() {
    return {
      provider: this.provider,
      namespace: this.namespace,
      connected: this.connected,
      redis_url: redactRedisUrl(this.url),
      default_ttl_ms: this.defaultTtlMs,
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

  key(name) {
    return `${this.namespace}:lock:${name}`;
  }
}

function localLease(acquired, manager, key, name, token, expiresAt) {
  return {
    acquired,
    provider: manager.provider,
    name,
    key,
    token,
    expires_at: new Date(expiresAt).toISOString(),
    release: async () => manager.release(key, token),
  };
}

function redisLease(acquired, manager, key, name, token, ttlMs) {
  return {
    acquired,
    provider: manager.provider,
    name,
    key,
    token,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    release: async () => manager.release(key, token),
  };
}

function ttlFor(options, fallback) {
  const value = Number(options.ttlMs ?? fallback);
  return Number.isInteger(value) && value >= 1_000 ? value : fallback;
}

function lockTtlMs(env) {
  const value = Number(env.CODEX_PET_LOCK_TTL_MS ?? DEFAULT_LOCK_TTL_MS);
  return Number.isInteger(value) && value >= 1_000 ? value : DEFAULT_LOCK_TTL_MS;
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
