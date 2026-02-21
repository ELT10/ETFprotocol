import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { MAX_INDEX_DESCRIPTION_LEN, MAX_INDEX_NAME_LEN } from '@/utils/protocol';

export interface ParsedAssetComponent {
    mint: PublicKey;
    units: BN;
    tokenProgram: PublicKey;
}

export interface ParsedIndexConfigAccountData {
    admin: PublicKey;
    creator: PublicKey;
    name: string;
    description: string;
    indexMint: PublicKey;
    assets: ParsedAssetComponent[];
    bump: number;
    maxAssets: number;
    paused: boolean;
    pendingAdmin: PublicKey | null;
    tradeFeeBps: number;
    feeCollector: PublicKey;
    lifetimeFeeSharesTotal: BN;
}

const PUBKEY_BYTES = 32;
const U16_BYTES = 2;
const U64_BYTES = 8;
const U32_BYTES = 4;
const OPTION_TAG_BYTES = 1;
const OPTION_PUBKEY_MAX_BYTES = OPTION_TAG_BYTES + PUBKEY_BYTES;
const LEGACY_ASSET_COMPONENT_BYTES = PUBKEY_BYTES + U64_BYTES;
const ASSET_COMPONENT_BYTES = PUBKEY_BYTES + U64_BYTES + PUBKEY_BYTES;
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SPL_TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SUPPORTED_TOKEN_PROGRAMS = new Set([
    SPL_TOKEN_PROGRAM_ID.toBase58(),
    SPL_TOKEN_2022_PROGRAM_ID.toBase58(),
]);

// Minimum serialized bytes required to decode IndexConfig when pending_admin = None.
export const MIN_INDEX_CONFIG_SERIALIZED_HEADER_SIZE =
    8 + // discriminator
    PUBKEY_BYTES + // admin
    PUBKEY_BYTES + // creator
    PUBKEY_BYTES + // index mint
    1 + // bump
    1 + // max assets
    1 + // paused
    OPTION_TAG_BYTES + // pending admin option tag
    U16_BYTES + // trade_fee_bps
    PUBKEY_BYTES + // fee_collector
    U64_BYTES + // lifetime_fee_shares_total
    U32_BYTES + // name len
    U32_BYTES + // description len
    U32_BYTES; // vec len

// Account space header (matches on-chain allocation), includes max Option<Pubkey> size.
export const INDEX_CONFIG_ACCOUNT_HEADER_SIZE =
    8 + // discriminator
    PUBKEY_BYTES + // admin
    PUBKEY_BYTES + // creator
    PUBKEY_BYTES + // index mint
    1 + // bump
    1 + // max assets
    1 + // paused
    OPTION_PUBKEY_MAX_BYTES + // pending admin option max size
    U16_BYTES + // trade_fee_bps
    PUBKEY_BYTES + // fee_collector
    U64_BYTES + // lifetime_fee_shares_total
    U32_BYTES + MAX_INDEX_NAME_LEN + // name
    U32_BYTES + MAX_INDEX_DESCRIPTION_LEN + // description
    U32_BYTES; // vec len

export function indexConfigAccountSize(maxAssetsCap: number): number {
    return INDEX_CONFIG_ACCOUNT_HEADER_SIZE + (maxAssetsCap * ASSET_COMPONENT_BYTES);
}

function readU16LE(data: Uint8Array, offset: number): number | null {
    if (offset + U16_BYTES > data.length) return null;
    const view = new DataView(data.buffer, data.byteOffset + offset, U16_BYTES);
    return view.getUint16(0, true);
}

function readU32LE(data: Uint8Array, offset: number): number | null {
    if (offset + U32_BYTES > data.length) return null;
    const view = new DataView(data.buffer, data.byteOffset + offset, U32_BYTES);
    return view.getUint32(0, true);
}

function readU64LEAsBN(data: Uint8Array, offset: number): BN | null {
    if (offset + U64_BYTES > data.length) return null;
    const bytes = data.slice(offset, offset + U64_BYTES);
    return new BN(bytes, 10, 'le');
}

function parseAssetsWithTokenProgram(
    source: Uint8Array,
    startOffset: number,
    assetsLen: number
): { assets: ParsedAssetComponent[]; nextOffset: number } | null {
    let cursor = startOffset + U32_BYTES;
    if (cursor + assetsLen * ASSET_COMPONENT_BYTES > source.length) return null;

    const assets: ParsedAssetComponent[] = [];
    for (let i = 0; i < assetsLen; i += 1) {
        const mint = new PublicKey(source.slice(cursor, cursor + PUBKEY_BYTES));
        cursor += PUBKEY_BYTES;

        const units = readU64LEAsBN(source, cursor);
        if (!units) return null;
        cursor += U64_BYTES;

        const tokenProgram = new PublicKey(source.slice(cursor, cursor + PUBKEY_BYTES));
        cursor += PUBKEY_BYTES;
        if (!SUPPORTED_TOKEN_PROGRAMS.has(tokenProgram.toBase58())) return null;

        assets.push({ mint, units, tokenProgram });
    }

    return { assets, nextOffset: cursor };
}

