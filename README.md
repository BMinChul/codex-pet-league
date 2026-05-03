# Codex Pet League

Local product prototype for the Codex App exclusive pet league.

## Run

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

## What Works

- League demo account session.
- Public pet asset registration with server-side manifest validation.
- Optional Codex hatch atlas PNG upload, with server-side PNG dimension and hash validation.
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
- Sandbox battle simulation for result testing. It does not award official XP or ranked LP.
- LP and tier/division updates only for official Ranked PvP matchmaking battles.
- Leaderboard and server event log.
- Node test coverage for core rules.

## Scripts

```bash
npm test
npm run test:runtime
npm run verify:loop -- 2
npm start
npm run dev
npm run cli -- help
```

Runtime state is stored in `data/league-state.json` and ignored by git.
The JSON store is dev-only. It now writes atomically with temp-file rename and ledger hash chains, but production must use a real append-only database.

## CLI Bridge

The CLI is the local bridge that Codex App slash commands or natural-language tool triggers can call.

```bash
npm run cli -- session
npm run cli -- session list
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
npm run cli -- auth verify --challenge auth_challenge_id --code 123456
npm run cli -- league
npm run cli -- pet create --name Pebble --primary Forge --secondary Trace
npm run cli -- pet profile
npm run cli -- pet loadout --skills forge_offense,forge_defense,forge_status,trace_offense --aliases forge_offense=Hammer
npm run cli -- pet replays
npm run cli -- pets
npm run cli -- xp status
npm run cli -- report draft --implementation --verification --tests-run 3
npm run cli -- report submit --milestone --files large
npm run cli -- battle start --mode casual
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
펫 훈련 리포트 만들어줘 -> codexpet report draft
오늘 작업 pet XP로 제출해줘 -> codexpet report submit
펫 XP 상태 보여줘 -> codexpet xp status
내 펫 서버에 올려줘 -> codexpet pet create --atlas <path>
```

Environment:

```bash
CODEX_PET_LEAGUE_URL=http://localhost:4317
CODEX_PET_STATE_PATH=C:\path\to\league-state.json
CODEX_PET_SESSION_TOKEN=league_session_token
CODEX_PET_ACCOUNT_ID=acct_demo
CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=false
CODEX_PET_AUTH_DEV_CODE=false
CODEX_PET_BRIDGE_SECRET=shared_bridge_hmac_secret
```

`CODEX_PET_SESSION_TOKEN` or the HttpOnly `league_session` cookie is the official request path. `CODEX_PET_ACCOUNT_ID` is a local development fallback and is disabled unless `CODEX_PET_ALLOW_DEV_ACCOUNT_HEADER=true`.
`CODEX_PET_AUTH_DEV_CODE` exposes challenge codes for local testing only and defaults off. Production auth should deliver codes through the chosen email/passkey/OAuth provider.
`CODEX_PET_BRIDGE_SECRET` lets CLI/MCP sign Training Report payloads; untrusted high-value reports are held for review.
High-impact mutation routes require a unique `request_id` or `Idempotency-Key`; the browser, CLI, and MCP bridge add one automatically.
Risk scores are review signals first. Automatic ranked lock only respects an explicit/manual `ranked_locked_until` or future tamper-confirmed policy, so false positives do not silently punish normal players.

## Codex App MCP Bridge

The MCP bridge exposes the same product actions as tools:

- `auth_challenge`
- `auth_verify`
- `pet_status`
- `pet_create`
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

Example Codex CLI registration:

```powershell
codex mcp add codex-pet-league -- node C:\Users\Chul\Desktop\codexpet\src\mcp\codex-pet-mcp.cjs
```

The League server must be running at `CODEX_PET_LEAGUE_URL` before tool calls can create pets, submit reports, or resolve battles.
