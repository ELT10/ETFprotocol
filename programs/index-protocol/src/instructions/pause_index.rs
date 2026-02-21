use crate::constants::SEED_INDEX_CONFIG;
use crate::state::IndexConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PauseIndex<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnpauseIndex<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

pub fn pause_handler(ctx: Context<PauseIndex>) -> Result<()> {
    let index_config = &mut ctx.accounts.index_config;
    index_config.paused = true;
    msg!("Index paused.");
    Ok(())
}

pub fn unpause_handler(ctx: Context<UnpauseIndex>) -> Result<()> {
    let index_config = &mut ctx.accounts.index_config;
    index_config.paused = false;
    msg!("Index unpaused.");
    Ok(())
}
