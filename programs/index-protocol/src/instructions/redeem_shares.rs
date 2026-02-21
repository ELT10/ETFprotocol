use crate::constants::*;
use crate::errors::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_spl::token::{
    self, Burn, Mint, Token, TokenAccount, Transfer, TransferChecked as SplTransferChecked,
};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use anchor_spl::token_2022::{
    self as token_2022, Token2022, TransferChecked as Token2022TransferChecked,
};
use anchor_spl::token_2022::spl_token_2022;

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(
        seeds = [SEED_INDEX_CONFIG, index_mint.key().as_ref()],
        bump = index_config.bump
    )]
    pub index_config: Account<'info, IndexConfig>,

    #[account(
        mut,
        address = index_config.index_mint
    )]
    pub index_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_index_token_account.mint == index_mint.key(),
        constraint = user_index_token_account.owner == user.key()
    )]
    pub user_index_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_collector_index_token_account.mint == index_mint.key(),
        constraint = fee_collector_index_token_account.owner == index_config.fee_collector
    )]
    pub fee_collector_index_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Clone, Copy)]
struct DecodedTokenAccount {
    mint: Pubkey,
    owner: Pubkey,
}

fn decode_token_account(account_info: &AccountInfo, token_program_key: &Pubkey) -> Result<DecodedTokenAccount> {
    require!(
        account_info.owner == token_program_key,
        IndexError::InvalidTokenProgramOwner
    );

    let data = account_info
        .try_borrow_data()
        .map_err(|_| error!(IndexError::InvalidTokenAccountData))?;

    if *token_program_key == spl_token::ID {
        let account =
            SplTokenAccount::unpack(&data).map_err(|_| error!(IndexError::InvalidTokenAccountData))?;
        return Ok(DecodedTokenAccount {
            mint: account.mint,
            owner: account.owner,
        });
    }

    if *token_program_key == spl_token_2022::ID {
        let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
            .map_err(|_| error!(IndexError::InvalidTokenAccountData))?;
        return Ok(DecodedTokenAccount {
            mint: account.base.mint,
            owner: account.base.owner,
        });
    }

    err!(IndexError::UnsupportedAssetTokenProgram)
}

