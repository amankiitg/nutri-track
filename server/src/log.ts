/**
 * Structured logs to stdout, which is what Render collects. One JSON object per
 * line so a query in the dashboard is a filter rather than a regex.
 *
 * Never log a bearer token, the Gemini key or a Supabase key. Log identifiers
 * and counts instead.
 */
type Level = "info" | "warn" | "error";

type FieldValue = string | number | boolean | null;

export type LogFields = Record<string, FieldValue | undefined>;

export function log(level: Level, message: string, fields: LogFields = {}): void {
  const line: Record<string, FieldValue> = {
    level,
    message,
    at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}
