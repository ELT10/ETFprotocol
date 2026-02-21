'use client';

import { FC, ReactNode, useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { getSolanaRpcUrl } from '@/utils/network';

export const AppWalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const isBrowser = typeof window !== 'undefined';
    const endpoint = useMemo(() => getSolanaRpcUrl(), []);

    const wallets = useMemo(
        () =>
            isBrowser
                ? [
                      new PhantomWalletAdapter(),
                      new SolflareWalletAdapter(),
                  ]
                : [],
        [isBrowser]
    );

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect={isBrowser}>
                <WalletModalProvider>
                    {children}
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
};
