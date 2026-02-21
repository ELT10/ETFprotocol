'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, PlusCircle, Wallet, Coins, Briefcase } from 'lucide-react';
import { getNetworkLabel } from '@/utils/network';

// Dynamically import wallet button with SSR disabled to prevent hydration mismatch
const WalletMultiButtonDynamic = dynamic(
    async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
    {
        ssr: false,
        loading: () => (
            <button className="wallet-adapter-button wallet-adapter-button-trigger" disabled>
                <Wallet size={16} />
                <span>Loading...</span>
            </button>
        )
    }
);

const navItems = [
    { href: '/', label: 'Market', icon: LayoutDashboard },
    { href: '/create', label: 'Create', icon: PlusCircle },
    { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
    { href: '/creator', label: 'Creator', icon: Coins },
];

function isRouteActive(pathname: string, href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
}

export function Navbar() {
    const pathname = usePathname();
    const networkLabel = getNetworkLabel();
    const [showScrollOverlay, setShowScrollOverlay] = useState(false);

    useEffect(() => {
        const onScroll = () => {
            setShowScrollOverlay(window.scrollY > 8);
        };

        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            window.removeEventListener('scroll', onScroll);
        };
    }, []);

    return (
        <>
            <div
                className={`pointer-events-none fixed inset-x-0 top-0 z-40 h-[170px] transition-opacity duration-300 ${
                    showScrollOverlay ? 'opacity-100' : 'opacity-0'
                }`}
                aria-hidden="true"
            >
                <div className="h-full w-full bg-gradient-to-b from-black/72 via-black/46 to-transparent backdrop-blur-sm" />
            </div>

            <nav className="sticky top-0 z-50 px-4 pt-4 md:px-6 md:pt-5">
                <div className="glass-card mx-auto flex w-full max-w-[1240px] flex-col gap-3 px-4 py-3 md:px-5">
                    <div className="flex items-center justify-between gap-4">
                        <Link href="/" className="flex min-w-0 items-center gap-3">
                            <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-lime-300 to-indigo-300 text-sm font-bold text-zinc-900">
                                ETF
                            </div>
                            <div className="min-w-0">
                                <div className="display-font truncate text-base font-semibold tracking-tight text-white md:text-lg">
                                    Index Protocol
                                </div>
                                <div className="section-label hidden md:block">Trade basket tokens on-chain</div>
                            </div>
                        </Link>

                        <div className="flex items-center gap-2 md:gap-3">
                            <div className="inline-flex items-center gap-2 rounded-full border border-lime-300/30 bg-lime-300/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-lime-100">
                                <span className="size-1.5 animate-pulse rounded-full bg-lime-300" />
                                {networkLabel}
                            </div>
                            <WalletMultiButtonDynamic />
                        </div>
                    </div>

                    <div className="inner-card flex items-center gap-2 overflow-x-auto p-1.5">
                        {navItems.map((item) => {
                            const active = isRouteActive(pathname, item.href);
                            const Icon = item.icon;

                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition md:px-4 ${
                                        active
                                            ? 'bg-lime-300 text-zinc-950'
                                            : 'text-zinc-200/85 hover:bg-black/45 hover:text-zinc-100'
                                    }`}
                                >
                                    <Icon size={16} />
                                    <span>{item.label}</span>
                                </Link>
                            );
                        })}
                    </div>
                </div>
            </nav>
        </>
    );
}
