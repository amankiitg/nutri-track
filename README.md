# NutriTrack: Your Daily Food Guide

Lovable Build Prompt: NutriTrack (photo-first calorie and nutrient tracker)

Paste "Prompt 1" into a fresh Lovable project. After it builds and you confirm it works, paste Prompts 2 through 5 one at a time. Lovable produces far better results in stages than from a single giant prompt.

Before starting, in Lovable: connect Supabase (Project Settings > Integrations), then add these secrets in the Supabase Edge Function secrets panel (never in frontend code):

DEEPSEEK_API_KEY

DEEPSEEK_VISION_MODEL = deepseek-v4-flash-vision-exp (or deepseek-flash if V4.1-Flash is available on your account; keep this configurable)

DEEPSEEK_TEXT_MODEL = deepseek-chat

Prompt 1: Foundation, auth, onboarding, data model

Build a mobile-first progressive web app called NutriTrack. It is a personal food and nutrient tracker whose core job is to tell each user, every day, whether their intake is on track for their weight goal (lose, maintain, or gain). Primary input is a photo of the food; second is voice; typed text is the fallback. An LLM parses the input into structured food items; the user always reviews and edits before anything is saved.

Stack and constraints

React + TypeScript + Tailwind + shadcn/ui. Mobile-first layout, installable PWA (manifest, service worker for the app shell, add-to-home-screen prompt).

Supabase for auth, Postgres, storage, and Edge Functions. All calls to the DeepSeek API go through Supabase Edge Functions. The DeepSeek key must never reach the browser.

Row Level Security on every table: a user can read and write only rows where user_id = auth.uid().

Auth: Google OAuth and email + password (with email verification). This first version is for two users (me and my wife). Add an allowed_emails table; signup is blocked unless the email is on it. Include a simple admin toggle so I can add friends later.

Onboarding (runs once after first login, editable later in Settings)

Collect, with inline validation, all inputs needed to compute a daily calorie target:

Display name, date of birth (must give age 13 to 100), biological sex (for the BMR formula), height (cm or ft/in, store cm), current weight (kg or lb, store kg).

Activity level: sedentary 1.2, lightly active 1.375, moderately active 1.55, very active 1.725, extra active 1.9. Show one-line descriptions.

Goal: lose, maintain, or gain. If lose or gain, ask target weight and desired pace in kg/week, limited to 0.25, 0.5, 0.75 or 1.0. Show the projected date to reach the target. Block target weight that implies BMI under 18.5 and show a message suggesting a clinician review.

Unit preferences (metric/imperial), time zone (auto-detect, confirm), daily reminder time (optional).

Optional: protein target as g per kg body weight (default 1.6), dietary tags (vegetarian, etc.) which are passed to the LLM as hints.

A review screen that shows every value entered and the computed targets, with an "Edit" link per field, before the profile is written to the database. Nothing is stored until the user confirms.

Target calculation (implement exactly, and unit-test it)

BMR (Mifflin-St Jeor): male = 10kg + 6.25cm - 5age + 5; female = 10kg + 6.25cm - 5age - 161.

TDEE = BMR * activity multiplier.

Daily adjustment = pace_kg_per_week * 7700 / 7 (7700 kcal per kg). Subtract for lose, add for gain, zero for maintain.

Floor the target at 1200 kcal (female) / 1500 kcal (male). If the floor binds, tell the user the pace was capped and show the effective pace.

Macro split defaults: protein = protein_g_per_kg * kg; fat = 25% of calories / 9; carbs = remainder / 4. User can override in Settings.

Worked example to put in the unit test: female, 32 y, 165 cm, 70 kg, moderately active, lose at 0.5 kg/week. BMR = 700 + 1031.25 - 160 - 161 = 1410.25. TDEE = 1410.25 * 1.55 = 2185.9. Adjustment = 0.5 * 7700 / 7 = 550. Target = 1636 kcal. Protein = 1.6 * 70 = 112 g. Fat = 0.25 * 1636 / 9 = 45 g. Carbs = (1636 - 1124 - 459) / 4 = 196 g.

Health app data

A web app cannot read Apple Health or Google Health Connect directly. Do not attempt it. Instead: (a) make all onboarding values manual with validation, and (b) build an "Import" screen in Settings that accepts an Apple Health export.xml or a CSV with columns date, weight_kg and imports weight history into the weight_log table after showing a preview and a duplicate check (same date = update, not insert). Leave a clearly labeled placeholder for a future native integration.

