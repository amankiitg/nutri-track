/**
 * TEMPORARY. Shows the raw parse response so the pipeline can be checked by eye
 * before the review screen exists. Delete this file and its one use in
 * `CaptureSheet` when the review screen lands.
 */
import type { ParseResponse } from "@/lib/capture";

export function ParseDebugPanel({ result }: { result: ParseResponse }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/40 p-3">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Debug — raw parse response
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Temporary. Nothing is saved yet: the review screen is what will edit and store this.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">model</dt>
        <dd className="font-mono">{result.model}</dd>
        <dt className="text-muted-foreground">attempts</dt>
        <dd className="font-mono">{result.attempts}</dd>
        <dt className="text-muted-foreground">meal type</dt>
        <dd className="font-mono">{result.meal_type}</dd>
      </dl>
      <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-background p-2 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(result.items, null, 2)}
      </pre>
    </div>
  );
}
