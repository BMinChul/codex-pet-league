const checks = [
  ["CODEX_PET_AUTH_PROVIDER", process.env.CODEX_PET_AUTH_PROVIDER ?? "local_dev"],
  ["CODEX_PET_AUTH_DEV_CODE", process.env.CODEX_PET_AUTH_DEV_CODE ?? "false"],
  ["CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER", process.env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER ?? "false"],
  ["CODEX_PET_BRIDGE_SECRET", process.env.CODEX_PET_BRIDGE_SECRET ? "configured" : "missing"],
  ["CODEX_PET_BRIDGE_ATTESTATION_SECRET", process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET ? "configured" : "missing"],
  ["CODEX_PET_REPLAY_SIGNING_SECRET", process.env.CODEX_PET_REPLAY_SIGNING_SECRET ? "configured" : "local_dev"],
  ["CODEX_PET_STATE_PATH", process.env.CODEX_PET_STATE_PATH ?? "data/league-state.json"],
];

for (const [name, value] of checks) {
  console.log(`${name}=${value}`);
}

if (process.env.CODEX_PET_AUTH_DEV_CODE === "true") {
  console.log("warning: dev auth codes are exposed; keep this off outside local testing");
}

if (process.env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER === "true") {
  console.log("warning: dev account header fallback is enabled; keep this off outside local testing");
}
