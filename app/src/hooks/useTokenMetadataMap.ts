'use client';

import { useEffect, useMemo, useState } from 'react';

export interface TokenMetadata {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
    logoURI?: string;
}

interface UseTokenMetadataMapResult {
    tokenMap: Map<string, TokenMetadata>;
    loading: boolean;
    error: string | null;
}

const MAX_MINTS = 120;

export function useTokenMetadataMap(mints: string[]): UseTokenMetadataMapResult {
    const [tokenMap, setTokenMap] = useState<Map<string, TokenMetadata>>(new Map());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalizedMints = useMemo(
        () =>
            Array.from(
                new Set(
                    mints
                        .filter((mint) => typeof mint === 'string')
                        .map((mint) => mint.trim())
                        .filter((mint) => mint.length > 0)
                )
            )
                .sort()
                .slice(0, MAX_MINTS),
        [mints]
    );

    useEffect(() => {
        if (normalizedMints.length === 0) {
            setTokenMap(new Map());
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);

        const fetchMetadata = async () => {
            try {
                const res = await fetch('/api/tokens/resolve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mints: normalizedMints }),
                });

                if (!res.ok) {
                    throw new Error(`Token resolve failed (${res.status})`);
                }

                const payload: unknown = await res.json().catch(() => null);
                const tokens = Array.isArray((payload as { tokens?: unknown[] })?.tokens)
                    ? ((payload as { tokens: TokenMetadata[] }).tokens)
                          .filter((token) => token?.mint && token?.symbol && typeof token.decimals === 'number')
                    : [];

                if (cancelled) return;
                const map = new Map<string, TokenMetadata>();
                for (const token of tokens) {
                    map.set(token.mint, token);
                }
                setTokenMap(map);
            } catch (err: unknown) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                    setTokenMap(new Map());
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void fetchMetadata();
        return () => {
            cancelled = true;
        };
    }, [normalizedMints]);

    return { tokenMap, loading, error };
}
