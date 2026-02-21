// Pyth Network Price Feed Integration
// Using Hermes API for real-time price data
// Docs: https://docs.pyth.network/price-feeds/core/how-pyth-works/hermes

import { HermesClient } from '@pythnetwork/hermes-client';

// Hermes endpoint - free public endpoint
const HERMES_ENDPOINT = 'https://hermes.pyth.network';

// Pyth Price Feed IDs (these are the same across all networks)
// Full list: https://pyth.network/developers/price-feed-ids
export const PYTH_FEED_IDS: Record<string, string> = {
    // Major cryptocurrencies
    BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', // BTC/USD
    WBTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', // Same as BTC
    ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', // ETH/USD
    WETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', // Same as ETH
    SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', // SOL/USD

    // Stablecoins
    USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a', // USDC/USD
    USDT: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', // USDT/USD

    // Solana ecosystem tokens
    BONK: '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419', // BONK/USD
    JUP: '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996', // JUP/USD
    PYTH: '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff', // PYTH/USD
    JTO: '0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2', // JTO/USD
    RENDER: '0xab7f4d287419056349d5af5c99f6a26ff930e636ed375f4c2ea66e9f6b71d0ce', // RENDER/USD (RNDR)
    HNT: '0x649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756', // HNT/USD
    RAY: '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a', // RAY/USD
    ORCA: '0x37505261e557e251290b8c8899453064e8d760ed5c65a779f8c9fda5b914f57c', // ORCA/USD (Note: may not be available)

    // Additional tokens that may not have Pyth feeds - will fallback to mock
    BLZE: '', // No Pyth feed
    MNDE: '', // No Pyth feed
    SHDW: '', // No Pyth feed
};

// Get all valid feed IDs (non-empty)
export function getValidFeedIds(): string[] {
    return Object.values(PYTH_FEED_IDS).filter((id) => id.length > 0);
}

// Get feed ID for a symbol
export function getFeedIdForSymbol(symbol: string): string | null {
    const feedId = PYTH_FEED_IDS[symbol.toUpperCase()];
    return feedId && feedId.length > 0 ? feedId : null;
}

// Map feed ID back to symbol
export function getSymbolForFeedId(feedId: string): string | null {
    for (const [symbol, id] of Object.entries(PYTH_FEED_IDS)) {
        if (id === feedId) return symbol;
    }
    return null;
}

export interface PythPrice {
    symbol: string;
    price: number;
    confidence: number;
    publishTime: number;
    expo: number;
}

// Create Hermes client singleton
let hermesClient: HermesClient | null = null;

function getHermesClient(): HermesClient {
    if (!hermesClient) {
        hermesClient = new HermesClient(HERMES_ENDPOINT, {});
    }
    return hermesClient;
}

/**
 * Fetch latest prices from Pyth Hermes API
 * @param symbols Array of token symbols to fetch prices for
 * @returns Map of symbol to price data
 */
export async function fetchPythPrices(symbols: string[]): Promise<Map<string, PythPrice>> {
    const prices = new Map<string, PythPrice>();

    // Get feed IDs for requested symbols
    const feedIdToSymbol = new Map<string, string>();
    const feedIds: string[] = [];

    for (const symbol of symbols) {
        const feedId = getFeedIdForSymbol(symbol);
        if (feedId) {
            feedIds.push(feedId);
            feedIdToSymbol.set(feedId, symbol);
        }
    }

    if (feedIds.length === 0) {
        return prices;
    }

    try {
        const client = getHermesClient();
        const priceUpdates = await client.getLatestPriceUpdates(feedIds, {
            parsed: true,
            ignoreInvalidPriceIds: true,
        });

        if (priceUpdates?.parsed) {
            for (const update of priceUpdates.parsed) {
                const feedId = update.id.startsWith('0x') ? update.id : '0x' + update.id;
                const symbol = feedIdToSymbol.get(feedId);

                if (symbol && update.price) {
                    // Price is returned as a string with an exponent
                    // e.g., price = "9700000000", expo = -8 means $97,000.00
                    const priceValue = parseFloat(update.price.price);
                    const expo = update.price.expo;
                    const actualPrice = priceValue * Math.pow(10, expo);

                    const confidence = parseFloat(update.price.conf) * Math.pow(10, expo);

                    prices.set(symbol, {
                        symbol,
                        price: actualPrice,
                        confidence,
                        publishTime: update.price.publish_time,
                        expo,
                    });

                    // Also set for wrapped variants
                    if (symbol === 'BTC') prices.set('WBTC', prices.get(symbol)!);
                    if (symbol === 'ETH') prices.set('WETH', prices.get(symbol)!);
                }
            }
        }
    } catch (error) {
        console.error('Failed to fetch Pyth prices:', error);
    }

    return prices;
}

/**
 * Fetch a single price from Pyth
 */
export async function fetchPythPrice(symbol: string): Promise<PythPrice | null> {
    const prices = await fetchPythPrices([symbol]);
    return prices.get(symbol) || null;
}

/**
 * Subscribe to real-time price updates via polling
 * Note: SSE streaming is available but has TypeScript compatibility issues
 * This implementation uses polling as a reliable alternative
 * @param symbols Array of token symbols to subscribe to
 * @param onUpdate Callback for price updates
 * @param intervalMs Polling interval in milliseconds (default 5000)
 * @returns Cleanup function to stop polling
 */
export function subscribeToPythPrices(
    symbols: string[],
    onUpdate: (prices: Map<string, PythPrice>) => void,
    intervalMs: number = 5000
): () => void {
    let isRunning = true;
    let timeoutId: NodeJS.Timeout | null = null;

    const poll = async () => {
        if (!isRunning) return;

        try {
            const prices = await fetchPythPrices(symbols);
            if (isRunning && prices.size > 0) {
                onUpdate(prices);
            }
        } catch (error) {
            console.error('Pyth polling error:', error);
        }

        if (isRunning) {
            timeoutId = setTimeout(poll, intervalMs);
        }
    };

    // Start polling
    poll();

    return () => {
        isRunning = false;
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    };
}

/**
 * Format price with appropriate precision
 */
export function formatPythPrice(price: number): string {
    if (price >= 1000) {
        return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    } else if (price >= 1) {
        return price.toFixed(2);
    } else if (price >= 0.01) {
        return price.toFixed(4);
    } else {
        return price.toFixed(8);
    }
}
