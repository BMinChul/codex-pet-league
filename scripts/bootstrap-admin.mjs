import { createHash, randomUUID } from "node:crypto";
import { closeStorage, updateState } from "../src/storage/jsonStore.js";

const options = parseArgs(process.argv.slice(2));
const email = normalizeEmail(options.email ?? process.env.CODEX_PET_OWNER_EMAIL ?? process.env.CODEX_PET_ADMIN_EMAIL);
const dryRun = options.dryRun || process.env.CODEX_PET_ADMIN_BOOTSTRAP_DRY_RUN === "true";
const allowLocal = options.allowLocal || process.env.CODEX_PET_ADMIN_BOOTSTRAP_ALLOW_LOCAL === "true";

if (!email) {
  console.error("error: provide --email=<verified-owner-email> or CODEX_PET_OWNER_EMAIL.");
  process.exitCode = 1;
} else if (!allowLocal && email.endsWith("@codexpet.local")) {
  console.error("error: refusing to promote local demo accounts without --allow-local.");
  process.exitCode = 1;
} else {
  try {
    const result = await updateState((state) => bootstrapAdmin(state, { email, dryRun }));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeStorage();
  }
}

function bootstrapAdmin(state, input) {
  const matches = (state.accounts ?? []).filter(
    (entry) => normalizeEmail(entry.email) === input.email || normalizeEmail(entry.identifier) === input.email,
  );
  if (matches.length > 1) {
    throw opsError("ADMIN_ACCOUNT_AMBIGUOUS", `Multiple League accounts match ${input.email}; refusing bootstrap.`);
  }
  const account = matches[0];
  if (!account) {
    throw opsError(
      "ADMIN_ACCOUNT_NOT_FOUND",
      `No League account exists for ${input.email}. Sign in through email-code login first.`,
    );
  }
  if (account.verified !== true) {
    throw opsError("ADMIN_ACCOUNT_NOT_VERIFIED", `Account ${account.id} is not verified.`);
  }

  const previousRole = account.role ?? "player";
  const localAdmins = (state.accounts ?? []).filter(
    (entry) => entry.id !== account.id && (entry.role ?? "player") === "admin" && isLocalDemoAccount(entry),
  );
  if (!input.dryRun && previousRole !== "admin") {
    account.role = "admin";
    account.admin_bootstrapped_at ??= new Date().toISOString();
    account.admin_bootstrap_reason = "first_verified_owner_account";
    appendOpsEvent(state, {
      type: "admin.bootstrap",
      accountId: account.id,
      payload: {
        previous_role: previousRole,
        new_role: "admin",
        identifier_hash: hashText(input.email),
      },
    });
  }
  if (!input.dryRun) {
    for (const localAdmin of localAdmins) {
      localAdmin.role = "player";
      localAdmin.admin_demoted_at = new Date().toISOString();
      localAdmin.admin_demote_reason = "production_owner_bootstrap";
      appendOpsEvent(state, {
        type: "admin.local_demo_demoted",
        accountId: localAdmin.id,
        payload: {
          new_role: "player",
          reason: "production_owner_bootstrap",
        },
      });
    }
  }

  return {
    ok: true,
    dry_run: input.dryRun,
    promoted_exact_email_only: true,
    account: {
      id: account.id,
      email: account.email ?? null,
      identifier: account.identifier ?? null,
      verified: account.verified === true,
      previous_role: previousRole,
      role: input.dryRun ? previousRole : account.role,
      admin_bootstrapped_at: account.admin_bootstrapped_at ?? null,
    },
    local_demo_admins_demoted: input.dryRun ? 0 : localAdmins.length,
    local_demo_admins_that_would_be_demoted: input.dryRun ? localAdmins.map((entry) => entry.id) : [],
  };
}

function appendOpsEvent(state, input) {
  state.events ??= [];
  const event = {
    id: `event_${randomUUID()}`,
    type: input.type,
    account_id: input.accountId,
    payload: input.payload,
    previous_hash: state.events[0]?.hash ?? null,
    created_at: new Date().toISOString(),
  };
  event.hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  state.events.unshift(event);
  state.events = state.events.slice(0, 200);
}

function parseArgs(args) {
  const parsed = { dryRun: false, allowLocal: false };
  for (const arg of args) {
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--allow-local") parsed.allowLocal = true;
    else if (arg.startsWith("--email=")) parsed.email = arg.slice("--email=".length);
  }
  return parsed;
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isLocalDemoAccount(account) {
  return [account.email, account.identifier].some((value) => normalizeEmail(value).endsWith("@codexpet.local"));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function opsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
