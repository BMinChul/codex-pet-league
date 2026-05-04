---
name: codex-pet-league
description: Use the Codex Pet League plugin to manage official pets, Training Reports, matchmaking, Friend Duel invites, 30-second turn battles, replays, leaderboard checks, and daily XP from Codex App.
---

# Codex Pet League

Use this skill when the user asks about their Codex pet, official `hatch-pet` package import, daily XP, Training Reports, matchmaking, invite codes, turn battles, replays, leaderboard, or anti-cheat/admin status.

## Operating Rules

- Treat Codex App and CLI as the primary play surfaces. The web UI is a companion surface for profiles, leaderboards, replays, visual inspection, and operations.
- Treat OpenAI `hatch-pet` output as the primary pet asset source. The expected package is `${CODEX_HOME:-~/.codex}/pets/<pet-id>/pet.json` plus `spritesheet.webp`.
- Use package inspection/discovery before import when the user is unsure. Official imports expose manifest sha256, spritesheet sha256, package fingerprint, and server source fingerprint.
- Users can have multiple local `hatch-pet` packages, but League play uses one permanent active official pet per account. Do not switch it after the first League selection.
- Public Codex App documentation does not currently expose a verifiable "currently selected active pet" API to the League server. Treat local package discovery as candidate input, not proof of official League identity.
- Codex CLI/App can sign in with ChatGPT for Codex access, but that does not currently give this League server a verified OpenAI account identity token.
- Treat the League server as authoritative. Do not infer XP, LP, rank, battle results, or replay outcomes locally.
- Prefer MCP tools when available. Use CLI commands as the fallback bridge.
- Official actions require `CODEX_PET_SESSION_TOKEN` or a League session cookie. `CODEX_PET_ACCOUNT_ID` is only a local development fallback.
- The official shared alpha server is `https://league.codexpetz.com`. Use `CODEX_PET_LEAGUE_URL=https://league.codexpetz.com` unless the user is running local or self-hosted.
- Training Reports must come from observable Codex work signals and should be drafted before submission when the user wants to review.
- Battle turns are simultaneous and have a 30-second deadline. If the user gives no action, recommend `guard` for low HP, `focus` for low energy, otherwise `strike`.
- User skill aliases are cosmetic. Never change the server skill ids unless the user explicitly changes the four-skill loadout.

## Common MCP Flow

1. `auth_challenge` and `auth_verify` when the user has no League session token yet; tell the user to set the returned `CODEX_PET_SESSION_TOKEN` before official actions.
2. `league_setup` for first-run onboarding. It checks League session, discovers hatch packages, requires permanent-selection confirmation, imports the official pet, and returns the next action.
3. `league_home` for a combined account, active pet, XP, queue, and leaderboard snapshot.
4. `next_action` when the user asks what to do next.
5. `pet_discover_hatch` if the user has not provided a package path.
6. `pet_inspect_hatch` to validate a chosen package before upload.
7. `pet_import_hatch` with `package_path`, or no path when discovery finds exactly one package, to register an official pet.
8. `pet_activate` only before the first permanent League selection, or idempotently for the already active pet.
9. `pet_create` with `atlas_path` only for direct PNG/WebP spritesheet uploads.
10. `league_play` for the Codex App loop: inspect active state, optionally join queue, optionally submit the recommended turn.
11. `training_report_draft`, then `training_report_submit` after user approval.
12. `matchmaking_join` for random ranked or casual queue.
13. `friend_invite_create` and `friend_invite_accept` for invite-code battles.
14. `battle_get`, `battle_action_options`, then `battle_action` for active turns.
15. `league_doctor` when the user asks whether the local League server, auth, bridge, or runtime configuration is healthy.

## CLI Fallbacks

```powershell
npm run cli -- doctor
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
npm run cli -- auth verify --challenge challenge_id --code EMAILCODE
npm run cli -- home
npm run cli -- setup --path <hatch-pet-folder> --yes --primary Forge --secondary Trace
npm run cli -- next
npm run cli -- daily
npm run cli -- pet discover-hatch
npm run cli -- pet inspect-hatch --path <hatch-pet-folder>
npm run cli -- pet import-hatch --path <hatch-pet-folder> --primary Forge --secondary Trace
npm run cli -- pet activate --pet pet_id
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
- "리그 상태 점검해줘" -> `league_doctor` or `codexpet doctor`
- "처음 시작 세팅해줘" -> `league_setup`
- "내 hatch-pet 펫 찾아줘" -> `pet_discover_hatch`
- "이 hatch-pet 파일 검증해줘" -> `codexpet pet inspect-hatch --path <folder>` or `pet_discover_hatch` if no path is known
- "내 hatch-pet 펫 서버에 올려줘" -> `pet_import_hatch`
- "처음 선택한 펫을 공식으로 확정할래" -> `pet_activate`
- "오늘 XP 얼마나 남았어" -> `pet_status` or `daily`
- "훈련 리포트 만들어줘" -> `training_report_draft`
- "오늘 작업 제출해줘" -> `training_report_submit`
- "랭크 랜덤매칭 잡아줘" -> `matchmaking_join` with `ranked`
- "친구초대 코드 만들어줘" -> `friend_invite_create`
- "지금 배틀에서 뭐해야돼" -> `battle_action_options`, then recommend one action
- "지금 Codex App에서 한 턴 진행해줘" -> `league_play` with `submit_recommended_action`
