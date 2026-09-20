export type EvalCase = {
  query: string;
  relevant: string[];
  note?: string;
};

export type EvalResult = {
  query: string;
  note?: string;
  relevant: Set<string>;
  ranked: string[];
  hitsAt1: boolean;
  hitsAt3: boolean;
  hitsAt5: boolean;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  topProducts: Array<{ id: string; title: string; score: number; source: string }>;
};

export function hitsAt(ranked: string[], relevant: Set<string>, k: number): boolean {
  return ranked.slice(0, k).some((id) => relevant.has(id));
}

export function recallAt(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const matched = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return matched / relevant.size;
}

export function mrr(ranked: string[], relevant: Set<string>): number {
  const idx = ranked.findIndex((id) => relevant.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

export function ndcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  const dcg = (list: string[]) =>
    list.slice(0, k).reduce((acc, id, i) => acc + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Math.min(k, relevant.size);
  const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  if (idcg === 0) return 0;
  return dcg(ranked) / idcg;
}

export function evaluateCase(
  query: string,
  ranked: Array<{ id: string; title: string; score: number; source: string }>,
  relevantIds: string[],
  note?: string,
): EvalResult {
  const relevant = new Set(relevantIds);
  const rankedIds = ranked.map((r) => r.id);
  return {
    query,
    note,
    relevant,
    ranked: rankedIds,
    hitsAt1: hitsAt(rankedIds, relevant, 1),
    hitsAt3: hitsAt(rankedIds, relevant, 3),
    hitsAt5: hitsAt(rankedIds, relevant, 5),
    recallAt3: recallAt(rankedIds, relevant, 3),
    recallAt5: recallAt(rankedIds, relevant, 5),
    mrr: mrr(rankedIds, relevant),
    ndcgAt5: ndcgAt(rankedIds, relevant, 5),
    topProducts: ranked,
  };
}

export function summarize(results: EvalResult[]): {
  cases: number;
  hitsAt1: number;
  hitsAt3: number;
  hitsAt5: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  nonzeroRelevant: number;
} {
  const withRelevant = results.filter((r) => r.relevant.size > 0);
  const mean = (fn: (r: EvalResult) => number) =>
    withRelevant.length ? withRelevant.reduce((a, r) => a + fn(r), 0) / withRelevant.length : 0;
  return {
    cases: results.length,
    hitsAt1: withRelevant.filter((r) => r.hitsAt1).length,
    hitsAt3: withRelevant.filter((r) => r.hitsAt3).length,
    hitsAt5: withRelevant.filter((r) => r.hitsAt5).length,
    recallAt3: round(mean((r) => r.recallAt3)),
    recallAt5: round(mean((r) => r.recallAt5)),
    mrr: round(mean((r) => r.mrr)),
    ndcgAt5: round(mean((r) => r.ndcgAt5)),
    nonzeroRelevant: withRelevant.length,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}