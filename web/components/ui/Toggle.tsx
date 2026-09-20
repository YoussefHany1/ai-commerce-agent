'use client';

import { cn } from '@/lib/utils';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  size = 'md',
  'aria-label': ariaLabel,
}: ToggleProps) {
  const th = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const kh = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const dotTranslate = size === 'sm' ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-5 rtl:-translate-x-5';

  return (
    <label
      className={cn(
        'flex items-center gap-3',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200',
          th,
          checked
            ? 'border-transparent bg-gradient-to-r from-violet-600 to-violet-500'
            : 'border-slate-300 bg-slate-200 dark:border-white/10 dark:bg-white/10',
          disabled && 'pointer-events-none',
        )}
      >
        <span
          className={cn(
            'inline-block rounded-full bg-white shadow-sm transition-transform duration-200',
            kh,
            checked ? dotTranslate : 'translate-x-0.5 rtl:-translate-x-0.5',
          )}
        />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && (
            <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">
              {label}
            </span>
          )}
          {description && (
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
}