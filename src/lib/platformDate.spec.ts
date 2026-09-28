import { describe, expect, test } from 'vitest';
import { parsePlatformDate, toPlatformDateParam } from './platformDate.js';

describe('parsePlatformDate', () => {
  test('reads an offset-free Salla timestamp as Riyadh local time', () => {
    expect(parsePlatformDate('2026-08-02 18:08:47.000000')?.toISOString()).toBe('2026-08-02T15:08:47.000Z');
  });

  test('reads an offset-free Zid timestamp as Riyadh local time', () => {
    expect(parsePlatformDate('2025-11-12 08:57:35')?.toISOString()).toBe('2025-11-12T05:57:35.000Z');
  });

  test('does not let a late-evening order drift into the next day', () => {
    // 23:30 in Riyadh is 20:30Z the same day. Resolved as UTC local it becomes
    // the following day and the rollup books the revenue to the wrong date.
    expect(parsePlatformDate('2026-08-02 23:30:00')?.toISOString()).toBe('2026-08-02T20:30:00.000Z');
  });

  test('honours an explicit zone over the platform default', () => {
    expect(parsePlatformDate('2026-08-02T18:08:47Z')?.toISOString()).toBe('2026-08-02T18:08:47.000Z');
    expect(parsePlatformDate('2026-08-02 18:08:47', 'Asia/Riyadh')?.toISOString()).toBe('2026-08-02T15:08:47.000Z');
  });

  test('accepts a T separator and sub-millisecond precision', () => {
    expect(parsePlatformDate('2026-08-02T18:08:47.123456789')?.toISOString()).toBe('2026-08-02T15:08:47.123Z');
  });

  test('returns undefined rather than an Invalid Date', () => {
    expect(parsePlatformDate(undefined)).toBeUndefined();
    expect(parsePlatformDate(null)).toBeUndefined();
    expect(parsePlatformDate('')).toBeUndefined();
    expect(parsePlatformDate('   ')).toBeUndefined();
    expect(parsePlatformDate('not a date')).toBeUndefined();
    expect(parsePlatformDate('2026-13-45 99:99:99')).toBeUndefined();
  });
});

describe('toPlatformDateParam', () => {
  test('formats a calendar day for from_date and to_date', () => {
    expect(toPlatformDateParam(new Date('2026-03-04T23:59:59Z'))).toBe('2026-03-04');
  });
});
