# Codex Pet League User Setup

This guide is for players who want to use the official shared alpha server.

Official server:

```text
https://league.codexpetz.com
```

Web UI:

```text
https://league.codexpetz.com
```

Public pet assets:

```text
https://assets.codexpetz.com
```

Official alpha operation pages:

- Status: https://league.codexpetz.com/status
- Support: https://league.codexpetz.com/support
- Privacy Notice: https://league.codexpetz.com/privacy
- Alpha Terms: https://league.codexpetz.com/terms

## 1. Install From GitHub

Clone the repo and install dependencies:

```bash
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
```

PowerShell works too:

```powershell
git clone https://github.com/BMinChul/codex-pet-league.git
cd codex-pet-league
npm install
```

You do not need to run the local server when using the official shared alpha.

## 2. Point CLI At The Official Server

Bash:

```bash
export CODEX_PET_LEAGUE_URL=https://league.codexpetz.com
```

PowerShell:

```powershell
$env:CODEX_PET_LEAGUE_URL="https://league.codexpetz.com"
```

Check the connection:

```bash
npm run cli -- doctor
npm run cli -- auth providers
```

## 3. Log In With Email Code

Request a code:

```bash
npm run cli -- auth challenge --method email_magic_link --identifier you@example.com
```

Check your email, then verify:

```bash
npm run cli -- auth verify --challenge challenge_id_from_previous_step --code EMAILCODE
```

The verify command prints a `session_token`. Set it for future official League requests.

Bash:

```bash
export CODEX_PET_SESSION_TOKEN=league_session_token_from_verify
```

PowerShell:

```powershell
$env:CODEX_PET_SESSION_TOKEN="league_session_token_from_verify"
```

The official server rate-limits email-code requests to one request per IP every 10 minutes. If you request a code and immediately request another, the second request can be rejected on purpose.

## 4. Register Codex App MCP

From the repo root:

```powershell
$repo = (Get-Location).Path
codex mcp add codex-pet-league -- node "$repo\src\mcp\codex-pet-mcp.cjs"
```

Before starting Codex App or Codex CLI, make sure these environment variables are available to the MCP process:

```powershell
$env:CODEX_PET_LEAGUE_URL="https://league.codexpetz.com"
$env:CODEX_PET_SESSION_TOKEN="league_session_token_from_verify"
```

If your Codex environment loads the repo-local plugin scaffold, it is under:

```text
plugins/codex-pet-league
```

The plugin scaffold points to the official server by default. Self-hosted users can change `CODEX_PET_LEAGUE_URL` in `plugins/codex-pet-league/.mcp.json`.

## 5. Create A Hatch Pet

Codex Pet League targets OpenAI's official `hatch-pet` package format. The expected local package is:

```text
${CODEX_HOME:-~/.codex}/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

Use the official hatch-pet skill in Codex first, then come back here. If you have more than one local hatch package, choose explicitly; the first official League pet selection is permanent for your account.

Discover local hatch packages:

```bash
npm run cli -- pet discover-hatch
```

Inspect one package before upload:

```bash
npm run cli -- pet inspect-hatch --path <hatch-pet-folder>
```

## 6. Import And Lock Your Official Pet

The simplest flow is:

```bash
npm run cli -- setup --path <hatch-pet-folder> --yes --primary Forge --secondary Trace
```

You can choose a different primary and secondary element:

```text
Logic
Patch
Trace
Forge
Pulse
Deploy
```

Important: each League account has exactly one permanent active official pet selection. Re-selecting the same pet is allowed, but switching to a different active pet after the first selection is blocked.

## 7. Play

Check your home state:

```bash
npm run cli -- home
npm run cli -- daily
npm run cli -- next
```

Draft and submit a Training Report:

```bash
npm run cli -- report draft --implementation --verification --tests-run 3
npm run cli -- report submit --implementation --verification --tests-run 3
```

Join ranked matchmaking:

```bash
npm run cli -- queue join --mode ranked
npm run cli -- queue status
```

Play an active battle:

```bash
npm run cli -- battle watch --battle battle_room_id --once
npm run cli -- battle actions --battle battle_room_id
npm run cli -- battle action --battle battle_room_id --kind strike
```

Friend duel:

```bash
npm run cli -- invite create
npm run cli -- invite accept --code ABC123
```

## 8. Codex App Phrases

Once MCP is registered and the session token is available to it, these natural-language prompts should map to League tools:

```text
리그 상태 점검해줘
내 펫 상태와 오늘 남은 XP 보여줘
내 hatch-pet 펫 찾아줘
이 hatch-pet 파일 검증해줘
내 hatch-pet 펫 서버에 올려줘
처음 선택한 펫을 공식으로 확정할래
훈련 리포트 초안 만들어줘
랭크 랜덤매칭 잡아줘
지금 배틀에서 뭐해야돼
```

## Troubleshooting

If the CLI cannot reach the server:

```bash
npm run cli -- doctor
```

If auth fails:

```bash
npm run cli -- auth providers
```

If commands return `SESSION_INVALID`, set `CODEX_PET_SESSION_TOKEN` again from your latest `auth verify` output.

If pet import fails, run:

```bash
npm run cli -- pet inspect-hatch --path <hatch-pet-folder>
```

The server validates the hatch manifest, spritesheet dimensions, MIME type, safe paths, hashes, and asset policy. Local file edits after registration do not change ranked state.

## Privacy Notes

The official shared alpha stores League account records, pet metadata, uploaded canonical pet atlas assets, Training Report summaries, battle/replay records, XP/LP ledgers, moderation metadata, and operational audit events on the League server.

Do not submit raw source code or full Codex transcripts in Training Reports. Training Reports should contain summarized work signals only.

Codex App or ChatGPT sign-in is not treated as League account authority. League ownership comes from League email-code login and server records.
