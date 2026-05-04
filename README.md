# Codex Pet League

Public local/self-host preview for the Codex App and Codex CLI-first pet league.

## Release Model

This repository is intended to be public before the official shared League server is operated.

- Local run: clone this repo, run the League server on your own machine, and connect the CLI/MCP bridge to it.
- Self-host run: deploy your own server and point `CODEX_PET_LEAGUE_URL` at that HTTPS endpoint.
- Official shared League server: planned later. Do not treat this repo's local development auth, state files, or secrets as production service credentials.

## Local Run

Install dependencies:

```bash
npm install
```

Start the local League server:

```bash
CODEX_PET_AUTH_DEV_CODE=true npm start
```

PowerShell:

```powershell
$env:CODEX_PET_AUTH_DEV_CODE="true"; npm start
```

Then open:

```text
http://localhost:4317
```

In another terminal, check the CLI bridge:

```bash
npm run cli -- doctor
npm run cli -- home
```

## What Works

- League demo account session.
- Public pet asset registration with server-side manifest validation.
- Official `hatch-pet` package import: `pet.json` plus `spritesheet.webp` from `${CODEX_HOME:-~/.codex}/pets/<pet-id>`.
- `hatch-pet` import provenance: manifest hash, spritesheet hash, package fingerprint, immutable server source fingerprint, and cross-account duplicate review signals.
- Multiple local `hatch-pet` packages can be discovered, but each League account has one permanent active official pet selection. Switching is blocked after the first selection.
- Optional Codex hatch spritesheet PNG/WebP upload, with server-side dimension, MIME, and hash validation.
- Local filesystem atlas storage and public atlas URLs for visible active pets.
- Official pet creation with primary and secondary elements.
- Server-derived stats, level, Battle Class, skill loadout, and ranked rating.
- Training Report draft and submit flow with risk scoring and review holds.
- Daily XP cap display:
  - Pet XP `700/day`
  - Training XP `400/day`
  - Battle XP `300/day`
  - Friend Duel XP `75/day`
  - Style XP `1,000/day`, `5,000/week`
- Server-authoritative 30-second turn battle rooms with Strike, Guard, Focus, Skill, turn nonce freshness, replay hash chain, and AFK loss.
- Random PvP matchmaking with same Battle Class and LP-window matching.
- Active season tracking. Season 1 runs from `2026-05-03` to `2026-08-01`.
- Ranked queue LP windows expand with wait time: `150 -> 300 -> 500 -> 800`.
- Friend Duel invite codes that create PvP turn battle rooms.
- Real-time browser updates over `/api/live` SSE.
- Skill loadout updates with cosmetic skill aliases.
- Public pet profiles and replay logs.
- Cookie-backed auth challenge/session flow for passkey, magic link, and OAuth-shaped account binding.
- Local audit checks for XP/LP/replay/risk/event-log integrity with tamper-evident hash chains.
- Anti-cheat request guards for rate limits, idempotency/replay prevention, repeated Training Report evidence, and asset upload abuse.
- Server authority ops job for matchmaking, settlement reconciliation, audit review, and abuse alert generation.
- Deployment readiness endpoints: `/api/health` JSON and `/api/metrics` Prometheus-style text.
- Admin operations console for held Training Reports, moderation queue, risk cases, manual enforcement, and season operations.
- Asset report/moderation flow with report threshold privacy protection.
- Level cosmetic rewards and season reward generation for non-ranked and ranked loops.
- Public pet profile, skill alias controls, replay timeline, queue/invite status cards, and battle-side asset previews.
- Sandbox battle simulation for result testing. It does not award official XP or ranked LP.
- LP and tier/division updates only for official Ranked PvP matchmaking battles.
- Leaderboard and server event log.
- Node test coverage for core rules.

## Play Surface Priority

Codex App and Codex CLI are the primary play surfaces. The web UI remains useful for visible battle review, profile pages, leaderboards, replays, and admin/ops work, but normal Codex Pet League play should work from the tools Codex users already live in.

- Codex App: MCP tools handle natural-language pet status, `hatch-pet` package import, Training Reports, matchmaking, action recommendations, and turn submissions.
- Codex CLI: terminal commands handle the same flow, including `pet import-hatch`, game-like `battle watch`, and `battle play` modes.
- Web: optional companion UI for public browsing, visual battle inspection, leaderboards, and operations.

## Codex Active Pet Source

OpenAI's public `hatch-pet` contract documents local packages under `${CODEX_HOME:-~/.codex}/pets/<pet-id>` with `pet.json` and `spritesheet.webp`. Public Codex App documentation does not currently document a verifiable API or signed claim for reading the user's currently selected active Codex pet. Until OpenAI exposes that, Codex Pet League treats local discovery as candidate input only and makes the League server's first active pet selection authoritative and permanent per account.

