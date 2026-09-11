import { useState } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalorieRing } from "@/components/dashboard/CalorieRing";
import { MacroBars, VerdictLine } from "@/components/dashboard/MacroBars";
import { MealTimeline } from "@/components/dashboard/MealTimeline";
import { WeightEntry } from "@/components/dashboard/WeightEntry";
import { localDateString } from "@/lib/profile";
import {
  VERDICT_DAYS,
  deleteMeal,
  fetchDailyTotals,
  fetchRecentWeights,
  fetchTimeline,
  fetchWeekVerdict,
  logWeight,
  mealTypeLabel,
  restoreMeal,
  type TimelineMeal,
} from "@/lib/dashboard";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/today")({
  component: TodayPage,
});

function TodayPage() {
  const { profile } = parentApi.useRouteContext();
  const userId = profile?.user_id ?? "";
  const timeZone = profile?.timezone ?? "UTC";
  const unitSystem = profile?.units ?? "metric";

  // The profile's local date, not the device's. Every function on the other side
  // resolves the day the same way, so the totals, the verdict and the timeline all
  // agree about which day "today" is.
  const today = localDateString(timeZone);
  const [busyMealId, setBusyMealId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const enabled = userId !== "";

  const totals = useQuery({
    queryKey: ["daily-totals", userId, today],
    queryFn: () => fetchDailyTotals(today),
    enabled,
  });

  const verdict = useQuery({
    queryKey: ["week-verdict", userId, today, VERDICT_DAYS],
    queryFn: () => fetchWeekVerdict(today, VERDICT_DAYS),
    enabled,
  });

  const timeline = useQuery({
    queryKey: ["timeline", userId, today],
    queryFn: () => fetchTimeline(today),
    enabled,
  });

  const weights = useQuery({
    queryKey: ["weights", userId],
    queryFn: () => fetchRecentWeights(2),
    enabled,
  });

  function refreshDay(): void {
    void queryClient.invalidateQueries({ queryKey: ["daily-totals"] });
    void queryClient.invalidateQueries({ queryKey: ["timeline"] });
    void queryClient.invalidateQueries({ queryKey: ["week-verdict"] });
  }

  const remove = useMutation({
    mutationFn: (meal: TimelineMeal) => deleteMeal(meal.id),
    onMutate: (meal) => setBusyMealId(meal.id),
    onSuccess: (_result, meal) => {
      refreshDay();
      // The undo lives in the toast rather than as a pending state on the row: the
      // delete has already happened on the server, so the honest offer is to reverse
      // it, not to pretend it has not happened yet.
      toast(`${mealTypeLabel(meal.meal_type)} removed`, {
        duration: 10000,
        action: {
          label: "Undo",
          onClick: () => {
            void restoreMeal(meal.id)
              .then(() => {
                refreshDay();
                toast.success("Meal restored");
              })
              .catch((error: unknown) => {
                toast.error(
                  error instanceof Error ? error.message : "Could not restore that meal.",
                );
              });
          },
        },
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not remove that meal.");
    },
    onSettled: () => setBusyMealId(null),
  });

  const saveWeight = useMutation({
    mutationFn: (weightKg: number) => logWeight({ userId, date: today, weightKg }),
    onSuccess: () => {
      toast.success("Weight recorded");
      void queryClient.invalidateQueries({ queryKey: ["weights"] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not save that weight.");
    },
  });

  return (
    <div className="app-shell space-y-6 py-8">
      <header className="animate-rise">
        <p className="text-sm text-muted-foreground">Welcome back</p>
        <h1 className="text-3xl font-semibold">{profile?.display_name ?? "there"}</h1>
      </header>

      {totals.isPending && (
        <Card className="card-soft">
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">Loading today…</p>
          </CardContent>
        </Card>
      )}

      {totals.isError && (
        <Card className="card-soft">
          <CardContent className="py-6">
            <p role="alert" className="text-sm text-destructive">
              Could not load today. Pull to refresh or try again shortly.
            </p>
          </CardContent>
        </Card>
      )}

      {totals.isSuccess && (
        <>
          <Card className="card-soft animate-rise">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Calories</CardTitle>
            </CardHeader>
            <CardContent className="pb-6">
              <CalorieRing consumed={totals.data.calories} target={totals.data.target_calories} />
            </CardContent>
          </Card>

          <MacroBars totals={totals.data} />
        </>
      )}

      {verdict.isSuccess && <VerdictLine verdict={verdict.data} />}

      {weights.isSuccess && (
        <WeightEntry
          entries={weights.data}
          unitSystem={unitSystem}
          saving={saveWeight.isPending}
          onSave={(weightKg) => saveWeight.mutate(weightKg)}
        />
      )}

      {timeline.isSuccess && (
        <MealTimeline
          meals={timeline.data}
          timeZone={timeZone}
          busyId={busyMealId}
          onDelete={(meal) => remove.mutate(meal)}
        />
      )}
    </div>
  );
}
