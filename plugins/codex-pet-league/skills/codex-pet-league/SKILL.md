---
name: codex-pet-league
description: Use the Codex Pet League plugin to manage official pets, Training Reports, matchmaking, Friend Duel invites, 30-second turn battles, replays, leaderboard checks, and daily XP from Codex App.
---

# Codex Pet League

Use this skill when the user asks about their Codex pet, official `hatch-pet` package import, daily XP, Training Reports, matchmaking, invite codes, turn battles, replays, leaderboard, or anti-cheat/admin status.

## Operating Rules

- Treat Codex App and CLI as the primary play surfaces. The web UI is a companion surface for profiles, leaderboards, replays, visual inspection, and operations.
- Treat OpenAI `hatch-pet` output as the primary pet asset source. The expected package is `${CODEX_HOME:-~/.codex}/pets/<pet-id>/pet.json` plus `spritesheet.webp`.
- Treat the League server as authoritative. Do not infer XP, LP, rank, battle results, or replay outcomes locally.
- Prefer MCP tools when available. Use CLI commands as the fallback bridge.
- Official actions require `CODEX_PET_SESSION_TOKEN` or a League session cookie. `CODEX_PET_ACCOUNT_ID` is only a local development fallback.
- Training Reports must come from observable Codex work signals and should be drafted before submission when the user wants to review.
- Battle turns are simultaneous and have a 30-second deadline. If the user gives no action, recommend `guard` for low HP, `focus` for low energy, otherwise `strike`.
- User skill aliases are cosmetic. Never change the server skill ids unless the user explicitly changes the four-skill loadout.

## Common MCP Flow

1. `league_home` for a combined account, active pet, XP, queue, and leaderboard snapshot.
2. `next_action` when the user asks what to do next.
3. `pet_import_hatch` with `package_path` to upload a Codex `hatch-pet` package and register an official pet.
4. `pet_create` with `atlas_path` only for direct PNG/WebP spritesheet uploads.
5. `league_play` for the Codex App loop: inspect active state, optionally join queue, optionally submit the recommended turn.
6. `training_report_draft`, then `training_report_submit` after user approval.
7. `matchmaking_join` for random ranked or casual queue.
8. `friend_invite_create` and `friend_invite_accept` for invite-code battles.
9. `battle_get`, `battle_action_options`, then `battle_action` for active turns.

## CLI Fallbacks

```powershell
npm run cli -- home
npm run cli -- next
npm run cli -- daily
npm run cli -- pet import-hatch --path C:\Users\you\.codex\pets\pebble --primary Forge --secondary Trace
npm run cli -- pet create --name Pebble --primary Forge --secondary Trace --atlas C:\path\spritesheet.webp
npm run cli -- report draft --implementation --verification --tests-run 3
npm run cli -- report submit --milestone --files large
npm run cli -- queue join --mode ranked
npm run cli -- invite create
npm run cli -- invite accept --code ABC123
npm run cli -- battle watch --battle battle_room_id
npm run cli -- battle play --battle battle_room_id
npm run cli -- battle play --battle battle_room_id --auto
npm run cli -- battle actions --battle battle_room_id
npm run cli -- battle action --battle battle_room_id --kind strike
```

## User-Facing Trigger Phrases

- "내 펫 상태 보여줘" -> `league_home`
- "내 hatch-pet 펫 서버에 올려줘" -> `pet_import_hatch`
- "오늘 XP 얼마나 남았어" -> `pet_status` or `daily`
- "훈련 리포트 만들어줘" -> `training_report_draft`
- "오늘 작업 제출해줘" -> `training_report_submit`
- "랭크 랜덤매칭 잡아줘" -> `matchmaking_join` with `ranked`
- "친구초대 코드 만들어줘" -> `friend_invite_create`
- "지금 배틀에서 뭐해야돼" -> `battle_action_options`, then recommend one action
- "지금 Codex App에서 한 턴 진행해줘" -> `league_play` with `submit_recommended_action`
