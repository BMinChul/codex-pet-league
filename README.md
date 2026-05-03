# Codex Pet League

Local product prototype for the Codex App exclusive pet league.

## Run

```bash
npm start
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
- Training Report draft and submit flow.
- Daily XP cap display:
  - Pet XP `700/day`
  - Training XP `400/day`
  - Battle XP `300/day`
  - Friend Duel XP `75/day`
  - Style XP `1,000/day`, `5,000/week`
- Server-authoritative 30-second turn battle rooms with Strike, Guard, Focus, Skill, replay hash, and AFK loss.
- Server-authoritative battle simulation for ranked, casual, friend, and training battle-result testing.
- LP and tier/division updates for ranked battles.
- Leaderboard and server event log.
- Node test coverage for core rules.

## Scripts

```bash
npm test
npm start
npm run dev
npm run cli -- help
```

Runtime state is stored in `data/league-state.json` and ignored by git.

## CLI Bridge

The CLI is the local bridge that Codex App slash commands or natural-language tool triggers can call.

```bash
npm run cli -- session
npm run cli -- pet create --name Pebble --primary Forge --secondary Trace
npm run cli -- pets
npm run cli -- xp status
npm run cli -- report draft --implementation --verification --tests-run 3
npm run cli -- report submit --milestone --files large
npm run cli -- battle start --mode casual
npm run cli -- battle action --battle battle_room_id --kind strike
npm run cli -- battle get --battle battle_room_id
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
CODEX_PET_ACCOUNT_ID=acct_demo
```

## Codex App MCP Bridge

The MCP bridge exposes the same product actions as tools:

- `pet_status`
- `pet_create`
- `training_report_draft`
- `training_report_submit`
- `battle_simulate`
- `battle_start`
- `battle_action`
- `battle_get`
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
