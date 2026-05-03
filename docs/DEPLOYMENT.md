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
- storage still uses JSON
- public base URL is not HTTPS

## Runtime Layout

Use persistent storage for:

- `CODEX_PET_SQLITE_PATH`
- `CODEX_PET_ASSET_ROOT`
- backups from `npm run backup`

The Docker compose file maps `./data` to `/app/data`, so local containers keep state between restarts.
For object storage instead of a local volume, set `CODEX_PET_ASSET_STORAGE=s3_compatible` plus `CODEX_PET_S3_ENDPOINT`, `CODEX_PET_S3_BUCKET`, `CODEX_PET_S3_ACCESS_KEY_ID`, and `CODEX_PET_S3_SECRET_ACCESS_KEY`. Set `CODEX_PET_ASSET_CDN_BASE_URL` when a CDN should serve public atlas URLs directly.

## Backup

```bash
npm run backup
npm run backup -- runs/backups/manual-before-upgrade
```

The backup script copies the JSON state, SQLite database files, WAL/SHM files when present, and atlas assets into a timestamped folder with a manifest.

## User-Owned Setup Kept For Last

These cannot be completed locally without your accounts or provider choices:

- domain and HTTPS certificate
- production host or cloud project
- email/passkey/OAuth provider credentials
- bridge and replay signing secrets
- persistent object storage or volume location
- monitoring destination for `/api/metrics`
