/**
 * No em dash in anything a person reads: UI strings, JSX text, page titles, the service's
 * user-facing messages and the local invite tool's page. Sentences use a comma or a period
 * instead, and an empty value says "None" or shows nothing.
 *
 * Comments are free to use one, so this reads the TypeScript token stream rather than the
 * raw text: only string literals, template strings and JSX text are checked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "..", "..");
const ROOTS = ["src", "shared", "server/src", "tools/invite/src"];
/** Text that only an operator reads in a terminal, never a page or a message. */
const NOT_UI = new Set(["server/src/sweep-config.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
  });
}

function emDashes(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of files(join(REPO, root))) {
      const rel = relative(REPO, file);
      const text = readFileSync(file, "utf8");
      if (NOT_UI.has(rel) || !text.includes("—")) continue;
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        const isText =
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node);
        if (isText && node.getText(source).includes("—")) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          found.push(`${rel}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe("copy", () => {
  it("has no em dash in any user-facing string", () => {
    expect(emDashes()).toEqual([]);
  });
});
