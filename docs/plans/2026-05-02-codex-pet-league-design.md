# Codex Pet League 1.0 Design

Date: 2026-05-02
Status: Draft, based on current product decisions

## Product Definition

Codex Pet League is a Codex App exclusive pet league where users bring their own hatched Codex pets into a real-time turn-based battle system. Pets grow through Codex-related activity and battle participation, but official ranked outcomes are controlled by the League server, not by local files or client-side state.

The core promise is:

- Users keep the pet identity and appearance they created through Codex hatch.
- Battles are fair, server-authoritative, and resistant to local tampering.
- Pet growth reflects Codex usage style without letting old or heavy users start with unfair raw power.
- Ranked play supports both random matchmaking and friend invite codes.
- The experience works through both Codex chat commands and a web battle screen.

## Current Account Decision

The official account authority for 1.0 is a League verified account.

We tested a local MCP identity probe through both `codex exec` and the current Codex App session. The MCP request metadata included Codex turn/session metadata, but did not include a server-verifiable signed OpenAI or ChatGPT user identity claim. Specifically, no signed ID token, OIDC subject, verified OpenAI account claim, JWT, certificate, or attestation payload was visible to the MCP server.

Because of that, OpenAI or ChatGPT account identity must not be treated as the 1.0 account authority.

Account tiers:

- League Verified: official account, ranked eligible.
- Device Guest: local trial account, casual/friend-only, not ranked eligible.
- OpenAI Attested: future upgrade if Codex App later exposes a signed OpenAI identity claim to third-party services.

The League account owns pets, registered assets, ranked records, LP, season history, battle replays, and cosmetic skill nicknames.

League verified accounts launch with passkey, email magic link, and League OAuth login options. OAuth here means providers such as Google, Apple, or GitHub. It does not mean OpenAI account authority.

## Anti-Cheat Principles

The client is never authoritative.

Local files, local pet manifests, local hatch outputs, local stats, local XP, and local battle results are all considered user-controlled. They can be useful inputs, but they cannot directly affect ranked state.

The League server is authoritative for:

- account ownership
- pet ownership
- official pet asset registry
- stats and progression
- skill definitions
- battle state
- turn timing
- RNG
- HP, energy, cooldowns, status effects
- LP, XP, rankings, season records
- battle logs and replays

The client may send only user intent, such as selected battle action. The server validates whether that action is legal and computes the result.

The design goal is not merely to make cheating difficult. The goal is to make local manipulation unable to affect ranked outcomes.

## Pet Identity And Asset Registry

Users should be able to use the pet appearance they created with Codex hatch. This is a major identity and attachment feature.

The server does not redesign user pets. It validates and stores the submitted asset as the official canonical copy.

Expected hatch asset shape, based on observed Codex pet hatch output:

- PNG sprite atlas
- 8 columns x 9 rows
- cell size 192 x 208
- full atlas size 1536 x 1872
- magenta `#FF00FF` chroma-key background
- state rows:
  - `idle`
  - `running-right`
  - `running-left`
  - `waving`
  - `jumping`
  - `failed`
  - `waiting`
  - `running`
  - `review`

Registration flow:

1. User hatches or selects a Codex pet in the Codex App.
2. User submits the pet atlas and manifest to the League server.
3. Server validates dimensions, row layout, frame structure, image format, file size, and chroma key rules.
4. If format validation passes, the asset becomes active immediately.
5. Server normalizes the asset and computes a canonical hash.
6. Server stores the canonical asset and issues a `pet_asset_id`.
7. Async safety checks and user reports can later quarantine or remove abusive assets.
8. The asset is immutable after registration.
9. Changes create a new asset revision instead of mutating the existing asset.

Ranked battles use only server-registered assets. If a user modifies a local image, it has no ranked effect.

There is no manual pre-approval queue for normal pet usage. Users should be able to use the pet they made right away once the atlas is structurally valid.

## Pet Data Model

Pet data is split by responsibility:

- Pet Identity: name, owner account, asset id, hatch metadata, cosmetic history.
- Pet Build: primary element, secondary element, stats, skill loadout.
- Pet Progression: level, unlocks, titles, approved training history, battle growth.
- Pet Battle State: HP, energy, cooldowns, statuses, selected action, turn timers.

Identity and cosmetics can feel personal and expressive. Build, progression, and battle state are controlled by server rules.

## Elements

Pets use a hybrid Codex/game element system:

- Logic
- Patch
- Trace
- Forge
- Pulse
- Deploy

Each pet has a primary element and later unlocks a secondary element.

Primary element is determined automatically by Codex activity analysis during pet creation. This affects style and starting template, not raw advantage. One reroll is allowed, selected from strong activity-based candidate elements rather than pure random.

Secondary element unlocks later. The system analyzes activity patterns and presents 2-3 candidates. The user chooses one.

## Starting Balance