The importer validates the local package before upload: `pet.json` must include `id`, `displayName`, `description`, and a safe relative `spritesheetPath`; the spritesheet must be PNG or WebP, match the official `1536x1872` atlas contract, and remain inside the package directory. The server recomputes hashes after upload and never trusts client-provided hashes as authority.

Official Codex docs say Codex CLI/App can be used after signing in with ChatGPT, but that is Codex product access, not a League-verifiable account token. League login remains passkey, email magic link, or League OAuth until OpenAI documents a signed identity claim for third-party League servers.

## Scripts

```bash
npm test
npm run test:runtime
npm run test:abuse
npm run test:storage
npm run test:load
npm run test:browser
npm run db:migrate -- data/league-state.json data/league-state.sqlite
npm run db:schema:check
npm run db:postgres:migrate
npm run prod:check
npm run backup
npm run verify:loop -- 2
npm run ops:check
npm start
npm run dev
npm run cli -- help
```

Runtime state is stored in `data/league-state.json` by default and ignored by git.
Set `CODEX_PET_STORAGE_DRIVER=sqlite` with `CODEX_PET_SQLITE_PATH` to use the SQLite snapshot backend. It keeps transaction-protected, hashable state snapshots with WAL enabled, and `npm run db:migrate -- <json> <sqlite>` moves the current JSON state into that backend.
Set `CODEX_PET_STORAGE_DRIVER=postgres` with `CODEX_PET_POSTGRES_URL` to use the Postgres snapshot backend. Run `npm run db:postgres:migrate` against the target database before switching production traffic.

## CLI Bridge

The CLI is the local bridge that Codex App slash commands or natural-language tool triggers can call.

```powershell
npm run cli -- setup --path <hatch-pet-folder> --yes --primary Forge --secondary Trace
npm run cli -- doctor
npm run cli -- home
npm run cli -- next
npm run cli -- daily
npm run cli -- session
npm run cli -- session list
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
npm run cli -- auth verify --challenge auth_challenge_id --code 123456
npm run cli -- auth providers
npm run cli -- bridge status
npm run cli -- league
npm run cli -- pet discover-hatch
npm run cli -- pet inspect-hatch --path <hatch-pet-folder>
npm run cli -- pet import-hatch --path <hatch-pet-folder> --primary Forge --secondary Trace
npm run cli -- pet activate --pet pet_id
npm run cli -- pet create --name Pebble --primary Forge --secondary Trace
npm run cli -- pet profile
npm run cli -- pet loadout --skills forge_offense,forge_defense,forge_status,trace_offense --aliases forge_offense=Hammer
npm run cli -- pet replays
npm run cli -- pets
npm run cli -- xp status
npm run cli -- report draft --implementation --verification --tests-run 3
npm run cli -- report submit --milestone --files large
npm run cli -- battle start --mode casual
npm run cli -- battle actions --battle battle_room_id
npm run cli -- battle watch --battle battle_room_id --once
npm run cli -- battle play --battle battle_room_id --auto
npm run cli -- battle action --battle battle_room_id --kind strike
npm run cli -- battle get --battle battle_room_id
npm run cli -- queue join --mode ranked
npm run cli -- queue status
npm run cli -- queue cancel --ticket ticket_id
npm run cli -- invite create
npm run cli -- invite accept --code ABC123
npm run cli -- audit
npm run cli -- battle simulate --mode ranked --result win --opponent-lp 1500
npm run cli -- leaderboard
```

Natural-language trigger mapping:

```text
리그 상태 점검해줘 -> codexpet doctor
내 펫 홈 보여줘 -> codexpet home
다음에 뭐 해야돼 -> codexpet next
오늘 남은 XP 보여줘 -> codexpet daily
펫 훈련 리포트 만들어줘 -> codexpet report draft
오늘 작업 pet XP로 제출해줘 -> codexpet report submit
펫 XP 상태 보여줘 -> codexpet xp status
내 hatch-pet 펫 찾아줘 -> codexpet pet discover-hatch
이 hatch-pet 파일 검증해줘 -> codexpet pet inspect-hatch --path <hatch-pet-folder>
처음 시작 세팅해줘 -> codexpet setup --path <hatch-pet-folder> --yes
내 hatch-pet 펫 서버에 올려줘 -> codexpet pet import-hatch --path <hatch-pet-folder>
처음 선택한 펫을 공식으로 확정할래 -> codexpet pet activate --pet <pet-id>
내 펫 서버에 올려줘 -> codexpet pet create --atlas <path.png|path.webp>
지금 배틀 액션 뭐 가능해 -> codexpet battle actions --battle <id>
터미널에서 배틀판 보여줘 -> codexpet battle watch --battle <id>
추천 액션으로 한 턴 해줘 -> codexpet battle play --battle <id> --auto
```

