# Codex Pet League Anti-Cheat Threat Model

Codex Pet League treats anti-cheat as a core architecture requirement, not a later moderation add-on. The goal is to make client manipulation unable to affect official battle, progression, ranking, ownership, or season outcomes.

## Security Goals

- Official pet ownership cannot be forged or transferred.
- Official pet assets cannot be replaced, mutated, or used after quarantine.
- XP, level, stats, Battle Class, LP, battle results, and season records are server-derived.
- Codex App, CLI, plugin, browser UI, and local files are never trusted as authoritative.
- Every official state change is replayable from server events or ledgers.
- Suspicious behavior can be delayed, reviewed, rolled back, or limited without corrupting the season.
- Anti-cheat data avoids storing raw source code, full Codex transcripts, or private project content.

## Trust Boundaries

Trusted:

- League server application code.
- Server database transactions.
- Server battle engine.
- Server-generated clocks, nonces, deadlines, and RNG.
- Server-owned skill config, season config, and progression tables.
- Server object storage after canonical re-encode and hash.

Partially trusted:

- League verified account session.
- Device binding.
- Official plugin version signal.
- Codex App or CLI environment metadata.
- Training Report summaries approved by the user.

Untrusted:

- Local files.
- Local hatch manifests before server validation.
- Local pet stats, XP, LP, cooldowns, HP, and battle logs.
- Client clocks.
- Browser or WebSocket clients.
- Modified plugins or direct API callers.
- User-provided report type, battle result, or reward claims.

## Golden Rules

- Clients submit intent, assets, and report summaries. They never submit official outcomes.
- XP, LP, level, stats, Battle Class, ownership, and battle results are append-only event or ledger outputs.
- Current state is derived from ledgers and immutable records, not directly trusted client updates.
- Server time is the only time used for caps, deadlines, resets, cooldowns, and seasons.
- Ranked LP changes only from completed server battle results.
- Battle XP changes only from completed server battle results.
- Training XP changes only from server-scored Training Reports.
- Style XP never changes combat power.
- Admin changes use the same ledger model with stronger audit requirements.

## Attack Surface Matrix

