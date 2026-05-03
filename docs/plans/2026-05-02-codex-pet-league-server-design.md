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
- Worker service: asset processing, async safety checks, leaderboard snapshots, season jobs, replay export.
- Storage:
  - Postgres for accounts, pets, ranked data, battle logs, skill config, and asset safety state.
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
- `asset_status`: `active`, `format_rejected`, `quarantined`, `removed`
- `safety_status`: `unscanned`, `clear`, `flagged`
- `created_at`
- `activated_at`

`pet_asset_revisions`

- `id`
- `asset_id`
- `revision_number`
- `canonical_hash`
- `atlas_object_key`
- `manifest_json`
- `asset_status`
- `safety_status`
- `created_at`

Assets become active immediately after automatic format validation passes. Revisions are new immutable records linked to the same visual lineage.

There is no manual pre-approval queue for normal pet usage. The user should be able to use the pet they made as soon as the atlas is structurally valid. Safety checks run automatically and asynchronously; clearly abusive or invalid assets can be quarantined or removed after the fact.

### Pet

`pets`

- `id`
- `owner_account_id`
- `pet_asset_id`
- `name`
- `status`: `active`, `retired`, `asset_hold`
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
- `total_stats`
- `battle_class`: `hatch`, `core`, `surge`, `apex`, `prime`
- `growth_meters_json`
- `stat_version`
- `updated_at`

`pet_progression`

- `pet_id`
- `level`
- `mastery_level`
- `xp`
- `battle_xp`
- `training_xp`
- `style_xp`
- `progression_version`
- `updated_at`

The server derives these values. The client never submits final stats.

Leveling rules:

- Level 1 starts at 100 total stats from the primary element template.
- Levels 2-100 grant +2 actual stat points per level.
- Level 100 reaches 298 total stats.
- Level 101+ is Mastery progression and grants cosmetics, titles, aura, prestige, and profile rewards instead of battle stats.
- Stat growth is automatic. Users do not manually assign stat points.
- Growth distribution is based on the pet's primary and secondary element profile, weighted 70% primary and 30% secondary.
- `growth_meters_json` may hold fractional internal progress so long-term 70/30 distribution works even though visible stats increase as integers.

### XP Economy

Progression uses three separate values:

- Pet XP levels the pet, increases actual stats through Level 100, and moves the pet through Battle Classes.
- Style XP unlocks cosmetics, titles, aura, profile items, skill VFX skins, victory poses, and other non-power rewards.
- LP is ranked rating only. LP is separate from XP and has no daily earning cap.

Ranked Growth XP is not a separate currency. Main Ranked uses actual server-derived pet stats and Battle Class matchmaking, so Pet XP is the only level/stat progression XP.

Target pace:

- Hardcore players reach Level 100 in about 90 days.
- Regular players reach Level 100 in about 4-5 months.
- Casual players reach Level 100 in 6+ months.

Pet XP caps:

| Cap | Limit |
| --- | ---: |
| Total Pet XP per day | 700 |
| Training Report Pet XP per day | 400 |
| Battle Pet XP per day | 300 |
| Friend Duel Pet XP sub-cap per day | 75 |

Training Report Pet XP:

| Report Type | Pet XP |
| --- | ---: |
| Light | 30 |
| Standard | 70 |
| Major | 120 |
| Milestone | 180 |

The first approved Daily Training Report receives a +20% Pet XP bonus. The maximum single Training Report reward is 216 XP.

Battle Pet XP:

| Battle Result | Pet XP |
| --- | ---: |
| Ranked win | 80 |
| Ranked draw | 60 |
| Ranked active loss | 45 |
| Casual win | 60 |
| Casual draw | 45 |
| Casual active loss | 35 |
| Friend Duel complete | 25 |
| Training Battle complete | 25-40 |
| AFK battle | 0 |

Style XP caps:

| Cap | Limit |
| --- | ---: |
| Style XP per day | 1,000 |
| Style XP per week | 5,000 |

