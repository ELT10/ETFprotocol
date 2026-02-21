import { NextResponse } from 'next/server';

type JupiterSwapMode = 'ExactIn' | 'ExactOut';

interface QuoteRequestBody {
    inputMint?: string;
    outputMint?: string;
    amount?: string | number;
    slippageBps?: number;
    swapMode?: JupiterSwapMode;
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
    return 'Jupiter request failed';
}

function normalizeAmount(amount: string | number | undefined): string | null {
    if (typeof amount === 'number') {
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return Math.floor(amount).toString();
    }
    if (typeof amount === 'string') {
        const trimmed = amount.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        if (trimmed === '0') return null;
        return trimmed;
    }
    return null;
}

function pickQuotePayload(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') return null;
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
        return data[0] ?? null;
    }
    return payload;
}

export async function POST(req: Request) {
    let body: QuoteRequestBody | null = null;
    try {
        body = (await req.json()) as QuoteRequestBody;
    } catch {
        body = null;
    }

    const inputMint = body?.inputMint?.trim();
    const outputMint = body?.outputMint?.trim();
    const amount = normalizeAmount(body?.amount);
    const slippageBps =
        typeof body?.slippageBps === 'number' && Number.isFinite(body.slippageBps)
            ? Math.max(1, Math.floor(body.slippageBps))
            : 50;
    const requestedSwapMode: JupiterSwapMode = body?.swapMode === 'ExactOut' ? 'ExactOut' : 'ExactIn';
    if (requestedSwapMode === 'ExactOut') {
        return NextResponse.json(
            { error: 'ExactOut is not supported in this app. Use swapMode=ExactIn.' },
            { status: 400 }
        );
    }
    const swapMode: JupiterSwapMode = 'ExactIn';

    if (!inputMint || !outputMint || !amount) {
        return NextResponse.json(
            { error: 'Missing required fields: inputMint, outputMint, amount' },
            { status: 400 }
        );
    }

    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount,
        slippageBps: slippageBps.toString(),
        swapMode,
    });

    const headers: Record<string, string> = { accept: 'application/json' };
    if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;

    const res = await fetch(`${JUPITER_API_BASE}/swap/v1/quote?${params.toString()}`, {
        headers,
        cache: 'no-store',
    });
    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
        return NextResponse.json({ error: getErrorMessage(payload) }, { status: res.status });
    }

    const quote = pickQuotePayload(payload);
    if (!quote || typeof quote !== 'object') {
        return NextResponse.json({ error: 'Invalid quote payload from Jupiter' }, { status: 502 });
    }

    return NextResponse.json(quote);
}
