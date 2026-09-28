/**
 * Timestamps from the Saudi merchant platforms.
 *
 * Salla returns `date.date` as `"2026-08-02 18:08:47.000000"` alongside a
 * `timezone: "Asia/Riyadh"` hint, and Zid returns `created_at` as
 * `"2025-11-12 08:57:35"` with no zone at all. Neither is ISO 8601: no `T`, no
 * offset. `new Date()` on such a string is implementation-defined — V8 accepts
 * it and resolves it against the *host* timezone, so on a UTC host every order
 * is read three hours late.
 *
 * That is not a rounding error. Saudi stores take a large share of their orders
 * after 21:00 local, which is exactly the window that gets pushed across the
 * midnight boundary and attributed to the next day. The daily revenue rollup
 * groups by `placed_at`, so the misattribution lands directly in the dashboard.
 *
 * Naive values are therefore pinned to the platform's own timezone (Riyadh,
 * UTC+3 year-round — Saudi Arabia has observed no DST since 2016) instead of to
 * whatever the server happens to be running in.
 */

/** Matches an offset-free platform timestamp, with or without a `T` separator. */
const NAIVE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;

/** Offsets for zones the platforms hand us. Riyadh is UTC+3 with no DST. */
const ZONE_OFFSETS: Record<string, string> = {
  'Asia/Riyadh': '+03:00',
};

export const DEFAULT_PLATFORM_TIMEZONE = 'Asia/Riyadh';

/**
 * Parses a merchant-platform timestamp into a real instant.
 *
 * Values that already carry a zone (`2026-08-02T18:08:47Z`, `...+03:00`) are
 * handed to `Date` untouched. Values without one are read as `timezone`, which
 * defaults to Riyadh — the correct reading for both Salla and Zid, and the only
 * defensible one for Zid, which reports no zone at all.
 *
 * Returns `undefined` rather than an `Invalid Date` so callers can treat a
 * missing or unusable timestamp as "placement unknown" instead of poisoning a
 * comparison.
 */
export function parsePlatformDate(
  value: string | null | undefined,
  timezone: string | null | undefined = DEFAULT_PLATFORM_TIMEZONE,
): Date | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const match = NAIVE_TIMESTAMP.exec(raw);
  if (!match) {
    const direct = new Date(raw);
    return Number.isNaN(direct.getTime()) ? undefined : direct;
  }

  const [, year, month, day, hour, minute, second, fraction] = match;
  const offset = (timezone && ZONE_OFFSETS[timezone]) ?? ZONE_OFFSETS[DEFAULT_PLATFORM_TIMEZONE]!;
  // Sub-millisecond precision is not representable, and appending those digits in
  // front of the offset would make the string unparseable, so the fraction is cut
  // to milliseconds and right-padded to keep the `.mmm` form.
  const millis = (fraction ?? '').slice(0, 3).padEnd(3, '0');
  const withZone = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offset}`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Formats an instant as the `yyyy-mm-dd` that Salla's `from_date` / `to_date`
 * filters accept. UTC on purpose: the filter is a calendar day in the store's
 * timezone, and the client-side timestamp filter re-trims the edges, so a day of
 * slack here costs a few extra rows rather than correctness.
 */
export function toPlatformDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}
