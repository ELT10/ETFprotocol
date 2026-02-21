import type { Metadata } from 'next';
import './globals.css';
import '@solana/wallet-adapter-react-ui/styles.css';
import { AppWalletProvider } from '@/components/infrastructure/WalletProvider';
import { Navbar } from '@/components/infrastructure/Navbar';

export const metadata: Metadata = {
  title: 'ETF Protocol',
  description: 'Create and Trade On-Chain ETFs',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-zinc-100">
        <AppWalletProvider>
          <Navbar />
          <main className="app-shell">
            {children}
          </main>
        </AppWalletProvider>
      </body>
    </html>
  );
}
