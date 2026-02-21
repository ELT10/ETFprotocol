use crate::constants::SEED_INDEX_CONFIG;
use crate::errors::IndexError;
use crate::state::IndexConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetPendingAdmin<'info> {
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
pub struct AcceptAdmin<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub pending_admin: Signer<'info>,
}

pub fn set_pending_admin_handler(ctx: Context<SetPendingAdmin>, new_admin: Pubkey) -> Result<()> {
    require!(new_admin != Pubkey::default(), IndexError::InvalidNewAdmin);
    let index_config = &mut ctx.accounts.index_config;
    index_config.pending_admin = Some(new_admin);
    msg!("Pending admin set.");
    Ok(())
}

pub fn accept_admin_handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let index_config = &mut ctx.accounts.index_config;
    let pending = index_config
        .pending_admin
        .ok_or(IndexError::NoPendingAdmin)?;

    require!(
        pending == ctx.accounts.pending_admin.key(),
        IndexError::InvalidPendingAdmin
    );

    index_config.admin = pending;
    index_config.pending_admin = None;
    msg!("Admin transfer accepted.");
    Ok(())
}
