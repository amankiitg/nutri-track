/**
 * The local page: two boxes and a button.
 *
 * Plain HTML and a plain form POST, no JavaScript: the page has exactly one job, and a page that
 * cannot break is worth more here than one that feels app-like. The credential is never sent to
 * the browser — this page only ever learns the outcome.
 */
import { SENDER_NAME, SUBJECT } from "./invite.js";

/**
 * The name and address come from the form and are echoed back, so they are escaped.
 *
 * Not a security boundary — it is your own laptop and your own typing — but a name with an
 * ampersand in it should not render as broken markup, and a stray `<` should not swallow the
 * rest of the page.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The app's own palette, so the tool looks like the thing it is inviting people to. */
const STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    padding: 2rem 1rem;
    display: grid;
    place-items: center;
    background: #f0ece4;
    color: #192217;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main {
    width: 100%;
    max-width: 30rem;
    padding: 2rem;
    background: #fffdf9;
    border: 1px solid #e2ded2;
    border-radius: 20px;
  }
  h1 {
    margin: 0 0 0.5rem;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.55rem;
    letter-spacing: -0.01em;
  }
  .lead { margin: 0 0 1.25rem; color: #5e6657; }
  label { display: block; margin: 1rem 0 0.35rem; font-size: 0.85rem; font-weight: 600; }
  input {
    width: 100%;
    height: 2.75rem;
    padding: 0 0.85rem;
    font: inherit;
    background: #fff;
    border: 1px solid #e2ded2;
    border-radius: 12px;
  }
  input:focus-visible { outline: 2px solid #195c2e; outline-offset: 1px; }
  .hint { margin: 0.5rem 0 0; font-size: 0.8rem; color: #5e6657; }
  button, .button {
    display: inline-block;
    margin-top: 1.5rem;
    padding: 0.85rem 1.6rem;
    font: inherit;
    font-weight: 700;
    color: #fbf8f1;
    background: #195c2e;
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    text-decoration: none;
  }
  button:hover, .button:hover { background: #14491f; }
  dl { margin: 1.25rem 0 0; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.4rem 0; border-top: 1px solid #e2ded2; }
  dt { color: #5e6657; font-size: 0.9rem; }
  dd { margin: 0; font-weight: 600; text-align: right; }
  .problem { margin: 0 0 1rem; padding: 0.85rem 1rem; border-radius: 12px; background: #fbeae8; color: #8c1d18; white-space: pre-wrap; }
  a.plain { color: #195c2e; }
  .foot { margin: 1.25rem 0 0; font-size: 0.85rem; color: #5e6657; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`;
}

/** The form. `notice` is for a rejection worth repeating back, like a malformed address. */
export function formPage(address: string, notice?: string): string {
  const problem =
    notice === undefined ? "" : `      <p class="problem">${escapeHtml(notice)}</p>\n`;
  return shell(
    "Invite someone — NutriTrack",
    `${problem}      <h1>Invite someone</h1>
      <p class="lead">
        Creates a Gmail <strong>draft</strong> in ${escapeHtml(address)}. It never sends: read it in
        Gmail, then send it yourself.
      </p>
      <form method="post" action="/draft">
        <label for="name">Their first name</label>
        <input id="name" name="name" autocomplete="off" required autofocus />

        <label for="email">Their email</label>
        <input id="email" name="email" type="email" autocomplete="off" required />

        <p class="hint">
          Add it on the Admin page first — that is the address the invite is tied to, and what the
          email tells them to sign in with.
        </p>

        <button type="submit">Generate draft</button>
      </form>`,
  );
}

/** The good outcome. Reviewing happens in Gmail, so this just says where to look. */
export function createdPage(input: { name: string; email: string; address: string }): string {
  return shell(
    "Draft created — NutriTrack",
    `      <h1>Draft created</h1>
      <p class="lead">It is in your Gmail drafts, waiting for you to read it.</p>
      <dl>
        <div class="row"><dt>To</dt><dd>${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;</dd></div>
        <div class="row"><dt>From</dt><dd>${escapeHtml(input.address)}</dd></div>
        <div class="row"><dt>Subject</dt><dd>${escapeHtml(SUBJECT)}</dd></div>
        <div class="row"><dt>Signed</dt><dd>${escapeHtml(SENDER_NAME)}</dd></div>
      </dl>
      <a class="button" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Open Gmail drafts</a>
      <p class="foot"><a class="plain" href="/">Invite someone else</a></p>`,
  );
}

/**
 * The bad outcome. `message` has already been through `safeError`, so it cannot contain the
 * credential — this is the one place a failure is shown, and it is shown nowhere else.
 */
export function problemPage(message: string): string {
  return shell(
    "Could not create the draft — NutriTrack",
    `      <h1>Could not create the draft</h1>
      <p class="problem">${escapeHtml(message)}</p>
      <p class="lead">
        Nothing was created and nothing was sent. Check <code>GMAIL_ADDRESS</code> and
        <code>GMAIL_APP_PASSWORD</code> in <code>.env</code>, then try again — or run
        <code>npm run invite:check</code>, which reports whether the account accepts the credential
        without creating anything.
      </p>
      <p class="foot"><a class="plain" href="/">Back</a></p>`,
  );
}
