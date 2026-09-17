/**
 * Regenerates `docs/invite-email.html` from the template.
 *
 * The committed file is a preview, not a second copy: edit `src/invite.ts`, run this, commit
 * both. It renders the placeholder values, so the file stays generic and can still be filled in
 * by hand if the tool is ever unavailable.
 *
 * No credentials are read here, so this runs anywhere.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PREVIEW, renderInviteHtml } from "../../../shared/invite-email.js";

const OUT = fileURLToPath(new URL("../../../docs/invite-email.html", import.meta.url));

writeFileSync(OUT, renderInviteHtml(PREVIEW));
process.stdout.write(`Wrote ${OUT}\n`);
