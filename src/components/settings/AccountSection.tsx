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
import { supabase } from "@/integrations/supabase/client";
import { providerSummary } from "@/lib/account";
import { friendlyAuthError } from "@/lib/auth-errors";

/** The same minimum the other password fields use. */
const MIN_PASSWORD = 8;

export function AccountSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  /** One reveal for both fields, the same decision the reset page makes. */
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"password" | "signout" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
  }, []);

  const providers = (user?.identities ?? []).map((identity) => identity.provider);
  const hasPasswordIdentity = providers.includes("email");
  const passwordLabel = hasPasswordIdentity ? "Change password" : "Set a password";

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
    setPassword("");
    setConfirmation("");
    setVisible(false);
    setOpen(false);
    toast.success(
      hasPasswordIdentity
        ? "Password changed."
        : "Password set. You can now sign in with email as well as Google.",
    );
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
      </CardContent>
    </Card>
  );
}