Style XP never affects level, stats, LP, matchmaking, damage, defense, speed, recovery, or status formulas.

Level XP table:

| Current Level | XP To Next Level |
| --- | ---: |
| 1-10 | 100 |
| 11-25 | 250 |
| 26-45 | 450 |
| 46-65 | 650 |
| 66-80 | 850 |
| 81-90 | 1,050 |
| 91-99 | 1,300 |

Level 100 requires about 61,700 Pet XP. At the 700 Pet XP daily cap, the theoretical fastest path is about 88-90 days.

### Ranked Battle Classes

Main Ranked uses actual server-derived stats. It does not compress grown pets down to a near-new-pet stat budget.

Newer pets are protected through Battle Class matchmaking:

| Battle Class | Total Stats | Typical Level Band |
| --- | ---: | --- |
| Hatch | 100-139 | Lv 1-20 |
| Core | 140-179 | Lv 21-40 |
| Surge | 180-219 | Lv 41-60 |
| Apex | 220-259 | Lv 61-80 |
| Prime | 260-298 | Lv 81-100 |

Ranked matchmaking first separates pets by current Battle Class, then matches by LP, tier, division, placement state, and repeated-opponent limits. Main Ranked LP matches should not cross Battle Class.

LP remains a seasonal pet value. When a pet grows into a new Battle Class, it keeps its current LP and continues ranked play against pets in the new class.

Equalized stats may be introduced later as a special event or optional mode, but they are not the main ranked ruleset.

### Element Advantage

Element advantage uses a six-element cycle:

```text
Logic > Pulse > Trace > Deploy > Patch > Forge > Logic
```

Server rules:

- Primary element advantage: +10% damage or status chance.
- Secondary element advantage: +5% damage or status chance.
- Primary element disadvantage: -10%.
- Secondary element disadvantage: -5%.
- Final element modifier is capped between -15% and +15%.

The battle engine computes element modifiers from server-owned pet and skill data. The client may display matchup hints, but it never submits advantage calculations.

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

`xp_ledger_entries`

- `id`
- `account_id`
- `pet_id`
- `source_type`: `training_report`, `ranked_battle`, `casual_battle`, `friend_duel`, `training_battle`, `style_reward`, `admin_adjustment`
- `source_id`
- `pet_xp_delta`
- `style_xp_delta`
- `cap_buckets_json`: `pet_daily`, `training_daily`, `battle_daily`, `friend_daily`, `style_daily`, `style_weekly`
- `applied_at`

`progression_cap_counters`

- `id`
- `account_id`
- `pet_id`
- `bucket`
- `window_start_at`
- `window_end_at`
- `amount_used`
- `updated_at`

Training reports contain summarized signals only. They must not contain source code, full conversation transcripts, or private project content.

Server caps apply per day, week, season, and pet. XP awards must be written through the ledger so cap enforcement, refunds, audits, and abuse reviews can replay the same progression state.

### Skills

`official_skills`

- `id`
- `official_name`
- `element`
- `catalog_role`: `offense`, `defense`, `status`, `tempo`, `finisher`
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

Season 1 starts with 30 official skills: five per element across six elements. Each element should have one skill in each catalog role:

- offense
- defense or counterplay
- status application
- energy, priority, or tempo control
- high-risk finisher

Pets equip exactly four active skills. A pet's legal skill pool comes from its primary and secondary elements. Skill versions, costs, cooldowns, and effect JSON are server-owned and season-versioned.

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

Ranked season entry uses five placement matches. Placement results seed the starting LP band, then normal LP updates apply.

LP delta inputs:

- match result: win, loss, draw, AFK loss
- player's current LP
- opponent's current LP
- placement status
- streak or volatility guardrails if needed for early-season stability

The basic rule is: beating a higher-LP opponent awards more LP, losing to a lower-LP opponent costs more LP. AFK losses always receive the harshest allowed LP penalty for the context.

