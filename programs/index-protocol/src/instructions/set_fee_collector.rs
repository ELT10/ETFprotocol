use crate::constants::SEED_INDEX_CONFIG;
use crate::errors::IndexError;
use crate::state::IndexConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetFeeCollector<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetFeeCollector>, new_fee_collector: Pubkey) -> Result<()> {
    require!(
        new_fee_collector != Pubkey::default(),
        IndexError::InvalidFeeCollector
    );

    ctx.accounts.index_config.fee_collector = new_fee_collector;
    msg!("Set fee_collector to {}.", new_fee_collector);
    Ok(())
}
