/**
 * The privacy page, at /privacy.
 *
 * Public on purpose, and outside `_authenticated`: Google's OAuth reviewers fetch this URL while
 * verifying the consent screen, so it has to render for a signed-out visitor with no session and
 * no data of its own.
 *
 * It describes what the code actually does, which is why it names the soft-delete behaviour and
 * says plainly that account deletion is not built. A privacy page that claims a capability the
 * app does not have is worse than a short one, because it is the page someone believes.
 */
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: () => ({ meta: [{ title: "Privacy — NutriTrack" }] }),
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function PrivacyPage() {
  return (
    <main className="app-shell space-y-8 py-10 text-sm leading-relaxed">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Privacy</h1>
        <p className="text-muted-foreground">Last updated 17 September 2026.</p>
      </header>

      <p>
        NutriTrack keeps what you tell it about your body and the meals you log. It is yours. There
        is no analytics, no advertising, and nothing is sold or shared beyond the one place a meal
        photo is sent to be estimated, which is described below.
      </p>

      <Section title="What is kept">
        <p className="font-medium">About you</p>
        <List
          items={[
            "Your email address, and the Google identity you signed in with if you used Google.",
            "Your name, date of birth, sex, height and timezone.",
            "Your goal: target weight, how fast you want to get there, activity level, and your protein setting.",
            "Dietary tags, if you set any. These can imply an allergy or a religion, so they are worth naming here.",
          ]}
        />
        <p className="pt-2 font-medium">What you log</p>
        <List
          items={[
            "Meals: when you ate, the meal type, whether you used a photo, your voice or typing, and any note you typed.",
            "The meal photos themselves, up to three per meal.",
            "Per item: the estimated portion, calories and macros, how confident that estimate was, and whether you changed it. The model's original answer is kept alongside your edit, so the app can show what changed.",
            "Weight and waist readings, with the date.",
            "A count of how many analyses you have used, which is what the daily limit is checked against.",
          ]}
        />
        <p className="pt-2">
          Not kept: no analytics, no tracking pixels, no advertising identifiers, no location.
        </p>
      </Section>

      <Section title="Where it lives">
        <p>
          Everything is in Supabase, a hosted Postgres database and file storage service: the rows
          in the database and the photos in a private storage bucket. That bucket is not public.
          The app reads a photo through a short-lived signed link that only your own signed-in
          session can obtain, and a photo is stored under your account id, which is what the
          access rules check.
        </p>
        <p>
          The meal analysis runs on a service hosted by Render, and the website is served by
          Cloudflare. Neither keeps a copy of your data; they pass it through.
        </p>
      </Section>

      <Section title="Who can reach it">
        <p>
          You, and only you, through the app. That is enforced by the database rather than by the
          app's screens: every table carries an access rule requiring the row's owner to be the
          person asking, and the photo bucket's rules require the same. A bug in a screen could
          show an error; it could not show you somebody else's meals.
        </p>
        <p>
          I am the admin, so I keep the invite list. Through the admin screen I can see the
          addresses on it and whether they have signed up, and for each account its email address,
          timezone, and how many analyses it has used.
        </p>
        <p>
          I cannot see anyone's meals, photos, weight, waist or targets through the admin screen,
          and there is no screen that shows them. As the person who runs the database I could
          reach any row directly, the way any hosted database works. I have not, and no part of
          the app does.
        </p>
      </Section>

      <Section title="What leaves the app">
        <p>
          One thing. When you analyse a meal, the photo and the text of that meal are sent to
          Google's Gemini model to be estimated. What is sent is the image, what you typed or said,
          and which meal it is. Your name, email, date of birth, weight, waist and account id are
          not sent.
        </p>
        <p>
          If you use the microphone, your browser transcribes the recording using its own speech
          service, which in most browsers means Google. That audio never reaches this app's
          servers.
        </p>
      </Section>

      <Section title="How long it is kept">
        <p>
          Until you ask for it to be removed. Nothing is deleted automatically and there is no
          retention limit, so a meal you logged a year ago is still there.
        </p>
        <p>
          One detail worth knowing: deleting a meal in the app hides it and offers an undo. Because
          of the undo, the record keeps naming its photos, so those photos are not removed at that
          point. Deleting the meal and then deleting it again is what removes them. Photos from a
          capture you cancel before saving are deleted immediately.
        </p>
      </Section>

      <Section title="Deleting your account">
        <p className="font-medium">Account deletion is not built yet.</p>
        <p>
          There is no button for it. I would rather say that plainly than point you at something
          that does not exist.
        </p>
        <p>To have your data removed in the meantime, reply to the email you were invited with and ask. That will:</p>
        <List
          items={[
            "delete your profile, targets, meals, meal items, weight and waist readings, and your usage counts",
            "delete your meal photos from storage",
            "delete the account itself, so you can no longer sign in",
          ]}
        />
        <p>
          It is done by hand at the moment, so expect a day or two rather than immediately. When
          there is a button, this page will say so.
        </p>
        <p>
          If you would like a copy of your data before it goes, ask in the same message and I will
          send you what is stored.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If what is kept, or where it goes, changes, this page changes with it. The date at the
          top is the last time it did.
        </p>
      </Section>

      <p className="pt-2">
        <Link to="/" className="text-primary underline">
          Back to NutriTrack
        </Link>
      </p>
    </main>
  );
}
