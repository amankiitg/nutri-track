import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Camera, Mic, Play, Type } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/app/BrandMark";
import { DemoIntro, INTRO_FADE_MS } from "@/components/landing/DemoIntro";
import { markIntroSeen, shouldPlayIntro } from "@/lib/intro";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NutriTrack: know if today is on track" },
      {
        name: "description",
        content:
          "Snap a photo, speak, or type your meal. NutriTrack estimates calories and macros and tells you each day whether you're on pace for your weight goal.",
      },
      { property: "og:title", content: "NutriTrack: know if today is on track" },
      {
        property: "og:description",
        content: "Photo-first calorie and nutrient tracking with a daily on-track verdict.",
      },
    ],
  }),
  component: Landing,
});

type Phase = "pending" | "intro" | "landing";

/**
 * The landing page opens as an intro: the demo plays full screen, then fades to the page.
 *
 * Nothing is decided while rendering. The server cannot know about the session (it lives
 * in localStorage) or about sessionStorage and reduced motion, so the first paint on both
 * sides is the page, present but invisible, and an effect decides: a signed-in visitor goes
 * to /today with no intro; otherwise the intro plays unless it already played in this
 * browser session or reduced motion is set, in which case the page simply appears.
 */
export function Landing() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("pending");
  const [introMounted, setIntroMounted] = useState(false);

  const playIntro = useCallback(() => {
    markIntroSeen();
    setIntroMounted(true);
    setPhase("intro");
  }, []);

  useEffect(() => {
    let active = true;
    const decide = () => {
      if (!active) return;
      if (shouldPlayIntro()) playIntro();
      else setPhase("landing");
    };
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) navigate({ to: "/today", replace: true });
      else decide();
    }, decide);
    return () => {
      active = false;
    };
  }, [navigate, playIntro]);

  // The intro stays mounted while it fades out over the page, then goes.
  useEffect(() => {
    if (phase !== "landing" || !introMounted) return;
    const timer = window.setTimeout(() => setIntroMounted(false), INTRO_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, introMounted]);

  const finishIntro = useCallback(() => setPhase("landing"), []);
  const shown = phase === "landing";

  return (
    <main className="paper-grain flex min-h-dvh flex-col">
      {introMounted && <DemoIntro onDone={finishIntro} />}
      {/* Keyed so the page's rise animation plays when it is revealed, not while hidden. */}
      <div
        key={shown ? "shown" : "hidden"}
        data-testid="landing-page"
        className={
          "app-shell flex flex-1 flex-col justify-center py-16" + (shown ? "" : " invisible")
        }
      >
        <div className="animate-rise">
          <BrandMark size={56} />
          <h1 className="mt-8 text-5xl leading-[1.02] font-semibold">
            Know if today
            <br />
            is <span className="italic text-primary">on track.</span>
          </h1>
          <p className="mt-5 max-w-sm text-lg text-muted-foreground">
            Snap your plate. NutriTrack reads it, you confirm it, and you get a straight answer on
            your weight goal, every single day.
          </p>
          <button
            type="button"
            onClick={playIntro}
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4"
          >
            <Play className="size-3.5" aria-hidden="true" />
            Watch the demo
          </button>
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
          <Button asChild size="lg" className="h-12 rounded-full text-base">
            <Link to="/auth">Sign in</Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-12 rounded-full text-base">
            <Link to="/try">Try it now</Link>
          </Button>
          <p className="text-center text-sm">
            {/* The request page, not a step inside sign-in: somebody with no invite has one thing
                to do, and it should not begin with a form that asks them to prove they need it. */}
            <Link to="/auth/request" className="underline">
              Request an invite
            </Link>
          </p>
          <p className="text-center text-xs text-muted-foreground">
            Private, invite-only. Estimates are estimates. You always review before saving.
          </p>
        </div>

        {/*
          What happens to the data, before anyone is asked for an email. Each line is something
          the code actually does: no analytics is a fact about the bundle, and "enforced by the
          database" is RLS rather than a promise in a policy document.
        */}
        <section className="mt-10 animate-rise space-y-2 rounded-2xl border border-border bg-muted/30 p-4 text-sm [animation-delay:260ms]">
          <h2 className="font-semibold">Your data</h2>
          <ul className="space-y-1 text-muted-foreground">
            <li>No ads, no analytics, nothing sold.</li>
            <li>Only you can see your meals, enforced by the database.</li>
            <li>
              Only the meal photo and text are sent for estimating, never your name or weight.
            </li>
          </ul>
          <Link to="/privacy" className="inline-block underline">
            Read the privacy page
          </Link>
        </section>
      </div>
    </main>
  );
}
