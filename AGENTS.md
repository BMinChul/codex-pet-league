# Codex Pet League Agent Guide

This file is the source-of-truth handoff for agents working in this repo. Keep future changes aligned with the product decisions below.

## Product Goal

Codex Pet League is a Codex App and Codex CLI-first platform where users bring pets made with OpenAI's official `hatch-pet` skill into a server-authoritative pet growth and turn battle league.

The core fantasy is that a pet is a user's unique Codex-born companion. The platform should preserve the user's hatch appearance, grow the pet through Codex activity and battles, and let pets fight other users' pets without allowing local manipulation to affect ranked state.

Primary surfaces:

- Codex App through MCP tools and natural-language commands.
- Codex CLI through game-like terminal commands.
- Web UI as a companion surface for visual battles, profiles, leaderboards, replays, public browsing, and operations.

Do not turn the product into a web-only game. Web can play, but Codex App plus CLI are priority one.

## Current Handoff Snapshot

Latest verified repo baseline before the user-docs update:

- Commit: `c11d664` (`Resolve stale audit alert workflow`).
- Working tree after that commit was clean before the official user setup documentation update.
- Verification passed at that baseline:
  - `npm test` with 84 passing tests.
  - Live Render deploy reached `live` for stable hash and stale audit alert cleanup.
  - Live `npm run audit:summary -- --json` reported `ok: true` with zero findings.
  - Live `npm run cost:check -- --json` reported `status: ok` with zero open abuse alerts.
  - Live `/api/health` and `/api/metrics` returned healthy production counts.
  - Earlier live multiplayer ranked smoke passed with disposable account cleanup.
  - Owner-only admin allowlist was verified against the live Render service.

Implemented local product surface:

- Codex App MCP bridge is present in `src/mcp/codex-pet-mcp.cjs`.
- Codex CLI is present in `src/cli/index.js`.
- Web companion UI is present in `public/app.js` and `public/styles.css`.
- Official `hatch-pet` package discovery, inspection, import, validation, provenance hashing, and duplicate source review are implemented in `src/hatchPackage.cjs` and domain asset creation.
- First active League pet selection is permanent and server-enforced.
- Real-time turn-based battles, random matchmaking, friend invite rooms, 30 second turn timing, AFK timeout ladder, battle logs, replay hashes, and ranked settlement are implemented locally.
- Pet XP, Style XP, level, stats, Battle Class, LP, seasons, tiers, daily caps, and ledgers are implemented locally.
- User skill nicknames are cosmetic only and visible on battle/profile/replay surfaces, while official skill identity remains authoritative.
- Anti-cheat controls are implemented locally for idempotency, rate limits, stale actions, replay/hash chains, linked account context, repeated pairings, friend farming, duplicate hatch source fingerprints, asset moderation, and manual ranked locks.
- Audit recomputes pet XP, Style XP, level, stats, Battle Class, and LP from append-only ledgers and flags direct state tampering.
- Asset policy is implemented as: review/private assets cannot enter ranked; safety-blocked assets cannot enter any battle; local post-registration file changes have no ranked effect.
- `codexpet doctor`, `codexpet auth providers`, `codexpet bridge status`, `codexpet pet inspect-hatch`, MCP `league_doctor`, and MCP `pet_inspect_hatch` exist for Codex App/CLI troubleshooting.

Current execution track:

The active launch model is:

1. Public GitHub repo is the install path for the CLI, MCP bridge, and Codex App plugin scaffold.
2. Official shared alpha server is live at `https://league.codexpetz.com`.
3. Local and self-host modes remain supported for development and independent deployments.
4. Never publish production secrets, live service credentials, local state, admin tokens, session tokens, or personal machine paths.

Current GitHub release checklist:

- [x] Confirm launch model: public GitHub local/self-host preview first, official shared League server later.
- [x] Run a public-safety scan for secrets, local state, ignored files, personal paths, and placeholder URLs.
- [x] Decide the GitHub repo owner/name and license before replacing metadata.
- [x] Replace plugin metadata placeholders.
- [x] Remove local-only absolute paths from plugin/MCP config.
- [x] Document an installable CLI/MCP/plugin flow for other users' machines.
- [x] Split README guidance into local run, self-host run, and official shared League server later.
- [x] Run the GitHub-release verification set before pushing.
- [x] Create or select the GitHub repository and push the public baseline.
- [x] After the public repo baseline is shipped, return to official shared League server provider decisions.

Checklist discipline:

- Work the checklist from top to bottom.
- Mark an item `[x]` only after it is actually completed.
- Do not start production provider selection until the public GitHub baseline is ready unless the user explicitly changes the launch model.

Latest public-safety scan notes:

- Ignored local runtime/dependency paths confirmed: `data/`, `runs/`, `node_modules/`, and identity-probe logs/output.
- No tracked `.env` file was found; `.env.example` contains placeholder/local development values only.
- Public-release blocker scan is clean for personal paths and placeholder plugin metadata after the README/plugin updates.
- `localhost:4317` is acceptable for local/self-host docs, but README must clearly separate local/self-host mode from future official shared League server mode.

GitHub release metadata decision:

- GitHub owner: `BMinChul` unless the user chooses a different GitHub account or org before push.
- Repository name: `codex-pet-league`.
- License: `MIT`.

Latest GitHub-release verification:

- `npm test`: passed, 84 tests.
- `npm run test:runtime`: passed.
- `npm run test:browser`: passed, 3 browser smoke tests.
- `npm run monitor:official`: passed against `https://league.codexpetz.com`.
- `npm run balance:sim`: passed with `status: ok`.
- `npm run verify:loop -- 2`: passed.
- `git diff --check`: passed.
- GitHub-facing Hangul scan: passed, no Korean text remains in tracked public repo files outside ignored runtime/vendor paths.

Public GitHub baseline:

- Repository: `https://github.com/BMinChul/codex-pet-league`.
- First pushed branch: `master`.
- Public release prep commit: `a51e13b` (`Prepare public GitHub release`).
- First public alpha release: `v0.1.0-alpha`, GitHub pre-release at `https://github.com/BMinChul/codex-pet-league/releases/tag/v0.1.0-alpha`.
- GitHub issue templates are present for bug reports, install/MCP problems, and gameplay issues. Private account, moderation, privacy, or security-sensitive reports route to `support@codexpetz.com`.

Remaining official shared League server work:

- No blocker remains on the launch checklist after item 10.
- Public alpha operating pages are implemented at `/privacy`, `/terms`, `/support`, and `/status`.
- Broader traffic still needs only follow-up operating choices as usage grows: a private support inbox, provider-level paging/escalation if needed, and any future passkey/OAuth provider additions.

Official shared League server provider decision track:

- [x] Open the provider decision track after the public GitHub baseline.
- [x] Confirm hosting/deployment target: Render Web Service.
- [x] Confirm Auth provider for low-cost alpha: native League email-code login with Resend delivery. Passkeys and OAuth are deferred until needed.
- [x] Confirm managed Postgres provider: Render Postgres.
- [x] Confirm Redis-compatible provider for realtime bus, request guard, and distributed locks: Render Key Value from the first shared server launch.
- [x] Confirm object storage and public asset URL/CDN strategy: Cloudflare R2 with a custom domain.
- [x] Confirm image/text moderation provider and review policy: OpenAI Moderation API with `omni-moderation-latest`, using manual review for quarantine/block decisions.
- [x] Confirm domain, HTTPS, cookie, and admin access strategy: Cloudflare DNS, Render custom domain, secure host-only League cookies, and server-side League admin roles after verified email login.
- [x] Write chosen provider values into deployment docs and `.env.example` comments/placeholders.
- [x] Implement Resend email-code delivery path and production/ops config checks.
- [x] Run the remaining production-shaped integration checks after real credentials exist.

Official shared server launch checklist:

- [x] 1. Create real provider resources:
  - [x] Render Web Service from `https://github.com/BMinChul/codex-pet-league`.
  - [x] Render Postgres in the same Render region as the Web Service.
  - [x] Render Key Value Redis in the same Render region as the Web Service.
  - [x] Resend verified sender domain for the League email-code login sender.
  - [x] Cloudflare R2 bucket for canonical/public pet atlas assets.
  - [x] OpenAI API project key for moderation.
  - [x] Cloudflare DNS zone or domain for `league.<domain>` and `assets.<domain>`.