Database schema (create migrations)

profiles: user_id (PK, FK auth.users), display_name, dob, sex, height_cm, weight_kg, activity_level, goal, target_weight_kg, pace_kg_per_week, protein_g_per_kg, units, timezone, reminder_time, dietary_tags text[], created_at, updated_at.

targets: id, user_id, effective_from date, calories, protein_g, carbs_g, fat_g, fiber_g nullable. A new row is written whenever the profile changes so history stays honest.

meals: id, user_id, eaten_at timestamptz, meal_type (breakfast, lunch, dinner, snack), source (photo, voice, text), notes, photo_path nullable, photo_hash nullable, input_fingerprint text (see duplicate rules), created_at. Unique index on (user_id, input_fingerprint).

meal_items: id, meal_id, name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence numeric(3,2), user_edited boolean, llm_raw jsonb.

weight_log: id, user_id, logged_on date, weight_kg, source (manual, import). Unique (user_id, logged_on).

daily_summaries as a Postgres view (not a table): per user per local date, sum of calories and macros, joined to the target effective on that date, plus status = under / on_track / over using a tolerance of plus or minus 10% of the calorie target.

allowed_emails: email (PK), added_by, created_at.

Show me the schema and the Edge Function list before you write any UI beyond onboarding.

Prompt 2: Photo, voice, and text capture with LLM parsing and mandatory review

Add the "Log a meal" flow. It is the most important screen in the app; make it fast and forgiving.

Capture

A large floating "+" button on every screen opens a bottom sheet with three tabs in this order: Photo, Voice, Type.

Photo: use the camera directly on mobile (capture="environment"), allow choosing from gallery, allow up to 3 photos per meal (for example plate plus nutrition label). Client-side resize to max 1024 px on the long edge and JPEG quality 0.8 before upload. Show the upload progress. Compute a SHA-256 hash of the resized bytes on the client.

Voice: use the browser Web Speech API (SpeechRecognition) for live transcription with a visible transcript the user can correct before sending. If the browser does not support it, show the Type tab with a notice. Do not send audio to any server.

Type: a plain textarea with placeholder examples ("2 eggs, 1 slice sourdough, black coffee").

All three tabs share: meal type (auto-guessed from local time: 5 to 10 breakfast, 11 to 14 lunch, 17 to 21 dinner, otherwise snack), eaten-at time (defaults to now, editable), optional note.

Edge Function parse-meal

Input: { photos: [storage paths], transcript or text, meal_type, dietary_tags, user_units }.

For photos, call DeepSeek chat completions with the vision model from DEEPSEEK_VISION_MODEL, images as base64 in the message content. Disable any thinking/reasoning mode in the request so the output budget is not consumed. For voice/text, call DEEPSEEK_TEXT_MODEL.

System prompt for the model: "You are a nutrition estimator. Identify each distinct food item in the input. For each item return name, estimated quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, and a confidence between 0 and 1. Use USDA-style typical values. If a nutrition label is visible, read it and set confidence 0.95. If a portion is ambiguous, pick the most common serving and lower confidence. Respond with only a JSON object matching this schema, no prose, no markdown." Include the JSON schema and one example in the prompt.

Validate the response with Zod. If parsing fails, retry once with the instruction "Your previous response was not valid JSON. Return only the JSON object." If it fails again, return an error the UI can show ("Could not read this, try again or type it").

Sanity checks server-side before returning: calories must be within 15% of (4protein + 4carbs + 9*fat) or flag the item; any item over 2000 kcal or 0 kcal is flagged; grams over 1500 is flagged. Flagged items get needs_review: true.

Log every call's token usage and latency to a llm_calls table (user_id, model, prompt_tokens, completion_tokens, latency_ms, status).

Review screen (mandatory, cannot be skipped)

Shows the photo thumbnail(s) or transcript at the top, then one card per item with editable name, quantity, unit, grams, and each nutrient. Editing grams rescales all nutrients proportionally; editing a nutrient directly does not.

Confidence shown as a colored dot (green above 0.8, amber 0.5 to 0.8, red below 0.5). Flagged items are expanded by default with the reason.

Buttons: add item manually, remove item, "re-analyze with a hint" (sends the photo again with an extra text hint such as "the bowl is about 300 g").

