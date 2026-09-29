"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { AtSign } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { api, ApiError } from "@/lib/api";
import { useLocale } from "@/lib/locale";
import { makeTranslator } from "@/lib/i18n";

type State = "idle" | "submitting" | "error" | "sent";

/**
 * Requests a password reset email. The outcome is deliberately uniform: whether
 * or not the email is registered, the page says the same thing, so the form can
 * never be used to enumerate accounts.
 */
export function ForgotForm() {
  const { locale } = useLocale();
  const t = makeTranslator(locale);

  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state === "submitting") return;
    if (!email.trim()) return;

    setState("submitting");
    setMessage(null);

    try {
      await api.forgot(email.trim());
      setState("sent");
      setMessage(t("forgotSent"));
    } catch (error) {
      const errorText =
        error instanceof ApiError && error.status === 503
          ? t("authUnavailable")
          : t("authGenericError");
      setState("error");
      setMessage(errorText);
    }
  }

  if (state === "sent") {
    return (
      <div className="mt-5 space-y-4 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("forgotSent")}</p>
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
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        autoFocus
        icon={<AtSign className="h-4 w-4" />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={state === "error" ? message ?? undefined : undefined}
        disabled={state === "submitting"}
      />

      <Button
        type="submit"
        className="w-full"
        loading={state === "submitting"}
        disabled={state === "submitting" || !email.trim()}
      >
        {t("forgotSubmit")}
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