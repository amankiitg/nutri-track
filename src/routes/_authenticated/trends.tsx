import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/trends")({
  component: TrendsPage,
});

function TrendsPage() {
  return (
    <div className="app-shell flex min-h-[60vh] flex-col justify-center py-8 text-center">
      <h1 className="text-2xl font-semibold">Trends</h1>
      <p className="mt-2 text-muted-foreground">Coming soon.</p>
    </div>
  );
}
