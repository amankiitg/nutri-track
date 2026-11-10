/**
 * iOS Safari zooms the page when a field whose font is under 16px takes focus, and the
 * zoom shifts the screen sideways. The fix is 16px (`text-base`) on every focusable text
 * field at phone widths, never `maximum-scale` in the viewport meta, which also takes
 * pinch zoom away from people who need it.
 *
 * jsdom has no layout and no iOS, so this reads the source instead: every input, textarea
 * and select in src/ must not carry an unprefixed `text-xs`, `text-sm` or `text-[<16px]`,
 * and a raw element (not the `Input`/`Textarea` primitives, which default to `text-base`)
 * must name a font size, because Safari's own default for a field is about 13px.
 * A `md:` or other prefixed size is fine: that is the desktop design.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const FIELD = /<(input|textarea|select|Input|Textarea)\b/g;
const NOT_TEXT = /\btype=["'](checkbox|radio|hidden|file|range|color)["']/;
const SMALL = /(?<![\w:-])text-(xs|sm|\[(?:[0-9]|1[0-5])(?:\.\d+)?px\])(?![\w-])/;
const SIZED = /(?<![\w:-])text-(base|lg|xl|[2-9]xl|\[(?:1[6-9]|[2-9]\d)(?:\.\d+)?px\])(?![\w-])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".tsx") && !path.includes(".test.") ? [path] : [];
  });
}

/** The tag's own text, from `<` to the `>` that closes it, skipping `>` inside `{...}`. */
function tagText(source: string, start: number): string {
  let depth = 0;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    // The primitives' own markup is checked through its consumers.
    if (file.includes(`${join("components", "ui")}`)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(FIELD)) {
      const tag = tagText(source, match.index);
      if (NOT_TEXT.test(tag) || /tabIndex=\{-1\}/.test(tag)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      const element = match[1] ?? "";
      const where = `${relative(ROOT, file)}:${line} <${element}>`;
      if (SMALL.test(tag)) found.push(`${where} has a font under 16px on phones`);
      else if (/^[a-z]/.test(element) && !SIZED.test(tag))
        found.push(`${where} names no font size`);
    }
  }
  return found;
}

describe("form fields on iOS", () => {
  it("are at least 16px at phone widths, so focusing one does not zoom the page", () => {
    expect(offenders()).toEqual([]);
  });

  it("keep the primitives at text-base below md", () => {
    for (const name of ["input.tsx", "textarea.tsx", "select.tsx"]) {
      const source = readFileSync(join(ROOT, "components", "ui", name), "utf8");
      expect(source, name).toMatch(/(?<![\w:-])text-base\b/);
      expect(source, name).toMatch(/\bmd:text-sm\b/);
    }
  });

  it("does not disable zoom in the viewport meta", () => {
    const root = readFileSync(join(ROOT, "routes", "__root.tsx"), "utf8");
    expect(root).not.toMatch(/maximum-scale|user-scalable/);
  });
});
