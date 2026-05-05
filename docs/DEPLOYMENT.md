# Codex Pet League Deployment

This repo now has a local production-shaped package path. The pieces that need outside accounts or secrets stay last.

## Local Container Run

```bash
cp .env.example .env
npm run prod:check
docker compose up --build
```

Then check:

```bash
curl http://localhost:4317/api/health
curl http://localhost:4317/api/metrics
```

## Production Readiness Check

Run this before starting a real deployment:

```bash
CODEX_PET_DEPLOYMENT_ENV=production npm run prod:check
```

In production mode it fails if:

- auth still uses `local_dev`
- auth dev codes or dev account headers are enabled
- secure cookies are off
- bridge/replay secrets are missing or default-looking
- no real auth method is fully configured
- storage is not `postgres` or `CODEX_PET_POSTGRES_URL` is missing
- public base URL is not HTTPS
- realtime bus, request guard, or distributed lock is still local, or Redis is not configured
- OpenAI moderation provider, model, fail mode, or API key is missing

## Render Deployment Target

The official shared League server deployment target is Render Web Service.

Use Render for the long-running Node server and keep provider secrets in Render environment variables, not in git. Render should build from this repository's root `Dockerfile`, run `node src/server/index.js`, and use `/api/health` as the service health check path.

Initial Render service settings:

- Service type: Web Service.
- Source: `https://github.com/BMinChul/codex-pet-league`.
- Runtime: Docker, using the root `Dockerfile`.
- Branch: `master` until a release branch is introduced.
- Health check path: `/api/health`.
- Port: use the app `PORT` environment variable. This repo defaults to `4317`; keep `PORT=4317` unless the Render service is configured for a different container port.
- Auto deploy: acceptable for early operations, but pause it before risky production migrations.

Minimum Render environment values before real production traffic:

```bash
NODE_ENV=production
CODEX_PET_DEPLOYMENT_ENV=production
PORT=4317
CODEX_PET_PUBLIC_BASE_URL=https://league.<domain>
CODEX_PET_COOKIE_SECURE=true
CODEX_PET_AUTH_PROVIDER=email_code
CODEX_PET_AUTH_DEV_CODE=false
CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false
CODEX_PET_ADMIN_EMAIL_ALLOWLIST=owner@example.com
CODEX_PET_EMAIL_PROVIDER=resend
CODEX_PET_RESEND_FROM_EMAIL=no-reply@league.<domain>
CODEX_PET_RESEND_FROM_NAME=Codex Pet League
CODEX_PET_RESEND_REPLY_TO=support@<domain>
CODEX_PET_RESEND_API_KEY=<resend-api-key>
CODEX_PET_STORAGE_DRIVER=postgres
CODEX_PET_POSTGRES_URL=<render-postgres-url>
CODEX_PET_REALTIME_BUS=redis
CODEX_PET_REQUEST_GUARD=redis
CODEX_PET_DISTRIBUTED_LOCK=redis
CODEX_PET_REDIS_URL=<render-key-value-redis-url>
CODEX_PET_ASSET_STORAGE=s3_compatible
CODEX_PET_S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
CODEX_PET_S3_BUCKET=<r2-bucket-name>
CODEX_PET_S3_REGION=auto
CODEX_PET_S3_ACCESS_KEY_ID=<r2-access-key-id>
CODEX_PET_S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
CODEX_PET_ASSET_CDN_BASE_URL=https://assets.<domain>
OPENAI_API_KEY=<openai-api-key>
CODEX_PET_MODERATION_PROVIDER=openai
CODEX_PET_MODERATION_MODEL=omni-moderation-latest
CODEX_PET_MODERATION_FAIL_MODE=review
CODEX_PET_BRIDGE_SECRET=<strong-secret>
CODEX_PET_BRIDGE_ATTESTATION_SECRET=<strong-secret>
CODEX_PET_REPLAY_SIGNING_SECRET=<strong-secret>
```

The official shared alpha is live at `https://league.codexpetz.com`. Keep the provider credentials, domain/admin rollout, secure cookies, and owner-only admin policy configured before sending broader traffic.

## Domain, HTTPS, Cookie, And Admin Target

The official shared League server domain strategy is:

- `league.<domain>`: Render Web Service custom domain for the web UI, HTTP API, Codex App MCP bridge endpoint, and CLI server target.
- `assets.<domain>`: Cloudflare R2 custom domain for public pet atlas assets.
- `www.<domain>`: optional redirect or public landing page later; not required for the first shared League server.

