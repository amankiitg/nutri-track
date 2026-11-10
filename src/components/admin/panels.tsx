/**
 * The three panels of the admin page.
 *
 * Kept in one file for the same reason `onboarding/steps.tsx` is: they are one screen's
 * worth of question groups and splitting them would mean three files that only ever get
 * read together.
 *
 * None of this decides who may see anything. Every read and write here is refused by RLS
 * for a non-admin, so a bug in the route cannot turn this into a leak — it can only show
 * an error.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  approveRequest,
  declineRequest,
  draftApproved,
  draftInvite,
  fetchInviteRequests,
  fetchInvites,
  fetchSpend,
  fetchTrialStats,
  formatCount,
  formatDay,
  inviteStatus,
  isPlausibleEmail,
  normalizeEmail,
  pendingRequests,
  presentSpend,
  removeInvite,
  requestStatus,
  revokedRequests,
  type InviteRequest,
} from "@/lib/admin";
import { DAILY_ANALYSIS_LIMIT } from "@shared/meal-parse";
import { fetchAnalysisLimits } from "@/lib/calls";

/** One error line, so every panel fails the same way. */
function PanelError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function InviteList({ adminId }: { adminId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [firstName, setFirstName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invites = useQuery({ queryKey: ["admin-invites"], queryFn: fetchInvites });

  /**
   * One action, not two. The service drafts the email and adds the address in a single request,
   * in an order where a failure grants nobody access — so this page cannot leave the two out of
   * step, and there is no way to add someone here with no draft waiting for you in Gmail.
   */
  const add = useMutation({
    mutationFn: (input: { email: string; firstName: string }) =>
      draftInvite(input.email, input.firstName),
    onSuccess: (outcome) => {
      setDraft("");
      setFirstName("");
      setError(null);
      toast.success(
        outcome.alreadyInvited
          ? `Draft ready. ${outcome.email} was already on the list, so nothing changed there.`
          : `Draft ready for ${outcome.email}. Read it in Gmail, then send it.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not create the invite.");
    },
  });

  const remove = useMutation({
    mutationFn: removeInvite,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not remove that address.");
    },
  });

  const normalized = normalizeEmail(draft);
  const canAdd = isPlausibleEmail(draft) && firstName.trim() !== "" && !add.isPending;

  /**
   * The invitations that were taken away.
   *
   * A revoked request is not waiting for anything and is not in the list above, so it needs a home of
   * its own: the admin's question is "who did I remove, and do I want them back". Reading the same
   * query the pending card uses keeps the two from disagreeing about a row.
   */
  const removed = useQuery({
    queryKey: ["admin-invite-requests"],
    queryFn: fetchInviteRequests,
  });
  const removedRows = removed.isSuccess ? revokedRequests(removed.data) : [];

  const approveAgain = useMutation({
    mutationFn: (request: InviteRequest) => approveRequest(request.id),
    onSuccess: (_email, request) => {
      toast.success(`${request.email} can sign in again`);
      void queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-invite-requests"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not approve that address again.");
    },
  });

  return (
    <Card className="card-soft">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Invites</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAdd) return;
            add.mutate({ email: normalized, firstName: firstName.trim() });
          }}
        >
          <div className="flex gap-2">
            <Input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              placeholder="First Name"
              autoComplete="off"
              aria-label="Their first name"
              className="w-1/3 min-w-24"
            />
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="name@example.com"
              inputMode="email"
              autoComplete="off"
              aria-label="Address to invite"
              className="flex-1"
            />
          </div>
          <Button type="submit" className="w-full rounded-full" disabled={!canAdd}>
            {add.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="mr-1 size-4" aria-hidden="true" />
            )}
            Draft the invite
          </Button>
          <p className="text-xs text-muted-foreground">
            Adds them to the invite list and leaves a draft in Gmail. It never sends.
          </p>
        </form>

        {draft !== "" && normalized !== draft && (
          // The rule the lookup uses, shown rather than applied silently, so it is obvious
          // what will be stored rather than a surprise on the list.
          <p className="text-xs text-muted-foreground">
            Will be stored as <span className="font-medium text-foreground">{normalized}</span>,
            because matching is case- and space-insensitive.
          </p>
        )}

        {error !== null && <PanelError message={error} />}

        {invites.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {invites.isError && (
          <PanelError
            message={
              invites.error instanceof Error
                ? invites.error.message
                : "Could not load the invite list."
            }
          />
        )}

        {invites.isSuccess && (
          <ul className="divide-y divide-border">
            {invites.data.map((invite) => {
              const status = inviteStatus(invite);
              return (
                <li key={invite.email} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {status.label} · added {formatDay(invite.createdAt, "UTC")}
                      {invite.addedBy !== null && ` by ${invite.addedBy}`}
                    </p>
                  </div>
                  <Badge variant={status.tone === "joined" ? "default" : "secondary"}>
                    {status.tone === "joined" ? "Signed up" : "Waiting"}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${invite.email}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(invite.email)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {removedRows.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Removed
            </h3>
            <ul className="divide-y divide-border">
              {removedRows.map((request) => {
                const status = requestStatus(request);
                return (
                  <li key={request.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{request.email}</p>
                      <p className="text-xs text-muted-foreground">
                        Removed {formatDay(request.requestedAt, "UTC")}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-muted-foreground">
                      {status.label}
                    </Badge>
                    {/* Putting it back is the same approval as the first time: the RPC adds the
                        address to the list and marks the request approved. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 rounded-full"
                      disabled={approveAgain.isPending}
                      onClick={() => approveAgain.mutate(request)}
                    >
                      Approve again
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Removing an address stops a new sign-in. It does not sign anyone out, and it does not
          deactivate an account that already exists.
        </p>
      </CardContent>
    </Card>
  );
}

export function InviteRequestsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  /**
   * A draft that failed while the approval itself went through.
   *
   * Kept apart from `error` because it is not a failed approval and must not read like one: the
   * person is on the list and can sign in, and the only thing missing is the email telling them.
   */
  const [draftFailure, setDraftFailure] = useState<{
    email: string;
    firstName: string;
    message: string;
  } | null>(null);

  const requests = useQuery({
    queryKey: ["admin-invite-requests"],
    queryFn: fetchInviteRequests,
  });

  const approve = useMutation({
    mutationFn: async (request: InviteRequest) => {
      // The approval comes first and stands on its own: `admin_approve_request` adds the address and
      // marks the row in one transaction. The draft is a courtesy that follows it, so a failure
      // there is reported without undoing anything.
      const email = await approveRequest(request.id);
      const firstName = request.firstName ?? "";
      // Approving something already approved drafts nothing. A second draft lands in Gmail as a
      // second message about the same person, which reads as a mistake, and there is exactly one
      // place that is supposed to draft again: the Retry button above.
      if (request.status === "approved") {
        return { email, firstName, draftError: null as string | null };
      }
      try {
        await draftApproved(email, firstName);
        return { email, firstName, draftError: null as string | null };
      } catch (caught) {
        return {
          email,
          firstName,
          draftError:
            caught instanceof Error ? caught.message : "Could not create the draft in Gmail.",
        };
      }
    },
    onSuccess: ({ email, firstName, draftError }) => {
      setError(null);
      setDraftFailure(draftError === null ? null : { email, firstName, message: draftError });
      if (draftError === null) toast.success(`${email} can now sign in`);
      void queryClient.invalidateQueries({ queryKey: ["admin-invite-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not approve that request.");
    },
  });

  const decline = useMutation({
    mutationFn: (request: InviteRequest) => declineRequest(request.id),
    onSuccess: (_result, request) => {
      setError(null);
      toast.success(`Declined ${request.email}`);
      void queryClient.invalidateQueries({ queryKey: ["admin-invite-requests"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not decline that request.");
    },
  });

  const retryDraft = useMutation({
    mutationFn: (failure: { email: string; firstName: string }) =>
      draftApproved(failure.email, failure.firstName),
    onSuccess: (_draft, failure) => {
      setDraftFailure(null);
      toast.success(`Draft ready for ${failure.email}`);
    },
    onError: (caught: unknown, failure) => {
      setDraftFailure({
        ...failure,
        message: caught instanceof Error ? caught.message : "Could not create the draft in Gmail.",
      });
    },
  });

  const pending = requests.isSuccess ? pendingRequests(requests.data) : [];

  return (
    <Card className="card-soft">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Pending requests
          {pending.length > 0 && (
            <Badge variant="default" className="ml-2 align-middle">
              {pending.length} waiting
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Recorded when somebody asks from the request page, or signs in with Google and is not on
          the list. One row per mailbox, so the same person asking again does nothing. An approval
          here adds the address and drafts the welcome email; a decline takes the request out of
          this list for good.
        </p>

        {error !== null && <PanelError message={error} />}

        {draftFailure !== null && (
          <div
            role="alert"
            className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3"
          >
            <p className="text-sm text-destructive">{draftFailure.message}</p>
            <p className="text-xs text-muted-foreground">
              {draftFailure.email} was approved and can sign in. Only the email is missing, so this
              can be tried again without touching the list.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={retryDraft.isPending}
              onClick={() => retryDraft.mutate(draftFailure)}
            >
              Retry draft
            </Button>
          </div>
        )}

        {requests.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {requests.isError && <PanelError message="Could not load the requests." />}

        {requests.isSuccess && pending.length === 0 && (
          <p className="text-sm text-muted-foreground">Nobody is waiting.</p>
        )}

        {pending.length > 0 && (
          <ul className="divide-y divide-border">
            {pending.map((request) => (
              <li key={request.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  {/* The name first, because it is what the approval email will greet them by and
                      the one thing on this row that a person chose rather than typed. */}
                  <p className="truncate text-sm font-medium">
                    {request.firstName === null || request.firstName === ""
                      ? request.email
                      : request.firstName}
                  </p>
                  {request.firstName !== null && request.firstName !== "" && (
                    <p className="truncate text-xs text-muted-foreground">{request.email}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Asked {formatDay(request.requestedAt, "UTC")}
                  </p>
                  {request.fromTrial && (
                    <p className="text-xs font-medium text-muted-foreground">Trial: 10/10 used</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="rounded-full"
                    disabled={approve.isPending || decline.isPending}
                    onClick={() => approve.mutate(request)}
                  >
                    <Check className="mr-1 size-3.5" aria-hidden="true" />
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    disabled={approve.isPending || decline.isPending}
                    onClick={() => decline.mutate(request)}
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function SpendPanel({ viewerId }: { viewerId?: string }) {
  const spend = useQuery({ queryKey: ["admin-spend"], queryFn: fetchSpend });
  /**
   * The two ceilings, from the service that enforces them.
   *
   * Per row rather than one number, because an admin's own ceiling is not the ceiling of the people
   * in this list. A failure here falls back to the shared defaults, so the panel still renders.
   */
  const limits = useQuery({
    queryKey: ["analysis-limits"],
    queryFn: fetchAnalysisLimits,
    retry: false,
  });
  const limitFor = (userId: string): number => {
    if (limits.isSuccess) return userId === viewerId ? limits.data.admin : limits.data.daily;
    // Nobody else can reach this page, so the only account here that might be an admin is the reader.
    return DAILY_ANALYSIS_LIMIT;
  };

  return (
    <Card className="card-soft">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Model spend</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Tokens, not money. There is no price in here on purpose — a rate card would be wrong the
          first time it changed, and multiplying two numbers is easy enough.
        </p>

        {spend.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {spend.isError && (
          <PanelError
            message={
              spend.error instanceof Error ? spend.error.message : "Could not load the figures."
            }
          />
        )}

        {spend.isSuccess && (
          <ul className="space-y-4">
            {spend.data.map((row) => {
              if (row.isTrial) {
                return (
                  <li key="trial" className="space-y-2 border-t border-border pt-3 first:border-0">
                    <p className="truncate text-sm font-medium">Trial</p>
                    <p className="text-xs text-muted-foreground">
                      {formatCount(row.callsToday)} today · {formatCount(row.callsMonth)} this month
                      · {formatCount(row.callsTotal)} all time · {formatCount(row.tokensTotal)}{" "}
                      tokens
                    </p>
                  </li>
                );
              }
              const shown = presentSpend(row, limitFor(row.userId ?? ""));
              return (
                <li
                  key={row.userId ?? row.email}
                  className="space-y-2 border-t border-border pt-3 first:border-0"
                >
                  <p className="truncate text-sm font-medium">{row.email}</p>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={shown.exhausted ? "text-sm text-destructive" : "text-sm"}>
                      {shown.exhausted && (
                        <TriangleAlert className="mr-1 inline size-3.5" aria-hidden="true" />
                      )}
                      {shown.today}
                    </span>
                    <span className="text-xs text-muted-foreground">{shown.lastUsed}</span>
                  </div>
                  <Progress value={shown.todayFraction * 100} aria-hidden="true" />
                  <p className="text-xs text-muted-foreground">
                    {shown.month} · {shown.total}
                  </p>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Raw figures</summary>
                    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
                      <dt>Today</dt>
                      <dd>{formatCount(row.callsToday)} calls</dd>
                      <dt>Month</dt>
                      <dd>
                        {formatCount(row.callsMonth)} calls · {formatCount(row.tokensMonth)} tokens
                      </dd>
                      <dt>All time</dt>
                      <dd>
                        {formatCount(row.callsTotal)} calls · {formatCount(row.tokensTotal)} tokens
                      </dd>
                      <dt>Resets</dt>
                      <dd>{formatDay(row.resetsToday, row.timeZone)}</dd>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The trial, in one card: today's scans against the daily budget, and how many
 * mailboxes have started a trial. The budget comes from the database's trial_settings,
 * returned by admin_trial_stats, so the card cannot drift from the number the
 * enforcing function reads.
 */
export function TrialCard() {
  const stats = useQuery({
    queryKey: ["admin-trial-stats"],
    queryFn: () => fetchTrialStats(),
    retry: false,
  });

  return (
    <Card className="card-soft">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Trial</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {stats.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {stats.isError && <PanelError message="Could not load the trial figures." />}
        {stats.isSuccess && (
          <>
            <p className="text-sm">
              {stats.data.scansToday} of {stats.data.budget} scans used today
            </p>
            <Progress
              value={Math.min(1, stats.data.scansToday / Math.max(1, stats.data.budget)) * 100}
              aria-hidden="true"
            />
            <p className="text-xs text-muted-foreground">
              {stats.data.userCount} trial user{stats.data.userCount === 1 ? "" : "s"}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
