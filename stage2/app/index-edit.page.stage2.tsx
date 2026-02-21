'use client';

import { useEffect, useState, use, useMemo, useCallback } from 'react';
import { useIndexProtocol } from '@/hooks/useIndexProtocol';
import { PublicKey } from '@solana/web3.js';
import TOKEN_REGISTRY from '@/utils/token-registry.json';
import {
    calculateDrift,
    getMaxDrift,
    formatUsd,
    percentageToUnits,
    AllocationItem,
    DriftItem,
    MOCK_PRICES,
} from '@/utils/prices';
import { usePythPrices, getPriceFromMap } from '@/hooks/usePythPrices';
import {
    Loader2,
    Save,
    ArrowLeft,
    Plus,
    X,
    AlertTriangle,
    TrendingUp,
    TrendingDown,
    Minus,
    ArrowRight,
    Check,
    RefreshCw,
    Radio,
} from 'lucide-react';
import Link from 'next/link';
import { STAGE1_ENABLE_REBALANCE, STAGE1_MAX_ASSETS } from '@/utils/protocol';

interface AssetComponent {
    mint: string;
    units: number;
    symbol: string;
}

interface ConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    currentAllocations: AllocationItem[];
    targetAllocations: AllocationItem[];
    driftItems: DriftItem[];
    loading: boolean;
}

function ConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    currentAllocations,
    targetAllocations,
    driftItems,
    loading,
}: ConfirmationModalProps) {
    if (!isOpen) return null;

    const totalCurrentValue = currentAllocations.reduce((sum, a) => sum + a.usdValue, 0);
    const totalTargetValue = targetAllocations.reduce((sum, a) => sum + a.usdValue, 0);

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="p-6 border-b border-zinc-800">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <RefreshCw size={20} className="text-indigo-400" />
                        Confirm Rebalancing
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        Review the changes before updating the index composition
                    </p>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                    {/* Summary Stats */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-zinc-950 rounded-xl p-4 border border-zinc-800">
                            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Current NAV</div>
                            <div className="text-xl font-mono text-white">{formatUsd(totalCurrentValue)}</div>
                        </div>
                        <div className="bg-zinc-950 rounded-xl p-4 border border-zinc-800">
                            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">New NAV</div>
                            <div className="text-xl font-mono text-white">{formatUsd(totalTargetValue)}</div>
                        </div>
                    </div>

                    {/* Changes Table */}
                    <div>
                        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                            Allocation Changes
                        </h3>
                        <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-zinc-800">
                                        <th className="text-left text-xs text-zinc-500 font-medium p-3">Asset</th>
                                        <th className="text-right text-xs text-zinc-500 font-medium p-3">Current</th>
                                        <th className="text-center text-xs text-zinc-500 font-medium p-3"></th>
                                        <th className="text-right text-xs text-zinc-500 font-medium p-3">New</th>
                                        <th className="text-right text-xs text-zinc-500 font-medium p-3">Change</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {driftItems.map((item) => {
                                        const isAdded = item.currentPercentage === 0 && item.targetPercentage > 0;
                                        const isRemoved = item.currentPercentage > 0 && item.targetPercentage === 0;
                                        const change = item.targetPercentage - item.currentPercentage;

                                        return (
                                            <tr key={item.symbol} className="border-b border-zinc-800/50 last:border-0">
                                                <td className="p-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className="size-6 bg-zinc-800 rounded-full flex items-center justify-center text-xs font-bold">
                                                            {item.symbol[0]}
                                                        </div>
                                                        <span className="text-white font-medium">{item.symbol}</span>
                                                        {isAdded && (
                                                            <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                                                                NEW
                                                            </span>
                                                        )}
                                                        {isRemoved && (
                                                            <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">
                                                                REMOVED
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="p-3 text-right font-mono text-zinc-400">
                                                    {item.currentPercentage.toFixed(1)}%
                                                </td>
                                                <td className="p-3 text-center">
                                                    <ArrowRight size={14} className="text-zinc-600 mx-auto" />
                                                </td>
                                                <td className="p-3 text-right font-mono text-white">
                                                    {item.targetPercentage.toFixed(1)}%
                                                </td>
                                                <td className="p-3 text-right">
                                                    <span
                                                        className={`font-mono text-sm ${
                                                            change > 0
                                                                ? 'text-green-400'
                                                                : change < 0
                                                                ? 'text-red-400'
                                                                : 'text-zinc-500'
                                                        }`}
                                                    >
                                                        {change > 0 ? '+' : ''}
                                                        {change.toFixed(1)}%
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Warning */}
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-3">
                        <AlertTriangle className="text-amber-400 shrink-0 mt-0.5" size={18} />
                        <div className="text-sm text-amber-300">
                            <strong className="block mb-1">Important Notice</strong>
                            <p className="text-amber-300/80">
                                This will update the target weights for the index. Future mints and redeems will use the
                                new composition. Existing vault contents will not be automatically rebalanced.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-zinc-800 flex gap-3">
                    <button
                        onClick={onClose}
                        disabled={loading}
                        className="flex-1 py-3 rounded-xl font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={loading}
                        className="flex-1 py-3 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-500 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading ? (
                            <>
                                <Loader2 className="animate-spin" size={18} />
                                Updating...
                            </>
                        ) : (
                            <>
                                <Check size={18} />
                                Confirm Update
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

function DriftIndicator({ drift }: { drift: number }) {
    const absDrift = Math.abs(drift);
    const isOverweight = drift > 0;

    if (absDrift < 0.5) {
        return (
            <span className="flex items-center gap-1 text-zinc-500 text-xs">
                <Minus size={12} />
                On target
            </span>
        );
    }

    return (
        <span
            className={`flex items-center gap-1 text-xs ${
                isOverweight ? 'text-amber-400' : 'text-blue-400'
            }`}
        >
            {isOverweight ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {isOverweight ? 'Overweight' : 'Underweight'} {absDrift.toFixed(1)}%
        </span>
    );
}

function AllocationBar({ percentage, color }: { percentage: number; color: string }) {
    return (
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
                className={`h-full ${color} transition-all duration-300`}
                style={{ width: `${Math.min(percentage, 100)}%` }}
            />
        </div>
    );
}

// Hydration-safe live indicator component
function LiveIndicator({ isLive }: { isLive: boolean }) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted || !isLive) return null;

    return (
        <span className="inline-flex items-center gap-1 text-green-400">
            <Radio size={10} className="animate-pulse" />
            <span className="text-[10px]">LIVE</span>
        </span>
    );
}

// Hydration-safe number formatter
function FormattedNumber({ value }: { value: number }) {
    const [formatted, setFormatted] = useState<string>(value.toString());

    useEffect(() => {
        setFormatted(value.toLocaleString());
    }, [value]);

    return <>{formatted}</>;
}

interface AssetRowProps {
    asset: AssetComponent;
    index: number;
    inputMode: 'percentage' | 'units';
    percentage: number;
    price: number;
    drift: number;
    onAssetChange: (index: number, field: 'mint' | 'units' | 'percentage', value: string | number) => void;
    onRemove: (index: number) => void;
    assets: AssetComponent[];
    priceSource: 'pyth' | 'jupiter' | 'mock';
}

function AssetRow({ asset, index, inputMode, percentage, price, drift, onAssetChange, onRemove, assets, priceSource }: AssetRowProps) {
    const [localPercentage, setLocalPercentage] = useState<string>(percentage.toFixed(1));
    const [localUnits, setLocalUnits] = useState<string>(asset.units.toString());
    const [isFocused, setIsFocused] = useState(false);

    // Update local state when percentage changes externally (but not while focused)
    useEffect(() => {
        if (!isFocused) {
            setLocalPercentage(percentage.toFixed(1));
        }
    }, [percentage, isFocused]);

    // Update local units when asset.units changes externally (but not while focused)
    useEffect(() => {
        if (!isFocused) {
            setLocalUnits(asset.units.toString());
        }
    }, [asset.units, isFocused]);

    const handlePercentageChange = (value: string) => {
        setLocalPercentage(value);
        const numValue = parseFloat(value);
        if (!isNaN(numValue) && numValue >= 0) {
            onAssetChange(index, 'percentage', numValue);
        }
    };

    const handleUnitsChange = (value: string) => {
        setLocalUnits(value);
        const numValue = parseInt(value, 10);
        if (!isNaN(numValue) && numValue >= 0) {
            onAssetChange(index, 'units', numValue);
        }
    };

    const handleBlur = () => {
        setIsFocused(false);
        // Normalize the display value on blur
        if (inputMode === 'percentage') {
            const numValue = parseFloat(localPercentage);
            if (!isNaN(numValue)) {
                setLocalPercentage(numValue.toFixed(1));
            } else {
                setLocalPercentage(percentage.toFixed(1));
            }
        } else {
            const numValue = parseInt(localUnits, 10);
            if (isNaN(numValue) || numValue < 1) {
                setLocalUnits(asset.units.toString());
            }
        }
    };

    return (
        <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-4">
                {/* Token Selector */}
                <div className="flex-1">
                    <label className="text-xs text-zinc-500 mb-1 block">Token</label>
                    <select
                        value={asset.mint}
                        onChange={(e) => onAssetChange(index, 'mint', e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-indigo-500"
                    >
                        {TOKEN_REGISTRY.map((t) => (
                            <option
                                key={t.mint}
                                value={t.mint}
                                disabled={assets.some((a) => a.mint === t.mint && a.mint !== asset.mint)}
                            >
                                {t.symbol} - {t.name}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Input (Percentage or Units) */}
                <div className="w-32">
                    <label className="text-xs text-zinc-500 mb-1 block">
                        {inputMode === 'percentage' ? 'Allocation %' : 'Units'}
                    </label>
                    {inputMode === 'percentage' ? (
                        <div className="relative">
                            <input
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                value={localPercentage}
                                onChange={(e) => handlePercentageChange(e.target.value)}
                                onFocus={() => setIsFocused(true)}
                                onBlur={handleBlur}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-right pr-8 focus:outline-none focus:border-indigo-500"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500">
                                %
                            </span>
                        </div>
                    ) : (
                        <input
                            type="number"
                            min="1"
                            value={localUnits}
                            onChange={(e) => handleUnitsChange(e.target.value)}
                            onFocus={() => setIsFocused(true)}
                            onBlur={handleBlur}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-right focus:outline-none focus:border-indigo-500"
                        />
                    )}
                </div>

                {/* Remove Button */}
                <button
                    onClick={() => onRemove(index)}
                    className="p-2 text-zinc-500 hover:text-red-400 transition-colors mt-5"
                >
                    <X size={18} />
                </button>
            </div>

            {/* Asset Info Row */}
            <div className="flex items-center justify-between text-xs text-zinc-500 pt-2 border-t border-zinc-800/50">
                <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1">
                        Price: {formatUsd(price)}
                        {priceSource === 'pyth' ? (
                            <span className="inline-flex items-center gap-0.5 text-green-400" title="Live price from Pyth">
                                <Radio size={10} className="animate-pulse" />
                            </span>
                        ) : priceSource === 'jupiter' ? (
                            <span className="text-sky-400" title="Jupiter quote price">(jup)</span>
                        ) : (
                            <span className="text-zinc-600" title="Mock price">(mock)</span>
                        )}
                    </span>
                    <span>Units: <FormattedNumber value={asset.units} /></span>
                </div>
                <DriftIndicator drift={drift} />
            </div>
        </div>
    );
}

export default function EditIndexPage({ params }: { params: Promise<{ address: string }> }) {
    const { address } = use(params);
    const { program, wallet } = useIndexProtocol();
    const [indexConfig, setIndexConfig] = useState<any>(null);
    const [originalAssets, setOriginalAssets] = useState<AssetComponent[]>([]);
    const [assets, setAssets] = useState<AssetComponent[]>([]);
    const [loading, setLoading] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [inputMode, setInputMode] = useState<'percentage' | 'units'>('percentage');

    // Reference portfolio value for percentage calculations (per share)
    const REFERENCE_VALUE = 100; // $100 per share

    // Get all unique symbols for price fetching
    const allSymbols = useMemo(() => {
        const symbols = new Set<string>();
        assets.forEach((a) => symbols.add(a.symbol));
        originalAssets.forEach((a) => symbols.add(a.symbol));
        TOKEN_REGISTRY.forEach((t) => symbols.add(t.symbol));
        return Array.from(symbols);
    }, [assets, originalAssets]);

    // Fetch live prices from Pyth
    const { prices: livePrices, isLoading: pricesLoading, lastUpdated } = usePythPrices({
        symbols: allSymbols,
        refreshInterval: 15000, // Refresh every 15 seconds
    });

    const symbolsNeedingLivePrices = useMemo(() => {
        const symbols = new Set<string>();
        assets.forEach((a) => symbols.add(a.symbol));
        originalAssets.forEach((a) => symbols.add(a.symbol));
        return Array.from(symbols);
    }, [assets, originalAssets]);

    const hasMissingLivePrice = useMemo(() => {
        if (symbolsNeedingLivePrices.length === 0) return false;
        return symbolsNeedingLivePrices.some(
            (symbol) => (livePrices.get(symbol)?.source || 'mock') === 'mock'
        );
    }, [symbolsNeedingLivePrices, livePrices]);

    // Helper to get price (from Pyth or fallback to mock)
    const getPrice = useCallback(
        (symbol: string): number => {
            return getPriceFromMap(livePrices, symbol);
        },
        [livePrices]
    );

    useEffect(() => {
        if (!program || !address || !wallet) return;
        const fetchConfig = async () => {
            try {
                const indexMint = new PublicKey(address);
                const [pda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('index_config'), indexMint.toBuffer()],
                    program.programId
                );
                const acc = await program.account.indexConfig.fetch(pda);
                setIndexConfig({ publicKey: pda, account: acc, indexMint });

                // Convert from on-chain format with symbol lookup
                const currentAssets = (acc.assets as any[]).map((a) => {
                    const mintStr = a.mint.toBase58();
                    const token = TOKEN_REGISTRY.find((t) => t.mint === mintStr);
                    return {
                        mint: mintStr,
                        units: a.units.toNumber(),
                        symbol: token?.symbol || 'UNKNOWN',
                    };
                });
                setAssets(currentAssets);
                setOriginalAssets(currentAssets);

                // Check if connected wallet is admin
                setIsAdmin(acc.admin.toBase58() === wallet.publicKey.toBase58());
            } catch (e) {
                console.error('Failed to load index', e);
            }
        };
        fetchConfig();
    }, [program, address, wallet]);

    // Calculate allocations with live prices
    const calculateAllocationsWithPrices = useCallback(
        (assetList: AssetComponent[]): AllocationItem[] => {
            const totalValue = assetList.reduce((sum, asset) => {
                const price = getPrice(asset.symbol);
                const humanAmount = asset.units / Math.pow(10, 6);
                return sum + humanAmount * price;
            }, 0);

            return assetList.map((asset) => {
                const price = getPrice(asset.symbol);
                const humanAmount = asset.units / Math.pow(10, 6);
                const usdValue = humanAmount * price;
                return {
                    symbol: asset.symbol,
                    mint: asset.mint,
                    units: asset.units,
                    usdValue,
                    percentage: totalValue > 0 ? (usdValue / totalValue) * 100 : 0,
                    price,
                };
            });
        },
        [getPrice]
    );

    const currentAllocations = useMemo(() => {
        return calculateAllocationsWithPrices(originalAssets);
    }, [originalAssets, calculateAllocationsWithPrices]);

    const targetAllocations = useMemo(() => {
        return calculateAllocationsWithPrices(assets);
    }, [assets, calculateAllocationsWithPrices]);

    const driftItems = useMemo(() => {
        return calculateDrift(currentAllocations, targetAllocations);
    }, [currentAllocations, targetAllocations]);

    const maxDrift = useMemo(() => getMaxDrift(driftItems), [driftItems]);
    const hasChanges = useMemo(() => {
        if (originalAssets.length !== assets.length) return true;
        return assets.some((a, i) => {
            const orig = originalAssets[i];
            return !orig || orig.mint !== a.mint || orig.units !== a.units;
        });
    }, [originalAssets, assets]);

    const totalCurrentValue = useMemo(() => {
        return currentAllocations.reduce((sum, a) => sum + a.usdValue, 0);
    }, [currentAllocations]);

    const totalTargetValue = useMemo(() => {
        return targetAllocations.reduce((sum, a) => sum + a.usdValue, 0);
    }, [targetAllocations]);

    // Helper to convert percentage to units with live prices
    const percentageToUnitsWithPrice = useCallback(
        (percentage: number, symbol: string): number => {
            const price = getPrice(symbol);
            if (price === 0) return 0;
            const usdAllocation = (percentage / 100) * REFERENCE_VALUE;
            const humanAmount = usdAllocation / price;
            return Math.round(humanAmount * Math.pow(10, 6));
        },
        [getPrice]
    );

    const handleAddAsset = () => {
        if (assets.length >= STAGE1_MAX_ASSETS) return;
        const availableToken = TOKEN_REGISTRY.find((t) => !assets.some((a) => a.mint === t.mint));
        if (availableToken) {
            // Default to equal weight
            const equalPercentage = 100 / (assets.length + 1);
            const defaultUnits = percentageToUnitsWithPrice(equalPercentage, availableToken.symbol);
            setAssets([...assets, { mint: availableToken.mint, units: defaultUnits, symbol: availableToken.symbol }]);
        }
    };

    const handleRemoveAsset = (index: number) => {
        setAssets(assets.filter((_, i) => i !== index));
    };

    const handleAssetChange = (index: number, field: 'mint' | 'units' | 'percentage', value: string | number) => {
        const updated = [...assets];
        if (field === 'mint') {
            const newToken = TOKEN_REGISTRY.find((t) => t.mint === value);
            updated[index].mint = value as string;
            updated[index].symbol = newToken?.symbol || 'UNKNOWN';
        } else if (field === 'units') {
            updated[index].units = Number(value);
        } else if (field === 'percentage') {
            // Convert percentage to units using live prices
            const percentage = Number(value);
            const newUnits = percentageToUnitsWithPrice(percentage, updated[index].symbol);
            updated[index].units = newUnits;
        }
        setAssets(updated);
    };

    const handleSave = async () => {
        if (!program || !wallet || !indexConfig) return;
        if (hasMissingLivePrice) {
            alert('Missing live prices for one or more assets. Rebalancing is disabled.');
            return;
        }
        setLoading(true);

        try {
            alert('Stage 1 static contract does not support rebalancing.');
        } catch (err) {
            console.error('Failed to update:', err);
            alert('Failed to update index. Check console.');
        } finally {
            setLoading(false);
            setShowConfirmModal(false);
        }
    };

    const getAssetPercentage = (asset: AssetComponent): number => {
        const allocation = targetAllocations.find((a) => a.mint === asset.mint);
        return allocation?.percentage ?? 0;
    };

    if (!indexConfig) {
        return (
            <div className="flex items-center justify-center min-h-[50vh]">
                <Loader2 className="animate-spin h-8 w-8 text-indigo-500" />
            </div>
        );
    }

    if (!STAGE1_ENABLE_REBALANCE) {
        return (
            <div className="max-w-2xl mx-auto text-center py-20">
                <h1 className="text-2xl font-bold text-white mb-4">Rebalancing Disabled</h1>
                <p className="text-zinc-400 mb-6">
                    Rebalancing is a Stage 2 feature. Stage 1 indexes are static.
                </p>
                <Link href={`/index/${address}`} className="text-indigo-400 hover:underline">
                    &larr; Back to Index
                </Link>
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="max-w-2xl mx-auto text-center py-20">
                <h1 className="text-2xl font-bold text-white mb-4">Access Denied</h1>
                <p className="text-zinc-400 mb-6">Only the index creator can edit this fund.</p>
                <Link href={`/index/${address}`} className="text-indigo-400 hover:underline">
                    &larr; Back to Index
                </Link>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Link
                        href={`/index/${address}`}
                        className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
                    >
                        <ArrowLeft size={20} />
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold text-white">Rebalance Index</h1>
                        <p className="text-sm text-zinc-500 font-mono">{address.slice(0, 8)}...</p>
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider flex items-center justify-end gap-2">
                        Current NAV / Share
                        <LiveIndicator isLive={!pricesLoading && !!lastUpdated} />
                    </div>
                    <div className="text-xl font-mono text-green-400 font-bold">{formatUsd(totalCurrentValue)}</div>
                </div>
            </div>

            {/* Current vs Target Overview */}
            <div className="grid md:grid-cols-2 gap-6">
                {/* Current Allocation */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
                            Current Allocation
                        </h3>
                        <span className="text-xs text-zinc-500">{formatUsd(totalCurrentValue)}</span>
                    </div>
                    <div className="space-y-3">
                        {currentAllocations.map((alloc) => (
                            <div key={alloc.mint}>
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                        <div className="size-5 bg-zinc-800 rounded-full flex items-center justify-center text-[10px] font-bold">
                                            {alloc.symbol[0]}
                                        </div>
                                        <span className="text-sm text-white font-medium">{alloc.symbol}</span>
                                    </div>
                                    <span className="text-sm font-mono text-zinc-400">
                                        {alloc.percentage.toFixed(1)}%
                                    </span>
                                </div>
                                <AllocationBar percentage={alloc.percentage} color="bg-zinc-600" />
                            </div>
                        ))}
                        {currentAllocations.length === 0 && (
                            <p className="text-sm text-zinc-500 text-center py-4">No assets configured</p>
                        )}
                    </div>
                </div>

                {/* Target Allocation */}
                <div className="bg-zinc-900/50 border border-indigo-500/30 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-indigo-400 uppercase tracking-wider">
                            Target Allocation
                        </h3>
                        <span className="text-xs text-zinc-500">{formatUsd(totalTargetValue)}</span>
                    </div>
                    <div className="space-y-3">
                        {targetAllocations.map((alloc) => {
                            const driftItem = driftItems.find((d) => d.symbol === alloc.symbol);
                            const drift = driftItem ? driftItem.targetPercentage - driftItem.currentPercentage : 0;
                            return (
                                <div key={alloc.mint}>
                                    <div className="flex items-center justify-between mb-1">
                                        <div className="flex items-center gap-2">
                                            <div className="size-5 bg-indigo-500/20 rounded-full flex items-center justify-center text-[10px] font-bold text-indigo-300">
                                                {alloc.symbol[0]}
                                            </div>
                                            <span className="text-sm text-white font-medium">{alloc.symbol}</span>
                                            {Math.abs(drift) > 0.5 && (
                                                <span
                                                    className={`text-xs ${
                                                        drift > 0 ? 'text-green-400' : 'text-red-400'
                                                    }`}
                                                >
                                                    {drift > 0 ? '+' : ''}
                                                    {drift.toFixed(1)}%
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-sm font-mono text-white">
                                            {alloc.percentage.toFixed(1)}%
                                        </span>
                                    </div>
                                    <AllocationBar percentage={alloc.percentage} color="bg-indigo-500" />
                                </div>
                            );
                        })}
                        {targetAllocations.length === 0 && (
                            <p className="text-sm text-zinc-500 text-center py-4">Add assets below</p>
                        )}
                    </div>
                </div>
            </div>

            {/* Drift Summary */}
            {hasChanges && (
                <div
                    className={`rounded-xl p-4 flex items-center justify-between ${
                        maxDrift > 10
                            ? 'bg-amber-500/10 border border-amber-500/20'
                            : 'bg-indigo-500/10 border border-indigo-500/20'
                    }`}
                >
                    <div className="flex items-center gap-3">
                        <RefreshCw
                            size={20}
                            className={maxDrift > 10 ? 'text-amber-400' : 'text-indigo-400'}
                        />
                        <div>
                            <div className={`font-medium ${maxDrift > 10 ? 'text-amber-300' : 'text-indigo-300'}`}>
                                {maxDrift > 10
                                    ? 'Significant Rebalancing'
                                    : maxDrift > 5
                                    ? 'Moderate Rebalancing'
                                    : 'Minor Adjustment'}
                            </div>
                            <div className="text-xs text-zinc-400">
                                Max allocation change: {maxDrift.toFixed(1)}%
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-2xl font-mono font-bold text-white">{maxDrift.toFixed(1)}%</div>
                        <div className="text-xs text-zinc-500">Max Drift</div>
                    </div>
                </div>
            )}

            {/* Asset Editor */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-semibold text-white">Edit Composition</h3>
                        <p className="text-xs text-zinc-500 mt-1">
                            Adjust target allocations for the index
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="flex bg-zinc-800 rounded-lg p-0.5">
                            <button
                                onClick={() => setInputMode('percentage')}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                    inputMode === 'percentage'
                                        ? 'bg-indigo-600 text-white'
                                        : 'text-zinc-400 hover:text-white'
                                }`}
                            >
                                %
                            </button>
                            <button
                                onClick={() => setInputMode('units')}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                    inputMode === 'units'
                                        ? 'bg-indigo-600 text-white'
                                        : 'text-zinc-400 hover:text-white'
                                }`}
                            >
                                Units
                            </button>
                        </div>
                        <button
                            onClick={handleAddAsset}
                            disabled={assets.length >= STAGE1_MAX_ASSETS}
                            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                        >
                            <Plus size={16} />
                            Add Token
                        </button>
                    </div>
                </div>

                <div className="space-y-3">
                    {assets.map((asset, index) => {
                        const percentage = getAssetPercentage(asset);
                        const price = getPrice(asset.symbol);
                        const priceData = livePrices.get(asset.symbol);
                        const currentAlloc = currentAllocations.find((a) => a.mint === asset.mint);
                        const drift = currentAlloc ? percentage - currentAlloc.percentage : percentage;

                        return (
                            <AssetRow
                                key={`${asset.mint}-${index}`}
                                asset={asset}
                                index={index}
                                inputMode={inputMode}
                                percentage={percentage}
                                price={price}
                                drift={drift}
                                onAssetChange={handleAssetChange}
                                onRemove={handleRemoveAsset}
                                assets={assets}
                                priceSource={priceData?.source || 'mock'}
                            />
                        );
                    })}

                    {assets.length === 0 && (
                        <div className="text-center py-12 text-zinc-500">
                            <Plus size={32} className="mx-auto mb-2 opacity-50" />
                            <p>No assets configured. Add at least one token.</p>
                        </div>
                    )}
                </div>

                {/* Total Check */}
                {assets.length > 0 && (
                    <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
                        <span className="text-sm text-zinc-400">Total Allocation</span>
                        <span
                            className={`font-mono font-bold ${
                                Math.abs(targetAllocations.reduce((sum, a) => sum + a.percentage, 0) - 100) < 1
                                    ? 'text-green-400'
                                    : 'text-amber-400'
                            }`}
                        >
                            {targetAllocations.reduce((sum, a) => sum + a.percentage, 0).toFixed(1)}%
                        </span>
                    </div>
                )}
            </div>

            {hasMissingLivePrice && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
                    One or more assets only have mock pricing. Rebalancing is disabled until live prices are available.
                </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-4">
                <Link
                    href={`/index/${address}`}
                    className="flex-1 py-4 rounded-xl font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 transition-colors text-center"
                >
                    Cancel
                </Link>
                <button
                    onClick={() => setShowConfirmModal(true)}
                    disabled={loading || assets.length === 0 || !hasChanges || hasMissingLivePrice}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-2"
                >
                    <Save size={20} />
                    Review Changes
                </button>
            </div>

            {/* Confirmation Modal */}
            <ConfirmationModal
                isOpen={showConfirmModal}
                onClose={() => setShowConfirmModal(false)}
                onConfirm={handleSave}
                currentAllocations={currentAllocations}
                targetAllocations={targetAllocations}
                driftItems={driftItems}
                loading={loading}
            />
        </div>
    );
}