Do not split the app and API across separate hostnames for 1.0. Keeping browser traffic on `league.<domain>` lets the existing `league_session` cookie remain host-only and avoids cross-site cookie complexity. CLI and MCP clients can continue using `CODEX_PET_SESSION_TOKEN` or the `x-league-session-token` header.

Render and Cloudflare DNS setup:

1. Add `league.<domain>` as a Render custom domain on the Web Service.
2. In Cloudflare DNS, create a CNAME for `league` pointing at the service's `*.onrender.com` hostname.
3. Keep the `league` record DNS-only while Render verifies the domain and issues TLS.
4. Remove any `AAAA` records for Render-served hostnames.
5. If the zone has CAA records, allow Render's certificate authorities: `letsencrypt.org` and `pki.goog`.
6. After Render shows the certificate as valid, leave the record DNS-only for the simplest launch path or switch it to proxied only after `/api/health`, session login, SSE, and battle turns are verified through Cloudflare.
7. Disable the default `*.onrender.com` subdomain after `league.<domain>` is healthy, so official traffic uses only the League domain.

HTTPS and cookie runtime values:

```bash
CODEX_PET_PUBLIC_BASE_URL=https://league.<domain>
CODEX_PET_COOKIE_SECURE=true
CODEX_PET_AUTH_DEV_CODE=false
CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false
```

Render terminates inbound HTTPS at its load balancer and forwards HTTP to the service container, so the Node app should keep binding to `PORT` and should not try to manage public TLS itself. The current browser session cookie is `league_session` with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `CODEX_PET_COOKIE_SECURE=true`.

Admin access policy:

- Admin API access requires a valid League session, server-side `account.role === "admin"`, and membership in `CODEX_PET_ADMIN_EMAIL_ALLOWLIST` when that allowlist is configured.
- Do not use shared admin passwords, public admin tokens, query-string secrets, or client-controlled role flags.
- Use League email-code login as the upstream identity proof for the low-cost alpha, then promote only verified owner accounts into League server records as `role=admin`.
- Store admin authorization only in League server-side account state plus the locked-down server-side email allowlist. Do not trust browser-submitted role values.
- For the official shared server, keep `CODEX_PET_ADMIN_EMAIL_ALLOWLIST` limited to the owner email unless the owner explicitly authorizes another admin.
- Bootstrap the first production admin with a controlled one-off promotion after verified email login, then keep later admin changes audited through League admin operations or a small locked-down ops script.
- Keep `CODEX_PET_AUTH_DEV_CODE=false` and `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false` in every shared environment.

## Render Postgres Target

The official shared League server managed database provider is Render Postgres.

Create the database in the same Render account and region as the Web Service. Use the Render Postgres internal database URL for `CODEX_PET_POSTGRES_URL` whenever the League server runs on Render. Keep the external URL for local admin tools only, and restrict or disable external access after initial setup.

Initial database setup:

```bash
CODEX_PET_POSTGRES_URL=<render-internal-postgres-url> npm run db:postgres:migrate
```

Production runtime values:

```bash
CODEX_PET_STORAGE_DRIVER=postgres
CODEX_PET_POSTGRES_URL=<render-internal-postgres-url>
CODEX_PET_POSTGRES_SSL=false
CODEX_PET_POSTGRES_SSL_REJECT_UNAUTHORIZED=true
CODEX_PET_POSTGRES_SNAPSHOT_RETENTION=500
```

Notes:

- Render Postgres provides internal and external URLs. The internal URL minimizes latency through Render private networking.
- Render's external Postgres connections use TLS. If connecting from local admin tools with the external URL, keep TLS support enabled in the client.
- The current runtime writes authoritative snapshots to `league_state_snapshots`; table-specific write-through can be added after the production database is live.
- Consider Render PgBouncer only if connection pressure appears in metrics or logs. The current single Web Service can start with direct internal connections.

## Render Key Value Target

The official shared League server Redis-compatible provider is Render Key Value. Use it from the first shared server launch so matchmaking, battle turns, request guards, idempotency, and realtime fanout do not depend on one process's memory.

Use one Render Key Value instance for:

- Realtime fanout over Redis-compatible pub/sub.
- Distributed request guard buckets for rate limits and idempotency keys.
- Distributed locks for matchmaking, battle turns, and ops jobs.

Create the Key Value instance in the same Render workspace and region as the Web Service. Use the internal URL for `CODEX_PET_REDIS_URL` whenever possible. Render Key Value URLs can use either `redis://` or `rediss://`; this runtime supports both schemes.

Production runtime values:

