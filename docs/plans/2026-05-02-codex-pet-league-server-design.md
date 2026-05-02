# Codex Pet League Server Design

Date: 2026-05-02
Status: Draft
Depends on: `2026-05-02-codex-pet-league-design.md`

## Goal

This document defines the server-side authority model, core data model, APIs, and realtime protocol for Codex Pet League.

The key design rule is simple: the server owns every value that can affect ranked play. The Codex App client owns only presentation, local convenience, and user intent submission.

## Architecture Overview

Recommended initial architecture:

- API service: HTTPS JSON API for accounts, pets, assets, skills, training, matchmaking, and profile data.
- Realtime service: WebSocket gateway for battle rooms and matchmaking updates.
- Battle engine: deterministic server module that validates actions and resolves turns.
- Worker service: moderation, asset processing, leaderboard snapshots, season jobs, replay export.
- Storage:
  - Postgres for accounts, pets, ranked data, battle logs, skill config, moderation state.
  - Object storage for pet atlas images and derived previews.
  - Redis or equivalent for matchmaking queues, active room state, connection presence, short TTL locks.

Postgres remains the source of truth. Redis may speed up active gameplay, but final ranked results and replay logs must be durably written by the server.

## Trust Boundaries

Trusted:

- League server code
- server-side battle engine
- server-side skill and balance config
- server-generated RNG seed and event log
- server-registered pet assets
- verified League account sessions

Untrusted:

- local Codex plugin state
- local hatch manifests
- local images
- local training analysis
- client clock
- client battle state
- client-reported battle result
- client-reported XP, LP, stats, cooldowns, energy, or HP

The client can request an action. The server decides whether it is legal and what happens.

## Core Entity Model

### Account

`accounts`

- `id`
- `display_name`
- `handle`
- `status`: `active`, `suspended`, `deleted`
- `created_at`
- `updated_at`

`account_identities`

- `id`
- `account_id`
- `provider`: `email`, `google`, `apple`, `github`, `passkey`, `openai_attested_future`
- `provider_subject`
- `verified_at`
- `created_at`

`sessions`

- `id`
- `account_id`
- `session_hash`
- `created_at`
- `expires_at`
- `revoked_at`
- `last_seen_at`

Ranked play requires an active account with at least one verified identity.

### Device Binding

`device_bindings`

- `id`
- `account_id`
- `device_public_key`
- `device_label`
- `created_at`
- `last_seen_at`
- `revoked_at`

Device binding improves abuse detection and session continuity, but device identity is not account authority by itself.

### Pet Asset

`pet_assets`

- `id`
- `owner_account_id`
- `canonical_hash`
- `atlas_object_key`
- `manifest_json`
- `width`
- `height`
- `cell_width`
- `cell_height`
- `columns`
- `rows`
- `moderation_status`: `pending`, `approved`, `rejected`, `quarantined`
- `created_at`
- `approved_at`

`pet_asset_revisions`

- `id`
- `asset_id`
- `revision_number`
- `canonical_hash`
- `atlas_object_key`
- `manifest_json`
- `moderation_status`
- `created_at`

Assets are immutable once approved. Revisions are new immutable records linked to the same visual lineage.

### Pet

`pets`

- `id`
- `owner_account_id`
- `pet_asset_id`
- `name`
- `status`: `active`, `retired`, `moderation_hold`
- `primary_element`
- `secondary_element`
- `secondary_unlocked_at`
- `created_at`
- `updated_at`

`pet_creation_rolls`

- `id`
- `pet_id`
- `candidate_elements_json`
- `selected_primary_element`
- `reroll_used`
- `created_at`
- `rerolled_at`

Primary element is chosen from server-accepted activity summary inputs. It affects starting template, not total starting power.

### Stats And Progression

`pet_stats`

- `pet_id`
- `power`
- `guard`
- `speed`
- `focus`
- `recovery`
- `insight`
- `stat_version`
- `updated_at`

`pet_progression`

- `pet_id`
- `level`
- `xp`
- `battle_xp`
- `training_xp`
- `progression_version`
- `updated_at`

The server derives these values. The client never submits final stats.

### Training

`training_reports`

- `id`
- `account_id`
- `pet_id`
- `client_report_id`
- `summary_json`
- `status`: `draft`, `submitted`, `approved`, `rejected`, `expired`
- `created_at`
- `approved_at`

`training_events`

- `id`
- `training_report_id`
- `pet_id`
- `event_type`
- `element_signal`
- `xp_delta`
- `server_reason`
- `created_at`

Training reports contain summarized signals only. They must not contain source code, full conversation transcripts, or private project content.

Server caps apply per day, week, season, and pet.

### Skills

`official_skills`

- `id`
- `official_name`
- `element`
- `base_description`
- `status`: `active`, `disabled`
- `created_at`

`skill_versions`

- `id`
- `skill_id`
- `season_id`
- `energy_cost`
- `cooldown_turns`
- `effect_json`
- `balance_notes`
- `active_from`
- `active_until`

`pet_skill_nicknames`

- `id`
- `pet_id`
- `skill_id`
- `nickname`
- `moderation_status`
- `updated_at`

