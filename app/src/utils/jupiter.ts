export interface JupiterPrice {
    symbol: string;
    price: number;
}

export type JupiterSwapMode = 'ExactIn';
export type JupiterRouteBaseSymbol = 'USDC' | 'USDT' | 'SOL';

export interface JupiterQuote {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: JupiterSwapMode;
    slippageBps: number;
    priceImpactPct?: string;
    routePlan?: unknown[];
}

export interface JupiterSwapTransactionResponse {
    swapTransaction: string;
    lastValidBlockHeight?: number;
    prioritizationFeeLamports?: number;
}

export interface JupiterRouteBaseTokenOption {
    symbol: JupiterRouteBaseSymbol;
    mint: string;
    decimals: number;
}

export type JupiterQuickRouteProbeStatus = 'supported' | 'unsupported' | 'error';

export interface JupiterQuickRouteProbeResult {
    status: JupiterQuickRouteProbeStatus;
    attempts: number;
    minAmountAtomic?: string;
    lastTriedAmountAtomic: string;
    reason?: string;
}

export interface JupiterQuickRouteBaseCapability {
    symbol: JupiterRouteBaseSymbol;
    baseMint: string;
    buyExactIn: JupiterQuickRouteProbeResult;
    sellExactIn: JupiterQuickRouteProbeResult;
    quickBuySupported: boolean;
    quickSellSupported: boolean;
    roundTripSupported: boolean;
}

export interface JupiterQuickRouteCheckResult {
    supported: boolean;
    unsupportedRoutes: string[];
    failedRoutes: string[];
    baseCapabilities: JupiterQuickRouteBaseCapability[];
    anyQuickBuySupported: boolean;
    anyQuickSellSupported: boolean;
    anyRoundTripSupported: boolean;
    allBasesRoundTripSupported: boolean;
}

export const DEFAULT_JUP_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEFAULT_JUP_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEFAULT_JUP_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const DEFAULT_JUP_SLIPPAGE_BPS = 50;
export const DEFAULT_JUP_QUOTE_TIMEOUT_MS = 12_000;

export const JUPITER_QUICK_ROUTE_BASE_TOKENS: JupiterRouteBaseTokenOption[] = [
    {
        symbol: 'USDC',
        mint: process.env.NEXT_PUBLIC_JUPITER_USDC_MINT?.trim() || DEFAULT_JUP_USDC_MINT,
        decimals: 6,
    },
    {
        symbol: 'USDT',
        mint: process.env.NEXT_PUBLIC_JUPITER_USDT_MINT?.trim() || DEFAULT_JUP_USDT_MINT,
        decimals: 6,
    },
    {
        symbol: 'SOL',
        mint: DEFAULT_JUP_SOL_MINT,
        decimals: 9,
    },
];

function isLikelyMint(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function extractErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const maybeError = (payload as { error?: unknown }).error;
    if (typeof maybeError === 'string' && maybeError.trim().length > 0) return maybeError;
    const maybeMessage = (payload as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) return maybeMessage;
    return null;
}

export function isLikelyNonTradableError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes('not tradable') ||
        normalized.includes('no route') ||
        normalized.includes('could not find any route') ||
        normalized.includes('market not found')
    );
}

function oneTokenAtomic(decimals: number): string {
    return (BigInt(10) ** BigInt(Math.max(0, Math.floor(decimals)))).toString();
}

function normalizePositiveAtomic(amount: string | undefined): bigint | null {
    if (typeof amount !== 'string') return null;
    const trimmed = amount.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = BigInt(trimmed);
    if (parsed <= BigInt(0)) return null;
    return parsed;
}

function resolveProbeAttempts(rawAttempts: number | undefined): number {
    if (typeof rawAttempts !== 'number' || !Number.isFinite(rawAttempts)) return 8;
    return Math.max(1, Math.floor(rawAttempts));
}

function resolveProbeMultiplier(rawMultiplier: number | undefined): bigint {
    if (typeof rawMultiplier !== 'number' || !Number.isFinite(rawMultiplier)) return BigInt(10);
    return BigInt(Math.max(2, Math.floor(rawMultiplier)));
}

function directRouteProbeResult(): JupiterQuickRouteProbeResult {
    return {
        status: 'supported',
        attempts: 0,
        minAmountAtomic: '0',
        lastTriedAmountAtomic: '0',
    };
}

