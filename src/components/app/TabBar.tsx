import { Link } from "@tanstack/react-router";
import { CalendarDays, LineChart, Settings2, ShieldCheck } from "lucide-react";

const TABS = [
  { to: "/today", label: "Today", Icon: CalendarDays },
  { to: "/trends", label: "Trends", Icon: LineChart },
  { to: "/settings", label: "Settings", Icon: Settings2 },
] as const;

const ADMIN_TAB = { to: "/admin", label: "Admin", Icon: ShieldCheck } as const;

/**
 * Fixed bottom navigation for the authenticated shell.
 *
 * The Admin tab is absent, not hidden, for anyone who is not an admin. That is a
 * courtesy to the reader and nothing more: the policies behind the page are what makes
 * it private, and they refuse a non-admin whether this tab is here or not.
 */
export function TabBar({ isAdmin = false }: { isAdmin?: boolean | undefined }) {
  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : [...TABS];
  const columns = tabs.length === 4 ? "grid-cols-4" : "grid-cols-3";

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className={`app-shell grid ${columns}`}>
        {tabs.map(({ to, label, Icon }) => (
          <li key={to}>
            <Link
              to={to}
              activeProps={{ "aria-current": "page" }}
              className="flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors data-[status=active]:text-primary"
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
