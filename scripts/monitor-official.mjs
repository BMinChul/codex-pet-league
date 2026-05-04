const DEFAULT_BASE_URL = "https://league.codexpetz.com";
const BASE_URL = (process.env.CODEX_PET_MONITOR_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.CODEX_PET_MONITOR_TIMEOUT_MS ?? 10_000);
const FAIL_ON_OPEN_ALERTS = process.env.CODEX_PET_MONITOR_FAIL_ON_ALERTS === "true";

await main();

async function main() {
  const startedAt = new Date().toISOString();
  const health = await getJson("/api/health");
  assert(health.status === "ok", `health status is ${health.status ?? "unknown"}`);
  assert(health.storage?.driver === "postgres", `unexpected storage driver ${health.storage?.driver ?? "unknown"}`);
  assert(health.realtime?.provider === "redis", `unexpected realtime provider ${health.realtime?.provider ?? "unknown"}`);
  assert(health.request_guard?.provider === "redis", `unexpected request guard ${health.request_guard?.provider ?? "unknown"}`);
  assert(health.locks?.provider === "redis", `unexpected lock provider ${health.locks?.provider ?? "unknown"}`);

  const metrics = await getText("/api/metrics");
  assert(metrics.includes("codex_pet_uptime_seconds"), "metrics missing uptime gauge");
  assert(metrics.includes("codex_pet_abuse_alerts_total"), "metrics missing abuse alert gauge");

  await assertPage("/status", "League Status");
  await assertPage("/support", "support@codexpetz.com");
  await assertPage("/privacy", "Privacy Notice");
  await assertPage("/terms", "Alpha Terms");

  const openAlerts = Number(health.counts?.abuse_alerts ?? 0);
  if (FAIL_ON_OPEN_ALERTS && openAlerts > 0) {
    throw new Error(`open abuse alerts: ${openAlerts}`);
  }

  console.log(JSON.stringify({
    status: "ok",
    base_url: BASE_URL,
    checked_at: startedAt,
    storage: health.storage?.driver,
    realtime: health.realtime?.provider,
    request_guard: health.request_guard?.provider,
    locks: health.locks?.provider,
    counts: {
      accounts: health.counts?.accounts ?? 0,
      pets: health.counts?.pets ?? 0,
      active_battles: health.counts?.active_battles ?? 0,
      match_tickets: health.counts?.match_tickets ?? 0,
      held_training_reports: health.counts?.held_training_reports ?? 0,
      abuse_alerts: openAlerts,
    },
  }, null, 2));
}

async function assertPage(path, expectedText) {
  const body = await getText(path);
  assert(body.includes(expectedText), `${path} did not contain ${expectedText}`);
}

async function getJson(path) {
  const text = await getText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return valid JSON`);
  }
}

async function getText(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { "user-agent": "codex-pet-league-official-monitor/1.0" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${text.slice(0, 240)}`);
    }
    return text;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${path} timed out after ${TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
