import { NextResponse } from 'next/server';

interface SwapRequestBody {
    quoteResponse?: unknown;
    userPublicKey?: string;
    wrapAndUnwrapSol?: boolean;
}

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://api.jup.ag';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

function getErrorMessage(payload: unknown): string {
    if (payload && typeof payload === 'object') {
        const maybeError = (payload as { error?: unknown }).error;
        if (typeof maybeError === 'string' && maybeError.trim().length > 0) return maybeError;

        const maybeMessage = (payload as { message?: unknown }).message;
        if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) return maybeMessage;
    }
    return 'Jupiter swap build failed';
}

export async function POST(req: Request) {
    let body: SwapRequestBody | null = null;
    try {
        body = (await req.json()) as SwapRequestBody;
    } catch {
        body = null;
    }

    const quoteResponse = body?.quoteResponse;
    const userPublicKey = body?.userPublicKey?.trim();
    const wrapAndUnwrapSol = body?.wrapAndUnwrapSol ?? true;

    if (!quoteResponse || typeof quoteResponse !== 'object' || !userPublicKey) {
        return NextResponse.json(
            { error: 'Missing required fields: quoteResponse, userPublicKey' },
            { status: 400 }
        );
    }

    const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
    };
    if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;

    const upstreamBody = {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol,
        dynamicComputeUnitLimit: true,
    };

    const res = await fetch(`${JUPITER_API_BASE}/swap/v1/swap`, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        cache: 'no-store',
    });
    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
        return NextResponse.json({ error: getErrorMessage(payload) }, { status: res.status });
    }
    if (!payload || typeof payload !== 'object') {
        return NextResponse.json({ error: 'Invalid swap payload from Jupiter' }, { status: 502 });
    }

    const swapTransaction = (payload as { swapTransaction?: unknown }).swapTransaction;
    if (typeof swapTransaction !== 'string' || swapTransaction.length === 0) {
        return NextResponse.json({ error: 'Jupiter response missing swapTransaction' }, { status: 502 });
    }

    return NextResponse.json(payload);
}
