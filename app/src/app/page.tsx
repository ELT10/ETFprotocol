'use client';

import { useEffect, useState, useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { ArrowRight, Layers, Sparkles } from 'lucide-react';
import { useConnection } from '@solana/wallet-adapter-react';
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
const HOME_SURFACE =
    'relative overflow-hidden rounded-[1.75rem] border border-white/18 bg-[linear-gradient(155deg,rgba(23,31,70,0.94)_0%,rgba(9,13,33,0.98)_62%)] shadow-[0_28px_80px_-45px_rgba(1,4,20,0.95),inset_0_1px_0_rgba(255,255,255,0.15)]';
const HOME_METRIC_CARD =
    'relative overflow-hidden rounded-2xl border border-white/16 bg-[linear-gradient(165deg,rgba(22,30,64,0.96),rgba(9,13,31,0.98))] px-5 py-5 shadow-[0_24px_58px_-40px_rgba(2,6,23,0.9),inset_0_1px_0_rgba(255,255,255,0.12)]';
const HOME_INDEX_CARD =
    'relative overflow-hidden rounded-[1.5rem] border border-white/16 bg-[linear-gradient(160deg,rgba(20,28,61,0.96),rgba(8,12,29,0.985))] shadow-[0_28px_70px_-42px_rgba(2,6,23,0.94),inset_0_1px_0_rgba(255,255,255,0.14)]';
const HOME_LABEL = 'text-[11px] uppercase tracking-[0.22em] text-zinc-300/85';
const HOME_SUBTEXT = 'text-zinc-200/85';
const HOME_MICRO = 'text-zinc-300/78';

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

export default function Dashboard() {
    const { connection } = useConnection();
    const [indexes, setIndexes] = useState<IndexConfigAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const networkLabel = getNetworkLabel();
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
                        <p className={HOME_LABEL}>Stage 1 marketplace</p>
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

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/10 to-transparent" />
                    <p className={`${HOME_LABEL} mb-2`}>Live indexes</p>
                    <p className="relative z-10 text-3xl font-semibold text-white">{indexes.length}</p>
                </div>
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/10 to-transparent" />
                    <p className={`${HOME_LABEL} mb-2`}>Basket assets</p>
                    <p className="relative z-10 text-3xl font-semibold text-white">{totalAssets}</p>
                </div>
                <div className={HOME_METRIC_CARD}>
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/10 to-transparent" />
                    <p className={`${HOME_LABEL} mb-2`}>Cluster</p>
                    <p className="relative z-10 text-3xl font-semibold text-lime-200">{networkLabel}</p>
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
                        {indexes.map((idx) => (
                            <IndexCard
                                key={idx.publicKey.toBase58()}
                                data={idx}
                                tokenByMint={tokenMetadataByMint}
                                priceByMint={marketPricesByMint}
                                pricesLoading={marketPricesLoading}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function IndexCard({
    data,
    tokenByMint,
    priceByMint,
    pricesLoading,
}: {
    data: IndexConfigAccount;
    tokenByMint: Map<string, TokenMetadata>;
    priceByMint: Map<string, PriceData>;
    pricesLoading: boolean;
}) {
    const indexName = data.account.name?.trim() || `Index #${data.publicKey.toBase58().slice(0, 4)}`;

    const allocations = useMemo(() => {
        const assets = data.account.assets.map((a) => {
            const mintStr = a.mint.toBase58();
            const token = tokenByMint.get(mintStr);
            const unitsAtomic = numberLikeToNumber(a.units);
            const decimals = token?.decimals ?? 6;
            const humanAmount = unitsAtomic / Math.pow(10, decimals);
            const priceData = priceByMint.get(mintStr);
            const price = Number.isFinite(priceData?.price) ? Number(priceData?.price) : 0;
            const usdValue = humanAmount * price;
            return {
                mint: mintStr,
                units: unitsAtomic,
                symbol: token?.symbol || `${mintStr.slice(0, 4)}...${mintStr.slice(-4)}`,
                decimals,
                price,
                usdValue,
                source: (priceData?.source || 'mock') as 'pyth' | 'jupiter' | 'mock',
            };
        });

        const totalUsdValue = assets.reduce((sum, asset) => sum + asset.usdValue, 0);
        return assets.map((asset) => ({
            ...asset,
            percentage: totalUsdValue > 0 ? (asset.usdValue / totalUsdValue) * 100 : 0,
        }));
    }, [data.account.assets, tokenByMint, priceByMint]);

    const totalNav = useMemo(() => {
        return allocations.reduce((sum, a) => sum + a.usdValue, 0);
    }, [allocations]);
    const hasAllLiveAssetPrices = useMemo(
        () =>
            allocations.length > 0 &&
            allocations.every((alloc) => alloc.source !== 'mock' && Number.isFinite(alloc.price) && alloc.price > 0),
        [allocations]
    );
    const showLoading = !hasAllLiveAssetPrices && pricesLoading;
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
                <span className="inline-flex shrink-0 rounded-full border border-indigo-200/35 bg-indigo-200/15 px-2.5 py-1 text-xs font-medium text-indigo-100">
                    {data.account.assets.length} assets
                </span>
            </div>

            {data.account.paused ? (
                <span className="w-fit rounded-full border border-amber-300/40 bg-amber-300/15 px-2.5 py-1 text-xs font-medium text-amber-200">
                    Paused
                </span>
            ) : null}

            <div className="space-y-1">
                <p className={HOME_LABEL}>NAV per share</p>
                {hasAllLiveAssetPrices ? (
                    <p className="text-3xl font-semibold tracking-tight text-zinc-50">{formatUsd(totalNav)}</p>
                ) : showLoading ? (
                    <p className="text-sm text-zinc-200/85">Loading live prices...</p>
                ) : (
                    <p className="text-sm text-amber-200/85">Live prices unavailable</p>
                )}
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
