'use client';

import { useEffect, useState, use, useMemo, useCallback, useRef } from 'react';
import { useIndexProtocol } from '@/hooks/useIndexProtocol';
import { useWalletMintBalances } from '@/hooks/useWalletMintBalances';
import { AccountMeta, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import {
    NATIVE_MINT,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { formatUsd } from '@/utils/prices';
import { getInvestmentRange } from '@/utils/liquidity';
import { usePythPrices, getPriceFromMap } from '@/hooks/usePythPrices';
import type { PriceData, PriceQuery } from '@/hooks/usePythPrices';
import { useTokenMetadataMap } from '@/hooks/useTokenMetadataMap';
import {
    DEFAULT_JUP_SLIPPAGE_BPS,
    JUPITER_QUICK_ROUTE_BASE_TOKENS,
    fetchJupiterQuote,
    fetchJupiterSwapTransaction,
    isLikelyNonTradableError,
} from '@/utils/jupiter';
import { buildBaseCandidateOrder } from '@/utils/jupiterQuickRoutePlanner';
import {
    Loader2,
    ArrowRightLeft,
    TrendingUp,
    Coins,
    PieChart,
    Settings,
    Radio,
    ArrowDownUp,
    Wallet,
    Zap,
    Library,
    ChevronDown,
    ExternalLink,
} from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import Link from 'next/link';
import { INDEX_SHARE_DECIMALS, STAGE1_ENABLE_REBALANCE } from '@/utils/protocol';
import { getExplorerCluster } from '@/utils/network';
import TokenAvatar from '@/components/TokenAvatar';
import type { JupiterRouteBaseSymbol } from '@/utils/jupiter';
import {
    TOKEN_2022_PROGRAM_ID_STR,
    formatToken2022ExtensionNames,
    isSupportedAssetTokenProgramOwner,
    parseUnsupportedToken2022MintExtensions,
} from '@/utils/tokenPrograms';

function LiveIndicator({ isLive }: { isLive: boolean }) {
    if (!isLive) return null;

    return (
        <span className="inline-flex items-center gap-1 text-green-400">
            <Radio size={10} className="animate-pulse" />
            <span className="text-[10px]">LIVE</span>
        </span>
    );
}

function LastUpdatedTime({ lastUpdated }: { lastUpdated: Date | null }) {
    if (!lastUpdated) return null;

    return (
        <span className="text-xs text-zinc-300/70">
            Updated {lastUpdated.toLocaleTimeString()}
        </span>
    );
}

// Colors for allocation bars
const ALLOCATION_COLORS = [
    'bg-lime-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-cyan-500',
    'bg-purple-500',
    'bg-orange-500',
];

const INDEX_SHARE_SCALE = BigInt(10) ** BigInt(INDEX_SHARE_DECIMALS);
const U64_MAX = BigInt('18446744073709551615');
const BPS_DENOMINATOR = BigInt(10_000);

function decimalToAtomic(value: string, decimals: number): bigint | null {
    const normalized = value.trim();
    if (!normalized) return null;
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    if (fractionRaw.length > decimals) return null;

    const whole = BigInt(wholeRaw || '0');
    const base = BigInt(10) ** BigInt(decimals);
    const fractionPadded = (fractionRaw + '0'.repeat(decimals)).slice(0, decimals);
    const fraction = BigInt(fractionPadded || '0');

    return whole * base + fraction;
}

function atomicToHumanString(amount: bigint, decimals: number): string {
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    if (fraction === BigInt(0)) return whole.toString();

    const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fractionPadded}`;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
    let x = a < BigInt(0) ? -a : a;
    let y = b < BigInt(0) ? -b : b;
    while (y !== BigInt(0)) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x;
}

function lcmBigInt(a: bigint, b: bigint): bigint {
    if (a === BigInt(0) || b === BigInt(0)) return BigInt(0);
    return (a / gcdBigInt(a, b)) * b;
}

function computeComponentAmountAtomic(unitsAtomic: bigint, quantityAtomic: bigint): bigint | null {
    const product = unitsAtomic * quantityAtomic;
    if (product % INDEX_SHARE_SCALE !== BigInt(0)) return null;
    return product / INDEX_SHARE_SCALE;
}

function resolveAssetTokenProgram(asset: IndexAsset): PublicKey {
    return asset.tokenProgram ?? asset.token_program ?? TOKEN_PROGRAM_ID;
}

interface WeightedAllocation {
    mint: string;
    symbol: string;
    weightScaled: bigint;
}

function allocateAtomicByWeights(totalAtomic: bigint, entries: WeightedAllocation[]): Map<string, bigint> {
    const allocations = new Map<string, bigint>();
    if (totalAtomic <= BigInt(0) || entries.length === 0) return allocations;

    const normalized = entries.map((entry) => ({
        ...entry,
        weightScaled: entry.weightScaled > BigInt(0) ? entry.weightScaled : BigInt(1),
    }));
    const weightSum = normalized.reduce((sum, entry) => sum + entry.weightScaled, BigInt(0));
    if (weightSum <= BigInt(0)) return allocations;

    let allocated = BigInt(0);
    for (const entry of normalized) {
        const value = (totalAtomic * entry.weightScaled) / weightSum;
        allocations.set(entry.mint, value);
        allocated += value;
    }

    const remainder = totalAtomic - allocated;
    if (remainder > BigInt(0)) {
        const fallbackMint = normalized[0].mint;
        allocations.set(fallbackMint, (allocations.get(fallbackMint) ?? BigInt(0)) + remainder);
    }

    return allocations;
}

function computeMintableSharesFromContributions(params: {
    contributionByMint: Map<string, bigint>;
    unitsByMint: Map<string, bigint>;
    minimumStepAtomic: bigint;
}): bigint {
    let limit: bigint | null = null;

    for (const [mint, unitsAtomic] of params.unitsByMint.entries()) {
        if (unitsAtomic <= BigInt(0)) return BigInt(0);
        const contribution = params.contributionByMint.get(mint) ?? BigInt(0);
        const candidate = (contribution * INDEX_SHARE_SCALE) / unitsAtomic;
        limit = limit === null ? candidate : candidate < limit ? candidate : limit;
    }

    if (limit === null || limit <= BigInt(0)) return BigInt(0);
    const step = params.minimumStepAtomic > BigInt(0) ? params.minimumStepAtomic : BigInt(1);
    return (limit / step) * step;
}

function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

interface LiquidityAssetInput {
    mint: string;
    symbol: string;
    weight: number;
}

interface LiquidityTokenResult {
    mint: string;
    symbol: string;
    weight: number;
    priceImpactPct: number | null;
    maxSize: number;
    effectiveMax: number;
}

interface LiquidityResponse {
    asOf: string;
    maxImpactBps: number;
    probeSizeUsdc: number;
    maxExtrapolationMultiplier: number;
    missingQuotes: string[];
    tokens: LiquidityTokenResult[];
    index: {
        maxInvestment: number;
        liquidityScore: number;
        limitingToken: LiquidityTokenResult | null;
    };
}

interface LiquidityHistoryEntry {
    date: string;
    maxInvestment: number;
    liquidityScore: number;
}

interface LiquidityAverage {
    days: number;
    maxInvestment: number;
    liquidityScore: number;
}

interface IndexAsset {
    mint: PublicKey;
    units: BN;
    tokenProgram?: PublicKey;
    token_program?: PublicKey;
}

interface IndexConfigAccountData {
    admin: PublicKey;
    creator?: PublicKey;
    name?: string;
    description?: string;
    indexMint: PublicKey;
    assets: IndexAsset[];
    paused?: boolean;
    maxAssets?: number;
    max_assets?: number;
    pendingAdmin?: PublicKey | null;
    pending_admin?: PublicKey | null;
    tradeFeeBps?: number;
    trade_fee_bps?: number;
    feeCollector?: PublicKey;
    fee_collector?: PublicKey;
    lifetimeFeeSharesTotal?: BN;
    lifetime_fee_shares_total?: BN;
}

interface IndexConfigView {
    publicKey: PublicKey;
    account: IndexConfigAccountData;
}

interface AllocationRow {
    symbol: string;
    mint: string;
    logoURI?: string;
    units: bigint;
    decimals: number;
    humanAmount: number;
    usdValue: number;
    percentage: number;
    price: number;
    source: 'pyth' | 'jupiter' | 'mock';
}

interface TradeBreakdownItem {
    mint: string;
    symbol: string;
    decimals: number;
    totalAtomic: bigint;
    human: number;
    usdValue: number;
}

interface QuoteBreakdownItem {
    mint: string;
    symbol: string;
    decimals: number;
    totalAtomic: bigint;
}

interface TradeAccounts {
    indexConfig: PublicKey;
    indexMint: PublicKey;
    user: PublicKey;
    userIndexTokenAccount: PublicKey;
    feeCollectorIndexTokenAccount: PublicKey;
    tokenProgram: PublicKey;
    token2022Program: PublicKey;
}

interface PreparedTradeContext {
    quantity: BN;
    accounts: TradeAccounts;
    issueRemainingAccounts: AccountMeta[];
    redeemRemainingAccounts: AccountMeta[];
    preInstructions: TransactionInstruction[];
}

type BuyInputTokenSymbol = JupiterRouteBaseSymbol;
type SellOutputTokenSymbol = JupiterRouteBaseSymbol;
type BuyMethod = 'single' | 'basket';
type SellMethod = 'single' | 'basket';

interface BuyInputTokenOption {
    symbol: BuyInputTokenSymbol;
    label: string;
    mint: string;
    decimals: number;
}

interface SellOutputTokenOption {
    symbol: SellOutputTokenSymbol;
    label: string;
    mint: string;
    decimals: number;
}

interface PlannedSwapLeg {
    inputMint: string;
    outputMint: string;
    inputSymbol: string;
    outputSymbol: string;
    inputAmountAtomic: string;
    contributionMint?: string;
}

interface QuickBuyRoutePlan {
    resolvedBaseSymbol: BuyInputTokenSymbol;
    resolvedBaseMint: string;
    routeSummary: string;
    swapLegs: PlannedSwapLeg[];
    componentInputByMint: Map<string, bigint>;
    directContributionByMint: Map<string, bigint>;
    estimatedSharesAtomic: string;
}

interface QuickSellRoutePlan {
    resolvedBaseSymbol: SellOutputTokenSymbol;
    resolvedBaseMint: string;
    routeSummary: string;
    swapLegs: PlannedSwapLeg[];
    estimatedOutputAtomic: string;
}

type WorkflowStepKind = 'swap-buy' | 'mint' | 'redeem' | 'swap-sell';
type WorkflowStepStatus = 'pending' | 'active' | 'done' | 'error';

interface TradeWorkflowStep {
    id: string;
    kind: WorkflowStepKind;
    label: string;
    status: WorkflowStepStatus;
    txSignature?: string;
    swapConservativeOutputAtomic?: string;
    componentMint?: string;
    componentSymbol?: string;
    componentAmountAtomic?: string;
    swapInputMint?: string;
    swapOutputMint?: string;
    swapInputSymbol?: string;
    swapOutputSymbol?: string;
    swapInputAmountAtomic?: string;
    contributionMint?: string;
}

interface WorkflowLogEntry {
    id: number;
    message: string;
    createdAt: number;
}

type ParsedWorkflowLogTone = 'info' | 'action' | 'success' | 'error';

interface ParsedWorkflowLog {
    tone: ParsedWorkflowLogTone;
    title: string;
    detail?: string;
    txUrl?: string;
}

const BUY_INPUT_TOKEN_OPTIONS: BuyInputTokenOption[] = JUPITER_QUICK_ROUTE_BASE_TOKENS.map((option) => ({
    symbol: option.symbol,
    label: option.symbol,
    mint: option.symbol === 'SOL' ? NATIVE_MINT.toBase58() : option.mint,
    decimals: option.decimals,
}));

const SELL_OUTPUT_TOKEN_OPTIONS: SellOutputTokenOption[] = BUY_INPUT_TOKEN_OPTIONS.map((option) => ({
    symbol: option.symbol,
    label: option.label,
    mint: option.mint,
    decimals: option.decimals,
}));

function toPositiveAtomicOrNull(raw: string | undefined): bigint | null {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const parsed = BigInt(raw);
    return parsed > BigInt(0) ? parsed : null;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function normalizeWorkflowLogMessage(message: string): string {
    return message
        .replace(/^🚀\s*/, '')
        .replace(/^⚡\s*/, '')
        .replace(/^✅\s*/, '')
        .replace(/^❌\s*/, '')
        .replace(/^🎉\s*/, '')
        .replace(/^↔️\s*/, '')
        .trim();
}

function shortenAddress(address: string | PublicKey | null | undefined): string {
    if (!address) return '';
    const str = address.toString();
    if (str.length <= 12) return str;
    return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

function SolscanLink({ address, cluster }: { address: string | PublicKey; cluster: string }) {
    const addrStr = address.toString();
    const url = `https://solscan.io/account/${addrStr}?cluster=${cluster}`;
    return (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-300 hover:text-white transition-colors underline decoration-white/20 underline-offset-2">
            {shortenAddress(addrStr)}
            <ExternalLink size={12} className="text-zinc-500" />
        </a>
    );
}

function extractExplorerTxUrl(message: string): { cleanedMessage: string; txUrl?: string } {
    const match = message.match(/https:\/\/explorer\.solana\.com\/tx\/[A-Za-z0-9]+(?:\?cluster=[^\s]+)?/);
    if (!match) return { cleanedMessage: message };
    const txUrl = match[0];
    const cleanedMessage = message.replace(txUrl, '').replace(/[:\s]+$/, '').trim();
    return { cleanedMessage, txUrl };
}

function parseWorkflowLog(message: string): ParsedWorkflowLog {
    const normalized = normalizeWorkflowLogMessage(message);
    const { cleanedMessage, txUrl } = extractExplorerTxUrl(normalized);
    let tone: ParsedWorkflowLogTone = 'info';

    if (message.startsWith('❌')) {
        tone = 'error';
    } else if (message.startsWith('✅') || message.startsWith('🎉')) {
        tone = 'success';
    } else if (message.startsWith('↔️') || message.startsWith('🚀')) {
        tone = 'action';
    }

    let title = cleanedMessage || 'Execution update';
    let detail: string | undefined;
    const separatorIndex = cleanedMessage.indexOf(':');
    if (separatorIndex > 0 && separatorIndex < cleanedMessage.length - 1) {
        title = cleanedMessage.slice(0, separatorIndex).trim();
        detail = cleanedMessage.slice(separatorIndex + 1).trim();
    }

    if (!detail && txUrl) {
        detail = 'Transaction confirmed on chain.';
    }

    return {
        tone,
        title,
        detail,
        txUrl,
    };
}

function formatWorkflowLogTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

const LIQUIDITY_HISTORY_DAYS = 7;
const PRICE_GATE_TIMEOUT_MS = 20_000;

function liquidityHistoryKey(address: string) {
    return `liquidity-history:${address}`;
}

function readLiquidityHistory(address: string): LiquidityHistoryEntry[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(liquidityHistoryKey(address));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry) => entry && entry.date);
    } catch {
        return [];
    }
}

function writeLiquidityHistory(address: string, entries: LiquidityHistoryEntry[]) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(liquidityHistoryKey(address), JSON.stringify(entries));
    } catch {
        // Ignore write failures (private mode, quota, etc).
    }
}

function upsertLiquidityHistory(address: string, entry: LiquidityHistoryEntry): LiquidityHistoryEntry[] {
    const history = readLiquidityHistory(address);
    const existingIndex = history.findIndex((item) => item.date === entry.date);
    const updated = [...history];
    if (existingIndex >= 0) {
        updated[existingIndex] = entry;
    } else {
        updated.push(entry);
    }
    updated.sort((a, b) => a.date.localeCompare(b.date));
    const trimmed = updated.slice(-LIQUIDITY_HISTORY_DAYS * 2);
    writeLiquidityHistory(address, trimmed);
    return trimmed;
}

