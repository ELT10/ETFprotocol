use crate::constants::{MAX_INDEX_DESCRIPTION_LEN, MAX_INDEX_NAME_LEN};
use crate::errors::IndexError;
use anchor_lang::prelude::*;

pub fn validate_recipe(assets: &[Pubkey], units: &[u64], max_assets: usize) -> Result<()> {
    require!(max_assets > 0, IndexError::InvalidMaxAssets);
    require!(assets.len() == units.len(), IndexError::InvalidInputLengths);
    require!(!assets.is_empty(), IndexError::EmptyAssets);
    require!(assets.len() <= max_assets, IndexError::TooManyAssets);

    for i in 0..assets.len() {
        require!(units[i] > 0, IndexError::ZeroUnits);
        for j in 0..i {
            require!(assets[i] != assets[j], IndexError::DuplicateAsset);
        }
    }

    Ok(())
}

pub fn validate_metadata(name: &str, description: &str) -> Result<()> {
    let normalized_name = name.trim();
    require!(!normalized_name.is_empty(), IndexError::EmptyIndexName);
    require!(
        normalized_name.as_bytes().len() <= MAX_INDEX_NAME_LEN,
        IndexError::IndexNameTooLong
    );
    require!(
        description.as_bytes().len() <= MAX_INDEX_DESCRIPTION_LEN,
        IndexError::IndexDescriptionTooLong
    );
    Ok(())
}