```bash
CODEX_PET_REALTIME_BUS=redis
CODEX_PET_REQUEST_GUARD=redis
CODEX_PET_DISTRIBUTED_LOCK=redis
CODEX_PET_REDIS_URL=<render-key-value-internal-url>
CODEX_PET_REALTIME_CHANNEL=codex-pet-league:events
CODEX_PET_REQUEST_GUARD_NAMESPACE=codex-pet-league
CODEX_PET_LOCK_NAMESPACE=codex-pet-league
CODEX_PET_LOCK_TTL_MS=30000
```

Notes:

- Prefer paid/persistent Key Value for the official shared League server so short-lived lock/rate/idempotency data survives routine instance restarts as much as the provider supports.
- Keep external Key Value access disabled unless a specific admin/debug workflow needs it, and disable it again afterward.
- `codexpet doctor`, MCP `league_doctor`, and `/api/health` expose redacted Redis connection status for troubleshooting.

## Cloudflare R2 Asset Storage Target

The official shared League server object storage provider is Cloudflare R2 with a custom domain for public pet atlas URLs.

Use R2 as an S3-compatible private write target for canonical atlas objects. Use the custom domain only as the public read surface for assets that League policy allows to be public. Do not rely on the Cloudflare-managed `r2.dev` URL for production traffic.

Production runtime values:

```bash
CODEX_PET_ASSET_STORAGE=s3_compatible
CODEX_PET_S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
CODEX_PET_S3_BUCKET=<r2-bucket-name>
CODEX_PET_S3_REGION=auto
CODEX_PET_S3_ACCESS_KEY_ID=<r2-access-key-id>
CODEX_PET_S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
CODEX_PET_ASSET_CDN_BASE_URL=https://assets.<domain>
```

R2 setup notes:

- Create the R2 bucket in the same Cloudflare account that manages the League domain zone.
- Create an R2 S3 API token with object read/write access scoped to the League bucket only.
- Point `CODEX_PET_S3_ENDPOINT` at the account-level S3 API endpoint. The runtime uses path-style object URLs of the form `/bucket/key` and signs requests with `CODEX_PET_S3_REGION=auto`.
- Connect a custom domain such as `assets.<domain>` to the bucket and set that value as `CODEX_PET_ASSET_CDN_BASE_URL`.
- Keep the public development `r2.dev` URL disabled for production. Use the custom domain so Cloudflare cache, access controls, WAF rules, and bot controls can be applied.
- The server should only emit CDN URLs for visible public assets. If a previously public asset is later quarantined, blocked, or made private, delete or overwrite the public object or purge/disable the custom-domain path as part of the moderation action.

## OpenAI Moderation Target

The official shared League server image/text moderation provider is the OpenAI Moderation API with `omni-moderation-latest`.

The `OPENAI_API_KEY` for this service is moderation-only. Do not use it for Responses, Chat Completions, image generation, embeddings, audio, fine-tuning, or any other paid OpenAI endpoint. In the OpenAI project settings, use a dedicated project/key for this League service and restrict permissions/budgets as tightly as the dashboard allows.

Use moderation as a triage signal before public asset exposure and before user-controlled text is shown broadly. It should feed the existing asset states instead of replacing admin review:

- `clear`: content can stay public and can enter ranked if all other rules pass.
- `quarantine`: content becomes private, cannot enter ranked, and waits for admin review.
- `hide`: content becomes blocked/private and cannot enter any battle.

Production-shaped moderation environment values:

```bash
OPENAI_API_KEY=<openai-api-key>
CODEX_PET_MODERATION_PROVIDER=openai
CODEX_PET_MODERATION_MODEL=omni-moderation-latest
CODEX_PET_MODERATION_FAIL_MODE=review
```

Moderation policy:

- Send both the pet atlas image and related text when available: pet name, appearance metadata, skill nicknames, user report reasons, and Training Report summaries. Do not send raw source code or full Codex transcripts.
- Treat hard model flags for severe categories as `quarantine` by default, with `hide` reserved for clear safety-blocking cases or manual admin resolution.
- Do not auto-punish accounts, remove LP, or apply ranked locks from moderation scores alone. Account enforcement stays a manual review outcome.
- If the moderation provider is down or times out during public asset registration, fail into `quarantine`/private review rather than publishing directly to the R2 custom domain.
- Store only moderation metadata needed for audit: model, timestamp, flagged result, categories, scores, applied input types, action, and reviewer notes. Avoid storing unnecessary submitted text beyond the existing summarized League records.
- Image-only moderation does not cover every text-only category. Keep user reports and manual review available for text embedded inside pet pixels or ambiguous stylized imagery.

## Resend Email Code Auth Target

The official shared League server alpha auth path is native League email-code login delivered through Resend.

