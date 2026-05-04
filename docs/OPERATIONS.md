# Codex Pet League Operations

This project defaults to the JSON store for local development. For production-like runs, switch to `CODEX_PET_STORAGE_DRIVER=postgres`, keep authoritative decisions server-side, and keep the audit trails tamper-evident.

## Daily Loop

1. Run the server authority job from the admin console or `POST /api/admin/ops/run`.
2. Review held Training Reports before granting XP.
3. Check abuse alerts for rate-limit bursts, replay attempts, repeated evidence, cross-account hatch fingerprint reuse, and asset reports.
4. Resolve asset moderation cases as `clear`, `quarantine`, or `hide`.
5. Use ranked locks only as a manual review outcome, not as an automatic risk-score side effect.

## Moderation Loop

Production moderation uses the OpenAI Moderation API with `omni-moderation-latest` for image/text triage, plus manual admin review for final quarantine/block decisions.

Review asset cases with the existing actions:

- `clear`: restore `safety_status=clear` and `visibility=public`.
- `quarantine`: set `safety_status=review` and `visibility=private`; the pet cannot enter ranked while review is open.
- `hide`: set `safety_status=blocked` and `visibility=private`; the pet cannot enter any battle.

Moderation output is not an automatic account penalty. Use category flags, category scores, user reports, duplicate-source evidence, and visible asset context together before blocking content or applying account enforcement. If an already-public asset becomes quarantined or hidden, purge or remove the public R2/custom-domain object path as part of the same moderation action.

## Admin Access Loop

Production admin access is tied to verified League accounts with server-side `role=admin` and the server-side `CODEX_PET_ADMIN_EMAIL_ALLOWLIST`. Email-code login proves control of the owner email address for the low-cost alpha; the League server decides the role, and the allowlist is the final gate.

Before launch:

1. Verify the first owner account through Resend email-code login.
2. Promote only that account to `role=admin` with a controlled one-off operation:

```bash
npm run admin:bootstrap -- --email=owner@example.com
```

Use `--dry-run` first when checking the target account. The script promotes only the exact email passed with `--email`, refuses emails outside `CODEX_PET_ADMIN_EMAIL_ALLOWLIST` when configured, refuses local demo accounts unless `--allow-local` is explicitly provided, requires the account to already exist, and requires `verified: true`. During the real production bootstrap, local demo admin accounts ending in `@codexpet.local` are demoted so the owner email is the first real admin.
3. Confirm `/api/admin/audit` rejects normal players and accepts only the promoted admin session.
4. Confirm `CODEX_PET_AUTH_DEV_CODE=false`, `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false`, `CODEX_PET_ADMIN_EMAIL_ALLOWLIST=<owner-email>`, `CODEX_PET_PUBLIC_BASE_URL=https://league.<domain>`, and `CODEX_PET_COOKIE_SECURE=true`.

During operations, admin role changes should be rare and auditable. The official shared server keeps the owner as the only admin unless the owner explicitly authorizes another email. Revoke sessions after removing admin access, remove the email from `CODEX_PET_ADMIN_EMAIL_ALLOWLIST`, and avoid using Render dashboard or database access as a routine moderation tool.

## Season Loop

1. End the active season with `end_current`.
2. Review generated season rewards.
3. Start the next season with `start_next`.
4. Confirm pets receive fresh season ratings before ranked matchmaking.

## Runtime Checks

```bash
npm run ops:check
npm run monitor:official
npm run cost:check
npm run test:abuse
npm run test:storage
npm run test:load
npm run test:browser
npm run balance:sim
npm run db:schema:check
npm run db:postgres:migrate
npm run verify:loop -- 2
npm run prod:check
npm run cli -- doctor
```

Use `/api/health` for load balancer checks and `/api/metrics` for scraping runtime counts such as accounts, pets, active battles, waiting match tickets, held Training Reports, and open abuse alerts.
Keep `CODEX_PET_AUTH_DEV_CODE=false` and `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false` outside local testing. Configure `CODEX_PET_BRIDGE_SECRET` and `CODEX_PET_BRIDGE_ATTESTATION_SECRET` before trusting high-value Training Reports from CLI or MCP bridge flows.
Set `CODEX_PET_COOKIE_SECURE=true` when serving over HTTPS.
SQLite remains useful for local persistence: migrate once with `npm run db:migrate -- data/league-state.json data/league-state.sqlite`, then set `CODEX_PET_STORAGE_DRIVER=sqlite` and `CODEX_PET_SQLITE_PATH=data/league-state.sqlite`.
Before a Postgres run, set `CODEX_PET_POSTGRES_URL`, run `npm run db:postgres:migrate`, then set `CODEX_PET_STORAGE_DRIVER=postgres`.
Keep `CODEX_PET_ASSET_ROOT` on persistent storage. The server stores uploaded hatch atlas PNG/WebP objects under that root and serves visible active pets through `/api/assets/:asset_id/atlas`; private or blocked assets return 404. Asset records include atlas sha256, hatch manifest sha256, source fingerprint, and provenance metadata for audit review. Private or review-state assets are blocked from ranked matchmaking; safety-blocked assets cannot enter battles.
For S3-compatible storage, set `CODEX_PET_ASSET_STORAGE=s3_compatible` and keep the bucket private unless a CDN URL is configured.
For more than one server instance, set `CODEX_PET_REALTIME_BUS=redis`, `CODEX_PET_REQUEST_GUARD=redis`, and `CODEX_PET_DISTRIBUTED_LOCK=redis`, then point `CODEX_PET_REDIS_URL` at the shared Redis deployment.
Run `npm run backup` before upgrades or risky maintenance.