fn decode_mint_decimals(mint_info: &AccountInfo, token_program_key: &Pubkey) -> Result<u8> {
    require!(
        mint_info.owner == token_program_key,
        IndexError::InvalidAssetMintOwner
    );

    let data = mint_info
        .try_borrow_data()
        .map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;

    if *token_program_key == spl_token::ID {
        let mint = spl_token::state::Mint::unpack(&data).map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
        return Ok(mint.decimals);
    }

    if *token_program_key == spl_token_2022::ID {
        let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)
            .map_err(|_| error!(IndexError::InvalidAssetMintAccount))?;
        return Ok(mint.base.decimals);
    }

    err!(IndexError::UnsupportedAssetTokenProgram)
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RedeemShares<'info>>,
    quantity: u64,
) -> Result<()> {
    let assets = ctx.accounts.index_config.assets.clone();
    let bump = ctx.accounts.index_config.bump;
    let index_mint_key = ctx.accounts.index_mint.key();
    let index_config_key = ctx.accounts.index_config.key();
    let configured_max_assets = ctx.accounts.index_config.max_assets as usize;
    let trade_fee_bps = ctx.accounts.index_config.trade_fee_bps;
    let fee_collector = ctx.accounts.index_config.fee_collector;

    require!(quantity > 0, IndexError::InvalidQuantity);
    require!(!ctx.accounts.index_config.paused, IndexError::IndexPaused);
    require!(!assets.is_empty(), IndexError::EmptyAssets);
    require!(
        configured_max_assets > 0 && configured_max_assets <= MAX_ASSETS,
        IndexError::InvalidMaxAssets
    );
    require!(trade_fee_bps <= MAX_TRADE_FEE_BPS, IndexError::FeeTooHigh);
    require!(
        assets.len() <= configured_max_assets,
        IndexError::TooManyAssets
    );
    require!(
        ctx.remaining_accounts.len() == assets.len() * 3,
        IndexError::InvalidAssetAccountLayout
    );

    let token_program_info = ctx.accounts.token_program.to_account_info();
    let index_authority_info = ctx.accounts.index_config.to_account_info();

    let expected_fee_collector_ata =
        get_associated_token_address_with_program_id(&fee_collector, &index_mint_key, &spl_token::ID);
    require!(
        ctx.accounts.fee_collector_index_token_account.key() == expected_fee_collector_ata,
        IndexError::InvalidFeeCollectorTokenAccount
    );

    let fee_shares_u128 = (quantity as u128)
        .checked_mul(trade_fee_bps as u128)
        .ok_or(IndexError::Overflow)?
        .checked_div(BPS_DENOMINATOR_U128)
        .ok_or(IndexError::Overflow)?;
    let fee_shares = u64::try_from(fee_shares_u128).map_err(|_| error!(IndexError::Overflow))?;
    let net_quantity = quantity
        .checked_sub(fee_shares)
        .ok_or(IndexError::NetQuantityZeroAfterFees)?;
    require!(net_quantity > 0, IndexError::NetQuantityZeroAfterFees);

    let mut credited_fee_shares = 0u64;
    if fee_shares > 0
        && ctx.accounts.user_index_token_account.key() != ctx.accounts.fee_collector_index_token_account.key()
    {
        let fee_transfer_accounts = Transfer {
            from: ctx.accounts.user_index_token_account.to_account_info(),
            to: ctx.accounts.fee_collector_index_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let fee_transfer_ctx = CpiContext::new(token_program_info.clone(), fee_transfer_accounts);
        token::transfer(fee_transfer_ctx, fee_shares)?;
        credited_fee_shares = fee_shares;
    }

    let cpi_accounts = Burn {
        mint: ctx.accounts.index_mint.to_account_info(),
        from: ctx.accounts.user_index_token_account.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::burn(cpi_ctx, net_quantity)?;

    let seeds = &[SEED_INDEX_CONFIG, index_mint_key.as_ref(), &[bump]];
    let signer = &[&seeds[..]];

    for (i, asset) in assets.iter().enumerate() {
        let amount_needed_u128 = (asset.units as u128)
            .checked_mul(net_quantity as u128)
            .ok_or(IndexError::Overflow)?;
        require!(
            amount_needed_u128 % INDEX_SHARE_SCALE_U128 == 0,
            IndexError::InvalidShareQuantityGranularity
        );
        let amount_needed_u128 = amount_needed_u128 / INDEX_SHARE_SCALE_U128;
        let amount_needed =
            u64::try_from(amount_needed_u128).map_err(|_| error!(IndexError::Overflow))?;

        if amount_needed == 0 {
            continue;
        }

        let mint_account_info = ctx.remaining_accounts[i * 3].clone();
        let vault_account_info = ctx.remaining_accounts[(i * 3) + 1].clone();
        let user_account_info = ctx.remaining_accounts[(i * 3) + 2].clone();

        require!(
            *mint_account_info.key == asset.mint,
            IndexError::InvalidAssetMintAccount
        );
        require!(
            *mint_account_info.owner == asset.token_program,
            IndexError::InvalidAssetMintOwner
        );
        require!(
            asset.token_program == spl_token::ID || asset.token_program == spl_token_2022::ID,
            IndexError::UnsupportedAssetTokenProgram
        );

        let mint_decimals = decode_mint_decimals(&mint_account_info, &asset.token_program)?;
        let vault_account = decode_token_account(&vault_account_info, &asset.token_program)?;
        let user_account = decode_token_account(&user_account_info, &asset.token_program)?;

        require!(vault_account.mint == asset.mint, IndexError::InvalidAsset);
        require!(user_account.mint == asset.mint, IndexError::InvalidAsset);
        require!(
            user_account.owner == ctx.accounts.user.key(),
            IndexError::InvalidTokenAccountOwner
        );
        require!(
            vault_account.owner == index_config_key,
            IndexError::InvalidVaultAccount
        );

        let expected_vault_ata =
            get_associated_token_address_with_program_id(&index_config_key, &asset.mint, &asset.token_program);
        require!(
            *vault_account_info.key == expected_vault_ata,
            IndexError::InvalidVaultAccount
        );

        if asset.token_program == spl_token::ID {
            let cpi_accounts = SplTransferChecked {
                from: vault_account_info,
                mint: mint_account_info,
                to: user_account_info,
                authority: index_authority_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer_checked(cpi_ctx, amount_needed, mint_decimals)?;
        } else if asset.token_program == spl_token_2022::ID {
            let cpi_accounts = Token2022TransferChecked {
                from: vault_account_info,
                mint: mint_account_info,
                to: user_account_info,
                authority: index_authority_info.clone(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token_2022::transfer_checked(cpi_ctx, amount_needed, mint_decimals)?;
        } else {
            return err!(IndexError::UnsupportedAssetTokenProgram);
        }
    }

    let index_config = &mut ctx.accounts.index_config;
    index_config.lifetime_fee_shares_total = index_config
        .lifetime_fee_shares_total
        .checked_add(credited_fee_shares)
        .ok_or(IndexError::Overflow)?;

    msg!(
        "Redeemed {} shares after {} fee shares.",
        net_quantity,
        credited_fee_shares
    );
    Ok(())
}