Resend is only the email sender. The League server still creates the auth challenge, verifies the code, binds the account, and issues its own `league_session` cookie or `CODEX_PET_SESSION_TOKEN`. Do not treat Codex App or ChatGPT sign-in as League ownership proof.

Production-shaped Resend environment values:

```bash
CODEX_PET_AUTH_PROVIDER=email_code
CODEX_PET_EMAIL_PROVIDER=resend
CODEX_PET_RESEND_FROM_EMAIL=no-reply@league.<domain>
CODEX_PET_RESEND_FROM_NAME=Codex Pet League
CODEX_PET_RESEND_REPLY_TO=support@<domain>
CODEX_PET_RESEND_API_KEY=<resend-api-key>
```

Setup notes:

- Verify the sending domain in Resend before opening traffic.
- Keep the Resend account on the free plan while login volume is small; the free plan has daily and monthly quotas that act as a hard early cost brake.
- Keep pay-as-you-go overages disabled unless the official server has a real usage reason.
- Keep `CODEX_PET_AUTH_DEV_CODE=false`; production users should receive the code only through email.
- Auth challenge rate limits are IP-scoped to one email-code request per 10 minutes, and Resend delivery uses a per-challenge idempotency key so retries do not duplicate emails.
- Passkeys and OAuth/social login can be added later through the existing `passkey` and `league_oauth` hook contracts, but they are not required for the low-cost alpha.

Before production traffic, test the flow through `codexpet auth providers`, `codexpet auth challenge --method email_magic_link --identifier <email>`, and `codexpet auth verify`. Production mode must not pass with only `local_dev` auth.

## Private Support Inbox Target

The official shared alpha private support address is:

```text
support@codexpetz.com
```

Use Cloudflare Email Routing for inbound support during the alpha. It forwards mail to the owner's private inbox without adding a paid mailbox provider. This receiving path is separate from Resend, which remains the outbound email-code sender.

Cloudflare setup:

1. In Cloudflare, open `codexpetz.com` and go to Email Routing.
2. Onboard the domain if Email Routing is not already enabled.
3. Add the owner's destination inbox and complete the verification email.
4. Create a custom address: `support`.
5. Set the action to send to the verified owner inbox.
6. Leave catch-all disabled or set it to drop during alpha to reduce spam.
7. Send a test email from another mailbox to `support@codexpetz.com`.
8. After the test arrives, keep `CODEX_PET_RESEND_REPLY_TO=support@codexpetz.com` in Render so login-code replies point at the same private support address.

DNS note: Cloudflare Email Routing uses MX records for the root `codexpetz.com` receiving domain. Resend currently sends from the League subdomain path, so keep the existing Resend sender DNS records intact and do not delete the `send` subdomain records.

## Runtime Layout

Use persistent storage for:

- `CODEX_PET_POSTGRES_URL`
- `CODEX_PET_ASSET_ROOT` for local filesystem storage only
- backups from `npm run backup`

The Docker compose file maps `./data` to `/app/data`, so local containers keep state between restarts.
For object storage instead of a local volume, set `CODEX_PET_ASSET_STORAGE=s3_compatible` plus `CODEX_PET_S3_ENDPOINT`, `CODEX_PET_S3_BUCKET`, `CODEX_PET_S3_ACCESS_KEY_ID`, and `CODEX_PET_S3_SECRET_ACCESS_KEY`. Set `CODEX_PET_ASSET_CDN_BASE_URL` when a CDN should serve public atlas URLs directly.

## Database And Realtime Scale-Out

The current runtime store can run on JSON, SQLite snapshots, or Postgres snapshots. For production, apply the Postgres schema first and then switch `CODEX_PET_STORAGE_DRIVER=postgres`:

```bash
npm run db:schema:check
CODEX_PET_POSTGRES_URL=postgres://user:password@db.example.com:5432/league npm run db:postgres:migrate
```

The schema keeps narrow indexed columns for hot paths and JSONB documents for compatibility with the current snapshot-backed domain state. The runtime now writes authoritative snapshots to `league_state_snapshots`; table-specific write-through can be added after the DB backend is live.

For multi-instance realtime updates, use Redis pub/sub:

```bash
CODEX_PET_REALTIME_BUS=redis
CODEX_PET_REQUEST_GUARD=redis
CODEX_PET_DISTRIBUTED_LOCK=redis
CODEX_PET_REDIS_URL=<redis-url-from-provider>
CODEX_PET_REALTIME_CHANNEL=codex-pet-league:events
CODEX_PET_REQUEST_GUARD_NAMESPACE=codex-pet-league
CODEX_PET_LOCK_NAMESPACE=codex-pet-league
```