Environment:

```bash
CODEX_PET_LEAGUE_URL=http://localhost:4317
CODEX_PET_DEPLOYMENT_ENV=local
CODEX_PET_STATE_PATH=./data/league-state.json
CODEX_PET_SESSION_TOKEN=league_session_token
CODEX_PET_ACCOUNT_ID=acct_demo
CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false
CODEX_PET_AUTH_PROVIDER=local_dev
CODEX_PET_AUTH_DEV_CODE=false
CODEX_PET_COOKIE_SECURE=false
CODEX_PET_PUBLIC_BASE_URL=http://localhost:4317
CODEX_PET_EMAIL_PROVIDER=webhook
CODEX_PET_EMAIL_WEBHOOK_URL=https://email-provider.example/send
CODEX_PET_AUTH_WEBHOOK_SECRET=shared_auth_hook_secret
CODEX_PET_EMAIL_WEBHOOK_SECRET=shared_email_hmac_secret
CODEX_PET_PASSKEY_PROVIDER=true
CODEX_PET_PASSKEY_VERIFY_URL=https://passkey-provider.example/verify
CODEX_PET_PASSKEY_RP_ID=league.example.com
CODEX_PET_OAUTH_ISSUER=https://oauth-provider.example
CODEX_PET_OAUTH_AUTHORIZE_URL=https://oauth-provider.example/authorize
CODEX_PET_OAUTH_CLIENT_ID=codex-pet-league
CODEX_PET_OAUTH_REDIRECT_URI=https://league.example.com/oauth/callback
CODEX_PET_OAUTH_VERIFY_URL=https://oauth-provider.example/verify
CODEX_PET_BRIDGE_SECRET=shared_bridge_hmac_secret
CODEX_PET_BRIDGE_ATTESTATION_SECRET=shared_codex_app_attestation_secret
CODEX_PET_REPLAY_SIGNING_SECRET=shared_replay_signing_secret
CODEX_PET_OPS_JOB_INTERVAL_MS=60000
CODEX_PET_STORAGE_DRIVER=json
CODEX_PET_SQLITE_PATH=./data/league-state.sqlite
CODEX_PET_SQLITE_SNAPSHOT_RETENTION=500
CODEX_PET_POSTGRES_URL=
CODEX_PET_POSTGRES_SNAPSHOT_RETENTION=500
CODEX_PET_POSTGRES_SSL=false
CODEX_PET_POSTGRES_SSL_REJECT_UNAUTHORIZED=true
CODEX_PET_ASSET_STORAGE=local_fs
CODEX_PET_ASSET_ROOT=./data/assets
CODEX_PET_ASSET_CDN_BASE_URL=
CODEX_PET_S3_ENDPOINT=
CODEX_PET_S3_BUCKET=
CODEX_PET_S3_REGION=auto
CODEX_PET_S3_ACCESS_KEY_ID=
CODEX_PET_S3_SECRET_ACCESS_KEY=
CODEX_PET_REALTIME_BUS=local
CODEX_PET_REALTIME_CHANNEL=codex-pet-league:events
CODEX_PET_REQUEST_GUARD=local
CODEX_PET_REQUEST_GUARD_NAMESPACE=codex-pet-league
CODEX_PET_DISTRIBUTED_LOCK=local
CODEX_PET_LOCK_NAMESPACE=codex-pet-league
CODEX_PET_LOCK_TTL_MS=30000
CODEX_PET_REDIS_URL=
```

