import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { countsNote, fetchCallBudget, presentBudget, remainingAnalysesLine } from "@/lib/calls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm } from "@/components/onboarding/ProfileForm";
import { AccountSection } from "@/components/settings/AccountSection";
import { useMaintainSuggestion, useWeightWindow } from "@/hooks/use-maintain-suggestion";
import { useToday } from "@/hooks/use-today";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { profile } = parentApi.useRouteContext();
  const userId = profile?.user_id ?? "";
  const timeZone = profile?.timezone ?? "UTC";
  const today = useToday(timeZone);

  /**
   * The same reached-target decision Today makes, from the same 7-day window and the same
   * rule. Settings ignores the "Not now" dismissal because this is where a goal is changed,
   * but it never decides for itself: when Today's rule says no, this is null too.
   */
  const maintain = useMaintainSuggestion({
    userId,
    today,
    goal: profile?.goal ?? null,
    targetKg: profile?.target_weight_kg ?? null,
    dismissed: null,
  });

  /**
   * The same 7-day average the notice above reads, for the arrival date under the pace options.
   * One query, one window: the date and the notice are two answers about one number.
   */
  const weightWindow = useWeightWindow({ userId, today });

  /**
   * The analysis budget. Refreshed whenever anything is logged, because the sheet
   * invalidates every query on save and this is one of them — a count that only moved
   * on a page reload would be wrong exactly when the user came here to check it.
   */
  const budget = useQuery({
    queryKey: ["call-budget", userId],
    queryFn: fetchCallBudget,
    enabled: userId !== "",
  });

  if (!profile) return null;

  const shown = budget.isSuccess ? presentBudget(budget.data, timeZone) : null;
  // One quiet line in Account. Null when the budget could not be read, which hides it rather
  // than printing a number that may be wrong.
  const analysesLeft = budget.isSuccess ? remainingAnalysesLine(budget.data) : null;

  return (
    <div className="app-shell space-y-6 py-8">
      <header>
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit your profile. Saving recomputes your targets.
        </p>
      </header>

      <Card className="card-soft">
        <CardHeader>
          <CardTitle className="text-base">Analyses today</CardTitle>
        </CardHeader>
        <CardContent>
          {budget.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {budget.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not read today's analyses. It only affects this count. Logging a meal still
              works.
            </p>
          )}
          {shown !== null && (
            <>
              <p className="text-3xl font-semibold tabular-nums">
                {shown.remaining}
                <span className="ml-2 text-base font-normal text-muted-foreground">
                  {shown.scale}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{shown.reset}</p>
              <p className="mt-1 text-xs text-muted-foreground">{countsNote}</p>
              {shown.exhausted !== null && (
                <p
                  role="status"
                  className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                >
                  {shown.exhausted}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ProfileForm
        profile={profile}
        maintain={maintain}
        averageKg={weightWindow.averageKg}
        today={today}
        onSaved={() => {
          toast.success("Profile saved. Your new targets start today.");
        }}
      />

      {/* Last, because it is the thing you reach for once, not every visit. */}
      <AccountSection
        timeZone={timeZone}
        units={profile.units}
        today={today}
        remainingAnalyses={analysesLeft}
      />
    </div>
  );
}
