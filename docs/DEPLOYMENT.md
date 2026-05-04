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
CODEX_PET_PUBLIC_BASE_URL=https://<league-domain>
CODEX_PET_COOKIE_SECURE=true
CODEX_PET_AUTH_PROVIDER=<real-provider>
CODEX_PET_AUTH_DEV_CODE=false
CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false
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
CODEX_PET_ASSET_CDN_BASE_URL=https://assets.<league-domain>
CODEX_PET_BRIDGE_SECRET=<strong-secret>
CODEX_PET_BRIDGE_ATTESTATION_SECRET=<strong-secret>
CODEX_PET_REPLAY_SIGNING_SECRET=<strong-secret>
```

Do not send real users to the Render service until the real provider credentials and remaining policies are configured: Clerk, Render Postgres, Render Key Value, Cloudflare R2/custom domain, moderation, domain/HTTPS, and admin access policy.

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

The official shared League server Redis-compatible provider is Render Key Value.

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
CODEX_PET_ASSET_CDN_BASE_URL=https://assets.<league-domain>
```

R2 setup notes:

- Create the R2 bucket in the same Cloudflare account that manages the League domain zone.
- Create an R2 S3 API token with object read/write access scoped to the League bucket only.
- Point `CODEX_PET_S3_ENDPOINT` at the account-level S3 API endpoint. The runtime uses path-style object URLs of the form `/bucket/key` and signs requests with `CODEX_PET_S3_REGION=auto`.
- Connect a custom domain such as `assets.<league-domain>` to the bucket and set that value as `CODEX_PET_ASSET_CDN_BASE_URL`.
- Keep the public development `r2.dev` URL disabled for production. Use the custom domain so Cloudflare cache, access controls, WAF rules, and bot controls can be applied.
- The server should only emit CDN URLs for visible public assets. If a previously public asset is later quarantined, blocked, or made private, delete or overwrite the public object or purge/disable the custom-domain path as part of the moderation action.

## Clerk Auth Target

The official shared League server auth provider is Clerk.

Clerk is the upstream account provider for passkeys, email links, and OAuth/social connections. The League server should still issue its own `league_session` cookie or `CODEX_PET_SESSION_TOKEN` after Clerk verifies a user. Do not treat Codex App or ChatGPT sign-in as League ownership proof.

The current server uses an external auth hook contract, so wire Clerk through a small auth adapter or server route that can:

- Send or initiate Clerk-backed email link login for `email_magic_link`.
- Verify Clerk passkey results for `passkey`.
- Verify Clerk OAuth/session results for `league_oauth`.
- Return JSON with `verified: true` and a stable `provider_subject` when Clerk verification succeeds.

Production-shaped Clerk environment values:

```bash
CODEX_PET_AUTH_PROVIDER=clerk
CODEX_PET_EMAIL_PROVIDER=webhook
CODEX_PET_EMAIL_WEBHOOK_URL=https://<auth-adapter>/clerk/email-link
CODEX_PET_AUTH_WEBHOOK_SECRET=<shared-auth-hook-secret>
CODEX_PET_EMAIL_WEBHOOK_SECRET=<shared-auth-hook-secret>
CODEX_PET_PASSKEY_PROVIDER=true
CODEX_PET_PASSKEY_VERIFY_URL=https://<auth-adapter>/clerk/passkey/verify
CODEX_PET_PASSKEY_RP_ID=<league-domain>
CODEX_PET_OAUTH_ISSUER=https://<clerk-instance-domain>
CODEX_PET_OAUTH_AUTHORIZE_URL=https://<clerk-instance-domain>/sign-in
CODEX_PET_OAUTH_CLIENT_ID=codex-pet-league
CODEX_PET_OAUTH_REDIRECT_URI=https://<league-domain>/oauth/callback
CODEX_PET_OAUTH_VERIFY_URL=https://<auth-adapter>/clerk/oauth/verify
```

Before production traffic, test all three auth methods through `codexpet auth providers`, `codexpet auth challenge`, and `codexpet auth verify`. Production mode must not pass with only `local_dev` auth.

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
CODEX_PET_REDIS_URL=redis://default:password@redis.example.com:6379/0
CODEX_PET_REALTIME_CHANNEL=codex-pet-league:events
CODEX_PET_REQUEST_GUARD_NAMESPACE=codex-pet-league
CODEX_PET_LOCK_NAMESPACE=codex-pet-league
```

Local development stays on `CODEX_PET_REALTIME_BUS=local`, `CODEX_PET_REQUEST_GUARD=local`, and `CODEX_PET_DISTRIBUTED_LOCK=local`. In production, Redis shares realtime events, rate-limit buckets, idempotency keys, and short-lived leases for matchmaking, ops jobs, and battle turns across server instances.

## Backup

```bash
npm run backup
npm run backup -- runs/backups/manual-before-upgrade
```

The backup script copies the JSON state, SQLite database files, WAL/SHM files when present, atlas assets, and a Postgres state snapshot when `CODEX_PET_STORAGE_DRIVER=postgres`.

## User-Owned Setup Kept For Last

These cannot be completed locally without your accounts or provider choices:

- domain and HTTPS certificate
- production host or cloud project
- email/passkey/OAuth provider credentials
- bridge and replay signing secrets
- Postgres, Redis, and persistent object storage locations
- monitoring destination for `/api/metrics`