async function probeRouteWithAdaptiveAmount(params: {
    inputMint: string;
    outputMint: string;
    swapMode: JupiterSwapMode;
    slippageBps: number;
    initialAmountAtomic: bigint;
    maxAmountAtomic: bigint;
    maxAttempts: number;
    multiplier: bigint;
}): Promise<JupiterQuickRouteProbeResult> {
    let amount = params.initialAmountAtomic > BigInt(0) ? params.initialAmountAtomic : BigInt(1);
    let maxAmount = params.maxAmountAtomic > BigInt(0) ? params.maxAmountAtomic : amount;
    if (maxAmount < amount) {
        maxAmount = amount;
    }

    let attempts = 0;
    let lastTriedAmountAtomic = amount.toString();
    let lastReason = 'No routes found';

    while (attempts < params.maxAttempts) {
        const attemptAmount = amount > maxAmount ? maxAmount : amount;
        const amountAtomic = attemptAmount.toString();
        attempts += 1;
        lastTriedAmountAtomic = amountAtomic;

        try {
            await fetchJupiterQuote({
                inputMint: params.inputMint,
                outputMint: params.outputMint,
                amount: amountAtomic,
                swapMode: params.swapMode,
                slippageBps: params.slippageBps,
            });
            return {
                status: 'supported',
                attempts,
                minAmountAtomic: amountAtomic,
                lastTriedAmountAtomic: amountAtomic,
            };
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!isLikelyNonTradableError(reason)) {
                return {
                    status: 'error',
                    attempts,
                    lastTriedAmountAtomic: amountAtomic,
                    reason,
                };
            }

            lastReason = reason;
            if (attemptAmount >= maxAmount) break;
            const nextAmount = attemptAmount * params.multiplier;
            amount = nextAmount > maxAmount ? maxAmount : nextAmount;
        }
    }

    return {
        status: 'unsupported',
        attempts,
        lastTriedAmountAtomic,
        reason: lastReason,
    };
}

export async function fetchJupiterPrice(symbol: string): Promise<JupiterPrice | null> {
    const prices = await fetchJupiterPrices([symbol]);
    return prices.get(symbol) ?? prices.get(symbol.toUpperCase()) ?? null;
}

export async function fetchJupiterPrices(symbols: string[]): Promise<Map<string, JupiterPrice>> {
    if (!symbols.length) return new Map();
    const normalizedSymbols = [
        ...new Set(
            symbols
                .map((symbol) => symbol.trim())
                .filter(Boolean)
                .map((symbol) => (isLikelyMint(symbol) ? symbol : symbol.toUpperCase()))
        ),
    ];
    const map = new Map<string, JupiterPrice>();
    try {
        const res = await fetch('/api/jupiter/prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbols: normalizedSymbols }),
        });
        if (!res.ok) return map;
        const data = await res.json();
        const prices = Array.isArray(data?.prices) ? data.prices : [];
        for (const item of prices) {
            if (item?.symbol && Number.isFinite(item?.price)) {
                const price = { symbol: item.symbol, price: Number(item.price) };
                map.set(item.symbol, price);
                if (!isLikelyMint(item.symbol)) {
                    map.set(item.symbol.toUpperCase(), price);
                }
            }
        }
    } catch (err) {
        console.error('Failed to fetch Jupiter prices', err);
    }
    return map;
}

export async function fetchJupiterQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
    swapMode?: JupiterSwapMode;
    timeoutMs?: number;
}): Promise<JupiterQuote> {
    const timeoutMs =
        typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
            ? Math.floor(params.timeoutMs)
            : DEFAULT_JUP_QUOTE_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
        res = await fetch('/api/jupiter/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: controller.signal,
        }).catch((err) => {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error(`Quote request timed out after ${timeoutMs}ms`);
            }
            throw err;
        });
    } finally {
        window.clearTimeout(timeoutId);
    }

    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
        const reason = extractErrorMessage(payload) ?? `Quote failed (${res.status})`;
        throw new Error(reason);
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid quote response');
    }
    return payload as JupiterQuote;
}

