import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchCurrentTarget, type Target } from "@/lib/profile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm } from "@/components/onboarding/ProfileForm";

const parentApi = getRouteApi("/_authenticated");

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { profile } = parentApi.useRouteContext();
  const queryClient = useQueryClient();
  const userId = profile?.user_id ?? "";

  const target = useQuery<Target | null>({
    queryKey: ["current-target", userId],
    queryFn: () => fetchCurrentTarget(userId),
    enabled: userId !== "",
  });

  if (!profile) return null;

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
          <CardTitle className="text-base">Current targets</CardTitle>
        </CardHeader>
        <CardContent>
          {target.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {target.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load your targets.
            </p>
          )}
          {target.isSuccess && !target.data && (
            <p className="text-sm text-muted-foreground">No target yet.</p>
          )}
          {target.isSuccess && target.data && (
            <>
              <p className="text-3xl font-semibold tabular-nums">
                {target.data.calories.toLocaleString("en-US")}
                <span className="ml-2 text-base font-normal text-muted-foreground">kcal</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Protein {Math.round(Number(target.data.protein_g))} g · Carbs{" "}
                {Math.round(Number(target.data.carbs_g))} g · Fat{" "}
                {Math.round(Number(target.data.fat_g))} g
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Effective from{" "}
                <time dateTime={target.data.effective_from}>
                  {new Date(`${target.data.effective_from}T00:00:00`).toLocaleDateString("en-US")}
                </time>
                .
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <ProfileForm
        profile={profile}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["current-target", userId] });
          toast.success("Profile saved. Your new targets start today.");
        }}
      />
    </div>
  );
}
