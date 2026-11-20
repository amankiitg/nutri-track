# Email style

Every email this repo sends, transactional or broadcast, is rendered by `renderEmail()` in
`shared/email-layout.ts`. **Never hand-write email HTML.** If a message needs a shape the layout
does not have, add a section type to the layout and use it everywhere, rather than pasting a
one-off table into a file.

Broadcast copy lives in `tools/email/render.ts` and its `.html` is generated:

```sh
npm run email:render   # rewrites emails/*.html from the layout
```

`shared/email-layout.test.ts` fails if a checked-in `.html` does not match that output, so a hand
edit cannot survive. The `.txt` parts are written by hand beside them, because stripping tags
produces a worse read than writing it out.

## Colours

Copied from the app's own tokens via the invite email. No other hex value belongs in an email.

| Role | Value |
| --- | --- |
| Page background | `#f0ece4` (cream) |
| Card | `#fffdf9` |
| Card border | `#e2ded2` |
| Body ink | `#192217` (near black) |
| Quiet ink | `#5e6657` |
| Leaf green (links, emphasis, button) | `#195c2e` |
| Panel | `#f4f0e6` |
| Button text | `#fbf8f1` |
| Offer line under the button | `#2f3a2b` |

## Fonts

Two stacks, both with local fallbacks, and no `<link>` to a web font (the request would be
dropped or would delay the render):

- Display, 34px / 1.05 / 700 / `-0.02em`: `"Fraunces", Georgia, "Times New Roman", serif`
- Body, 16px / 1.6 and smaller: `"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`

## Shape and spacing

- Card: max width **600px**, `#fffdf9`, 1px `#e2ded2` border, **20px** radius, centred in a 32px / 16px page pad.
- Logo row: 40px icon, 10px radius, brand wordmark 19px display, padding `40px 40px 8px`.
- Headline: optional, inside the logo cell with `margin: 28px 0 0 0`, one phrase in leaf green.
- Body blocks: padding `24px 40px 0`, 16px / 1.6. A block that follows the button uses `26px`.
- Panel: `#f4f0e6`, 1px border, **14px** radius, padding `16px 18px`, 15px quiet ink.
- GIF: max width **480px**, `width: 100%`, linked to the same place as the button, alt text names the action.
- Button: one per email, centred, pill. Anchor `padding: 16px 34px`, **999px** radius, filled `#195c2e`, `#fbf8f1`, 16px / 700. Under it: a 12px quiet line, then an optional 14px `#2f3a2b` offer line.
- Sign-off: `26px 40px 0`, the closing line then the name.
- Footer: `28px 40px 40px`, 1px top border, 12px quiet ink, the reason sentence, then the unsubscribe link.

## Copy rules

1. **Plain and personal.** It reads as a note from Aman, not a campaign. Short sentences, no marketing register, no exclamation-mark stacking.
2. **From Aman**, first person, signed with a name. Transactional notes are signed too.
3. **No em dashes and no en dashes.** Use commas, full stops or brackets. The tests check this in every file.
4. **One button.** The thing to do appears once, phrased as the action ("Try it free", "Open NutriTrack").
5. **Every broadcast explains itself** in the footer and carries `{{{RESEND_UNSUBSCRIBE_URL}}}`. A transactional email may omit the token but never the reason.
6. **Merge tags are Resend's**: `{{{contact.first_name|there}}}` with a fallback, and the unsubscribe token verbatim.
7. **No invented facts.** A number in the copy is either measured or left out.

## Before finishing

Render the email at **600px and 375px** with playwright-core (not the Chrome CLI, which hangs on
these pages), check there is no horizontal overflow, and compare it against the invite email. If
it does not look like the invite, it does not ship.
