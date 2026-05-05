# Codex Pet League

Codex App and Codex CLI-first pet growth, Training Reports, and server-authoritative turn battles.

Codex Pet League lets users bring pets made with OpenAI's official `hatch-pet` skill into a shared League server where progression, battles, XP, LP, assets, and replays are owned by the server instead of local files.

## Links

- Official shared alpha: https://league.codexpetz.com
- Latest alpha release: https://github.com/BMinChul/codex-pet-league/releases/tag/v0.1.0-alpha
- User setup guide: docs/USER_SETUP.md
- Status: https://league.codexpetz.com/status
- Support: https://league.codexpetz.com/support

## Quick Start

Clone the CLI, MCP bridge, and Codex App plugin scaffold:

```bash
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
export CODEX_PET_LEAGUE_URL=https://league.codexpetz.com
npm run cli -- doctor
```

PowerShell:

```powershell
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
$env:CODEX_PET_LEAGUE_URL="https://league.codexpetz.com"
npm run cli -- doctor
```

Log in with an email code:

```bash
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
npm run cli -- auth verify --challenge challenge_id_from_previous_step --code EMAILCODE
export CODEX_PET_SESSION_TOKEN=league_session_token_from_verify
```

Import a real OpenAI `hatch-pet` package:

```bash
npm run cli -- pet discover-hatch
npm run cli -- pet inspect-hatch --path <hatch-pet-folder>
npm run cli -- setup --path <hatch-pet-folder> --yes --primary Forge --secondary Trace
```

Important: your first active official League pet is permanent for that League account. Do not lock a demo pet if you want to use a real pet later.

## Codex App MCP

Register the MCP bridge from the repo root:

```powershell
$repo = (Get-Location).Path
codex mcp add codex-pet-league -- node "$repo\src\mcp\codex-pet-mcp.cjs"
```

Common Codex prompts:

```text
Check League status.
Find my hatch-pet packages.
Import my hatch-pet to the League server.
Show my pet status and today's remaining XP.
Join ranked matchmaking.
```

## What Works

- Official shared alpha server at `https://league.codexpetz.com`.
- Email-code League login with server-owned sessions.
- OpenAI `hatch-pet` package discovery, inspection, validation, upload, and permanent first-pet selection.
- Training Reports for Pet XP and Style XP.
- Server-authoritative turn battles, ranked matchmaking, LP settlement, replay logs, and public profiles.
- Redis-backed realtime bus, request guards, and distributed locks on the official server.
- Postgres-backed production state, R2-backed public pet assets, and OpenAI Moderation API triage.

## Docs

- Player setup: docs/USER_SETUP.md
- Share/announcement copy: docs/SHARE.md
- Deployment and self-hosting: docs/DEPLOYMENT.md
- Operations: docs/OPERATIONS.md
- Support inbox setup: docs/SUPPORT_INBOX.md
- Alpha release notes: docs/releases/v0.1.0-alpha.md

## Local Development

```bash
npm install
CODEX_PET_AUTH_DEV_CODE=true npm start
```

PowerShell:

```powershell
$env:CODEX_PET_AUTH_DEV_CODE="true"; npm start
```

Then open `http://localhost:4317`.

## Security

Do not commit `.env`, provider credentials, API keys, session tokens, local state, uploaded assets, database files, or personal machine paths.

This repo tracks `.env.example` only. Real production secrets belong in Render, Cloudflare, Resend, OpenAI, or another provider's private environment settings.
