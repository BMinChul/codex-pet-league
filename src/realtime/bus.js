import { connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";

export function createRealtimeBus(env = process.env, options = {}) {
  const provider = env.CODEX_PET_REALTIME_BUS || "local";
  if (provider === "local") return new LocalRealtimeBus(env);
  if (provider === "redis") return new RedisRealtimeBus(env, options.connect ?? netConnect);
  throw new Error(`Unsupported CODEX_PET_REALTIME_BUS: ${provider}`);
}

export class LocalRealtimeBus {
  constructor(env = process.env) {
    this.provider = "local";
    this.channel = env.CODEX_PET_REALTIME_CHANNEL || "codex-pet-league:events";
    this.handlers = new Set();
    this.started = false;
  }

  async start(handler) {
    this.handlers.add(handler);
    this.started = true;
    return this.status();
  }

  async publish(type, payload) {
    const event = realtimeEvent(type, payload);
    for (const handler of this.handlers) queueMicrotask(() => handler(event));
    return event;
  }

  status() {
    return {
      provider: this.provider,
      channel: this.channel,
      connected: this.started,
    };
  }

  async close() {
    this.handlers.clear();
    this.started = false;
  }
}

export class RedisRealtimeBus {
  constructor(env = process.env, connect = netConnect) {
    this.provider = "redis";
    this.channel = env.CODEX_PET_REALTIME_CHANNEL || "codex-pet-league:events";
    this.url = env.CODEX_PET_REDIS_URL || "redis://127.0.0.1:6379/0";
    this.connect = connect;
    this.pub = null;
    this.sub = null;
    this.started = false;
  }

  async start(handler) {
    this.sub = new RedisConnection(this.url, this.connect);
    await this.sub.open();
    this.sub.onPush((message) => {
      if (message.kind !== "message" || message.channel !== this.channel) return;
      try {
        handler(JSON.parse(message.payload));
      } catch (error) {
        console.error(`redis realtime message ignored: ${error.message}`);
      }
    });
    await this.sub.command("SUBSCRIBE", this.channel);

    this.pub = new RedisConnection(this.url, this.connect);
    await this.pub.open();
    await this.pub.command("PING");
    this.started = true;
    return this.status();
  }

  async publish(type, payload) {
    if (!this.pub) {
      this.pub = new RedisConnection(this.url, this.connect);
      await this.pub.open();
    }
    const event = realtimeEvent(type, payload);
    await this.pub.command("PUBLISH", this.channel, JSON.stringify(event));
    return event;
  }

  status() {
    return {
      provider: this.provider,
      channel: this.channel,
      connected: this.started,
      redis_url: redactRedisUrl(this.url),
    };
  }

  async close() {
    this.pub?.close();
    this.sub?.close();
    this.pub = null;
    this.sub = null;
    this.started = false;
  }
}

class RedisConnection {
  constructor(url, connect) {
    this.url = new URL(url);
    this.connect = connect;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.pushHandler = null;
  }

  async open() {
    if (this.socket) return;
    this.socket = this.connect({
      host: this.url.hostname,
      port: Number(this.url.port || 6379),
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.rejectPending(error));
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    if (this.url.password) await this.command("AUTH", this.url.username || "default", this.url.password);
    const db = Number(this.url.pathname.replace("/", "") || 0);
    if (db) await this.command("SELECT", String(db));
  }

  command(...parts) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeRedisCommand(parts));
    });
  }

  onPush(handler) {
    this.pushHandler = handler;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const parsed = parseResp(this.buffer);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.offset);
      this.handleValue(parsed.value);
    }
  }

  handleValue(value) {
    if (value instanceof Error) {
      const pending = this.pending.shift();
      if (pending) pending.reject(value);
      else console.error(value.message);
      return;
    }
    if (isRedisPush(value)) {
      const [kind, channel, payload] = value;
      this.pushHandler?.({ kind, channel, payload });
      if (kind === "subscribe" && this.pending.length) this.pending.shift().resolve(value);
      return;
    }
    const pending = this.pending.shift();
    if (pending) pending.resolve(value);
  }

  rejectPending(error) {
    while (this.pending.length) this.pending.shift().reject(error);
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.rejectPending(new Error("Redis connection closed."));
  }
}

export function encodeRedisCommand(parts) {
  const chunks = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    chunks.push(`$${value.length}\r\n`, value, "\r\n");
  }
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  if (prefix === "+") return parseLine(buffer, offset, (line) => line);
  if (prefix === "-") return parseLine(buffer, offset, (line) => new Error(line));
  if (prefix === ":") return parseLine(buffer, offset, (line) => Number(line));
  if (prefix === "$") return parseBulk(buffer, offset);
  if (prefix === "*") return parseArray(buffer, offset);
  throw new Error(`Unsupported Redis RESP prefix: ${prefix}`);
}

function parseLine(buffer, offset, map) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return null;
  const line = buffer.subarray(offset + 1, end).toString("utf8");
  return { value: map(line), offset: end + 2 };
}

function parseBulk(buffer, offset) {
  const header = parseLine(buffer, offset, Number);
  if (!header) return null;
  if (header.value < 0) return { value: null, offset: header.offset };
  const end = header.offset + header.value;
  if (buffer.length < end + 2) return null;
  return {
    value: buffer.subarray(header.offset, end).toString("utf8"),
    offset: end + 2,
  };
}

function parseArray(buffer, offset) {
  const header = parseLine(buffer, offset, Number);
  if (!header) return null;
  let nextOffset = header.offset;
  const values = [];
  for (let index = 0; index < header.value; index += 1) {
    const parsed = parseResp(buffer, nextOffset);
    if (!parsed) return null;
    values.push(parsed.value);
    nextOffset = parsed.offset;
  }
  return { value: values, offset: nextOffset };
}

function isRedisPush(value) {
  return Array.isArray(value) && ["message", "subscribe"].includes(value[0]);
}

function realtimeEvent(type, payload) {
  return {
    id: `evt_${randomUUID()}`,
    type,
    payload,
    created_at: new Date().toISOString(),
  };
}

function redactRedisUrl(value) {
  const url = new URL(value);
  if (url.password) url.password = "REDACTED";
  return url.toString();
}