Running total for the meal and the day's remaining calories shown at the bottom.

Primary action Save meal. Secondary Discard. On save, write meals and meal_items in a single transaction via an RPC, storing llm_raw and user_edited per item.

Duplicate prevention (implement all of these)

input_fingerprint = SHA-256 of (user_id + photo_hash if any + normalized lowercase text/transcript + eaten_at rounded to 10 minutes). The unique index rejects exact repeats; the UI shows "You already logged this at 12:40, open it?" with a link.

Before the review screen opens, query meals in the last 90 minutes for the same user. If any share 2 or more item names (case-insensitive fuzzy match) with the parsed result, show a yellow banner "Looks similar to your 12:40 lunch" with buttons "It is a new meal" and "Open existing".

Every Save request carries a client-generated UUID as an idempotency key; the RPC ignores a second call with the same key. Disable the Save button while a request is in flight.

A photo whose hash already exists for that user in the last 24 hours triggers the same banner.

Prompt 3: Dashboard, history, and aggregation

Today screen (home)

Top: a ring showing calories consumed vs target, with the status label (under / on track / over) and the number remaining. Below it three small bars for protein, carbs, fat vs targets.

A one-line verdict computed from the trailing 7-day average: "Averaging 1610 kcal/day this week, 26 below target, on pace for about 0.5 kg/week". Formula: (7-day average intake minus TDEE) * 7 / 7700 = projected weekly change in kg. Label this as an estimate.

Meal timeline for the day grouped by meal type, each meal card showing thumbnail, items, calories, and a swipe-to-delete with undo (soft delete via deleted_at).

Quick weight entry field at the bottom (writes to weight_log).

Trends screen

Segmented control: Week / Month / Year. Date navigator with previous/next arrows and a "today" button. All aggregation in the user's time zone.

Week: grouped bar chart, one bar per day, calories with the target drawn as a horizontal line. Tapping a bar opens that day.

Month: bar chart per day plus a summary row (average, best day, days on track out of days logged).

Year: bar chart per month of average daily calories, with logged-day count under each bar.

Macro breakdown: a donut (protein / carbs / fat by calories) for the selected period, and a stacked bar version below it so the two can be compared.

Weight chart: line of weight_log with a 7-day rolling average line and the target weight as a dashed line, over the same period.

"Days logged" and "adherence" (days on track / days logged) stat tiles.

Use Recharts. Charts must render correctly on a 375 px wide screen. Provide an empty state for periods with no data.

Build all aggregations as Postgres SQL functions (get_period_summary(user_id, period, anchor_date, tz)) rather than aggregating in the browser, so year views stay fast.

Prompt 4: Robustness, UX polish, offline

Optimistic UI for saves; queue writes in IndexedDB when offline and sync on reconnect, with a small "1 meal pending sync" chip.

Skeleton loaders on every screen. Every LLM call shows a progress state ("Reading your photo, about 5 seconds") and a cancel button.

Global error boundary with a "Report a problem" button that copies a diagnostic JSON (user id, route, last error) to the clipboard.

Rate limit parse-meal to 60 calls per user per day in the Edge Function; show the remaining count in Settings.

Frequently logged items: a "Recent" chip row on the capture sheet showing the user's 10 most-logged item names; tapping one pre-fills the review screen from the last saved values, no LLM call needed.

Copy meal from yesterday, and "same as last time" for a photo the app has seen before (by hash) with a confirmation.

Settings: edit profile (recomputes targets and writes a new targets row), units, reminder, export all data as CSV, delete account (cascade).

Accessibility: all buttons labeled, contrast checked, font size respects system setting.

Add Playwright tests for: onboarding validation, the worked TDEE example, duplicate rejection on double-tap Save, and the review screen blocking save with zero items.

Prompt 5: Multi-user readiness (run when adding friends)

Admin page (visible only to emails in an admins table) to add or remove allowed_emails and to view llm_calls cost totals per user.

Optional household sharing: a households table so my wife and I can see each other's daily summary on a "Family" tab, each user opting in from Settings. No one can edit another user's meals.

Prepare for Render if I later move the backend there: keep all LLM logic inside the single parse-meal function with a plain HTTP interface so it can be re-hosted as a small Node service on Render with the same env variable names.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ae9f8649-d948-4986-b301-0e67d5c36513).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitLab and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
