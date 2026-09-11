import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Camera, Mic, Type } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NutriTrack — know if today is on track" },
      {
        name: "description",
        content:
          "Snap a photo, speak, or type your meal. NutriTrack estimates calories and macros and tells you each day whether you're on pace for your weight goal.",
      },
      { property: "og:title", content: "NutriTrack — know if today is on track" },
      {
        property: "og:description",
        content: "Photo-first calorie and nutrient tracking with a daily on-track verdict.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) navigate({ to: "/today", replace: true });
      else setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <main className="paper-grain flex min-h-dvh flex-col">
      <div className="app-shell flex flex-1 flex-col justify-center py-16">
        <div className="animate-rise">
          <BrandMark size={56} />
          <h1 className="mt-8 text-5xl leading-[1.02] font-semibold">
            Know if today
            <br />
            is <span className="italic text-primary">on track.</span>
          </h1>
          <p className="mt-5 max-w-sm text-lg text-muted-foreground">
            Snap your plate. NutriTrack reads it, you confirm it, and you get a straight answer on
            your weight goal — every single day.
          </p>
        </div>

        <ul className="mt-10 grid grid-cols-3 gap-3 animate-rise [animation-delay:120ms]">
          {[
            { icon: Camera, label: "Photo first" },
            { icon: Mic, label: "Or speak" },
            { icon: Type, label: "Or type" },
          ].map(({ icon: Icon, label }) => (
            <li key={label} className="card-soft flex flex-col items-center gap-2 px-2 py-4">
              <span className="grid size-10 place-items-center rounded-full bg-secondary text-secondary-foreground">
                <Icon className="size-5" />
              </span>
              <span className="text-xs font-medium">{label}</span>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex flex-col gap-3 animate-rise [animation-delay:200ms]">
          <Button asChild size="lg" className="h-12 rounded-full text-base" disabled={checking}>
            <Link to="/auth">{checking ? "Checking…" : "Sign in"}</Link>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Private, invite-only. Estimates are estimates — you always review before saving.
          </p>
        </div>
      </div>
    </main>
  );
}
