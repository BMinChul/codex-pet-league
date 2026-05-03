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
- Server-authoritative battle simulation for ranked, casual, friend, and training battles.
- LP and tier/division updates for ranked battles.
- Leaderboard and server event log.
- Node test coverage for core rules.

## Scripts

```bash
npm test
npm start
npm run dev
```

Runtime state is stored in `data/league-state.json` and ignored by git.
