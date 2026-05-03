import { createHmac } from "node:crypto";
import { oauthAuthorizeUrl, passkeyChallengeOptions } from "../domain/authConfig.js";

export async function deliverAuthChallenge(challenge, env = process.env, transport = fetch) {
  if (challenge.method === "email_magic_link") {
    return deliverEmailMagicLink(challenge, env, transport);
  }
  if (challenge.method === "passkey") {
    return {
      delivery: {
        method: "passkey",
        status: "challenge_ready",
        channel: env.CODEX_PET_AUTH_PROVIDER === "local_dev" ? "local_dev" : "webauthn",
        message: "Passkey challenge options are ready for the client.",
      },
      passkey_options: passkeyChallengeOptions(challenge, env),
    };
  }
  if (challenge.method === "league_oauth") {
    return {
      delivery: {
        method: "league_oauth",
        status: "redirect_ready",
        channel: env.CODEX_PET_AUTH_PROVIDER === "local_dev" ? "local_dev" : "oauth",
        message: "OAuth redirect URL is ready.",
      },
      oauth_authorize_url: oauthAuthorizeUrl(challenge, env),
    };
  }
  return { delivery: { method: challenge.method, status: "noop", channel: "unknown" } };
}

export async function verifyExternalAuth(challenge, input = {}, env = process.env, transport = fetch) {
  if (!challenge || (env.CODEX_PET_AUTH_PROVIDER || "local_dev") === "local_dev") return null;
  if (challenge.method === "passkey" && input.assertion) {
    return postVerifyHook(env.CODEX_PET_PASSKEY_VERIFY_URL, {
      type: "auth.passkey.verify",
      challenge_id: challenge.id,
      identifier: challenge.identifier,
      assertion: input.assertion,
    }, env, transport);
  }
  if (challenge.method === "league_oauth" && (input.oauth_code || input.provider_token)) {
    return postVerifyHook(env.CODEX_PET_OAUTH_VERIFY_URL, {
      type: "auth.oauth.verify",
      challenge_id: challenge.id,
      identifier: challenge.identifier,
      oauth_code: input.oauth_code,
      provider_token: input.provider_token,
      redirect_uri: env.CODEX_PET_OAUTH_REDIRECT_URI,
      issuer: env.CODEX_PET_OAUTH_ISSUER,
    }, env, transport);
  }
  return null;
}

async function deliverEmailMagicLink(challenge, env, transport) {
  const authProvider = env.CODEX_PET_AUTH_PROVIDER || "local_dev";
  const provider = env.CODEX_PET_EMAIL_PROVIDER || (authProvider === "local_dev" ? "local_dev" : "");
  const payload = {
    type: "auth.magic_link",
    challenge_id: challenge.challenge_id,
    identifier: challenge.identifier,
    code: challenge.dev_code,
    expires_at: challenge.expires_at,
    verify_url: `${publicBaseUrl(env)}/?auth_challenge=${encodeURIComponent(challenge.challenge_id)}`,
  };

  if (provider === "local_dev") {
    return {
      delivery: {
        method: "email_magic_link",
        status: "local_dev",
        channel: "local_dev",
        message: "Local dev challenge created.",
      },
    };
  }
  if (provider === "console") {
    console.log(`Codex Pet League magic link code for ${challenge.identifier}: ${challenge.dev_code}`);
    return {
      delivery: {
        method: "email_magic_link",
        status: "sent",
        channel: "console",
        message: "Magic link code was written to the server console.",
      },
    };
  }
  if (provider === "webhook") {
    await postWebhook(env.CODEX_PET_EMAIL_WEBHOOK_URL, payload, env, transport);
    return {
      delivery: {
        method: "email_magic_link",
        status: "sent",
        channel: "webhook",
        message: "Magic link code was handed to the configured email webhook.",
      },
    };
  }

  const error = new Error("Email magic-link provider is not configured.");
  error.status = 503;
  error.code = "AUTH_DELIVERY_NOT_CONFIGURED";
  throw error;
}

async function postVerifyHook(url, payload, env, transport) {
  if (!url) {
    const error = new Error("External auth verification hook is not configured.");
    error.status = 503;
    error.code = "AUTH_VERIFY_HOOK_NOT_CONFIGURED";
    throw error;
  }
  const response = await postWebhook(url, payload, env, transport);
  if (response?.verified !== true) {
    const error = new Error("External auth provider did not verify the challenge.");
    error.status = 401;
    error.code = "AUTH_PROVIDER_VERIFICATION_FAILED";
    throw error;
  }
  return {
    verified: true,
    provider_subject: cleanProviderSubject(response.provider_subject ?? response.sub),
    provider_reason: String(response.reason ?? "external_provider_verified").slice(0, 80),
  };
}

async function postWebhook(url, payload, env, transport) {
  if (!url) {
    const error = new Error("Auth provider webhook URL is not configured.");
    error.status = 503;
    error.code = "AUTH_WEBHOOK_NOT_CONFIGURED";
    throw error;
  }
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "user-agent": "codex-pet-league/0.1",
  };
  const signatureSecret = env.CODEX_PET_AUTH_WEBHOOK_SECRET || env.CODEX_PET_EMAIL_WEBHOOK_SECRET;
  if (signatureSecret) {
    headers["x-codex-pet-signature"] = `hmac-sha256=${createHmac("sha256", signatureSecret).update(body).digest("hex")}`;
  }
  const response = await transport(url, { method: "POST", headers, body });
  if (!response?.ok) {
    const error = new Error(`Auth provider webhook failed with ${response?.status ?? "no response"}.`);
    error.status = 502;
    error.code = "AUTH_PROVIDER_WEBHOOK_FAILED";
    throw error;
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : {};
}

function cleanProviderSubject(value) {
  const text = String(value ?? "").trim().slice(0, 128);
  return text || null;
}

function publicBaseUrl(env) {
  return env.CODEX_PET_PUBLIC_BASE_URL || `http://localhost:${env.PORT || 4317}`;
}
