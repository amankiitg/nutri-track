/**
 * One admin section, collapsible, with a one-line summary while it is closed.
 *
 * The summary is why this exists: four cards stacked on a phone is a page you scroll
 * past, and the numbers that decide whether you open one are exactly the numbers the
 * card already knows. The closed state keeps them visible and the body out of the way.
 *
 * The open/closed choice is remembered per section in localStorage. Reading it happens
 * in an effect rather than in the first render: a browser store is not readable while
 * rendering when the page may also be server-rendered, and the admin route is client
 * only today but the rule is the same one the onboarding wizard follows.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";

const STORAGE_KEY = "nutritrack.admin.sections";

function readStored(id: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)[id];
    return typeof value === "boolean" ? value : null;
  } catch {
    // A privacy mode that throws on storage, or a value somebody edited by hand: the
    // section still works, it just forgets.
    return null;
  }
}

function writeStored(id: string, open: boolean): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    let parsed: unknown = {};
    if (raw !== null) {
      parsed = JSON.parse(raw);
    }
    if (typeof parsed !== "object" || parsed === null) parsed = {};
    (parsed as Record<string, unknown>)[id] = open;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Remembering is a convenience; failing to remember is not an error the admin can act on.
  }
}

export function Section({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  /** Stable key for the remembered state. Changing it forgets the section once. */
  id: string;
  title: string;
  /** One line, shown under the title whether open or closed. */
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    const stored = readStored(id);
    if (stored !== null) setOpen(stored);
  }, [id]);

  const panelId = `admin-section-${id}`;

  return (
    <Card className="card-soft overflow-hidden py-0 gap-0">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            const next = !open;
            setOpen(next);
            writeStored(id, next);
          }}
          className="flex w-full items-start justify-between gap-3 px-6 py-4 text-left text-base hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="min-w-0">
            <span className="block text-base font-semibold">{title}</span>
            <span className="mt-0.5 block truncate text-base text-muted-foreground">{summary}</span>
          </span>
          <ChevronDown
            className={`mt-0.5 size-5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </Card>
  );
}
