use crate::constants::{MAX_ASSETS, SEED_INDEX_CONFIG};
use crate::errors::IndexError;
use crate::state::IndexConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetMaxAssets<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetMaxAssets>, new_max_assets: u8) -> Result<()> {
    let index_config = &mut ctx.accounts.index_config;
    let new_limit = new_max_assets as usize;

    require!(
        new_limit > 0 && new_limit <= MAX_ASSETS,
        IndexError::InvalidMaxAssets
    );
    require!(
        index_config.assets.len() <= new_limit,
        IndexError::MaxAssetsBelowCurrentComposition
    );

    index_config.max_assets = new_max_assets;

    msg!("Set max_assets to {}.", new_max_assets);
    Ok(())
}
