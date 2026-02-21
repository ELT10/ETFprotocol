use crate::constants::{MAX_TRADE_FEE_BPS, SEED_INDEX_CONFIG};
use crate::errors::IndexError;
use crate::state::IndexConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetTradeFeeBps<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetTradeFeeBps>, new_trade_fee_bps: u16) -> Result<()> {
    require!(
        new_trade_fee_bps <= MAX_TRADE_FEE_BPS,
        IndexError::FeeTooHigh
    );

    ctx.accounts.index_config.trade_fee_bps = new_trade_fee_bps;
    msg!("Set trade_fee_bps to {}.", new_trade_fee_bps);
    Ok(())
}
