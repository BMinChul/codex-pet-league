import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { authProviderStatus } from "../src/domain/authConfig.js";

const env = process.env;
const deploymentEnv = env.CODEX_PET_DEPLOYMENT_ENV || env.NODE_ENV || "local";
const production = deploymentEnv === "production";
const findings = [];

check("CODEX_PET_AUTH_PROVIDER", env.CODEX_PET_AUTH_PROVIDER || "local_dev");
check("CODEX_PET_AUTH_DEV_CODE", env.CODEX_PET_AUTH_DEV_CODE || "false");
check("CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER", env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER || "false");
check("CODEX_PET_COOKIE_SECURE", env.CODEX_PET_COOKIE_SECURE || "false");
check("CODEX_PET_STORAGE_DRIVER", env.CODEX_PET_STORAGE_DRIVER || "json");
check("CODEX_PET_PUBLIC_BASE_URL", env.CODEX_PET_PUBLIC_BASE_URL || "missing");
check("CODEX_PET_REALTIME_BUS", env.CODEX_PET_REALTIME_BUS || "local");

const auth = authProviderStatus(env);
const authReady = ["passkey", "email_magic_link", "league_oauth"].some(
  (method) => auth.methods?.[method]?.status === "configured",
);

if (production) {
  requireCondition((env.CODEX_PET_AUTH_PROVIDER || "local_dev") !== "local_dev", "production auth must not use local_dev");
  requireCondition(env.CODEX_PET_AUTH_DEV_CODE !== "true", "production must not expose auth dev codes");
  requireCondition(env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER !== "true", "production must not allow dev account headers");
  requireCondition(env.CODEX_PET_COOKIE_SECURE === "true", "production should set CODEX_PET_COOKIE_SECURE=true");
  requireCondition(authReady, "production needs at least one fully configured auth method");
  requireSecret("CODEX_PET_BRIDGE_SECRET");
  requireSecret("CODEX_PET_BRIDGE_ATTESTATION_SECRET");
  requireSecret("CODEX_PET_REPLAY_SIGNING_SECRET");
  requireCondition((env.CODEX_PET_STORAGE_DRIVER || "json") !== "json", "production should use sqlite until the final DB backend lands");
  requireCondition(/^https:\/\//.test(env.CODEX_PET_PUBLIC_BASE_URL || ""), "production public base URL must be HTTPS");
  requireCondition((env.CODEX_PET_REALTIME_BUS || "local") !== "local", "production should use redis realtime bus for scale-out");
  requireCondition(Boolean(env.CODEX_PET_REDIS_URL), "production redis realtime bus requires CODEX_PET_REDIS_URL");
  if ((env.CODEX_PET_ASSET_STORAGE || "local_fs") === "s3_compatible") requireS3Config();
} else {
  warnIf(env.CODEX_PET_AUTH_DEV_CODE === "true", "auth dev codes are exposed");
  warnIf(env.CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER === "true", "dev account header fallback is enabled");
}

await assertWritablePath(env.CODEX_PET_ASSET_ROOT || "data/assets", "asset root");
if ((env.CODEX_PET_STORAGE_DRIVER || "json") === "sqlite") {
  await assertWritablePath(dirname(resolve(env.CODEX_PET_SQLITE_PATH || "data/league-state.sqlite")), "sqlite directory");
}

for (const finding of findings) {
  const prefix = finding.level === "error" ? "error" : "warning";
  console.log(`${prefix}: ${finding.message}`);
}

if (findings.some((finding) => finding.level === "error")) {
  process.exitCode = 1;
} else {
  console.log(`production check ok (${deploymentEnv})`);
}

function check(name, value) {
  console.log(`${name}=${value}`);
}

function requireSecret(name) {
  const value = env[name];
  requireCondition(Boolean(value) && !/^change-me/.test(value), `${name} must be configured with a non-default secret`);
}

function requireCondition(condition, message) {
  if (!condition) findings.push({ level: "error", message });
}

function warnIf(condition, message) {
  if (condition) findings.push({ level: "warning", message });
}

async function assertWritablePath(path, label) {
  const target = resolve(path);
  await mkdir(target, { recursive: true });
  await access(target, constants.W_OK);
  const probe = resolve(target, `.codex-pet-${process.pid}.probe`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
  console.log(`${label} writable=${target}`);
}

function requireS3Config() {
  for (const name of [
    "CODEX_PET_S3_ENDPOINT",
    "CODEX_PET_S3_BUCKET",
    "CODEX_PET_S3_ACCESS_KEY_ID",
    "CODEX_PET_S3_SECRET_ACCESS_KEY",
  ]) {
    requireSecret(name);
  }
}
