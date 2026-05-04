import { createHash, createHmac } from "node:crypto";
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
  if (provider === "aws_ses") {
    const result = await sendSesEmail(challenge, payload, env, transport);
    return {
      delivery: {
        method: "email_magic_link",
        status: "sent",
        channel: "aws_ses",
        message: "Login code was sent through AWS SES.",
        provider_message_id: result?.MessageId ?? null,
      },
    };
  }

  const error = new Error("Email magic-link provider is not configured.");
  error.status = 503;
  error.code = "AUTH_DELIVERY_NOT_CONFIGURED";
  throw error;
}

async function sendSesEmail(challenge, payload, env, transport) {
  const request = signedSesSendEmailRequest(sesEmailPayload(challenge, payload, env), env);
  const response = await transport(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  if (!response?.ok) {
    const error = new Error(`AWS SES email delivery failed with ${response?.status ?? "no response"}.`);
    error.status = 502;
    error.code = "AUTH_EMAIL_DELIVERY_FAILED";
    throw error;
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : {};
}

function sesEmailPayload(challenge, payload, env) {
  const config = sesConfig(env);
  const text = [
    "Codex Pet League login",
    "",
    `Your login code is: ${challenge.dev_code}`,
    "",
    `This code expires at ${challenge.expires_at}.`,
    `Challenge link: ${payload.verify_url}`,
    "",
    "If you did not request this login, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Codex Pet League login</p>",
    `<p>Your login code is: <strong>${escapeHtml(challenge.dev_code)}</strong></p>`,
    `<p>This code expires at ${escapeHtml(challenge.expires_at)}.</p>`,
    `<p>Challenge link: <a href="${escapeHtml(payload.verify_url)}">${escapeHtml(payload.verify_url)}</a></p>`,
    "<p>If you did not request this login, you can ignore this email.</p>",
  ].join("");
  const email = {
    FromEmailAddress: sesFromEmailAddress(config),
    Destination: {
      ToAddresses: [challenge.identifier],
    },
    Content: {
      Simple: {
        Subject: {
          Data: env.CODEX_PET_SES_SUBJECT || "Your Codex Pet League login code",
          Charset: "UTF-8",
        },
        Body: {
          Text: {
            Data: text,
            Charset: "UTF-8",
          },
          Html: {
            Data: html,
            Charset: "UTF-8",
          },
        },
      },
    },
  };
  if (config.replyTo) email.ReplyToAddresses = [config.replyTo];
  if (config.configurationSet) email.ConfigurationSetName = config.configurationSet;
  return email;
}

function signedSesSendEmailRequest(payload, env) {
  const config = sesConfig(env);
  const method = "POST";
  const path = "/v2/email/outbound-emails";
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const url = `${endpoint}${path}`;
  const host = new URL(endpoint).host;
  const body = JSON.stringify(payload);
  const date = new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex(body);
  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name.toLowerCase()}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
    .join(";");
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${config.region}/ses/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(config.secretAccessKey, dateStamp, config.region), stringToSign);
  const requestHeaders = {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  delete requestHeaders.host;
  return {
    url,
    headers: requestHeaders,
    body,
  };
}

function sesConfig(env) {
  const region = env.CODEX_PET_SES_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION;
  const config = {
    endpoint: env.CODEX_PET_SES_ENDPOINT || (region ? `https://email.${region}.amazonaws.com` : ""),
    region,
    fromEmail: env.CODEX_PET_SES_FROM_EMAIL,
    fromName: env.CODEX_PET_SES_FROM_NAME,
    replyTo: env.CODEX_PET_SES_REPLY_TO,
    configurationSet: env.CODEX_PET_SES_CONFIGURATION_SET,
    accessKeyId: env.CODEX_PET_SES_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.CODEX_PET_SES_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.CODEX_PET_SES_SESSION_TOKEN || env.AWS_SESSION_TOKEN,
  };
  for (const [key, value] of Object.entries({
    endpoint: config.endpoint,
    region: config.region,
    fromEmail: config.fromEmail,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })) {
    if (!value) {
      const error = new Error(`AWS SES email delivery is missing ${key}.`);
      error.status = 503;
      error.code = "AUTH_EMAIL_DELIVERY_NOT_CONFIGURED";
      throw error;
    }
  }
  return config;
}

function sesFromEmailAddress(config) {
  if (!config.fromName) return config.fromEmail;
  const cleanName = String(config.fromName).replaceAll('"', "").trim();
  return cleanName ? `"${cleanName}" <${config.fromEmail}>` : config.fromEmail;
}

function signingKey(secret, dateStamp, region) {
  const dateKey = hmacBuffer(`AWS4${secret}`, dateStamp);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, "ses");
  return hmacBuffer(serviceKey, "aws4_request");
}

function hmacBuffer(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
