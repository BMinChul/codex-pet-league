import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "codexpet-load-"));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["src/server/index.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    CODEX_PET_STATE_PATH: join(tempRoot, "league-state.json"),
    CODEX_PET_AUTH_DEV_CODE: "true",
    CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const logs = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => logs.push(`stdout: ${chunk.trim()}`));
child.stderr.on("data", (chunk) => logs.push(`stderr: ${chunk.trim()}`));

try {
  await waitForServer();
  await assertSecurityHeaders();

  const sessionTimings = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      timed(() =>
        createSession(`load-${index}@example.test`, {
          "x-forwarded-for": `198.51.100.${index + 1}`,
          "x-league-device-id": `load-smoke-device-${String(index).padStart(2, "0")}`,
        }),
      ),
    ),
  );
  assert(sessionTimings.every((entry) => entry.result.session_token), "all load users should receive sessions");

  const readTimings = await Promise.all(
    Array.from({ length: 90 }, (_, index) =>
      timed(() => get(index % 3 === 0 ? "/api/health" : index % 3 === 1 ? "/api/rules" : "/api/metrics")),
    ),
  );
  const p95 = percentile([...sessionTimings, ...readTimings].map((entry) => entry.ms), 0.95);
  assert(p95 < 5000, `load smoke p95 too slow: ${p95}ms`);
  console.log(`load smoke ok p95=${Math.round(p95)}ms requests=${sessionTimings.length * 2 + readTimings.length}`);
} finally {
  child.kill();
  await rm(tempRoot, { recursive: true, force: true });
}

async function createSession(identifier, headers) {
  const challenge = await post("/api/auth/challenge", { method: "email_magic_link", identifier }, headers);
  return post("/api/auth/verify", { challenge_id: challenge.challenge_id, code: challenge.dev_code }, headers);
}

async function assertSecurityHeaders() {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  await response.arrayBuffer();
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${text}`);
  return text;
}

async function post(path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.join("\n")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`server did not start:\n${logs.join("\n")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}
