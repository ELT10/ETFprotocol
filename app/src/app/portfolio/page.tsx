'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import Link from 'next/link';
import { ArrowRight, Briefcase, Loader2, Wallet } from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { useTokenMetadataMap } from '@/hooks/useTokenMetadataMap';
import { formatUsd, getTokenPrice } from '@/utils/prices';
import { getIndexProtocolProgramId } from '@/utils/network';
import idl from '@/utils/idl/index_protocol.json';
import { INDEX_SHARE_DECIMALS, STAGE1_MAX_ASSETS } from '@/utils/protocol';
import {
    hasDiscriminator,
    parseIndexConfigAccountData,
    ParsedIndexConfigAccountData,
} from '@/utils/index-config';
import { useWalletMintBalances } from '@/hooks/useWalletMintBalances';

interface IndexConfigAccount {
    publicKey: PublicKey;
    account: ParsedIndexConfigAccountData;
}

interface IdlAccountEntry {
    name: string;
    discriminator: number[];
}

interface PortfolioHolding {
    indexName: string;
    indexMint: string;
    description: string;
    assetsCount: number;
    shareBalanceHuman: string;
    shareBalanceNumeric: number;
    navPerShare: number;
    estimatedUsdValue: number;
    paused: boolean;
}

const INDEX_FETCH_TIMEOUT_MS = 12_000;
const STAGE1_MAX_ASSETS_HARD_CAP = STAGE1_MAX_ASSETS;

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

