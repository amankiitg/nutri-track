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
  draftInvite,
  fetchInviteRequests,
  fetchInvites,
  fetchSpend,
  formatCount,
  formatDay,
  inviteStatus,
  isPlausibleEmail,
  normalizeEmail,
  pendingCount,
  presentSpend,
  removeInvite,
  requestStatus,
  sortRequests,
} from "@/lib/admin";

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

  const requests = useQuery({
    queryKey: ["admin-invite-requests"],
    queryFn: fetchInviteRequests,
  });

  const approve = useMutation({
    mutationFn: approveRequest,
    onSuccess: (email) => {
      setError(null);
      toast.success(`${email} can now sign in`);
      void queryClient.invalidateQueries({ queryKey: ["admin-invite-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "Could not approve that request.");
    },
  });

  const pending = requests.isSuccess ? pendingCount(requests.data) : 0;

  return (
    <Card className="card-soft">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Requests from people who signed in
          {pending > 0 && (
            <Badge variant="default" className="ml-2 align-middle">
              {pending} waiting
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Recorded automatically when someone signs in with Google and is not on the list. One row
          per address — the same person asking again does nothing.
        </p>

        {error !== null && <PanelError message={error} />}
        {requests.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {requests.isError && <PanelError message="Could not load the requests." />}

        {requests.isSuccess && requests.data.length === 0 && (
          <p className="text-sm text-muted-foreground">Nobody has asked yet.</p>
        )}

        {requests.isSuccess && requests.data.length > 0 && (
          <ul className="divide-y divide-border">
            {sortRequests(requests.data).map((request) => {
              const status = requestStatus(request);
              return (
                <li key={request.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{request.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Asked {formatDay(request.requestedAt, "UTC")}
                    </p>
                  </div>
                  {request.status === "pending" ? (
                    <Button
                      type="button"
                      size="sm"
                      className="rounded-full"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(request.id)}
                    >
                      <Check className="mr-1 size-3.5" aria-hidden="true" />
                      Approve
                    </Button>
                  ) : (
                    <Badge variant={status.tone === "joined" ? "default" : "secondary"}>
                      {status.label}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function SpendPanel() {
  const spend = useQuery({ queryKey: ["admin-spend"], queryFn: fetchSpend });

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
              const shown = presentSpend(row);
              return (
                <li
                  key={row.userId}
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
