# Codex Identity Probe

This probe checks what a Codex local MCP server can see during normal tool calls.

It intentionally does not read `~/.codex/auth.json`, OS credential stores, browser storage,
or any OpenAI token file. It only reports sanitized process environment and MCP request metadata.

Run:

```powershell
$repo = (Get-Location).Path
codex mcp add codex-identity-probe -- node "$repo\identity-probe\mcp-identity-probe.cjs"
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "Use the codex-identity-probe MCP tool identity_probe once and summarize whether it includes a signed OpenAI/ChatGPT user identity claim."
```

Logs are written under `identity-probe/logs/`.
