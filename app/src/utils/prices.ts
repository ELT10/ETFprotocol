// Mock price service for devnet testing
// These prices are approximate and for display purposes only
// In production, integrate with Pyth or Switchboard oracle

export interface TokenPrice {
  symbol: string;
  price: number; // USD price
  change24h: number; // 24h change percentage (mocked)
}

// Devnet mock prices (approximate real-world values)
export const MOCK_PRICES: Record<string, TokenPrice> = {
  WBTC: { symbol: "WBTC", price: 97000, change24h: 2.5 },
  WETH: { symbol: "WETH", price: 3400, change24h: 1.8 },
  SOL: { symbol: "SOL", price: 195, change24h: 3.2 },
  USDC: { symbol: "USDC", price: 1, change24h: 0 },
  BONK: { symbol: "BONK", price: 0.000025, change24h: -5.2 },
  JUP: { symbol: "JUP", price: 0.95, change24h: 4.1 },
  PYTH: { symbol: "PYTH", price: 0.38, change24h: -1.3 },
  JTO: { symbol: "JTO", price: 3.20, change24h: 2.8 },
  RENDER: { symbol: "RENDER", price: 7.50, change24h: 1.5 },
  HNT: { symbol: "HNT", price: 5.80, change24h: -0.8 },
  RAY: { symbol: "RAY", price: 5.20, change24h: 6.2 },
  ORCA: { symbol: "ORCA", price: 4.10, change24h: 3.5 },
  BLZE: { symbol: "BLZE", price: 0.008, change24h: -2.1 },
  MNDE: { symbol: "MNDE", price: 0.12, change24h: 1.9 },
  SHDW: { symbol: "SHDW", price: 0.55, change24h: -0.5 },
};

// Get price for a token symbol
export function getTokenPrice(symbol: string): number {
  return MOCK_PRICES[symbol]?.price ?? 0;
}

// Get full price info for a token
export function getTokenPriceInfo(symbol: string): TokenPrice | null {
  return MOCK_PRICES[symbol] ?? null;
}

// Calculate USD value from token amount and decimals
export function calculateUsdValue(
  amount: number,
  symbol: string,
  decimals: number = 6
): number {
  const price = getTokenPrice(symbol);
  const humanAmount = amount / Math.pow(10, decimals);
  return humanAmount * price;
}

// Calculate total portfolio value
export function calculatePortfolioValue(
  assets: { symbol: string; units: number; decimals?: number }[]
): number {
  return assets.reduce((total, asset) => {
    return total + calculateUsdValue(asset.units, asset.symbol, asset.decimals ?? 6);
  }, 0);
}

// Calculate allocation percentages
export interface AllocationItem {
  symbol: string;
  mint: string;
  units: number;
  usdValue: number;
  percentage: number;
  price: number;
}

export function calculateAllocations(
  assets: { mint: string; units: number; symbol: string; decimals?: number }[]
): AllocationItem[] {
  const totalValue = calculatePortfolioValue(
    assets.map((a) => ({ symbol: a.symbol, units: a.units, decimals: a.decimals }))
  );

  if (totalValue === 0) {
    return assets.map((a) => ({
      symbol: a.symbol,
      mint: a.mint,
      units: a.units,
      usdValue: 0,
      percentage: assets.length > 0 ? 100 / assets.length : 0,
      price: getTokenPrice(a.symbol),
    }));
  }

  return assets.map((asset) => {
    const usdValue = calculateUsdValue(asset.units, asset.symbol, asset.decimals ?? 6);
    return {
      symbol: asset.symbol,
      mint: asset.mint,
      units: asset.units,
      usdValue,
      percentage: (usdValue / totalValue) * 100,
      price: getTokenPrice(asset.symbol),
    };
  });
}

// Calculate drift between current and target allocations
export interface DriftItem {
  symbol: string;
  currentPercentage: number;
  targetPercentage: number;
  drift: number; // positive = overweight, negative = underweight
  driftUsd: number; // USD amount of drift
}

export function calculateDrift(
  currentAllocations: AllocationItem[],
  targetAllocations: AllocationItem[]
): DriftItem[] {
  const currentMap = new Map(currentAllocations.map((a) => [a.symbol, a]));
  const targetMap = new Map(targetAllocations.map((a) => [a.symbol, a]));

  const allSymbols = new Set([
    ...currentAllocations.map((a) => a.symbol),
    ...targetAllocations.map((a) => a.symbol),
  ]);

  const totalCurrentValue = currentAllocations.reduce((sum, a) => sum + a.usdValue, 0);

  return Array.from(allSymbols).map((symbol) => {
    const current = currentMap.get(symbol);
    const target = targetMap.get(symbol);

    const currentPercentage = current?.percentage ?? 0;
    const targetPercentage = target?.percentage ?? 0;
    const drift = currentPercentage - targetPercentage;
    const driftUsd = (drift / 100) * totalCurrentValue;

    return {
      symbol,
      currentPercentage,
      targetPercentage,
      drift,
      driftUsd,
    };
  });
}

// Check if rebalancing is needed based on threshold
export function needsRebalancing(
  driftItems: DriftItem[],
  thresholdPercent: number = 5
): boolean {
  return driftItems.some((item) => Math.abs(item.drift) >= thresholdPercent);
}

// Get max drift from portfolio
export function getMaxDrift(driftItems: DriftItem[]): number {
  return Math.max(...driftItems.map((item) => Math.abs(item.drift)));
}

// Format USD value for display
export function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  if (value < 0.01) {
    return `$${value.toFixed(6)}`;
  }
  return `$${value.toFixed(2)}`;
}

// Format percentage for display
export function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// Convert percentage allocation to units given a target portfolio value
export function percentageToUnits(
  percentage: number,
  targetPortfolioValue: number,
  symbol: string,
  decimals: number = 6
): number {
  const price = getTokenPrice(symbol);
  if (price === 0) return 0;

  const usdAllocation = (percentage / 100) * targetPortfolioValue;
  const humanAmount = usdAllocation / price;
  return Math.round(humanAmount * Math.pow(10, decimals));
}

// Convert units to percentage given total portfolio value
export function unitsToPercentage(
  units: number,
  totalPortfolioValue: number,
  symbol: string,
  decimals: number = 6
): number {
  if (totalPortfolioValue === 0) return 0;
  const usdValue = calculateUsdValue(units, symbol, decimals);
  return (usdValue / totalPortfolioValue) * 100;
}
