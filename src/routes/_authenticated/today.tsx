import { useEffect, useRef, useState } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalorieRing } from "@/components/dashboard/CalorieRing";
import { MacroBars, VerdictLine } from "@/components/dashboard/MacroBars";
import { MealTimeline } from "@/components/dashboard/MealTimeline";
import { WeightEntry } from "@/components/dashboard/WeightEntry";
import { EditMealSheet } from "@/components/review/EditMealSheet";
import { localDateString, refreshTargetIfStale } from "@/lib/profile";
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
  /**
   * The meal being edited, or null. The sheet is mounted only while this is set, so opening it
   * loads that meal's rows and closing it throws the loaded state away rather than showing a
   * previous meal's items for a frame.
   */
  const [editingMeal, setEditingMeal] = useState<TimelineMeal | null>(null);
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

  /**
   * An edit landed. Only the day's own numbers can have moved — the meal keeps its photos, its
   * source and its place in the day — so this refetches the day's three queries rather than
   * everything, which is what the capture sheet has to do because it stands on every screen.
   */
  function handleMealEdited(): void {
    setEditingMeal(null);
    refreshDay();
    toast.success("Meal updated");
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
    mutationFn: (input: { weightKg: number; waistCm?: number | undefined }) =>
      logWeight({ userId, date: today, ...input }),
    onSuccess: () => {
      toast.success("Weight recorded");
      void queryClient.invalidateQueries({ queryKey: ["weights"] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not save that weight.");
    },
  });

  // The one place the app writes something the user did not ask for on the spot.
  //
  // A target is only recomputed when the weight behind it has drifted, and the new row
  // takes effect tomorrow, so this can never move the numbers on screen. The guard is
  // belt and braces: `refreshTargetIfStale` is idempotent, because today's effective
  // target keeps its old basis until tomorrow's row is in force.
  const refreshAttempted = useRef(false);
  useEffect(() => {
    if (!profile || refreshAttempted.current) return;
    refreshAttempted.current = true;

    void refreshTargetIfStale(profile)
      .then((result) => {
        if (!result.refreshed) return;
        // Said out loud rather than done silently: the target is about to change and the
        // user should know why, and from when.
        toast.info("Your target has been refreshed", {
          description: `You have been averaging ${result.weightKg} kg, so tomorrow starts on a new target. Today is unchanged.`,
          duration: 12000,
        });
        void queryClient.invalidateQueries({ queryKey: ["daily-totals"] });
      })
      .catch(() => {
        // A refresh that fails must not interrupt the dashboard. Today's numbers are
        // still correct; tomorrow's will be recomputed on the next load.
      });
  }, [profile, queryClient]);

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
          onSave={(input) => saveWeight.mutate(input)}
        />
      )}

      {timeline.isSuccess && (
        <MealTimeline
          meals={timeline.data}
          timeZone={timeZone}
          busyId={busyMealId}
          onDelete={(meal) => remove.mutate(meal)}
          onEdit={(meal) => setEditingMeal(meal)}
        />
      )}

      {/*
        Mounted only while a meal is being edited, so the sheet starts empty every time and there
        is no stale meal to flash. Its `remainingToday` is the day's remainder as stored, which
        already counts this meal; the screen adds that meal back itself before subtracting what the
        edit changed it to.
      */}
      {editingMeal !== null && (
        <EditMealSheet
          open
          onOpenChange={(next) => {
            if (!next) setEditingMeal(null);
          }}
          mealId={editingMeal.id}
          timeZone={timeZone}
          targetCalories={totals.data?.target_calories ?? null}
          remainingToday={totals.data?.remaining_calories ?? null}
          onSaved={handleMealEdited}
        />
      )}
    </div>
  );
}
