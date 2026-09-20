import { describe, expect, it } from 'vitest';
import { funnelSummary, lagDistribution, summarizeLag } from '../services/analytics.js';

describe('funnelSummary', () => {
  it('computes CTR and CVR with 3-decimal rounding', () => {
    const rows = funnelSummary([
      { channel: 'web', recommended: 100, clicked: 30, converted: 9, revenue: 450 },
      { channel: 'whatsapp', recommended: 50, clicked: 25, converted: 10, revenue: 1000, avgConversionLagHours: 2.35 },
    ]);
    expect(rows[0]).toMatchObject({ ctr: 0.3, cvr: 0.3, revenue: 450, avgConversionLagHours: 0 });
    expect(rows[1]).toMatchObject({ ctr: 0.5, cvr: 0.4, revenue: 1000, avgConversionLagHours: 2.4 });
    expect(rows[1].avgConversionLagHours).toBe(2.4);
  });

  it('returns zero rates when there is no activity', () => {
    const rows = funnelSummary([{ channel: 'web', recommended: 0, clicked: 0, converted: 0, revenue: 0 }]);
    expect(rows[0]).toMatchObject({ ctr: 0, cvr: 0, avgConversionLagHours: 0 });
  });
});

describe('summarizeLag', () => {
  it('computes avg/median/p90 of conversion lag hours', () => {
    const s = summarizeLag([1, 2, 3, 4, 100]);
    expect(s).toMatchObject({ count: 5, avgHours: 22, medianHours: 3, p90Hours: 100 });
  });

  it('returns zeros for an empty set', () => {
    expect(summarizeLag([])).toEqual({ count: 0, avgHours: 0, medianHours: 0, p90Hours: 0 });
  });
});

describe('lagDistribution', () => {
  it('buckets lags into cumulative time bands that sum to the total', () => {
    const ages = [0.5, 3, 10, 20, 40, 100, 200];
    const d = lagDistribution(ages);
    expect(d.map((b) => b.label)).toEqual(['<1h', '1–6h', '6–12h', '12–24h', '1–7d', '>7d']);
    expect(d.map((b) => b.count).reduce((a, b) => a + b, 0)).toBe(ages.length);
    const share = d.reduce((a, b) => a + b.share, 0);
    expect(share).toBeCloseTo(1, 2);
  });

  it('returns buckets with zero counts when empty', () => {
    const d = lagDistribution([]);
    expect(d.every((b) => b.count === 0 && b.share === 0)).toBe(true);
  });
});