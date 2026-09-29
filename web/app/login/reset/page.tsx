import { redirect } from 'next/navigation';

/**
 * Landing point for the Supabase recovery email link.
 *
 * The API issues reset links with `redirectTo = APP_BASE_URL/login/reset`
 * (APP_BASE_URL is the dashboard origin), so the browser lands here with
 * `?token=…&type=recovery`. The reset surface is the /reset page; redirecting
 * keeps every query parameter, so the token survives the hop.
 */
export default function LoginResetRedirect() {
  redirect('/reset');
}