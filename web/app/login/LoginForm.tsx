"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AtSign, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { useLocale } from "@/lib/locale";
import { makeTranslator } from "@/lib/i18n";

type State = "idle" | "submitting" | "locked" | "error";
type Kind = "operator" | "client";

/**
 * Exchanges email and password for the HTTP-only session cookie.
 *
 * Two kinds of account sign in here, and they differ in exactly one respect: an operator
 * is a person who runs this install, a client is an invited merchant. Both now sign in
 * with an email and a password against Supabase — the operator's address used to be
 * irrelevant, because one shared password was the credential — so the two tabs differ
 * only in which endpoint the form posts to, not in what it asks for.
 *
 * The password is never persisted here: it goes to this app's own login route and is
 * dropped. Whether it was correct, and how many attempts remain before a lockout, is
 * decided by the API.
 *
 * Google is offered to both, deliberately. The callback has no way to know which kind of
 * person is arriving — it is one redirect either way — so it hands the token to the API
 * and writes whichever session that token earned. Gating the button by tab would only
 * mean the operator had to arrive with a password.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const { locale } = useLocale();
  const t = makeTranslator(locale);

  const [kind, setKind] = useState<Kind>("operator");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state === "submitting") return;
    if (!password || !email) return;

    setState("submitting");
    setMessage(null);

    const body = { kind, email, password };

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        // Only same-origin paths, so `next` cannot become an open redirect.
        const target =
          next && next.startsWith("/") && !next.startsWith("//")
            ? next
            : "/dashboard";
        router.replace(target);
        router.refresh();
        return;
      }

      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after"));
        setState("locked");
        setRetryAfter(Number.isFinite(header) && header > 0 ? header : 60);
        setMessage("Too many attempts. Wait a moment and try again.");
        return;
      }

      if (res.status === 503) {
        setState("error");
        setMessage(
          "Sign-in is temporarily unavailable. Please try again shortly.",
        );
        return;
      }

      setState("error");
      // One message for both. Saying "wrong password" to an operator or "unknown email"
      // to a merchant would turn this form into a probe for which addresses have an
      // account on this install.
      setMessage("Invalid email or password.");
    } catch {
      setState("error");
      setMessage(
        "Could not reach the server. Check your connection and try again.",
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-5">
      {/* Which kind of account is being used. It selects the endpoint, not the
          credential: both tabs ask for the same two fields. */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/5">
        {(
          [
            { value: "operator", label: "Operator" },
            { value: "client", label: "Store login" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setKind(option.value);
              setMessage(null);
              setState("idle");
              setRetryAfter(null);
              setPassword("");
              setEmail("");
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-semibold transition",
              kind === option.value
                ? "bg-white text-slate-900 shadow-sm dark:bg-white/10 dark:text-white"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <Input
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        autoFocus
        icon={<AtSign className="h-4 w-4" />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={state === "error" && message ? message : undefined}
        disabled={state === "submitting" || state === "locked"}
      />

      <Input
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        icon={<Lock className="h-4 w-4" />}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={state === "error" && message ? message : undefined}
        disabled={state === "submitting" || state === "locked"}
      />

      {state === "locked" && message && (
        <p className="text-center text-sm text-amber-600 dark:text-amber-400">
          {message}
        </p>
      )}

      <Button
        type="submit"
        className="w-full"
        loading={state === "submitting"}
        disabled={state === "locked" || !password || !email}
      >
        Sign in
      </Button>

      {/* Google and password recovery are offered to both kinds. Recovery is
          principal-neutral upstream: it reaches whichever account the token resolves
          to, and so does the OAuth callback. */}
      <div className="space-y-4 pt-1">
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-slate-200 dark:border-white/10" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white px-3 text-xs text-slate-400 dark:bg-slate-900 dark:text-slate-500">
              or
            </span>
          </div>
        </div>

        <a
          href="/auth/google"
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-white/10 dark:text-slate-200 dark:hover:bg-white/5"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
            <path
              fill="#EA4335"
              d="M12 5.04c1.7 0 3.22.58 4.42 1.72l3.28-3.28C17.65 1.6 15.05.5 12 .5 7.44.5 3.42 3.23 1.62 7.15l3.85 2.99C6.25 7.5 8.92 5.04 12 5.04z"
            />
            <path
              fill="#4285F4"
              d="M23.5 12.27c0-.88-.08-1.53-.25-2.27H12v4.51h6.47c-.13 1.07-1.17 2.83-3.27 3.97l3.83 2.98c2.62-2.42 4.47-5.98 4.47-9.19z"
            />
            <path
              fill="#FBBC05"
              d="M5.47 14.14a6.94 6.94 0 0 1-.36-2.14c0-.74.13-1.46.35-2.14L1.62 6.87A11.46 11.46 0 0 0 .5 12c0 1.85.44 3.6 1.22 5.17l3.75-3.03z"
            />
            <path
              fill="#34A853"
              d="M12 23.5c3.04 0 5.59-1 7.46-2.63l-3.83-2.98c-1.02.7-2.34 1.19-3.63 1.19-3.05 0-5.72-2.46-6.52-5.94L1.62 17.17C3.42 20.77 7.44 23.5 12 23.5z"
            />
          </svg>
          {t("authGoogle")}
        </a>

        <div className="flex items-center justify-between text-sm">
          <Link
            href="/forgot"
            className="font-medium text-violet-600 hover:text-violet-500 dark:text-violet-400"
          >
            {t("authForgotPassword")}
          </Link>
          {/* Self-signup is for merchants; operators are provisioned by an
              existing one, so an invite is the only way in. */}
          {kind === "client" && (
            <Link
              href="/register"
              className="font-medium text-violet-600 hover:text-violet-500 dark:text-violet-400"
            >
              {t("authCreateAccount")}
            </Link>
          )}
        </div>
      </div>

      {retryAfter !== null && (
        <p className="text-center text-xs text-slate-400">
          Retry in about {retryAfter}s.
        </p>
      )}
    </form>
  );
}