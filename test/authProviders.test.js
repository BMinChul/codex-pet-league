import test from "node:test";
import assert from "node:assert/strict";
import { authProviderStatus, assertAuthMethodConfigured, oauthAuthorizeUrl } from "../src/domain/authConfig.js";
import { deliverAuthChallenge, verifyExternalAuth } from "../src/server/authProviders.js";

test("production auth config fails closed when provider hooks are missing", () => {
  const env = { CODEX_PET_AUTH_PROVIDER: "production" };

  assert.equal(authProviderStatus(env).email_magic_link, "missing");
  assert.throws(() => assertAuthMethodConfigured("email_magic_link", env), {
    code: "AUTH_PROVIDER_NOT_CONFIGURED",
    status: 503,
  });
});

test("email magic-link webhook delivery posts a signed provider payload", async () => {
  const calls = [];
  const env = {
    CODEX_PET_AUTH_PROVIDER: "production",
    CODEX_PET_EMAIL_PROVIDER: "webhook",
    CODEX_PET_EMAIL_WEBHOOK_URL: "https://email.example.test/send",
    CODEX_PET_EMAIL_WEBHOOK_SECRET: "secret",
    CODEX_PET_PUBLIC_BASE_URL: "https://league.example.test",
  };
  const challenge = {
    challenge_id: "challenge_1",
    method: "email_magic_link",
    identifier: "player@example.test",
    dev_code: "ABCDEFGH",
    expires_at: "2026-05-03T00:10:00.000Z",
  };
  const result = await deliverAuthChallenge(challenge, env, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({});
  });

  assert.equal(result.delivery.status, "sent");
  assert.equal(calls[0].url, env.CODEX_PET_EMAIL_WEBHOOK_URL);
  assert.match(calls[0].init.headers["x-codex-pet-signature"], /^hmac-sha256=[a-f0-9]{64}$/);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.identifier, "player@example.test");
  assert.equal(payload.code, "ABCDEFGH");
  assert.equal(payload.verify_url, "https://league.example.test/?auth_challenge=challenge_1");
});

test("passkey provider verification accepts a verified external hook response", async () => {
  const env = {
    CODEX_PET_AUTH_PROVIDER: "production",
    CODEX_PET_PASSKEY_PROVIDER: "true",
    CODEX_PET_PASSKEY_VERIFY_URL: "https://passkey.example.test/verify",
  };
  const challenge = {
    id: "challenge_1",
    method: "passkey",
    identifier: "player@example.test",
  };
  const result = await verifyExternalAuth(challenge, { assertion: { id: "credential_1" } }, env, async (url, init) => {
    assert.equal(url, env.CODEX_PET_PASSKEY_VERIFY_URL);
    assert.equal(JSON.parse(init.body).type, "auth.passkey.verify");
    return jsonResponse({ verified: true, sub: "provider-user-1" });
  });

  assert.equal(result.verified, true);
  assert.equal(result.provider_subject, "provider-user-1");
});

test("OAuth authorize URL carries the League challenge id as state", () => {
  const url = oauthAuthorizeUrl(
    {
      challenge_id: "challenge_1",
      identifier: "player@example.test",
    },
    {
      CODEX_PET_PUBLIC_BASE_URL: "https://league.example.test",
      CODEX_PET_OAUTH_AUTHORIZE_URL: "https://oauth.example.test/authorize",
      CODEX_PET_OAUTH_CLIENT_ID: "client_1",
      CODEX_PET_OAUTH_REDIRECT_URI: "https://league.example.test/oauth/callback",
    },
  );

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("state"), "challenge_1");
  assert.equal(parsed.searchParams.get("login_hint"), "player@example.test");
  assert.equal(parsed.searchParams.get("client_id"), "client_1");
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}
