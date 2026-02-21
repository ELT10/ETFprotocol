'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIndexProtocol } from '@/hooks/useIndexProtocol';
import { BN } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Check, Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useConnection } from '@solana/wallet-adapter-react';
import TokenAvatar from '@/components/TokenAvatar';
import {
    DEFAULT_JUP_SLIPPAGE_BPS,
    JUPITER_QUICK_ROUTE_BASE_TOKENS,
    checkJupiterQuickRouteTradability,
    type JupiterQuickRouteCheckResult,
} from '@/utils/jupiter';
import {
    buildIndexQuickRouteSupportByBase,
    summarizeIndexQuickRouteCoverage,
    type IndexQuickRouteBaseSupport,
} from '@/utils/jupiterQuickRoutePlanner';
import {
    INDEX_SHARE_DECIMALS,
    MAX_INDEX_DESCRIPTION_LEN,
    MAX_INDEX_NAME_LEN,
    STAGE1_MAX_ASSETS,
} from '@/utils/protocol';
import {
    TOKEN_2022_PROGRAM_ID_STR,
    formatToken2022ExtensionNames,
    isSupportedAssetTokenProgramOwner,
    parseUnsupportedToken2022MintExtensions,
} from '@/utils/tokenPrograms';
import { getExplorerCluster } from '@/utils/network';

const INDEX_SHARE_SCALE = BigInt(10) ** BigInt(INDEX_SHARE_DECIMALS);
const COARSE_STEP_WARNING_ATOMIC = BigInt(10_000);
const U64_MAX = BigInt('18446744073709551615');
const TOP_TOKEN_LIMIT = 50;
const TRADABILITY_CHECK_STALL_TIMEOUT_MS = 30_000;

type TokenTradabilityStatus = 'checking' | 'tradable' | 'limited' | 'non-tradable' | 'error';
type CreateWorkflowStepId = 'create-index' | 'set-metadata' | 'finalize-settings';
type CreateWorkflowStepStatus = 'pending' | 'active' | 'done' | 'error';

interface TokenCatalogEntry {
    symbol: string;
    name: string;
    mint: string;
    decimals: number;
    logoURI?: string;
}

interface TokenTradabilityCheckOutcome {
    status: TokenTradabilityStatus;
    detail?: string;
    quickRouteResult: JupiterQuickRouteCheckResult;
}

interface CreateWorkflowStep {
    id: CreateWorkflowStepId;
    label: string;
    description: string;
    status: CreateWorkflowStepStatus;
    txSignatures: string[];
}

function mergeTokens(existing: TokenCatalogEntry[], incoming: TokenCatalogEntry[]): TokenCatalogEntry[] {
    const map = new Map<string, TokenCatalogEntry>();
    for (const token of existing) map.set(token.mint, token);
    for (const token of incoming) map.set(token.mint, token);
    return Array.from(map.values());
}

function decimalToAtomic(value: string, decimals: number): bigint | null {
    const normalized = value.trim();
    if (!normalized) return null;
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

    const [wholeRaw, fractionRaw = ''] = normalized.split('.');
    if (fractionRaw.length > decimals) return null;

    const whole = BigInt(wholeRaw || '0');
    const base = BigInt(10) ** BigInt(decimals);
    const fractionPadded = (fractionRaw + '0'.repeat(decimals)).slice(0, decimals);
    const fraction = BigInt(fractionPadded || '0');

    return whole * base + fraction;
}