The admin console shows open review cases, audit findings, active abuse alerts, recent risk events, enforcement history, and asset moderation history. Audit-driven alerts are review-only signals; ranked locks stay manual to avoid false-positive punishment. Audit also recomputes pet XP, level, stats, Battle Class, Style XP, and ranked LP from server ledgers so direct state tampering is visible before ops sign-off.

## Public Alpha Pages

The official shared alpha exposes these public operating pages:

- `https://league.codexpetz.com/status`: browser status page backed by `/api/health`, with links to `/api/health` and `/api/metrics`.
- `https://league.codexpetz.com/support`: support process, GitHub Issues link, moderation-report guidance, and secret-sharing warnings.
- `https://league.codexpetz.com/privacy`: alpha privacy notice.
- `https://league.codexpetz.com/terms`: alpha operating terms.

The status page is a public convenience view, not a full alerting system. Keep provider dashboards and any future external monitors pointed at `/api/health`, `/api/metrics`, Render deploy status, Postgres, Redis, Resend, R2, and OpenAI moderation usage.

GitHub Actions runs `.github/workflows/official-monitor.yml` every 15 minutes against the official shared alpha. The monitor fails when `/api/health` is not `ok`, production providers drift away from Postgres/Redis, `/api/metrics` is missing expected gauges, or the public operating pages stop rendering. Run the same check manually with:

```bash
npm run monitor:official
```

Use `CODEX_PET_MONITOR_BASE_URL=https://league.<domain>` for self-host checks. Set `CODEX_PET_MONITOR_FAIL_ON_ALERTS=true` only when open abuse alerts should fail the monitor instead of remaining a manual review signal.

## Backup Loop

Run a manual backup before risky deploys, schema work, provider changes, or moderation cleanups:

```bash
npm run backup -- runs/backups/manual-YYYYMMDD-HHMM
```

The script copies JSON/SQLite state, local atlas objects, and a Postgres state snapshot when the process is pointed at a Postgres runtime. On Render one-off jobs, files are written to the job's ephemeral filesystem, so treat that as a smoke check unless the artifact is retrieved immediately. For the official shared server, keep Render Postgres managed backups enabled and use a separate private backup bucket if durable exported snapshots are later added. Do not put state backups in the public R2 asset bucket or under `assets.codexpetz.com`.

## Cost Guard Loop

Run the cost guard daily during alpha and after any traffic spike:

```bash
npm run cost:check
npm run cost:check -- --json
```

This is not provider billing data. It is a local sentinel over League state for the costs we can cause directly: email-code challenges, asset uploads/storage growth, open abuse alerts, and open asset reports. The command exits nonzero only on `critical` thresholds, while `warning` means review dashboards and usage before raising quotas or enabling overages.

Default thresholds are controlled by:

```bash
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

If email challenges cross warning, keep Resend overages disabled, confirm the 10-minute IP rate limit is active, and inspect `/api/metrics` plus provider logs. If asset storage crosses warning, inspect recent uploads and moderation queue before increasing R2 or CDN exposure.

If `npm run audit:summary -- --json` reports only `event_log_hash_invalid` after moving state through Postgres JSONB, the likely cause is legacy order-sensitive hashes. The runtime now uses stable JSON hashing; run a dry check first, then apply the one-time chain rebase only if the finding shape is understood:

```bash
npm run ops:rehash
npm run ops:rehash -- --apply
```

Do not use `ops:rehash` to hide unexplained tampering. Use it only for the stable JSON hash migration or another documented hash-format migration.

After audit findings are cleared, resolve stale audit-generated abuse alerts so cost guard reflects current risk instead of historical resolved findings:

```bash
npm run ops:resolve-audit-alerts
npm run ops:resolve-audit-alerts -- --apply
```

This only closes open abuse alerts whose `audit:*` dedupe key no longer corresponds to an active high/critical audit finding.

## Incident Loop

When the site is down, slow, under abuse, or behaving oddly, collect a redacted pack first:

```bash
npm run incident:pack
npm run incident:pack -- runs/incidents/incident-YYYYMMDD-HHMM
```

Set `CODEX_PET_INCIDENT_BASE_URL=https://league.codexpetz.com` when collecting from the official shared server. The pack writes:

- `health.json` from `/api/health`.
- `metrics.txt` from `/api/metrics`.
- `state-summary.json` with redacted counts, queues, recent event metadata, open reviews, and open abuse alerts.
- `cost-guard.json` with the same usage threshold view as `npm run cost:check`.
- `manifest.json` describing what was collected.

The pack intentionally does not dump full state, session tokens, API keys, provider credentials, raw source code, or full user report contents.

Triage order:

1. Confirm `/api/health`, `/api/metrics`, and Render service/deploy status.
2. Run `npm run prod:check`, `npm run audit:summary`, and `npm run cost:check` in the same runtime environment.
3. Check Postgres, Redis, Resend, R2, and OpenAI provider dashboards for outages or quota limits.
4. If auth email usage spikes, keep overages off and temporarily pause public login links if needed.
5. If assets or moderation spike, quarantine suspicious assets manually; do not auto-punish accounts from risk scores alone.
6. Roll back the latest Render deploy if the incident began immediately after a deploy.
