import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect as netConnect } from "node:net";
import { once } from "node:events";
import { createDistributedLockManager } from "../src/domain/distributedLock.js";

test("local distributed lock manager serializes same-process leases", async () => {
  const locks = createDistributedLockManager({
    CODEX_PET_DISTRIBUTED_LOCK: "local",
    CODEX_PET_LOCK_NAMESPACE: "codex-pet-test",
    CODEX_PET_LOCK_TTL_MS: "5000",
  });

  const first = await locks.acquire("matchmaking.queue");
  const second = await locks.acquire("matchmaking.queue");
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);

  await first.release();
  const third = await locks.acquire("matchmaking.queue");
  assert.equal(third.acquired, true);
  await third.release();
});

test("redis distributed lock manager shares leases across instances", async () => {
  const redis = await startFakeRedis();
  try {
    const first = createDistributedLockManager(redis.env(), { connect: redis.connect });
    const second = createDistributedLockManager(redis.env(), { connect: redis.connect });
    try {
      const firstLease = await first.acquire("battle.room_1");
      const blocked = await second.acquire("battle.room_1");
      assert.equal(firstLease.acquired, true);
      assert.equal(blocked.acquired, false);

      await firstLease.release();
      const afterRelease = await second.acquire("battle.room_1");
      assert.equal(afterRelease.acquired, true);
      await afterRelease.release();
      assert.equal(first.status().provider, "redis");
    } finally {
      await first.close();
      await second.close();
    }
  } finally {
    await redis.close();
  }
});

async function startFakeRedis() {
  const values = new Map();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.offset);
        socket.write(handleRedisCommand(parsed.parts, values));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    connect: (options) => netConnect(options),
    env: () => ({
      CODEX_PET_DISTRIBUTED_LOCK: "redis",
      CODEX_PET_REDIS_URL: `redis://127.0.0.1:${port}/0`,
      CODEX_PET_LOCK_NAMESPACE: "codex-pet-test",
      CODEX_PET_LOCK_TTL_MS: "5000",
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function handleRedisCommand(parts, values) {
  const command = parts[0]?.toUpperCase();
  if (command === "PING") return simple("PONG");
  if (command === "SET") {
    const [key, value] = [parts[1], parts[2]];
    if (parts.includes("NX") && values.has(key)) return nullBulk();
    values.set(key, value);
    return simple("OK");
  }
  if (command === "GET") {
    const value = values.get(parts[1]);
    return value ? bulk(value) : nullBulk();
  }
  if (command === "DEL") {
    const removed = values.delete(parts[1]);
    return integer(removed ? 1 : 0);
  }
  if (command === "EVAL") {
    const key = parts[3];
    const token = parts[4];
    if (values.get(key) === token) {
      values.delete(key);
      return integer(1);
    }
    return integer(0);
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
