use anchor_lang::prelude::*;

#[constant]
pub const SEED_INDEX_CONFIG: &[u8] = b"index_config";

#[constant]
pub const SEED_VAULT: &[u8] = b"vault"; // For token accounts owned by the PDA

// Stage-1 ceiling for composition size. Mint/redeem use dynamic remaining accounts.
pub const MAX_ASSETS: usize = 10;

// On-chain metadata bounds (bytes, UTF-8 length).
pub const MAX_INDEX_NAME_LEN: usize = 40;
pub const MAX_INDEX_DESCRIPTION_LEN: usize = 280;

// Basis points configuration.
pub const BPS_DENOMINATOR: u16 = 10_000;
pub const BPS_DENOMINATOR_U128: u128 = BPS_DENOMINATOR as u128;

// Per-index trade fee is capped at 10%.
pub const MAX_TRADE_FEE_BPS: u16 = 1_000;

// Index share mint precision (matches create_index mint::decimals).
pub const INDEX_MINT_DECIMALS: u8 = 6;
pub const INDEX_SHARE_SCALE: u64 = 1_000_000;
pub const INDEX_SHARE_SCALE_U128: u128 = INDEX_SHARE_SCALE as u128;
