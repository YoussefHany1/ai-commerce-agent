"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AtSign, KeyRound, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { api, ApiError } from "@/lib/api";
import { useLocale } from "@/lib/locale";
import { makeTranslator } from "@/lib/i18n";

type State = "idle" | "submitting" | "error" | "done";

/**
 * Finishes a password reset.
 *
 * The reset email from Supabase points at `/login/reset?token=…&type=recovery` on
 * this app. The form collects the new password and hands the token to the
 * `/api/auth/reset` BFF route, which verifies it, rotates the password, bumps the
 * account epoch (killing every older session) and returns signed in. After that
 * redirect to the dashboard.
 */
export function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { locale } = useLocale();
  const t = makeTranslator(locale);

  const token = params.get("token") ?? "";
  const type = params.get("type");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!token || type !== "recovery") {
    return (
      <div className="mt-5 space-y-4 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("resetInvalidLink")}
        </p>
        <Link
          href="/forgot"
          className="font-medium text-violet-600 hover:text-violet-500 dark:text-violet-400"
        >
          {t("forgotSubmit")}
        </Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state === "submitting") return;
    if (!email.trim() || !password) return;
    if (password.length < 12) {
      setState("error");
      setMessage("Password must be at least 12 characters.");
      return;
    }

    setState("submitting");
    setMessage(null);

    try {
      await api.resetPassword({ email: email.trim(), token, password });
      setState("done");
      setMessage(t("resetPasswordSet"));
      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      const errorText =
        error instanceof ApiError
          ? error.code === "invalid_link"
            ? t("resetInvalidLink")
            : error.status === 503
              ? t("authUnavailable")
              : t("authGenericError")
          : t("authGenericError");
      setState("error");
      setMessage(errorText);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-5">
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
        label={t("resetToken")}
        name="token"
        type="text"
        autoComplete="off"
        icon={<KeyRound className="h-4 w-4" />}
        value={token}
        onChange={() => {}}
        disabled
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
        disabled={state === "submitting" || !email.trim() || !password}
      >
        {t("resetSubmit")}
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