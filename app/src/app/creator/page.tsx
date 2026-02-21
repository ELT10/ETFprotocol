'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { ArrowRight, Coins, Wallet } from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { TokenMetadata, useTokenMetadataMap } from '@/hooks/useTokenMetadataMap';
import { calculateAllocations, formatUsd } from '@/utils/prices';
import { getIndexProtocolProgramId } from '@/utils/network';
import { numberLikeToNumber } from '@/utils/numbers';
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

const INDEX_FETCH_TIMEOUT_MS = 12_000;
const STAGE1_MAX_ASSETS_HARD_CAP = STAGE1_MAX_ASSETS;
const INDEX_SHARE_SCALE = 1_000_000;

const ALLOCATION_COLORS = [
    '#c9f65f',
    '#aeb2ff',
    '#7fd8ff',
    '#f8bb5c',
    '#ff87be',
    '#9ef19a',
    '#d6b4ff',
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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

function feeSharesToHuman(value: unknown): number {
    return numberLikeToNumber(value) / INDEX_SHARE_SCALE;
}

export default function CreatorDashboardPage() {
    const { connection } = useConnection();
    const wallet = useWallet();
    const walletPublicKey = wallet.publicKey;
    const [indexes, setIndexes] = useState<IndexConfigAccount[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
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
        if (!walletPublicKey) {
            setIndexes([]);
            setLoading(false);
            setLoadError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setLoadError(null);

        const fetchCreatedIndexes = async () => {
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
                    if (!account) continue;
                    const creatorKey = account.creator ?? account.admin;
                    if (!creatorKey.equals(walletPublicKey)) continue;
                    decoded.push({ publicKey: raw.pubkey, account });
                }

                if (!cancelled) setIndexes(decoded);
            } catch (err) {
                console.error('Failed to fetch creator indexes:', err);
                if (!cancelled) {
                    setIndexes([]);
                    setLoadError('Unable to fetch creator indexes right now.');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchCreatedIndexes();
        return () => {
            cancelled = true;
        };
    }, [walletPublicKey, connection, programId, indexConfigDiscriminator, indexConfigDiscriminatorBytes]);

    const lifetimeFeeShares = useMemo(
        () => indexes.reduce((sum, idx) => sum + feeSharesToHuman(idx.account.lifetimeFeeSharesTotal), 0),
        [indexes]
    );
    const creatorAssetMints = useMemo(
        () =>
            Array.from(
                new Set(
                    indexes.flatMap((idx) => idx.account.assets.map((asset) => asset.mint.toBase58()))
                )
            ),
        [indexes]
    );
    const { tokenMap: tokenMetadataByMint } = useTokenMetadataMap(creatorAssetMints);

    const lifetimeFeeUsdEstimate = useMemo(() => {
        return indexes.reduce((sum, idx) => {
            const assets = idx.account.assets.map((a) => {
                const mintStr = a.mint.toBase58();
                const token = tokenMetadataByMint.get(mintStr);
                return {
                    mint: mintStr,
                    units: numberLikeToNumber(a.units),
                    symbol: token?.symbol || `${mintStr.slice(0, 4)}...${mintStr.slice(-4)}`,
                    decimals: token?.decimals ?? 6,
                };
            });
            const allocations = calculateAllocations(assets);
            const navPerShare = allocations.reduce((acc, item) => acc + item.usdValue, 0);
            const feeShares = feeSharesToHuman(idx.account.lifetimeFeeSharesTotal);
            return sum + feeShares * navPerShare;
        }, 0);
    }, [indexes, tokenMetadataByMint]);

    if (!walletPublicKey) {
        return (
            <div className="glass-card mx-auto max-w-3xl p-10 text-center">
                <Wallet className="mx-auto mb-4 text-zinc-300/85" />
                <h2 className="display-font text-2xl font-semibold text-white">Connect wallet</h2>
                <p className="mt-2 text-zinc-200/85">View your created indexes and fee revenue after connecting.</p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="grid min-h-[50vh] place-items-center">
                <div className="size-9 animate-spin rounded-full border-2 border-lime-200/25 border-t-lime-200" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <header className="glass-card p-6 md:p-8">
                <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                    <div>
                        <p className="section-label mb-2">Creator analytics</p>
                        <h1 className="section-title">Performance of your indexes</h1>
                        <p className="section-subtitle mt-2">Monitor fee generation and discover high-conversion baskets.</p>
                    </div>
                    <Link href="/create" className="btn-primary w-fit">
                        Create index
                    </Link>
                </div>
            </header>

            <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="metric-card">
                    <p className="section-label mb-2">Indexes created</p>
                    <p className="text-3xl font-semibold text-white">{indexes.length}</p>
                </div>
                <div className="metric-card">
                    <p className="section-label mb-2">Lifetime fee shares</p>
                    <p className="text-3xl font-semibold text-lime-200">{lifetimeFeeShares.toFixed(4)}</p>
                </div>
                <div className="metric-card">
                    <p className="section-label mb-2">Estimated fee value</p>
                    <p className="text-3xl font-semibold text-indigo-100">{formatUsd(lifetimeFeeUsdEstimate)}</p>
                </div>
            </section>

            {indexes.length === 0 ? (
                <section className="glass-card py-16 text-center">
                    <Coins className="mx-auto mb-4 text-zinc-300/85" />
                    <h2 className="text-xl font-semibold text-white">No created indexes yet</h2>
                    <p className="mt-2 text-sm text-zinc-200/85">Launch your first index to start collecting trade fees.</p>
                    {loadError ? <p className="mt-3 text-xs text-amber-300">{loadError}</p> : null}
                </section>
            ) : (
                <section className="list-panel">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {indexes.map((idx) => (
                            <CreatorIndexCard
                                key={idx.publicKey.toBase58()}
                                data={idx}
                                tokenByMint={tokenMetadataByMint}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function CreatorIndexCard({
    data,
    tokenByMint,
}: {
    data: IndexConfigAccount;
    tokenByMint: Map<string, TokenMetadata>;
}) {
    const indexName = data.account.name?.trim() || `Index #${data.publicKey.toBase58().slice(0, 4)}`;

    const allocations = useMemo(() => {
        const assets = data.account.assets.map((a) => {
            const mintStr = a.mint.toBase58();
            const token = tokenByMint.get(mintStr);
            return {
                mint: mintStr,
                units: numberLikeToNumber(a.units),
                symbol: token?.symbol || `${mintStr.slice(0, 4)}...${mintStr.slice(-4)}`,
                decimals: token?.decimals ?? 6,
            };
        });
        return calculateAllocations(assets);
    }, [data.account.assets, tokenByMint]);

    const navPerShare = useMemo(() => allocations.reduce((sum, item) => sum + item.usdValue, 0), [allocations]);
    const lifetimeFeeShares = feeSharesToHuman(data.account.lifetimeFeeSharesTotal);
    const lifetimeFeeUsd = lifetimeFeeShares * navPerShare;

    return (
        <Link
            href={`/index/${data.account.indexMint.toBase58()}`}
            className="glass-card strong-hover group flex h-full flex-col gap-4 p-5"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="truncate text-lg font-semibold text-white">{indexName}</h3>
                    <p className="mt-1 text-xs text-zinc-300/85">
                        {data.account.indexMint.toBase58().slice(0, 8)}...{data.account.indexMint.toBase58().slice(-4)}
                    </p>
                </div>
                <span className="shrink-0 rounded-full border border-indigo-200/30 bg-indigo-200/10 px-2.5 py-1 text-xs font-medium text-indigo-100">
                    {(data.account.tradeFeeBps / 100).toFixed(2)}%
                </span>
            </div>

            {data.account.description?.trim() ? (
                <p className="text-sm text-zinc-200/85">{data.account.description.trim()}</p>
            ) : null}

            <div className="h-2 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/10">
                <div className="flex h-full w-full">
                    {allocations.map((alloc, i) => (
                        <div
                            key={alloc.mint}
                            style={{ width: `${alloc.percentage}%`, background: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }}
                        />
                    ))}
                </div>
            </div>

            <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                    <span className="text-zinc-300/85">Lifetime shares</span>
                    <span className="font-medium text-lime-200">{lifetimeFeeShares.toFixed(4)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-zinc-300/85">Estimated value</span>
                    <span className="font-medium text-zinc-100">{formatUsd(lifetimeFeeUsd)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-zinc-300/85">Collector</span>
                    <span className="text-xs font-mono text-zinc-300">
                        {data.account.feeCollector.toBase58().slice(0, 6)}...{data.account.feeCollector.toBase58().slice(-4)}
                    </span>
                </div>
            </div>

            <div className="strong-divider mt-auto flex items-center justify-between pt-4 text-sm text-lime-200">
                <span>Open index</span>
                <ArrowRight size={15} />
            </div>
        </Link>
    );
}
