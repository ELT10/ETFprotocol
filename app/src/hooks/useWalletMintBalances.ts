'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';

export interface WalletMintBalance {
    amountAtomic: bigint;
    decimals: number;
}

interface UseWalletMintBalancesOptions {
    pollIntervalMs?: number;
}

function safeBigInt(value: string): bigint {
    try {
        return BigInt(value);
    } catch {
        return BigInt(0);
    }
}

export function useWalletMintBalances({ pollIntervalMs = 15_000 }: UseWalletMintBalancesOptions = {}) {
    const { connection } = useConnection();
    const wallet = useWallet();
    const walletAddress = wallet.publicKey?.toBase58() ?? null;
    const [balances, setBalances] = useState<Map<string, WalletMintBalance>>(new Map());
    const [loading, setLoading] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!wallet.publicKey) {
            setBalances(new Map());
            setLoading(false);
            setInitialized(false);
            setError(null);
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const [tokenkegAccounts, token2022Accounts, solLamports] = await Promise.all([
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
                connection.getBalance(wallet.publicKey, 'confirmed'),
            ]);

            const nextBalances = new Map<string, WalletMintBalance>();
            const mergeBalancesFromParsedAccounts = (tokenAccounts: typeof tokenkegAccounts.value) => {
                for (const tokenAccount of tokenAccounts) {
                    const parsedInfo = (tokenAccount.account.data as unknown as {
                        parsed?: {
                            info?: {
                                mint?: string;
                                tokenAmount?: {
                                    amount?: string;
                                    decimals?: number;
                                };
                            };
                        };
                    })?.parsed?.info;
                    const mint = parsedInfo?.mint;
                    const amount = parsedInfo?.tokenAmount?.amount;
                    const decimals = parsedInfo?.tokenAmount?.decimals;
                    if (!mint || !amount || typeof decimals !== 'number') continue;

                    const amountAtomic = safeBigInt(amount);
                    const existing = nextBalances.get(mint);
                    if (existing) {
                        nextBalances.set(mint, {
                            amountAtomic: existing.amountAtomic + amountAtomic,
                            decimals: existing.decimals,
                        });
                    } else {
                        nextBalances.set(mint, {
                            amountAtomic,
                            decimals,
                        });
                    }
                }
            };

            mergeBalancesFromParsedAccounts(tokenkegAccounts.value);
            mergeBalancesFromParsedAccounts(token2022Accounts.value);

            nextBalances.set(NATIVE_MINT.toBase58(), {
                amountAtomic: BigInt(solLamports),
                decimals: 9,
            });

            setBalances(nextBalances);
            setError(null);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        } finally {
            setLoading(false);
            setInitialized(true);
        }
    }, [connection, wallet.publicKey]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!wallet.publicKey || pollIntervalMs <= 0) return;
        const intervalId = window.setInterval(() => {
            void refresh();
        }, pollIntervalMs);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [refresh, wallet.publicKey, pollIntervalMs]);

    const getMintBalanceAtomic = useCallback(
        (mint: string): bigint => balances.get(mint)?.amountAtomic ?? BigInt(0),
        [balances]
    );

    const getMintBalanceDecimals = useCallback(
        (mint: string): number | null => balances.get(mint)?.decimals ?? null,
        [balances]
    );

    return useMemo(
        () => ({
            walletAddress,
            balances,
            loading,
            initialized,
            error,
            refresh,
            getMintBalanceAtomic,
            getMintBalanceDecimals,
        }),
        [
            walletAddress,
            balances,
            loading,
            initialized,
            error,
            refresh,
            getMintBalanceAtomic,
            getMintBalanceDecimals,
        ]
    );
}
