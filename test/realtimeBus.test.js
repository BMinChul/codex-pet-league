import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { createRealtimeBus, encodeRedisCommand } from "../src/realtime/bus.js";

test("local realtime bus fans events out to subscribers", async () => {
  const bus = createRealtimeBus({ CODEX_PET_REALTIME_BUS: "local" });
  const received = [];
  await bus.start((event) => received.push(event));
  const event = await bus.publish("test.event", { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bus.status().provider, "local");
  assert.equal(received[0].id, event.id);
  assert.deepEqual(received[0].payload, { ok: true });
});

test("Redis command encoding uses RESP arrays", () => {
  assert.equal(encodeRedisCommand(["PING"]).toString("utf8"), "*1\r\n$4\r\nPING\r\n");
  assert.equal(encodeRedisCommand(["PUBLISH", "room", "hello"]).toString("utf8"), "*3\r\n$7\r\nPUBLISH\r\n$4\r\nroom\r\n$5\r\nhello\r\n");
});

test("redis realtime bus publishes through a Redis-compatible socket", async () => {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("PING")) socket.write("+PONG\r\n");
      if (text.includes("PUBLISH")) socket.write(":1\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const bus = createRealtimeBus({
      CODEX_PET_REALTIME_BUS: "redis",
      CODEX_PET_REDIS_URL: `redis://127.0.0.1:${port}/0`,
      CODEX_PET_REALTIME_CHANNEL: "codex-pet-test",
    });
    try {
      const event = await bus.publish("test.event", { ok: true });
      assert.equal(event.type, "test.event");
      assert.equal(bus.status().provider, "redis");
    } finally {
      await bus.close();
    }
  } finally {
    server.close();
  }
});

test("redis realtime bus subscribes to Redis-compatible fanout messages", async () => {
  const channel = "codex-pet-test";
  let subSocket;
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("SUBSCRIBE")) {
        subSocket = socket;
        socket.write(encodeRedisCommand(["subscribe", channel, "1"]));
      }
      if (text.includes("PING")) socket.write("+PONG\r\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  try {
    const bus = createRealtimeBus({
      CODEX_PET_REALTIME_BUS: "redis",
      CODEX_PET_REDIS_URL: `redis://127.0.0.1:${port}/0`,
      CODEX_PET_REALTIME_CHANNEL: channel,
    });
    const received = onceEvent(bus);
    try {
      await bus.start((event) => received.resolve(event));
      subSocket.write(encodeRedisCommand(["message", channel, JSON.stringify({ type: "fanout", payload: { ok: true } })]));
      const event = await received.promise;
      assert.equal(event.type, "fanout");
      assert.deepEqual(event.payload, { ok: true });
      assert.equal(bus.status().connected, true);
    } finally {
      await bus.close();
    }
  } finally {
    server.close();
  }
});

function onceEvent() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
