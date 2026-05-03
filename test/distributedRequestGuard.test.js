import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect as netConnect } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createDistributedRequestGuard } from "../src/domain/distributedRequestGuard.js";
import { hashRequestBody } from "../src/domain/antiCheat.js";

test("redis request guard rejects idempotency replays across guard instances", async () => {
  const redis = await startFakeRedis();
  const input = requestInput({
    routeKey: "battle.action",
    requestId: "req_shared_123",
    bodyHash: hashRequestBody({ kind: "strike" }),
  });

  try {
    const first = createDistributedRequestGuard(redis.env(), { connect: redis.connect });
    const second = createDistributedRequestGuard(redis.env(), { connect: redis.connect });
    try {
      await first.enforce(input);
      await assert.rejects(() => second.enforce(input), /already used/);
    } finally {
      await first.close();
      await second.close();
    }
  } finally {
    await redis.close();
  }
});

test("redis request guard shares rate limit buckets across instances", async () => {
  const redis = await startFakeRedis();
  const input = requestInput({
    routeKey: "auth.challenge",
    requestId: "",
    bodyHash: hashRequestBody({ identifier: "same@example.test" }),
  });

  try {
    const guards = Array.from({ length: 6 }, () => createDistributedRequestGuard(redis.env(), { connect: redis.connect }));
    try {
      for (let index = 0; index < 5; index += 1) await guards[index].enforce(input);
      await assert.rejects(() => guards[5].enforce(input), /Too many auth.challenge/);
    } finally {
      await Promise.all(guards.map((guard) => guard.close()));
    }
  } finally {
    await redis.close();
  }
});

async function startFakeRedis() {
  const counters = new Map();
  const values = new Map();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.offset);
        socket.write(handleRedisCommand(parsed.parts, counters, values));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    connect: (options) => netConnect(options),
    env: () => ({
      CODEX_PET_REQUEST_GUARD: "redis",
      CODEX_PET_REDIS_URL: `redis://127.0.0.1:${port}/0`,
      CODEX_PET_REQUEST_GUARD_NAMESPACE: "codex-pet-test",
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function requestInput({ routeKey, requestId, bodyHash }) {
  const actorHash = createHash("sha256").update("account:acct_demo").digest("hex");
  const policies = {
    "auth.challenge": { limit: 5, windowMs: 15 * 60 * 1000, score: 25 },
    "battle.action": { limit: 90, windowMs: 60 * 1000, score: 20 },
  };
  return {
    accountId: "acct_demo",
    actorHash,
    routeKey,
    policy: policies[routeKey],
    now: new Date("2026-05-03T00:00:00.000Z"),
    requestId,
    bodyHash,
    required: Boolean(requestId),
  };
}

function handleRedisCommand(parts, counters, values) {
  const command = parts[0]?.toUpperCase();
  if (command === "PING") return simple("PONG");
  if (command === "INCR") {
    const key = parts[1];
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    return integer(count);
  }
  if (command === "PEXPIRE") return integer(1);
  if (command === "PTTL") return integer(60_000);
  if (command === "SET") {
    const [key, value] = [parts[1], parts[2]];
    if (values.has(key)) return nullBulk();
    values.set(key, value);
    return simple("OK");
  }
  if (command === "GET") {
    const value = values.get(parts[1]);
    return value ? bulk(value) : nullBulk();
  }
  return simple("OK");
}

function parseCommand(buffer, offset = 0) {
  if (buffer[offset] !== 42) return null;
  const header = parseLine(buffer, offset);
  if (!header) return null;
  const count = Number(header.value);
  let next = header.offset;
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const sizeLine = parseLine(buffer, next);
    if (!sizeLine) return null;
    const size = Number(sizeLine.value);
    const start = sizeLine.offset;
    const end = start + size;
    if (buffer.length < end + 2) return null;
    parts.push(buffer.subarray(start, end).toString("utf8"));
    next = end + 2;
  }
  return { parts, offset: next };
}

function parseLine(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return null;
  return { value: buffer.subarray(offset + 1, end).toString("utf8"), offset: end + 2 };
}

function simple(value) {
  return Buffer.from(`+${value}\r\n`);
}

function integer(value) {
  return Buffer.from(`:${value}\r\n`);
}

function bulk(value) {
  return Buffer.from(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
}

function nullBulk() {
  return Buffer.from("$-1\r\n");
}
