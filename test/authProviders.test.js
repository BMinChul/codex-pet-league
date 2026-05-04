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

test("auth config accepts AWS SES email delivery", () => {
  const env = {
    CODEX_PET_AUTH_PROVIDER: "email_code",
    CODEX_PET_EMAIL_PROVIDER: "aws_ses",
    CODEX_PET_SES_REGION: "us-east-1",
    CODEX_PET_SES_FROM_EMAIL: "no-reply@example.test",
    CODEX_PET_SES_ACCESS_KEY_ID: "access",
    CODEX_PET_SES_SECRET_ACCESS_KEY: "secret",
  };

  const status = authProviderStatus(env);
  assert.equal(status.email_magic_link, "configured");
  assert.equal(status.methods.email_magic_link.delivery, "aws_ses");
  assert.equal(status.methods.email_magic_link.region, "us-east-1");
  assert.doesNotThrow(() => assertAuthMethodConfigured("email_magic_link", env));
});

test("email magic-link AWS SES delivery signs SendEmail request", async () => {
  const calls = [];
  const env = {
    CODEX_PET_AUTH_PROVIDER: "email_code",
    CODEX_PET_EMAIL_PROVIDER: "aws_ses",
    CODEX_PET_SES_REGION: "us-east-1",
    CODEX_PET_SES_FROM_EMAIL: "no-reply@example.test",
    CODEX_PET_SES_FROM_NAME: "Codex Pet League",
    CODEX_PET_SES_ACCESS_KEY_ID: "access",
    CODEX_PET_SES_SECRET_ACCESS_KEY: "secret",
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
    return jsonResponse({ MessageId: "message_1" });
  });

  assert.equal(result.delivery.status, "sent");
  assert.equal(result.delivery.channel, "aws_ses");
  assert.equal(result.delivery.provider_message_id, "message_1");
  assert.equal(calls[0].url, "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(calls[0].init.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.match(calls[0].init.headers["x-amz-content-sha256"], /^[a-f0-9]{64}$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.FromEmailAddress, '"Codex Pet League" <no-reply@example.test>');
  assert.equal(body.Destination.ToAddresses[0], "player@example.test");
  assert.match(body.Content.Simple.Body.Text.Data, /ABCDEFGH/);
  assert.match(body.Content.Simple.Body.Text.Data, /https:\/\/league\.example\.test\/\?auth_challenge=challenge_1/);
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
