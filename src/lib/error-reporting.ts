/**
 * Client-side error reporting.
 *
 * NutriTrack has no third-party telemetry service: boundary errors are logged
 * locally. `describeError` is the shared formatter that the "Report a problem"
 * clipboard payload will reuse.
 */

export function describeError(error: unknown): string {
  if (error instanceof Response) {
    return `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  const stack = error instanceof Error ? error.stack : undefined;
  console.error("[NutriTrack]", describeError(error), {
    route: typeof window === "undefined" ? undefined : window.location.pathname,
    ...context,
    ...(stack !== undefined && { stack }),
  });
}
