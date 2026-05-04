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
CODEX_PET_BRIDGE_SECRET=<strong-secret>
CODEX_PET_BRIDGE_ATTESTATION_SECRET=<strong-secret>
CODEX_PET_REPLAY_SIGNING_SECRET=<strong-secret>
```

Do not send real users to the Render service until the remaining provider choices are configured: Auth, Render Postgres, Render Key Value, object storage/CDN, moderation, domain/HTTPS, and admin access policy.

## Runtime Layout

Use persistent storage for:

- `CODEX_PET_POSTGRES_URL`
- `CODEX_PET_ASSET_ROOT`
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
