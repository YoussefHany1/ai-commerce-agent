'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

type State = 'idle' | 'submitting' | 'locked' | 'error';

/**
 * Exchanges the operator password for the HTTP-only session cookie.
 *
 * The password is never persisted here — it is posted to this app's own login route
 * and dropped. Whether it was correct, and how many attempts remain before a lockout,
 * is decided by the API, which owns the stored hash and the shared attempt counter.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [password, setPassword] = useState('');
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password || state === 'submitting') return;

    setState('submitting');
    setMessage(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Only same-origin paths, so `next` cannot become an open redirect.
        const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
        router.replace(target);
        router.refresh();
        return;
      }

      if (res.status === 429) {
        const header = Number(res.headers.get('retry-after'));
        setState('locked');
        setRetryAfter(Number.isFinite(header) && header > 0 ? header : 60);
        setMessage('Too many attempts. Wait a moment and try again.');
        return;
      }

      if (res.status === 503) {
        setState('error');
        setMessage('Sign-in is temporarily unavailable. Please try again shortly.');
        return;
      }

      setState('error');
      setMessage('Incorrect password.');
    } catch {
      setState('error');
      setMessage('Could not reach the server. Check your connection and try again.');
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-5">
      <Input
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        autoFocus
        icon={<Lock className="h-4 w-4" />}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={state === 'error' && message ? message : undefined}
        disabled={state === 'submitting' || state === 'locked'}
      />

      {state === 'locked' && message && (
        <p className="text-center text-sm text-amber-600 dark:text-amber-400">{message}</p>
      )}

      <Button type="submit" className="w-full" loading={state === 'submitting'} disabled={!password || state === 'locked'}>
        Sign in
      </Button>

      {retryAfter !== null && (
        <p className="text-center text-xs text-slate-400">Retry in about {retryAfter}s.</p>
      )}
    </form>
  );
}
