'use client';

import { useEffect, useState, useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { ArrowRight, Layers, Sparkles } from 'lucide-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { TokenMetadata, useTokenMetadataMap } from '@/hooks/useTokenMetadataMap';
import { usePythPrices } from '@/hooks/usePythPrices';
import type { PriceData, PriceQuery } from '@/hooks/usePythPrices';
import { formatUsd } from '@/utils/prices';
import { numberLikeToNumber } from '@/utils/numbers';
import { getIndexProtocolProgramId, getNetworkLabel } from '@/utils/network';
import idl from '@/utils/idl/index_protocol.json';
import { STAGE1_MAX_ASSETS } from '@/utils/protocol';
import {
    hasDiscriminator,
    parseIndexConfigAccountData,
    ParsedIndexConfigAccountData,
} from '@/utils/index-config';

interface IndexConfigAccount {
    publicKey: PublicKey;
    account: ParsedIndexConfigAccountData;
}

interface IdlAccountEntry {
    name: string;
    discriminator: number[];
}

interface AllocationMetric {
    mint: string;
    symbol: string;
    price: number;
    usdValue: number;
    source: 'pyth' | 'jupiter' | 'mock';
    percentage: number;
}

interface IndexDisplayMetrics {
    allocations: AllocationMetric[];
    navPerShare: number;
    hasAllLiveAssetPrices: boolean;
}

const ALLOCATION_COLORS = [
    '#c9f65f',
    '#aeb2ff',
    '#7fd8ff',
    '#f8bb5c',
    '#ff87be',
    '#9ef19a',
    '#d6b4ff',
];

const INDEX_FETCH_TIMEOUT_MS = 12_000;
const STAGE1_MAX_ASSETS_HARD_CAP = STAGE1_MAX_ASSETS;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_MIN_SERIALIZED_BYTES = 72;
const TOKEN_ACCOUNT_SERIALIZED_BYTES = 165;
const HOME_SURFACE =
    'relative overflow-hidden rounded-[1.75rem] border border-white/18 bg-[linear-gradient(155deg,rgba(23,31,70,0.94)_0%,rgba(9,13,33,0.98)_62%)] shadow-[0_28px_80px_-45px_rgba(1,4,20,0.95),inset_0_1px_0_rgba(255,255,255,0.15)]';
const HOME_METRIC_CARD =
    'relative overflow-hidden rounded-2xl border border-white/16 bg-[linear-gradient(165deg,rgba(22,30,64,0.96),rgba(9,13,31,0.98))] px-3 py-3 sm:px-5 sm:py-5 shadow-[0_24px_58px_-40px_rgba(2,6,23,0.9),inset_0_1px_0_rgba(255,255,255,0.12)]';
const HOME_INDEX_CARD =
    'relative overflow-hidden rounded-[1.5rem] border border-white/16 bg-[linear-gradient(160deg,rgba(20,28,61,0.96),rgba(8,12,29,0.985))] shadow-[0_28px_70px_-42px_rgba(2,6,23,0.94),inset_0_1px_0_rgba(255,255,255,0.14)]';
const HOME_LABEL = 'text-[11px] uppercase tracking-[0.22em] text-zinc-300/85';
const HOME_SUBTEXT = 'text-zinc-200/85';
const HOME_MICRO = 'text-zinc-300/78';

function buildIndexDisplayMetrics(
    indexConfig: IndexConfigAccount,
    tokenByMint: Map<string, TokenMetadata>,
    priceByMint: Map<string, PriceData>
): IndexDisplayMetrics {
    const baseAllocations = indexConfig.account.assets.map((asset) => {
        const mint = asset.mint.toBase58();
        const token = tokenByMint.get(mint);
        const unitsAtomic = numberLikeToNumber(asset.units);
        const decimals = token?.decimals ?? 6;
        const humanAmount = unitsAtomic / Math.pow(10, decimals);
        const priceData = priceByMint.get(mint);
        const price = Number.isFinite(priceData?.price) ? Number(priceData?.price) : 0;
        const usdValue = humanAmount * price;
        const source =
            priceData?.source === 'pyth' || priceData?.source === 'jupiter' ? priceData.source : 'mock';

        return {
            mint,
            symbol: token?.symbol || `${mint.slice(0, 4)}...${mint.slice(-4)}`,
            price,
            usdValue,
            source,
        };
    });

    const navPerShare = baseAllocations.reduce((sum, allocation) => sum + allocation.usdValue, 0);
    const allocations = baseAllocations.map((allocation) => ({
        ...allocation,
        percentage: navPerShare > 0 ? (allocation.usdValue / navPerShare) * 100 : 0,
    }));
    const hasAllLiveAssetPrices =
        allocations.length > 0 &&
        allocations.every(
            (allocation) =>
                allocation.source !== 'mock' &&
                Number.isFinite(allocation.price) &&
                allocation.price > 0
        );

    return {
        allocations,
        navPerShare,
        hasAllLiveAssetPrices,
    };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
    });
}

