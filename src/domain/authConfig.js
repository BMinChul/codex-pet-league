export function authProviderStatus(env = process.env) {
  const provider = env.CODEX_PET_AUTH_PROVIDER || "local_dev";
  const localDev = provider === "local_dev";
  const emailDelivery = emailDeliveryStatus(env, localDev);
  const passkey = passkeyStatus(env, localDev);
  const oauth = oauthStatus(env, localDev);

  return {
    provider,
    passkey: passkey.status,
    email_magic_link: emailDelivery.status,
    oauth: oauth.status,
    methods: {
      passkey,
      email_magic_link: emailDelivery,
      league_oauth: oauth,
    },
    dev_codes_exposed: env.CODEX_PET_AUTH_DEV_CODE === "true",
  };
}

export function assertAuthMethodConfigured(method, env = process.env) {
  const provider = env.CODEX_PET_AUTH_PROVIDER || "local_dev";
  if (provider === "local_dev") return;
  const status = authProviderStatus(env);
  const methodStatus = status.methods?.[method]?.status;
  if (methodStatus === "configured") return;
  const error = new Error(`${method} auth is not configured for this League server.`);
  error.status = 503;
  error.code = "AUTH_PROVIDER_NOT_CONFIGURED";
  throw error;
}

export function oauthAuthorizeUrl(challenge, env = process.env) {
  const authorizeUrl = env.CODEX_PET_OAUTH_AUTHORIZE_URL;
  if (!authorizeUrl) return null;
  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", env.CODEX_PET_OAUTH_CLIENT_ID || "codex-pet-league");
  url.searchParams.set("redirect_uri", env.CODEX_PET_OAUTH_REDIRECT_URI || publicBaseUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.CODEX_PET_OAUTH_SCOPE ?? "openid email profile");
  url.searchParams.set("state", challenge.challenge_id);
  url.searchParams.set("login_hint", challenge.identifier);
  return url.toString();
}

export function passkeyChallengeOptions(challenge, env = process.env) {
  return {
    challenge: challenge.challenge_id,
    rp_id: env.CODEX_PET_PASSKEY_RP_ID || new URL(publicBaseUrl(env)).hostname,
    timeout_ms: Number(env.CODEX_PET_PASSKEY_TIMEOUT_MS ?? 300_000),
    user_verification: env.CODEX_PET_PASSKEY_USER_VERIFICATION ?? "preferred",
    identifier: challenge.identifier,
  };
}

function emailDeliveryStatus(env, localDev) {
  const provider = env.CODEX_PET_EMAIL_PROVIDER || "";
  if (localDev && !provider) {
    return {
      status: "dev_stub",
      delivery: "local_dev",
      webhook: "missing",
    };
  }
  if (provider === "webhook" && env.CODEX_PET_EMAIL_WEBHOOK_URL) {
    return {
      status: "configured",
      delivery: "webhook",
      webhook: "configured",
      signed: Boolean(env.CODEX_PET_EMAIL_WEBHOOK_SECRET),
    };
  }
  if (provider === "aws_ses") {
    const ses = sesStatus(env);
    return {
      status: ses.configured ? "configured" : "missing",
      delivery: "aws_ses",
      region: ses.region,
      endpoint: ses.endpoint,
      from: ses.from,
      credentials: ses.credentials,
    };
  }
  if (provider === "console") {
    return {
      status: localDev ? "dev_stub" : "degraded",
      delivery: "console",
      webhook: "missing",
    };
  }
  return {
    status: "missing",
    delivery: provider || "missing",
    webhook: env.CODEX_PET_EMAIL_WEBHOOK_URL ? "configured" : "missing",
  };
}

function sesStatus(env) {
  const region = env.CODEX_PET_SES_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || "";
  const endpoint = env.CODEX_PET_SES_ENDPOINT || (region ? `https://email.${region}.amazonaws.com` : "");
  const from = env.CODEX_PET_SES_FROM_EMAIL || "";
  const hasAccessKey = Boolean(env.CODEX_PET_SES_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID);
  const hasSecretKey = Boolean(env.CODEX_PET_SES_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY);
  const credentials = hasAccessKey && hasSecretKey ? "configured" : "missing";
  return {
    configured: Boolean(region && endpoint && from && hasAccessKey && hasSecretKey),
    region: region || "missing",
    endpoint: endpoint ? "configured" : "missing",
    from: from ? "configured" : "missing",
    credentials,
  };
}

function passkeyStatus(env, localDev) {
  if (localDev && env.CODEX_PET_PASSKEY_PROVIDER !== "true") {
    return {
      status: "dev_stub",
      provider: "local_dev",
      verify_hook: "missing",
      rp_id: env.CODEX_PET_PASSKEY_RP_ID || new URL(publicBaseUrl(env)).hostname,
    };
  }
  const providerEnabled = env.CODEX_PET_PASSKEY_PROVIDER === "true";
  const verifyHook = Boolean(env.CODEX_PET_PASSKEY_VERIFY_URL);
  return {
    status: providerEnabled && verifyHook ? "configured" : "missing",
    provider: providerEnabled ? "external" : "missing",
    verify_hook: verifyHook ? "configured" : "missing",
    rp_id: env.CODEX_PET_PASSKEY_RP_ID || new URL(publicBaseUrl(env)).hostname,
  };
}

function oauthStatus(env, localDev) {
  if (localDev && !env.CODEX_PET_OAUTH_ISSUER) {
    return {
      status: "dev_stub",
      issuer: "local_dev",
      authorize: "missing",
      verify_hook: "missing",
    };
  }
  const configured = Boolean(
    env.CODEX_PET_OAUTH_ISSUER &&
      env.CODEX_PET_OAUTH_AUTHORIZE_URL &&
      env.CODEX_PET_OAUTH_CLIENT_ID &&
      env.CODEX_PET_OAUTH_REDIRECT_URI &&
      env.CODEX_PET_OAUTH_VERIFY_URL,
  );
  return {
    status: configured ? "configured" : "missing",
    issuer: env.CODEX_PET_OAUTH_ISSUER || "missing",
    authorize: env.CODEX_PET_OAUTH_AUTHORIZE_URL ? "configured" : "missing",
    verify_hook: env.CODEX_PET_OAUTH_VERIFY_URL ? "configured" : "missing",
  };
}

function publicBaseUrl(env) {
  return env.CODEX_PET_PUBLIC_BASE_URL || `http://localhost:${env.PORT || 4317}`;
}
