/**
 * iOS Safari zooms the page when a field whose font is under 16px takes focus, and the
 * zoom shifts the screen sideways. The fix is 16px (`text-base`) on every focusable text
 * field at every width (iPad Safari is 768px and up and zooms too), never `maximum-scale`
 * in the viewport meta, which also takes pinch zoom away from people who need it.
 *
 * jsdom has no layout and no iOS, so this reads the source instead: every input, textarea
 * and select in src/ must not carry `text-xs`, `text-sm` or `text-[<16px]` at any
 * breakpoint (`md:text-sm` included), and a raw element (not the `Input`/`Textarea`
 * primitives, which are `text-base`) must name a font size, because Safari's own default
 * for a field is about 13px. Only the `file:` and `placeholder:` variants may be smaller:
 * they style the file button and the placeholder, not the text being typed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const FIELD = /<(input|textarea|select|Input|Textarea)\b/g;
const NOT_TEXT = /\btype=["'](checkbox|radio|hidden|file|range|color)["']/;
const SMALL = /(?<![\w-])((?:[\w-]+:)*)text-(xs|sm|\[(?:[0-9]|1[0-5])(?:\.\d+)?px\])(?![\w-])/g;
const HARMLESS_VARIANT = /(^|:)(file|placeholder):/;

/** Small sizes on the field itself, at any breakpoint. */
function smallSizes(classes: string): string[] {
  return [...classes.matchAll(SMALL)]
    .filter((m) => !HARMLESS_VARIANT.test(m[1] ?? ""))
    .map((m) => m[0]);
}
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
      const small = smallSizes(tag);
      if (small.length > 0) found.push(`${where} has a font under 16px: ${small.join(" ")}`);
      else if (/^[a-z]/.test(element) && !SIZED.test(tag))
        found.push(`${where} names no font size`);
    }
  }
  return found;
}

describe("form fields on iOS", () => {
  it("are at least 16px at every width, so focusing one does not zoom the page", () => {
    expect(offenders()).toEqual([]);
  });

  it("keep the field primitives at text-base, with no smaller size at any breakpoint", () => {
    for (const name of ["input.tsx", "textarea.tsx"]) {
      const source = readFileSync(join(ROOT, "components", "ui", name), "utf8");
      expect(source, name).toMatch(/(?<![\w:-])text-base\b/);
      expect(smallSizes(source), name).toEqual([]);
    }
    // The Select trigger: its first class list is the trigger's; the item lists below it
    // are menu rows, not fields.
    const select = readFileSync(join(ROOT, "components", "ui", "select.tsx"), "utf8");
    const trigger = /SelectPrimitive\.Trigger[\s\S]*?"([^"]+)"/.exec(select)?.[1] ?? "";
    expect(trigger).toMatch(/(?<![\w:-])text-base\b/);
    expect(smallSizes(trigger)).toEqual([]);
  });

  it("does not disable zoom in the viewport meta", () => {
    const root = readFileSync(join(ROOT, "routes", "__root.tsx"), "utf8");
    expect(root).not.toMatch(/maximum-scale|user-scalable/);
  });
});