Local development stays on `CODEX_PET_REALTIME_BUS=local`, `CODEX_PET_REQUEST_GUARD=local`, and `CODEX_PET_DISTRIBUTED_LOCK=local`. In production, Redis shares realtime events, rate-limit buckets, idempotency keys, and short-lived leases for matchmaking, ops jobs, and battle turns across server instances and restarts.

## Backup

```bash
npm run backup
npm run backup -- runs/backups/manual-before-upgrade
```

The backup script copies the JSON state, SQLite database files, WAL/SHM files when present, atlas assets, and a Postgres state snapshot when `CODEX_PET_STORAGE_DRIVER=postgres`.

For Render one-off jobs, backup output is written to the job's ephemeral filesystem. Use that only to prove the backup command can read production state unless the artifact is retrieved immediately. The official shared server should rely on Render Postgres managed backups for durable database recovery, and any future exported state backup should go to a separate private backup bucket with no public custom domain. Do not store League state backups in the public R2 asset bucket.

## Cost Guard And Incident Packs

```bash
npm run cost:check
npm run cost:check -- --json
npm run audit:summary
npm run audit:summary -- --json
npm run ops:rehash
npm run ops:rehash -- --apply
npm run ops:resolve-audit-alerts
npm run ops:resolve-audit-alerts -- --apply
npm run incident:pack
npm run incident:pack -- runs/incidents/incident-YYYYMMDD-HHMM
```

`npm run cost:check` reads League state and flags usage patterns that can turn into cost or abuse problems: email-code challenge spikes, asset upload/storage growth, open asset reports, and open abuse alerts. It exits nonzero only at `critical` thresholds so it can be used in one-off jobs or monitors without failing on early warnings.

`npm run audit:summary` prints redacted audit finding counts and a small high/critical sample so an incident can quickly separate real state tampering from test or cleanup residue. It exits nonzero when audit has high or critical findings.

`npm run ops:rehash` is a dry-run chain rebase for append-only state hashes. Use `-- --apply` only for a documented hash-format migration, such as converting legacy `JSON.stringify` hashes to stable JSON hashes after Postgres JSONB storage has normalized object key order.

`npm run ops:resolve-audit-alerts` closes stale open `audit:*` abuse alerts only after the corresponding high/critical audit finding no longer exists. Use the dry run first, then apply.

`npm run incident:pack` writes a redacted local bundle with `/api/health`, `/api/metrics`, state summary counts, open review/alert summaries, and cost guard output. Set `CODEX_PET_INCIDENT_BASE_URL=https://league.<domain>` when collecting against the official shared server. It does not include raw state snapshots, secrets, API keys, session tokens, or full user content.

Production ops threshold defaults:

```bash
CODEX_PET_INCIDENT_BASE_URL=https://league.<domain>
CODEX_PET_INCIDENT_FETCH_TIMEOUT_MS=5000
CODEX_PET_COST_AUTH_CHALLENGES_HOURLY_WARN=10
CODEX_PET_COST_AUTH_CHALLENGES_HOURLY_CRITICAL=30
CODEX_PET_COST_AUTH_CHALLENGES_DAILY_WARN=50
CODEX_PET_COST_AUTH_CHALLENGES_DAILY_CRITICAL=150
CODEX_PET_COST_ASSET_UPLOADS_DAILY_WARN=25
CODEX_PET_COST_ASSET_UPLOADS_DAILY_CRITICAL=100
CODEX_PET_COST_ASSET_BYTES_TOTAL_WARN=536870912
CODEX_PET_COST_ASSET_BYTES_TOTAL_CRITICAL=1073741824
CODEX_PET_COST_OPEN_ABUSE_ALERTS_WARN=25
CODEX_PET_COST_OPEN_ABUSE_ALERTS_CRITICAL=100
CODEX_PET_COST_OPEN_ASSET_REPORTS_WARN=25
CODEX_PET_COST_OPEN_ASSET_REPORTS_CRITICAL=100
```

Keep Resend pay-as-you-go overages disabled during alpha. If cost guard warns on auth challenges, inspect Resend and Render logs before raising limits. If storage thresholds warn, inspect recent assets and moderation state before changing R2/CDN exposure.

## Self-Host Setup Still User-Owned

These remain self-host responsibilities for anyone deploying their own League server:

- domain and HTTPS certificate
- production host or cloud project
- Resend email sender credentials
- bridge and replay signing secrets
- Postgres, Redis, and persistent object storage locations
- monitoring destination for `/api/metrics`