- [x] 2. Wire Render environment variables without committing secrets.
- [x] 3. Run Postgres migrations and schema checks against the real Render Postgres URL.
- [x] 4. Deploy the Render Web Service and verify `/api/health` plus `/api/metrics`.
- [x] 5. Connect `league.<domain>` to Render and `assets.<domain>` to R2.
- [x] 6. Run real integration checks: Resend login, Postgres persistence, Redis matchmaking/locks, R2 assets, OpenAI moderation, CLI/MCP doctor, and browser smoke.
- [x] 7. Bootstrap the first verified owner account to server-side `role=admin`.
  - [x] Add controlled ops script: `npm run admin:bootstrap -- --email=<verified-owner-email>`.
  - [x] The bootstrap script promotes only the exact owner email passed to `--email`; it does not promote every verified account.
  - [x] The bootstrap script demotes local demo admins ending in `@codexpet.local` during the real production owner bootstrap.
  - [x] Owner email `skskcb@gmail.com` signed in through Resend email-code login on the live server.
  - [x] Render one-off job `job-d7sgr49j2pic73f9q0s0` promoted only `skskcb@gmail.com` from `player` to `admin` and demoted one local demo admin.
  - [x] Render one-off job `job-d7sgrgfavr4c73b5qujg` confirmed admin-only endpoint access: unauthenticated rejected, normal player rejected, promoted owner accepted.
  - [x] Production admin access is locked to `skskcb@gmail.com` with `CODEX_PET_ADMIN_EMAIL_ALLOWLIST` so no other admin can access admin endpoints unless the owner explicitly changes that allowlist.
  - [x] Render one-off job `job-d7sgumegvqtc73buhf80` confirmed a non-owner `role=admin` account is rejected with `ADMIN_NOT_ALLOWED` while the owner admin session is accepted.
- [x] 8. Run a small live multiplayer test with pet import, matchmaking, battle, XP/LP settlement, replay, report, and moderation paths.
  - [x] Render one-off job `job-d7sgvt1j2pic73f9vplg` created disposable verified player sessions, uploaded hatch-pet atlas assets through the live API, created pets, submitted a Training Report, matched ranked PvP, resolved a turn battle, verified XP/LP/replay/profile, exercised asset report plus admin moderation, then cleaned the test accounts/pets/battles from Postgres state.
- [x] 9. Add backup/log/cost-alert/incident routines.
  - [x] `npm run backup` is documented for manual snapshots before risky changes; Render one-off backup output is explicitly treated as ephemeral unless retrieved.
  - [x] `npm run audit:summary` prints redacted audit finding counts and high/critical samples for incident triage.
  - [x] `npm run ops:rehash` dry-runs and applies documented append-only hash-chain migrations, such as the stable JSON hash migration needed after Postgres JSONB key normalization.
  - [x] `npm run ops:resolve-audit-alerts` closes stale open `audit:*` abuse alerts after their underlying high/critical audit finding is gone.
  - [x] `npm run cost:check` checks email-code challenge volume, asset upload/storage growth, open asset reports, and open abuse alerts against configurable warning/critical thresholds.
  - [x] `npm run incident:pack` collects `/api/health`, `/api/metrics`, redacted state summaries, and cost guard output without dumping secrets, session tokens, API keys, or full state.
- [x] 10. Publish official server URL and user setup docs.
  - [x] README names `https://league.codexpetz.com` as the official shared alpha server.
  - [x] `docs/USER_SETUP.md` documents install, email-code login, session token setup, MCP registration, hatch-pet import, Training Reports, matchmaking, and troubleshooting.
  - [x] The repo-local plugin scaffold defaults `CODEX_PET_LEAGUE_URL` to the official server, with docs for local/self-host overrides.

Post-launch alpha operating surface:

- [x] Publish alpha Privacy Notice at `https://league.codexpetz.com/privacy`.
- [x] Publish alpha Terms at `https://league.codexpetz.com/terms`.
- [x] Publish Support guidance at `https://league.codexpetz.com/support` with GitHub Issues for public bug reports and secret-sharing warnings.
- [x] Publish public Status page at `https://league.codexpetz.com/status` backed by `/api/health`.
- [x] Add GitHub Actions official monitor every 15 minutes for `/api/health`, `/api/metrics`, and public operating pages.
- [x] Add private support inbox docs and public references for `support@codexpetz.com`.
- [x] Complete Cloudflare Email Routing setup for `support@codexpetz.com` and verify delivery to the owner inbox.
- [ ] Add provider-level paging or a private escalation channel later if GitHub Actions failure notices are not enough.
- [ ] Add passkey and OAuth providers later when the alpha needs them.

Current live shared-server status:

- Render Web Service: `codex-pet-league`, service id `srv-d7s35rcm0tmc738lspj0`, official URL `https://league.codexpetz.com`, fallback Render URL `https://codex-pet-league.onrender.com`.
- Render custom domain `league.codexpetz.com` is verified.
- Render runtime env is configured for production, email-code auth through Resend, Postgres snapshots, Redis realtime/request guard/locks, OpenAI moderation, and Cloudflare R2 S3-compatible asset storage.
- Auth challenge email rate limit is IP-scoped to one request per 10 minutes.
- Private support inbox `support@codexpetz.com` is configured through Cloudflare Email Routing to the owner inbox; root-domain MX resolves to Cloudflare routing hosts.
- R2 bucket `codex-pet-league-assets` is configured and `assets.codexpetz.com` serves the tiny `ops-probe/r2-write-read-probe.png` object with 200 `image/png`.
- `CODEX_PET_PUBLIC_BASE_URL` and `CODEX_PET_LEAGUE_URL` are set to `https://league.codexpetz.com`.
- `CODEX_PET_ASSET_CDN_BASE_URL` is set to `https://assets.codexpetz.com`.
- Render one-off job `job-d7sfmi3eo5us73ah26l0` applied `001_initial_postgres_schema.sql` to the real Render Postgres database.
- Render one-off job `job-d7sfmmjrjlhs73bspa70` passed schema check with `1 migration, 25 tables`.
- Owner account `skskcb@gmail.com` is verified and server-side `role=admin`; the production owner bootstrap demoted local `@codexpet.local` demo admin access. Production admin access must stay owner-only unless the owner explicitly authorizes another email.
- `CODEX_PET_ADMIN_EMAIL_ALLOWLIST` is set to `skskcb@gmail.com`, and non-owner `role=admin` accounts are rejected by admin endpoints.
- Live multiplayer ranked smoke passed on 2026-05-04, and disposable test accounts/pets/assets/battles were cleaned from Postgres state afterward.
- Backup/log/cost-alert/incident routines are implemented as local/one-off ops commands: `npm run backup`, `npm run cost:check`, and `npm run incident:pack`. Durable exported backups must use a separate private backup bucket if added later, not the public R2 asset bucket.
- 2026-05-04 real integration checks passed:
  - Resend auth challenge through `https://league.codexpetz.com` returned 201 with Resend delivery and no exposed dev code.
  - Render one-off job `job-d7sg9fjeo5us73ahopmg` verified Postgres snapshot load/save persistence.
  - Render one-off job `job-d7sg9ibrjlhs73btfrsg` verified Redis PING, expiring request-guard-style keys, and distributed lock exclusion.
  - Render one-off job `job-d7sg9l77f7vs73d9bfm0` verified Cloudflare R2 write/read through the S3-compatible asset store.
  - Render one-off job `job-d7sg9o5ckfvc73cguso0` verified the moderation-only OpenAI `/v1/moderations` call path with `omni-moderation-latest`.
  - CLI `doctor`, `auth providers`, `bridge status`, and `rules` passed against the live Render fallback URL while local Windows DNS cache for `league.codexpetz.com` clears.
  - MCP `league_doctor` passed against the live server.
  - Playwright browser smoke loaded `https://league.codexpetz.com` and reached the expected signed-out UI state without unexpected JS or network failures.

Current provider recommendation as of 2026-05-04:

- Hosting/deployment: Render Web Service.
- Database: Render Postgres. Use the internal database URL from the Render Web Service when the app and database are in the same account and region.
- Realtime/request guard/locks: Render Key Value, Redis-compatible, from the first shared server launch. Use the internal URL from the same Render region when possible; the runtime supports both `redis://` and `rediss://`.
- Auth: native League email-code login with Resend delivery for the low-cost alpha. The League server owns challenge verification and issues its own `league_session`; Resend only sends the code email. Passkeys and OAuth/social login remain future additions.
- Object storage/CDN: Cloudflare R2 with S3-compatible API and a custom domain for public pet atlas assets.
- Moderation: OpenAI Moderation API with `omni-moderation-latest` for image and text checks, plus manual review for review/private/blocked asset states.
- Domain/DNS: Cloudflare-managed domain. Use `league.<domain>` as the Render Web Service custom domain for app/API/web/MCP traffic and `assets.<domain>` as the R2 custom domain. Keep app/API on one host so `league_session` remains a host-only `HttpOnly; SameSite=Lax; Secure` cookie. Admin access must come from a verified League session with server-side `role=admin`, bootstrapped after email-code login by a controlled one-off promotion; no shared admin token.

Official Codex sign-in docs:

- https://developers.openai.com/codex/app
- https://developers.openai.com/codex/cli
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

Codex CLI/App can sign in with ChatGPT for Codex access. That still does not give this League server a public, signed, server-verifiable OpenAI account identity claim. Keep League account auth separate until OpenAI documents such a claim/API.