Tier thresholds:

Each non-Codex tier has three divisions. Division 1 is the entry band and Division 3 is the promotion band.

| Tier Division | LP Range |
| --- | ---: |
| Bronze 1 | 0-333 |
| Bronze 2 | 334-666 |
| Bronze 3 | 667-999 |
| Silver 1 | 1000-1333 |
| Silver 2 | 1334-1666 |
| Silver 3 | 1667-1999 |
| Gold 1 | 2000-2333 |
| Gold 2 | 2334-2666 |
| Gold 3 | 2667-2999 |
| Platinum 1 | 3000-3333 |
| Platinum 2 | 3334-3666 |
| Platinum 3 | 3667-3999 |
| Diamond 1 | 4000-4333 |
| Diamond 2 | 4334-4666 |
| Diamond 3 | 4667-4999 |
| Mythic 1 | 5000-5333 |
| Mythic 2 | 5334-5666 |
| Mythic 3 | 5667-5999 |
| Codex | 6000+, leaderboard rank based |

Base LP changes:

| Result | Base LP |
| --- | ---: |
| Win | +25 |
| Loss | -25 |
| Draw | +0 |
| AFK loss | -40 |

Opponent LP modifiers:

| Condition | Modifier |
| --- | ---: |
| Win against opponent 400+ LP above | +10 |
| Win against opponent 200-399 LP above | +5 |
| Loss against opponent 400+ LP below | -10 |
| Loss against opponent 200-399 LP below | -5 |
| Loss against opponent 400+ LP above | +5 |
| Win against opponent 400+ LP below | -5 |

Normal ranked LP movement is clamped between -45 and +45. Placement matches double the calculated LP movement, then clamp between -90 and +90.

### Matchmaking

`matchmaking_tickets`

- `id`
- `account_id`
- `pet_id`
- `mode`: `ranked`, `casual`
- `status`: `queued`, `matched`, `cancelled`, `expired`
- `battle_class`
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
- `battle_class_at_start`
- `stats_snapshot_json`
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

Launch login methods: passkey, email magic link, and OAuth.

OAuth means League account OAuth, such as Google, Apple, or GitHub. It does not mean OpenAI account authority. OpenAI-attested identity remains future-only until OpenAI provides a signed claim that the League server can verify.

### Pet Assets

- `POST /pet-assets/uploads`
- `PUT /pet-assets/uploads/{upload_id}/file`
- `POST /pet-assets/uploads/{upload_id}/complete`
- `GET /pet-assets/{asset_id}`
- `GET /pet-assets/{asset_id}/manifest`
- `GET /pet-assets/{asset_id}/atlas`

Upload completion triggers automatic format validation. If validation passes, the asset becomes active immediately and can be used in ranked, casual, and friend battles.

Async safety checks and user reports can later quarantine or remove abusive assets. Quarantine blocks future use but does not let the client rewrite past ranked results.

### Pets

- `POST /pets`
- `GET /pets`
- `GET /pets/{pet_id}`
- `PATCH /pets/{pet_id}/name`
- `POST /pets/{pet_id}/reroll-primary`
- `GET /pets/{pet_id}/secondary-candidates`
- `POST /pets/{pet_id}/secondary-element`

`POST /pets` requires an active `pet_asset_id`.

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

Each battle loadout has exactly four active skill slots. Skill mechanics are official server config; user nicknames are cosmetic.

### Matchmaking

- `POST /matchmaking/queue`
- `DELETE /matchmaking/tickets/{ticket_id}`
- `GET /matchmaking/tickets/{ticket_id}`
- `POST /friend-rooms`
- `POST /friend-rooms/join`
- `DELETE /friend-rooms/{room_id}`

Ranked queue validates account verification, pet ownership, active asset status, pet eligibility, legal four-skill loadout, and active season.

Ranked matchmaking prioritizes similar tier and LP. The search band can widen gradually if queue time grows, but the first-order matching goal is always similar competitive standing.

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

