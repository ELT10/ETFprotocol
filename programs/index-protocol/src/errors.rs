use anchor_lang::prelude::*;

#[error_code]
pub enum IndexError {
    #[msg("The assets and units arrays must be of equal length.")]
    InvalidInputLengths,
    #[msg("At least one asset is required.")]
    EmptyAssets,
    #[msg("Too many assets in the index.")]
    TooManyAssets,
    #[msg("Asset units must be greater than zero.")]
    ZeroUnits,
    #[msg("Duplicate assets are not allowed.")]
    DuplicateAsset,
    #[msg("Calculation overflow.")]
    Overflow,
    #[msg("Quantity must be greater than zero.")]
    InvalidQuantity,
    #[msg("Slippage limit exceeded.")]
    SlippageExceeded,
    #[msg("Invalid asset in basket.")]
    InvalidAsset,
    #[msg("Invalid vault account for this index asset.")]
    InvalidVaultAccount,
    #[msg("Invalid token account owner for this operation.")]
    InvalidTokenAccountOwner,
    #[msg("Invalid max assets value.")]
    InvalidMaxAssets,
    #[msg("Cannot set max assets below current composition size.")]
    MaxAssetsBelowCurrentComposition,
    #[msg("Index is paused.")]
    IndexPaused,
    #[msg("No pending admin is set.")]
    NoPendingAdmin,
    #[msg("Signer is not the pending admin.")]
    InvalidPendingAdmin,
    #[msg("New admin cannot be the default pubkey.")]
    InvalidNewAdmin,
    #[msg("Share quantity is not compatible with this index composition granularity.")]
    InvalidShareQuantityGranularity,
    #[msg("Invalid number of asset token accounts provided.")]
    InvalidAssetAccountCount,
    #[msg("Asset token account is not owned by the expected token program.")]
    InvalidTokenProgramOwner,
    #[msg("Failed to decode token account data.")]
    InvalidTokenAccountData,
    #[msg("Asset mint account is invalid or missing.")]
    InvalidAssetMintAccount,
    #[msg("Asset mint account owner does not match configured token program.")]
    InvalidAssetMintOwner,
    #[msg("Asset token program is unsupported. Only Tokenkeg and Token-2022 are allowed.")]
    UnsupportedAssetTokenProgram,
    #[msg("This Token-2022 mint uses unsupported extensions for this protocol.")]
    UnsupportedToken2022MintExtensions,
    #[msg("Asset remaining accounts must be provided in the expected mint/account tuple layout.")]
    InvalidAssetAccountLayout,
    #[msg("Trade fee exceeds the max allowed value.")]
    FeeTooHigh,
    #[msg("Fee collector cannot be the default pubkey.")]
    InvalidFeeCollector,
    #[msg("Fee collector token account is invalid.")]
    InvalidFeeCollectorTokenAccount,
    #[msg("Net share quantity is zero after fees.")]
    NetQuantityZeroAfterFees,
    #[msg("Index name cannot be empty.")]
    EmptyIndexName,
    #[msg("Index name is too long.")]
    IndexNameTooLong,
    #[msg("Index description is too long.")]
    IndexDescriptionTooLong,
}