| Area | Abuse Attempt | Prevention | Detection | Response |
| --- | --- | --- | --- | --- |
| Account creation | Mass alt accounts, smurfing, ban evasion | passkey/email/OAuth, device binding, rate limits, ranked unlock gates | account graph, device reuse, IP/region velocity, repeated pairings | ranked cooldown, verification challenge, queue limits, suspension |
| Session security | Token theft, refresh token replay, account takeover | refresh rotation, session binding, short-lived access tokens, passkey recovery | impossible travel, new device spikes, token reuse | revoke sessions, lock ranked, require reauth |
| API access | Direct API calls outside plugin, forged requests | scoped tokens, server validation, idempotency keys, rate limits | unusual client version, endpoint velocity, failed validation counts | throttle, deny scope, flag account |
| Plugin integrity | Modified plugin submits fake report metadata | plugin version allowlist, signed release metadata where available, server-side scoring | unknown client version, high reward rate, repeated payload shapes | lower trust score, Style XP only, review |
| Training Reports | Fake Major/Milestone report | server reclassifies from signals, report scoring, user approval required | report quality anomalies, mismatch between report type and signals | downgrade reward, pending review, Style XP only |
| Training duplication | Same work submitted multiple times | client_report_id, server nonce, summary hash, time window, workspace fingerprint | repeated hashes, overlapping time windows, repeated file buckets | reject duplicate, cap reward, flag |
| Training automation | Bot loops meaningless work to farm XP | daily 3 official submits, 400 Training XP cap, quality score | short interval reports, repeated low-signal patterns | Style XP only, cooldown, review |
| Report prompt injection | Project files or chat content try to instruct the plugin to over-reward | schema allowlist, user preview, server reclassification, no raw prompt authority | suspicious report language, impossible reward class, repeated phrasing | reject, downgrade, warn |
| Workspace farming | Same work copied across folders/accounts | workspace fingerprint, account graph, summary similarity | cross-account similarity, repeated report structures | reward hold, account cluster review |
| Reset boundary abuse | Submit exactly around daily/weekly reset to double-count caps | server time, atomic cap windows, ledger replay | cap spikes near reset, repeated boundary timing | replay caps, rollback excess |
| Privacy bypass | Raw source/transcript submitted accidentally or maliciously | schema rejects raw content, size limits, field allowlist | high entropy payload, source-like markers, oversized fields | reject report, purge payload, warn user |
| XP caps | Parallel submit race exceeds daily cap | DB transaction locks, cap counter rows, ledger replay | cap counter mismatch, over-cap ledger delta | rollback excess, block account until replay |
| Battle state | Client submits fake HP/energy/cooldowns | action intent only, server state machine | illegal action attempts, impossible transitions | reject action, flag account |
| Loadout swap abuse | Change skills, asset, or stats after queue or battle start | snapshot loadout, skill versions, stats, Battle Class, asset hash at room creation | snapshot/current mismatch | use snapshot, reject illegal changes |
| Season boundary abuse | Finish or submit results across season cutover | season id snapshot, server finish transaction, season lock window | late writes, mismatched season ids | hold result, apply to correct season |
| Turn timing | Late action after seeing opponent action | server deadline, simultaneous hidden action lock, no opponent reveal before resolution | late submissions, latency abuse pattern | reject action, timeout, ranked penalty |
| Action replay | Reuse previous action or stale turn id | turn idempotency, action unique constraint, turn nonce | duplicate action id, stale turn attempts | reject, flag |
| Disconnect abuse | Dodge losing games, force rematch timing | reconnect grace, timeout escalation, AFK loss | disconnect near-loss, queue dodge rate | cooldown, LP penalty, ranked lock |
| Friend farming | Repeated friend duel XP farming | Friend Duel 75 XP cap, minimum meaningful turns | same pair loops, short battles, mirrored actions | XP reduction, no XP, review |
| LP win trading | Alt/friend intentionally loses in ranked | ranked random only, opponent graph, same-opponent LP decay | reciprocal wins/losses, repeated pairings, odd surrender timing | result hold, LP rollback, ranked suspension |
| Matchmaking abuse | Queue dodge until desired opponent | dodge penalty, queue cooldown, randomized search windows | repeated cancels, same-target timing | cooldown, lower priority, ranked lock |
| Battle Class abuse | Stay low level to dominate lower class | placement volatility, fast LP correction, win streak correction | high win rates at low class, account skill mismatch | faster tier adjustment, review |
| Asset upload | Broken atlas, payload image, hidden frames | strict dimensions, image decode sandbox, canonical re-encode, full-frame validation | decoder errors, unusual entropy, repeated rejects | reject asset, account warning |
| Asset mutation | Replace local file after registration | canonical hash, immutable server asset, battle snapshot | asset hash mismatch | ignore local changes, require revision |
| Moderation evasion | Offensive image/name/nickname | automated safety scan, reports, quarantine, filters | repeated reports, safety flags | hide, quarantine, rename, suspend |
| Replay/log tampering | Client displays fake result or replay | server-signed replay, state hash per turn, append-only battle log | replay hash mismatch | reject replay, use server record |
| Leaderboard race | Duplicate result updates LP twice | battle_result unique constraint, transaction locks, derived snapshots | ledger replay mismatch, duplicate battle id | rebuild leaderboard, rollback duplicate |
| Economy abuse | Event/cosmetic reward repeated claims | reward ledger, claim idempotency, season caps | duplicate claim keys, rapid claims | reject, rollback, cooldown |
| Protocol spam | WebSocket/API floods, queue spam, upload spam | per-account and per-IP rate limits, queue limits, upload intent TTL, backpressure | connection spikes, 429 rates, abandoned uploads | throttle, cooldown, temporary block |
| Resource exhaustion | Image bombs, huge manifests, replay export abuse | hard size limits, decode sandbox, streaming limits, job quotas | memory/CPU spikes, repeated decoder failures | reject payload, quarantine account |
| Information leak | Spectator/replay/queue leaks reveal hidden actions or matchup data | no live opponent action reveal, replay after resolution, limited queue metadata | unusual polling, timing correlation | reduce metadata, block polling |
| Admin abuse | Manual LP/XP/pet edits | dual approval, reason-required actions, admin ledger | unusual admin grants, edits outside policy | alert, freeze, rollback, audit |
| Insider data abuse | Sensitive project data stored in reports | data minimization, schema allowlist, retention policy | raw-content detectors | purge, incident review |