1. Server emits `turn_started` with a fixed 30 second deadline.
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

The 30 second timer is fixed for Ranked, Casual, and Friend Duel. Friend rooms do not get custom timer settings in 1.0.

## Ranked Eligibility

A pet can enter ranked only if:

- owner has a League verified account
- pet belongs to the account
- pet asset is active
- pet is not under asset hold
- pet has a legal loadout
- pet has exactly four active skill slots
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
- `ASSET_NOT_ACTIVE`
- `LOADOUT_INVALID`
- `QUEUE_ALREADY_ACTIVE`
- `BATTLE_NOT_FOUND`
- `TURN_STALE`
- `ACTION_ALREADY_SUBMITTED`
- `ACTION_ILLEGAL`
- `SKILL_ON_COOLDOWN`
- `INSUFFICIENT_ENERGY`
- `RATE_LIMITED`
- `ASSET_HOLD`

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
- XP ledger anomalies and repeated cap-bound farming
- asset hash and asset/safety state at battle start

Do not store raw Codex project content in audit records.

## Testing Strategy

Unit tests:

- skill resolution
- status duration
- energy and cooldown validation
- timeout defaults
- stat template totals
- level-to-stat growth totals
- level XP table totals
- Pet XP daily cap enforcement
- Style XP daily and weekly cap enforcement
- Battle Class boundary calculation
- element advantage cap calculation
- LP delta rules

Property tests:

- no action can produce negative HP below allowed floor
- energy never exceeds cap
- cooldowns cannot skip illegally
- every ranked battle produces exactly one result
- LP changes only from server battle results
- XP ledger replay produces the same progression totals
- Style XP never changes battle stats or level
- ranked matchmaking does not cross Battle Class
- element advantage never exceeds the -15% to +15% cap

Integration tests:

- account login to ranked queue
- asset upload to active pet
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
- client submits fake XP or cap counter state
- client tries ranked with inactive or quarantined asset
- client changes local asset after registration

## Decisions Locked In

- League verified account is the 1.0 official account authority.
- League verified account supports passkey, email magic link, and League OAuth.
- OpenAI-attested identity is future-only until OpenAI provides a signed claim that the League server can verify.
- User hatch appearance is preserved.
- Server asset registry makes the canonical official copy.
- Structurally valid assets are active immediately; safety enforcement is automatic and post-hoc unless the file is invalid or clearly abusive.
- Skill mechanics are official and server-defined.
- Season 1 starts with five official skills per element, for 30 official skills total.
- User skill nicknames are cosmetic only.
- Battle loadouts use exactly four active skill slots.
- Every turn uses a fixed 30 second timer.
- Pet XP is capped at 700 per day, split into 400 Training Report XP and 300 Battle XP.
- Friend Duel Battle XP has a 75 XP daily sub-cap.
- Style XP is capped at 1,000 per day and 5,000 per week, and never affects combat power.
- Level 100 requires about 61,700 Pet XP, targeting roughly 90 days for hardcore players.
- Leveling increases actual stats through level 100; Mastery levels do not add battle stats.
- Main Ranked uses actual server-derived stats instead of stat compression.
- Main Ranked separates pets by Battle Class before LP matching.
- Element advantage follows Logic > Pulse > Trace > Deploy > Patch > Forge > Logic.
- Element advantage is capped between -15% and +15%.
- Ranked uses seven top-level LP tiers: Bronze, Silver, Gold, Platinum, Diamond, Mythic, and Codex.
- Bronze through Mythic each have three divisions. Codex is leaderboard rank based.
- Ranked season entry uses five placement matches from a neutral 1500 hidden seed.
- Ranked LP changes use fixed base results, opponent LP modifiers, and per-battle clamps.
- Battle, XP, LP, and ranked outcomes are server-authoritative.

## Open Questions

- Should active pet assets be public by default or private until first battle?
