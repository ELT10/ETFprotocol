use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod validation;

use instructions::*;

declare_id!("8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD");

#[program]
pub mod index_protocol {
    use super::*;

    pub fn create_index(
        ctx: Context<CreateIndex>,
        assets: Vec<Pubkey>,
        units: Vec<u64>,
    ) -> Result<()> {
        instructions::create_index::handler(ctx, assets, units)
    }

    pub fn issue_shares<'info>(
        ctx: Context<'_, '_, '_, 'info, IssueShares<'info>>,
        quantity: u64,
    ) -> Result<()> {
        instructions::issue_shares::handler(ctx, quantity)
    }

    pub fn redeem_shares<'info>(
        ctx: Context<'_, '_, '_, 'info, RedeemShares<'info>>,
        quantity: u64,
    ) -> Result<()> {
        instructions::redeem_shares::handler(ctx, quantity)
    }

    pub fn pause_index(ctx: Context<PauseIndex>) -> Result<()> {
        instructions::pause_index::pause_handler(ctx)
    }

    pub fn unpause_index(ctx: Context<UnpauseIndex>) -> Result<()> {
        instructions::pause_index::unpause_handler(ctx)
    }

    pub fn set_pending_admin(ctx: Context<SetPendingAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin_transfer::set_pending_admin_handler(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin_transfer::accept_admin_handler(ctx)
    }

    pub fn set_max_assets(ctx: Context<SetMaxAssets>, new_max_assets: u8) -> Result<()> {
        instructions::set_max_assets::handler(ctx, new_max_assets)
    }

    pub fn set_trade_fee_bps(
        ctx: Context<SetTradeFeeBps>,
        new_trade_fee_bps: u16,
    ) -> Result<()> {
        instructions::set_trade_fee_bps::handler(ctx, new_trade_fee_bps)
    }

    pub fn set_fee_collector(
        ctx: Context<SetFeeCollector>,
        new_fee_collector: Pubkey,
    ) -> Result<()> {
        instructions::set_fee_collector::handler(ctx, new_fee_collector)
    }

    pub fn set_index_metadata(
        ctx: Context<SetIndexMetadata>,
        name: String,
        description: String,
    ) -> Result<()> {
        instructions::set_index_metadata::handler(ctx, name, description)
    }
}