`pet_loadouts`

- `id`
- `pet_id`
- `slot_1_skill_id`
- `slot_2_skill_id`
- `slot_3_skill_id`
- `slot_4_skill_id`
- `updated_at`

Official skill behavior is fixed by server config. Nicknames are cosmetic only.

### Seasons And Rating

`seasons`

- `id`
- `name`
- `starts_at`
- `ends_at`
- `status`: `scheduled`, `active`, `completed`
- `ruleset_version`

`league_ratings`

- `id`
- `season_id`
- `account_id`
- `pet_id`
- `lp`
- `tier`
- `wins`
- `losses`
- `draws`
- `last_match_at`

`leaderboard_snapshots`

- `id`
- `season_id`
- `snapshot_at`
- `snapshot_json`

LP and tier are server-generated from ranked battle results only.

### Matchmaking

`matchmaking_tickets`

- `id`
- `account_id`
- `pet_id`
- `mode`: `ranked`, `casual`
- `status`: `queued`, `matched`, `cancelled`, `expired`
- `rating_band_min`
- `rating_band_max`
- `region`
- `created_at`
- `matched_at`

`friend_rooms`

- `id`
- `room_code_hash`
- `host_account_id`
- `host_pet_id`
- `guest_account_id`
- `guest_pet_id`
- `status`: `open`, `ready`, `started`, `closed`, `expired`
- `created_at`
- `expires_at`

Friend codes and random matching both result in a battle room.

### Battle

`battle_rooms`

- `id`
- `season_id`
- `mode`: `ranked`, `casual`, `friend`
- `status`: `created`, `active`, `finished`, `cancelled`
- `ruleset_version`
- `rng_seed_commitment`
- `created_at`
- `started_at`
- `finished_at`

`battle_participants`

- `id`
- `battle_room_id`
- `account_id`
- `pet_id`
- `side`: `a`, `b`
- `connection_status`
- `result`: `win`, `loss`, `draw`, `afk_loss`, `cancelled`

`battle_turns`

- `id`
- `battle_room_id`
- `turn_number`
- `state_before_hash`
- `deadline_at`
- `resolved_at`
- `state_after_hash`

`battle_actions`

- `id`
- `battle_turn_id`
- `participant_id`
- `action_type`: `strike`, `skill`, `guard`, `focus`
- `skill_id`
- `submitted_at`
- `server_status`: `accepted`, `rejected`, `timeout_defaulted`
- `server_reason`

`battle_events`

- `id`
- `battle_room_id`
- `turn_number`
- `event_index`
- `event_type`
- `event_json`
- `created_at`

`battle_results`

- `battle_room_id`
- `winner_participant_id`
- `result_reason`
- `lp_delta_json`
- `xp_delta_json`
- `replay_hash`
- `created_at`

Battle logs are append-only. Ranked state is derived from `battle_results`.

## API Surface

All endpoints require HTTPS. Official account endpoints require a League session.

### Auth

- `POST /auth/start`
- `POST /auth/callback`
- `POST /auth/logout`
- `GET /me`
- `GET /me/sessions`
- `DELETE /me/sessions/{session_id}`

Recommended first login methods: passkey and email magic link. OAuth providers can be added without changing the battle model.

### Pet Assets

- `POST /pet-assets/uploads`
- `PUT /pet-assets/uploads/{upload_id}/file`
- `POST /pet-assets/uploads/{upload_id}/complete`
- `GET /pet-assets/{asset_id}`
- `GET /pet-assets/{asset_id}/manifest`
- `GET /pet-assets/{asset_id}/atlas`

Upload completion triggers validation and moderation. Ranked eligibility requires `moderation_status = approved`.

### Pets

- `POST /pets`
- `GET /pets`
- `GET /pets/{pet_id}`
- `PATCH /pets/{pet_id}/name`
- `POST /pets/{pet_id}/reroll-primary`
- `GET /pets/{pet_id}/secondary-candidates`
- `POST /pets/{pet_id}/secondary-element`

`POST /pets` requires an approved `pet_asset_id`.

### Training

- `POST /training/reports`
- `GET /training/reports/{report_id}`
- `POST /training/reports/{report_id}/approve`
- `POST /training/reports/{report_id}/reject`
- `GET /pets/{pet_id}/training-history`

The server may reject reports that exceed caps, look duplicated, contain disallowed content, or are inconsistent with account state.

### Skills

- `GET /skills/catalog`
- `GET /pets/{pet_id}/skills`
- `PATCH /pets/{pet_id}/skills/{skill_id}/nickname`
- `PUT /pets/{pet_id}/loadout`

Nickname moderation can be synchronous for clear cases and pending for borderline cases.

### Matchmaking

- `POST /matchmaking/queue`
- `DELETE /matchmaking/tickets/{ticket_id}`
- `GET /matchmaking/tickets/{ticket_id}`
- `POST /friend-rooms`
- `POST /friend-rooms/join`
- `DELETE /friend-rooms/{room_id}`

Ranked queue validates account verification, pet ownership, asset approval, pet eligibility, and active season.

### Battle Read APIs