function atomicToHumanString(amount: bigint, decimals: number): string {
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    if (fraction === BigInt(0)) return whole.toString();
    const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fractionPadded}`;
}

export default function PortfolioPage() {
    const { connection } = useConnection();
    const wallet = useWallet();
    const walletAddress = wallet.publicKey?.toBase58() ?? null;
    const [indexes, setIndexes] = useState<IndexConfigAccount[]>([]);
    const [indexesLoading, setIndexesLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const programId = useMemo(() => new PublicKey(getIndexProtocolProgramId()), []);
    const idlAccounts = useMemo(
        () => (((idl as unknown as { accounts?: IdlAccountEntry[] }).accounts) ?? []),
        []
    );
    const indexConfigDiscriminatorBytes = useMemo(() => {
        const entry = idlAccounts.find((account) => account.name === 'IndexConfig');
        if (!entry || !Array.isArray(entry.discriminator) || entry.discriminator.length !== 8) return null;
        return Uint8Array.from(entry.discriminator);
    }, [idlAccounts]);
    const indexConfigDiscriminator = useMemo(
        () => (indexConfigDiscriminatorBytes ? bs58.encode(indexConfigDiscriminatorBytes) : null),
        [indexConfigDiscriminatorBytes]
    );
    const portfolioAssetMints = useMemo(
        () =>
            Array.from(
                new Set(
                    indexes.flatMap((idx) => idx.account.assets.map((asset) => asset.mint.toBase58()))
                )
            ),
        [indexes]
    );
    const { tokenMap: tokenByMint } = useTokenMetadataMap(portfolioAssetMints);
    const { initialized: balancesInitialized, loading: balancesLoading, getMintBalanceAtomic } = useWalletMintBalances();

    useEffect(() => {
        let cancelled = false;
        setIndexesLoading(true);
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
                    if (!account) continue;
                    decoded.push({ publicKey: raw.pubkey, account });
                }

                if (!cancelled) {
                    setIndexes(decoded);
                }
            } catch (error: unknown) {
                console.error('Failed to fetch indexes:', error);
                if (!cancelled) {
                    setIndexes([]);
                    setLoadError('Unable to fetch index list from RPC right now.');
                }
            } finally {
                if (!cancelled) {
                    setIndexesLoading(false);
                }
            }
        };

        void fetchIndexes();
        return () => {
            cancelled = true;
        };
    }, [connection, programId, indexConfigDiscriminator, indexConfigDiscriminatorBytes]);

    const holdings = useMemo<PortfolioHolding[]>(() => {
        if (!walletAddress || !balancesInitialized) return [];

        const rows: PortfolioHolding[] = [];
        for (const index of indexes) {
            const indexMint = index.account.indexMint.toBase58();
            const shareBalanceAtomic = getMintBalanceAtomic(indexMint);
            if (shareBalanceAtomic <= BigInt(0)) continue;

            const shareBalanceNumeric = Number(shareBalanceAtomic) / Math.pow(10, INDEX_SHARE_DECIMALS);
            const navPerShare = index.account.assets.reduce((sum, asset) => {
                const mint = asset.mint.toBase58();
                const token = tokenByMint.get(mint);
                const symbol = token?.symbol || mint;
                const decimals = token?.decimals ?? 6;
                const unitsAtomic = BigInt(asset.units.toString());
                const unitsHuman = Number(unitsAtomic) / Math.pow(10, decimals);
                return sum + unitsHuman * getTokenPrice(symbol);
            }, 0);

            const indexName = index.account.name?.trim() || `Index #${index.publicKey.toBase58().slice(0, 4)}`;
            rows.push({
                indexName,
                indexMint,
                description: index.account.description?.trim() || '',
                assetsCount: index.account.assets.length,
                shareBalanceHuman: atomicToHumanString(shareBalanceAtomic, INDEX_SHARE_DECIMALS),
                shareBalanceNumeric,
                navPerShare,
                estimatedUsdValue: shareBalanceNumeric * navPerShare,
                paused: index.account.paused,
            });
        }

        rows.sort((a, b) => b.estimatedUsdValue - a.estimatedUsdValue);
        return rows;
    }, [walletAddress, balancesInitialized, indexes, getMintBalanceAtomic, tokenByMint]);

    const portfolioValueUsd = useMemo(() => {
        return holdings.reduce((sum, holding) => sum + holding.estimatedUsdValue, 0);
    }, [holdings]);

    const isLoading = indexesLoading || (walletAddress !== null && !balancesInitialized && balancesLoading);

    if (isLoading) {
        return (
            <div className="grid min-h-[50vh] place-items-center">
                <Loader2 className="animate-spin text-lime-200" />
            </div>
        );
    }

    if (!walletAddress) {
        return (
            <div className="glass-card mx-auto max-w-2xl p-10 text-center">
                <Wallet className="mx-auto mb-4 text-zinc-300/85" />
                <h1 className="display-font text-2xl font-semibold text-white">Connect wallet</h1>
                <p className="mt-2 text-zinc-200/85">Your index token balances will appear here once connected.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <header className="glass-card p-6 md:p-8">
                <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                    <div>
                        <p className="section-label mb-2">Portfolio view</p>
                        <h1 className="section-title">Your index positions</h1>
                        <p className="section-subtitle mt-2">Track balances and value across all minted indexes.</p>
                    </div>
                    <Link href="/" className="btn-secondary w-fit">
                        Browse market
                    </Link>
                </div>
            </header>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="metric-card">
                    <p className="section-label mb-2">Holdings</p>
                    <p className="text-3xl font-semibold text-white">{holdings.length}</p>
                </div>
                <div className="metric-card">
                    <p className="section-label mb-2">Estimated value</p>
                    <p className="text-3xl font-semibold text-lime-200">{formatUsd(portfolioValueUsd)}</p>
                </div>
                <div className="metric-card">
                    <p className="section-label mb-2">Wallet</p>
                    <p className="truncate font-mono text-sm text-zinc-300">{walletAddress}</p>
                </div>
            </section>

            {loadError ? (
                <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-sm text-amber-200">
                    {loadError}
                </div>
            ) : null}

            {holdings.length === 0 ? (
                <section className="glass-card py-16 text-center">
                    <Briefcase className="mx-auto mb-4 text-zinc-300/85" />
                    <h2 className="text-xl font-semibold text-white">No index balances yet</h2>
                    <p className="mt-2 text-sm text-zinc-200/85">Mint or buy an index token and it will appear automatically.</p>
                    <Link href="/" className="btn-primary mt-6">
                        Go to marketplace
                    </Link>
                </section>
            ) : (
                <section className="list-panel">
                    <div className="grid gap-4">
                        {holdings.map((holding) => (
                            <Link
                                key={holding.indexMint}
                                href={`/index/${holding.indexMint}`}
                                className="glass-card strong-hover block p-5"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h3 className="truncate text-lg font-semibold text-white">{holding.indexName}</h3>
                                            {holding.paused ? (
                                                <span className="rounded-full border border-amber-300/35 bg-amber-300/12 px-2 py-0.5 text-[10px] font-medium text-amber-200">
                                                    Paused
                                                </span>
                                            ) : null}
                                        </div>
                                        <p className="mt-1 text-xs text-zinc-300/85">
                                            {holding.indexMint.slice(0, 8)}...{holding.indexMint.slice(-4)}
                                        </p>
                                        {holding.description ? (
                                            <p className="mt-2 text-sm text-zinc-200/85">{holding.description}</p>
                                        ) : null}
                                    </div>
                                    <ArrowRight className="mt-1 shrink-0 text-zinc-300/85" size={16} />
                                </div>

                                <div className="strong-divider mt-4 grid grid-cols-2 gap-3 pt-4 text-sm md:grid-cols-4">
                                    <div>
                                        <p className="text-zinc-300/85">Balance</p>
                                        <p className="font-mono text-zinc-100">{holding.shareBalanceHuman}</p>
                                    </div>
                                    <div>
                                        <p className="text-zinc-300/85">Value</p>
                                        <p className="font-mono text-lime-200">{formatUsd(holding.estimatedUsdValue)}</p>
                                    </div>
                                    <div>
                                        <p className="text-zinc-300/85">NAV/share</p>
                                        <p className="font-mono text-zinc-300">{formatUsd(holding.navPerShare)}</p>
                                    </div>
                                    <div>
                                        <p className="text-zinc-300/85">Assets</p>
                                        <p className="text-zinc-300">{holding.assetsCount}</p>
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
