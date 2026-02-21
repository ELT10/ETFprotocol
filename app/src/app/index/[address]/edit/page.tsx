'use client';

import Link from 'next/link';
import { use } from 'react';

export default function EditIndexPage({ params }: { params: Promise<{ address: string }> }) {
    const { address } = use(params);

    return (
        <div className="glass-card mx-auto max-w-2xl p-12 text-center">
            <p className="section-label mb-3">Stage 2 capability</p>
            <h1 className="display-font text-3xl font-semibold text-white">Rebalancing is disabled here</h1>
            <p className="mt-3 text-zinc-200/85">
                Stage 1 indexes are immutable. Composition edits are available only in Stage 2.
            </p>
            <Link href={`/index/${address}`} className="btn-secondary mt-7">
                Back to index
            </Link>
        </div>
    );
}