All new pets start with the same total stat budget. Codex activity determines style, not starting strength.

Stats:

- Power
- Guard
- Speed
- Focus
- Recovery
- Insight

All starting templates total 100 points.

Initial templates:

| Primary | Power | Guard | Speed | Focus | Recovery | Insight |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Logic | 13 | 14 | 15 | 22 | 13 | 23 |
| Patch | 13 | 22 | 13 | 15 | 23 | 14 |
| Trace | 13 | 14 | 22 | 14 | 13 | 24 |
| Forge | 24 | 20 | 13 | 14 | 13 | 16 |
| Pulse | 14 | 13 | 24 | 22 | 13 | 14 |
| Deploy | 23 | 13 | 14 | 16 | 13 | 21 |

These templates are fixed for balance. Users cannot manually min-max starting stats.

## Growth

Growth has two sources:

- Codex activity growth
- Battle growth

Codex activity growth reflects work style, but must be approved and capped. The plugin may analyze local activity and produce a Training Report, but server progression changes happen only after user approval and server validation.

Training Report examples:

- tests and verification -> Logic
- bug fixing and recovery -> Patch
- debugging, search, logs -> Trace
- feature implementation -> Forge
- quick iteration -> Pulse
- documentation, cleanup, release work -> Deploy

The server stores approved training events as summarized events, not raw project code or private content.

Battle growth rewards participation and good decisions, not only wins.

- Win: larger XP, LP increase in ranked.
- Loss: smaller XP if actively played.
- Good play: bonus XP for useful guards, good element choices, focus-skill combos, and comeback play.
- AFK or suspicious behavior: reduced or zero XP.

Ranked battle power is bounded through caps and normalization so older pets gain strategy depth and identity, not overwhelming raw stat advantage.

Ranked matchmaking and stat normalization solve different problems. Matchmaking decides who should fight, prioritizing similar tier and LP. Normalization decides how much raw growth can affect the fight once it starts.

Ranked normalization:

- Each season has a ranked effective level cap.
- A pet's base ranked stats come from its primary template, secondary element, and legal loadout.
- Growth can add bounded ranked bonuses.
- Per-stat growth bonus cap: +10%.
- Total ranked stat bonus cap: +15% over the normalized base budget.
- Growth beyond the cap still matters for cosmetics, titles, unlocks, skill options, non-ranked progression, and future seasons.
- Casual and Friend Duel may display broader growth, but official ranked results use normalized stats.

This prevents a long-grown pet from crushing a newer pet through raw numbers while preserving the feeling that growth matters.

## Battle System

Battles are real-time turn-based.

Each battle room contains two players and their registered pets. Each turn uses a fixed 30 second timer in Ranked, Casual, and Friend Duel. Both players choose actions simultaneously. Once both actions are submitted, or the timer expires, the server resolves the turn.

Core actions:

- Strike: stable basic damage and small energy gain.
- Skill: uses an official skill, requiring energy and/or cooldown.
- Guard: reduces incoming damage and improves status resistance.
- Focus: restores energy and empowers the next skill or improves action reliability.

If a player takes no action:

- first timeout: automatic Guard
- repeated timeout: weaker defensive result or no action
- continued timeout: AFK loss
- disconnect: short reconnect grace window, then AFK handling

All battle resolution happens on the server.

## Status Effects

Each element has one core status identity:

- Logic -> Predicted: next action is read, reducing effect or exposing counterplay.
- Patch -> Stabilized: increases recovery, defense, or debuff resistance.
- Trace -> Exposed: increases incoming damage or reduces guard effectiveness.
- Forge -> Overheated: empowers current output but weakens next-turn defense or energy.
- Pulse -> Charged: improves energy recovery, speed, or priority.
- Deploy -> Committed: strengthens decisive finishing moves but creates risk if blocked.

Statuses should generally last 1-2 turns and avoid heavy stacking.

## Skills

Skill effects are official and server-defined. Users cannot create custom skill mechanics for ranked play.

Each skill has:

- `skill_id`
- official name
- element
- energy cost
- cooldown
- effect definition
- effect version or season version
- allowed nickname

Users may set pet-specific cosmetic nicknames for skills. Nicknames do not alter behavior.

Each pet battle loadout has exactly four active skill slots.

Example:

```json
{
  "skill_id": "patch_hotfix",
  "official_name": "Hotfix",
  "nickname": "Pebble Reset",
  "element": "Patch",
  "effect_version": "season_1"
}
```

Battle UI should show both:

`Pebble used Pebble Reset`

`Hotfix · Patch`

Nickname moderation rules:

- length limited
- profanity and hate filters
- no impersonation of OpenAI, League staff, or other users
- official skill identity always visible in ranked contexts

## Skill Name Direction

Official skill names should feel Codex-native but game-readable.

Example official names:

