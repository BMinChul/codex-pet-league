# Codex Pet League Operations

This project still uses the JSON store until the final DB migration, so production-like operation means keeping every authoritative decision server-side and tamper-evident.

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
npm run verify:loop -- 2
```

Keep `CODEX_PET_AUTH_DEV_CODE=false` and `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false` outside local testing. Configure `CODEX_PET_BRIDGE_SECRET` and `CODEX_PET_BRIDGE_ATTESTATION_SECRET` before trusting high-value Training Reports from CLI or MCP bridge flows.