function atomicToHumanString(amount: bigint, decimals: number): string {
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    if (fraction === BigInt(0)) return whole.toString();

    const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fractionPadded}`;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
    let x = a < BigInt(0) ? -a : a;
    let y = b < BigInt(0) ? -b : b;
    while (y !== BigInt(0)) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x;
}

function lcmBigInt(a: bigint, b: bigint): bigint {
    if (a === BigInt(0) || b === BigInt(0)) return BigInt(0);
    return (a / gcdBigInt(a, b)) * b;
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values));
}

function formatMinQuickShares(minSharesAtomic: bigint | null): string {
    if (minSharesAtomic === null) return 'unavailable';
    if (minSharesAtomic === BigInt(0)) return 'any valid share amount';
    return `${atomicToHumanString(minSharesAtomic, INDEX_SHARE_DECIMALS)} shares`;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function buildCreateWorkflowSteps(params: {
    feeCollectorNeedsUpdate: boolean;
    tradeFeeNeedsUpdate: boolean;
}): CreateWorkflowStep[] {
    const { feeCollectorNeedsUpdate, tradeFeeNeedsUpdate } = params;
    let finalizeDescription = 'No fee updates needed; defaults will be kept.';
    if (feeCollectorNeedsUpdate && tradeFeeNeedsUpdate) {
        finalizeDescription = 'Update fee collector and trade fee (this step can require two signatures).';
    } else if (feeCollectorNeedsUpdate) {
        finalizeDescription = 'Update fee collector address.';
    } else if (tradeFeeNeedsUpdate) {
        finalizeDescription = 'Set trade fee percent.';
    }

    return [
        {
            id: 'create-index',
            label: 'Transaction 1 of 3',
            description: 'Create index mint and config account.',
            status: 'pending',
            txSignatures: [],
        },
        {
            id: 'set-metadata',
            label: 'Transaction 2 of 3',
            description: 'Save index name and description.',
            status: 'pending',
            txSignatures: [],
        },
        {
            id: 'finalize-settings',
            label: 'Transaction 3 of 3',
            description: finalizeDescription,
            status: 'pending',
            txSignatures: [],
        },
    ];
}

export default function CreateIndexPage() {
    const router = useRouter();
    const { connection } = useConnection();
    const { program, wallet } = useIndexProtocol();
    const explorerCluster = useMemo(() => getExplorerCluster(), []);
    const [displayedTokens, setDisplayedTokens] = useState<TokenCatalogEntry[]>([]);
    const [tokenUniverse, setTokenUniverse] = useState<TokenCatalogEntry[]>([]);
    const [tokenSearchQuery, setTokenSearchQuery] = useState('');
    const [tokenLoading, setTokenLoading] = useState(false);
    const [tokenLoadError, setTokenLoadError] = useState<string | null>(null);
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [weights, setWeights] = useState<Record<string, string>>({});
    const [indexName, setIndexName] = useState('');
    const [indexDescription, setIndexDescription] = useState('');
    const [tradeFeePercent, setTradeFeePercent] = useState('0');
    const [feeCollectorAddress, setFeeCollectorAddress] = useState('');
    const [allowNonTradableTokens, setAllowNonTradableTokens] = useState(false);
    const [tokenTradabilityByMint, setTokenTradabilityByMint] = useState<Record<string, TokenTradabilityStatus>>({});
    const [tokenTradabilityErrorByMint, setTokenTradabilityErrorByMint] = useState<Record<string, string>>({});
    const [tokenQuickRouteByMint, setTokenQuickRouteByMint] = useState<Record<string, JupiterQuickRouteCheckResult>>({});
    const [tokenProgramOwnerByMint, setTokenProgramOwnerByMint] = useState<Record<string, string>>({});
    const [tokenProgramCheckErrorByMint, setTokenProgramCheckErrorByMint] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createWorkflowModalOpen, setCreateWorkflowModalOpen] = useState(false);
    const [createWorkflowSteps, setCreateWorkflowSteps] = useState<CreateWorkflowStep[]>([]);
    const [createWorkflowError, setCreateWorkflowError] = useState<string | null>(null);
    const tradabilityChecksInFlightRef = useRef<Set<string>>(new Set());
    const tradabilityCheckStartedAtRef = useRef<Record<string, number>>({});
    const tokenProgramChecksInFlightRef = useRef<Set<string>>(new Set());
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const tokenByMint = useMemo(() => {
        return new Map(tokenUniverse.map((token) => [token.mint, token]));
    }, [tokenUniverse]);

    useEffect(() => {
        const selectedMintSet = new Set(selectedTokens);
        for (const mint of Object.keys(tradabilityCheckStartedAtRef.current)) {
            if (!selectedMintSet.has(mint)) {
                delete tradabilityCheckStartedAtRef.current[mint];
                tradabilityChecksInFlightRef.current.delete(mint);
            }
        }
        for (const mint of Array.from(tokenProgramChecksInFlightRef.current.values())) {
            if (!selectedMintSet.has(mint)) {
                tokenProgramChecksInFlightRef.current.delete(mint);
            }
        }
    }, [selectedTokens]);

    useEffect(() => {
        const runProgramChecks = async () => {
            for (const mint of selectedTokens) {
                const knownOwner = tokenProgramOwnerByMint[mint];
                const knownError = tokenProgramCheckErrorByMint[mint];
                if (knownOwner || knownError || tokenProgramChecksInFlightRef.current.has(mint)) continue;

                tokenProgramChecksInFlightRef.current.add(mint);
                try {
                    const mintPubkey = new PublicKey(mint);
                    const info = await Promise.race([
                        connection.getAccountInfo(mintPubkey, 'confirmed'),
                        new Promise<null>((_, reject) =>
                            window.setTimeout(() => reject(new Error('Token program check timed out.')), 10_000)
                        ),
                    ]);
                    if (!isMountedRef.current) continue;
                    if (!info) {
                        setTokenProgramCheckErrorByMint((prev) => ({
                            ...prev,
                            [mint]: 'Mint account not found on RPC.',
                        }));
                    } else {
                        const owner = info.owner.toBase58();
                        if (!isSupportedAssetTokenProgramOwner(owner)) {
                            setTokenProgramCheckErrorByMint((prev) => ({
                                ...prev,
                                [mint]: `Unsupported token program (${owner}). Only SPL Token and Token-2022 are supported.`,
                            }));
                            continue;
                        }
                        if (owner === TOKEN_2022_PROGRAM_ID_STR) {
                            try {
                                const unsupportedExtensions = parseUnsupportedToken2022MintExtensions({
                                    mint: mintPubkey,
                                    mintAccountInfo: info,
                                });
                                if (unsupportedExtensions.length > 0) {
                                    setTokenProgramCheckErrorByMint((prev) => ({
                                        ...prev,
                                        [mint]: `Unsupported Token-2022 extensions: ${formatToken2022ExtensionNames(
                                            unsupportedExtensions
                                        )}.`,
                                    }));
                                    continue;
                                }
                            } catch (parseErr: unknown) {
                                const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
                                setTokenProgramCheckErrorByMint((prev) => ({
                                    ...prev,
                                    [mint]: `Failed to parse Token-2022 mint metadata: ${message}`,
                                }));
                                continue;
                            }
                        }
                        setTokenProgramOwnerByMint((prev) => ({
                            ...prev,
                            [mint]: owner,
                        }));
                    }
                } catch (err: unknown) {
                    if (!isMountedRef.current) continue;
                    const message = err instanceof Error ? err.message : String(err);
                    setTokenProgramCheckErrorByMint((prev) => ({
                        ...prev,
                        [mint]: `Failed to verify token program: ${message}`,
                    }));
                } finally {
                    tokenProgramChecksInFlightRef.current.delete(mint);
                }
            }
        };

        void runProgramChecks();
    }, [selectedTokens, tokenProgramOwnerByMint, tokenProgramCheckErrorByMint, connection]);

    const loadTokens = useCallback(
        async (query: string) => {
            setTokenLoading(true);
            try {
                const params = new URLSearchParams({ limit: TOP_TOKEN_LIMIT.toString() });
                const trimmedQuery = query.trim();
                if (trimmedQuery.length > 0) {
                    params.set('q', trimmedQuery);
                }

                const res = await fetch(`/api/tokens?${params.toString()}`, { cache: 'no-store' });
                if (!res.ok) {
                    throw new Error(`Token request failed (${res.status})`);
                }

                const payload: unknown = await res.json().catch(() => null);
                const tokens = Array.isArray((payload as { tokens?: unknown[] })?.tokens)
                    ? ((payload as { tokens: TokenCatalogEntry[] }).tokens)
                          .filter((token) => token?.mint && token?.symbol && token?.name)
                          .slice(0, TOP_TOKEN_LIMIT)
                    : [];

                if (tokens.length === 0) {
                    throw new Error('Token list is empty');
                }

                setDisplayedTokens(tokens);
                setTokenUniverse((prev) => mergeTokens(prev, tokens));
                setTokenLoadError(null);
            } catch (err) {
                console.error('Failed to load Jupiter tokens:', err);
                setDisplayedTokens([]);
                setTokenLoadError('Failed to load token list from Jupiter.');
            } finally {
                setTokenLoading(false);
            }
        },
        []
    );

    useEffect(() => {
        const timeoutId = window.setTimeout(
            () => void loadTokens(tokenSearchQuery),
            tokenSearchQuery.trim().length > 0 ? 300 : 0
        );
        return () => window.clearTimeout(timeoutId);
    }, [tokenSearchQuery, loadTokens]);

    const compositionStep = useMemo(() => {
        if (selectedTokens.length === 0) {
            return { stepAtomic: null as bigint | null, stepHuman: null as string | null, invalidSymbol: null as string | null };
        }

        let step = BigInt(1);
        for (const mint of selectedTokens) {
            const token = tokenByMint.get(mint);
            if (!token) {
                return { stepAtomic: null, stepHuman: null, invalidSymbol: mint.slice(0, 6) };
            }
            const atomic = decimalToAtomic(weights[mint] || '', token.decimals);
            if (atomic === null || atomic <= BigInt(0)) {
                return { stepAtomic: null, stepHuman: null, invalidSymbol: token.symbol };
            }
            const assetStep = INDEX_SHARE_SCALE / gcdBigInt(INDEX_SHARE_SCALE, atomic);
            step = lcmBigInt(step, assetStep);
        }

        return {
            stepAtomic: step,
            stepHuman: atomicToHumanString(step, INDEX_SHARE_DECIMALS),
            invalidSymbol: null as string | null,
        };
    }, [selectedTokens, tokenByMint, weights]);

    const handleToggleToken = (mint: string) => {
        setError(null);
        if (selectedTokens.includes(mint)) {
            setSelectedTokens((prev) => prev.filter((t) => t !== mint));
            const newWeights = { ...weights };
            delete newWeights[mint];
            setWeights(newWeights);
        } else {
            if (selectedTokens.length >= STAGE1_MAX_ASSETS) return;
            setSelectedTokens((prev) => [...prev, mint]);
            setWeights((prev) => ({ ...prev, [mint]: '1' }));
        }
    };

    const handleRemoveSelectedToken = useCallback((mint: string) => {
        setError(null);
        setSelectedTokens((prev) => prev.filter((t) => t !== mint));
        setWeights((prev) => {
            const next = { ...prev };
            delete next[mint];
            return next;
        });
    }, []);

    const nonTradableTokenSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => tokenTradabilityByMint[mint] === 'non-tradable')
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenTradabilityByMint, tokenByMint]);

    const unsupportedTokenProgramSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => {
                    if (tokenProgramCheckErrorByMint[mint]) return true;
                    const owner = tokenProgramOwnerByMint[mint];
                    return !!owner && !isSupportedAssetTokenProgramOwner(owner);
                })
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenProgramOwnerByMint, tokenProgramCheckErrorByMint, tokenByMint]);

    const tokenProgramPendingSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => !tokenProgramOwnerByMint[mint] && !tokenProgramCheckErrorByMint[mint])
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenProgramOwnerByMint, tokenProgramCheckErrorByMint, tokenByMint]);

    const limitedQuickRouteTokenSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => tokenTradabilityByMint[mint] === 'limited')
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenTradabilityByMint, tokenByMint]);

    const tradabilityCheckFailedSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => tokenTradabilityByMint[mint] === 'error')
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenTradabilityByMint, tokenByMint]);

    const quickRouteUnavailableTokenSymbols = useMemo(() => {
        return uniqueStrings([...nonTradableTokenSymbols, ...tradabilityCheckFailedSymbols]);
    }, [nonTradableTokenSymbols, tradabilityCheckFailedSymbols]);

    const tradabilityPendingSymbols = useMemo(() => {
        return uniqueStrings(
            selectedTokens
                .filter((mint) => !tokenTradabilityByMint[mint] || tokenTradabilityByMint[mint] === 'checking')
                .map((mint) => tokenByMint.get(mint)?.symbol || mint.slice(0, 6))
        );
    }, [selectedTokens, tokenTradabilityByMint, tokenByMint]);

    const checkTokenTradabilityAgainstQuickRoutes = useCallback(async (token: TokenCatalogEntry): Promise<TokenTradabilityCheckOutcome> => {
        const result = await checkJupiterQuickRouteTradability({
            tokenMint: token.mint,
            tokenDecimals: token.decimals,
            baseTokens: JUPITER_QUICK_ROUTE_BASE_TOKENS,
            slippageBps: DEFAULT_JUP_SLIPPAGE_BPS,
            probeTokenAmountAtomic: (BigInt(10) ** BigInt(Math.max(0, Math.floor(token.decimals)))).toString(),
            maxProbeAttempts: 8,
        });

        if (result.failedRoutes.length > 0) {
            return {
                status: 'error',
                detail: `Tradability check failed for ${token.symbol}: ${result.failedRoutes[0]}`,
                quickRouteResult: result,
            };
        }

        if (!result.anyQuickBuySupported && !result.anyQuickSellSupported) {
            return {
                status: 'non-tradable',
                quickRouteResult: result,
            };
        }

        const quickBuyBases = result.baseCapabilities
            .filter((base) => base.quickBuySupported)
            .map((base) => base.symbol);
        const quickSellBases = result.baseCapabilities
            .filter((base) => base.quickSellSupported)
            .map((base) => base.symbol);
        const roundTripBases = result.baseCapabilities
            .filter((base) => base.roundTripSupported)
            .map((base) => base.symbol);

        if (result.allBasesRoundTripSupported) {
            return {
                status: 'tradable',
                quickRouteResult: result,
            };
        }

        return {
            status: 'limited',
            detail: `${quickBuyBases.length > 0 ? `Quick Buy lanes: ${quickBuyBases.join(', ')}` : 'Quick Buy unavailable'} | ${
                quickSellBases.length > 0 ? `Quick Exit lanes: ${quickSellBases.join(', ')}` : 'Quick Exit unavailable'
            }${roundTripBases.length > 0 ? ` | Shared lanes: ${roundTripBases.join(', ')}` : ''}.`,
            quickRouteResult: result,
        };
    }, []);

    useEffect(() => {
        const runChecks = async () => {
            for (const mint of selectedTokens) {
                const existingStatus = tokenTradabilityByMint[mint];
                if (existingStatus === 'tradable' || existingStatus === 'limited' || existingStatus === 'non-tradable' || existingStatus === 'error') {
                    continue;
                }
                if (tradabilityChecksInFlightRef.current.has(mint)) continue;

                const token = tokenByMint.get(mint);
                if (!token) {
                    setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: 'error' }));
                    setTokenTradabilityErrorByMint((prev) => ({
                        ...prev,
                        [mint]: 'Token metadata unavailable for tradability check. Re-select token.',
                    }));
                    continue;
                }

                const programCheckError = tokenProgramCheckErrorByMint[mint];
                if (programCheckError) {
                    setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: 'error' }));
                    setTokenTradabilityErrorByMint((prev) => ({ ...prev, [mint]: programCheckError }));
                    continue;
                }

                const mintProgramOwner = tokenProgramOwnerByMint[mint];
                if (!mintProgramOwner) {
                    continue;
                }
                if (!isSupportedAssetTokenProgramOwner(mintProgramOwner)) {
                    const programLabel =
                        mintProgramOwner === TOKEN_2022_PROGRAM_ID_STR ? 'Token-2022' : mintProgramOwner;
                    setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: 'error' }));
                    setTokenTradabilityErrorByMint((prev) => ({
                        ...prev,
                        [mint]: `${token.symbol} uses unsupported token program ${programLabel}. Only SPL Token and basic Token-2022 mints are supported.`,
                    }));
                    continue;
                }

                tradabilityChecksInFlightRef.current.add(mint);
                tradabilityCheckStartedAtRef.current[mint] = Date.now();
                setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: 'checking' }));
                setTokenTradabilityErrorByMint((prev) => {
                    if (!prev[mint]) return prev;
                    const next = { ...prev };
                    delete next[mint];
                    return next;
                });
                setTokenQuickRouteByMint((prev) => {
                    if (!prev[mint]) return prev;
                    const next = { ...prev };
                    delete next[mint];
                    return next;
                });

                try {
                    const outcome = await checkTokenTradabilityAgainstQuickRoutes(token);
                    if (isMountedRef.current) {
                        setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: outcome.status }));
                        setTokenQuickRouteByMint((prev) => ({ ...prev, [mint]: outcome.quickRouteResult }));
                        if (outcome.detail) {
                            setTokenTradabilityErrorByMint((prev) => ({ ...prev, [mint]: outcome.detail || '' }));
                        }
                    }
                } catch (err: unknown) {
                    if (!isMountedRef.current) continue;
                    const message = err instanceof Error ? err.message : String(err);
                    setTokenTradabilityByMint((prev) => ({ ...prev, [mint]: 'error' }));
                    setTokenTradabilityErrorByMint((prev) => ({ ...prev, [mint]: message }));
                } finally {
                    tradabilityChecksInFlightRef.current.delete(mint);
                    delete tradabilityCheckStartedAtRef.current[mint];
                }
            }
        };

        void runChecks();
    }, [
        selectedTokens,
        tokenByMint,
        tokenTradabilityByMint,
        tokenProgramOwnerByMint,
        tokenProgramCheckErrorByMint,
        checkTokenTradabilityAgainstQuickRoutes,
    ]);

    useEffect(() => {
        if (selectedTokens.length === 0) return;
        const stalledMints = selectedTokens.filter((mint) => {
            if (tokenTradabilityByMint[mint] !== 'checking') return false;
            return !tradabilityChecksInFlightRef.current.has(mint);
        });
        if (stalledMints.length === 0) return;
        setTokenTradabilityByMint((prev) => {
            const next = { ...prev };
            for (const mint of stalledMints) {
                next[mint] = 'error';
            }
            return next;
        });
        setTokenTradabilityErrorByMint((prev) => {
            const next = { ...prev };
            for (const mint of stalledMints) {
                next[mint] = 'Tradability check did not settle. Please retry.';
            }
            return next;
        });
    }, [selectedTokens, tokenTradabilityByMint]);

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            if (!isMountedRef.current || selectedTokens.length === 0) return;
            const now = Date.now();
            const timedOutMints = selectedTokens.filter((mint) => {
                if (tokenTradabilityByMint[mint] !== 'checking') return false;
                const startedAt = tradabilityCheckStartedAtRef.current[mint];
                if (!startedAt) return false;
                return now - startedAt >= TRADABILITY_CHECK_STALL_TIMEOUT_MS;
            });
            if (timedOutMints.length === 0) return;

            for (const mint of timedOutMints) {
                tradabilityChecksInFlightRef.current.delete(mint);
                delete tradabilityCheckStartedAtRef.current[mint];
            }

            setTokenTradabilityByMint((prev) => {
                const next = { ...prev };
                for (const mint of timedOutMints) {
                    next[mint] = 'error';
                }
                return next;
            });
            setTokenTradabilityErrorByMint((prev) => {
                const next = { ...prev };
                for (const mint of timedOutMints) {
                    next[mint] = `Tradability check timed out after ${TRADABILITY_CHECK_STALL_TIMEOUT_MS / 1000}s.`;
                }
                return next;
            });
        }, 1_500);

        return () => window.clearInterval(intervalId);
    }, [selectedTokens, tokenTradabilityByMint]);

    const perShareAtomicByMint = useMemo(() => {
        const map = new Map<string, bigint | null>();
        for (const mint of selectedTokens) {
            const token = tokenByMint.get(mint);
            map.set(mint, token ? decimalToAtomic(weights[mint] || '', token.decimals) : null);
        }
        return map;
    }, [selectedTokens, tokenByMint, weights]);

    const tokenSymbolByMint = useMemo(() => {
        const map = new Map<string, string>();
        for (const mint of selectedTokens) {
            const token = tokenByMint.get(mint);
            map.set(mint, token?.symbol || mint.slice(0, 6));
        }
        return map;
    }, [selectedTokens, tokenByMint]);

    const indexQuickRouteSupportByBase = useMemo<IndexQuickRouteBaseSupport[]>(() => {
        return buildIndexQuickRouteSupportByBase({
            selectedTokens,
            tokenQuickRouteByMint,
            tokenSymbolByMint,
            perShareAtomicByMint,
        });
    }, [selectedTokens, tokenQuickRouteByMint, tokenSymbolByMint, perShareAtomicByMint]);

    const indexQuickRouteCoverage = useMemo(
        () => summarizeIndexQuickRouteCoverage(indexQuickRouteSupportByBase),
        [indexQuickRouteSupportByBase]
    );
    const indexQuickBuyBaseSymbols = indexQuickRouteCoverage.quickBuyBaseSymbols;
    const indexQuickSellBaseSymbols = indexQuickRouteCoverage.quickSellBaseSymbols;
    const indexRoundTripBaseSymbols = indexQuickRouteCoverage.roundTripBaseSymbols;
    const indexPartiallySupportedBaseSymbols = indexQuickRouteCoverage.partiallySupportedBaseSymbols;

    const quickRoutesUnavailableForIndex = useMemo(() => {
        if (selectedTokens.length === 0) return false;
        if (tradabilityPendingSymbols.length > 0) return false;
        return !indexQuickRouteCoverage.quickBuyAvailable || !indexQuickRouteCoverage.quickSellAvailable;
    }, [selectedTokens.length, tradabilityPendingSymbols.length, indexQuickRouteCoverage]);

    const quickRouteCoverageSummaryText = useMemo(() => {
        const buyText =
            indexQuickBuyBaseSymbols.length > 0
                ? `Quick Buy lanes: ${indexQuickBuyBaseSymbols.join(', ')}`
                : 'Quick Buy lanes: none';
        const sellText =
            indexQuickSellBaseSymbols.length > 0
                ? `Quick Exit lanes: ${indexQuickSellBaseSymbols.join(', ')}`
                : 'Quick Exit lanes: none';
        return `${buyText}. ${sellText}.`;
    }, [indexQuickBuyBaseSymbols, indexQuickSellBaseSymbols]);

    const getExplorerTxUrl = useCallback(
        (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=${explorerCluster}`,
        [explorerCluster]
    );

    const updateCreateWorkflowStep = useCallback((stepId: CreateWorkflowStepId, patch: Partial<CreateWorkflowStep>) => {
        setCreateWorkflowSteps((prev) =>
            prev.map((step) => {
                if (step.id !== stepId) return step;
                return { ...step, ...patch };
            })
        );
    }, []);

    const appendCreateWorkflowSignature = useCallback((stepId: CreateWorkflowStepId, signature: string) => {
        setCreateWorkflowSteps((prev) =>
            prev.map((step) => {
                if (step.id !== stepId) return step;
                return {
                    ...step,
                    txSignatures: [...step.txSignatures, signature],
                };
            })
        );
    }, []);

    useEffect(() => {
        if (!quickRoutesUnavailableForIndex) {
            setAllowNonTradableTokens(false);
        }
    }, [quickRoutesUnavailableForIndex]);

    const handleCreate = async () => {
        if (!program || !wallet) {
            setError('Connect wallet to create an index.');
            return;
        }
        if (selectedTokens.length === 0) {
            setError('Select at least one token.');
            return;
        }
        if (!compositionStep.stepAtomic) {
            setError('Provide valid token/share amounts for every selected asset.');
            return;
        }
        const normalizedName = indexName.trim();
        if (!normalizedName) {
            setError('Index name is required.');
            return;
        }
        if (new TextEncoder().encode(normalizedName).length > MAX_INDEX_NAME_LEN) {
            setError(`Index name must be at most ${MAX_INDEX_NAME_LEN} bytes.`);
            return;
        }
        if (new TextEncoder().encode(indexDescription).length > MAX_INDEX_DESCRIPTION_LEN) {
            setError(`Description must be at most ${MAX_INDEX_DESCRIPTION_LEN} bytes.`);
            return;
        }
        const feePercentNumber = Number(tradeFeePercent);
        if (!Number.isFinite(feePercentNumber) || feePercentNumber < 0 || feePercentNumber > 10) {
            setError('Trade fee must be between 0% and 10%.');
            return;
        }
        const feeBps = Math.round(feePercentNumber * 100);
        const feeCollectorInput = feeCollectorAddress.trim();
        let feeCollector = wallet.publicKey;
        if (feeCollectorInput) {
            try {
                feeCollector = new PublicKey(feeCollectorInput);
            } catch {
                setError('Fee collector wallet address is invalid.');
                return;
            }
        }
        const feeCollectorNeedsUpdate = feeCollector.toBase58() !== wallet.publicKey.toBase58();
        const tradeFeeNeedsUpdate = feeBps > 0;

        const assets: PublicKey[] = [];
        const units: BN[] = [];

        for (const mint of selectedTokens) {
            const token = tokenByMint.get(mint);
            if (!token) {
                setError(`Token metadata unavailable for ${mint}. Re-select the token and retry.`);
                return;
            }

            const atomic = decimalToAtomic(weights[mint] || '', token.decimals);
            if (atomic === null || atomic <= BigInt(0)) {
                setError(`Invalid "${token.symbol}" amount. Use up to ${token.decimals} decimals.`);
                return;
            }
            if (atomic > U64_MAX) {
                setError(`"${token.symbol}" amount is too large.`);
                return;
            }

            assets.push(new PublicKey(mint));
            units.push(new BN(atomic.toString()));
        }

        if (tokenProgramPendingSymbols.length > 0) {
            setError(`Checking token program support for: ${tokenProgramPendingSymbols.join(', ')}. Please wait.`);
            return;
        }

        if (unsupportedTokenProgramSymbols.length > 0) {
            setError(
                `Unsupported token program for: ${unsupportedTokenProgramSymbols.join(', ')}. This protocol supports SPL Token and basic Token-2022 mints only.`
            );
            return;
        }

        if (tradabilityPendingSymbols.length > 0) {
            setError(`Checking Jupiter Quick Buy/Quick Exit routes for: ${tradabilityPendingSymbols.join(', ')}. Please wait.`);
            return;
        }

        if (quickRoutesUnavailableForIndex && !allowNonTradableTokens) {
            setError(
                `This composition has incomplete quick-route coverage across SOL/USDC/USDT (${quickRouteCoverageSummaryText}) ${
                    quickRouteUnavailableTokenSymbols.length > 0
                        ? `Impacted tokens: ${quickRouteUnavailableTokenSymbols.join(', ')}. `
                        : ''
                }Quick Buy/Quick Exit will be deactivated, but Basket Deposit/Withdraw remains available.`
            );
            return;
        }

        setCreateWorkflowSteps(
            buildCreateWorkflowSteps({
                feeCollectorNeedsUpdate,
                tradeFeeNeedsUpdate,
            })
        );
        setCreateWorkflowModalOpen(true);
        setCreateWorkflowError(null);
        setLoading(true);
        setError(null);

        let activeCreateStepId: CreateWorkflowStepId | null = null;
        try {
            const indexMintKeypair = Keypair.generate();
            const [indexConfigPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('index_config'), indexMintKeypair.publicKey.toBuffer()],
                program.programId
            );

            activeCreateStepId = 'create-index';
            updateCreateWorkflowStep('create-index', { status: 'active' });
            const tx = await program.methods
                .createIndex(assets, units)
                .accountsPartial({
                    admin: wallet.publicKey,
                    indexMint: indexMintKeypair.publicKey,
                })
                .remainingAccounts(
                    assets.map((mint) => ({
                        pubkey: mint,
                        isSigner: false,
                        isWritable: false,
                    }))
                )
                .signers([indexMintKeypair])
                .rpc();

            console.log('Created Index:', tx);
            appendCreateWorkflowSignature('create-index', tx);
            updateCreateWorkflowStep('create-index', { status: 'done' });

            activeCreateStepId = 'set-metadata';
            updateCreateWorkflowStep('set-metadata', { status: 'active' });
            const setMetadataTx = await program.methods
                .setIndexMetadata(normalizedName, indexDescription)
                .accounts({
                    indexConfig: indexConfigPda,
                    admin: wallet.publicKey,
                })
                .rpc();
            console.log('Updated index metadata:', setMetadataTx);
            appendCreateWorkflowSignature('set-metadata', setMetadataTx);
            updateCreateWorkflowStep('set-metadata', { status: 'done' });

            activeCreateStepId = 'finalize-settings';
            updateCreateWorkflowStep('finalize-settings', { status: 'active' });
            if (!feeCollectorNeedsUpdate && !tradeFeeNeedsUpdate) {
                updateCreateWorkflowStep('finalize-settings', {
                    status: 'done',
                    description: 'No fee changes requested; using default settings.',
                });
            }

            if (feeCollectorNeedsUpdate) {
                const setCollectorTx = await program.methods
                    .setFeeCollector(feeCollector)
                    .accounts({
                        indexConfig: indexConfigPda,
                        admin: wallet.publicKey,
                    })
                    .rpc();
                console.log('Updated fee collector:', setCollectorTx);
                appendCreateWorkflowSignature('finalize-settings', setCollectorTx);
            }

            if (tradeFeeNeedsUpdate) {
                const setFeeTx = await program.methods
                    .setTradeFeeBps(feeBps)
                    .accounts({
                        indexConfig: indexConfigPda,
                        admin: wallet.publicKey,
                    })
                    .rpc();
                console.log('Updated trade fee:', setFeeTx);
                appendCreateWorkflowSignature('finalize-settings', setFeeTx);
            }

            if (feeCollectorNeedsUpdate || tradeFeeNeedsUpdate) {
                updateCreateWorkflowStep('finalize-settings', { status: 'done' });
            }

            router.push(`/index/${indexMintKeypair.publicKey.toBase58()}`);
        } catch (err: unknown) {
            console.error('Error creating index:', err);
            if (activeCreateStepId) {
                updateCreateWorkflowStep(activeCreateStepId, { status: 'error' });
            }
            setCreateWorkflowError(getErrorMessage(err));
            setError('Failed to create index. Check wallet and balances, then retry.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            <header className="glass-card p-6 md:p-8">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                    <div>
                        <p className="section-label mb-2">Create stage 1 index</p>
                        <h1 className="section-title">Build your basket in minutes</h1>
                        <p className="section-subtitle mt-2">
                            Pick up to {STAGE1_MAX_ASSETS} assets and define per-share token amounts.
                        </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-lime-300/30 bg-lime-300/10 px-3 py-1.5 text-xs font-medium text-lime-100">
                        {selectedTokens.length}/{STAGE1_MAX_ASSETS} selected
                    </div>
                </div>
            </header>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_1fr]">
                <section className="glass-card p-5 md:p-6">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="display-font text-lg font-semibold text-white">Asset universe</h2>
                        <span className="text-xs text-zinc-300/85">{displayedTokens.length} shown</span>
                    </div>

                    <input
                        type="text"
                        value={tokenSearchQuery}
                        onChange={(e) => setTokenSearchQuery(e.target.value)}
                        className="soft-input mb-3"
                        placeholder="Search Jupiter by token name, symbol, or mint address"
                    />

                    <div className="mb-3 flex items-center justify-between text-xs text-zinc-300/85">
                        <span>
                            {tokenSearchQuery.trim().length > 0
                                ? 'Search results from Jupiter'
                                : `Top ${TOP_TOKEN_LIMIT} Jupiter tokens`}
                        </span>
                        {tokenLoading ? <span>Loading...</span> : null}
                    </div>

                    {tokenLoadError ? (
                        <p className="mb-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-2.5 py-2 text-xs text-amber-200">
                            {tokenLoadError}
                        </p>
                    ) : null}

                    <div className="grid max-h-[560px] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                        {displayedTokens.map((token) => {
                            const selected = selectedTokens.includes(token.mint);
                            const disabled = !selected && selectedTokens.length >= STAGE1_MAX_ASSETS;
                            return (
                                <button
                                    key={token.mint}
                                    onClick={() => handleToggleToken(token.mint)}
                                    disabled={disabled}
                                    className={`rounded-2xl border p-3 text-left transition ${
                                        selected
                                            ? 'border-lime-300/50 bg-lime-300/10 text-zinc-100'
                                            : 'border-white/16 bg-black/36 text-zinc-300 hover:border-white/28'
                                    } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                            <TokenAvatar symbol={token.symbol} logoURI={token.logoURI} className="size-8" />
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium">{token.symbol}</p>
                                                <p className="truncate text-xs text-zinc-300/85">{token.name}</p>
                                            </div>
                                        </div>
                                        {selected ? <Check size={15} className="text-lime-200" /> : null}
                                    </div>
                                </button>
                            );
                        })}
                        {displayedTokens.length === 0 ? (
                            <div className="col-span-full rounded-2xl border border-white/12 bg-black/30 p-4 text-sm text-zinc-300/85">
                                No tokens matched your search.
                            </div>
                        ) : null}
                    </div>
                </section>

                <section className="glass-card p-5 md:p-6">
                    <h2 className="display-font text-lg font-semibold text-white">Index setup</h2>

                    {selectedTokens.length === 0 ? (
                        <div className="mt-5 inner-card-soft border-dashed p-8 text-center text-sm text-zinc-300/85">
                            Select assets to begin composition.
                        </div>
                    ) : (
                        <div className="mt-5 space-y-5">
                            <div className="space-y-2">
                                {selectedTokens.map((mint) => {
                                    const token = tokenByMint.get(mint);
                                    const symbol = token?.symbol || mint.slice(0, 6);
                                    const tradabilityStatus = tokenTradabilityByMint[mint];
                                    const tradabilityError = tokenTradabilityErrorByMint[mint];
                                    const routeResult = tokenQuickRouteByMint[mint];
                                    const mintProgramOwner = tokenProgramOwnerByMint[mint];
                                    const mintProgramCheckError = tokenProgramCheckErrorByMint[mint];
                                    const tokenProgramPending = !mintProgramOwner && !mintProgramCheckError;
                                    const roundTripBases =
                                        routeResult?.baseCapabilities.filter((base) => base.roundTripSupported).map((base) => base.symbol) ?? [];
                                    const quickBuyOnlyBases =
                                        routeResult?.baseCapabilities
                                            .filter((base) => base.quickBuySupported && !base.quickSellSupported)
                                            .map((base) => base.symbol) ?? [];
                                    const quickSellOnlyBases =
                                        routeResult?.baseCapabilities
                                            .filter((base) => !base.quickBuySupported && base.quickSellSupported)
                                            .map((base) => base.symbol) ?? [];
                                    return (
                                        <div
                                            key={mint}
                                            className="inner-card-soft p-3"
                                        >
                                            <div className="mb-2 flex items-center justify-between gap-3">
                                                <span className="text-sm font-medium text-zinc-100">{symbol}</span>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[11px] text-zinc-300/85">
                                                        {mint.slice(0, 6)}...{mint.slice(-4)}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRemoveSelectedToken(mint)}
                                                        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/16 bg-black/28 text-zinc-300 transition hover:border-rose-400/40 hover:text-rose-200"
                                                        aria-label={`Remove ${symbol}`}
                                                        title={`Remove ${symbol}`}
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            </div>
                                            <input
                                                type="number"
                                                min="0"
                                                step="any"
                                                value={weights[mint]}
                                                onChange={(e) => setWeights((prev) => ({ ...prev, [mint]: e.target.value }))}
                                                className="soft-input"
                                                placeholder="Tokens per share"
                                            />
                                            <p
                                                className={`mt-2 text-[11px] ${
                                                    tokenProgramPending
                                                        ? 'text-zinc-300/85'
                                                        : tradabilityStatus === 'non-tradable' || tradabilityStatus === 'error'
                                                        ? 'text-amber-300'
                                                        : tradabilityStatus === 'tradable' || tradabilityStatus === 'limited'
                                                          ? 'text-emerald-300'
                                                          : 'text-zinc-300/85'
                                                }`}
                                            >
                                                {tokenProgramPending
                                                    ? 'Checking token program support...'
                                                    : tradabilityStatus === 'tradable'
                                                    ? 'Quick Buy/Quick Exit supported via SOL, USDC, and USDT.'
                                                    : tradabilityStatus === 'limited'
                                                      ? `${symbol} has partial quick-route coverage. ${
                                                            roundTripBases.length > 0 ? `Shared lanes: ${roundTripBases.join(', ')}. ` : ''
                                                        }${
                                                            quickBuyOnlyBases.length > 0
                                                                ? `Buy-only lanes: ${quickBuyOnlyBases.join(', ')}. `
                                                                : ''
                                                        }${
                                                            quickSellOnlyBases.length > 0
                                                                ? `Sell-only lanes: ${quickSellOnlyBases.join(', ')}.`
                                                                : ''
                                                        }`.trim()
                                                    : tradabilityStatus === 'non-tradable'
                                                      ? `${symbol} is not tradable across Quick Buy/Quick Exit routes (SOL/USDC/USDT). Basket Deposit/Withdraw is still available.`
                                                      : tradabilityStatus === 'error'
                                                        ? (tradabilityError ||
                                                            `Could not verify tradability for ${symbol}; treating Quick Buy/Quick Exit as unavailable.`)
                                                        : 'Checking Jupiter Quick Buy/Quick Exit routes (SOL/USDC/USDT)...'}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="inner-card-soft p-4">
                                <p className="section-label mb-2">Minimum trade step</p>
                                {compositionStep.stepAtomic ? (
                                    <>
                                        <p className="text-xl font-semibold text-zinc-100">{compositionStep.stepHuman} shares</p>
                                        <p className={`mt-2 text-xs ${compositionStep.stepAtomic > COARSE_STEP_WARNING_ATOMIC ? 'text-amber-300' : 'text-zinc-200/85'}`}>
                                            {compositionStep.stepAtomic > COARSE_STEP_WARNING_ATOMIC
                                                ? 'This composition allows only coarse mint/redeem increments.'
                                                : 'Smaller steps improve user trading flexibility.'}
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-sm text-zinc-300/85">
                                        Enter valid values for all selected assets
                                        {compositionStep.invalidSymbol ? ` (${compositionStep.invalidSymbol})` : ''}.
                                    </p>
                                )}
                            </div>

                            <div className="space-y-3 inner-card-soft p-4">
                                <div>
                                    <label className="section-label mb-1 block">Index name</label>
                                    <input
                                        type="text"
                                        value={indexName}
                                        onChange={(e) => setIndexName(e.target.value)}
                                        maxLength={MAX_INDEX_NAME_LEN}
                                        className="soft-input"
                                        placeholder="Blue Chip Momentum"
                                    />
                                </div>

                                <div>
                                    <label className="section-label mb-1 block">Description</label>
                                    <textarea
                                        value={indexDescription}
                                        onChange={(e) => setIndexDescription(e.target.value)}
                                        maxLength={MAX_INDEX_DESCRIPTION_LEN}
                                        rows={3}
                                        className="soft-input resize-none"
                                        placeholder="Strategy and risk profile"
                                    />
                                </div>
                            </div>

                            <div className="space-y-3 inner-card-soft p-4">
                                <div>
                                    <label className="section-label mb-1 block">Trade fee (%)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        max="10"
                                        step="0.01"
                                        value={tradeFeePercent}
                                        onChange={(e) => setTradeFeePercent(e.target.value)}
                                        className="soft-input"
                                    />
                                </div>

                                <div>
                                    <label className="section-label mb-1 block">Fee collector wallet</label>
                                    <input
                                        type="text"
                                        value={feeCollectorAddress}
                                        onChange={(e) => setFeeCollectorAddress(e.target.value)}
                                        placeholder={wallet?.publicKey?.toBase58() || 'Defaults to connected wallet'}
                                        className="soft-input font-mono text-xs"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="mt-6 border-t border-white/10 pt-5">
                    {error ? (
                        <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                            {error}
                        </p>
                    ) : null}
                    {tokenProgramPendingSymbols.length > 0 ? (
                        <div className="mb-3 rounded-lg border border-sky-300/30 bg-sky-300/10 px-3 py-2 text-xs text-sky-100">
                            Checking token program support for: {tokenProgramPendingSymbols.join(', ')}.
                        </div>
                    ) : null}
                    {tradabilityPendingSymbols.length > 0 ? (
                        <div className="mb-3 rounded-lg border border-sky-300/30 bg-sky-300/10 px-3 py-2 text-xs text-sky-100">
                            Checking Jupiter Quick Buy/Quick Exit routes (SOL/USDC/USDT) for: {tradabilityPendingSymbols.join(', ')}.
                        </div>
                    ) : null}
                    {selectedTokens.length > 0 && tradabilityPendingSymbols.length === 0 ? (
                        <div className="mb-3 rounded-lg border border-white/14 bg-black/25 px-3 py-2 text-xs text-zinc-200/90">
                            <p className="font-medium text-zinc-100">Quick route matrix (all selected components must pass per lane)</p>
                            <div className="mt-2 space-y-1">
                                {indexQuickRouteSupportByBase.map((base) => (
                                    <div key={base.symbol} className="rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                                        <p className="text-zinc-100">
                                            {base.symbol}: Buy {base.quickBuySupported ? 'yes' : 'no'}, Sell {base.quickSellSupported ? 'yes' : 'no'}
                                        </p>
                                        <p className="text-[11px] text-zinc-300/85">
                                            {base.roundTripSupported
                                                ? `Min Quick Buy: ${formatMinQuickShares(base.minQuickBuySharesAtomic)} | Min Quick Exit: ${formatMinQuickShares(base.minQuickSellSharesAtomic)}`
                                                : `Buy blockers: ${
                                                      base.buyBlockedSymbols.length > 0 ? base.buyBlockedSymbols.join(', ') : 'n/a'
                                                  } | Sell blockers: ${
                                                      base.sellBlockedSymbols.length > 0 ? base.sellBlockedSymbols.join(', ') : 'n/a'
                                                  }`}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            <p className="mt-2 text-zinc-200/90">
                                {indexQuickBuyBaseSymbols.length > 0 && indexQuickSellBaseSymbols.length > 0
                                    ? indexRoundTripBaseSymbols.length > 0
                                        ? `Quick Buy lanes: ${indexQuickBuyBaseSymbols.join(', ')}. Quick Exit lanes: ${indexQuickSellBaseSymbols.join(', ')}. Shared lanes: ${indexRoundTripBaseSymbols.join(', ')}.`
                                        : `Quick Buy lanes: ${indexQuickBuyBaseSymbols.join(', ')}. Quick Exit lanes: ${indexQuickSellBaseSymbols.join(', ')}. No shared lane, but the app can route each side through an active lane.`
                                    : indexPartiallySupportedBaseSymbols.length > 0
                                      ? `Quick-route coverage is incomplete. ${quickRouteCoverageSummaryText} Partial lanes: ${indexPartiallySupportedBaseSymbols.join(', ')}.`
                                      : `No Quick Buy/Quick Exit lanes are available for this composition. ${quickRouteCoverageSummaryText}`}
                            </p>
                        </div>
                    ) : null}
                    {limitedQuickRouteTokenSymbols.length > 0 ? (
                        <div className="mb-3 rounded-lg border border-lime-300/30 bg-lime-300/10 px-3 py-2 text-xs text-lime-100">
                            Limited quick-route coverage for: {limitedQuickRouteTokenSymbols.join(', ')}. The app can fallback-route via active lanes when possible.
                        </div>
                    ) : null}
                    {quickRouteUnavailableTokenSymbols.length > 0 ? (
                        <div className="mb-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">
                            These tokens are not tradable across Quick Buy/Quick Exit routes (SOL/USDC/USDT): {quickRouteUnavailableTokenSymbols.join(', ')}. Quick Buy/Quick Exit will be deactivated for this index. Basket Deposit/Withdraw remains available.
                        </div>
                    ) : null}
                    {unsupportedTokenProgramSymbols.length > 0 ? (
                        <div className="mb-3 rounded-lg border border-rose-300/35 bg-rose-300/10 px-3 py-2 text-xs text-rose-200">
                            Unsupported token program for: {unsupportedTokenProgramSymbols.join(', ')}. This protocol supports SPL Token and
                            basic Token-2022 mints only.
                        </div>
                    ) : null}
                    {quickRoutesUnavailableForIndex ? (
                        <label className="mb-3 flex items-start gap-2 rounded-lg border border-white/12 bg-black/25 px-3 py-2 text-xs text-zinc-200/90">
                            <input
                                type="checkbox"
                                checked={allowNonTradableTokens}
                                onChange={(e) => setAllowNonTradableTokens(e.target.checked)}
                                className="mt-0.5"
                            />
                            <span>
                                Create anyway with Basket Deposit/Withdraw only when quick-route coverage is incomplete.
                            </span>
                        </label>
                    ) : null}
                        <button
                            onClick={handleCreate}
                            disabled={
                                loading ||
                                selectedTokens.length === 0 ||
                                tokenProgramPendingSymbols.length > 0 ||
                                tradabilityPendingSymbols.length > 0 ||
                                unsupportedTokenProgramSymbols.length > 0
                            }
                            className="btn-primary w-full py-3.5 text-base"
                        >
                            {loading ? <Loader2 className="animate-spin" size={18} /> : null}
                            {loading
                                ? 'Creating...'
                                : tokenProgramPendingSymbols.length > 0
                                  ? 'Checking token programs...'
                                  : tradabilityPendingSymbols.length > 0
                                    ? 'Checking routes...'
                                    : 'Launch index'}
                        </button>
                    </div>
                </section>
            </div>

            {createWorkflowModalOpen ? (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="inner-card-soft w-full max-w-xl space-y-5 p-6">
                        <div className="space-y-1">
                            <h3 className="text-xl font-semibold text-white">Create index in 3 guided steps</h3>
                            <p className="text-sm text-zinc-200/85">
                                Wallet prompts will appear one-by-one. Approve each prompt to finish index creation.
                            </p>
                        </div>

                        <div className="inner-card max-h-80 space-y-2 overflow-y-auto p-4">
                            {createWorkflowSteps.map((step) => (
                                <div key={step.id} className="inner-card px-3 py-2.5">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-zinc-100">{step.label}</span>
                                        <span
                                            className={`rounded-full px-2 py-1 text-xs font-medium ${
                                                step.status === 'done'
                                                    ? 'bg-emerald-500/20 text-emerald-300'
                                                    : step.status === 'active'
                                                      ? 'bg-lime-500/20 text-lime-300'
                                                      : step.status === 'error'
                                                        ? 'bg-rose-500/20 text-rose-300'
                                                        : 'bg-zinc-800 text-zinc-200/85'
                                            }`}
                                        >
                                            {step.status === 'done'
                                                ? 'Done'
                                                : step.status === 'active'
                                                  ? 'In Progress'
                                                  : step.status === 'error'
                                                    ? 'Failed'
                                                    : 'Pending'}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-zinc-300/85">{step.description}</p>
                                    {step.txSignatures.length > 0 ? (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            {step.txSignatures.map((signature, idx) => (
                                                <a
                                                    key={`${step.id}-${signature}`}
                                                    href={getExplorerTxUrl(signature)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="text-xs text-lime-400 hover:text-lime-300 hover:underline"
                                                >
                                                    View transaction{step.txSignatures.length > 1 ? ` ${idx + 1}` : ''}
                                                </a>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ))}
                        </div>

                        {loading ? (
                            <div className="rounded-lg border border-sky-300/30 bg-sky-300/10 px-3 py-2 text-xs text-sky-100">
                                Waiting for wallet confirmation...
                            </div>
                        ) : null}

                        {createWorkflowError ? (
                            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                                {createWorkflowError}
                            </div>
                        ) : null}

                        <div className="flex items-center justify-end">
                            <button
                                type="button"
                                onClick={() => setCreateWorkflowModalOpen(false)}
                                disabled={loading}
                                className="btn-secondary px-4 py-2 disabled:opacity-50"
                            >
                                {loading ? 'Processing...' : 'Close'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
