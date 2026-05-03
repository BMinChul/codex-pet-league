const port = process.env.PORT || 4317;
const baseUrl = process.env.CODEX_PET_HEALTHCHECK_URL || `http://127.0.0.1:${port}`;

try {
  const response = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(Number(process.env.CODEX_PET_HEALTHCHECK_TIMEOUT_MS ?? 4000)),
  });
  const payload = await response.json();
  if (!response.ok || payload.status !== "ok") {
    console.error(`healthcheck failed: ${response.status} ${JSON.stringify(payload)}`);
    process.exit(1);
  }
  console.log("healthcheck ok");
} catch (error) {
  console.error(`healthcheck failed: ${error.message}`);
  process.exit(1);
}
