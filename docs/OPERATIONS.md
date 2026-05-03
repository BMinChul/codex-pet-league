# Codex Pet League Operations

This project defaults to the JSON store for local development. For production-like runs, switch to `CODEX_PET_STORAGE_DRIVER=sqlite`, keep authoritative decisions server-side, and keep the audit trails tamper-evident.

## Daily Loop

1. Run the server authority job from the admin console or `POST /api/admin/ops/run`.
2. Review held Training Reports before granting XP.
3. Check abuse alerts for rate-limit bursts, replay attempts, repeated evidence, and asset reports.
4. Resolve asset moderation cases as `clear`, `quarantine`, or `hide`.
5. Use ranked locks only as a manual review outcome, not as an automatic risk-score side effect.

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
npm run verify:loop -- 2
```

Use `/api/health` for load balancer checks and `/api/metrics` for scraping runtime counts such as accounts, pets, active battles, waiting match tickets, held Training Reports, and open abuse alerts.
Keep `CODEX_PET_AUTH_DEV_CODE=false` and `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false` outside local testing. Configure `CODEX_PET_BRIDGE_SECRET` and `CODEX_PET_BRIDGE_ATTESTATION_SECRET` before trusting high-value Training Reports from CLI or MCP bridge flows.
Before a SQLite run, migrate once with `npm run db:migrate -- data/league-state.json data/league-state.sqlite`, then set `CODEX_PET_STORAGE_DRIVER=sqlite` and `CODEX_PET_SQLITE_PATH=data/league-state.sqlite`.
Keep `CODEX_PET_ASSET_ROOT` on persistent storage. The server stores uploaded hatch atlas PNGs under that root and serves visible active pets through `/api/assets/:asset_id/atlas`; hidden or blocked assets return 404.

The admin console shows open review cases, audit findings, active abuse alerts, recent risk events, enforcement history, and asset moderation history. Audit-driven alerts are review-only signals; ranked locks stay manual to avoid false-positive punishment.