function readU64LittleEndian(data: Uint8Array, offset: number): bigint | null {
    if (offset + 8 > data.length) return null;
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
        value |= BigInt(data[offset + i]) << BigInt(8 * i);
    }
    return value;
}

function appendTokenAccountHolders(
    accounts: Array<{ account: { data: Uint8Array } }>,
    holders: Set<string>
): void {
    for (const raw of accounts) {
        const data = raw.account.data;
        if (data.length < TOKEN_ACCOUNT_MIN_SERIALIZED_BYTES) continue;

        const amount = readU64LittleEndian(data, TOKEN_ACCOUNT_AMOUNT_OFFSET);
        if (amount === null || amount <= 0n) continue;

        const ownerBytes = data.slice(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + 32);
        holders.add(new PublicKey(ownerBytes).toBase58());
    }
}

function formatCompactUsd(value: number): string {
    if (!Number.isFinite(value)) return '$0.0';
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);

    if (abs >= 1_000_000_000_000) return `${sign}$${(abs / 1_000_000_000_000).toFixed(1)}T`;
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(1)}`;
}

export default function Dashboard() {
    const { connection } = useConnection();
    const [indexes, setIndexes] = useState<IndexConfigAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [indexSupplyByMint, setIndexSupplyByMint] = useState<Map<string, number>>(new Map());
    const [indexSupplyLoading, setIndexSupplyLoading] = useState(false);
    const [indexInvestorCountByMint, setIndexInvestorCountByMint] = useState<Map<string, number>>(new Map());
    const [indexInvestorLoading, setIndexInvestorLoading] = useState(false);
    const networkLabel = getNetworkLabel();
    const showDevnetCluster = networkLabel === 'Devnet';
    const programId = useMemo(() => new PublicKey(getIndexProtocolProgramId()), []);
    const idlAccounts = useMemo(
        () => (((idl as unknown as { accounts?: IdlAccountEntry[] }).accounts) ?? []),
        []
    );
    const indexConfigDiscriminatorBytes = useMemo(() => {
        const entry = idlAccounts.find((a) => a.name === 'IndexConfig');
        if (!entry || !Array.isArray(entry.discriminator) || entry.discriminator.length !== 8) return null;
        return Uint8Array.from(entry.discriminator);
    }, [idlAccounts]);
    const indexConfigDiscriminator = useMemo(
        () => (indexConfigDiscriminatorBytes ? bs58.encode(indexConfigDiscriminatorBytes) : null),
        [indexConfigDiscriminatorBytes]
    );

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(null);

        const fetchIndexes = async () => {
            try {
                if (!indexConfigDiscriminator) {
                    throw new Error('IndexConfig discriminator is missing in IDL.');
                }
                const rawAccounts = await withTimeout(
                    connection.getProgramAccounts(programId, {
                        filters: [
                            {
                                memcmp: {
                                    offset: 0,
                                    bytes: indexConfigDiscriminator,
                                },
                            },
                        ],
                    }),
                    INDEX_FETCH_TIMEOUT_MS,
                    'getProgramAccounts'
                );

                const decoded: IndexConfigAccount[] = [];
                for (const raw of rawAccounts) {
                    const accountData = raw.account.data as Uint8Array;
                    if (!hasDiscriminator(accountData, indexConfigDiscriminatorBytes ?? new Uint8Array())) continue;
                    const account = parseIndexConfigAccountData(accountData, STAGE1_MAX_ASSETS_HARD_CAP);
                    if (!account) {
                        console.warn('Skipped undecodable IndexConfig account', raw.pubkey.toBase58());
                        continue;
                    }
                    decoded.push({ publicKey: raw.pubkey, account });
                }

                if (!cancelled) {
                    setIndexes(decoded.filter((indexConfig) => !indexConfig.account.paused));
                }
            } catch (err) {
                console.error('Failed to fetch indexes:', err);
                if (!cancelled) {
                    setIndexes([]);
                    setLoadError('Unable to fetch index list from RPC right now.');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchIndexes();
        return () => {
            cancelled = true;
        };
    }, [connection, programId, indexConfigDiscriminator, indexConfigDiscriminatorBytes]);

    const totalAssets = useMemo(
        () => indexes.reduce((sum, idx) => sum + idx.account.assets.length, 0),
        [indexes]
    );
    const indexAssetMints = useMemo(
        () =>
            Array.from(
                new Set(
                    indexes.flatMap((idx) => idx.account.assets.map((asset) => asset.mint.toBase58()))
                )
            ),
        [indexes]
    );
    const { tokenMap: tokenMetadataByMint } = useTokenMetadataMap(indexAssetMints);
    const marketPriceQueries = useMemo<PriceQuery[]>(
        () =>
            indexAssetMints.map((mint) => {
                const pythSymbol = tokenMetadataByMint.get(mint)?.symbol;
                return pythSymbol ? { key: mint, pythSymbol } : { key: mint };
            }),
        [indexAssetMints, tokenMetadataByMint]
    );
    const { prices: marketPricesByMint, isLoading: marketPricesLoading } = usePythPrices({
        queries: marketPriceQueries,
    });
    const indexDisplayMetrics = useMemo(() => {
        const metrics = new Map<string, IndexDisplayMetrics>();
        for (const indexConfig of indexes) {
            metrics.set(
                indexConfig.publicKey.toBase58(),
                buildIndexDisplayMetrics(indexConfig, tokenMetadataByMint, marketPricesByMint)
            );
        }
        return metrics;
    }, [indexes, tokenMetadataByMint, marketPricesByMint]);

    useEffect(() => {
        let cancelled = false;

        const indexMints = indexes.map((idx) => idx.account.indexMint.toBase58());
        if (indexMints.length === 0) {
            setIndexSupplyByMint(new Map());
            setIndexInvestorCountByMint(new Map());
            setIndexSupplyLoading(false);
            setIndexInvestorLoading(false);
            return () => {
                cancelled = true;
            };
        }

        const fetchIndexStats = async () => {
            setIndexSupplyLoading(true);
            setIndexInvestorLoading(true);

            try {
                const [supplyResults, investorResults] = await Promise.all([
                    Promise.all(
                        indexMints.map(async (mint) => {
                            try {
                                const supply = await connection.getTokenSupply(new PublicKey(mint));
                                const parsed = Number.parseFloat(supply.value.uiAmountString ?? '0');
                                return [mint, Number.isFinite(parsed) ? parsed : 0] as const;
                            } catch (error) {
                                console.warn('Failed to fetch index mint supply', mint, error);
                                return [mint, Number.NaN] as const;
                            }
                        })
                    ),
                    Promise.all(
                        indexMints.map(async (mint) => {
                            try {
                                const [tokenAccounts, token2022Accounts] = await Promise.all([
                                    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
                                        filters: [
                                            { memcmp: { offset: 0, bytes: mint } },
                                            { dataSize: TOKEN_ACCOUNT_SERIALIZED_BYTES },
                                        ],
                                    }),
                                    connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
                                        filters: [{ memcmp: { offset: 0, bytes: mint } }],
                                    }),
                                ]);

                                const holders = new Set<string>();
                                appendTokenAccountHolders(
                                    tokenAccounts as Array<{ account: { data: Uint8Array } }>,
                                    holders
                                );
                                appendTokenAccountHolders(
                                    token2022Accounts as Array<{ account: { data: Uint8Array } }>,
                                    holders
                                );
                                return [mint, holders.size] as const;
                            } catch (error) {
                                console.warn('Failed to fetch investor count for index mint', mint, error);
                                return [mint, Number.NaN] as const;
                            }
                        })
                    ),
                ]);

                if (!cancelled) {
                    const supplyNext = new Map<string, number>();
                    for (const [mint, supply] of supplyResults) {
                        if (Number.isFinite(supply)) supplyNext.set(mint, supply);
                    }
                    setIndexSupplyByMint(supplyNext);

                    const investorNext = new Map<string, number>();
                    for (const [mint, investorCount] of investorResults) {
                        if (Number.isFinite(investorCount)) investorNext.set(mint, investorCount);
                    }
                    setIndexInvestorCountByMint(investorNext);
                }
            } finally {
                if (!cancelled) {
                    setIndexSupplyLoading(false);
                    setIndexInvestorLoading(false);
                }
            }
        };

        fetchIndexStats();
        return () => {
            cancelled = true;
        };
    }, [connection, indexes]);

    const indexTvlByConfig = useMemo(() => {
        const tvlByConfig = new Map<string, number>();

        for (const indexConfig of indexes) {
            const configKey = indexConfig.publicKey.toBase58();
            const metrics = indexDisplayMetrics.get(configKey);
            if (!metrics?.hasAllLiveAssetPrices) continue;

            const supply = indexSupplyByMint.get(indexConfig.account.indexMint.toBase58());
            if (typeof supply !== 'number' || !Number.isFinite(supply)) continue;

            tvlByConfig.set(configKey, Math.max(metrics.navPerShare * supply, 0));
        }

        return tvlByConfig;
    }, [indexes, indexDisplayMetrics, indexSupplyByMint]);

    const indexInvestorByConfig = useMemo(() => {
        const investorByConfig = new Map<string, number>();
        for (const indexConfig of indexes) {
            const mint = indexConfig.account.indexMint.toBase58();
            const investorCount = indexInvestorCountByMint.get(mint);
            if (typeof investorCount !== 'number' || !Number.isFinite(investorCount)) continue;
            investorByConfig.set(indexConfig.publicKey.toBase58(), investorCount);
        }
        return investorByConfig;
    }, [indexes, indexInvestorCountByMint]);

    const totalTvlSummary = useMemo(() => {
        let coveredIndexes = 0;
        let totalTvl = 0;

        for (const indexConfig of indexes) {
            const tvl = indexTvlByConfig.get(indexConfig.publicKey.toBase58());
            if (typeof tvl !== 'number' || !Number.isFinite(tvl)) continue;
            coveredIndexes += 1;
            totalTvl += tvl;
        }

        return {
            coveredIndexes,
            totalIndexes: indexes.length,
            totalTvl,
        };
    }, [indexes, indexTvlByConfig]);

    if (loading) {
        return (
            <div className="grid min-h-[55vh] place-items-center">
                <div className="size-10 animate-spin rounded-full border-2 border-lime-200/25 border-t-lime-200" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <header className={`${HOME_SURFACE} p-6 md:p-8`}>
                <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/12 to-transparent" />
                <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className={HOME_LABEL}>Stage 1 marketplace</p>
                            {showDevnetCluster ? (
                                <span className="inline-flex rounded-full border border-lime-300/40 bg-lime-300/15 px-2 py-1 text-[11px] font-medium text-lime-200">
                                    Cluster: {networkLabel}
                                </span>
                            ) : null}
                        </div>
                        <h1 className="section-title">Discover live index baskets</h1>
                        <p className={`max-w-2xl text-lg ${HOME_SUBTEXT}`}>
                            Focus on the numbers that matter: basket composition, fees, and current NAV per share.
                        </p>
                    </div>
                    <Link href="/create" className="btn-primary w-fit">
                        Create index
                        <Sparkles size={16} />
                    </Link>
                </div>
            </header>

            <section className="grid grid-cols-3 gap-2 sm:gap-3">
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/10 to-transparent sm:h-10" />
                    <p className={`${HOME_LABEL} mb-2`}>
                        <span className="max-[500px]:block">Live</span>{' '}
                        <span className="max-[500px]:block">Indexes</span>
                    </p>
                    <p className="relative z-10 text-2xl font-semibold text-white sm:text-3xl">{indexes.length}</p>
                </div>
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/10 to-transparent sm:h-10" />
                    <p className={`${HOME_LABEL} mb-2`}>
                        <span className="max-[500px]:block">Basket</span>{' '}
                        <span className="max-[500px]:block">Assets</span>
                    </p>
                    <p className="relative z-10 text-2xl font-semibold text-white sm:text-3xl">{totalAssets}</p>
                </div>
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/10 to-transparent sm:h-10" />
                    <p className={`${HOME_LABEL} mb-2`}>
                        <span className="max-[500px]:block">Total</span>{' '}
                        <span className="max-[500px]:block">TVL</span>
                    </p>
                    {indexes.length === 0 || totalTvlSummary.coveredIndexes > 0 ? (
                        <p className="relative z-10 text-2xl font-semibold text-white sm:text-3xl">
                            {formatCompactUsd(totalTvlSummary.totalTvl)}
                        </p>
                    ) : marketPricesLoading || indexSupplyLoading ? (
                        <p className={`relative z-10 text-xs ${HOME_SUBTEXT}`}>Loading...</p>
                    ) : (
                        <p className="relative z-10 text-xs text-amber-200/85">Unavailable</p>
                    )}
                    {totalTvlSummary.coveredIndexes > 0 &&
                    totalTvlSummary.coveredIndexes < totalTvlSummary.totalIndexes ? (
                        <p className={`relative z-10 mt-1 text-[10px] ${HOME_MICRO}`}>
                            {totalTvlSummary.coveredIndexes}/{totalTvlSummary.totalIndexes} indexed
                        </p>
                    ) : null}
                </div>
            </section>

            {indexes.length === 0 ? (
                <section className={`${HOME_SURFACE} p-12 text-center`}>
                    <Layers className="mx-auto mb-4 text-zinc-300/85" size={30} />
                    <h2 className="text-xl font-semibold text-white">No indexes yet</h2>
                    <p className={`mt-2 text-sm ${HOME_SUBTEXT}`}>Create the first basket and it will appear here instantly.</p>
                    {loadError ? <p className="mt-3 text-xs text-amber-300">{loadError}</p> : null}
                    <Link href="/create" className="btn-primary mt-6">
                        Launch first index
                    </Link>
                </section>
            ) : (
                <section className="rounded-[1.7rem] border border-white/12 bg-black/20 p-3 shadow-[0_30px_80px_-55px_rgba(1,4,20,0.95)] md:p-4">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {indexes.map((idx) => {
                            const cardKey = idx.publicKey.toBase58();
                            return (
                                <IndexCard
                                    key={cardKey}
                                    data={idx}
                                    metrics={indexDisplayMetrics.get(cardKey)}
                                    tvlUsd={indexTvlByConfig.get(cardKey)}
                                    investorCount={indexInvestorByConfig.get(cardKey)}
                                    pricesLoading={marketPricesLoading}
                                    indexSupplyLoading={indexSupplyLoading}
                                    indexInvestorLoading={indexInvestorLoading}
                                />
                            );
                        })}
                    </div>
                </section>
            )}
        </div>
    );
}

function IndexCard({
    data,
    metrics,
    tvlUsd,
    investorCount,
    pricesLoading,
    indexSupplyLoading,
    indexInvestorLoading,
}: {
    data: IndexConfigAccount;
    metrics: IndexDisplayMetrics | undefined;
    tvlUsd: number | undefined;
    investorCount: number | undefined;
    pricesLoading: boolean;
    indexSupplyLoading: boolean;
    indexInvestorLoading: boolean;
}) {
    const indexName = data.account.name?.trim() || `Index #${data.publicKey.toBase58().slice(0, 4)}`;
    const allocations = metrics?.allocations ?? [];
    const totalNav = metrics?.navPerShare ?? 0;
    const hasAllLiveAssetPrices = metrics?.hasAllLiveAssetPrices ?? false;
    const showLoading = !hasAllLiveAssetPrices && pricesLoading;
    const showTvlLoading = typeof tvlUsd !== 'number' && (indexSupplyLoading || showLoading);
    return (
        <Link
            href={`/index/${data.account.indexMint.toBase58()}`}
            className={`${HOME_INDEX_CARD} group flex h-full flex-col gap-5 p-5 transition hover:-translate-y-0.5 hover:border-lime-300/55 hover:shadow-[0_35px_88px_-46px_rgba(2,6,23,0.98),inset_0_1px_0_rgba(255,255,255,0.2)]`}
        >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/12 to-transparent" />
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-lg font-semibold text-white">{indexName}</h3>
                    <p className={`mt-1 truncate text-xs ${HOME_MICRO}`}>
                        {data.account.indexMint.toBase58().slice(0, 8)}...{data.account.indexMint.toBase58().slice(-4)}
                    </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="inline-flex rounded-full border border-indigo-200/35 bg-indigo-200/15 px-2.5 py-1 text-xs font-medium text-indigo-100">
                        {data.account.assets.length} assets
                    </span>
                    <span className="inline-flex rounded-full border border-lime-200/30 bg-lime-200/12 px-2.5 py-1 text-xs font-medium text-lime-100">
                        {typeof investorCount === 'number'
                            ? `${investorCount.toLocaleString()} investors`
                            : indexInvestorLoading
                              ? 'Investors...'
                              : 'Investors n/a'}
                    </span>
                </div>
            </div>

            {data.account.paused ? (
                <span className="w-fit rounded-full border border-amber-300/40 bg-amber-300/15 px-2.5 py-1 text-xs font-medium text-amber-200">
                    Paused
                </span>
            ) : null}

            <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                    <p className={HOME_LABEL}>Price</p>
                    {hasAllLiveAssetPrices ? (
                        <p className="text-2xl font-semibold tracking-tight text-zinc-50">{formatUsd(totalNav)}</p>
                    ) : showLoading ? (
                        <p className="text-sm text-zinc-200/85">Loading live prices...</p>
                    ) : (
                        <p className="text-sm text-amber-200/85">Live prices unavailable</p>
                    )}
                </div>
                <div className="space-y-1">
                    <p className={HOME_LABEL}>TVL</p>
                    {typeof tvlUsd === 'number' ? (
                        <p className="text-2xl font-semibold tracking-tight text-lime-100">{formatUsd(tvlUsd)}</p>
                    ) : showTvlLoading ? (
                        <p className="text-sm text-zinc-200/85">Loading TVL...</p>
                    ) : (
                        <p className="text-sm text-amber-200/85">TVL unavailable</p>
                    )}
                </div>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-black/45 ring-1 ring-white/8">
                <div className="flex h-full w-full">
                    {hasAllLiveAssetPrices ? (
                        allocations.map((alloc, i) => (
                            <div
                                key={alloc.mint}
                                style={{ width: `${alloc.percentage}%`, background: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }}
                                title={`${alloc.symbol}: ${alloc.percentage.toFixed(1)}%`}
                            />
                        ))
                    ) : (
                        <div className="h-full w-full bg-white/20" />
                    )}
                </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {allocations.slice(0, 4).map((alloc, i) => (
                    <span
                        key={alloc.mint}
                        className="inline-flex items-center gap-1 rounded-full border border-white/8 bg-black/35 px-2 py-1 text-[11px] text-zinc-200"
                    >
                        <span
                            className="size-1.5 rounded-full"
                            style={{ background: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }}
                        />
                        {alloc.symbol} {hasAllLiveAssetPrices ? `${alloc.percentage.toFixed(0)}%` : ''}
                    </span>
                ))}
                {allocations.length > 4 ? (
                    <span className="inline-flex items-center rounded-full border border-white/8 bg-black/35 px-2 py-1 text-[11px] text-zinc-300/85">
                        +{allocations.length - 4}
                    </span>
                ) : null}
            </div>

            <div className="data-divider mt-auto flex items-center justify-between pt-4 text-sm">
                <div>
                    <p className={HOME_MICRO}>Trade fee</p>
                    <p className="font-semibold text-zinc-100">{(data.account.tradeFeeBps / 100).toFixed(2)}%</p>
                </div>
                <span className="inline-flex items-center gap-1 text-lime-200">
                    View
                    <ArrowRight size={14} />
                </span>
            </div>
        </Link>
    );
}