function averageLiquidityHistory(entries: LiquidityHistoryEntry[], days: number): LiquidityAverage | null {
    if (!entries.length) return null;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const filtered = entries.filter((entry) => new Date(entry.date) >= cutoff);
    if (!filtered.length) return null;
    const maxInvestment = filtered.reduce((sum, entry) => sum + entry.maxInvestment, 0) / filtered.length;
    const liquidityScore = filtered.reduce((sum, entry) => sum + entry.liquidityScore, 0) / filtered.length;
    return {
        days: filtered.length,
        maxInvestment,
        liquidityScore,
    };
}

export default function IndexDetailsPage({ params }: { params: Promise<{ address: string }> }) {
    const { address } = use(params);
    const { connection } = useConnection();
    const walletAdapter = useWallet();
    const { program, wallet } = useIndexProtocol();
    const walletConnected = !!walletAdapter.publicKey;
    const {
        initialized: walletBalancesInitialized,
        loading: walletBalancesLoading,
        error: walletBalancesError,
        refresh: refreshWalletBalances,
        getMintBalanceAtomic,
    } = useWalletMintBalances();
    const programKey = program?.programId?.toBase58() ?? null;
    const programRef = useRef(program);
    const [indexConfig, setIndexConfig] = useState<IndexConfigView | null>(null);
    const [indexLoadError, setIndexLoadError] = useState<string | null>(null);
    const [amount, setAmount] = useState<string>('');
    const [quickBuySpendAmount, setQuickBuySpendAmount] = useState<string>('');
    const [mode, setMode] = useState<'buy' | 'sell'>('buy');
    const [buyMethod, setBuyMethod] = useState<BuyMethod>('single');
    const [buyInputSymbol, setBuyInputSymbol] = useState<BuyInputTokenSymbol>('USDC');
    const [sellMethod, setSellMethod] = useState<SellMethod>('single');
    const [sellOutputSymbol, setSellOutputSymbol] = useState<SellOutputTokenSymbol>('USDC');
    const [loading, setLoading] = useState(false);
    const [tradeError, setTradeError] = useState<string | null>(null);
    const [singleBuyQuoteLoading, setSingleBuyQuoteLoading] = useState(false);
    const [singleBuyQuoteError, setSingleBuyQuoteError] = useState<string | null>(null);
    const [singleBuyQuoteInputAtomic, setSingleBuyQuoteInputAtomic] = useState<string | null>(null);
    const [singleBuyEstimatedSharesAtomic, setSingleBuyEstimatedSharesAtomic] = useState<string | null>(null);
    const [singleBuyRoutePlan, setSingleBuyRoutePlan] = useState<QuickBuyRoutePlan | null>(null);
    const [singleSellQuoteLoading, setSingleSellQuoteLoading] = useState(false);
    const [singleSellQuoteError, setSingleSellQuoteError] = useState<string | null>(null);
    const [singleSellQuoteOutputAtomic, setSingleSellQuoteOutputAtomic] = useState<string | null>(null);
    const [singleSellRoutePlan, setSingleSellRoutePlan] = useState<QuickSellRoutePlan | null>(null);
    const [unsupportedAssetProgramSymbols, setUnsupportedAssetProgramSymbols] = useState<string[]>([]);
    const [assetProgramSupportLoading, setAssetProgramSupportLoading] = useState(false);
    const [logs, setLogs] = useState<WorkflowLogEntry[]>([]);
    const [tradeModalOpen, setTradeModalOpen] = useState(false);
    const [tradeWorkflowSteps, setTradeWorkflowSteps] = useState<TradeWorkflowStep[]>([]);
    const [tradeWorkflowRunning, setTradeWorkflowRunning] = useState(false);
    const [tradeWorkflowError, setTradeWorkflowError] = useState<string | null>(null);
    const [tradeWorkflowDone, setTradeWorkflowDone] = useState(false);
    const [adminLoading, setAdminLoading] = useState(false);
    const [adminError, setAdminError] = useState<string | null>(null);
    const [liquidityWeights, setLiquidityWeights] = useState<LiquidityAssetInput[] | null>(null);
    const [liquidityData, setLiquidityData] = useState<LiquidityResponse | null>(null);
    const [liquidityAvg, setLiquidityAvg] = useState<LiquidityAverage | null>(null);
    const [liquidityLoading, setLiquidityLoading] = useState(false);
    const [liquidityError, setLiquidityError] = useState<string | null>(null);
    const [priceGateStartedAtMs, setPriceGateStartedAtMs] = useState<number | null>(null);
    const [priceGateTimedOut, setPriceGateTimedOut] = useState(false);
    const [readyCoverageContextKey, setReadyCoverageContextKey] = useState<string | null>(null);
    const [lastCompletePriceMap, setLastCompletePriceMap] = useState<Map<string, PriceData>>(new Map());
    const explorerCluster = getExplorerCluster();
    const jupiterCheckoutSupported = explorerCluster === 'mainnet-beta';
    const assetMints = useMemo(
        () => (indexConfig ? indexConfig.account.assets.map((asset) => asset.mint.toBase58()) : []),
        [indexConfig]
    );
    const { tokenMap: tokenMetadataByMint } = useTokenMetadataMap(assetMints);

    useEffect(() => {
        programRef.current = program;
    }, [program]);

    const assetPriceQueries = useMemo<PriceQuery[]>(() => {
        if (!indexConfig) return [];
        return indexConfig.account.assets.map((a) => {
            const mintStr = a.mint.toBase58();
            const token = tokenMetadataByMint.get(mintStr);
            return token?.symbol ? { key: mintStr, pythSymbol: token.symbol } : { key: mintStr };
        });
    }, [indexConfig, tokenMetadataByMint]);

    // Fetch live prices from Pyth
    const { prices: livePrices, lastUpdated } = usePythPrices({
        queries: assetPriceQueries,
    });

    useEffect(() => {
        if (!address) return;
        const activeProgram = programRef.current;
        if (!activeProgram || !programKey) {
            setIndexConfig(null);
            setIndexLoadError('Connect wallet to load this index.');
            return;
        }
        setIndexLoadError(null);
        let cancelled = false;

        const fetchConfig = async () => {
            try {
                const indexMint = new PublicKey(address);
                const [pda] = PublicKey.findProgramAddressSync(
                    [Buffer.from('index_config'), indexMint.toBuffer()],
                    activeProgram.programId
                );
                const acc = (await activeProgram.account.indexConfig.fetch(pda)) as unknown as IndexConfigAccountData;
                if (!cancelled) {
                    setIndexConfig({ publicKey: pda, account: acc });
                }
            } catch (e) {
                if (!cancelled) {
                    setIndexConfig(null);
                    setIndexLoadError('Failed to load index for this address.');
                    console.error('Failed to load index', e);
                }
            }
        };
        fetchConfig();

        return () => {
            cancelled = true;
        };
    }, [programKey, address]);

    const priceGateContextKey = useMemo(() => {
        if (!indexConfig) return null;
        const mints = indexConfig.account.assets.map((asset) => asset.mint.toBase58()).sort();
        return `${address}:${mints.join(',')}`;
    }, [address, indexConfig]);

    const baseAssets = useMemo(() => {
        if (!indexConfig) return [] as Omit<AllocationRow, 'usdValue' | 'percentage' | 'price' | 'source'>[];
        return indexConfig.account.assets.map((asset) => {
            const mint = asset.mint.toBase58();
            const token = tokenMetadataByMint.get(mint);
            const decimals = token?.decimals ?? 6;
            const units = BigInt(asset.units.toString());
            const humanAmount = Number(units) / Math.pow(10, decimals);
            return {
                mint,
                symbol: token?.symbol || mint,
                logoURI: token?.logoURI,
                units,
                decimals,
                humanAmount,
            };
        });
    }, [indexConfig, tokenMetadataByMint]);

    const missingPriceAssets = useMemo(() => {
        if (!indexConfig) return [] as { mint: string; symbol: string }[];
        return baseAssets
            .map((asset) => {
                const livePrice = livePrices.get(asset.mint);
                const hasLivePrice =
                    !!livePrice &&
                    livePrice.source !== 'mock' &&
                    Number.isFinite(livePrice.price) &&
                    livePrice.price > 0;
                if (hasLivePrice) return null;
                const fallbackSymbol =
                    asset.symbol === asset.mint
                        ? `${asset.mint.slice(0, 6)}...${asset.mint.slice(-4)}`
                        : asset.symbol;
                return { mint: asset.mint, symbol: fallbackSymbol };
            })
            .filter((entry): entry is { mint: string; symbol: string } => !!entry);
    }, [indexConfig, baseAssets, livePrices]);

    const hasAllAssetPrices = useMemo(() => {
        if (!indexConfig) return false;
        const expected = indexConfig.account.assets.length;
        if (expected === 0) return false;
        return missingPriceAssets.length === 0;
    }, [indexConfig, missingPriceAssets.length]);

    const hasReachedFullPriceCoverage =
        !!priceGateContextKey && readyCoverageContextKey === priceGateContextKey;

    useEffect(() => {
        if (!priceGateContextKey || !hasAllAssetPrices) return;
        setReadyCoverageContextKey(priceGateContextKey);
        setLastCompletePriceMap(new Map(livePrices));
        setPriceGateTimedOut(false);
    }, [priceGateContextKey, hasAllAssetPrices, livePrices]);

    const effectiveLivePrices = useMemo(() => {
        if (hasReachedFullPriceCoverage && !hasAllAssetPrices && lastCompletePriceMap.size > 0) {
            return lastCompletePriceMap;
        }
        return livePrices;
    }, [hasReachedFullPriceCoverage, hasAllAssetPrices, lastCompletePriceMap, livePrices]);

    const getPrice = useCallback(
        (key: string): number => {
            return getPriceFromMap(effectiveLivePrices, key);
        },
        [effectiveLivePrices]
    );

    const allocations = useMemo<AllocationRow[]>(() => {
        if (!baseAssets.length) return [];
        const totalValue = baseAssets.reduce((sum, asset) => {
            const price = getPrice(asset.mint);
            return sum + asset.humanAmount * price;
        }, 0);

        return baseAssets.map((asset) => {
            const price = getPrice(asset.mint);
            const usdValue = asset.humanAmount * price;
            const priceData = effectiveLivePrices.get(asset.mint);
            return {
                ...asset,
                usdValue,
                percentage: totalValue > 0 ? (usdValue / totalValue) * 100 : 0,
                price,
                source: (priceData?.source || 'mock') as 'pyth' | 'jupiter' | 'mock',
            };
        });
    }, [baseAssets, getPrice, effectiveLivePrices]);

    const totalNav = useMemo(() => {
        return allocations.reduce((sum, a) => sum + a.usdValue, 0);
    }, [allocations]);

    useEffect(() => {
        if (!priceGateContextKey) {
            setPriceGateStartedAtMs(null);
            setPriceGateTimedOut(false);
            setReadyCoverageContextKey(null);
            setLastCompletePriceMap(new Map());
            return;
        }
        setPriceGateStartedAtMs(Date.now());
        setPriceGateTimedOut(false);
        setReadyCoverageContextKey(null);
        setLastCompletePriceMap(new Map());
        setLiquidityWeights(null);
        setLiquidityData(null);
        setLiquidityAvg(null);
        setLiquidityError(null);
        setLiquidityLoading(false);
    }, [priceGateContextKey]);

    const isPriceGateReady = hasAllAssetPrices || hasReachedFullPriceCoverage;

    useEffect(() => {
        if (!priceGateStartedAtMs || isPriceGateReady) {
            if (isPriceGateReady) {
                setPriceGateTimedOut(false);
            }
            return;
        }
        const elapsedMs = Date.now() - priceGateStartedAtMs;
        if (elapsedMs >= PRICE_GATE_TIMEOUT_MS) {
            setPriceGateTimedOut(true);
            return;
        }

        const timerId = window.setTimeout(() => {
            setPriceGateTimedOut(true);
        }, PRICE_GATE_TIMEOUT_MS - elapsedMs);

        return () => {
            window.clearTimeout(timerId);
        };
    }, [priceGateStartedAtMs, isPriceGateReady, missingPriceAssets.length]);

    const priceGateState: 'loading' | 'ready' | 'error' = isPriceGateReady
        ? 'ready'
        : priceGateTimedOut
          ? 'error'
          : 'loading';
    const missingPriceSymbols = useMemo(
        () => Array.from(new Set(missingPriceAssets.map((asset) => asset.symbol))),
        [missingPriceAssets]
    );
    const priceGateErrorMessage =
        missingPriceSymbols.length > 0
            ? `Missing prices for: ${missingPriceSymbols.join(', ')}`
            : 'Missing prices for one or more index assets.';

    useEffect(() => {
        if (!indexConfig || indexConfig.account.assets.length === 0) {
            setUnsupportedAssetProgramSymbols([]);
            setAssetProgramSupportLoading(false);
            return;
        }

        let cancelled = false;
        const run = async () => {
            setAssetProgramSupportLoading(true);
            try {
                const mintPubkeys = indexConfig.account.assets.map((asset) => asset.mint);
                const mintInfos = await connection.getMultipleAccountsInfo(mintPubkeys, 'confirmed');
                if (cancelled) return;
                const unsupported: string[] = [];
                mintInfos.forEach((info, idx) => {
                    if (!info) {
                        const mint = mintPubkeys[idx].toBase58();
                        const symbol = tokenMetadataByMint.get(mint)?.symbol || `${mint.slice(0, 6)}...${mint.slice(-4)}`;
                        unsupported.push(`${symbol} (mint not found)`);
                        return;
                    }
                    const mint = mintPubkeys[idx].toBase58();
                    const symbol = tokenMetadataByMint.get(mint)?.symbol || `${mint.slice(0, 6)}...${mint.slice(-4)}`;
                    const owner = info.owner.toBase58();
                    if (!isSupportedAssetTokenProgramOwner(owner)) {
                        unsupported.push(symbol);
                        return;
                    }
                    if (owner === TOKEN_2022_PROGRAM_ID_STR) {
                        try {
                            const unsupportedExtensions = parseUnsupportedToken2022MintExtensions({
                                mint: mintPubkeys[idx],
                                mintAccountInfo: info,
                            });
                            if (unsupportedExtensions.length > 0) {
                                unsupported.push(
                                    `${symbol} (${formatToken2022ExtensionNames(unsupportedExtensions)})`
                                );
                            }
                        } catch {
                            unsupported.push(`${symbol} (failed to parse Token-2022 metadata)`);
                        }
                    }
                });
                setUnsupportedAssetProgramSymbols(Array.from(new Set(unsupported)));
            } catch (err) {
                if (!cancelled) {
                    console.error('Failed to verify asset token programs', err);
                    setUnsupportedAssetProgramSymbols([]);
                }
            } finally {
                if (!cancelled) {
                    setAssetProgramSupportLoading(false);
                }
            }
        };

        void run();
        return () => {
            cancelled = true;
        };
    }, [indexConfig, connection, tokenMetadataByMint]);

    const isAdmin = useMemo(() => {
        if (!wallet || !indexConfig) return false;
        return wallet.publicKey.equals(indexConfig.account.admin);
    }, [wallet, indexConfig]);

    const isPaused = !!indexConfig?.account?.paused;
    const indexName = useMemo(() => {
        if (!indexConfig) return '';
        const name = indexConfig.account.name?.trim();
        return name && name.length > 0 ? name : `Index #${indexConfig.publicKey.toBase58().slice(0, 4)}`;
    }, [indexConfig]);
    const indexDescription = useMemo(() => {
        const description = indexConfig?.account.description?.trim();
        return description && description.length > 0 ? description : null;
    }, [indexConfig]);
    const tradeFeeBps = useMemo(
        () => Number(indexConfig?.account.tradeFeeBps ?? indexConfig?.account.trade_fee_bps ?? 0),
        [indexConfig]
    );
    const feeCollectorPubkey = useMemo(
        () => indexConfig?.account.feeCollector ?? indexConfig?.account.fee_collector ?? indexConfig?.account.admin ?? null,
        [indexConfig]
    );
    const lifetimeFeeSharesAtomic = useMemo(() => {
        const raw = indexConfig?.account.lifetimeFeeSharesTotal ?? indexConfig?.account.lifetime_fee_shares_total;
        return raw ? BigInt(raw.toString()) : BigInt(0);
    }, [indexConfig]);
    const lifetimeFeeSharesHuman = useMemo(
        () => Number(lifetimeFeeSharesAtomic) / Number(INDEX_SHARE_SCALE),
        [lifetimeFeeSharesAtomic]
    );
    const lifetimeFeeUsdEstimate = useMemo(
        () => lifetimeFeeSharesHuman * totalNav,
        [lifetimeFeeSharesHuman, totalNav]
    );

    const quantityAtomic = useMemo(() => {
        const atomic = decimalToAtomic(amount, INDEX_SHARE_DECIMALS);
        if (atomic === null || atomic <= BigInt(0) || atomic > U64_MAX) return null;
        return atomic;
    }, [amount]);
    const feeSharesAtomic = useMemo(() => {
        if (!quantityAtomic) return null;
        return (quantityAtomic * BigInt(tradeFeeBps)) / BPS_DENOMINATOR;
    }, [quantityAtomic, tradeFeeBps]);
    const userReceivesSharesAtomic = useMemo(() => {
        if (!quantityAtomic || feeSharesAtomic === null) return null;
        if (feeSharesAtomic > quantityAtomic) return null;
        return quantityAtomic - feeSharesAtomic;
    }, [quantityAtomic, feeSharesAtomic]);
    const feeSharesHuman = useMemo(
        () => (feeSharesAtomic === null ? null : atomicToHumanString(feeSharesAtomic, INDEX_SHARE_DECIMALS)),
        [feeSharesAtomic]
    );
    const userReceivesSharesHuman = useMemo(
        () => (userReceivesSharesAtomic === null ? null : atomicToHumanString(userReceivesSharesAtomic, INDEX_SHARE_DECIMALS)),
        [userReceivesSharesAtomic]
    );
    const basketQuantityAtomic = useMemo(() => {
        if (mode === 'sell') return userReceivesSharesAtomic;
        return quantityAtomic;
    }, [mode, quantityAtomic, userReceivesSharesAtomic]);

    const minimumQuantityStepAtomic = useMemo(() => {
        if (!indexConfig || indexConfig.account.assets.length === 0) return BigInt(1);
        let step = BigInt(1);
        for (const asset of indexConfig.account.assets) {
            const unitsAtomic = BigInt(asset.units.toString());
            const assetStep = INDEX_SHARE_SCALE / gcdBigInt(INDEX_SHARE_SCALE, unitsAtomic);
            step = lcmBigInt(step, assetStep);
        }
        return step;
    }, [indexConfig]);

    const minimumQuantityStepHuman = useMemo(
        () => atomicToHumanString(minimumQuantityStepAtomic, INDEX_SHARE_DECIMALS),
        [minimumQuantityStepAtomic]
    );

    const isQuantityStepValid = useMemo(() => {
        if (!quantityAtomic) return false;
        return quantityAtomic % minimumQuantityStepAtomic === BigInt(0);
    }, [quantityAtomic, minimumQuantityStepAtomic]);

    const selectedBuyInputOption = useMemo(() => {
        return BUY_INPUT_TOKEN_OPTIONS.find((option) => option.symbol === buyInputSymbol) ?? BUY_INPUT_TOKEN_OPTIONS[0];
    }, [buyInputSymbol]);

    const selectedSellOutputOption = useMemo(() => {
        return SELL_OUTPUT_TOKEN_OPTIONS.find((option) => option.symbol === sellOutputSymbol) ?? SELL_OUTPUT_TOKEN_OPTIONS[0];
    }, [sellOutputSymbol]);

    const buyInputOptionBySymbol = useMemo(() => {
        const map = new Map<BuyInputTokenSymbol, BuyInputTokenOption>();
        for (const option of BUY_INPUT_TOKEN_OPTIONS) {
            map.set(option.symbol, option);
        }
        return map;
    }, []);

    const sellOutputOptionBySymbol = useMemo(() => {
        const map = new Map<SellOutputTokenSymbol, SellOutputTokenOption>();
        for (const option of SELL_OUTPUT_TOKEN_OPTIONS) {
            map.set(option.symbol, option);
        }
        return map;
    }, []);

    const quickBuySpendAtomic = useMemo(() => {
        const atomic = decimalToAtomic(quickBuySpendAmount, selectedBuyInputOption.decimals);
        if (atomic === null || atomic <= BigInt(0) || atomic > U64_MAX) return null;
        return atomic;
    }, [quickBuySpendAmount, selectedBuyInputOption.decimals]);

    const effectiveBuyMethod: BuyMethod = mode === 'buy' && jupiterCheckoutSupported ? buyMethod : 'basket';
    const effectiveSellMethod: SellMethod = mode === 'sell' && jupiterCheckoutSupported ? sellMethod : 'basket';
    const indexMintAddress = indexConfig?.account.indexMint.toBase58() ?? null;
    const indexShareBalanceAtomic = useMemo(() => {
        if (!indexMintAddress) return BigInt(0);
        return getMintBalanceAtomic(indexMintAddress);
    }, [indexMintAddress, getMintBalanceAtomic]);
    const indexShareBalanceHuman = useMemo(
        () => atomicToHumanString(indexShareBalanceAtomic, INDEX_SHARE_DECIMALS),
        [indexShareBalanceAtomic]
    );
    const selectedBuyInputBalanceAtomic = useMemo(
        () => getMintBalanceAtomic(selectedBuyInputOption.mint),
        [selectedBuyInputOption.mint, getMintBalanceAtomic]
    );
    const selectedBuyInputBalanceHuman = useMemo(
        () => atomicToHumanString(selectedBuyInputBalanceAtomic, selectedBuyInputOption.decimals),
        [selectedBuyInputBalanceAtomic, selectedBuyInputOption.decimals]
    );
    const selectedSellOutputBalanceAtomic = useMemo(
        () => getMintBalanceAtomic(selectedSellOutputOption.mint),
        [selectedSellOutputOption.mint, getMintBalanceAtomic]
    );
    const selectedSellOutputBalanceHuman = useMemo(
        () => atomicToHumanString(selectedSellOutputBalanceAtomic, selectedSellOutputOption.decimals),
        [selectedSellOutputBalanceAtomic, selectedSellOutputOption.decimals]
    );

    const unitsByMint = useMemo(() => {
        const map = new Map<string, bigint>();
        if (!indexConfig) return map;
        for (const asset of indexConfig.account.assets) {
            map.set(asset.mint.toBase58(), BigInt(asset.units.toString()));
        }
        return map;
    }, [indexConfig]);

    const quickBuyWeightEntries = useMemo<WeightedAllocation[]>(() => {
        if (!indexConfig) return [];
        return indexConfig.account.assets.map((asset) => {
            const mint = asset.mint.toBase58();
            const allocation = allocations.find((row) => row.mint === mint);
            const usdWeight = allocation?.usdValue ?? 0;
            const scaled = BigInt(Math.max(1, Math.floor(usdWeight * 1_000_000)));
            const token = tokenMetadataByMint.get(mint);
            return {
                mint,
                symbol: token?.symbol || mint,
                weightScaled: scaled,
            };
        });
    }, [indexConfig, allocations, tokenMetadataByMint]);

    const quoteBreakdown = useMemo<QuoteBreakdownItem[]>(() => {
        if (!indexConfig || !basketQuantityAtomic || !isQuantityStepValid) return [];
        const items: QuoteBreakdownItem[] = [];
        for (const asset of indexConfig.account.assets) {
            const mint = asset.mint.toBase58();
            const token = tokenMetadataByMint.get(mint);
            const decimals = token?.decimals ?? 6;
            const unitsAtomic = BigInt(asset.units.toString());
            const totalAtomic = computeComponentAmountAtomic(unitsAtomic, basketQuantityAtomic);
            if (totalAtomic === null) return [];
            const symbol = token?.symbol || mint;
            items.push({
                mint,
                symbol,
                decimals,
                totalAtomic,
            });
        }
        return items;
    }, [indexConfig, tokenMetadataByMint, basketQuantityAtomic, isQuantityStepValid]);

    const tradeBreakdown = useMemo<TradeBreakdownItem[]>(() => {
        return quoteBreakdown.map((item) => {
            const human = Number(item.totalAtomic) / Math.pow(10, item.decimals);
            return {
                ...item,
                human,
                usdValue: human * getPrice(item.mint),
            };
        });
    }, [quoteBreakdown, getPrice]);

    const estimatedTradeUsd = useMemo(() => {
        return tradeBreakdown.reduce((sum, item) => sum + item.usdValue, 0);
    }, [tradeBreakdown]);

    const effectiveEstimatedTradeUsd = useMemo(() => {
        if (mode === 'buy' && effectiveBuyMethod === 'single' && quickBuySpendAtomic) {
            const spendHuman = Number(quickBuySpendAtomic) / Math.pow(10, selectedBuyInputOption.decimals);
            const spendPrice = selectedBuyInputOption.symbol === 'SOL' ? getPrice('SOL') : 1;
            return spendHuman * spendPrice;
        }
        return estimatedTradeUsd;
    }, [
        mode,
        effectiveBuyMethod,
        quickBuySpendAtomic,
        selectedBuyInputOption.decimals,
        selectedBuyInputOption.symbol,
        getPrice,
        estimatedTradeUsd,
    ]);

    const estimatedSingleBuyInputAmount = useMemo(() => {
        if (!singleBuyQuoteInputAtomic) return null;
        const amountAtomic = BigInt(singleBuyQuoteInputAtomic);
        return atomicToHumanString(amountAtomic, selectedBuyInputOption.decimals);
    }, [singleBuyQuoteInputAtomic, selectedBuyInputOption.decimals]);

    const estimatedSingleBuySharesAmount = useMemo(() => {
        if (!singleBuyEstimatedSharesAtomic) return null;
        const sharesAtomic = BigInt(singleBuyEstimatedSharesAtomic);
        return atomicToHumanString(sharesAtomic, INDEX_SHARE_DECIMALS);
    }, [singleBuyEstimatedSharesAtomic]);

    const estimatedSingleSellOutputAmount = useMemo(() => {
        if (!singleSellQuoteOutputAtomic) return null;
        const amountAtomic = BigInt(singleSellQuoteOutputAtomic);
        return atomicToHumanString(amountAtomic, selectedSellOutputOption.decimals);
    }, [singleSellQuoteOutputAtomic, selectedSellOutputOption.decimals]);
    const hasInsufficientIndexShares = useMemo(() => {
        if (mode !== 'sell' || !walletBalancesInitialized || !quantityAtomic) return false;
        return quantityAtomic > indexShareBalanceAtomic;
    }, [mode, walletBalancesInitialized, quantityAtomic, indexShareBalanceAtomic]);
    const hasInsufficientQuickBuyInput = useMemo(() => {
        if (mode !== 'buy' || effectiveBuyMethod !== 'single' || !walletBalancesInitialized || !quickBuySpendAtomic) {
            return false;
        }
        return quickBuySpendAtomic > selectedBuyInputBalanceAtomic;
    }, [
        mode,
        effectiveBuyMethod,
        walletBalancesInitialized,
        quickBuySpendAtomic,
        selectedBuyInputBalanceAtomic,
    ]);
    const hasUnsupportedAssetTokenPrograms = unsupportedAssetProgramSymbols.length > 0;
    const isQuickBuyRouteBlocked = useMemo(() => {
        if (mode !== 'buy' || buyMethod !== 'single' || !jupiterCheckoutSupported || !singleBuyQuoteError) {
            return false;
        }
        return isLikelyNonTradableError(singleBuyQuoteError);
    }, [mode, buyMethod, jupiterCheckoutSupported, singleBuyQuoteError]);
    const isQuickSellRouteBlocked = useMemo(() => {
        if (mode !== 'sell' || sellMethod !== 'single' || !jupiterCheckoutSupported || !singleSellQuoteError) {
            return false;
        }
        return isLikelyNonTradableError(singleSellQuoteError);
    }, [mode, sellMethod, jupiterCheckoutSupported, singleSellQuoteError]);
    const isQuickRouteBlocked = mode === 'buy' ? isQuickBuyRouteBlocked : isQuickSellRouteBlocked;
    const quickRouteBlockedTitle = mode === 'buy' ? 'Quick Buy unavailable' : 'Quick Exit unavailable';
    const quickRouteBlockedMessage = mode === 'buy' ? singleBuyQuoteError : singleSellQuoteError;
    const quickRouteBlockedActionLabel = mode === 'buy' ? 'Switch to Basket Deposit' : 'Switch to Basket Withdraw';
    const quickMethodSelected = mode === 'buy' ? buyMethod === 'single' : sellMethod === 'single';
    const activeQuickRouteSummary = mode === 'buy' ? singleBuyRoutePlan?.routeSummary : singleSellRoutePlan?.routeSummary;
    const routeDescription =
        mode === 'buy'
            ? buyMethod === 'single'
                ? 'Quick Buy spends one token (ExactIn), auto-selects a valid base lane, swaps into basket components, then mints the maximum shares available.'
                : 'Basket Deposit mints by supplying each basket token directly.'
            : sellMethod === 'single'
              ? 'Quick Exit redeems to basket tokens, auto-selects a valid base lane, then swaps into one token.'
              : 'Basket Withdraw redeems and returns each basket token directly.';
    const quickTokenEstimateText =
        mode === 'buy'
            ? singleBuyQuoteLoading
                ? 'Estimating minted shares...'
                : estimatedSingleBuySharesAmount
                  ? `Est. mint: ${estimatedSingleBuySharesAmount} shares${activeQuickRouteSummary ? ` (${activeQuickRouteSummary})` : ''}`
                  : 'Enter spend amount to estimate minted shares.'
            : singleSellQuoteLoading
              ? 'Estimating output amount...'
              : estimatedSingleSellOutputAmount
                ? `Est. receive: ${estimatedSingleSellOutputAmount} ${selectedSellOutputOption.symbol}${activeQuickRouteSummary ? ` (${activeQuickRouteSummary})` : ''}`
                : 'Enter shares to estimate output.';
    const quickTokenAmountValue =
        mode === 'buy' ? quickBuySpendAmount : (estimatedSingleSellOutputAmount ?? '');
    const quickTokenAmountPlaceholder =
        mode === 'buy' ? `Enter ${selectedBuyInputOption.symbol} amount` : 'Enter shares to estimate output';

    useEffect(() => {
        if (jupiterCheckoutSupported) return;
        if (buyMethod === 'single') setBuyMethod('basket');
        if (sellMethod === 'single') setSellMethod('basket');
    }, [jupiterCheckoutSupported, buyMethod, sellMethod]);

    useEffect(() => {
        if (mode !== 'buy' || effectiveBuyMethod !== 'single' || hasUnsupportedAssetTokenPrograms || assetProgramSupportLoading) {
            setSingleBuyQuoteInputAtomic(null);
            setSingleBuyEstimatedSharesAtomic(null);
            setSingleBuyQuoteError(null);
            setSingleBuyQuoteLoading(false);
            setSingleBuyRoutePlan(null);
            return;
        }
        if (!quickBuySpendAtomic || quickBuySpendAtomic <= BigInt(0) || !indexConfig || quickBuyWeightEntries.length === 0) {
            setSingleBuyQuoteInputAtomic(null);
            setSingleBuyEstimatedSharesAtomic(null);
            setSingleBuyQuoteError(null);
            setSingleBuyQuoteLoading(false);
            setSingleBuyRoutePlan(null);
            return;
        }

        let cancelled = false;
        const timeoutId = window.setTimeout(async () => {
            setSingleBuyQuoteLoading(true);
            setSingleBuyQuoteError(null);
            setSingleBuyRoutePlan(null);
            try {
                const inputOption = selectedBuyInputOption;
                const candidateBaseSymbols = buildBaseCandidateOrder(inputOption.symbol, BUY_INPUT_TOKEN_OPTIONS);
                let firstFailure: string | null = null;
                let sawSpendTooSmall = false;

                for (const candidateSymbol of candidateBaseSymbols) {
                    if (cancelled) return;
                    const laneOption = buyInputOptionBySymbol.get(candidateSymbol);
                    if (!laneOption) continue;

                    try {
                        let laneBudgetAtomic = quickBuySpendAtomic;
                        const swapLegs: PlannedSwapLeg[] = [];
                        if (laneOption.mint !== inputOption.mint) {
                            const bridgeQuote = await fetchJupiterQuote({
                                inputMint: inputOption.mint,
                                outputMint: laneOption.mint,
                                amount: quickBuySpendAtomic.toString(),
                                swapMode: 'ExactIn',
                                slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                            });
                            const bridgeMinOutAtomic =
                                toPositiveAtomicOrNull(bridgeQuote.otherAmountThreshold) ??
                                toPositiveAtomicOrNull(bridgeQuote.outAmount);
                            if (!bridgeMinOutAtomic) {
                                throw new Error(`No bridge route from ${inputOption.symbol} to ${laneOption.symbol}.`);
                            }
                            laneBudgetAtomic = bridgeMinOutAtomic;
                            swapLegs.push({
                                inputMint: inputOption.mint,
                                outputMint: laneOption.mint,
                                inputSymbol: inputOption.symbol,
                                outputSymbol: laneOption.symbol,
                                inputAmountAtomic: quickBuySpendAtomic.toString(),
                            });
                        }

                        const componentInputByMint = allocateAtomicByWeights(laneBudgetAtomic, quickBuyWeightEntries);
                        const directContributionByMint = new Map<string, bigint>();
                        const contributionByMint = new Map<string, bigint>();

                        for (const asset of indexConfig.account.assets) {
                            const componentMint = asset.mint.toBase58();
                            const token = tokenMetadataByMint.get(componentMint);
                            const symbol = token?.symbol || `${componentMint.slice(0, 6)}...${componentMint.slice(-4)}`;
                            const componentInputAtomic = componentInputByMint.get(componentMint) ?? BigInt(0);
                            if (componentInputAtomic <= BigInt(0)) continue;

                            if (componentMint === laneOption.mint) {
                                directContributionByMint.set(
                                    componentMint,
                                    (directContributionByMint.get(componentMint) ?? BigInt(0)) + componentInputAtomic
                                );
                                contributionByMint.set(
                                    componentMint,
                                    (contributionByMint.get(componentMint) ?? BigInt(0)) + componentInputAtomic
                                );
                                continue;
                            }

                            const quote = await fetchJupiterQuote({
                                inputMint: laneOption.mint,
                                outputMint: componentMint,
                                amount: componentInputAtomic.toString(),
                                swapMode: 'ExactIn',
                                slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                            });
                            const minOutAtomic =
                                toPositiveAtomicOrNull(quote.otherAmountThreshold) ?? toPositiveAtomicOrNull(quote.outAmount);
                            if (!minOutAtomic) {
                                throw new Error(`Route via ${laneOption.symbol} returned zero output for ${symbol}.`);
                            }
                            contributionByMint.set(
                                componentMint,
                                (contributionByMint.get(componentMint) ?? BigInt(0)) + minOutAtomic
                            );
                            swapLegs.push({
                                inputMint: laneOption.mint,
                                outputMint: componentMint,
                                inputSymbol: laneOption.symbol,
                                outputSymbol: symbol,
                                inputAmountAtomic: componentInputAtomic.toString(),
                                contributionMint: componentMint,
                            });
                        }

                        const mintableSharesAtomic = computeMintableSharesFromContributions({
                            contributionByMint,
                            unitsByMint,
                            minimumStepAtomic: minimumQuantityStepAtomic,
                        });
                        if (mintableSharesAtomic <= BigInt(0)) {
                            sawSpendTooSmall = true;
                            continue;
                        }

                        if (!cancelled) {
                            const routeSummary =
                                laneOption.symbol === inputOption.symbol
                                    ? `Route: ${inputOption.symbol} lane`
                                    : `Route: ${inputOption.symbol} -> ${laneOption.symbol} lane`;
                            setSingleBuyQuoteInputAtomic(quickBuySpendAtomic.toString());
                            setSingleBuyEstimatedSharesAtomic(mintableSharesAtomic.toString());
                            setSingleBuyQuoteError(null);
                            setSingleBuyRoutePlan({
                                resolvedBaseSymbol: laneOption.symbol,
                                resolvedBaseMint: laneOption.mint,
                                routeSummary,
                                swapLegs,
                                componentInputByMint,
                                directContributionByMint,
                                estimatedSharesAtomic: mintableSharesAtomic.toString(),
                            });
                        }
                        return;
                    } catch (err: unknown) {
                        const reason = getErrorMessage(err);
                        const laneReason = `Via ${candidateSymbol}: ${reason}`;
                        if (!firstFailure) {
                            firstFailure = laneReason;
                        }
                    }
                }

                if (!cancelled) {
                    setSingleBuyQuoteInputAtomic(quickBuySpendAtomic.toString());
                    setSingleBuyEstimatedSharesAtomic(null);
                    setSingleBuyRoutePlan(null);
                    if (sawSpendTooSmall) {
                        setSingleBuyQuoteError('Spend amount is too small to mint any shares. Increase input size.');
                    } else {
                        setSingleBuyQuoteError(
                            firstFailure
                                ? `No routes found across available base lanes. ${firstFailure}`
                                : 'No routes found across available base lanes. Use Basket Deposit instead.'
                        );
                    }
                }
            } catch (err: unknown) {
                if (!cancelled) {
                    setSingleBuyQuoteInputAtomic(null);
                    setSingleBuyEstimatedSharesAtomic(null);
                    setSingleBuyQuoteError(getErrorMessage(err));
                    setSingleBuyRoutePlan(null);
                }
            } finally {
                if (!cancelled) {
                    setSingleBuyQuoteLoading(false);
                }
            }
        }, 350);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [
        mode,
        effectiveBuyMethod,
        hasUnsupportedAssetTokenPrograms,
        assetProgramSupportLoading,
        quickBuySpendAtomic,
        indexConfig,
        quickBuyWeightEntries,
        selectedBuyInputOption,
        buyInputOptionBySymbol,
        tokenMetadataByMint,
        unitsByMint,
        minimumQuantityStepAtomic,
    ]);

    useEffect(() => {
        if (mode !== 'sell' || effectiveSellMethod !== 'single' || hasUnsupportedAssetTokenPrograms || assetProgramSupportLoading) {
            setSingleSellQuoteOutputAtomic(null);
            setSingleSellQuoteError(null);
            setSingleSellQuoteLoading(false);
            setSingleSellRoutePlan(null);
            return;
        }
        if (!quantityAtomic || quoteBreakdown.length === 0) {
            setSingleSellQuoteOutputAtomic(null);
            setSingleSellQuoteError(null);
            setSingleSellQuoteLoading(false);
            setSingleSellRoutePlan(null);
            return;
        }

        let cancelled = false;
        const timeoutId = window.setTimeout(async () => {
            setSingleSellQuoteLoading(true);
            setSingleSellQuoteError(null);
            setSingleSellRoutePlan(null);
            try {
                const outputOption = selectedSellOutputOption;
                const candidateBaseSymbols = buildBaseCandidateOrder(outputOption.symbol, SELL_OUTPUT_TOKEN_OPTIONS);
                let firstFailure: string | null = null;

                for (const candidateSymbol of candidateBaseSymbols) {
                    if (cancelled) return;
                    const laneOption = sellOutputOptionBySymbol.get(candidateSymbol);
                    if (!laneOption) continue;

                    try {
                        let laneOutputAtomic = BigInt(0);
                        const swapLegs: PlannedSwapLeg[] = [];

                        for (const component of quoteBreakdown) {
                            if (component.totalAtomic <= BigInt(0)) continue;
                            if (component.mint === laneOption.mint) {
                                laneOutputAtomic += component.totalAtomic;
                                continue;
                            }

                            const quote = await fetchJupiterQuote({
                                inputMint: component.mint,
                                outputMint: laneOption.mint,
                                amount: component.totalAtomic.toString(),
                                swapMode: 'ExactIn',
                                slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                            });
                            const minOutAtomic =
                                toPositiveAtomicOrNull(quote.otherAmountThreshold) ?? toPositiveAtomicOrNull(quote.outAmount);
                            if (!minOutAtomic) {
                                throw new Error(`Route via ${laneOption.symbol} returned zero output for ${component.symbol}.`);
                            }
                            laneOutputAtomic += minOutAtomic;
                            swapLegs.push({
                                inputMint: component.mint,
                                outputMint: laneOption.mint,
                                inputSymbol: component.symbol,
                                outputSymbol: laneOption.symbol,
                                inputAmountAtomic: component.totalAtomic.toString(),
                            });
                        }

                        let estimatedOutputAtomic = laneOutputAtomic;
                        if (laneOption.mint !== outputOption.mint) {
                            const bridgeQuote = await fetchJupiterQuote({
                                inputMint: laneOption.mint,
                                outputMint: outputOption.mint,
                                amount: laneOutputAtomic.toString(),
                                swapMode: 'ExactIn',
                                slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                            });
                            const bridgeMinOutAtomic =
                                toPositiveAtomicOrNull(bridgeQuote.otherAmountThreshold) ??
                                toPositiveAtomicOrNull(bridgeQuote.outAmount);
                            if (!bridgeMinOutAtomic) {
                                throw new Error(`No bridge route from ${laneOption.symbol} to ${outputOption.symbol}.`);
                            }
                            estimatedOutputAtomic = bridgeMinOutAtomic;
                            swapLegs.push({
                                inputMint: laneOption.mint,
                                outputMint: outputOption.mint,
                                inputSymbol: laneOption.symbol,
                                outputSymbol: outputOption.symbol,
                                inputAmountAtomic: laneOutputAtomic.toString(),
                            });
                        }

                        if (!cancelled) {
                            const routeSummary =
                                laneOption.symbol === outputOption.symbol
                                    ? `Route: ${outputOption.symbol} lane`
                                    : `Route: ${laneOption.symbol} lane -> ${outputOption.symbol}`;
                            setSingleSellQuoteOutputAtomic(estimatedOutputAtomic.toString());
                            setSingleSellQuoteError(null);
                            setSingleSellRoutePlan({
                                resolvedBaseSymbol: laneOption.symbol,
                                resolvedBaseMint: laneOption.mint,
                                routeSummary,
                                swapLegs,
                                estimatedOutputAtomic: estimatedOutputAtomic.toString(),
                            });
                        }
                        return;
                    } catch (err: unknown) {
                        const reason = getErrorMessage(err);
                        const laneReason = `Via ${candidateSymbol}: ${reason}`;
                        if (!firstFailure) {
                            firstFailure = laneReason;
                        }
                    }
                }

                if (!cancelled) {
                    setSingleSellQuoteOutputAtomic(null);
                    setSingleSellRoutePlan(null);
                    setSingleSellQuoteError(
                        firstFailure
                            ? `No routes found across available base lanes. ${firstFailure}`
                            : 'No routes found across available base lanes. Use Basket Withdraw instead.'
                    );
                }
            } catch (err: unknown) {
                if (!cancelled) {
                    setSingleSellQuoteOutputAtomic(null);
                    setSingleSellQuoteError(getErrorMessage(err));
                    setSingleSellRoutePlan(null);
                }
            } finally {
                if (!cancelled) {
                    setSingleSellQuoteLoading(false);
                }
            }
        }, 350);

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [
        mode,
        effectiveSellMethod,
        hasUnsupportedAssetTokenPrograms,
        assetProgramSupportLoading,
        quantityAtomic,
        quoteBreakdown,
        selectedSellOutputOption,
        sellOutputOptionBySymbol,
    ]);

    useEffect(() => {
        if (!hasAllAssetPrices || !allocations.length || totalNav <= 0 || liquidityWeights) return;
        const weights = allocations
            .map((alloc) => ({
                mint: alloc.mint,
                symbol: alloc.symbol,
                weight: alloc.percentage / 100,
            }))
            .filter((alloc) => Number.isFinite(alloc.weight) && alloc.weight > 0);
        if (weights.length > 0) {
            setLiquidityWeights(weights);
        }
    }, [hasAllAssetPrices, allocations, totalNav, liquidityWeights]);

    useEffect(() => {
        if (!hasAllAssetPrices || !liquidityWeights || liquidityData) return;
        let cancelled = false;
        const fetchLiquidity = async () => {
            setLiquidityLoading(true);
            setLiquidityError(null);
            try {
                const res = await fetch('/api/liquidity', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assets: liquidityWeights }),
                });
                if (!res.ok) {
                    throw new Error(`Liquidity fetch failed (${res.status})`);
                }
                const data: LiquidityResponse = await res.json();
                if (cancelled) return;
                setLiquidityData(data);
                const today = new Date().toISOString().slice(0, 10);
                const history = upsertLiquidityHistory(address, {
                    date: today,
                    maxInvestment: data.index.maxInvestment,
                    liquidityScore: data.index.liquidityScore,
                });
                const avg = averageLiquidityHistory(history, LIQUIDITY_HISTORY_DAYS);
                setLiquidityAvg(avg);
            } catch (err: unknown) {
                if (!cancelled) {
                    setLiquidityError(getErrorMessage(err) || 'Failed to load liquidity');
                }
            } finally {
                if (!cancelled) setLiquidityLoading(false);
            }
        };
        fetchLiquidity();
        return () => {
            cancelled = true;
        };
    }, [hasAllAssetPrices, liquidityWeights, liquidityData, address]);

    const addLog = useCallback((message: string) => {
        setLogs((prev) => [
            ...prev,
            {
                id: prev.length > 0 ? prev[prev.length - 1].id + 1 : 1,
                message,
                createdAt: Date.now(),
            },
        ]);
    }, []);
    const getExplorerTxUrl = useCallback(
        (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=${explorerCluster}`,
        [explorerCluster]
    );

    const updateWorkflowStep = useCallback((stepId: string, patch: Partial<TradeWorkflowStep>) => {
        setTradeWorkflowSteps((prev) =>
            prev.map((step) => (step.id === stepId ? { ...step, ...patch } : step))
        );
    }, []);

    const validateTradeRequest = useCallback((): string | null => {
        if (!program || !wallet || !indexConfig) {
            return 'Connect wallet to trade this index.';
        }
        if (priceGateState === 'loading') {
            return 'Loading all component prices...';
        }
        if (priceGateState === 'error') {
            return priceGateErrorMessage;
        }
        if (isPaused) {
            return 'Index is paused. Trading is disabled by admin.';
        }
        if (assetProgramSupportLoading) {
            return 'Checking token program compatibility for index assets.';
        }
        if (hasUnsupportedAssetTokenPrograms) {
            return `This index contains unsupported token programs (${unsupportedAssetProgramSymbols.join(
                ', '
            )}). Protocol trades require SPL Token or basic Token-2022 assets.`;
        }

        const isQuickBuy = mode === 'buy' && effectiveBuyMethod === 'single';
        if (!isQuickBuy) {
            if (!quantityAtomic) {
                return 'Enter a valid share amount (up to 6 decimals).';
            }
            if (userReceivesSharesAtomic !== null && userReceivesSharesAtomic <= BigInt(0)) {
                return 'Share amount is too small after fee deduction.';
            }
            if (!isQuantityStepValid) {
                return `Invalid share amount for this index. Use increments of ${minimumQuantityStepHuman} shares.`;
            }
            if (!tradeBreakdown.length) {
                return 'Unable to compute basket requirements for this trade.';
            }
            if (mode === 'sell' && walletBalancesInitialized && quantityAtomic > indexShareBalanceAtomic) {
                return `Insufficient index shares. Wallet balance is ${indexShareBalanceHuman}.`;
            }
        }

        if (mode === 'buy' && effectiveBuyMethod === 'single') {
            if (!jupiterCheckoutSupported) return 'Quick Buy is only available on mainnet.';
            if (!walletAdapter.signTransaction) return 'Connected wallet cannot sign Jupiter swap transactions.';
            if (!quickBuySpendAtomic) return `Enter a valid ${selectedBuyInputOption.symbol} amount.`;
            if (singleBuyQuoteLoading) return 'Wait for quote calculation to complete.';
            if (singleBuyQuoteError) return `Quick Buy quote unavailable: ${singleBuyQuoteError}`;
            if (!singleBuyRoutePlan) return 'Quick Buy routing plan is unavailable.';
            if (!singleBuyEstimatedSharesAtomic || BigInt(singleBuyEstimatedSharesAtomic) <= BigInt(0)) {
                return 'Spend amount is too small to mint shares.';
            }
            if (walletBalancesInitialized && quickBuySpendAtomic > selectedBuyInputBalanceAtomic) {
                return `Insufficient ${selectedBuyInputOption.symbol}. Wallet balance is ${selectedBuyInputBalanceHuman}.`;
            }
        }
        if (mode === 'sell' && effectiveSellMethod === 'single') {
            if (!jupiterCheckoutSupported) return 'Quick Exit is only available on mainnet.';
            if (!walletAdapter.signTransaction) return 'Connected wallet cannot sign Jupiter swap transactions.';
            if (singleSellQuoteLoading) return 'Wait for quote calculation to complete.';
            if (singleSellQuoteError) return `Quick Exit quote unavailable: ${singleSellQuoteError}`;
            if (!singleSellRoutePlan) return 'Quick Exit routing plan is unavailable.';
        }
        return null;
    }, [
        program,
        wallet,
        indexConfig,
        quantityAtomic,
        userReceivesSharesAtomic,
        isQuantityStepValid,
        minimumQuantityStepHuman,
        tradeBreakdown,
        isPaused,
        assetProgramSupportLoading,
        hasUnsupportedAssetTokenPrograms,
        unsupportedAssetProgramSymbols,
        mode,
        walletBalancesInitialized,
        indexShareBalanceAtomic,
        indexShareBalanceHuman,
        effectiveBuyMethod,
        effectiveSellMethod,
        jupiterCheckoutSupported,
        walletAdapter.signTransaction,
        quickBuySpendAtomic,
        singleBuyQuoteLoading,
        singleBuyQuoteError,
        singleBuyRoutePlan,
        singleBuyEstimatedSharesAtomic,
        selectedBuyInputBalanceAtomic,
        selectedBuyInputOption.symbol,
        selectedBuyInputBalanceHuman,
        singleSellQuoteLoading,
        singleSellQuoteError,
        singleSellRoutePlan,
        priceGateState,
        priceGateErrorMessage,
    ]);

    const requiresShareQuantityInput = !(mode === 'buy' && effectiveBuyMethod === 'single');

    const primaryActionDisabled =
        loading ||
        tradeWorkflowRunning ||
        (requiresShareQuantityInput && !quantityAtomic) ||
        (requiresShareQuantityInput && !isQuantityStepValid) ||
        (mode === 'buy' && effectiveBuyMethod === 'single' && !quickBuySpendAtomic) ||
        (mode === 'buy' && effectiveBuyMethod === 'single' && !singleBuyQuoteLoading && !singleBuyEstimatedSharesAtomic) ||
        (mode === 'buy' && effectiveBuyMethod === 'single' && !singleBuyQuoteLoading && !singleBuyRoutePlan) ||
        (mode === 'sell' && effectiveSellMethod === 'single' && !singleSellQuoteLoading && !singleSellRoutePlan) ||
        assetProgramSupportLoading ||
        hasUnsupportedAssetTokenPrograms ||
        isPaused ||
        hasInsufficientIndexShares ||
        hasInsufficientQuickBuyInput ||
        isQuickBuyRouteBlocked ||
        isQuickSellRouteBlocked ||
        (mode === 'buy' && buyMethod === 'single' && !jupiterCheckoutSupported) ||
        (mode === 'sell' && sellMethod === 'single' && !jupiterCheckoutSupported) ||
        priceGateState !== 'ready';

    const primaryActionBlockedReason = useMemo(() => {
        if (!primaryActionDisabled) return null;
        if (loading || tradeWorkflowRunning) return 'Trade execution is in progress.';
        return validateTradeRequest() ?? 'Complete required trade inputs to continue.';
    }, [primaryActionDisabled, loading, tradeWorkflowRunning, validateTradeRequest]);
    const failedWorkflowStep = useMemo(
        () => tradeWorkflowSteps.find((step) => step.status === 'error') ?? null,
        [tradeWorkflowSteps]
    );
    const hasWorkflowProgress = useMemo(
        () => tradeWorkflowSteps.some((step) => step.status === 'done'),
        [tradeWorkflowSteps]
    );

    const buildWorkflowPlan = useCallback((): TradeWorkflowStep[] => {
        const steps: TradeWorkflowStep[] = [];
        let stepIndex = 1;
        const nextId = () => `step-${stepIndex++}`;

        if (mode === 'buy') {
            if (effectiveBuyMethod === 'single') {
                const routePlan = singleBuyRoutePlan;
                if (!routePlan) return [];
                for (const leg of routePlan.swapLegs) {
                    steps.push({
                        id: nextId(),
                        kind: 'swap-buy',
                        label: `Swap ${leg.inputSymbol} -> ${leg.outputSymbol}`,
                        status: 'pending',
                        swapInputMint: leg.inputMint,
                        swapOutputMint: leg.outputMint,
                        swapInputSymbol: leg.inputSymbol,
                        swapOutputSymbol: leg.outputSymbol,
                        swapInputAmountAtomic: leg.inputAmountAtomic,
                        contributionMint: leg.contributionMint,
                    });
                }
            }
            steps.push({
                id: nextId(),
                kind: 'mint',
                label: 'Deposit basket + mint shares',
                status: 'pending',
            });
        } else {
            steps.push({
                id: nextId(),
                kind: 'redeem',
                label: 'Redeem shares to basket tokens',
                status: 'pending',
            });
            if (effectiveSellMethod === 'single') {
                const routePlan = singleSellRoutePlan;
                if (!routePlan) return [];
                for (const leg of routePlan.swapLegs) {
                    steps.push({
                        id: nextId(),
                        kind: 'swap-sell',
                        label: `Swap ${leg.inputSymbol} -> ${leg.outputSymbol}`,
                        status: 'pending',
                        swapInputMint: leg.inputMint,
                        swapOutputMint: leg.outputMint,
                        swapInputSymbol: leg.inputSymbol,
                        swapOutputSymbol: leg.outputSymbol,
                        swapInputAmountAtomic: leg.inputAmountAtomic,
                    });
                }
            }
        }

        return steps;
    }, [
        mode,
        effectiveBuyMethod,
        effectiveSellMethod,
        singleBuyRoutePlan,
        singleSellRoutePlan,
    ]);

    const openTradeConfirmation = () => {
        const validationError = validateTradeRequest();
        if (validationError) {
            setTradeError(validationError);
            return;
        }

        const steps = buildWorkflowPlan();
        if (steps.length === 0) {
            setTradeError('No executable steps were generated for this trade.');
            return;
        }

        setTradeError(null);
        setTradeWorkflowError(null);
        setTradeWorkflowDone(false);
        setTradeWorkflowSteps(steps);
        setTradeModalOpen(true);
    };

    const closeTradeModal = () => {
        if (tradeWorkflowRunning) return;
        setTradeModalOpen(false);
    };

    const executeSerializedSwapTransaction = useCallback(
        async (swapTransactionBase64: string): Promise<string> => {
            if (!walletAdapter.signTransaction) {
                throw new Error('Connected wallet does not support transaction signing.');
            }

            const txBytes = decodeBase64(swapTransactionBase64);
            const tx = VersionedTransaction.deserialize(txBytes);
            const signedTx = await walletAdapter.signTransaction(tx);
            const signature = await connection.sendRawTransaction(signedTx.serialize(), {
                skipPreflight: false,
                maxRetries: 3,
            });
            await connection.confirmTransaction(signature, 'confirmed');
            return signature;
        },
        [walletAdapter, connection]
    );

    const executeSetupInstructions = useCallback(
        async (instructions: TransactionInstruction[]): Promise<string[]> => {
            if (instructions.length === 0) return [];
            if (!walletAdapter.sendTransaction || !wallet) {
                throw new Error('Connected wallet cannot submit setup transactions.');
            }

            const signatures: string[] = [];
            const chunkSize = 4;

            for (let i = 0; i < instructions.length; i += chunkSize) {
                const tx = new Transaction();
                tx.add(...instructions.slice(i, i + chunkSize));
                const signature = await walletAdapter.sendTransaction(tx, connection, {
                    skipPreflight: false,
                    maxRetries: 3,
                });
                await connection.confirmTransaction(signature, 'confirmed');
                signatures.push(signature);
            }

            return signatures;
        },
        [walletAdapter, wallet, connection]
    );

    const prepareTradeContext = useCallback(async (quantityOverrideAtomic?: bigint): Promise<PreparedTradeContext> => {
        const effectiveQuantityAtomic = quantityOverrideAtomic ?? quantityAtomic;
        if (!program || !wallet || !indexConfig || !effectiveQuantityAtomic) {
            throw new Error('Trade context is unavailable.');
        }

        const quantity = new BN(effectiveQuantityAtomic.toString());
        const indexMint = indexConfig.account.indexMint;
        const indexConfigPda = indexConfig.publicKey;
        const feeCollector = feeCollectorPubkey;
        const assets = indexConfig.account.assets;
        if (!assets.length) {
            throw new Error('Index has no configured assets.');
        }
        if (!feeCollector) {
            throw new Error('Index fee collector is not configured.');
        }

        const userIndexTokenAta = getAssociatedTokenAddressSync(
            indexMint,
            wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID
        );
        const feeCollectorIndexTokenAta = getAssociatedTokenAddressSync(
            indexMint,
            feeCollector,
            false,
            TOKEN_PROGRAM_ID
        );
        const assetInfos = assets.map((asset) => {
            const tokenProgram = resolveAssetTokenProgram(asset);
            const userAta = getAssociatedTokenAddressSync(asset.mint, wallet.publicKey, false, tokenProgram);
            const vaultAta = getAssociatedTokenAddressSync(asset.mint, indexConfigPda, true, tokenProgram);
            return { user: userAta, vault: vaultAta, mint: asset.mint, tokenProgram };
        });

        const ataPubkeys = [userIndexTokenAta, feeCollectorIndexTokenAta, ...assetInfos.flatMap((a) => [a.user, a.vault])];
        const uniqueAtaPubkeys = Array.from(new Map(ataPubkeys.map((p) => [p.toBase58(), p])).values());
        const ataInfos = await connection.getMultipleAccountsInfo(uniqueAtaPubkeys);
        const ataExists = new Map<string, boolean>();
        uniqueAtaPubkeys.forEach((pubkey, idx) => {
            ataExists.set(pubkey.toBase58(), !!ataInfos[idx]);
        });

        const preInstructions: TransactionInstruction[] = [];
        if (!ataExists.get(userIndexTokenAta.toBase58())) {
            preInstructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    wallet.publicKey,
                    userIndexTokenAta,
                    wallet.publicKey,
                    indexMint,
                    TOKEN_PROGRAM_ID
                )
            );
        }
        if (!ataExists.get(feeCollectorIndexTokenAta.toBase58())) {
            preInstructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                    wallet.publicKey,
                    feeCollectorIndexTokenAta,
                    feeCollector,
                    indexMint,
                    TOKEN_PROGRAM_ID
                )
            );
        }
        for (const assetInfo of assetInfos) {
            if (!ataExists.get(assetInfo.user.toBase58())) {
                preInstructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        assetInfo.user,
                        wallet.publicKey,
                        assetInfo.mint,
                        assetInfo.tokenProgram
                    )
                );
            }
            if (!ataExists.get(assetInfo.vault.toBase58())) {
                preInstructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        wallet.publicKey,
                        assetInfo.vault,
                        indexConfigPda,
                        assetInfo.mint,
                        assetInfo.tokenProgram
                    )
                );
            }
        }

        const accounts: TradeAccounts = {
            indexConfig: indexConfigPda,
            indexMint,
            user: wallet.publicKey,
            userIndexTokenAccount: userIndexTokenAta,
            feeCollectorIndexTokenAccount: feeCollectorIndexTokenAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
        };

        const issueRemainingAccounts: AccountMeta[] = assetInfos.flatMap((assetInfo) => [
            {
                pubkey: assetInfo.mint,
                isSigner: false,
                isWritable: false,
            },
            {
                pubkey: assetInfo.user,
                isSigner: false,
                isWritable: true,
            },
            {
                pubkey: assetInfo.vault,
                isSigner: false,
                isWritable: true,
            },
        ]);

        const redeemRemainingAccounts: AccountMeta[] = assetInfos.flatMap((assetInfo) => [
            {
                pubkey: assetInfo.mint,
                isSigner: false,
                isWritable: false,
            },
            {
                pubkey: assetInfo.vault,
                isSigner: false,
                isWritable: true,
            },
            {
                pubkey: assetInfo.user,
                isSigner: false,
                isWritable: true,
            },
        ]);

        return {
            quantity,
            accounts,
            issueRemainingAccounts,
            redeemRemainingAccounts,
            preInstructions,
        };
    }, [program, wallet, indexConfig, quantityAtomic, connection, feeCollectorPubkey]);

    const executeTradeWorkflow = async (resumeFromStepId?: string) => {
        if (!program || !wallet) {
            setTradeWorkflowError('Missing program or wallet context.');
            return;
        }
        if (!indexConfig) {
            setTradeWorkflowError('Index configuration is unavailable.');
            return;
        }
        if (tradeWorkflowSteps.length === 0) {
            setTradeWorkflowError('No execution steps to run.');
            return;
        }

        const workflowStepsSnapshot = tradeWorkflowSteps;
        const hasDoneSteps = workflowStepsSnapshot.some((step) => step.status === 'done');
        const hasErroredSteps = workflowStepsSnapshot.some((step) => step.status === 'error');
        const shouldRunFullValidation = !resumeFromStepId && !hasDoneSteps && !hasErroredSteps;
        if (shouldRunFullValidation) {
            const validationError = validateTradeRequest();
            if (validationError) {
                setTradeError(validationError);
                setTradeWorkflowError(validationError);
                return;
            }
        }

        let startIndex = 0;
        if (resumeFromStepId) {
            startIndex = workflowStepsSnapshot.findIndex((step) => step.id === resumeFromStepId);
            if (startIndex < 0) {
                setTradeWorkflowError('Failed step is no longer available.');
                return;
            }
        } else {
            const firstErroredIndex = workflowStepsSnapshot.findIndex((step) => step.status === 'error');
            if (firstErroredIndex >= 0) {
                startIndex = firstErroredIndex;
            } else {
                const firstNotDoneIndex = workflowStepsSnapshot.findIndex((step) => step.status !== 'done');
                startIndex = firstNotDoneIndex >= 0 ? firstNotDoneIndex : workflowStepsSnapshot.length;
            }
        }

        if (startIndex >= workflowStepsSnapshot.length) {
            setTradeWorkflowDone(true);
            setTradeWorkflowError(null);
            addLog('🎉 Execution completed successfully.');
            return;
        }

        const isResumeRun = startIndex > 0 || hasDoneSteps || hasErroredSteps;
        const startStepLabel = workflowStepsSnapshot[startIndex]?.label ?? `Step ${startIndex + 1}`;

        setLoading(true);
        setTradeWorkflowRunning(true);
        setTradeWorkflowError(null);
        setTradeWorkflowDone(false);
        setTradeError(null);
        if (!isResumeRun) {
            setLogs([]);
            addLog(`🚀 Starting ${mode === 'buy' ? 'BUY' : 'SELL'} execution...`);
        } else {
            addLog(`🔁 Retrying from step ${startIndex + 1}: ${startStepLabel}`);
        }
        setTradeWorkflowSteps((prev) =>
            prev.map((step, index) => {
                if (index < startIndex) return step;
                return {
                    ...step,
                    status: 'pending',
                    txSignature: undefined,
                    ...(step.kind === 'swap-buy' ? { swapConservativeOutputAtomic: undefined } : {}),
                };
            })
        );

        let activeStepId: string | null = null;
        try {
            const isQuickBuySpendFlow = mode === 'buy' && effectiveBuyMethod === 'single';
            let context: PreparedTradeContext | null = isQuickBuySpendFlow ? null : await prepareTradeContext();
            let setupDone = false;
            const quickBuyConservativeContributionByMint = new Map<string, bigint>();
            if (isQuickBuySpendFlow) {
                if (!singleBuyRoutePlan) {
                    throw new Error('Quick Buy route plan is unavailable.');
                }
                for (const [mint, amount] of singleBuyRoutePlan.directContributionByMint.entries()) {
                    quickBuyConservativeContributionByMint.set(
                        mint,
                        (quickBuyConservativeContributionByMint.get(mint) ?? BigInt(0)) + amount
                    );
                }
                for (let i = 0; i < startIndex; i += 1) {
                    const completedStep = workflowStepsSnapshot[i];
                    if (completedStep.kind !== 'swap-buy' || completedStep.status !== 'done') continue;
                    if (!completedStep.contributionMint) continue;
                    const conservativeOutAtomic = toPositiveAtomicOrNull(completedStep.swapConservativeOutputAtomic);
                    if (!conservativeOutAtomic) continue;
                    quickBuyConservativeContributionByMint.set(
                        completedStep.contributionMint,
                        (quickBuyConservativeContributionByMint.get(completedStep.contributionMint) ?? BigInt(0)) +
                            conservativeOutAtomic
                    );
                }
            }

            for (let stepIndex = startIndex; stepIndex < workflowStepsSnapshot.length; stepIndex += 1) {
                const step = workflowStepsSnapshot[stepIndex];
                activeStepId = step.id;
                updateWorkflowStep(step.id, { status: 'active' });

                if (step.kind === 'swap-buy') {
                    if (!step.swapInputMint || !step.swapOutputMint || !step.swapInputAmountAtomic) {
                        throw new Error('Invalid swap step payload.');
                    }
                    addLog(`↔️ ${step.label}`);

                    const quote = await fetchJupiterQuote({
                        inputMint: step.swapInputMint,
                        outputMint: step.swapOutputMint,
                        amount: step.swapInputAmountAtomic,
                        swapMode: 'ExactIn',
                        slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                    });
                    const swap = await fetchJupiterSwapTransaction({
                        quoteResponse: quote,
                        userPublicKey: wallet.publicKey.toBase58(),
                        wrapAndUnwrapSol:
                            step.swapInputMint === NATIVE_MINT.toBase58() || step.swapOutputMint === NATIVE_MINT.toBase58(),
                    });
                    const signature = await executeSerializedSwapTransaction(swap.swapTransaction);
                    if (isQuickBuySpendFlow && step.contributionMint) {
                        const conservativeOutAtomic =
                            toPositiveAtomicOrNull(quote.otherAmountThreshold) ?? toPositiveAtomicOrNull(quote.outAmount);
                        if (conservativeOutAtomic) {
                            quickBuyConservativeContributionByMint.set(
                                step.contributionMint,
                                (quickBuyConservativeContributionByMint.get(step.contributionMint) ?? BigInt(0)) + conservativeOutAtomic
                            );
                        }
                        updateWorkflowStep(step.id, {
                            swapConservativeOutputAtomic: conservativeOutAtomic ? conservativeOutAtomic.toString() : undefined,
                        });
                    }
                    addLog(`✅ ${step.swapOutputSymbol || 'Token'} acquired: ${getExplorerTxUrl(signature)}`);
                    updateWorkflowStep(step.id, { status: 'done', txSignature: signature });
                    continue;
                }

                if (step.kind === 'mint') {
                    if (!context) {
                        const mintableSharesAtomic = computeMintableSharesFromContributions({
                            contributionByMint: quickBuyConservativeContributionByMint,
                            unitsByMint,
                            minimumStepAtomic: minimumQuantityStepAtomic,
                        });
                        if (mintableSharesAtomic <= BigInt(0)) {
                            throw new Error('Quick Buy spend is too small to mint index shares.');
                        }
                        addLog(`⚡ Minting ${atomicToHumanString(mintableSharesAtomic, INDEX_SHARE_DECIMALS)} shares from acquired basket...`);
                        context = await prepareTradeContext(mintableSharesAtomic);
                    }

                    if (!setupDone && context.preInstructions.length > 0) {
                        addLog(`⚡ Preparing token accounts (${context.preInstructions.length} instructions)...`);
                        const setupSigs = await executeSetupInstructions(context.preInstructions);
                        if (setupSigs.length > 0) {
                            addLog(`✅ Account setup complete: ${getExplorerTxUrl(setupSigs[setupSigs.length - 1])}`);
                        }
                        setupDone = true;
                    }
                    addLog('⚡ Minting index shares...');
                    const signature = await program.methods
                        .issueShares(context.quantity)
                        .accounts(context.accounts)
                        .remainingAccounts(context.issueRemainingAccounts)
                        .rpc();
                    addLog(`✅ Mint complete: ${getExplorerTxUrl(signature)}`);
                    updateWorkflowStep(step.id, { status: 'done', txSignature: signature });
                    continue;
                }

                if (step.kind === 'redeem') {
                    if (!context) {
                        context = await prepareTradeContext();
                    }
                    if (!setupDone && context.preInstructions.length > 0) {
                        addLog(`⚡ Preparing token accounts (${context.preInstructions.length} instructions)...`);
                        const setupSigs = await executeSetupInstructions(context.preInstructions);
                        if (setupSigs.length > 0) {
                            addLog(`✅ Account setup complete: ${getExplorerTxUrl(setupSigs[setupSigs.length - 1])}`);
                        }
                        setupDone = true;
                    }
                    addLog('⚡ Redeeming shares...');
                    const signature = await program.methods
                        .redeemShares(context.quantity)
                        .accounts(context.accounts)
                        .remainingAccounts(context.redeemRemainingAccounts)
                        .rpc();
                    addLog(`✅ Redeem complete: ${getExplorerTxUrl(signature)}`);
                    updateWorkflowStep(step.id, { status: 'done', txSignature: signature });
                    continue;
                }

                if (step.kind === 'swap-sell') {
                    if (!step.swapInputMint || !step.swapOutputMint || !step.swapInputAmountAtomic) {
                        throw new Error('Invalid exit swap step payload.');
                    }
                    addLog(`↔️ ${step.label}`);

                    const quote = await fetchJupiterQuote({
                        inputMint: step.swapInputMint,
                        outputMint: step.swapOutputMint,
                        amount: step.swapInputAmountAtomic,
                        swapMode: 'ExactIn',
                        slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
                    });
                    const swap = await fetchJupiterSwapTransaction({
                        quoteResponse: quote,
                        userPublicKey: wallet.publicKey.toBase58(),
                        wrapAndUnwrapSol:
                            step.swapInputMint === NATIVE_MINT.toBase58() || step.swapOutputMint === NATIVE_MINT.toBase58(),
                    });
                    const signature = await executeSerializedSwapTransaction(swap.swapTransaction);
                    addLog(`✅ ${step.swapOutputSymbol || 'Token'} received: ${getExplorerTxUrl(signature)}`);
                    updateWorkflowStep(step.id, { status: 'done', txSignature: signature });
                    continue;
                }
            }

            setTradeWorkflowDone(true);
            void refreshWalletBalances();
            addLog('🎉 Execution completed successfully.');
        } catch (err: unknown) {
            console.error(err);
            const message = getErrorMessage(err);
            setTradeError(message);
            setTradeWorkflowError(message);
            addLog(`❌ ${message}`);
            if (activeStepId) {
                updateWorkflowStep(activeStepId, { status: 'error' });
            }
        } finally {
            setTradeWorkflowRunning(false);
            setLoading(false);
        }
    };

    const handlePauseToggle = async () => {
        if (!program || !wallet || !indexConfig || !isAdmin) return;
        setAdminLoading(true);
        setAdminError(null);
        try {
            const tx = isPaused
                ? await program.methods
                      .unpauseIndex()
                      .accounts({ indexConfig: indexConfig.publicKey, admin: wallet.publicKey })
                      .rpc()
                : await program.methods
                      .pauseIndex()
                      .accounts({ indexConfig: indexConfig.publicKey, admin: wallet.publicKey })
                      .rpc();

            const refreshed = await program.account.indexConfig.fetch(indexConfig.publicKey);
            setIndexConfig({ publicKey: indexConfig.publicKey, account: refreshed });
            addLog(`${isPaused ? '✅ Unpaused' : '✅ Paused'} index. Tx: ${tx.slice(0, 8)}...`);
        } catch (err: unknown) {
            console.error(err);
            setAdminError(getErrorMessage(err) || 'Admin action failed.');
        } finally {
            setAdminLoading(false);
        }
    };

    if (!indexConfig) {
        if (indexLoadError) {
            return (
                <div className="glass-card mx-auto max-w-xl p-10 text-center space-y-4">
                    <p className="text-rose-300 text-sm">{indexLoadError}</p>
                    <Link href="/" className="text-lime-400 hover:underline text-sm">
                        Back to marketplace
                    </Link>
                </div>
            );
        }

        return <div className="grid min-h-[45vh] place-items-center"><Loader2 className="animate-spin" /></div>;
    }

    return (
        <div className="mx-auto max-w-[1024px] w-full flex flex-col lg:grid lg:grid-cols-[500px_500px] lg:grid-rows-[auto_auto_1fr] justify-center gap-6 items-start">
            {/* Header - Top Left */}
            <div className="w-full order-1 lg:col-start-1 lg:row-start-1">
                {/* Header */}
            <div className="glass-card flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                    <h1 className="display-font text-3xl font-semibold text-white">{indexName}</h1>
                    <div className="mt-1 flex items-center gap-2 text-sm font-mono text-zinc-300/85">
                        <SolscanLink address={address} cluster={explorerCluster} />
                    </div>
                    {indexDescription ? (
                        <p className="mt-2 max-w-2xl text-sm text-zinc-200/85">{indexDescription}</p>
                    ) : null}
                </div>
                <div className="flex flex-row items-center justify-between sm:flex-col sm:items-end gap-4 shrink-0 border-t border-white/5 pt-4 sm:border-0 sm:pt-0">
                    <div className="text-left sm:text-right">
                        <div className="flex items-center justify-start sm:justify-end gap-2 text-sm text-zinc-200/85">
                            NAV / Share
                            <LiveIndicator isLive={priceGateState === 'ready' && !!lastUpdated} />
                        </div>
                        {priceGateState === 'ready' ? (
                            <div className="text-2xl font-bold text-lime-200">{formatUsd(totalNav)}</div>
                        ) : priceGateState === 'error' ? (
                            <div className="text-sm font-semibold text-rose-300">{priceGateErrorMessage}</div>
                        ) : (
                            <div className="inline-flex items-center gap-2 text-sm text-zinc-300">
                                <Loader2 size={16} className="animate-spin" />
                                Loading prices...
                            </div>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {STAGE1_ENABLE_REBALANCE ? (
                            <Link
                                href={`/index/${address}/edit`}
                                className="btn-secondary"
                            >
                                <Settings size={16} />
                                Rebalance
                            </Link>
                        ) : null}
                        <div
                            className={`px-3 py-1 rounded-full text-xs font-medium border ${
                                isPaused
                                    ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                    : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                            }`}
                        >
                            {isPaused ? 'Paused' : 'Active'}
                        </div>
                        {isAdmin ? (
                            <button
                                onClick={handlePauseToggle}
                                disabled={adminLoading}
                                className="btn-secondary px-3 py-2 text-xs disabled:opacity-50"
                            >
                                {adminLoading ? 'Updating...' : isPaused ? 'Unpause Index' : 'Pause Index'}
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
            </div>

            {/* Admin + Metadata Card */}
            <div className="w-full order-3 lg:col-start-1 lg:row-start-2">
            <div className="glass-card p-6 space-y-3">
                <div className="text-sm font-semibold text-zinc-200/85 uppercase tracking-wider">Index Metadata</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div className="text-zinc-200/85">
                        Name
                        <div className="text-zinc-200">{indexName}</div>
                    </div>
                    <div className="text-zinc-200/85">
                        Description
                        <div className="text-zinc-200">
                            {indexDescription || 'No description'}
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Creator
                        <div className="text-zinc-200 font-mono">
                            <SolscanLink 
                                address={indexConfig.account.creator || indexConfig.account.admin} 
                                cluster={explorerCluster} 
                            />
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Admin
                        <div className="text-zinc-200 font-mono">
                            <SolscanLink address={indexConfig.account.admin} cluster={explorerCluster} />
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Max Assets
                        <div className="text-zinc-200">{String(indexConfig.account.maxAssets ?? indexConfig.account.max_assets ?? 'N/A')}</div>
                    </div>
                    <div className="text-zinc-200/85">
                        Trade Fee
                        <div className="text-amber-300">{(tradeFeeBps / 100).toFixed(2)}%</div>
                    </div>
                    <div className="text-zinc-200/85">
                        Pending Admin
                        <div className="text-zinc-200 font-mono">
                            {indexConfig.account.pendingAdmin || indexConfig.account.pending_admin ? (
                                <SolscanLink 
                                    address={(indexConfig.account.pendingAdmin || indexConfig.account.pending_admin) as PublicKey} 
                                    cluster={explorerCluster} 
                                />
                            ) : 'None'}
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Fee Collector
                        <div className="text-zinc-200 font-mono">
                            {feeCollectorPubkey ? (
                                <SolscanLink address={feeCollectorPubkey} cluster={explorerCluster} />
                            ) : 'None'}
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Lifetime Fees
                        <div className="text-zinc-200">
                            {lifetimeFeeSharesHuman.toFixed(6)} shares (
                            {priceGateState === 'ready' ? formatUsd(lifetimeFeeUsdEstimate) : 'Loading prices...'})
                        </div>
                    </div>
                    <div className="text-zinc-200/85">
                        Program
                        <div className="text-zinc-200 font-mono">
                            {program ? (
                                <SolscanLink address={program.programId} cluster={explorerCluster} />
                            ) : 'None'}
                        </div>
                    </div>
                </div>
                {adminError ? <div className="text-sm text-rose-400">{adminError}</div> : null}
            </div>
            </div>

            {/* Composition Card */}
            <div className="w-full order-4 lg:col-start-1 lg:row-start-3">
            <div className="glass-card p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <PieChart size={18} className="text-lime-400" />
                        <h3 className="text-sm font-semibold text-zinc-200/85 uppercase tracking-wider">Composition</h3>
                    </div>
                    {priceGateState === 'ready' ? <LastUpdatedTime lastUpdated={lastUpdated} /> : null}
                </div>

                {priceGateState === 'loading' ? (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300 inline-flex items-center gap-2">
                        <Loader2 size={16} className="animate-spin" />
                        Loading all component prices...
                    </div>
                ) : priceGateState === 'error' ? (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
                        <div className="font-semibold">{priceGateErrorMessage}</div>
                        {missingPriceSymbols.length > 0 ? (
                            <div className="mt-1 text-xs text-rose-200/85">
                                Missing: {missingPriceSymbols.join(', ')}
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <>
                        {/* Stacked Allocation Bar */}
                        <div className="h-3 bg-zinc-800 rounded-full overflow-hidden flex mb-6">
                            {allocations.map((alloc, i) => (
                                <div
                                    key={alloc.mint}
                                    className={`${ALLOCATION_COLORS[i % ALLOCATION_COLORS.length]} transition-all duration-300`}
                                    style={{ width: `${alloc.percentage}%` }}
                                    title={`${alloc.symbol}: ${alloc.percentage.toFixed(1)}%`}
                                />
                            ))}
                        </div>

                        {/* Asset List */}
                        <div className="space-y-3">
                            {allocations.map((alloc, i: number) => (
                                <div key={alloc.mint} className="flex items-center justify-between border-b border-white/12 py-2 last:border-0">
                                    <div className="flex items-center gap-3">
                                        <TokenAvatar
                                            symbol={alloc.symbol}
                                            logoURI={alloc.logoURI}
                                            className="size-8"
                                            fallbackClassName={ALLOCATION_COLORS[i % ALLOCATION_COLORS.length]}
                                        />
                                        <div>
                                            <div className="font-medium text-white">{alloc.symbol}</div>
                                            <div className="text-xs text-zinc-300/85 flex items-center gap-1">
                                                {alloc.humanAmount.toLocaleString(undefined, {
                                                    maximumFractionDigits: Math.min(alloc.decimals, 8),
                                                })}{' '}
                                                tokens / share @ {formatUsd(alloc.price)}
                                                {alloc.source === 'pyth' ? (
                                                    <span className="text-green-400" title="Live Pyth price">
                                                        <Radio size={8} className="animate-pulse" />
                                                    </span>
                                                ) : alloc.source === 'jupiter' ? (
                                                    <span className="text-sky-400" title="Jupiter quote price">
                                                        (jup)
                                                    </span>
                                                ) : (
                                                    <span className="text-zinc-300/70">(mock)</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="font-mono text-white">{alloc.percentage.toFixed(1)}%</div>
                                        <div className="text-xs text-zinc-300/85">{formatUsd(alloc.usdValue)}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
            </div>

            <div className="w-full order-2 lg:col-start-2 lg:row-start-1 lg:row-span-3 space-y-6 lg:sticky lg:top-24">
                {/* Trade Widget */}
            <div className="glass-card overflow-hidden p-0! w-full">
                {/* Header Tabs */}
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <div className="flex bg-black/40 p-1 rounded-full border border-white/5">
                        <button
                            onClick={() => { setMode('buy'); setTradeError(null); setTradeWorkflowError(null); }}
                            className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${mode === 'buy' ? 'bg-white/10 text-lime-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            Buy
                        </button>
                        <button
                            onClick={() => { setMode('sell'); setTradeError(null); setTradeWorkflowError(null); }}
                            className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${mode === 'sell' ? 'bg-white/10 text-lime-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                        >
                            Sell
                        </button>
                    </div>
                    <div className="flex bg-black/40 p-1 rounded-full border border-white/5">
                        <button
                            onClick={() => {
                                if (mode === 'buy') setBuyMethod('single');
                                else setSellMethod('single');
                                setTradeError(null); setTradeWorkflowError(null);
                            }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                                (mode === 'buy' ? effectiveBuyMethod : effectiveSellMethod) === 'single'
                                    ? 'bg-white/10 text-lime-400 shadow-sm'
                                    : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            <Zap size={12} className={(mode === 'buy' ? effectiveBuyMethod : effectiveSellMethod) === 'single' ? "fill-current" : ""} /> Quick
                        </button>
                        <button
                            onClick={() => {
                                if (mode === 'buy') setBuyMethod('basket');
                                else setSellMethod('basket');
                                setTradeError(null); setTradeWorkflowError(null);
                            }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all ${
                                (mode === 'buy' ? effectiveBuyMethod : effectiveSellMethod) === 'basket'
                                    ? 'bg-white/10 text-cyan-400 shadow-sm'
                                    : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            <Library size={12} /> Basket
                        </button>
                    </div>
                </div>

                <div className="p-2 pt-0 relative">
                    <div className={`relative flex flex-col gap-1 ${isQuickRouteBlocked ? 'opacity-30 pointer-events-none' : ''}`}>
                        {/* Top Block: Pay */}
                        <div className="bg-[#131728] rounded-2xl p-4 border border-white/10 hover:border-white/20 focus-within:border-lime-500/40 focus-within:hover:border-lime-500/40 focus-within:bg-[#171c30] transition-colors shadow-inner">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-sm font-medium text-zinc-400">You pay</span>
                                <div className="text-xs font-medium text-zinc-500 flex items-center gap-1.5">
                                    {mode === 'buy' && effectiveBuyMethod === 'single' && (
                                        <div className="flex items-center gap-1">
                                            <Wallet size={12} />
                                            {walletBalancesLoading && !walletBalancesInitialized ? '...' : selectedBuyInputBalanceHuman}
                                        </div>
                                    )}
                                    {mode === 'sell' && (
                                        <div className="flex items-center gap-1">
                                            <Wallet size={12} />
                                            {walletBalancesLoading && !walletBalancesInitialized ? '...' : indexShareBalanceHuman}
                                            <button 
                                                onClick={() => {
                                                    setAmount(indexShareBalanceHuman);
                                                    setTradeError(null);
                                                }}
                                                className="ml-1 text-[10px] uppercase font-bold text-lime-400 bg-lime-400/10 hover:bg-lime-400/20 px-1.5 py-0.5 rounded transition-colors"
                                            >
                                                Max
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between items-center gap-4">
                                <div className="flex-1">
                                    {mode === 'buy' && effectiveBuyMethod === 'basket' ? (
                                        <div className="text-3xl font-medium text-zinc-500">
                                            Multiple
                                        </div>
                                    ) : (
                                        <input
                                            type={mode === 'buy' && effectiveBuyMethod === 'single' ? "text" : "number"}
                                            min="0"
                                            step={mode === 'sell' ? minimumQuantityStepHuman : undefined}
                                            value={mode === 'buy' && effectiveBuyMethod === 'single' ? quickBuySpendAmount : amount}
                                            onChange={(e) => {
                                                if (mode === 'buy' && effectiveBuyMethod === 'single') setQuickBuySpendAmount(e.target.value);
                                                else setAmount(e.target.value);
                                                setTradeError(null); setTradeWorkflowError(null);
                                            }}
                                            className="w-full bg-transparent text-3xl font-medium text-white outline-none placeholder:text-zinc-600"
                                            placeholder="0.00"
                                        />
                                    )}
                                </div>
                                <div className="shrink-0">
                                    {mode === 'buy' ? (
                                        effectiveBuyMethod === 'single' ? (
                                            <div className="relative">
                                                <select
                                                    value={buyInputSymbol}
                                                    onChange={(e) => {
                                                        setBuyInputSymbol(e.target.value as BuyInputTokenSymbol);
                                                        setTradeError(null); setTradeWorkflowError(null);
                                                    }}
                                                    className="appearance-none h-10 rounded-full border border-white/5 bg-white/5 pl-3 pr-8 text-sm font-bold text-white outline-none transition-colors hover:bg-white/10 focus:border-lime-500/40 cursor-pointer"
                                                >
                                                    {BUY_INPUT_TOKEN_OPTIONS.map((o) => <option key={o.symbol} value={o.symbol}>{o.symbol}</option>)}
                                                </select>
                                                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 h-10 rounded-full border border-white/5 bg-white/5 px-3">
                                                <Library size={16} className="text-cyan-400" />
                                                <span className="text-sm font-bold text-white">Basket</span>
                                            </div>
                                        )
                                    ) : (
                                        <div className="flex items-center gap-2 h-10 rounded-full border border-white/5 bg-white/5 pl-1.5 pr-3">
                                            <TokenAvatar symbol={indexName} className="size-7 rounded-full" fallbackClassName="bg-zinc-800" />
                                            <span className="text-sm font-bold text-white">{indexName}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="mt-2 text-xs font-medium text-zinc-500 h-4">
                                {mode === 'buy' && effectiveBuyMethod === 'single' && singleBuyQuoteLoading && '...'}
                                {mode === 'sell' && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                                {mode === 'buy' && effectiveBuyMethod === 'basket' && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                                {mode === 'buy' && effectiveBuyMethod === 'single' && !singleBuyQuoteLoading && estimatedSingleBuyInputAmount && `Pay ${estimatedSingleBuyInputAmount} ${selectedBuyInputOption.symbol}`}
                            </div>
                        </div>

                        {/* Swap Arrow */}
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                            <button
                                onClick={() => {
                                    setMode(mode === 'buy' ? 'sell' : 'buy');
                                    setTradeError(null); setTradeWorkflowError(null);
                                }}
                                className="size-10 rounded-full border-4 border-transparent bg-black/40 flex items-center justify-center hover:bg-black/60 text-zinc-400 hover:text-white transition-colors group"
                            >
                                <ArrowDownUp size={16} className="transition-transform group-hover:rotate-180 duration-300" />
                            </button>
                        </div>

                        {/* Bottom Block: Receive */}
                        <div className="bg-[#131728] rounded-2xl p-4 border border-white/10 hover:border-white/20 focus-within:border-lime-500/40 focus-within:hover:border-lime-500/40 focus-within:bg-[#171c30] transition-colors shadow-inner">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-sm font-medium text-zinc-400">You receive</span>
                                <div className="text-xs font-medium text-zinc-500 flex items-center gap-1.5">
                                    {mode === 'buy' && (
                                        <div className="flex items-center gap-1">
                                            <Wallet size={12} />
                                            {walletBalancesLoading && !walletBalancesInitialized ? '...' : indexShareBalanceHuman}
                                        </div>
                                    )}
                                    {mode === 'sell' && effectiveSellMethod === 'single' && (
                                        <div className="flex items-center gap-1">
                                            <Wallet size={12} />
                                            {walletBalancesLoading && !walletBalancesInitialized ? '...' : selectedSellOutputBalanceHuman}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between items-center gap-4">
                                <div className="flex-1">
                                    {mode === 'sell' && effectiveSellMethod === 'basket' ? (
                                        <div className="text-3xl font-medium text-zinc-500">
                                            Multiple
                                        </div>
                                    ) : (
                                        <input
                                            type={mode === 'buy' && effectiveBuyMethod === 'basket' ? "number" : "text"}
                                            min="0"
                                            step={mode === 'buy' && effectiveBuyMethod === 'basket' ? minimumQuantityStepHuman : undefined}
                                            value={mode === 'buy' ? (effectiveBuyMethod === 'single' ? (estimatedSingleBuySharesAmount ?? '') : amount) : (estimatedSingleSellOutputAmount ?? '')}
                                            onChange={(e) => {
                                                if (mode === 'buy' && effectiveBuyMethod === 'basket') setAmount(e.target.value);
                                                setTradeError(null); setTradeWorkflowError(null);
                                            }}
                                            readOnly={mode === 'sell' || (mode === 'buy' && effectiveBuyMethod === 'single')}
                                            className={`w-full bg-transparent text-3xl font-medium text-white outline-none placeholder:text-zinc-600 ${
                                                mode === 'sell' || (mode === 'buy' && effectiveBuyMethod === 'single') ? 'cursor-not-allowed' : ''
                                            }`}
                                            placeholder="0.00"
                                        />
                                    )}
                                </div>
                                <div className="shrink-0">
                                    {mode === 'buy' ? (
                                        <div className="flex items-center gap-2 h-10 rounded-full border border-white/5 bg-white/5 pl-1.5 pr-3">
                                            <TokenAvatar symbol={indexName} className="size-7 rounded-full" fallbackClassName="bg-zinc-800" />
                                            <span className="text-sm font-bold text-white">{indexName}</span>
                                        </div>
                                    ) : (
                                        effectiveSellMethod === 'single' ? (
                                            <div className="relative">
                                                <select
                                                    value={sellOutputSymbol}
                                                    onChange={(e) => {
                                                        setSellOutputSymbol(e.target.value as SellOutputTokenSymbol);
                                                        setTradeError(null); setTradeWorkflowError(null);
                                                    }}
                                                    className="appearance-none h-10 rounded-full border border-white/5 bg-white/5 pl-3 pr-8 text-sm font-bold text-white outline-none transition-colors hover:bg-white/10 focus:border-lime-500/40 cursor-pointer"
                                                >
                                                    {SELL_OUTPUT_TOKEN_OPTIONS.map((o) => <option key={o.symbol} value={o.symbol}>{o.symbol}</option>)}
                                                </select>
                                                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 h-10 rounded-full border border-white/5 bg-white/5 px-3">
                                                <Library size={16} className="text-cyan-400" />
                                                <span className="text-sm font-bold text-white">Basket</span>
                                            </div>
                                        )
                                    )}
                                </div>
                            </div>
                            <div className="mt-2 text-xs font-medium text-zinc-500 h-4">
                                {mode === 'sell' && effectiveSellMethod === 'single' && singleSellQuoteLoading && '...'}
                                {mode === 'buy' && effectiveBuyMethod === 'single' && estimatedSingleBuySharesAmount && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                                {mode === 'buy' && effectiveBuyMethod === 'basket' && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                                {mode === 'sell' && effectiveSellMethod === 'single' && !singleSellQuoteLoading && estimatedSingleSellOutputAmount && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                                {mode === 'sell' && effectiveSellMethod === 'basket' && effectiveEstimatedTradeUsd ? `~$${effectiveEstimatedTradeUsd.toFixed(2)}` : ''}
                            </div>
                        </div>

                    </div>

                    {isQuickRouteBlocked ? (
                        <div className="absolute inset-0 z-20 m-2 rounded-2xl border border-amber-500/40 bg-black/80 backdrop-blur-md p-6 flex flex-col items-center justify-center gap-4 text-center">
                            <div className="text-base font-bold text-amber-300">{quickRouteBlockedTitle}</div>
                            <p className="text-sm text-amber-200/80">
                                {quickRouteBlockedMessage ?? 'No Jupiter route available for one or more basket tokens.'}
                            </p>
                            <button
                                onClick={() => {
                                    if (mode === 'buy') setBuyMethod('basket');
                                    else setSellMethod('basket');
                                    setTradeError(null); setTradeWorkflowError(null);
                                }}
                                className="w-full max-w-[200px] rounded-xl bg-lime-500/20 text-lime-400 font-bold px-4 py-3 hover:bg-lime-500/30 transition-colors"
                            >
                                {quickRouteBlockedActionLabel}
                            </button>
                        </div>
                    ) : null}

                    {/* Errors / Warnings */}
                    <div className="mt-3 space-y-2 px-1">
                        {assetProgramSupportLoading ? (
                            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-200">
                                Checking token program compatibility...
                            </div>
                        ) : null}
                        {hasUnsupportedAssetTokenPrograms ? (
                            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300">
                                Unsupported token programs ({unsupportedAssetProgramSymbols.join(', ')}). SPL Token or Token-2022 only.
                            </div>
                        ) : null}
                        {(!jupiterCheckoutSupported && ((mode === 'buy' && effectiveBuyMethod === 'single') || (mode === 'sell' && effectiveSellMethod === 'single'))) ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                                Quick Trade requires mainnet RPC (Jupiter swap transactions).
                            </div>
                        ) : null}
                        {mode === 'buy' && singleBuyQuoteError ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                                {singleBuyQuoteError}
                            </div>
                        ) : null}
                        {mode === 'sell' && singleSellQuoteError ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                                {singleSellQuoteError}
                            </div>
                        ) : null}
                        {isPaused ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-300">
                                Trading is paused by index admin.
                            </div>
                        ) : null}
                        {tradeError ? (
                            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300">
                                {tradeError}
                            </div>
                        ) : null}
                        {primaryActionBlockedReason ? (
                            <div className="text-xs font-medium text-amber-400 text-center">{primaryActionBlockedReason}</div>
                        ) : null}
                        {amount && quantityAtomic && !isQuantityStepValid && (mode === 'buy' ? effectiveBuyMethod === 'basket' : true) ? (
                            <div className="text-xs font-medium text-amber-400 text-center">
                                Amount must be a multiple of {minimumQuantityStepHuman}.
                            </div>
                        ) : null}
                    </div>

                    {/* Execution Details Expander */}
                    <div className="mt-3 px-1">
                        <details className="group [&_summary::-webkit-details-marker]:hidden">
                            <summary className="flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-xs font-bold text-zinc-400 hover:text-zinc-200 transition-colors list-none">
                                <span>
                                    1 {indexName} ≈{' '}
                                    {priceGateState === 'ready'
                                        ? formatUsd(totalNav)
                                        : priceGateState === 'error'
                                          ? 'Price unavailable'
                                          : 'Loading prices...'}
                                </span>
                                <span className="flex items-center gap-1"><ChevronDown size={14} className="group-open:rotate-180 transition-transform" /></span>
                            </summary>
                            <div className="mt-2 rounded-2xl bg-[#131728] border border-white/10 p-3 space-y-2 text-xs shadow-inner">
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">NAV per share</span>
                                    <span className="text-zinc-300 font-mono">
                                        {priceGateState === 'ready'
                                            ? formatUsd(totalNav)
                                            : priceGateState === 'error'
                                              ? 'Unavailable'
                                              : 'Loading...'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">Trade fee</span>
                                    <span className="text-zinc-300 font-mono">
                                        {(tradeFeeBps / 100).toFixed(2)}%
                                        {feeSharesHuman !== null ? ` (${feeSharesHuman} shares)` : ''}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-500">{mode === 'buy' ? 'Shares you receive' : 'Redeem basis shares'}</span>
                                    <span className="text-zinc-300 font-mono">{userReceivesSharesHuman ?? 'n/a'}</span>
                                </div>
                                <div className="pt-2 mt-2 border-t border-white/5 space-y-2">
                                    <div className="font-semibold text-zinc-400 mb-1">{mode === 'buy' ? 'Token Requirements' : 'Token Outputs'}</div>
                                    {mode === 'buy' && effectiveBuyMethod === 'single' ? (
                                        singleBuyRoutePlan && singleBuyRoutePlan.componentInputByMint.size > 0 ? (
                                            Array.from(singleBuyRoutePlan.componentInputByMint.entries()).map(([mint, allocatedInputAtomic]) => {
                                                const token = tokenMetadataByMint.get(mint);
                                                const symbol = token?.symbol || mint;
                                                const routeInputOption = buyInputOptionBySymbol.get(singleBuyRoutePlan.resolvedBaseSymbol) ?? selectedBuyInputOption;
                                                return (
                                                    <div key={mint} className="flex items-center justify-between">
                                                        <span className="text-zinc-500">{symbol}</span>
                                                        <span className="text-zinc-300 font-mono">{atomicToHumanString(allocatedInputAtomic, routeInputOption.decimals)} {routeInputOption.symbol}</span>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="text-zinc-600 italic text-[11px]">Enter a valid spend amount to preview allocations.</div>
                                        )
                                    ) : tradeBreakdown.length > 0 ? (
                                        tradeBreakdown.map((item) => (
                                            <div key={item.mint} className="flex items-center justify-between">
                                                <span className="text-zinc-500">{item.symbol}</span>
                                                <span className="text-zinc-300 font-mono">{atomicToHumanString(item.totalAtomic, item.decimals)}</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-zinc-600 italic text-[11px]">
                                            {quantityAtomic && !isQuantityStepValid ? `Use share increments of ${minimumQuantityStepHuman}.` : 'Enter a valid share amount to preview basket amounts.'}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </details>
                    </div>

                    {/* Action Button */}
                    <div className="mt-3">
                        <button
                            onClick={openTradeConfirmation}
                            disabled={primaryActionDisabled}
                            className="w-full h-14 rounded-2xl bg-lime-400 text-lime-950 font-bold text-lg transition-all hover:bg-lime-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(163,230,53,0.15)] hover:shadow-[0_0_25px_rgba(163,230,53,0.25)] disabled:shadow-none"
                        >
                            {loading ? <Loader2 className="animate-spin" /> : null}
                            {!loading && (
                                mode === 'buy'
                                    ? effectiveBuyMethod === 'single'
                                        ? 'Review Quick Buy'
                                        : 'Review Mint'
                                    : effectiveSellMethod === 'single'
                                        ? 'Review Quick Exit'
                                        : 'Review Redeem'
                            )}
                        </button>
                    </div>
                </div>

                {/* Execution Activity */}
                {logs.length > 0 && (
                    <div className="inner-card mt-6 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-300/85">Execution Activity</p>
                                <p className="text-sm text-zinc-200">Live execution updates</p>
                            </div>
                            <div
                                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                                    tradeWorkflowRunning
                                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                        : tradeWorkflowError
                                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                                          : tradeWorkflowDone
                                            ? 'border-lime-500/40 bg-lime-500/10 text-lime-300'
                                            : 'border-white/16 bg-black/36 text-zinc-200/85'
                                }`}
                            >
                                {tradeWorkflowRunning ? 'Live' : tradeWorkflowError ? 'Error' : tradeWorkflowDone ? 'Complete' : 'Idle'}
                            </div>
                        </div>

                        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                            {[...logs].reverse().map((log) => {
                                const parsed = parseWorkflowLog(log.message);
                                const toneClasses =
                                    parsed.tone === 'success'
                                        ? {
                                              dot: 'bg-emerald-400 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]',
                                              title: 'text-emerald-100',
                                          }
                                        : parsed.tone === 'error'
                                          ? {
                                                dot: 'bg-rose-400 shadow-[0_0_0_3px_rgba(244,63,94,0.16)]',
                                                title: 'text-rose-100',
                                            }
                                          : parsed.tone === 'action'
                                            ? {
                                                  dot: 'bg-lime-400 shadow-[0_0_0_3px_rgba(99,102,241,0.16)]',
                                                  title: 'text-lime-100',
                                              }
                                            : {
                                                  dot: 'bg-zinc-400 shadow-[0_0_0_3px_rgba(161,161,170,0.14)]',
                                                  title: 'text-zinc-100',
                                              };

                                return (
                                    <div key={log.id} className="inner-card px-3 py-2.5">
                                        <div className="flex items-start gap-3">
                                            <span className={`mt-1.5 size-2 rounded-full shrink-0 ${toneClasses.dot}`} />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center justify-between gap-2">
                                                    <p className={`text-sm leading-snug ${toneClasses.title}`}>{parsed.title}</p>
                                                    <span className="font-mono text-[10px] text-zinc-300/85">
                                                        {formatWorkflowLogTime(log.createdAt)}
                                                    </span>
                                                </div>
                                                {parsed.detail ? (
                                                    <p className="mt-1 text-xs leading-relaxed text-zinc-200/85 wrap-break-word">{parsed.detail}</p>
                                                ) : null}
                                                {parsed.txUrl ? (
                                                    <a
                                                        href={parsed.txUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="mt-1.5 inline-flex text-xs text-lime-300 hover:text-lime-200 hover:underline"
                                                    >
                                                        View transaction
                                                    </a>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Liquidity Card */}
            <div className="glass-card p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <TrendingUp size={18} className="text-emerald-400" />
                        <h3 className="text-sm font-semibold text-zinc-200/85 uppercase tracking-wider">Liquidity</h3>
                    </div>
                    <span className="text-xs text-zinc-300/85">
                        {liquidityAvg ? `7d avg (${liquidityAvg.days}d)` : 'Latest'}
                    </span>
                </div>

                {liquidityLoading ? (
                    <div className="flex items-center gap-2 text-sm text-zinc-300/85">
                        <Loader2 className="animate-spin" size={16} />
                        Calculating depth from Jupiter quotes...
                    </div>
                ) : liquidityError ? (
                    <div className="text-sm text-rose-400">{liquidityError}</div>
                ) : liquidityData ? (
                    (() => {
                        const displayMaxInvestment = liquidityAvg?.maxInvestment ?? liquidityData.index.maxInvestment;
                        const displayScore = Math.round(liquidityAvg?.liquidityScore ?? liquidityData.index.liquidityScore);
                        const displayRange = getInvestmentRange(displayMaxInvestment);
                        const limitingToken = liquidityData.index.limitingToken;
                        const hasMissingQuotes = (liquidityData.missingQuotes || []).length > 0;
                        return (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-3xl font-bold text-white">{displayRange.label}</div>
                                        <div className="text-xs text-zinc-300/85">Recommended investment range</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs text-zinc-300/85">Liquidity score</div>
                                        <div className="text-2xl font-mono text-emerald-400">{displayScore}/100</div>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3 text-xs">
                                    <div className="text-zinc-300/85">
                                        Max size @ {liquidityData.maxImpactBps} bps impact
                                    </div>
                                    <div className="text-right text-zinc-300">{formatUsd(displayMaxInvestment)}</div>
                                    <div className="text-zinc-300/85">Limiting token</div>
                                    <div className="text-right text-zinc-300">
                                        {limitingToken
                                            ? `${limitingToken.symbol} (${formatUsd(limitingToken.maxSize)})`
                                            : '—'}
                                    </div>
                                </div>
                                {hasMissingQuotes && (
                                    <div className="text-[11px] text-amber-400">
                                        Missing Jupiter quotes for: {liquidityData.missingQuotes.join(', ')}. Range is estimated from available
                                        routes.
                                    </div>
                                )}
                                <p className="text-[11px] text-zinc-300/70">
                                    Based on Jupiter quote depth. This is a directional metric, not investment advice.
                                </p>
                            </div>
                        );
                    })()
                ) : (
                    <div className="text-sm text-zinc-300/85">Liquidity data will appear once quotes are available.</div>
                )}
            </div>

            {/* Info Card */}
            <div className="glass-card p-4 text-sm text-zinc-200/85">
                <div className="flex items-start gap-3">
                    <div className="size-8 bg-lime-500/10 rounded-lg flex items-center justify-center shrink-0">
                        <Coins size={16} className="text-lime-400" />
                    </div>
                    <div>
                        <h4 className="text-white font-medium mb-1">How it works</h4>
                        <p>
                            <strong>Quick Buy:</strong> Pay with USDC/USDT/SOL and the app swaps into the basket before minting shares.{' '}
                            <strong>Quick Exit:</strong> Redeem shares, then swap outputs into USDC/USDT/SOL.{' '}
                            <strong>Basket Mint / Withdraw:</strong> Trade directly with basket tokens.
                        </p>
                    </div>
                </div>
            </div>

            </div>

            {tradeModalOpen ? (
                <div className="fixed inset-0 z-60 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="inner-card-soft w-full max-w-xl space-y-5 p-6">
                        <div className="space-y-1">
                            <h3 className="text-xl font-semibold text-white">
                                {mode === 'buy'
                                    ? effectiveBuyMethod === 'single'
                                        ? `Confirm Quick Buy (${selectedBuyInputOption.symbol})`
                                        : 'Confirm Basket Mint'
                                    : effectiveSellMethod === 'single'
                                      ? `Confirm Quick Exit (${selectedSellOutputOption.symbol})`
                                      : 'Confirm Basket Redeem'}
                            </h3>
                            <p className="text-sm text-zinc-200/85">
                                {mode === 'buy' && effectiveBuyMethod === 'single'
                                    ? `${quickBuySpendAmount || '0'} ${selectedBuyInputOption.symbol} input. Wallet prompts will appear step-by-step and this modal will guide the whole flow.`
                                    : `${amount || '0'} shares. Wallet prompts will appear step-by-step and this modal will guide the whole flow.`}
                            </p>
                        </div>

                        <div className="inner-card p-4 space-y-2 max-h-72 overflow-y-auto">
                            {tradeWorkflowSteps.map((step) => (
                                <div key={step.id} className="inner-card px-3 py-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-zinc-100">{step.label}</span>
                                        <span
                                            className={`text-xs font-medium px-2 py-1 rounded-full ${
                                                step.status === 'done'
                                                    ? 'bg-emerald-500/20 text-emerald-300'
                                                    : step.status === 'active'
                                                      ? 'bg-lime-500/20 text-lime-300'
                                                      : step.status === 'error'
                                                        ? 'bg-rose-500/20 text-rose-300'
                                                        : 'bg-zinc-800 text-zinc-200/85'
                                            }`}
                                        >
                                            {step.status === 'done'
                                                ? 'Done'
                                                : step.status === 'active'
                                                  ? 'In Progress'
                                                  : step.status === 'error'
                                                    ? 'Failed'
                                                    : 'Pending'}
                                        </span>
                                    </div>
                                    {step.status === 'error' && !tradeWorkflowRunning && !tradeWorkflowDone ? (
                                        <button
                                            onClick={() => executeTradeWorkflow(step.id)}
                                            className="mt-2 text-xs font-medium rounded-md border border-rose-400/35 bg-rose-500/12 text-rose-200 px-2 py-1 hover:bg-rose-500/18 transition-colors"
                                        >
                                            Retry this step
                                        </button>
                                    ) : null}
                                    {step.txSignature ? (
                                        <a
                                            href={getExplorerTxUrl(step.txSignature)}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-xs text-lime-400 hover:underline mt-1 inline-block"
                                        >
                                            View transaction
                                        </a>
                                    ) : null}
                                </div>
                            ))}
                        </div>

                        {tradeWorkflowError ? (
                            <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                                {tradeWorkflowError}
                            </div>
                        ) : null}

                        <div className="flex items-center justify-end gap-3">
                            <button
                                onClick={closeTradeModal}
                                disabled={tradeWorkflowRunning}
                                className="px-4 py-2 rounded-lg border border-white/16 bg-black/28 text-zinc-200 hover:bg-black/38 disabled:opacity-50"
                            >
                                {tradeWorkflowDone ? 'Close' : 'Cancel'}
                            </button>
                            {!tradeWorkflowDone ? (
                                <button
                                    onClick={() => executeTradeWorkflow(failedWorkflowStep?.id)}
                                    disabled={tradeWorkflowRunning}
                                    className="px-4 py-2 rounded-lg bg-lime-600 hover:bg-lime-500 text-white font-medium disabled:opacity-50 inline-flex items-center gap-2"
                                >
                                    {tradeWorkflowRunning ? <Loader2 className="animate-spin" size={16} /> : null}
                                    {tradeWorkflowRunning
                                        ? 'Running...'
                                        : failedWorkflowStep
                                          ? 'Retry Failed Step'
                                          : hasWorkflowProgress
                                            ? 'Continue'
                                            : 'Confirm & Start'}
                                </button>
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
