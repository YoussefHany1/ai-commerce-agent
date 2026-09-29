"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { AtSign, Lock, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { api, ApiError } from "@/lib/api";
import { useLocale } from "@/lib/locale";
import { makeTranslator } from "@/lib/i18n";

type State = "idle" | "submitting" | "error" | "created";

/**
 * Activates an invited merchant account. The call goes to this app's own
 * `/api/auth/register` BFF route, which creates the Supabase identity (with the
 * confirmation email sent by Supabase, not this pod) and the account row. There
 * is no session minted here — the first real sign-in does that.
 */
export function RegisterForm() {
  const { locale } = useLocale();
  const t = makeTranslator(locale);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);

  function fail(error: unknown) {
    const errorText =
      error instanceof ApiError
        ? error.status === 503
          ? t("authUnavailable")
          : t("authGenericError")
        : t("authGenericError");
    setState("error");
    setMessage(errorText);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state === "submitting") return;
    if (!name.trim() || !email.trim() || !password) return;
    if (password.length < 12) {
      setState("error");
      setMessage("Password must be at least 12 characters.");
      return;
    }

    setState("submitting");
    setMessage(null);

    try {
      await api.register({ name: name.trim(), email: email.trim(), password });
      setState("created");
      setMessage(t("registerCheckEmail"));
    } catch (error) {
      fail(error);
    }
  }

  if (state === "created") {
    return (
      <div className="mt-5 space-y-4 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("registerCheckEmail")}
        </p>
        <Link
          href="/login"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-violet-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-violet-500 hover:to-violet-400"
        >
          {t("authHaveAccount")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-5">
      <Input
        label="Name"
        name="name"
        type="text"
        autoComplete="name"
        autoFocus
        icon={<UserRound className="h-4 w-4" />}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={state === "error" ? message ?? undefined : undefined}
        disabled={state === "submitting"}
      />

      <Input
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        icon={<AtSign className="h-4 w-4" />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={state === "error" ? message ?? undefined : undefined}
        disabled={state === "submitting"}
      />

      <Input
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        icon={<Lock className="h-4 w-4" />}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={state === "error" ? message ?? undefined : undefined}
        disabled={state === "submitting"}
      />

      <Button
        type="submit"
        className="w-full"
        loading={state === "submitting"}
        disabled={state === "submitting" || !name.trim() || !email.trim() || !password}
      >
        {t("registerSubmit")}
      </Button>

      <p className="text-center text-sm">
        <Link
          href="/login"
          className="font-medium text-violet-600 hover:text-violet-500 dark:text-violet-400"
        >
          {t("authHaveAccount")}
        </Link>
      </p>
    </form>
  );
}