- Logic: Predictive Read, Clean Proof, Counterline
- Patch: Hotfix, Stabilize, Rollback
- Trace: Expose Path, Breakpoint, Signal Leak
- Forge: Heavy Commit, Overclock, Build Breaker
- Pulse: Quick Loop, Charge Cycle, Tempo Shift
- Deploy: Final Push, Release Burst, Lock In

These names are not final balance content. They establish tone.

## League And Matchmaking

Supported battle modes:

- Ranked: random matchmaking, LP affected.
- Casual: random matchmaking, LP unaffected.
- Friend Duel: invite code, LP unaffected.
- Season Finals: later special mode for top ranked players.

Ranked uses:

- League Points
- tiers
- seasonal ladder
- server-computed battle records
- five placement matches at the start of a season
- LP deltas based on result and opponent LP difference

Tier direction:

Each non-Codex tier has three divisions. Division 1 is the entry band and Division 3 is the promotion band.

- Bronze 1: 0-333 LP
- Bronze 2: 334-666 LP
- Bronze 3: 667-999 LP
- Silver 1: 1000-1333 LP
- Silver 2: 1334-1666 LP
- Silver 3: 1667-1999 LP
- Gold 1: 2000-2333 LP
- Gold 2: 2334-2666 LP
- Gold 3: 2667-2999 LP
- Platinum 1: 3000-3333 LP
- Platinum 2: 3334-3666 LP
- Platinum 3: 3667-3999 LP
- Diamond 1: 4000-4333 LP
- Diamond 2: 4334-4666 LP
- Diamond 3: 4667-4999 LP
- Mythic 1: 5000-5333 LP
- Mythic 2: 5334-5666 LP
- Mythic 3: 5667-5999 LP
- Codex: 6000+ LP, leaderboard rank based

Season entry uses 5 placement matches. New ranked pets start placements from a neutral 1500 hidden seed, then receive visible LP after placement completes.

Base LP changes:

- Win: +25 LP
- Loss: -25 LP
- Draw: +0 LP
- AFK loss: -40 LP

Opponent LP difference modifies the result:

- Beat opponent 400+ LP above you: +10 LP bonus
- Beat opponent 200-399 LP above you: +5 LP bonus
- Lose to opponent 400+ LP below you: -10 LP extra penalty
- Lose to opponent 200-399 LP below you: -5 LP extra penalty
- Lose to opponent 400+ LP above you: +5 LP loss reduction
- Beat opponent 400+ LP below you: -5 LP win reduction

LP changes are clamped between -45 and +45 per ranked battle. Placement matches use the same result logic but double the final LP movement before clamping to -90 and +90.

Matchmaking should prioritize similar tier and LP. It may also consider recent performance, region/latency, and queue time. Search bands can widen if queue time grows, but the first-order goal is matching similar competitive standing.

Friend invite codes and random matchmaking share the same battle room infrastructure. Friend codes create or join a specific room. Random matchmaking places players from the queue into a room.

## UI Surfaces

The experience should support both:

- Codex chat commands
- web battle screen

Codex chat commands are useful for quick actions, summaries, setup, training reports, and accessibility.

The web battle screen is the primary visual battle experience, with:

- pet sprites
- HP bars
- energy bars
- status indicators
- turn timer
- action buttons
- skill picker
- battle log
- reconnect state
- result screen

Both surfaces connect to the same server battle room. Action submission from either surface is equivalent.

## Server Architecture

Major services/modules:

- Auth service: League verified accounts, sessions, passkeys, OAuth, and email magic link login.
- Asset registry: pet atlas upload, automatic format validation, canonical storage, revisions, async safety state.
- Pet service: ownership, identity, build, progression, loadouts.
- Training service: approved Codex activity summaries and growth rules.
- Matchmaking service: ranked/casual queues and friend code rooms.
- Battle service: authoritative room state, turn handling, RNG, validation, resolution.
- Replay/log service: immutable battle logs for audits, replays, and dispute checks.
- Leaderboard service: LP, tiers, seasons, ranking snapshots.
- Safety service: post-hoc pet asset quarantine/removal, names, skill nicknames, profile names.

The battle service must be isolated from client trust. It should accept only valid signed sessions and action intents.

## OpenAI Identity Future Upgrade

If Codex App later exposes a server-verifiable OpenAI/ChatGPT identity claim, the League can add OpenAI-attested accounts.

Requirements for using OpenAI identity:

- signed token or OIDC-like claim
- stable subject identifier
- audience bound to the League server
- expiration and issuer validation
- replay protection
- documented OpenAI verification endpoint or public keys

Until that exists, OpenAI identity must not be used as official League ownership.

## Open Questions

- Should Training Reports have daily or weekly caps?
- How many official skills should each element have at launch?
- Should users be able to trade or transfer pet assets, or are pets permanently account-bound?
- Should skill nicknames be globally visible in leaderboards/replays, or only during battle?
