import { config } from '../config.js';

const BATCH = 64;

function sortByIndex(data: Array<{ index: number; embedding: number[] }>): number[][] {
  return [...data]
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

async function embedOpenAI(batch: string[], model: string): Promise<number[][] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return sortByIndex(data.data);
  } catch {
    return null;
  }
}

async function embedOpenRouter(batch: string[], model: string): Promise<number[][] | null> {
  try {
    const base = (config.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'HTTP-Referer': config.APP_BASE_URL,
        'X-Title': 'AI Commerce Agent',
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return sortByIndex(data.data);
  } catch {
    return null;
  }
}

async function embedBatch(batch: string[], model: string): Promise<number[][] | null> {
  if (config.OPENAI_API_KEY) {
    const vecs = await embedOpenAI(batch, model);
    if (vecs) return vecs;
  }
  if (config.OPENROUTER_API_KEY) {
    return embedOpenRouter(batch, config.OPENROUTER_EMBEDDING_MODEL);
  }
  return null;
}

export async function embedTexts(
  texts: string[],
  model = 'text-embedding-3-small',
): Promise<number[][] | null> {
  if (texts.length === 0) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const vecs = await embedBatch(batch, model);
    if (!vecs) return null;
    out.push(...vecs);
  }
  return out;
}