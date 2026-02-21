use crate::constants::*;
use crate::errors::IndexError;
use crate::state::*;
use crate::validation::validate_recipe;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::{Mint, Token};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};

#[derive(Accounts)]
pub struct CreateIndex<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        mint::decimals = INDEX_MINT_DECIMALS,
        mint::authority = index_config,
        mint::freeze_authority = index_config,
    )]
    pub index_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = IndexConfig::LEN,
        seeds = [SEED_INDEX_CONFIG, index_mint.key().as_ref()],
        bump
    )]
    pub index_config: Account<'info, IndexConfig>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

fn is_supported_token_2022_mint_extension(extension_type: ExtensionType) -> bool {
    matches!(
        extension_type,
        ExtensionType::Uninitialized
            | ExtensionType::MintCloseAuthority
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
    )
}

fn validate_tokenkeg_mint(account_info: &AccountInfo) -> Result<()> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
    spl_token::state::Mint::unpack(&data).map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
    Ok(())
}

fn validate_token2022_mint(account_info: &AccountInfo) -> Result<()> {
    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
    let mint_with_extensions =
        StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data).map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
    for extension_type in mint_with_extensions
        .get_extension_types()
        .map_err(|_| error!(IndexError::InvalidAssetMintAccount))?
    {
        require!(
            is_supported_token_2022_mint_extension(extension_type),
            IndexError::UnsupportedToken2022MintExtensions
        );
    }
    Ok(())
}

pub fn handler(ctx: Context<CreateIndex>, assets: Vec<Pubkey>, units: Vec<u64>) -> Result<()> {
    validate_recipe(&assets, &units, MAX_ASSETS)?;
    require!(
        ctx.remaining_accounts.len() == assets.len(),
        IndexError::InvalidAssetAccountLayout
    );

    let index_config = &mut ctx.accounts.index_config;
    index_config.admin = ctx.accounts.admin.key();
    index_config.creator = ctx.accounts.admin.key();
    index_config.index_mint = ctx.accounts.index_mint.key();
    index_config.bump = ctx.bumps.index_config;
    index_config.max_assets = MAX_ASSETS as u8;
    index_config.paused = false;
    index_config.pending_admin = None;
    index_config.trade_fee_bps = 0;
    index_config.fee_collector = ctx.accounts.admin.key();
    index_config.lifetime_fee_shares_total = 0;
    index_config.name = "Untitled Index".to_string();
    index_config.description = String::new();

    let mut asset_components = Vec::with_capacity(assets.len());
    for (i, asset) in assets.iter().enumerate() {
        let mint_account_info = ctx
            .remaining_accounts
            .get(i)
            .ok_or_else(|| error!(IndexError::InvalidAssetMintAccount))?;
        require!(
            mint_account_info.key == asset,
            IndexError::InvalidAssetMintAccount
        );

        let token_program = *mint_account_info.owner;
        if token_program == spl_token::ID {
            validate_tokenkeg_mint(mint_account_info)?;
        } else if token_program == spl_token_2022::ID {
            validate_token2022_mint(mint_account_info)?;
        } else {
            return err!(IndexError::UnsupportedAssetTokenProgram);
        }

        asset_components.push(AssetComponent {
            mint: *asset,
            units: units[i],
            token_program,
        });
    }
    index_config.assets = asset_components;

    msg!("Created Index with {} assets.", assets.len());

    Ok(())
}
