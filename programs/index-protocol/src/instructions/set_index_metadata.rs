use crate::constants::SEED_INDEX_CONFIG;
use crate::state::IndexConfig;
use crate::validation::validate_metadata;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetIndexMetadata<'info> {
    #[account(
        mut,
        seeds = [SEED_INDEX_CONFIG, index_config.index_mint.as_ref()],
        bump = index_config.bump,
        has_one = admin
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetIndexMetadata>, name: String, description: String) -> Result<()> {
    validate_metadata(&name, &description)?;

    let index_config = &mut ctx.accounts.index_config;
    index_config.name = name.trim().to_string();
    index_config.description = description;

    msg!("Updated index metadata.");
    Ok(())
}
