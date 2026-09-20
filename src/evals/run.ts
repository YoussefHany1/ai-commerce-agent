import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { retrieve } from '../services/retrieval.js';
import { evaluateCase, summarize, type EvalCase } from './scoring.js';

const DEFAULT_STORE = '6aa91608-5c0c-4da4-8e5d-5f13daa1df6d';
const DEFAULT_DATASET = 'eval/queries.json';
const TOP_K = 10;

async function main() {
  const { values } = parseArgs({
    options: {
      store: { type: 'string', default: DEFAULT_STORE },
      dataset: { type: 'string', default: DEFAULT_DATASET },
      mode: { type: 'string', default: '' },
      rerank: { type: 'string', default: '' },
    },
  });
  const storeId = String(values.store);
  const datasetPath = String(values.dataset);
  const mode = String(values.mode).toLowerCase() || undefined;
  const rerankFlag = String(values.rerank).toLowerCase() || undefined;

  let raw: string;
  try {
    raw = await readFile(datasetPath, 'utf8');
  } catch (e) {
    console.error(`cannot read dataset: ${datasetPath} (${(e as Error).message})`);
    process.exit(1);
  }
  const cases = JSON.parse(raw) as EvalCase[];
  if (!Array.isArray(cases) || !cases.length) {
    console.error('dataset must be a non-empty JSON array');
    process.exit(1);
  }

  const effectiveMode = mode ?? config.RETRIEVAL_MODE;
  const effectiveRerank = rerankFlag ?? config.RETRIEVAL_RE_RANK;
  console.log(`eval | store=${storeId} mode=${effectiveMode} rerank=${effectiveRerank} cases=${cases.length} dataset=${datasetPath}`);
  console.log('');

  const results = [];
  for (const c of cases) {
    const ranked = await retrieve(c.query, storeId, {
      limit: TOP_K,
      mode: mode as any,
      rerank: rerankFlag as any,
    });
    const mapped = ranked.map((r) => ({ id: r.product.id, title: r.product.title, score: r.score, source: r.source }));
    results.push(evaluateCase(c.query, mapped, c.relevant, c.note));
  }

  const pad = (s: string, n: number) => String(s).padEnd(n).slice(0, n);
  console.log(
    pad('query', 26) + pad('hit@1', 6) + pad('hit@3', 6) + pad('hit@5', 6) +
    pad('recall@3', 9) + pad('recall@5', 9) + pad('mrr', 6) + pad('ndcg@5', 7),
  );
  console.log('-'.repeat(78));
  for (const r of results) {
    console.log(
      pad(r.query.slice(0, 25), 26) +
      pad(r.hitsAt1 ? 'Y' : '-', 6) + pad(r.hitsAt3 ? 'Y' : '-', 6) + pad(r.hitsAt5 ? 'Y' : '-', 6) +
      pad(r.recallAt3.toFixed(2), 9) + pad(r.recallAt5.toFixed(2), 9) + pad(r.mrr.toFixed(2), 6) +
      pad(r.ndcgAt5.toFixed(2), 7),
    );
  }
  console.log('');

  const s = summarize(results);
  console.log('---- summary (relevant cases only) ----');
  console.log(`cases: ${s.cases} (${s.nonzeroRelevant} with relevant targets)`);
  console.log(`hits@1: ${s.hitsAt1}/${s.nonzeroRelevant}   hits@3: ${s.hitsAt3}/${s.nonzeroRelevant}   hits@5: ${s.hitsAt5}/${s.nonzeroRelevant}`);
  console.log(`recall@3: ${s.recallAt3.toFixed(3)}   recall@5: ${s.recallAt5.toFixed(3)}`);
  console.log(`mrr: ${s.mrr.toFixed(3)}   ndcg@5: ${s.ndcgAt5.toFixed(3)}`);
  console.log('');

  const failures = results.filter((r) => r.relevant.size > 0 && !r.hitsAt5);
  if (failures.length) {
    console.log('---- no-hit cases ----');
    for (const f of failures) console.log(`  ${f.query}  (top: ${f.ranked.length ? f.ranked.slice(0, 3).join(', ') : 'none'})`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});