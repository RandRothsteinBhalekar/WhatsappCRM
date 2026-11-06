"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, UsersRound, Loader2, Lock } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token so signup can pass it to the server gate and then
  // land on /join/<token> to redeem.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(!inviteToken);
  const [ownerBootstrapAllowed, setOwnerBootstrapAllowed] = useState(false);
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (inviteToken) {
        try {
          const res = await fetch(
            `/api/invitations/${encodeURIComponent(inviteToken)}/peek`,
            { cache: "no-store" },
          );
          const body = (await res.json()) as {
            ok?: boolean;
            email?: string | null;
          };
          if (!cancelled && body.ok && body.email) {
            setInvitedEmail(body.email);
            setEmail(body.email);
          }
        } catch {
          // Peek failure still allows the form; server signup gate decides.
        } finally {
          if (!cancelled) setPolicyLoading(false);
        }
        return;
      }

      try {
        const res = await fetch("/api/auth/signup-policy", { cache: "no-store" });
        const body = (await res.json()) as { ownerBootstrapAllowed?: boolean };
        if (!cancelled) {
          setOwnerBootstrapAllowed(Boolean(body.ownerBootstrapAllowed));
        }
      } catch {
        if (!cancelled) setOwnerBootstrapAllowed(false);
      } finally {
        if (!cancelled) setPolicyLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const canShowForm = Boolean(inviteToken) || ownerBootstrapAllowed;

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }

    if (password.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }

    setLoading(true);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        inviteToken: inviteToken || undefined,
      },
    });

    if (signUpError) {
      setError(signUpError.message ?? "Error");
      setLoading(false);
      return;
    }

    // better-auth autoSignIn: true — prefer hard nav so cookies hit middleware.
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    if (data.session) {
      window.location.href = destination;
      return;
    }

    // No session (edge case) — send them to login / join.
    window.location.href = inviteToken
      ? `/login?invite=${encodeURIComponent(inviteToken)}`
      : "/login";
  };

  if (policyLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canShowForm) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              {t("inviteRequiredTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("inviteRequiredDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("signIn")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken
              ? t("titleJoin")
              : ownerBootstrapAllowed
                ? t("titleOwner")
                : t("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t("descJoin")
              : ownerBootstrapAllowed
                ? t("descOwner")
                : t("desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {t("fullNameLabel")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("fullNamePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                readOnly={Boolean(invitedEmail)}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("passwordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                {t("confirmPasswordLabel")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("creating") : t("submit")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("haveAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
