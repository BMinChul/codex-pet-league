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

## Season Loop

1. End the active season with `end_current`.
2. Review generated season rewards.
3. Start the next season with `start_next`.
4. Confirm pets receive fresh season ratings before ranked matchmaking.

## Runtime Checks

```bash
npm run ops:check
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
