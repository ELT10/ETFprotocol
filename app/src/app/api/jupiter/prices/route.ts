import { NextResponse } from 'next/server';

export interface JupiterPrice {
    symbol: string;
    price: number;
}

interface JupiterTokenRow {
    id?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
}

interface ResolvedToken {
    mint: string;
    symbol: string;
    decimals: number;
}

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://api.jup.ag';
const JUPITER_TOKENS_API_BASE = process.env.JUPITER_TOKENS_API_BASE || 'https://lite-api.jup.ag';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const REQUEST_DELAY_MS = Number(process.env.JUPITER_REQUEST_DELAY_MS || 1100);
const CACHE_TTL_MS = Number(process.env.JUPITER_PRICE_CACHE_TTL_MS || 30_000);
const USDC_MINT = process.env.JUPITER_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const USDT_MINT = process.env.JUPITER_USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDT_DECIMALS = 6;

type PriceCacheEntry = { expiresAt: number; price: JupiterPrice };
type TokenCacheEntry = { expiresAt: number; token: ResolvedToken | null };
const globalCache = globalThis as typeof globalThis & {
    __jupPriceCache?: Map<string, PriceCacheEntry>;
    __jupTokenResolveCache?: Map<string, TokenCacheEntry>;
};
const priceCacheStore: Map<string, PriceCacheEntry> = globalCache.__jupPriceCache ?? new Map<string, PriceCacheEntry>();
const tokenCacheStore: Map<string, TokenCacheEntry> =
    globalCache.__jupTokenResolveCache ?? new Map<string, TokenCacheEntry>();
globalCache.__jupPriceCache = priceCacheStore;
globalCache.__jupTokenResolveCache = tokenCacheStore;

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyMint(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function normalizePriceImpact(value: unknown): number | null {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num < 0) return null;
    return num > 1 ? num / 100 : num;
}

function tokenHeaders(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;
    return headers;
}

async function fetchTokensByQuery(query: string): Promise<JupiterTokenRow[]> {
    const res = await fetch(
        `${JUPITER_TOKENS_API_BASE}/tokens/v2/search?query=${encodeURIComponent(query)}`,
        {
            headers: tokenHeaders(),
            cache: 'no-store',
        }
    );
    if (!res.ok) return [];
    const payload: unknown = await res.json().catch(() => null);
    return Array.isArray(payload) ? (payload as JupiterTokenRow[]) : [];
}

function toResolvedToken(row: JupiterTokenRow): ResolvedToken | null {
    const mint = row.id?.trim();
    const symbol = row.symbol?.trim();
    const decimals = row.decimals;
    if (!mint || !symbol || typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;
    return {
        mint,
        symbol,
        decimals: Math.max(0, Math.floor(decimals)),
    };
}

function tokenCacheKey(query: string): string {
    return isLikelyMint(query) ? `mint:${query}` : `sym:${query.toUpperCase()}`;
}

function priceCacheKey(query: string): string {
    return tokenCacheKey(query);
}

async function resolveToken(query: string): Promise<ResolvedToken | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;
    if (trimmed.toUpperCase() === 'USDC' || trimmed === USDC_MINT) {
        return { mint: USDC_MINT, symbol: 'USDC', decimals: USDC_DECIMALS };
    }
    if (trimmed.toUpperCase() === 'USDT' || trimmed === USDT_MINT) {
        return { mint: USDT_MINT, symbol: 'USDT', decimals: USDT_DECIMALS };
    }

    const cacheKey = tokenCacheKey(trimmed);
    const cached = tokenCacheStore.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token;
    }

    const rows = await fetchTokensByQuery(trimmed);
    let selected: ResolvedToken | null = null;
    if (isLikelyMint(trimmed)) {
        const exact = rows.find((row) => row.id === trimmed);
        selected = exact ? toResolvedToken(exact) : null;
    } else {
        const exactSymbol = rows.find((row) => (row.symbol || '').toUpperCase() === trimmed.toUpperCase());
        selected = exactSymbol ? toResolvedToken(exactSymbol) : rows.length > 0 ? toResolvedToken(rows[0]) : null;
    }

    tokenCacheStore.set(cacheKey, {
        token: selected,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return selected;
}

async function fetchQuotePrice(key: string, resolved: ResolvedToken): Promise<JupiterPrice | null> {
    if (resolved.mint === USDC_MINT || resolved.mint === USDT_MINT) {
        return { symbol: key, price: 1 };
    }

    const inputAmountAtomic = (BigInt(10) ** BigInt(resolved.decimals)).toString();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;

    const quoteOutputs = [
        { mint: USDC_MINT, decimals: USDC_DECIMALS },
        { mint: USDT_MINT, decimals: USDT_DECIMALS },
    ];

    for (const output of quoteOutputs) {
        const params = new URLSearchParams({
            inputMint: resolved.mint,
            outputMint: output.mint,
            amount: inputAmountAtomic,
            slippageBps: '50',
            swapMode: 'ExactIn',
        });

        const res = await fetch(`${JUPITER_API_BASE}/swap/v1/quote?${params.toString()}`, {
            headers,
            cache: 'no-store',
        });

        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const route = Array.isArray((data as { data?: unknown[] })?.data)
            ? (data as { data: unknown[] }).data[0]
            : data;
        const outAmountRaw = (route as { outAmount?: unknown })?.outAmount;
        if (typeof outAmountRaw !== 'string' && typeof outAmountRaw !== 'number') continue;

        const outAmount = Number(outAmountRaw);
        if (!Number.isFinite(outAmount) || outAmount <= 0) continue;

        const impact = normalizePriceImpact((route as { priceImpactPct?: unknown; priceImpact?: unknown })?.priceImpactPct);
        const fallbackImpact = normalizePriceImpact((route as { priceImpact?: unknown })?.priceImpact);
        const effectiveImpact = impact ?? fallbackImpact;
        if (effectiveImpact !== null && effectiveImpact > 0.5) continue;

        const price = outAmount / Math.pow(10, output.decimals);
        return { symbol: key, price };
    }

    return null;
}

export async function POST(req: Request) {
    let body: { symbols?: string[] } | null = null;
    try {
        body = await req.json();
    } catch {
        body = null;
    }

    const symbols = body?.symbols?.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) ?? [];
    if (symbols.length === 0) {
        return NextResponse.json({ prices: [] as JupiterPrice[] });
    }

    const results: JupiterPrice[] = [];

    for (const key of symbols) {
        const cacheKey = priceCacheKey(key);
        const cached = priceCacheStore.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            results.push(cached.price);
            continue;
        }

        const resolved = await resolveToken(key);
        if (!resolved) {
            if (REQUEST_DELAY_MS > 0) await delay(REQUEST_DELAY_MS);
            continue;
        }

        const price = await fetchQuotePrice(key, resolved);
        if (price) {
            results.push(price);
            priceCacheStore.set(cacheKey, {
                price,
                expiresAt: Date.now() + CACHE_TTL_MS,
            });
        }

        if (REQUEST_DELAY_MS > 0) {
            await delay(REQUEST_DELAY_MS);
        }
    }

    return NextResponse.json({ prices: results });
}
