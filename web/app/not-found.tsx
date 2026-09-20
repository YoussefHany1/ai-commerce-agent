import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6 text-center dark:bg-bg-depth">
      <p className="text-7xl font-black tracking-tight text-gradient">404</p>
      <div>
        <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Page not found
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The page you’re looking for doesn’t exist or has moved.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="btn-primary"
      >
        Back to dashboard
      </Link>
    </div>
  );
}