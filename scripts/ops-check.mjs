const checks = [
  ["CODEX_PET_AUTH_PROVIDER", process.env.CODEX_PET_AUTH_PROVIDER ?? "local_dev"],
  ["CODEX_PET_AUTH_DEV_CODE", process.env.CODEX_PET_AUTH_DEV_CODE ?? "false"],
  ["CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER", process.env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER ?? "false"],
  ["CODEX_PET_EMAIL_PROVIDER", process.env.CODEX_PET_EMAIL_PROVIDER ?? "missing"],
  ["CODEX_PET_EMAIL_WEBHOOK_URL", process.env.CODEX_PET_EMAIL_WEBHOOK_URL ? "configured" : "missing"],
  ["CODEX_PET_PASSKEY_PROVIDER", process.env.CODEX_PET_PASSKEY_PROVIDER ?? "missing"],
  ["CODEX_PET_PASSKEY_VERIFY_URL", process.env.CODEX_PET_PASSKEY_VERIFY_URL ? "configured" : "missing"],
  ["CODEX_PET_OAUTH_ISSUER", process.env.CODEX_PET_OAUTH_ISSUER ?? "missing"],
  ["CODEX_PET_OAUTH_AUTHORIZE_URL", process.env.CODEX_PET_OAUTH_AUTHORIZE_URL ? "configured" : "missing"],
  ["CODEX_PET_OAUTH_VERIFY_URL", process.env.CODEX_PET_OAUTH_VERIFY_URL ? "configured" : "missing"],
  ["CODEX_PET_BRIDGE_SECRET", process.env.CODEX_PET_BRIDGE_SECRET ? "configured" : "missing"],
  ["CODEX_PET_BRIDGE_ATTESTATION_SECRET", process.env.CODEX_PET_BRIDGE_ATTESTATION_SECRET ? "configured" : "missing"],
  ["CODEX_PET_REPLAY_SIGNING_SECRET", process.env.CODEX_PET_REPLAY_SIGNING_SECRET ? "configured" : "local_dev"],
  ["CODEX_PET_STORAGE_DRIVER", process.env.CODEX_PET_STORAGE_DRIVER || "json"],
  ["CODEX_PET_STATE_PATH", process.env.CODEX_PET_STATE_PATH ?? "data/league-state.json"],
  ["CODEX_PET_SQLITE_PATH", process.env.CODEX_PET_SQLITE_PATH ?? "data/league-state.sqlite"],
  ["CODEX_PET_ASSET_STORAGE", process.env.CODEX_PET_ASSET_STORAGE || "local_fs"],
  ["CODEX_PET_ASSET_ROOT", process.env.CODEX_PET_ASSET_ROOT ?? "data/assets"],
  ["CODEX_PET_ASSET_CDN_BASE_URL", process.env.CODEX_PET_ASSET_CDN_BASE_URL ?? "missing"],
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

if ((process.env.CODEX_PET_AUTH_PROVIDER || "local_dev") !== "local_dev") {
  const emailReady = process.env.CODEX_PET_EMAIL_PROVIDER === "webhook" && process.env.CODEX_PET_EMAIL_WEBHOOK_URL;
  const passkeyReady = process.env.CODEX_PET_PASSKEY_PROVIDER === "true" && process.env.CODEX_PET_PASSKEY_VERIFY_URL;
  const oauthReady =
    process.env.CODEX_PET_OAUTH_ISSUER &&
    process.env.CODEX_PET_OAUTH_AUTHORIZE_URL &&
    process.env.CODEX_PET_OAUTH_CLIENT_ID &&
    process.env.CODEX_PET_OAUTH_REDIRECT_URI &&
    process.env.CODEX_PET_OAUTH_VERIFY_URL;
  if (!emailReady && !passkeyReady && !oauthReady) {
    console.error("error: production auth provider is enabled but no real auth method is fully configured");
    process.exitCode = 1;
  }
}
