/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/index_protocol.json`.
 */
export type IndexProtocol = {
  "address": "8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD",
  "metadata": {
    "name": "indexProtocol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "pendingAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "createIndex",
      "discriminator": [
        205,
        71,
        124,
        117,
        143,
        136,
        104,
        192
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "indexMint",
          "writable": true,
          "signer": true
        },
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "indexMint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assets",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "units",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "issueShares",
      "discriminator": [
        110,
        72,
        179,
        47,
        131,
        109,
        115,
        103
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "indexMint"
              }
            ]
          }
        },
        {
          "name": "indexMint",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "userIndexTokenAccount",
          "writable": true
        },
        {
          "name": "feeCollectorIndexTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pauseIndex",
      "discriminator": [
        179,
        16,
        188,
        186,
        103,
        238,
        66,
        158
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "redeemShares",
      "discriminator": [
        239,
        154,
        224,
        89,
        240,
        196,
        42,
        187
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "indexMint"
              }
            ]
          }
        },
        {
          "name": "indexMint",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "userIndexTokenAccount",
          "writable": true
        },
        {
          "name": "feeCollectorIndexTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setFeeCollector",
      "discriminator": [
        143,
        46,
        10,
        113,
        121,
        157,
        245,
        166
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": [
        {
          "name": "newFeeCollector",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setIndexMetadata",
      "discriminator": [
        102,
        192,
        79,
        83,
        146,
        60,
        248,
        91
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        }
      ]
    },
    {
      "name": "setMaxAssets",
      "discriminator": [
        255,
        30,
        87,
        108,
        250,
        54,
        161,
        52
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": [
        {
          "name": "newMaxAssets",
          "type": "u8"
        }
      ]
    },
    {
      "name": "setPendingAdmin",
      "discriminator": [
        248,
        204,
        95,
        229,
        240,
        21,
        219,
        3
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setTradeFeeBps",
      "discriminator": [
        233,
        118,
        36,
        169,
        99,
        253,
        231,
        38
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": [
        {
          "name": "newTradeFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "unpauseIndex",
      "discriminator": [
        83,
        21,
        2,
        15,
        95,
        204,
        100,
        207
      ],
      "accounts": [
        {
          "name": "indexConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  100,
                  101,
                  120,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "index_config.index_mint",
                "account": "indexConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "indexConfig"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "indexConfig",
      "discriminator": [
        235,
        135,
        160,
        216,
        32,
        122,
        108,
        201
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidInputLengths",
      "msg": "The assets and units arrays must be of equal length."
    },
    {
      "code": 6001,
      "name": "emptyAssets",
      "msg": "At least one asset is required."
    },
    {
      "code": 6002,
      "name": "tooManyAssets",
      "msg": "Too many assets in the index."
    },
    {
      "code": 6003,
      "name": "zeroUnits",
      "msg": "Asset units must be greater than zero."
    },
    {
      "code": 6004,
      "name": "duplicateAsset",
      "msg": "Duplicate assets are not allowed."
    },
    {
      "code": 6005,
      "name": "overflow",
      "msg": "Calculation overflow."
    },
    {
      "code": 6006,
      "name": "invalidQuantity",
      "msg": "Quantity must be greater than zero."
    },
    {
      "code": 6007,
      "name": "slippageExceeded",
      "msg": "Slippage limit exceeded."
    },
    {
      "code": 6008,
      "name": "invalidAsset",
      "msg": "Invalid asset in basket."
    },
    {
      "code": 6009,
      "name": "invalidVaultAccount",
      "msg": "Invalid vault account for this index asset."
    },
    {
      "code": 6010,
      "name": "invalidTokenAccountOwner",
      "msg": "Invalid token account owner for this operation."
    },
    {
      "code": 6011,
      "name": "invalidMaxAssets",
      "msg": "Invalid max assets value."
    },
    {
      "code": 6012,
      "name": "maxAssetsBelowCurrentComposition",
      "msg": "Cannot set max assets below current composition size."
    },
    {
      "code": 6013,
      "name": "indexPaused",
      "msg": "Index is paused."
    },
    {
      "code": 6014,
      "name": "noPendingAdmin",
      "msg": "No pending admin is set."
    },
    {
      "code": 6015,
      "name": "invalidPendingAdmin",
      "msg": "Signer is not the pending admin."
    },
    {
      "code": 6016,
      "name": "invalidNewAdmin",
      "msg": "New admin cannot be the default pubkey."
    },
    {
      "code": 6017,
      "name": "invalidShareQuantityGranularity",
      "msg": "Share quantity is not compatible with this index composition granularity."
    },
    {
      "code": 6018,
      "name": "invalidAssetAccountCount",
      "msg": "Invalid number of asset token accounts provided."
    },
    {
      "code": 6019,
      "name": "invalidTokenProgramOwner",
      "msg": "Asset token account is not owned by the expected token program."
    },
    {
      "code": 6020,
      "name": "invalidTokenAccountData",
      "msg": "Failed to decode token account data."
    },
    {
      "code": 6021,
      "name": "invalidAssetMintAccount",
      "msg": "Asset mint account is invalid or missing."
    },
    {
      "code": 6022,
      "name": "invalidAssetMintOwner",
      "msg": "Asset mint account owner does not match configured token program."
    },
    {
      "code": 6023,
      "name": "unsupportedAssetTokenProgram",
      "msg": "Asset token program is unsupported. Only Tokenkeg and Token-2022 are allowed."
    },
    {
      "code": 6024,
      "name": "unsupportedToken2022MintExtensions",
      "msg": "This Token-2022 mint uses unsupported extensions for this protocol."
    },
    {
      "code": 6025,
      "name": "invalidAssetAccountLayout",
      "msg": "Asset remaining accounts must be provided in the expected mint/account tuple layout."
    },
    {
      "code": 6026,
      "name": "feeTooHigh",
      "msg": "Trade fee exceeds the max allowed value."
    },
    {
      "code": 6027,
      "name": "invalidFeeCollector",
      "msg": "Fee collector cannot be the default pubkey."
    },
    {
      "code": 6028,
      "name": "invalidFeeCollectorTokenAccount",
      "msg": "Fee collector token account is invalid."
    },
    {
      "code": 6029,
      "name": "netQuantityZeroAfterFees",
      "msg": "Net share quantity is zero after fees."
    },
    {
      "code": 6030,
      "name": "emptyIndexName",
      "msg": "Index name cannot be empty."
    },
    {
      "code": 6031,
      "name": "indexNameTooLong",
      "msg": "Index name is too long."
    },
    {
      "code": 6032,
      "name": "indexDescriptionTooLong",
      "msg": "Index description is too long."
    }
  ],
  "types": [
    {
      "name": "assetComponent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "tokenProgram",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "indexConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "indexMint",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "maxAssets",
            "type": "u8"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "tradeFeeBps",
            "type": "u16"
          },
          {
            "name": "feeCollector",
            "type": "pubkey"
          },
          {
            "name": "lifetimeFeeSharesTotal",
            "type": "u64"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "assets",
            "type": {
              "vec": {
                "defined": {
                  "name": "assetComponent"
                }
              }
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "seedIndexConfig",
      "type": "bytes",
      "value": "[105, 110, 100, 101, 120, 95, 99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "seedVault",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
