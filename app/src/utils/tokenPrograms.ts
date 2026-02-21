import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
    ExtensionType,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getExtensionTypes,
    unpackMint,
} from '@solana/spl-token';

export const TOKEN_PROGRAM_ID_STR = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022_PROGRAM_ID_STR = TOKEN_2022_PROGRAM_ID.toBase58();

const SUPPORTED_TOKEN_2022_MINT_EXTENSIONS = new Set<ExtensionType>([
    ExtensionType.Uninitialized,
    ExtensionType.MintCloseAuthority,
    ExtensionType.MetadataPointer,
    ExtensionType.TokenMetadata,
    ExtensionType.GroupPointer,
    ExtensionType.TokenGroup,
    ExtensionType.GroupMemberPointer,
    ExtensionType.TokenGroupMember,
]);

const TOKEN_2022_EXTENSION_LABELS: Record<number, string> = {};

function addExtensionLabel(extensionName: string): void {
    const enumValue = (ExtensionType as unknown as Record<string, unknown>)[extensionName];
    if (typeof enumValue === 'number') {
        TOKEN_2022_EXTENSION_LABELS[enumValue] = extensionName;
    }
}

[
    'TransferFeeConfig',
    'TransferFeeAmount',
    'ConfidentialTransferMint',
    'ConfidentialTransferAccount',
    'DefaultAccountState',
    'ImmutableOwner',
    'MemoTransfer',
    'NonTransferable',
    'InterestBearingConfig',
    'CpiGuard',
    'PermanentDelegate',
    'NonTransferableAccount',
    'TransferHook',
    'TransferHookAccount',
    'ConfidentialTransferFeeConfig',
    'ConfidentialTransferFeeAmount',
    'ConfidentialMintBurn',
    'ScaledUiAmountConfig',
    'PausableConfig',
    'PausableAccount',
].forEach(addExtensionLabel);

export function isSupportedAssetTokenProgramOwner(owner: string): boolean {
    return owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
}

export function parseUnsupportedToken2022MintExtensions(params: {
    mint: PublicKey | string;
    mintAccountInfo: AccountInfo<Buffer>;
}): ExtensionType[] {
    const mintPubkey = typeof params.mint === 'string' ? new PublicKey(params.mint) : params.mint;
    const mint = unpackMint(mintPubkey, params.mintAccountInfo, TOKEN_2022_PROGRAM_ID);
    const extensionTypes = getExtensionTypes(mint.tlvData);
    return extensionTypes.filter((extensionType) => !SUPPORTED_TOKEN_2022_MINT_EXTENSIONS.has(extensionType));
}

export function formatToken2022ExtensionNames(extensionTypes: ExtensionType[]): string {
    if (extensionTypes.length === 0) return 'none';
    return extensionTypes
        .map((extensionType) => TOKEN_2022_EXTENSION_LABELS[extensionType] ?? `Extension(${extensionType})`)
        .join(', ');
}
