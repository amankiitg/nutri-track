/**
 * Who is signed in, and the two things you can do about it.
 *
 * Both actions need something the rest of the app does not: the identities on the session, which
 * say whether this account has a password at all. A Google-only account is offered "Set a
 * password" rather than "Change password", because there is nothing to change and a button that
 * says otherwise is a dead end; setting one adds it to the same account, which is the deliberate
 * choice recorded in AGENTS.md rather than a second account for the same address.
 *
 * Signing out clears the react-query cache. Every cached key is scoped by user id, so a stale
 * entry would not be *served* to the next person to sign in on this device, but it would sit in
 * memory until it was evicted, and "left something in the cache" is not a property worth leaving
 * to a key prefix.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { User } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { providerSummary } from "@/lib/account";
import { saveProductEmailChoice } from "@/lib/contacts";
import { authEntryState, stateHasPassword } from "@/lib/invite-request";
import { friendlyAuthError } from "@/lib/auth-errors";
import type { AnalysesLine } from "@/lib/calls";
import type { UnitSystem } from "@/lib/units";
import { ExportData } from "./ExportData";

/** The same minimum the other password fields use. */
const MIN_PASSWORD = 8;

export function AccountSection({
  userId,
  productEmails,
  timeZone,
  units,
  today,
  remainingAnalyses = null,
}: {
  /** The signed-in account's id, so the switch writes its own row. */
  userId: string;
  /** `profiles.product_emails`, which the mailing list sync reads. */
  productEmails: boolean;
  /** The profile's zone and day, so the export's files and its range end are the reader's. */
  timeZone: string;
  /** The unit preference the export writes weights in. */
  units: UnitSystem;
  today: string;
  /**
   * "14 of 20 photo analyses left today · resets at midnight", or null when the budget could not
   * be read. Null hides the line: a number that might be wrong is worse than no number on a
   * settings page.
   */
  remainingAnalyses?: AnalysesLine | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  /** One reveal for both fields, the same decision the reset page makes. */
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"password" | "signout" | "product-emails" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The switch, held here so it moves on the tap rather than after the round trip.
   * A failed profile write puts it back, because the row is what the sync reads.
   */
  const [productMail, setProductMail] = useState(productEmails);
  const [productMailError, setProductMailError] = useState<string | null>(null);
  /**
   * Whether this account actually has a password.
   *
   * The identities cannot answer this, and assuming they could was the bug: a magic-link account has
   * an `email` identity from the moment it is created and no password at all, so it was offered
   * "Change password" for a password that never existed. `auth_entry_state` is the one place that
   * knows, and its answer is what the sign-in screen uses too.
   *
   * Null while it is being read, and on a failed read. The fallback is deliberately the old
   * behaviour: an `email` identity means "Change password", which is wrong for a link-only account
   * but safe, because saving sets a password either way.
   */
  const [hasPassword, setHasPasswordState] = useState<boolean | null>(null);

  /** Reads the account, and asks the database whether a password is set. */
  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!active) return;
      const nextUser = data.user ?? null;
      setUser(nextUser);
      const address = nextUser?.email ?? "";
      if (address === "") {
        setHasPasswordState(null);
        return;
      }
      const state = await authEntryState(address);
      if (!active) return;
      // One helper decides what counts as a password, so this label and the sign-in screen cannot
      // disagree about the same account.
      setHasPasswordState(stateHasPassword(state) ? true : state === null ? null : false);
    });
    return () => {
      active = false;
    };
  }, []);

  const providers = (user?.identities ?? []).map((identity) => identity.provider);
  const hasPasswordIdentity = providers.includes("email");
  const passwordLabel = (hasPassword ?? hasPasswordIdentity) ? "Change password" : "Set a password";

  async function savePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    if (password !== confirmation) {
      setError("Those two passwords don't match.");
      return;
    }
    setBusy("password");
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(null);
    if (updateError) {
      setError(friendlyAuthError(updateError));
      return;
    }
    // Setting one gives a Google-only account an email identity, so the label has to be re-read
    // rather than assumed: the button that said "Set a password" would otherwise keep saying it.
    const { data } = await supabase.auth.getUser();
    setUser(data.user ?? null);
    // Recorded in the database, which is the only place the sign-in screen looks. GoTrue writes no
    // amr claim for a password that was set and never used, so without this the next sign-in would
    // send this person to the link and offer no password box at all. A failed call does not undo the
    // password that was just saved, so it is swallowed rather than shown: the person would be told
    // "could not save" about something that did save.
    try {
      await supabase.rpc("mark_has_password");
    } catch {
      // Nothing to do: the password exists, and the next sign-in with it writes the amr claim that
      // makes the flag unnecessary.
    }
    // A password exists now, whatever the database said a moment ago.
    setHasPasswordState(true);
    setPassword("");
    setConfirmation("");
    setVisible(false);
    setOpen(false);
    toast.success(
      hasPassword === true
        ? "Password changed."
        : "Password set. You can now sign in with email and a password, without waiting for a link.",
    );
  }

  async function changeProductMail(enabled: boolean): Promise<void> {
    const previous = productMail;
    setProductMail(enabled);
    setProductMailError(null);
    setBusy("product-emails");
    try {
      await saveProductEmailChoice(userId, enabled);
      // "Saved" rather than "on" when the switch goes back on: the sync never
      // re-subscribes a contact, so a person who left the list in Resend stays off it
      // whatever this switch says.
      toast.success("Saved.");
    } catch {
      setProductMail(previous);
      setProductMailError("Could not save that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut(): Promise<void> {
    setBusy("signout");
    setError(null);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setBusy(null);
      setError(friendlyAuthError(signOutError));
      return;
    }
    queryClient.clear();
    void navigate({ to: "/auth" });
  }

  return (
    <Card className="card-soft">
      <CardHeader>
        <CardTitle className="text-base">Account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium break-all">{user?.email ?? "Loading…"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Signing in with {providerSummary(providers)}
          </p>
          {remainingAnalyses !== null && (
            <>
              <p className="mt-1 text-xs text-muted-foreground">{remainingAnalyses.line}</p>
              {remainingAnalyses.note !== null && (
                <p className="mt-0.5 text-xs text-muted-foreground">{remainingAnalyses.note}</p>
              )}
            </>
          )}
        </div>

        {/*
          Product mail, beside the account line because it is about the address rather than
          about the body. The switch is the whole control: the sync reads the same column.
        */}
        <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
          <div className="space-y-1">
            <Label htmlFor="product-emails" className="text-base font-medium">
              Product update emails
            </Label>
            <p id="product-emails-note" className="text-base text-muted-foreground">
              Occasional updates, unsubscribe anytime
            </p>
          </div>
          <Switch
            id="product-emails"
            aria-describedby="product-emails-note"
            checked={productMail}
            disabled={busy !== null}
            onCheckedChange={(checked) => void changeProductMail(checked)}
          />
        </div>
        {productMailError !== null && (
          <p role="alert" className="text-base text-destructive">
            {productMailError}
          </p>
        )}

        {/* 
          The password row, with its own label and explanation, rather than a bare button beside
          Sign out. It is the one thing in this card that is not obvious from the account line: a
          person who signs in by link has no password and may not know one can be set.
        */}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Password</p>
          <p className="text-xs text-muted-foreground">
            {hasPassword === true
              ? "You can sign in with this password, and reset it if you forget it."
              : "You sign in with an email link. Set a password to sign in without waiting for one."}
          </p>
        </div>

        {open ? (
          <form onSubmit={savePassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="account-password">New password</Label>
              <PasswordInput
                id="account-password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                visible={visible}
                onToggle={() => setVisible((shown) => !shown)}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-confirm">Confirm password</Label>
              <PasswordInput
                id="account-confirm"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                visible={visible}
                onToggle={() => setVisible((shown) => !shown)}
                className="h-11"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="rounded-full" disabled={busy !== null}>
                {busy === "password" && <Loader2 className="animate-spin" />}
                {passwordLabel}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => {
                setOpen(true);
                setError(null);
              }}
            >
              {passwordLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              disabled={busy !== null}
              onClick={() => void signOut()}
            >
              {busy === "signout" && <Loader2 className="animate-spin" />}
              Sign out
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <ExportData userId={user?.id ?? ""} timeZone={timeZone} units={units} today={today} />
      </CardContent>
    </Card>
  );
}
