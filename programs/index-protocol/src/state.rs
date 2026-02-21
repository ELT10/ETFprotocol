use crate::constants::{MAX_ASSETS, MAX_INDEX_DESCRIPTION_LEN, MAX_INDEX_NAME_LEN};
use anchor_lang::prelude::*;

#[account]
pub struct IndexConfig {
    pub admin: Pubkey,      // Authority to update weights
    pub creator: Pubkey,    // Immutable creator for creator dashboard/attribution
    pub index_mint: Pubkey, // The token representing the index share
    pub bump: u8,
    pub max_assets: u8, // Admin-editable per-index limit, capped by constants::MAX_ASSETS
    pub paused: bool,   // Emergency stop for mint/redeem
    pub pending_admin: Option<Pubkey>, // Two-step admin transfer
    pub trade_fee_bps: u16, // Trade fee applied on mint/redeem in bps
    pub fee_collector: Pubkey, // Fee recipient wallet
    pub lifetime_fee_shares_total: u64, // Cumulative fee shares credited
    pub name: String, // Human-readable index name
    pub description: String, // Optional long-form strategy description

    // The recipe for 1 Share.
    // e.g. 1 Share = 100 TOKEN_A + 50 TOKEN_B
    pub assets: Vec<AssetComponent>,
}

impl IndexConfig {
    // Space calculation:
    // Discriminator (8) + Admin (32) + Creator (32) + IndexMint (32) + Bump (1) + MaxAssets (1) + Paused (1)
    // + PendingAdmin Option<Pubkey> (1 + 32) + TradeFeeBps (2) + FeeCollector (32)
    // + LifetimeFeeSharesTotal (8) + Name String (4 + MAX_INDEX_NAME_LEN)
    // + Description String (4 + MAX_INDEX_DESCRIPTION_LEN)
    // + Vec Overhead (4) + (AssetComponent Size * Max Assets)
    // Stage 1 stores up to constants::MAX_ASSETS asset components.
    // AssetComponent = 32 (mint Pubkey) + 8 (u64) + 32 (token program Pubkey) = 72 bytes.
    // 8 + 32 + 32 + 32 + 1 + 1 + 1 + 33 + 2 + 32 + 8 + (4 + MAX_INDEX_NAME_LEN)
    // + (4 + MAX_INDEX_DESCRIPTION_LEN) + 4 + (MAX_ASSETS * 72)
    pub const LEN: usize = 8
        + 32
        + 32
        + 32
        + 1
        + 1
        + 1
        + 33
        + 2
        + 32
        + 8
        + 4
        + MAX_INDEX_NAME_LEN
        + 4
        + MAX_INDEX_DESCRIPTION_LEN
        + 4
        + (MAX_ASSETS * 72);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AssetComponent {
    pub mint: Pubkey, // The token mint address
    pub units: u64,   // The atomic amount required per 1 Share
    pub token_program: Pubkey, // Token program that owns this mint (Tokenkeg or Token-2022)
}