## Official OpenAI Hatch Pet Compatibility

Official pet source link:

https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet

Use this OpenAI `hatch-pet` skill as the compatibility target for user-made pet appearances. The expected local package is:

```text
${CODEX_HOME:-~/.codex}/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

The official contract documents `pet.json` fields and a fixed sprite atlas. Current League importer supports PNG/WebP atlas upload and validates dimensions, MIME, safe relative `spritesheetPath`, manifest shape, manifest hash, spritesheet hash, and package fingerprint.

Important: public Codex App documentation does not currently expose a server-verifiable API, signed claim, or MCP field for reading the user's currently selected active Codex App pet. Treat local hatch package discovery as candidate input only.

League authority policy:

- Local `hatch-pet` packages are candidates.
- The League server's first active pet selection is the official League pet.
- Each League account has exactly one permanent active official pet selection.
- Switching to a different active pet after first selection is blocked with `ACTIVE_PET_SELECTION_LOCKED`.
- Re-selecting the already active pet is allowed and idempotent.
- If multiple local hatch packages are discovered, require an explicit `--path`; do not auto-pick the latest package.

## Account And Identity Policy

Launch account methods:

- Email code/magic-link login first, delivered by Resend and verified by the League server.
- Passkey later.
- League OAuth such as Google, Apple, GitHub, or another normal OAuth provider later.

League OAuth does not mean OpenAI account authority. OpenAI/ChatGPT account authority is future-only until OpenAI exposes a signed, server-verifiable identity claim with issuer, audience, expiry, replay protection, and a documented verification endpoint or public keys.

Until that exists:

- Do not treat OpenAI login, local Codex metadata, or Codex App session context as official ownership proof.
- Official League ownership comes from the League verified account and server records.
- `CODEX_PET_ACCOUNT_ID` is local development fallback only.
- Official requests should use a League session token or HttpOnly `league_session` cookie.

## Pet Ownership And Asset Rules

User hatch appearance should be preserved. The server does not redesign user pets.

Asset rules:

- The server validates the submitted hatch atlas and manifest.
- The server stores a canonical official copy and hash.
- The server stores source provenance: hatch source, hatch pet id, manifest sha256, atlas sha256, source fingerprint, upload account, and client package fingerprint hints.
- Cross-account reuse of the same hatch source fingerprint is allowed but flagged for review; do not automatically punish because false positives are possible.
- Asset records are immutable; changes create a new revision.
- Local file changes after registration have no ranked effect.
- Structurally valid assets become usable immediately.
- There is no manual pre-approval queue for normal pet usage.
- Safety, moderation, legal, or account enforcement can later hide or quarantine an asset.
- Active official pet assets are public by default so other players can see pets in profiles, battles, friend rooms, replays, and social surfaces.

Ownership rules:

- Official pets are permanently account-bound.
- No trading, selling, gifting, transfer, merge, marketplace, or progression migration in 1.0.
- Pet progression, stats, LP history, titles, mastery, and registered competitive identity do not transfer to another account.

## Elements, Stats, And Growth

Elements:

- Logic
- Patch
- Trace
- Forge
- Pulse
- Deploy

Each pet has a primary element and later a secondary element.

- Primary element is automatically determined from Codex activity analysis during creation.
- One reroll is allowed, chosen from strong activity-based candidates rather than pure random.
- Secondary element unlocks later from activity-derived candidates.
- Users choose from presented secondary candidates.

Element advantage cycle:

```text
Logic > Pulse > Trace > Deploy > Patch > Forge > Logic
```

Element advantage should matter without dominating:

- Primary advantage: +10% damage or status chance.
- Secondary advantage: +5%.
- Primary disadvantage: -10%.
- Secondary disadvantage: -5%.
- Final modifier is capped from -15% to +15%.
- The server computes modifiers. Clients only display hints.

Stats:

- Power
- Guard
- Speed
- Focus
- Recovery
- Insight

Starting balance:

- Every new pet starts with 100 total stats.
- Starting templates are fixed by primary element.
- Codex activity determines style and template, not starting power.
- Users cannot manually min-max starting stats.

Progression:

- Pet XP levels the pet and increases actual stats through Level 100.
- Level 1 starts at 100 total stats.
- Levels 2-100 grant +2 actual stat points per level.
- Level 100 reaches 298 total stats.
- Level 101+ is Mastery progression and grants cosmetics, titles, aura, prestige, and profile rewards only.
- Stat growth is automatic.
- Growth distribution follows primary/secondary element profiles, weighted 70% primary and 30% secondary.
- Fractional growth meters may be stored internally so long-term 70/30 distribution remains accurate.

Battle Classes:

| Battle Class | Total Stats | Typical Level Band |
| --- | ---: | --- |
| Hatch | 100-139 | Lv 1-20 |
| Core | 140-179 | Lv 21-40 |
| Surge | 180-219 | Lv 41-60 |
| Apex | 220-259 | Lv 61-80 |
| Prime | 260-298 | Lv 81-100 |

Main Ranked uses actual server-derived stats. Do not compress grown pets down to new-pet stats in the main ranked ruleset. Newer pets are protected through Battle Class matchmaking instead.

## XP, Style XP, And LP

Progression values:

- Pet XP: levels the pet, increases actual stats through Level 100, and moves the pet through Battle Classes.
- Style XP: cosmetic progression only.
- LP: ranked rating only.

Do not add Ranked Growth XP. Pet XP is the only level/stat progression XP.

Daily caps:

| Cap | Limit |
| --- | ---: |
| Total Pet XP per day | 700 |
| Training Report Pet XP per day | 400 |
| Battle Pet XP per day | 300 |
| Friend Duel Pet XP sub-cap per day | 75 |
| Style XP per day | 1,000 |
| Style XP per week | 5,000 |

Style XP never affects level, stats, LP, matchmaking, damage, defense, speed, recovery, or status formulas.

Training Report Pet XP:

| Report Type | Pet XP |
| --- | ---: |
| Light | 30 |
| Standard | 70 |
| Major | 120 |
| Milestone | 180 |

The first approved Daily Training Report receives +20% Pet XP. The maximum single Training Report reward is 216 XP.

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

Level 100 is about 61,700 Pet XP. At the 700 Pet XP daily cap, the fastest theoretical path is roughly 88-90 days.

## Ranked League

Ranked uses:

- Random matchmaking.
- Server-computed battle records.
- LP, tiers, divisions, and seasonal ladder.
- Five placement matches from a neutral 1500 hidden seed.

Top-level LP tiers:

- Bronze
- Silver
- Gold
- Platinum
- Diamond
- Mythic
- Codex

Bronze through Mythic each have three divisions. Codex is 6000+ LP and leaderboard-rank based.

Division LP bands:

- Bronze 1: 0-333
- Bronze 2: 334-666
- Bronze 3: 667-999
- Silver 1: 1000-1333
- Silver 2: 1334-1666
- Silver 3: 1667-1999
- Gold 1: 2000-2333
- Gold 2: 2334-2666
- Gold 3: 2667-2999
- Platinum 1: 3000-3333
- Platinum 2: 3334-3666
- Platinum 3: 3667-3999
- Diamond 1: 4000-4333
- Diamond 2: 4334-4666
- Diamond 3: 4667-4999
- Mythic 1: 5000-5333
- Mythic 2: 5334-5666
- Mythic 3: 5667-5999
- Codex: 6000+

LP changes:

- Win: +25 LP base.
- Loss: -25 LP base.
- Draw: +0 LP.
- AFK loss: -40 LP.
- Opponent LP modifiers apply for large underdog/favorite differences.
- Normal ranked LP changes clamp between -45 and +45.
- Placement matches double final movement and clamp between -90 and +90.

Main Ranked matchmaking order:

1. Battle Class.
2. LP, tier, and division.
3. Placement state.
4. Recent opponent limits and linked-account avoidance.
5. Queue time widening.

Ranked LP matches should not cross Battle Class in main ranked. Equalized stats can be a later special event mode, not the main ranked format.

## Battle System

Battles are real-time turn-based.

Modes:

- Ranked: random matchmaking, LP affected.
- Casual: random matchmaking, LP unaffected.
- Friend Duel: invite code, LP unaffected.
- Training Battle or sandbox simulation: testing and practice, no official LP.
- Season Finals can be added later for top ranked players.

Turn rules:

- Every turn has a fixed 30 second timer.
- Both players choose simultaneously.
- Server resolves the turn once both actions are submitted or the deadline expires.
- Clients submit only action intent.
- The server owns HP, energy, cooldowns, statuses, RNG, deadlines, nonces, and final results.

Core actions:

- Strike: stable basic damage and small energy gain.
- Skill: official skill, requires energy and/or cooldown.
- Guard: reduces incoming damage and improves status resistance.
- Focus: restores energy and empowers next skill or improves reliability.

Timeout rules:

- First timeout: automatic Guard.
- Second consecutive timeout: weaker Guard or no-op.
- Third consecutive timeout: AFK loss.
- Disconnect uses a short reconnect grace window, but the ranked timer continues.

Battle snapshots:

- At room creation, server snapshots pet id, asset hash/source summary, loadout, stats, Battle Class, skill versions, and ruleset version.
- Later loadout, asset, or stat changes do not affect that active room.
- Replays and logs are server-owned and tamper-evident.

## Skills

Skill mechanics are official and server-defined. Users cannot create custom ranked skill mechanics.

Season 1 starts with:

- Six elements.
- Five official skills per element.
- 30 official skills total.
- Exactly four active skill slots per battle loadout.

Skill nicknames:

- Users can create cosmetic aliases for official skills.
- Nicknames do not change mechanics.
- Nicknames should display in battle, replay, battle log, pet profile, and loadout surfaces.
- Nicknames should not display on leaderboards.
- Whenever a nickname appears, the official skill identity should also be available for clarity.
- Nicknames need length limits, moderation filters, and impersonation protection.

## Training Reports

Training Reports convert Codex work signals into server-scored growth.

Triggers:

- Natural language in Codex App, such as "Draft a pet Training Report", "Submit today's work for pet XP", and "Show pet XP status".
- CLI commands: `codexpet report draft`, `codexpet report submit`, `codexpet xp status`.
- MCP tools: `training_report_draft`, `training_report_submit`, `pet_status`.

Rules:

- Draft generation has no hard limit.
- Official submit is limited to 3 per day.
- Submissions require user approval.
- Automatic official submission is not allowed.
- Raw source code and full Codex transcripts must not be stored.
- Store summarized signals only.
- Server reclassifies and scores the report from allowed summary signals.
- Suspicious reports can be downgraded, rejected, delayed, held for review, or converted to Style XP only.

Codex activity examples:

- Tests and verification -> Logic.
- Bug fixing and recovery -> Patch.
- Debugging, search, logs -> Trace.
- Feature implementation -> Forge.
- Quick iteration -> Pulse.
- Documentation, cleanup, release work -> Deploy.

## Anti-Cheat And Trust Boundaries

Anti-cheat is a core architecture requirement, not a later moderation add-on.

Golden rules:

- The client is never authoritative.
- Codex App, CLI, plugin, browser UI, local files, and local hatch manifests are untrusted until server validation.
- Clients submit intent, assets, and report summaries only.
- Clients never submit official XP, LP, HP, stats, cooldowns, battle results, cap counters, or ranked outcomes.
- XP, LP, level, stats, Battle Class, ownership, battle results, and season records are server-derived.
- Current state must be replayable from server events, ledgers, snapshots, or immutable records.
- Server time is the only time used for caps, deadlines, resets, cooldowns, and seasons.
- Admin changes use audited ledger-like records.

Implemented/expected controls:

- League sessions, device binding, local provider-shaped auth flows, Resend email-code delivery for low-cost alpha login, and IP-scoped auth challenge rate limits of one email-code request per 10 minutes to reduce email cost abuse.
- Rate limits and idempotency keys for mutations.
- Replay prevention and stale action rejection.
- Turn nonces and server deadlines.
- Immutable server asset hashes and battle snapshots.
- XP/LP ledgers and replayable state, including audit recomputation of derived XP, Style XP, level, stats, Battle Class, and LP.
- Replay/event hash chains.
- Matchmaking repeated-opponent limits.
- Linked account and shared-client-context review cases.
- Friend Duel XP sub-cap and farming detection.
- Training Report dedupe, summary hash, and quality scoring.
- Official hatch package validation, asset upload validation, canonical storage, reporting, private/review/blocked moderation states, and duplicate source fingerprint review.
- Admin console for held reports, moderation, risk cases, manual enforcement, and season operations.

Risk-score policy:

- Risk scores are review signals first.
- Do not auto-punish normal users based only on a heuristic risk score.
- Ranked locks should be manual review outcomes or tamper-confirmed policy outcomes.
- False positives must be avoided, especially for linked IP/device/account patterns.

## Architecture Map

Key paths:

- `src/domain/state.js`: server-authoritative domain state and rules.
- `src/domain/battleEngine.js`: battle resolution logic.
- `src/domain/antiCheat.js`: anti-cheat/risk logic.
- `src/domain/audit.js`: audit and integrity checks.
- `src/server/index.js`: HTTP API, auth/session bridge, SSE, admin routes.
- `src/mcp/codex-pet-mcp.cjs`: Codex App MCP bridge.
- `src/cli/index.js`: CLI bridge and terminal play loop.
- `src/hatchPackage.cjs`: official `hatch-pet` local package discovery/import.
- `public/app.js`: web companion UI.
- `docs/plans/2026-05-02-codex-pet-league-design.md`: product design.
- `docs/plans/2026-05-02-codex-pet-league-server-design.md`: server/system design.
- `docs/plans/2026-05-02-codex-pet-league-anti-cheat-threat-model.md`: anti-cheat model.
- `docs/OPERATIONS.md`: operations loop.
- `docs/DEPLOYMENT.md`: production setup.
- `plugins/codex-pet-league/skills/codex-pet-league/SKILL.md`: Codex skill instructions.

## Runtime And Deployment Direction

Local development:

- JSON state is default.
- SQLite snapshots are supported for local persistence.
- Local filesystem stores asset objects by default.

Production-shaped direction:

- Postgres snapshot backend after migrations.
- Render Key Value Redis for realtime bus, request guard, and distributed locks from the first shared server launch.
- Cloudflare R2 S3-compatible object storage with a custom public asset domain.
- OpenAI Moderation API for image/text moderation triage.
- HTTPS with secure cookies.
- Resend email-code delivery for initial verified League login.
- Future passkey/OAuth providers when the account surface needs them.
- Server-side admin role bootstrap after verified email login, with League server-side `role=admin` enforcement.
- Bridge/replay signing secrets.
- `/api/health` and `/api/metrics` for runtime checks.
- `codexpet doctor` and MCP `league_doctor` for local Codex App/CLI runtime checks before deeper debugging.

Database conversion should be handled deliberately and late in the deployment path. Do not casually rewrite the persistence model while working on gameplay or UX features.

Production work not yet done:

- Provider choices, domain/admin strategy, real Render, Resend, Cloudflare R2, OpenAI, and domain credentials are wired and integration-checked; do not commit or expose the credential values.
- Local JSON storage remains the default dev path.
- Real Render Postgres migrations, schema checks, and snapshot persistence have passed.
- Redis and S3-compatible code paths have real provider credential runtime verification.
- OpenAI moderation is the chosen provider and has runtime verification; the production review runbook still needs completion.
- The first verified owner account has been bootstrapped to server-side `role=admin`.
- Backup/log/cost-alert/incident routines are implemented; external scheduling/alert delivery can be added later if the official server needs proactive notifications.
- Docker is not required for local verification right now; revisit it only if the selected deployment target needs container packaging.

## Verification Expectations

Before finishing meaningful changes, run the smallest useful set of checks. For broad changes, run the full set.

Common checks:

```powershell
npm test
npm run test:runtime
npm run test:browser
npm run balance:sim
npm run verify:loop -- 2
git diff --check
```

Other useful checks:

```powershell
npm run test:abuse
npm run test:storage
npm run test:load
npm run db:schema:check
npm run prod:check
npm run ops:check
```

For JavaScript syntax-only checks:

```powershell
node --check src/server/index.js
node --check src/domain/state.js
node --check src/cli/index.js
node --check src/mcp/codex-pet-mcp.cjs
node --check public/app.js
```

## Do Not Break These Decisions

- Do not rely on a Codex App active pet API unless OpenAI officially documents a server-verifiable claim/API.
- Do not treat ChatGPT sign-in to Codex as League login. It is Codex access only unless OpenAI provides a verified identity handoff.
- Do not allow active League pet switching after first selection.
- Do not add pet trading or account-to-account pet transfer.
- Do not let Style XP affect combat power.
- Do not make custom user skill mechanics ranked-authoritative.
- Do not let clients submit final XP, LP, stats, HP, or battle results.
- Do not trust stored pet XP, level, stats, Battle Class, or LP unless it matches the append-only XP/LP ledgers.
- Do not allow an asset under moderation review or private visibility into ranked; safety-blocked assets cannot enter battles.
- Do not auto-punish users only because a heuristic risk score is high.
- Do not make main ranked cross Battle Class.
- Do not make web the only required play surface.
- Do not store raw source code or full Codex transcripts in Training Reports.
- Do not use `OPENAI_API_KEY` for any paid OpenAI model endpoint. The official shared server key is moderation-only and should be used only for `/v1/moderations` with `omni-moderation-latest`.
- Do not grant, retain, or accept official shared-server admin access for anyone except `skskcb@gmail.com` unless the owner explicitly instructs a new admin allowlist change.