export async function checkJupiterQuickRouteTradability(params: {
    tokenMint: string;
    tokenDecimals: number;
    baseTokens?: JupiterRouteBaseTokenOption[];
    slippageBps?: number;
    probeTokenAmountAtomic?: string;
    maxProbeTokenAmountAtomic?: string;
    maxProbeAttempts?: number;
    probeMultiplier?: number;
}): Promise<JupiterQuickRouteCheckResult> {
    const baseTokens = params.baseTokens ?? JUPITER_QUICK_ROUTE_BASE_TOKENS;
    const slippageBps = params.slippageBps ?? DEFAULT_JUP_SLIPPAGE_BPS;
    const initialProbeAmountAtomic =
        normalizePositiveAtomic(params.probeTokenAmountAtomic) ?? BigInt(oneTokenAtomic(params.tokenDecimals));
    const defaultMaxProbeAmountAtomic = BigInt(oneTokenAtomic(params.tokenDecimals)) * BigInt(1_000_000);
    const normalizedMaxProbeAmountAtomic = normalizePositiveAtomic(params.maxProbeTokenAmountAtomic);
    const maxProbeAmountAtomic =
        normalizedMaxProbeAmountAtomic && normalizedMaxProbeAmountAtomic > initialProbeAmountAtomic
            ? normalizedMaxProbeAmountAtomic
            : defaultMaxProbeAmountAtomic > initialProbeAmountAtomic
              ? defaultMaxProbeAmountAtomic
              : initialProbeAmountAtomic;
    const maxProbeAttempts = resolveProbeAttempts(params.maxProbeAttempts);
    const probeMultiplier = resolveProbeMultiplier(params.probeMultiplier);
    const unsupportedRoutes: string[] = [];
    const failedRoutes: string[] = [];
    const baseCapabilities: JupiterQuickRouteBaseCapability[] = [];

    for (const base of baseTokens) {
        const buyExactIn =
            base.mint === params.tokenMint
                ? directRouteProbeResult()
                : await probeRouteWithAdaptiveAmount({
                      inputMint: base.mint,
                      outputMint: params.tokenMint,
                      swapMode: 'ExactIn',
                      slippageBps,
                      initialAmountAtomic: initialProbeAmountAtomic,
                      maxAmountAtomic: maxProbeAmountAtomic,
                      maxAttempts: maxProbeAttempts,
                      multiplier: probeMultiplier,
                  });
        const sellExactIn =
            base.mint === params.tokenMint
                ? directRouteProbeResult()
                : await probeRouteWithAdaptiveAmount({
                      inputMint: params.tokenMint,
                      outputMint: base.mint,
                      swapMode: 'ExactIn',
                      slippageBps,
                      initialAmountAtomic: initialProbeAmountAtomic,
                      maxAmountAtomic: maxProbeAmountAtomic,
                      maxAttempts: maxProbeAttempts,
                      multiplier: probeMultiplier,
                  });

        if (buyExactIn.status === 'unsupported') {
            unsupportedRoutes.push(`${base.symbol}->token (ExactIn)`);
        } else if (buyExactIn.status === 'error') {
            failedRoutes.push(`${base.symbol}->token (ExactIn): ${buyExactIn.reason || 'quote failed'}`);
        }

        if (sellExactIn.status === 'unsupported') {
            unsupportedRoutes.push(`token->${base.symbol} (ExactIn)`);
        } else if (sellExactIn.status === 'error') {
            failedRoutes.push(`token->${base.symbol} (ExactIn): ${sellExactIn.reason || 'quote failed'}`);
        }

        baseCapabilities.push({
            symbol: base.symbol,
            baseMint: base.mint,
            buyExactIn,
            sellExactIn,
            quickBuySupported: buyExactIn.status === 'supported',
            quickSellSupported: sellExactIn.status === 'supported',
            roundTripSupported: buyExactIn.status === 'supported' && sellExactIn.status === 'supported',
        });
    }

    const anyQuickBuySupported = baseCapabilities.some((base) => base.quickBuySupported);
    const anyQuickSellSupported = baseCapabilities.some((base) => base.quickSellSupported);
    const anyRoundTripSupported = baseCapabilities.some((base) => base.roundTripSupported);
    const allBasesRoundTripSupported = baseCapabilities.length > 0 && baseCapabilities.every((base) => base.roundTripSupported);

    return {
        supported: anyRoundTripSupported,
        unsupportedRoutes,
        failedRoutes,
        baseCapabilities,
        anyQuickBuySupported,
        anyQuickSellSupported,
        anyRoundTripSupported,
        allBasesRoundTripSupported,
    };
}

export async function fetchJupiterSwapTransaction(params: {
    quoteResponse: JupiterQuote;
    userPublicKey: string;
    wrapAndUnwrapSol?: boolean;
}): Promise<JupiterSwapTransactionResponse> {
    const res = await fetch('/api/jupiter/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
        const reason = extractErrorMessage(payload) ?? `Swap transaction build failed (${res.status})`;
        throw new Error(reason);
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid swap transaction response');
    }

    const swapTransaction = (payload as { swapTransaction?: unknown }).swapTransaction;
    if (typeof swapTransaction !== 'string' || swapTransaction.length === 0) {
        throw new Error('Missing swap transaction payload');
    }

    return payload as JupiterSwapTransactionResponse;
}