## Official Upload Flow Controls

Pet asset upload:

1. League session is required.
2. Client requests upload intent.
3. Server returns a short-lived signed upload URL and upload id.
4. Client uploads atlas and manifest.
5. Client completes upload.
6. Server decodes image in a sandbox.
7. Server validates dimensions, row count, frame size, file size, manifest shape, and chroma-key expectations.
8. Server canonicalizes and re-encodes the image.
9. Server computes canonical hash.
10. Server stores immutable asset and revision records.
11. Asset becomes active and public if validation passes.
12. Async safety scan may later hide, quarantine, or remove the asset.

Server never uses client-provided asset hashes as authority. Client hashes are hints only.

## Training Report Flow Controls

Training Report triggers:

- Natural language in Codex App: "펫 훈련 리포트 만들어줘", "오늘 작업 pet XP로 제출해줘", "펫 XP 상태 보여줘".
- Slash commands: `/pet train`, `/pet report`, `/pet submit`, `/pet xp`, `/pet status`.
- CLI commands: `codexpet report draft`, `codexpet report submit`, `codexpet xp status`.
- Optional post-task prompt after meaningful Codex work.

Rules:

- Draft generation has no hard limit.
- Official submit is limited to 3 per day.
- Training Pet XP is capped at 400 per day.
- Total Pet XP is capped at 700 per day.
- The first approved Daily Training Report receives a +20% Pet XP bonus.
- Submissions require user approval.
- Automatic submission is not allowed.
- Raw source code and full transcripts are rejected.

Status display before submit:

```text
Today Progress
Pet XP: 280 / 700
Training XP: 280 / 400
Battle XP: 0 / 300
Friend Duel XP: 0 / 75
Training Reports: 2 / 3 submitted
Style XP: 350 / 1,000
Weekly Style XP: 1,800 / 5,000
Daily reset in: 6h 24m
```

Server scoring:

- The client may suggest `light`, `standard`, `major`, or `milestone`.
- The server computes the final report class from allowed summary signals.
- The server may downgrade, reject, delay, or convert suspicious reports to Style XP only.
- The server stores scoring reasons without storing private project content.

## Battle Integrity Controls

Battle rooms:

- Server creates battle room and participants.
- Server snapshots pet id, asset hash, loadout, stats, Battle Class, skill versions, and ruleset version.
- The snapshot is the only battle-legal version for that room.
- Loadout, skill version, asset revision, or stat changes after queue entry do not affect the active room.
- Server owns RNG seed commitment and turn deadlines.
- Clients submit only action intents.
- The server validates skill ownership, energy, cooldown, turn id, timing, and action legality.
- The server resolves turns and writes state hashes.
- Ranked results and LP derive from the final server battle result only.

Simultaneous action handling:

- Actions lock when submitted.
- One player must not receive the other's action before resolution.
- Late actions are rejected by server deadline.
- Reconnect does not pause the ranked timer.

## Matchmaking And LP Abuse Controls

Ranked matchmaking order:

1. Battle Class.
2. LP, tier, and division.
3. Placement state.
4. Region and latency.
5. Repeated-opponent limits.
6. Queue time widening.

LP protections:

- Friend Duel and Casual never change LP.
- Ranked LP requires random matchmaking.
- Same-opponent pairings have cooldown and LP decay.
- Suspicious result clusters can be held before leaderboard publication.
- LP can be rolled back from the result ledger.

Smurf and low-class protection:

- New ranked accounts receive placement volatility.
- Extreme win streaks accelerate LP correction.
- Repeated low-class domination increases account risk score.
- Ranked unlock gates may require a minimum verified account age, pet level, or completed tutorial battles.

Season boundary protections:

- Battle rooms store `season_id` at creation.
- LP results apply to the room's stored season unless the server cancels the room before start.
- Season finalization uses a lock window where leaderboard snapshots are rebuilt from ledgers.
- Late workers cannot write directly to leaderboard state.
- Any correction after finalization creates a season integrity correction record.

## Ledger And State Model

Required ledgers:

- `xp_ledger_entries`
- `battle_results`
- `lp_ledger_entries`
- `asset_revision_events`
- `admin_audit_events`
- `moderation_events`
- `reward_claim_events`

