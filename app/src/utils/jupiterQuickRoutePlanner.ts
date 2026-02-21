import {
    JUPITER_QUICK_ROUTE_BASE_TOKENS,
    type JupiterQuickRouteCheckResult,
    type JupiterRouteBaseSymbol,
} from '@/utils/jupiter';

export interface IndexQuickRouteBaseSupport {
    symbol: JupiterRouteBaseSymbol;
    quickBuySupported: boolean;
    quickSellSupported: boolean;
    roundTripSupported: boolean;
    minQuickBuySharesAtomic: bigint | null;
    minQuickSellSharesAtomic: bigint | null;
    buyBlockedSymbols: string[];
    sellBlockedSymbols: string[];
}

export interface IndexQuickRouteCoverageSummary {
    quickBuyBaseSymbols: JupiterRouteBaseSymbol[];
    quickSellBaseSymbols: JupiterRouteBaseSymbol[];
    roundTripBaseSymbols: JupiterRouteBaseSymbol[];
    partiallySupportedBaseSymbols: JupiterRouteBaseSymbol[];
    quickBuyAvailable: boolean;
    quickSellAvailable: boolean;
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function ceilDivBigInt(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= BigInt(0)) return BigInt(0);
    return (numerator + denominator - BigInt(1)) / denominator;
}

function toPositiveAtomicOrNull(raw: string | undefined): bigint | null {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const parsed = BigInt(raw);
    return parsed > BigInt(0) ? parsed : null;
}

export function buildBaseCandidateOrder<T extends string>(preferred: T, options: readonly { symbol: T }[]): T[] {
    const seen = new Set<T>();
    const order: T[] = [];
    const push = (symbol: T) => {
        if (seen.has(symbol)) return;
        seen.add(symbol);
        order.push(symbol);
    };

    push(preferred);
    for (const option of options) {
        push(option.symbol);
    }

    return order;
}

export function buildIndexQuickRouteSupportByBase(params: {
    selectedTokens: string[];
    tokenQuickRouteByMint: Record<string, JupiterQuickRouteCheckResult>;
    tokenSymbolByMint: Map<string, string>;
    perShareAtomicByMint: Map<string, bigint | null>;
}): IndexQuickRouteBaseSupport[] {
    const support = JUPITER_QUICK_ROUTE_BASE_TOKENS.map((base) => ({
        symbol: base.symbol,
        quickBuySupported: true,
        quickSellSupported: true,
        roundTripSupported: true,
        minQuickBuySharesAtomic: BigInt(0) as bigint | null,
        minQuickSellSharesAtomic: BigInt(0) as bigint | null,
        buyBlockedSymbols: [] as string[],
        sellBlockedSymbols: [] as string[],
    }));

    for (const mint of params.selectedTokens) {
        const symbol = params.tokenSymbolByMint.get(mint) || mint.slice(0, 6);
        const routeResult = params.tokenQuickRouteByMint[mint];
        const perShareAtomic = params.perShareAtomicByMint.get(mint) ?? null;

        for (const baseSupport of support) {
            const baseRoute = routeResult?.baseCapabilities.find((capability) => capability.symbol === baseSupport.symbol);
            if (!baseRoute) {
                baseSupport.quickBuySupported = false;
                baseSupport.quickSellSupported = false;
                baseSupport.buyBlockedSymbols.push(symbol);
                baseSupport.sellBlockedSymbols.push(symbol);
                continue;
            }

            if (!baseRoute.quickBuySupported) {
                baseSupport.quickBuySupported = false;
                baseSupport.buyBlockedSymbols.push(symbol);
            } else {
                const minBuyAmountAtomic = toPositiveAtomicOrNull(baseRoute.buyExactIn.minAmountAtomic);
                if (minBuyAmountAtomic && minBuyAmountAtomic > BigInt(0)) {
                    if (!perShareAtomic || perShareAtomic <= BigInt(0)) {
                        baseSupport.minQuickBuySharesAtomic = null;
                    } else if (baseSupport.minQuickBuySharesAtomic !== null) {
                        const minShares = ceilDivBigInt(minBuyAmountAtomic, perShareAtomic);
                        if (minShares > baseSupport.minQuickBuySharesAtomic) {
                            baseSupport.minQuickBuySharesAtomic = minShares;
                        }
                    }
                }
            }

            if (!baseRoute.quickSellSupported) {
                baseSupport.quickSellSupported = false;
                baseSupport.sellBlockedSymbols.push(symbol);
            } else {
                const minSellAmountAtomic = toPositiveAtomicOrNull(baseRoute.sellExactIn.minAmountAtomic);
                if (minSellAmountAtomic && minSellAmountAtomic > BigInt(0)) {
                    if (!perShareAtomic || perShareAtomic <= BigInt(0)) {
                        baseSupport.minQuickSellSharesAtomic = null;
                    } else if (baseSupport.minQuickSellSharesAtomic !== null) {
                        const minShares = ceilDivBigInt(minSellAmountAtomic, perShareAtomic);
                        if (minShares > baseSupport.minQuickSellSharesAtomic) {
                            baseSupport.minQuickSellSharesAtomic = minShares;
                        }
                    }
                }
            }
        }
    }

    return support.map((baseSupport) => {
        const quickBuySupported = baseSupport.quickBuySupported;
        const quickSellSupported = baseSupport.quickSellSupported;
        return {
            ...baseSupport,
            roundTripSupported: quickBuySupported && quickSellSupported,
            minQuickBuySharesAtomic: quickBuySupported ? baseSupport.minQuickBuySharesAtomic : null,
            minQuickSellSharesAtomic: quickSellSupported ? baseSupport.minQuickSellSharesAtomic : null,
            buyBlockedSymbols: uniqueStrings(baseSupport.buyBlockedSymbols),
            sellBlockedSymbols: uniqueStrings(baseSupport.sellBlockedSymbols),
        };
    });
}

export function summarizeIndexQuickRouteCoverage(
    baseSupport: IndexQuickRouteBaseSupport[]
): IndexQuickRouteCoverageSummary {
    const quickBuyBaseSymbols = baseSupport.filter((base) => base.quickBuySupported).map((base) => base.symbol);
    const quickSellBaseSymbols = baseSupport.filter((base) => base.quickSellSupported).map((base) => base.symbol);
    const roundTripBaseSymbols = baseSupport.filter((base) => base.roundTripSupported).map((base) => base.symbol);
    const partiallySupportedBaseSymbols = baseSupport
        .filter((base) => base.quickBuySupported || base.quickSellSupported)
        .map((base) => base.symbol);

    return {
        quickBuyBaseSymbols,
        quickSellBaseSymbols,
        roundTripBaseSymbols,
        partiallySupportedBaseSymbols,
        quickBuyAvailable: quickBuyBaseSymbols.length > 0,
        quickSellAvailable: quickSellBaseSymbols.length > 0,
    };
}
