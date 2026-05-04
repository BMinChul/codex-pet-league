# Codex Pet League Support Inbox

The official shared alpha private support address is:

```text
support@codexpetz.com
```

Use this for account access problems, moderation appeals, privacy questions, and reports that include private identifiers. Keep public reproducible bugs in GitHub Issues.

## Recommended Provider

Use Cloudflare Email Routing for inbound support during alpha.

Why this path:

- It forwards `support@codexpetz.com` to the owner inbox without buying a paid mailbox.
- It works at the domain DNS layer and is separate from Resend.
- It avoids exposing the owner's personal email address on the public site.
- It can be disabled quickly if spam becomes noisy.

## Cloudflare Setup

1. Open Cloudflare Dashboard.
2. Select the `codexpetz.com` zone.
3. Go to Email Routing.
4. Onboard the domain if Cloudflare asks.
5. Add the destination inbox, such as the owner Gmail address.
6. Open the verification email in that destination inbox and confirm it.
7. Create a custom address with local part `support`.
8. Set the action to send mail to the verified destination inbox.
9. Keep catch-all disabled or set it to drop during alpha.
10. Send a test email from another mailbox to `support@codexpetz.com`.

## DNS Notes

Cloudflare Email Routing adds or manages MX records for receiving mail at the root domain.

Do not delete the existing Resend DNS records for the League sender. Resend remains the outbound login-code sender, while Cloudflare handles inbound support forwarding.

Expected split:

- `support@codexpetz.com`: inbound support forwarding through Cloudflare Email Routing.
- `no-reply@league.codexpetz.com` or the configured League sender: outbound email-code delivery through Resend.
- `CODEX_PET_RESEND_REPLY_TO=support@codexpetz.com`: replies to login-code emails go to private support.

## Handling Rules

- Never ask users to send session tokens, API keys, passwords, payment details, raw source code, or full Codex transcripts.
- Ask for approximate time, timezone, visible error code, CLI/MCP/web surface, and pet/battle/replay ids only when needed.
- Keep moderation and account reports private unless the user explicitly chooses to make a public GitHub issue.
- If a support email reports a visible pet asset, use the admin moderation queue and keep ranked locks manual.
- If a message looks like abuse or credential leakage, do not paste it into public issues or logs.

## Smoke Test

After Cloudflare routing is active:

1. Send mail from a non-owner mailbox to `support@codexpetz.com`.
2. Confirm it arrives in the owner inbox.
3. Reply from the owner inbox and confirm the sender identity is acceptable for alpha support.
4. Run:

```bash
npm run monitor:official
```

The monitor checks the support page mentions the public support flow, but mailbox delivery still needs the manual email smoke test above.