`CODEX_PET_SESSION_TOKEN` or the HttpOnly `league_session` cookie is the official request path. `CODEX_PET_ACCOUNT_ID` is a local development fallback and is disabled unless `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=true`.
`CODEX_PET_AUTH_DEV_CODE` exposes challenge codes for local testing only and defaults off. When `CODEX_PET_AUTH_PROVIDER` is not `local_dev`, auth fails closed unless at least one real method is fully configured: email magic-link webhook, passkey verify hook, or OAuth authorize plus verify hook.
Set `CODEX_PET_COOKIE_SECURE=true` behind HTTPS so League session cookies are marked `Secure`.
Email delivery and auth verification webhooks receive a signed JSON payload when `CODEX_PET_AUTH_WEBHOOK_SECRET` or `CODEX_PET_EMAIL_WEBHOOK_SECRET` is set. Passkey and OAuth verification hooks must return JSON with `verified: true` before the server creates an official League session.
Set `CODEX_PET_ASSET_STORAGE=s3_compatible` with the `CODEX_PET_S3_*` values to store hatch spritesheet PNG/WebP objects in S3-compatible object storage. If `CODEX_PET_ASSET_CDN_BASE_URL` is set, public pet profiles return CDN atlas URLs.
Set `CODEX_PET_REALTIME_BUS=redis`, `CODEX_PET_REQUEST_GUARD=redis`, and `CODEX_PET_DISTRIBUTED_LOCK=redis` with `CODEX_PET_REDIS_URL` when running more than one server instance. The Redis request guard shares rate-limit and idempotency buckets across instances, while Redis locks serialize matchmaking, ops jobs, and battle turn mutations. `npm run db:schema:check` validates the Postgres schema migrations under `db/migrations`; `npm run db:postgres:migrate` applies them to `CODEX_PET_POSTGRES_URL`.
`CODEX_PET_BRIDGE_SECRET` lets CLI/MCP sign Training Report payloads; `CODEX_PET_BRIDGE_ATTESTATION_SECRET` adds an app-attestation HMAC layer while official OpenAI identity remains unconfirmed. `CODEX_PET_REPLAY_SIGNING_SECRET` signs replay and audit-derived integrity records outside local development. Untrusted high-value reports are held for review.
High-impact mutation routes require a unique `request_id` or `Idempotency-Key`; the browser, CLI, and MCP bridge add one automatically.
Risk scores are review signals first. Automatic ranked lock only respects an explicit/manual `ranked_locked_until` or future tamper-confirmed policy, so false positives do not silently punish normal players.
`npm run test:load` starts a strict temp server, performs concurrent auth/read traffic, and checks security headers on `/api/health`.

See `docs/OPERATIONS.md` for runtime operations and `docs/DEPLOYMENT.md` for container deployment, production checks, backup, and the final user-owned setup list.

## Codex App MCP Bridge

The MCP bridge exposes the same product actions as tools:

- `league_doctor`
- `auth_challenge`
- `auth_verify`
- `league_setup`
- `league_home`
- `next_action`
- `league_play`
- `pet_status`
- `pet_create`
- `pet_discover_hatch`
- `pet_inspect_hatch`
- `pet_import_hatch`
- `pet_activate`
- `league_status`
- `pet_profile`
- `pet_loadout_update`
- `pet_replays`
- `training_report_draft`
- `training_report_submit`
- `battle_simulate`
- `battle_start`
- `battle_action`
- `battle_get`
- `battle_action_options`
- `matchmaking_join`
- `matchmaking_status`
- `matchmaking_cancel`
- `admin_audit`
- `friend_invite_create`
- `friend_invite_accept`
- `leaderboard`

Run directly:

```bash
npm run mcp
```

Example Codex CLI registration from the repo root:

```powershell
$repo = (Get-Location).Path
codex mcp add codex-pet-league -- node "$repo\src\mcp\codex-pet-mcp.cjs"
```

The League server must be running at `CODEX_PET_LEAGUE_URL` before tool calls can create pets, submit reports, or resolve battles.

## Codex App Plugin

This repo includes a local Codex App plugin scaffold at `plugins/codex-pet-league`.

- Manifest: `plugins/codex-pet-league/.codex-plugin/plugin.json`
- MCP config: `plugins/codex-pet-league/.mcp.json`
- Skill guide: `plugins/codex-pet-league/skills/codex-pet-league/SKILL.md`
- Marketplace entry: `.agents/plugins/marketplace.json`

The plugin MCP config points to `./scripts/codex-pet-mcp.cjs`, a small launcher that starts the repo's `src/mcp/codex-pet-mcp.cjs` bridge. By default it expects the League server at `http://localhost:4317`; set `CODEX_PET_LEAGUE_URL` to a self-hosted HTTPS server when you are not using the local server.

Plugin scaffold flow for a cloned repo:

```powershell
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
$env:CODEX_PET_AUTH_DEV_CODE="true"; npm start
```

Then register MCP directly with Codex CLI from another terminal, or use the repo-local plugin scaffold through `.agents/plugins/marketplace.json` in environments that load local Codex plugins.

## Privacy And Terms

This public preview is local/self-host first. When you run it locally, state stays in your configured local or self-hosted storage. Do not commit `.env`, `data/`, runtime logs, uploaded pet assets, database files, service credentials, or session tokens.

An official shared League server will need separate production privacy, terms, moderation, account, retention, and operations policies before it is opened to users.
