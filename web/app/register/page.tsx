import { Suspense } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { RegisterForm } from './RegisterForm';

export const metadata = { title: 'Create account' };

export default function RegisterPage() {
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
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Create your account</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Create your merchant account and sign in right away.
            </p>
          </div>

          <Suspense>
            <RegisterForm />
          </Suspense>
        </Card>
      </div>
    </main>
  );
}