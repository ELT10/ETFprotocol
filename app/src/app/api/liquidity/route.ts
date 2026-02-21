import { NextResponse } from 'next/server';
import { computeLiquidityScore, getInvestmentRange } from '@/utils/liquidity';

interface LiquidityAssetInput {
    mint: string;
    symbol?: string;
    weight: number;
}

interface TokenLiquidityResult {
    mint: string;
    symbol: string;
    weight: number;
    priceImpactPct: number | null;
    maxSize: number;
    effectiveMax: number;
    error?: string;
}

interface LiquidityResponse {
    asOf: string;
    maxImpactBps: number;
    probeSizeUsdc: number;
    maxExtrapolationMultiplier: number;
    missingQuotes: string[];
    tokens: TokenLiquidityResult[];
    index: {
        maxInvestment: number;
        recommendedRange: ReturnType<typeof getInvestmentRange>;
        liquidityScore: number;
        limitingToken: TokenLiquidityResult | null;
    };
}

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://api.jup.ag';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const PROBE_SIZE_USDC = Number(process.env.JUPITER_LIQUIDITY_PROBE_USDC || 1000);
const MAX_IMPACT_BPS = Number(process.env.JUPITER_MAX_IMPACT_BPS || 100);
const MAX_EXTRAPOLATION_MULTIPLIER = Number(process.env.JUPITER_LIQUIDITY_MAX_MULTIPLIER || 20);
const CACHE_TTL_MS = Number(process.env.JUPITER_LIQUIDITY_CACHE_TTL_MS || 10 * 60 * 1000);
const REQUEST_DELAY_MS = Number(process.env.JUPITER_REQUEST_DELAY_MS || 1100);

const USDC_MINT = process.env.JUPITER_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

type CacheEntry = { expiresAt: number; data: LiquidityResponse };
const globalCache = globalThis as typeof globalThis & {
    __jupLiquidityCache?: Map<string, CacheEntry>;
};
const cacheStore: Map<string, CacheEntry> = globalCache.__jupLiquidityCache ?? new Map<string, CacheEntry>();
globalCache.__jupLiquidityCache = cacheStore;

function normalizePriceImpact(value: unknown): number | null {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num < 0) return null;
    // If API returns percent (e.g. 3 for 3%), normalize to decimal.
    return num > 1 ? num / 100 : num;
}

async function fetchQuotePriceImpactPct(inputMint: string, outputMint: string, amount: number): Promise<number | null> {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: Math.floor(amount).toString(),
        swapMode: 'ExactIn',
        slippageBps: '50',
    });

    const headers: Record<string, string> = { accept: 'application/json' };
    if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;

    const res = await fetch(`${JUPITER_API_BASE}/swap/v1/quote?${params.toString()}`, {
        headers,
        cache: 'no-store',
    });

    if (!res.ok) return null;
    const data = await res.json();
    const route = Array.isArray(data?.data) ? data.data[0] : data;
    return normalizePriceImpact(route?.priceImpactPct ?? route?.priceImpact);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateMaxSize(impactPct: number | null, probeSize: number, maxImpactBps: number): number {
    const targetImpact = maxImpactBps / 10_000;
    if (impactPct === null) {
        return 0;
    }
    if (impactPct <= 0) {
        return probeSize * MAX_EXTRAPOLATION_MULTIPLIER;
    }
    const estimate = (probeSize * targetImpact) / impactPct;
    return Math.min(estimate, probeSize * MAX_EXTRAPOLATION_MULTIPLIER);
}

function buildCacheKey(assets: LiquidityAssetInput[]): string {
    const normalized = assets
        .map((a) => ({
            mint: a.mint,
            weight: Math.round(a.weight * 10_000) / 10_000,
        }))
        .sort((a, b) => a.mint.localeCompare(b.mint));
    return JSON.stringify({
        assets: normalized,
        probe: PROBE_SIZE_USDC,
        maxImpactBps: MAX_IMPACT_BPS,
    });
}

export async function POST(req: Request) {
    let body: { assets?: LiquidityAssetInput[] } | null = null;
    try {
        body = await req.json();
    } catch {
        body = null;
    }

    if (!body?.assets?.length) {
        return NextResponse.json({ error: 'Missing assets' }, { status: 400 });
    }

    const cacheKey = buildCacheKey(body.assets);
    const cached = cacheStore.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return NextResponse.json(cached.data);
    }

    const tokens: TokenLiquidityResult[] = [];
    const missingQuotes: string[] = [];

    for (const asset of body.assets) {
        if (!asset.mint || !Number.isFinite(asset.weight) || asset.weight <= 0) continue;

        const symbol =
            asset.symbol ||
            `${asset.mint.slice(0, 4)}...${asset.mint.slice(-4)}`;

        if (asset.mint === USDC_MINT) {
            const maxSize = PROBE_SIZE_USDC * MAX_EXTRAPOLATION_MULTIPLIER * 10;
            tokens.push({
                mint: asset.mint,
                symbol,
                weight: asset.weight,
                priceImpactPct: 0,
                maxSize,
                effectiveMax: maxSize / asset.weight,
            });
            continue;
        }

        const amountRaw = PROBE_SIZE_USDC * Math.pow(10, USDC_DECIMALS);
        const impactPct = await fetchQuotePriceImpactPct(USDC_MINT, asset.mint, amountRaw);
        const maxSize = estimateMaxSize(impactPct, PROBE_SIZE_USDC, MAX_IMPACT_BPS);
        const effectiveMax = maxSize / asset.weight;
        const hadQuote = impactPct !== null;
        if (!hadQuote) missingQuotes.push(symbol);

        tokens.push({
            mint: asset.mint,
            symbol,
            weight: asset.weight,
            priceImpactPct: impactPct,
            maxSize,
            effectiveMax,
            error: hadQuote ? undefined : 'no-quote',
        });

        if (REQUEST_DELAY_MS > 0) {
            await delay(REQUEST_DELAY_MS);
        }
    }

    const limitingToken = tokens
        .filter((token) => token.maxSize > 0 && Number.isFinite(token.effectiveMax))
        .reduce<TokenLiquidityResult | null>((minToken, token) => {
            if (!minToken) return token;
            return token.effectiveMax < minToken.effectiveMax ? token : minToken;
        }, null);

    const maxInvestment = limitingToken ? limitingToken.effectiveMax : 0;
    const liquidityScore = computeLiquidityScore(tokens.map((t) => ({ weight: t.weight, maxSize: t.maxSize })));
    const recommendedRange = getInvestmentRange(maxInvestment);

    const response: LiquidityResponse = {
        asOf: new Date().toISOString(),
        maxImpactBps: MAX_IMPACT_BPS,
        probeSizeUsdc: PROBE_SIZE_USDC,
        maxExtrapolationMultiplier: MAX_EXTRAPOLATION_MULTIPLIER,
        missingQuotes,
        tokens,
        index: {
            maxInvestment,
            recommendedRange,
            liquidityScore,
            limitingToken,
        },
    };

    cacheStore.set(cacheKey, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(response);
}
