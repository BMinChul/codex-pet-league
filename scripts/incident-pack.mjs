import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeStorage, loadState, storageStatus } from "../src/storage/jsonStore.js";
import { summarizeCostState, summarizeIncidentState } from "./ops-summary.mjs";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.argv[2] || `runs/incidents/${timestamp}`);
const baseUrl = normalizeBaseUrl(
  process.env.CODEX_PET_INCIDENT_BASE_URL ||
    process.env.CODEX_PET_LEAGUE_URL ||
    process.env.CODEX_PET_PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 4317}`,
);
const files = [];

await mkdir(outputRoot, { recursive: true });

const health = await fetchEndpoint("/api/health", "json");
await writeJson("health.json", health);

const metrics = await fetchEndpoint("/api/metrics", "text");
await writeText("metrics.txt", metrics.ok ? metrics.body : `fetch failed: ${JSON.stringify(metrics, null, 2)}\n`);

try {
  const state = await loadState();
  const stateSummary = summarizeIncidentState(state);
  const costSummary = summarizeCostState(state);
  await writeJson("state-summary.json", stateSummary);
  await writeJson("cost-guard.json", { ...costSummary, storage: storageStatus() });
} catch (error) {
  await writeJson("state-summary.json", { error: error.message });
  await writeJson("cost-guard.json", { error: error.message });
} finally {
  await closeStorage();
}

await writeJson("manifest.json", {
  created_at: new Date().toISOString(),
  base_url: baseUrl,
  output_root: outputRoot,
  files,
  notes: [
    "This pack stores runtime health, metrics, and redacted state summaries only.",
    "It does not include full state snapshots, session tokens, API keys, or provider credentials.",
  ],
});

console.log(`incident pack written: ${outputRoot}`);

async function fetchEndpoint(path, mode) {
  const url = `${baseUrl}${path}`;
  const timeoutMs = envNumber("CODEX_PET_INCIDENT_FETCH_TIMEOUT_MS", 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const bodyText = await response.text();
    const body = mode === "json" ? parseJsonBody(bodyText) : bodyText;
    return {
      ok: response.ok,
      status: response.status,
      status_text: response.statusText,
      url,
      content_type: response.headers.get("content-type") ?? null,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      error: error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function writeJson(name, value) {
  const path = join(outputRoot, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  files.push(path);
}

async function writeText(name, value) {
  const path = join(outputRoot, name);
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  files.push(path);
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function parseJsonBody(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
