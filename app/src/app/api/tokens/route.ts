import { NextResponse } from 'next/server';

interface JupiterTokenRow {
    id?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    icon?: string;
    organicScore?: number;
}

interface TokenCatalogEntry {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
    logoURI?: string;
}

const JUPITER_TOKENS_API_BASE = process.env.JUPITER_TOKENS_API_BASE || 'https://lite-api.jup.ag';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CACHE_TTL_MS = Number(process.env.JUPITER_TOP_TOKENS_CACHE_TTL_MS || 5 * 60 * 1000);

type CacheEntry = { expiresAt: number; tokens: TokenCatalogEntry[] };
const globalCache = globalThis as typeof globalThis & {
    __topTokenCache?: Map<string, CacheEntry>;
};
const cacheStore: Map<string, CacheEntry> = globalCache.__topTokenCache ?? new Map<string, CacheEntry>();
globalCache.__topTokenCache = cacheStore;

function clampLimit(raw: string | null): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    const rounded = Math.floor(parsed);
    if (rounded <= 0) return DEFAULT_LIMIT;
    return Math.min(rounded, MAX_LIMIT);
}

function normalizeToken(row: JupiterTokenRow): TokenCatalogEntry | null {
    const mint = row.id?.trim();
    const symbol = row.symbol?.trim();
    const name = row.name?.trim();
    const decimals = row.decimals;
    if (!mint || !symbol || !name || typeof decimals !== 'number' || !Number.isFinite(decimals)) {
        return null;
    }
    return {
        symbol,
        name,
        mint,
        decimals: Math.max(0, Math.floor(decimals)),
        logoURI: row.icon,
    };
}

function dedupeTokens(tokens: TokenCatalogEntry[]): TokenCatalogEntry[] {
    const map = new Map<string, TokenCatalogEntry>();
    for (const token of tokens) {
        if (!map.has(token.mint)) {
            map.set(token.mint, token);
        }
    }
    return Array.from(map.values());
}

async function fetchTopTokens(limit: number): Promise<TokenCatalogEntry[]> {
    const cacheKey = `top:${limit}`;
    const cached = cacheStore.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.tokens;
    }

    const res = await fetch(`${JUPITER_TOKENS_API_BASE}/tokens/v2/tag?query=verified`, {
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`Token catalog request failed (${res.status})`);
    }

    const payload: unknown = await res.json().catch(() => null);
    const rows = Array.isArray(payload) ? (payload as JupiterTokenRow[]) : [];
    const mapped = rows
        .map((row) => ({
            token: normalizeToken(row),
            score: Number.isFinite(row.organicScore as number) ? Number(row.organicScore) : -1,
        }))
        .filter((entry): entry is { token: TokenCatalogEntry; score: number } => !!entry.token)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.token);

    const top = dedupeTokens(mapped).slice(0, limit);
    if (!top.length) {
        throw new Error('No tokens returned from upstream catalog');
    }

    cacheStore.set(cacheKey, {
        tokens: top,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return top;
}

function sortSearchResults(tokens: TokenCatalogEntry[], query: string): TokenCatalogEntry[] {
    const normalized = query.toLowerCase();
    const rank = (token: TokenCatalogEntry): number => {
        const symbol = token.symbol.toLowerCase();
        const name = token.name.toLowerCase();
        const mint = token.mint.toLowerCase();
        if (symbol === normalized) return 0;
        if (name === normalized) return 1;
        if (mint === normalized) return 2;
        if (symbol.startsWith(normalized)) return 3;
        if (name.startsWith(normalized)) return 4;
        if (mint.startsWith(normalized)) return 5;
        if (symbol.includes(normalized)) return 6;
        if (name.includes(normalized)) return 7;
        return 8;
    };
    return [...tokens].sort((a, b) => rank(a) - rank(b));
}

async function searchTokens(query: string, limit: number): Promise<TokenCatalogEntry[]> {
    const cacheKey = `search:${query.toLowerCase()}:${limit}`;
    const cached = cacheStore.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.tokens;
    }

    const res = await fetch(
        `${JUPITER_TOKENS_API_BASE}/tokens/v2/search?query=${encodeURIComponent(query)}`,
        { cache: 'no-store' }
    );
    if (!res.ok) {
        throw new Error(`Token search request failed (${res.status})`);
    }

    const payload: unknown = await res.json().catch(() => null);
    const rows = Array.isArray(payload) ? (payload as JupiterTokenRow[]) : [];
    const mapped = rows
        .map(normalizeToken)
        .filter((token): token is TokenCatalogEntry => !!token);

    const filtered = mapped.filter((token) => {
        const symbol = token.symbol.toLowerCase();
        const name = token.name.toLowerCase();
        const mint = token.mint.toLowerCase();
        const normalized = query.toLowerCase();
        return symbol.includes(normalized) || name.includes(normalized) || mint.includes(normalized);
    });

    const ranked = sortSearchResults(dedupeTokens(filtered), query).slice(0, limit);
    cacheStore.set(cacheKey, {
        tokens: ranked,
        expiresAt: Date.now() + Math.min(CACHE_TTL_MS, 60_000),
    });
    return ranked;
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const limit = clampLimit(url.searchParams.get('limit'));
    const query = url.searchParams.get('q')?.trim() ?? '';

    try {
        const tokens = query.length > 0 ? await searchTokens(query, limit) : await fetchTopTokens(limit);
        return NextResponse.json({ tokens });
    } catch (error) {
        console.error('Token catalog request failed:', error);
        return NextResponse.json({ error: 'Token catalog unavailable' }, { status: 502 });
    }
}