function parseLegacyAssets(
    source: Uint8Array,
    startOffset: number,
    assetsLen: number
): { assets: ParsedAssetComponent[]; nextOffset: number } | null {
    let cursor = startOffset + U32_BYTES;
    if (cursor + assetsLen * LEGACY_ASSET_COMPONENT_BYTES > source.length) return null;

    const assets: ParsedAssetComponent[] = [];
    for (let i = 0; i < assetsLen; i += 1) {
        const mint = new PublicKey(source.slice(cursor, cursor + PUBKEY_BYTES));
        cursor += PUBKEY_BYTES;

        const units = readU64LEAsBN(source, cursor);
        if (!units) return null;
        cursor += U64_BYTES;

        assets.push({ mint, units, tokenProgram: SPL_TOKEN_PROGRAM_ID });
    }

    return { assets, nextOffset: cursor };
}

function readUtf8String(
    data: Uint8Array,
    offset: number,
    maxLenBytes: number
): { value: string; nextOffset: number } | null {
    const len = readU32LE(data, offset);
    if (len === null || len > maxLenBytes) return null;
    const start = offset + U32_BYTES;
    const end = start + len;
    if (end > data.length) return null;
    const value = new TextDecoder().decode(data.slice(start, end));
    return { value, nextOffset: end };
}

export function hasDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
    if (data.length < discriminator.length) return false;
    for (let i = 0; i < discriminator.length; i += 1) {
        if (data[i] !== discriminator[i]) return false;
    }
    return true;
}

export function parseIndexConfigAccountData(
    data: Uint8Array,
    maxAssetsHardCap: number
): ParsedIndexConfigAccountData | null {
    if (data.length < MIN_INDEX_CONFIG_SERIALIZED_HEADER_SIZE) return null;

    let offset = 8; // skip discriminator
    if (offset + PUBKEY_BYTES > data.length) return null;
    const admin = new PublicKey(data.slice(offset, offset + PUBKEY_BYTES));
    offset += PUBKEY_BYTES;

    if (offset + PUBKEY_BYTES > data.length) return null;
    const creator = new PublicKey(data.slice(offset, offset + PUBKEY_BYTES));
    offset += PUBKEY_BYTES;

    if (offset + PUBKEY_BYTES > data.length) return null;
    const indexMint = new PublicKey(data.slice(offset, offset + PUBKEY_BYTES));
    offset += PUBKEY_BYTES;

    if (offset + 3 > data.length) return null;
    const bump = data[offset];
    offset += 1;
    const maxAssets = data[offset];
    offset += 1;
    const paused = data[offset] !== 0;
    offset += 1;

    if (offset + 1 > data.length) return null;
    const pendingAdminTag = data[offset];
    offset += 1;
    let pendingAdmin: PublicKey | null = null;
    if (pendingAdminTag === 1) {
        if (offset + PUBKEY_BYTES > data.length) return null;
        pendingAdmin = new PublicKey(data.slice(offset, offset + PUBKEY_BYTES));
        offset += PUBKEY_BYTES;
    } else if (pendingAdminTag !== 0) {
        return null;
    }

    const tradeFeeBps = readU16LE(data, offset);
    if (tradeFeeBps === null) return null;
    offset += U16_BYTES;

    if (offset + PUBKEY_BYTES > data.length) return null;
    const feeCollector = new PublicKey(data.slice(offset, offset + PUBKEY_BYTES));
    offset += PUBKEY_BYTES;

    const lifetimeFeeSharesTotal = readU64LEAsBN(data, offset);
    if (!lifetimeFeeSharesTotal) return null;
    offset += U64_BYTES;

    const parseAssets = (
        source: Uint8Array,
        startOffset: number
    ): { assets: ParsedAssetComponent[]; nextOffset: number } | null => {
        const assetsLen = readU32LE(source, startOffset);
        if (assetsLen === null) return null;
        if (assetsLen > maxAssetsHardCap) return null;
        return (
            parseAssetsWithTokenProgram(source, startOffset, assetsLen) ??
            parseLegacyAssets(source, startOffset, assetsLen)
        );
    };

    // Preferred decode path (metadata-enabled layout).
    const parsedName = readUtf8String(data, offset, MAX_INDEX_NAME_LEN);
    if (parsedName) {
        const parsedDescription = readUtf8String(data, parsedName.nextOffset, MAX_INDEX_DESCRIPTION_LEN);
        if (parsedDescription) {
            const parsedAssets = parseAssets(data, parsedDescription.nextOffset);
            if (parsedAssets) {
                return {
                    admin,
                    creator,
                    name: parsedName.value,
                    description: parsedDescription.value,
                    indexMint,
                    assets: parsedAssets.assets,
                    bump,
                    maxAssets,
                    paused,
                    pendingAdmin,
                    tradeFeeBps,
                    feeCollector,
                    lifetimeFeeSharesTotal,
                };
            }
        }
    }

    // Backward-compat path for pre-metadata accounts.
    const legacyAssets = parseAssets(data, offset);
    if (!legacyAssets) return null;

    return {
        admin,
        creator,
        name: '',
        description: '',
        indexMint,
        assets: legacyAssets.assets,
        bump,
        maxAssets,
        paused,
        pendingAdmin,
        tradeFeeBps,
        feeCollector,
        lifetimeFeeSharesTotal,
    };
}
