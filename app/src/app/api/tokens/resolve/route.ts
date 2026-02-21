import { NextResponse } from 'next/server';

interface JupiterTokenRow {
    id?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    icon?: string;
}

interface TokenCatalogEntry {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
    logoURI?: string;
}

const JUPITER_TOKENS_API_BASE = process.env.JUPITER_TOKENS_API_BASE || 'https://lite-api.jup.ag';
const CACHE_TTL_MS = Number(process.env.JUPITER_TOKEN_RESOLVE_CACHE_TTL_MS || 10 * 60 * 1000);
const MAX_MINTS = 120;

type CacheEntry = { expiresAt: number; token: TokenCatalogEntry | null };
const globalCache = globalThis as typeof globalThis & {
    __tokenResolveCache?: Map<string, CacheEntry>;
};
const cacheStore: Map<string, CacheEntry> = globalCache.__tokenResolveCache ?? new Map<string, CacheEntry>();
globalCache.__tokenResolveCache = cacheStore;

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

async function resolveMint(mint: string): Promise<TokenCatalogEntry | null> {
    const cacheKey = mint;
    const cached = cacheStore.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token;
    }

    const res = await fetch(
        `${JUPITER_TOKENS_API_BASE}/tokens/v2/search?query=${encodeURIComponent(mint)}`,
        { cache: 'no-store' }
    );
    if (!res.ok) {
        throw new Error(`Token resolve failed (${res.status})`);
    }
    const payload: unknown = await res.json().catch(() => null);
    const rows = Array.isArray(payload) ? (payload as JupiterTokenRow[]) : [];
    const exact = rows.find((row) => row.id === mint);
    const token = exact ? normalizeToken(exact) : null;

    cacheStore.set(cacheKey, {
        token,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return token;
}

export async function POST(req: Request) {
    let body: { mints?: string[] } | null = null;
    try {
        body = (await req.json()) as { mints?: string[] };
    } catch {
        body = null;
    }

    const mints = Array.isArray(body?.mints)
        ? Array.from(
              new Set(
                  body!.mints
                      .filter((mint): mint is string => typeof mint === 'string')
                      .map((mint) => mint.trim())
                      .filter((mint) => mint.length > 0)
              )
          ).slice(0, MAX_MINTS)
        : [];

    if (mints.length === 0) {
        return NextResponse.json({ tokens: [] as TokenCatalogEntry[] });
    }

    const resolved = await Promise.all(
        mints.map(async (mint) => {
            try {
                return await resolveMint(mint);
            } catch {
                return null;
            }
        })
    );

    const tokens = resolved.filter((token): token is TokenCatalogEntry => !!token);
    return NextResponse.json({ tokens });
}
