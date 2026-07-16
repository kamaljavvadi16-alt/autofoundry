interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Array<[RegExp, ModelPricing]> = [
  [/fable|mythos/i, { inputPerMTok: 10, outputPerMTok: 50 }],
  [/opus/i, { inputPerMTok: 5, outputPerMTok: 25 }],
  [/sonnet/i, { inputPerMTok: 3, outputPerMTok: 15 }],
  [/haiku/i, { inputPerMTok: 1, outputPerMTok: 5 }],
];

const FALLBACK: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };

// 5-minute-TTL cache write premium; cache reads bill at ~10% of input price.
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function estimateCostUsd(model: string, t: TokenCounts): number {
  const p = PRICING.find(([re]) => re.test(model))?.[1] ?? FALLBACK;
  return (
    (t.input * p.inputPerMTok +
      t.cacheWrite * p.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      t.cacheRead * p.inputPerMTok * CACHE_READ_MULTIPLIER +
      t.output * p.outputPerMTok) /
    1_000_000
  );
}
