import { spawn, spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

await main();

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "codexpet-smoke-"));
  try {
    await runOfficialRuntimeSmoke(tempRoot);
    await runHiddenAuthCodeSmoke(tempRoot);
    console.log("runtime smoke ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runOfficialRuntimeSmoke(tempRoot) {
  const port = randomPort();
  const baseUrl = `http://localhost:${port}`;
  await withServer(
    {
      port,
      statePath: join(tempRoot, "official-state.json"),
      logPrefix: join(tempRoot, "official"),
      env: {
        CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER: "false",
        CODEX_PET_AUTH_DEV_CODE: "true",
      },
    },
    async () => {
      const blocked = await requestRejected(baseUrl, "/api/session", { expectedStatus: 401 });
      assert(blocked, "strict auth mode did not reject unauthenticated /api/session");

      const clientA = { "x-forwarded-for": "198.51.100.10", "x-league-device-id": "runtime-smoke-device-alpha" };
      const clientB = { "x-forwarded-for": "198.51.100.20", "x-league-device-id": "runtime-smoke-device-beta" };
      const clientCookie = { "x-forwarded-for": "198.51.100.30", "x-league-device-id": "runtime-smoke-device-cookie" };
      const sessionA = await newLeagueSession(baseUrl, "demo@codexpet.local", "email_magic_link", clientA);
      const sessionB = await newLeagueSession(baseUrl, "smoke-b@example.test", "league_oauth", clientB);
      const cookieSession = await newLeagueSessionWithCookie(baseUrl, "cookie@example.test", "email_magic_link", clientCookie);
      const headersA = { "x-league-session-token": sessionA.session_token, ...clientA };
      const headersB = { "x-league-session-token": sessionB.session_token, ...clientB };

      const account = await getJson(baseUrl, "/api/session", headersA);
      assert(account.account?.id === sessionA.account.id, "session endpoint returned the wrong account");
      const cookieAccount = await getJson(baseUrl, "/api/session", { cookie: cookieSession.cookie });
      assert(cookieAccount.account?.id === cookieSession.payload.account.id, "cookie session did not authenticate");
      await assertSseReady(baseUrl, cookieSession.cookie);

      const petA = await createSmokePet(baseUrl, headersA, "Smoke Alpha", "Forge", "Pulse");
      const petB = await createSmokePet(baseUrl, headersB, "Smoke Beta", "Forge", "Pulse");

      const loadout = await putJson(
        baseUrl,
        `/api/pets/${petA.id}/loadout`,
        {
          skills: ["forge_offense", "forge_defense", "forge_status", "pulse_offense"],
          aliases: { forge_offense: "Hammer Check" },
        },
        headersA,
      );
      assert(loadout.pet.skills.length === 4, "loadout did not persist exactly four skills");

      const report = await postJson(
        baseUrl,
        `/api/pets/${petA.id}/training-reports`,
        {
          client_report_id: "runtime-smoke-risk",
          signals: { testsRun: 99, milestone: true, filesChangedBucket: "small" },
        },
        headersA,
      );
      assert(report.report.status === "review", "risky Training Report was not held for review");
      assert(report.report.pet_xp_delta === 0, "review-held Training Report awarded pet XP");

      await postJson(baseUrl, `/api/pets/${petA.id}/matchmaking/queue`, { mode: "ranked" }, headersA);
      const match = await postJson(baseUrl, `/api/pets/${petB.id}/matchmaking/queue`, { mode: "ranked" }, headersB);
      assert(match.status === "matched", "ranked queue did not match compatible pets");
      assert(match.battle.source === "random_matchmaking", "ranked match was not official random matchmaking");

      const battle = match.battle;
      await postJson(
        baseUrl,
        `/api/battles/${battle.id}/actions`,
        { kind: "strike", turn_index: battle.turn_index, turn_nonce: battle.turn_nonce },
        headersA,
      );
      const actionB = await postJson(
        baseUrl,
        `/api/battles/${battle.id}/actions`,
        { kind: "guard", turn_index: battle.turn_index, turn_nonce: battle.turn_nonce },
        headersB,
      );
      assert(actionB.battle.turn_index >= 2, "turn did not resolve after both player actions");

      const profile = await getJson(baseUrl, `/api/public/pets/${petA.id}`, headersA);
      assert(profile.pet.id === petA.id, "public profile returned the wrong pet");

      const replays = await getJson(baseUrl, `/api/pets/${petA.id}/replays`, headersA);
      assert(Array.isArray(replays.replays), "replay endpoint did not return a replay list");

      const audit = await getJson(baseUrl, "/api/admin/audit", headersA);
      assert(audit.ok === true, `audit failed: ${JSON.stringify(audit.findings)}`);
      const adminConsole = await getJson(baseUrl, "/api/admin/console", headersA);
      assert(adminConsole.ops, "admin console did not return ops status");
      const opsJob = await postJson(baseUrl, "/api/admin/ops/run", {}, headersA);
      assert(opsJob.job?.id, "manual ops job did not return a job id");
      const providers = await getJson(baseUrl, "/api/auth/providers", {});
      assert(providers.provider, "auth provider status did not return a provider");
      const bridge = await getJson(baseUrl, "/api/bridge/status", {});
      assert(bridge.official_openai_identity === "unconfirmed", "bridge status changed unexpectedly");
      const health = await getJson(baseUrl, "/api/health", {});
      assert(health.status === "ok", "health endpoint did not return ok");
      const metrics = await getText(baseUrl, "/api/metrics", {});
      assert(metrics.includes("codex_pet_uptime_seconds"), "metrics endpoint did not expose uptime");

      runCli("session", baseUrl, sessionA.session_token);
      runCli("home", baseUrl, sessionA.session_token);
      runCli("daily", baseUrl, sessionA.session_token);
      runCli("next", baseUrl, sessionA.session_token);
      runCli(["battle", "actions", "--battle", battle.id], baseUrl, sessionA.session_token);
      runCli(["battle", "watch", "--battle", battle.id, "--once"], baseUrl, sessionA.session_token);
      runCli(["battle", "play", "--battle", battle.id, "--auto"], baseUrl, sessionA.session_token);
      runCli("audit", baseUrl, sessionA.session_token);
    },
  );
}

async function runHiddenAuthCodeSmoke(tempRoot) {
  const port = randomPort();
  const baseUrl = `http://localhost:${port}`;
  await withServer(
    {
      port,
      statePath: join(tempRoot, "hidden-auth-state.json"),
      logPrefix: join(tempRoot, "hidden-auth"),
      env: {
        CODEX_PET_AUTH_DEV_CODE: "false",
      },
    },
    async () => {
      const challenge = await postJson(baseUrl, "/api/auth/challenge", {
        method: "email_magic_link",
        identifier: "hidden@example.test",
      });
      assert(challenge.challenge_id, "hidden auth challenge did not return an id");
      assert(!Object.hasOwn(challenge, "dev_code"), "dev_code was exposed with CODEX_PET_AUTH_DEV_CODE=false");
    },
  );
}

async function withServer(options, fn) {
  const child = spawn(process.execPath, ["src/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
      CODEX_PET_STATE_PATH: options.statePath,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  try {
    await waitForServer(`http://localhost:${options.port}/`);
    await fn();
  } catch (error) {
    const out = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    throw new Error(`${error.message}\nserver stdout:\n${out}\nserver stderr:\n${err}`);
  } finally {
    child.kill();
  }
}

async function waitForServer(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry until deadline
    }
    await sleep(150);
  }
  throw new Error(`server did not become ready at ${url}`);
}

async function newLeagueSession(baseUrl, identifier, method, headers = {}) {
  const challenge = await postJson(baseUrl, "/api/auth/challenge", { method, identifier }, headers);
  return postJson(baseUrl, "/api/auth/verify", {
    challenge_id: challenge.challenge_id,
    code: challenge.dev_code,
  }, headers);
}

async function newLeagueSessionWithCookie(baseUrl, identifier, method, headers = {}) {
  const challenge = await postJson(baseUrl, "/api/auth/challenge", { method, identifier }, headers);
  const response = await requestJsonWithHeaders(baseUrl, "/api/auth/verify", {
    method: "POST",
    headers,
    body: {
      challenge_id: challenge.challenge_id,
      code: challenge.dev_code,
    },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert(cookie.startsWith("league_session="), "auth verify did not set a League session cookie");
  return { payload: response.payload, cookie };
}

async function createSmokePet(baseUrl, headers, name, primary, secondary) {
  const asset = await postJson(
    baseUrl,
    "/api/pet-assets/uploads",
    { appearance: { source: "runtime_smoke", name } },
    headers,
  );
  const pet = await postJson(
    baseUrl,
    "/api/pets",
    {
      name,
      pet_asset_id: asset.asset.id,
      primary_element: primary,
      secondary_element: secondary,
    },
    headers,
  );
  return pet.pet;
}

async function getJson(baseUrl, path, headers = {}) {
  return requestJson(baseUrl, path, { method: "GET", headers });
}

async function getText(baseUrl, path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${text}`);
  return text;
}

async function postJson(baseUrl, path, body, headers = {}) {
  return requestJson(baseUrl, path, { method: "POST", body, headers });
}

async function putJson(baseUrl, path, body, headers = {}) {
  return requestJson(baseUrl, path, { method: "PUT", body, headers });
}

async function requestJson(baseUrl, path, options) {
  return (await requestJsonWithHeaders(baseUrl, path, options)).payload;
}

async function requestJsonWithHeaders(baseUrl, path, options) {
  const body =
    options.body && ["POST", "PUT", "PATCH"].includes(options.method)
      ? { ...options.body, request_id: options.body.request_id ?? randomUUID() }
      : options.body;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "content-type": "application/json", ...options.headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return { payload, headers: response.headers };
}

async function requestRejected(baseUrl, path, { expectedStatus }) {
  const response = await fetch(`${baseUrl}${path}`);
  await response.text();
  return response.status === expectedStatus;
}

async function assertSseReady(baseUrl, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/live`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert(response.ok, `SSE live endpoint rejected cookie auth with ${response.status}`);
  const reader = response.body.getReader();
  try {
    const firstChunk = await Promise.race([
      reader.read(),
      sleep(1000).then(() => {
        throw new Error("SSE live endpoint did not send ready event");
      }),
    ]);
    const text = new TextDecoder().decode(firstChunk.value ?? new Uint8Array());
    assert(text.includes("event: ready"), "SSE live endpoint did not send ready event");
  } finally {
    controller.abort();
  }
}

function runCli(command, baseUrl, sessionToken) {
  const args = Array.isArray(command) ? command : [command];
  const result = spawnSync(process.execPath, ["src/cli/index.js", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_PET_LEAGUE_URL: baseUrl,
      CODEX_PET_SESSION_TOKEN: sessionToken,
    },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`CLI ${command} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function randomPort() {
  return randomInt(44_000, 49_000);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
