# Codex Pet League Share Kit

Use this when sharing the public alpha with early users.

## Short Announcement

Codex Pet League is a Codex App and Codex CLI-first pet league for pets created with OpenAI's official `hatch-pet` skill.

Bring your hatch pet into the official shared alpha server, submit Training Reports from your Codex work, grow your pet, and play server-authoritative turn battles against other users.

- GitHub: https://github.com/BMinChul/codex-pet-league
- Official alpha: https://league.codexpetz.com
- Setup guide: https://github.com/BMinChul/codex-pet-league/blob/master/docs/USER_SETUP.md
- Latest release: https://github.com/BMinChul/codex-pet-league/releases/tag/v0.1.0-alpha

## Longer Post

Codex Pet League is a public alpha for Codex-born pets.

If you create a pet with OpenAI's official `hatch-pet` skill, you can import that pet into a shared League server, preserve its appearance, and use it in Training Reports, profiles, leaderboards, replays, friend duels, and ranked turn battles.

The important bit: the server is authoritative. Local files can provide the hatch appearance, but ranked XP, LP, stats, matchmaking, battle results, replays, and asset hashes are all computed and stored by the League server.

Current alpha flow:

```bash
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
export CODEX_PET_LEAGUE_URL=https://league.codexpetz.com
npm run cli -- doctor
```

Then log in with an email code and import your `hatch-pet` package:

```bash
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
npm run cli -- auth verify --challenge challenge_id_from_previous_step --code EMAILCODE
export CODEX_PET_SESSION_TOKEN=league_session_token_from_verify
npm run cli -- pet discover-hatch
npm run cli -- setup --path <hatch-pet-folder> --yes --primary Forge --secondary Trace
```

Full setup guide:

```text
docs/USER_SETUP.md
```

## What To Tell Testers

- Use a real `hatch-pet` package before locking your official League pet.
- The first active official League pet is permanent for that League account.
- Do not send raw source code, API keys, session tokens, or full Codex transcripts in Training Reports or support requests.
- Public bugs can go to GitHub Issues.
- Private account, moderation, privacy, or security-sensitive reports should go to `support@codexpetz.com`.

## One-Line Description

Codex Pet League turns OpenAI `hatch-pet` companions into server-authoritative Codex CLI/App pets with Training Reports, XP, ranked battles, replays, and public profiles.
