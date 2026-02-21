export interface LiquidityRange {
    min: number;
    max: number | null;
    label: string;
    tier: number;
}

const RANGE_BUCKETS: LiquidityRange[] = [
    { min: 0, max: 10, label: '$0-$10', tier: 1 },
    { min: 10, max: 100, label: '$10-$100', tier: 2 },
    { min: 100, max: 1_000, label: '$100-$1K', tier: 3 },
    { min: 1_000, max: 10_000, label: '$1K-$10K', tier: 4 },
    { min: 10_000, max: 100_000, label: '$10K-$100K', tier: 5 },
    { min: 100_000, max: null, label: '$100K+', tier: 6 },
];

export function getInvestmentRange(amount: number): LiquidityRange {
    if (!Number.isFinite(amount) || amount <= 0) {
        return RANGE_BUCKETS[0];
    }

    for (const bucket of RANGE_BUCKETS) {
        if (bucket.max === null) return bucket;
        if (amount >= bucket.min && amount < bucket.max) return bucket;
    }

    return RANGE_BUCKETS[RANGE_BUCKETS.length - 1];
}

function depthScore(amount: number, cap: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const capped = Math.min(amount, cap);
    return Math.log10(capped + 1) / Math.log10(cap + 1);
}

export function computeLiquidityScore(
    tokens: { weight: number; maxSize: number }[],
    cap: number = 100_000
): number {
    if (tokens.length === 0) return 0;

    const scores = tokens.map((t) => depthScore(t.maxSize, cap));
    const weighted = tokens.reduce((sum, t, idx) => sum + t.weight * scores[idx], 0);
    const validScores = scores.filter((score) => score > 0);
    const minScore = validScores.length > 0 ? Math.min(...validScores) : 0;

    const score = 100 * (0.7 * weighted + 0.3 * minScore);
    return Math.max(0, Math.min(100, Math.round(score)));
}
