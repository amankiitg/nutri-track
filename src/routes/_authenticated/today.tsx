import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchCurrentTarget, type Target } from "@/lib/profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/today")({
  component: TodayPage,
});

function TodayPage() {
  const { profile } = parentApi.useRouteContext();
  const userId = profile?.user_id ?? "";
  const timeZone = profile?.timezone ?? "UTC";

  const target = useQuery<Target | null>({
    queryKey: ["current-target", userId, timeZone],
    queryFn: () => fetchCurrentTarget(userId, timeZone),
    enabled: userId !== "",
  });

  return (
    <div className="app-shell space-y-6 py-8">
      <header className="animate-rise">
        <p className="text-sm text-muted-foreground">Welcome back</p>
        <h1 className="text-3xl font-semibold">{profile?.display_name ?? "there"}</h1>
      </header>

      <Card className="card-soft animate-rise">
        <CardHeader>
          <CardTitle className="text-base">Today's target</CardTitle>
        </CardHeader>
        <CardContent>
          {target.isPending && (
            <p className="text-sm text-muted-foreground">Loading your target…</p>
          )}
          {target.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load your target. Pull to refresh or try again shortly.
            </p>
          )}
          {target.isSuccess && !target.data && (
            <p className="text-sm text-muted-foreground">
              You don't have a target yet. Finish onboarding to set one.
            </p>
          )}
          {target.isSuccess && target.data && <TargetSummary target={target.data} />}
        </CardContent>
      </Card>

      {/* The capture button is in the shell, so it is on this screen and every other
          authenticated one. Meal summaries belong here once the review screen lands. */}
      <p className="animate-rise rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        Tap <span className="font-semibold text-foreground">+</span> to log a meal by photo, voice
        or text.
      </p>
    </div>
  );
}

function TargetSummary({ target }: { target: Target }) {
  return (
    <div className="space-y-4">
      <p className="text-4xl font-semibold tabular-nums">
        {target.calories.toLocaleString()}
        <span className="ml-2 text-base font-normal text-muted-foreground">kcal</span>
      </p>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        {[
          { label: "Protein", value: target.protein_g },
          { label: "Carbs", value: target.carbs_g },
          { label: "Fat", value: target.fat_g },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl bg-secondary/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium tabular-nums">{Math.round(Number(value))} g</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Effective from{" "}
        <time dateTime={target.effective_from}>
          {new Date(`${target.effective_from}T00:00:00`).toLocaleDateString()}
        </time>
        .
      </p>
    </div>
  );
}
