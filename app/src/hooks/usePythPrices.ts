'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchPythPrices, getFeedIdForSymbol } from '@/utils/pyth';
import { fetchJupiterPrices } from '@/utils/jupiter';
import { MOCK_PRICES } from '@/utils/prices';

export interface PriceData {
    symbol: string;
    price: number;
    confidence?: number;
    publishTime?: number;
    source: 'pyth' | 'jupiter' | 'mock';
    loading: boolean;
    error?: string;
}

export interface PriceQuery {
    key: string;
    pythSymbol?: string;
}

interface NormalizedPriceQuery {
    key: string;
    pythSymbol?: string;
}

interface UsePythPricesOptions {
    symbols?: string[];
    queries?: PriceQuery[];
    refreshInterval?: number; // in milliseconds, default 40000 (40 seconds)
    enabled?: boolean;
}

interface UsePythPricesResult {
    prices: Map<string, PriceData>;
    isLoading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    lastUpdated: Date | null;
}

function isLikelyMint(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function normalizeQueries(options: { symbols?: string[]; queries?: PriceQuery[] }): NormalizedPriceQuery[] {
    const normalized: NormalizedPriceQuery[] = [];
    const keyIndex = new Map<string, number>();
    const raw =
        Array.isArray(options.queries) && options.queries.length > 0
            ? options.queries.map((query) => ({ key: query.key, pythSymbol: query.pythSymbol }))
            : (options.symbols ?? []).map((symbol) => ({ key: symbol, pythSymbol: symbol }));

    for (const entry of raw) {
        if (typeof entry.key !== 'string') continue;
        const key = entry.key.trim();
        if (!key) continue;
        const pythSymbol = typeof entry.pythSymbol === 'string' && entry.pythSymbol.trim().length > 0
            ? entry.pythSymbol.trim()
            : undefined;

        const existingIndex = keyIndex.get(key);
        if (typeof existingIndex === 'number') {
            if (!normalized[existingIndex].pythSymbol && pythSymbol) {
                normalized[existingIndex] = { ...normalized[existingIndex], pythSymbol };
            }
            continue;
        }

        normalized.push(pythSymbol ? { key, pythSymbol } : { key });
        keyIndex.set(key, normalized.length - 1);
    }

    return normalized;
}

/**
 * Hook to fetch and manage Pyth prices with fallback to mock prices
 */
export function usePythPrices({
    symbols,
    queries,
    refreshInterval = 40000,
    enabled = true,
}: UsePythPricesOptions): UsePythPricesResult {
    const [prices, setPrices] = useState<Map<string, PriceData>>(new Map());
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const mountedRef = useRef(true);
    const requestIdRef = useRef(0);
    const normalizedQueries = useMemo(
        () => normalizeQueries({ symbols, queries }),
        [symbols, queries]
    );
    const queryKeysSignature = useMemo(
        () => normalizedQueries.map((query) => query.key).slice().sort().join('|'),
        [normalizedQueries]
    );
    const latestQueriesRef = useRef<NormalizedPriceQuery[]>(normalizedQueries);

    const getMockPrice = useCallback((symbol: string) => {
        const exact = MOCK_PRICES[symbol];
        if (exact) return exact;
        return MOCK_PRICES[symbol.toUpperCase()];
    }, []);

    useEffect(() => {
        latestQueriesRef.current = normalizedQueries;
    }, [normalizedQueries]);

    const fetchPrices = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        const activeQueries = latestQueriesRef.current;
        if (!enabled || activeQueries.length === 0) {
            if (!mountedRef.current || requestId !== requestIdRef.current) return;
            setPrices(new Map());
            setIsLoading(false);
            setError(null);
            setLastUpdated(null);
            return;
        }

        try {
            setIsLoading(true);
            setError(null);

            const pythSymbolsByCanonical = new Map<string, string>();
            for (const query of activeQueries) {
                if (isLikelyMint(query.key)) continue;
                if (!query.pythSymbol || !getFeedIdForSymbol(query.pythSymbol)) continue;
                const canonical = query.pythSymbol.toUpperCase();
                if (!pythSymbolsByCanonical.has(canonical)) {
                    pythSymbolsByCanonical.set(canonical, query.pythSymbol);
                }
            }
            const pythSymbols = Array.from(pythSymbolsByCanonical.values());

            // Fetch Pyth prices
            const pythPrices = await fetchPythPrices(pythSymbols);

            // Build result map
            const resultPrices = new Map<string, PriceData>();
            const jupiterFallbackKeys: string[] = [];

            for (const query of activeQueries) {
                const pythSymbol = isLikelyMint(query.key) ? undefined : query.pythSymbol;
                const canonicalSymbol = pythSymbol?.toUpperCase();
                const pythPrice =
                    pythSymbol && canonicalSymbol
                        ? (pythPrices.get(pythSymbol) ?? pythPrices.get(canonicalSymbol))
                        : undefined;
                if (pythPrice) {
                    resultPrices.set(query.key, {
                        symbol: query.key,
                        price: pythPrice.price,
                        confidence: pythPrice.confidence,
                        publishTime: pythPrice.publishTime,
                        source: 'pyth',
                        loading: false,
                    });
                } else {
                    jupiterFallbackKeys.push(query.key);
                }
            }

            const uniqueJupiterFallbackKeys = [...new Set(jupiterFallbackKeys)];
            const jupiterPrices =
                uniqueJupiterFallbackKeys.length > 0
                    ? await fetchJupiterPrices(uniqueJupiterFallbackKeys)
                    : new Map();

            for (const query of activeQueries) {
                if (resultPrices.has(query.key)) continue;
                const canonicalKey = query.key.toUpperCase();
                const jupPrice = jupiterPrices.get(query.key) ?? jupiterPrices.get(canonicalKey);
                if (jupPrice) {
                    resultPrices.set(query.key, {
                        symbol: query.key,
                        price: jupPrice.price,
                        source: 'jupiter',
                        loading: false,
                    });
                } else {
                    const mockLookup = isLikelyMint(query.key) ? query.key : (query.pythSymbol || query.key);
                    const mockPrice = getMockPrice(mockLookup);
                    resultPrices.set(query.key, {
                        symbol: query.key,
                        price: mockPrice?.price ?? 0,
                        source: 'mock',
                        loading: false,
                        error: 'Missing live price',
                    });
                }
            }

            if (!mountedRef.current || requestId !== requestIdRef.current) return;
            setPrices(resultPrices);
            setLastUpdated(new Date());
        } catch (err) {
            if (!mountedRef.current || requestId !== requestIdRef.current) return;

            console.error('Error fetching prices:', err);
            setError(err instanceof Error ? err.message : 'Failed to fetch prices');

            // Fallback to mock prices on error
            const fallbackPrices = new Map<string, PriceData>();
            for (const query of activeQueries) {
                const mockLookup = isLikelyMint(query.key) ? query.key : (query.pythSymbol || query.key);
                const mockPrice = getMockPrice(mockLookup);
                fallbackPrices.set(query.key, {
                    symbol: query.key,
                    price: mockPrice?.price ?? 0,
                    source: 'mock',
                    loading: false,
                    error: 'Using fallback price',
                });
            }
            setPrices(fallbackPrices);
        } finally {
            if (mountedRef.current && requestId === requestIdRef.current) {
                setIsLoading(false);
            }
        }
    }, [enabled, getMockPrice]);

    // Initial fetch
    useEffect(() => {
        mountedRef.current = true;
        void fetchPrices();

        return () => {
            mountedRef.current = false;
        };
    }, [fetchPrices, queryKeysSignature]);

    // Set up refresh interval
    useEffect(() => {
        if (!enabled || refreshInterval <= 0) return;

        const intervalId = setInterval(() => {
            void fetchPrices();
        }, refreshInterval);

        return () => {
            clearInterval(intervalId);
        };
    }, [fetchPrices, refreshInterval, enabled]);

    return {
        prices,
        isLoading,
        error,
        refresh: fetchPrices,
        lastUpdated,
    };
}

/**
 * Simple hook to get a single price
 */
export function usePythPrice(symbol: string): PriceData | null {
    const { prices } = usePythPrices({ symbols: [symbol] });
    return prices.get(symbol) || prices.get(symbol.toUpperCase()) || null;
}

/**
 * Get price for a symbol from the prices map, with fallback
 */
export function getPriceFromMap(prices: Map<string, PriceData>, symbol: string): number {
    const priceData = prices.get(symbol) ?? prices.get(symbol.toUpperCase());
    if (priceData) return priceData.price;

    // Fallback to mock
    const mockPrice = MOCK_PRICES[symbol] ?? MOCK_PRICES[symbol.toUpperCase()];
    return mockPrice?.price ?? 0;
}