Derived state:

- pet level
- pet stats
- Battle Class
- daily and weekly cap counters
- LP
- tier and division
- leaderboard snapshots

Ledger requirements:

- append-only writes
- idempotency key for every external operation
- unique constraints for battle result and reward claim ids
- transaction locks for cap counters and LP application
- replay jobs that recompute current state and compare stored values
- integrity checksums for season-critical snapshots

## Risk Scoring

Risk score inputs:

- account age and verification strength
- device binding history
- session velocity and location changes
- report quality history
- report timing patterns
- duplicate summary hashes
- repeated opponent graph
- queue dodge frequency
- disconnect and AFK frequency
- rejected action counts
- cap-bound farming behavior
- reset-boundary farming behavior
- abandoned upload count
- queue cancel and requeue timing
- moderation flags
- admin adjustments

Risk score effects:

- no change for normal users
- reduced report trust
- Style XP only for suspicious reports
- delayed XP or LP application
- ranked queue cooldown
- extra verification challenge
- manual review
- temporary or permanent suspension

## Response Ladder

Use graduated responses so normal users are not punished for bugs or network issues:

1. Reject invalid request.
2. Apply no XP/LP for the specific event.
3. Convert Pet XP reward to Style XP only.
4. Delay XP or LP pending review.
5. Apply queue cooldown.
6. Require reauthentication or verification.
7. Roll back ledger-derived rewards.
8. Temporarily suspend ranked access.
9. Suspend account.
10. Publish season integrity correction if leaderboard results changed.

## Privacy Rules

- Training Reports store summarized signals only.
- Do not store raw code, full transcripts, secrets, environment variables, or full file paths where avoidable.
- Use coarse buckets for file counts, test counts, and activity duration.
- Store hashes for duplication detection, not raw workspace content.
- Give users a preview before submission.
- Provide a way to delete rejected draft payloads.

## Protocol And Availability Controls

Cheat prevention must also protect service availability, because a player can abuse infrastructure to avoid losses, block matchmaking, or corrupt event timing.

Controls:

- Per-account and per-IP rate limits for auth, upload intents, Training Report submission, matchmaking, battle actions, and replay export.
- Short TTLs for upload intents, queue tickets, friend rooms, and battle reconnect tokens.
- Maximum WebSocket connections per account and device.
- Backpressure on upload processing and replay export jobs.
- Hard payload limits before expensive decoding or parsing.
- Image decoding and thumbnail generation in a sandboxed worker.
- Queue tickets are single-active per mode per account.
- Battle action endpoint rejects duplicate or stale actions before deeper validation.
- Background workers are idempotent and safe to retry.

Availability abuse should usually trigger cooldowns and throttles before account bans unless tied to clear fraud or repeated ranked evasion.

## Required Tests

Unit tests:

- report scoring downgrade paths
- cap bucket calculation
- idempotency key behavior
- duplicate report rejection
- LP ledger application
- Battle Class boundary checks
- action deadline validation
- asset dimension validation
- nickname and pet name moderation states

Property tests:

- XP caps cannot be exceeded under parallel submission.
- LP cannot change without one battle result.
- Replaying ledgers produces the same derived state.
- A quarantined asset cannot enter ranked.
- Style XP never changes level or stats.
- Battle results are applied at most once.

Integration tests:

- signed upload URL to active public pet asset.
- duplicate asset upload revision.
- Training Report draft, preview, submit, cap display, XP application.
- two parallel Training Report submits at cap boundary.
- ranked battle through LP ledger update.
- disconnect and timeout ladder.
- leaderboard rebuild from battle results.

Security tests:

- fake XP payload.
- fake LP payload.
- fake cap counter.
- stale turn action.
- action after deadline.
- repeated friend duel XP farming.
- direct API call with missing plugin metadata.
- invalid atlas payload.
- asset mutation after registration.
- admin manual grant without required approval.

## Future Hardening

If OpenAI or Codex App later provides server-verifiable attestation, the League should add:

- signed Codex session claim
- stable OpenAI/Codex subject
- signed Training Report origin
- plugin execution attestation
- audience-bound token for the League server
- public-key verification endpoint

Until that exists, Codex activity is useful evidence, not official authority. Official authority remains the League server.
