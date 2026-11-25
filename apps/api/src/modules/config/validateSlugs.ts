import { OPENROUTER_BASE } from "../../lib/openrouter/stream";

/** USD per token, from OpenRouter's /models pricing. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

export interface SlugCheck {
  missing: string[];
  prices: Map<string, ModelPrice>;
}

/**
 * Startup check (T049): every configured preset slug must exist on OpenRouter. Also loads
 * per-token prices for `usage_daily.llm_cost_usd`, and warms the keep-alive connection.
 * Never throws: a failed check is logged and the API still starts.
 */
export async function validateSlugs(
  slugs: string[],
  fetchFn: typeof fetch,
  baseUrl = OPENROUTER_BASE,
): Promise<SlugCheck> {
  const res = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`models list HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const prices = new Map<string, ModelPrice>();
  for (const m of body.data ?? []) {
    if (!m.id) continue;
    prices.set(m.id, {
      prompt: Number(m.pricing?.prompt ?? 0),
      completion: Number(m.pricing?.completion ?? 0),
    });
  }
  const missing = [...new Set(slugs)].filter((s) => !prices.has(s));
  return { missing, prices };
}

export function llmCostUsd(
  price: ModelPrice | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!price) return 0;
  return (
    Math.round((inputTokens * price.prompt + outputTokens * price.completion) * 100_000) / 100_000
  );
}
