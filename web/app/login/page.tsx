import { Suspense } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LoginForm } from './LoginForm';

/**
 * Server component shell for the sign-in page.
 *
 * `LoginForm` reads the `next` query parameter, and a client component calling
 * `useSearchParams` has to sit inside a Suspense boundary for the page to be
 * prerendered at build time.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-violet-500 text-white shadow-sm">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-white">
            AI Commerce Agent
          </span>
        </div>

        <Card>
          <div className="space-y-1.5 text-center">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Sign in</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Sign in to manage your stores.
            </p>
          </div>

          <Suspense fallback={<LoginFormFallback />}>
            <LoginForm />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}

/** Matches the real form's layout so resolving the boundary does not shift it. */
function LoginFormFallback() {
  return (
    <div className="mt-5 space-y-5" aria-hidden>
      <div className="h-9 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" />
      <div className="h-11 animate-pulse rounded-xl bg-slate-100 dark:bg-white/5" />
    </div>
  );
}
