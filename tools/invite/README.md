# Invite tool

Local-only. Creates a Gmail **draft** of the NutriTrack invite. It never sends — read the draft
and send it yourself.

## One-time setup

```sh
cd tools/invite
npm install
```

Then put these two names in the repo-root `.env`, which is gitignored:

```
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=...
```

An app password comes from Google Account → Security → 2-Step Verification → App passwords. It
requires 2-Step Verification, and Google does not offer app passwords at all on accounts enrolled
in Advanced Protection. If yours is, this tool needs the Gmail API instead — only the transport
changes, not the message.

## Inviting someone

1. **Add their address on the Admin page first.** That is what the email tells them to sign in
   with, and `allowed_emails` is already the record of who was invited and when.
2. `npm run invite` from the repo root. It starts a page on <http://127.0.0.1:8788> and prints the
   URL; open it if your browser does not.
3. Type their first name and their email, press **Generate draft**.
4. The page then says the draft is there and links to Gmail. Read it, then send it yourself.

One person at a time. There is no batch mode, on purpose.

If it cannot sign in, the page says so and offers no theory about why. Run `npm run invite:check`
for the detail: it reports whether the account accepts the credential without creating anything.

## Why this is a local page and not a panel on the admin page

The Gmail credential is a password to a mailbox, not a row in a table. Serving this page from the
app would mean either shipping that credential to a server or holding a session that can write to
your mailbox — so it stays on the laptop and the admin page stays a list of addresses.

`src/server.ts` binds to `127.0.0.1` and not `0.0.0.0`. That is the same decision: an open port on
the local network would put an endpoint that writes to your mailbox one line away from anyone on
it. There is no code path that sends.

## Editing the email

`src/invite.ts` is the only copy. Change it, then run `npm run invite:preview` from the repo root
to regenerate `docs/invite-email.html`. Never edit that file: it is generated, and two copies of
an email drift until the one you send is not the one you meant.

The plain-text and HTML parts are both written there. They are separate rather than derived,
because stripping tags from the HTML reads worse, and the line about which address to sign in
with has to survive into the fallback. Keep the two in step.

## The credential

`src/redact.ts`. Nothing in this tool prints, logs, or puts the app password in an error message,
and `npm run test:invite` covers that. It is registered once at startup, so anything that fails
afterwards — a rejected login, a timeout mid-append — is redacted by default rather than by
remembering to be careful at each site.

`imapflow`'s logger is off for the same reason: it logs the IMAP commands it sends, and
`AUTHENTICATE` is one of them. And its `error` event has a handler in `src/draft.ts`, because an
unhandled one is an uncaught exception that prints a stack — a second output path that never went
through `redact`.