- `GET /battles/{battle_room_id}`
- `GET /battles/{battle_room_id}/replay`
- `GET /pets/{pet_id}/battle-history`
- `GET /seasons/{season_id}/leaderboard`

Battle writes happen through the WebSocket protocol, not regular REST endpoints.

## WebSocket Battle Protocol

Endpoint:

`wss://league.example.com/battles/{battle_room_id}/ws`

Client messages:

- `hello`: authenticate session and resume participant state.
- `choose_action`: submit `strike`, `skill`, `guard`, or `focus`.
- `heartbeat`: keep connection alive.
- `request_snapshot`: ask for current server state.
- `concede`: voluntarily lose the battle.

Server messages:

- `room_ready`
- `state_snapshot`
- `turn_started`
- `action_ack`
- `action_rejected`
- `turn_resolved`
- `participant_disconnected`
- `participant_reconnected`
- `timeout_warning`
- `battle_finished`
- `error`

Action submission shape:

```json
{
  "type": "choose_action",
  "battle_room_id": "room_123",
  "turn_number": 4,
  "client_action_id": "uuid",
  "action": {
    "type": "skill",
    "skill_id": "patch_hotfix"
  }
}
```

The server ignores client-provided battle state. `turn_number` and `client_action_id` are used for idempotency and stale-action rejection.

## Battle Resolution Rules

Per turn:

1. Server emits `turn_started` with deadline.
2. Each client submits one action.
3. Server validates session, participant, turn number, action type, skill ownership, energy, cooldown, and status restrictions.
4. If both actions are accepted before deadline, resolve immediately.
5. If deadline passes, missing actions become timeout defaults.
6. Server computes result, updates authoritative state, writes events, and emits `turn_resolved`.
7. If battle ends, server writes `battle_results` and applies XP/LP.

Timeout handling:

- first timeout: automatic Guard
- second consecutive timeout: weak Guard or no-op
- third consecutive timeout: AFK loss

Disconnect handling:

- short reconnect grace window
- continue timer while disconnected
- automatic timeout behavior if no action arrives

## Ranked Eligibility

A pet can enter ranked only if:

- owner has a League verified account
- pet belongs to the account
- pet asset is approved
- pet is not under moderation hold
- pet has a legal loadout
- season is active
- account is not rate-limited or suspended
- no other active ranked room exists for the same account

Casual and Friend Duel can be looser, but still must not trust local battle results.

## Error Handling

Use stable error codes.

Examples:

- `AUTH_REQUIRED`
- `ACCOUNT_NOT_VERIFIED`
- `PET_NOT_FOUND`
- `PET_NOT_OWNED`
- `ASSET_NOT_APPROVED`
- `LOADOUT_INVALID`
- `QUEUE_ALREADY_ACTIVE`
- `BATTLE_NOT_FOUND`
- `TURN_STALE`
- `ACTION_ALREADY_SUBMITTED`
- `ACTION_ILLEGAL`
- `SKILL_ON_COOLDOWN`
- `INSUFFICIENT_ENERGY`
- `RATE_LIMITED`
- `MODERATION_HOLD`

Errors sent over WebSocket should include a user-safe message and a machine-readable code.

## Audit And Abuse Detection

Record enough to investigate suspicious play:

- session id
- account id
- pet id
- battle room id
- IP and coarse region where policy allows
- device binding id if available
- action timing
- disconnect frequency
- repeated AFK
- impossible action attempts
- rejected action counts
- asset hash and moderation state at battle start

Do not store raw Codex project content in audit records.

## Testing Strategy

Unit tests:

- skill resolution
- status duration
- energy and cooldown validation
- timeout defaults
- stat template totals
- LP delta rules

Property tests:

- no action can produce negative HP below allowed floor
- energy never exceeds cap
- cooldowns cannot skip illegally
- every ranked battle produces exactly one result
- LP changes only from server battle results

Integration tests:

- account login to ranked queue
- asset upload to approved pet
- friend room creation and join
- random matchmaking to active battle
- reconnect during battle
- duplicate action idempotency
- stale turn rejection

Security tests:

- client submits fake HP
- client submits fake LP
- client uses skill not in loadout
- client submits action after deadline
- client replays old action
- client tries ranked with unapproved asset
- client changes local asset after registration

## Decisions Locked In

- League verified account is the 1.0 official account authority.
- OpenAI-attested identity is future-only until OpenAI provides a signed claim that the League server can verify.
- User hatch appearance is preserved.
- Server asset registry makes the canonical official copy.
- Skill mechanics are official and server-defined.
- User skill nicknames are cosmetic only.
- Battle, XP, LP, and ranked outcomes are server-authoritative.

## Open Questions

- Which auth methods launch first: passkey, email magic link, Google, Apple, GitHub?
- Should asset moderation block all battles or only ranked battles while pending?
- Should approved pet assets be public by default or private until first battle?
- What is the ranked stat normalization formula after pets level up?
- How many skill slots should be active in battle: 3 or 4?
- What is the exact turn timer: 20, 30, or 45 seconds?
- What are the LP delta formulas and placement match rules?
