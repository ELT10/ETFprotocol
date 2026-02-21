import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createMint,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getAccount,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { IndexProtocol } from "../target/types/index_protocol";

type AssetSpec = {
  mint: PublicKey;
  programId: PublicKey;
  units: anchor.BN;
};

type AssetAccounts = AssetSpec & {
  userAta: PublicKey;
  vaultAta: PublicKey;
};

describe("index-protocol multi-asset token-program support", () => {
  const provider = process.env.ANCHOR_PROVIDER_URL
    ? anchor.AnchorProvider.env()
    : anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const workspace = anchor.workspace as Record<string, Program<IndexProtocol>>;
  const workspaceProgram = workspace.IndexProtocol ?? workspace.indexProtocol;
  const idlPath = path.resolve(__dirname, "../target/idl/index_protocol.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program =
    workspaceProgram ?? (new Program(idl, provider) as Program<IndexProtocol>);

  const payer = (provider.wallet as any).payer as Keypair;
  const one = new anchor.BN(1_000_000);

  async function expectFailure(promise: Promise<unknown>) {
    try {
      await promise;
      expect.fail("Expected transaction to fail");
    } catch {
      // expected
    }
  }

  async function createAssetMint(programId: PublicKey, decimals = 6): Promise<PublicKey> {
    return createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      decimals,
      undefined,
      undefined,
      programId
    );
  }

  async function createToken2022MintWithTransferFeeExtension(decimals = 6): Promise<PublicKey> {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports,
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        payer.publicKey,
        25,
        BigInt(1_000_000),
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        decimals,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(tx, [mint]);
    return mint.publicKey;
  }

  async function createIndex(assetSpecs: AssetSpec[]): Promise<{ indexMint: Keypair; indexConfig: PublicKey }> {
    const indexMint = Keypair.generate();
    const [indexConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("index_config"), indexMint.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .createIndex(
        assetSpecs.map((asset) => asset.mint),
        assetSpecs.map((asset) => asset.units)
      )
      .accounts({
        admin: payer.publicKey,
        indexMint: indexMint.publicKey,
        indexConfig,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .remainingAccounts(
        assetSpecs.map((asset) => ({
          pubkey: asset.mint,
          isSigner: false,
          isWritable: false,
        }))
      )
      .signers([indexMint])
      .rpc();

    return { indexMint, indexConfig };
  }

  async function prepareAssetAccounts(indexConfig: PublicKey, assets: AssetSpec[]): Promise<AssetAccounts[]> {
    const result: AssetAccounts[] = [];

    for (const asset of assets) {
      const userAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        asset.mint,
        payer.publicKey,
        false,
        "confirmed",
        undefined,
        asset.programId
      );
      const vaultAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        asset.mint,
        indexConfig,
        true,
        "confirmed",
        undefined,
        asset.programId
      );

      await mintTo(
        provider.connection,
        payer,
        asset.mint,
        userAta.address,
        payer,
        BigInt(1_000_000_000),
        [],
        undefined,
        asset.programId
      );

      result.push({
        ...asset,
        userAta: userAta.address,
        vaultAta: vaultAta.address,
      });
    }

    return result;
  }

  async function getUserIndexAta(indexMint: PublicKey): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      indexMint,
      payer.publicKey,
      false,
      "confirmed",
      undefined,
      TOKEN_PROGRAM_ID
    );
    return ata.address;
  }

  async function issueShares(params: {
    indexConfig: PublicKey;
    indexMint: PublicKey;
    userIndexAta: PublicKey;
    quantity: anchor.BN;
    assets: AssetAccounts[];
  }): Promise<void> {
    await program.methods
      .issueShares(params.quantity)
      .accounts({
        indexConfig: params.indexConfig,
        indexMint: params.indexMint,
        user: payer.publicKey,
        userIndexTokenAccount: params.userIndexAta,
        feeCollectorIndexTokenAccount: params.userIndexAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      } as any)
      .remainingAccounts(
        params.assets.flatMap((asset) => [
          { pubkey: asset.mint, isSigner: false, isWritable: false },
          { pubkey: asset.userAta, isSigner: false, isWritable: true },
          { pubkey: asset.vaultAta, isSigner: false, isWritable: true },
        ])
      )
      .rpc();
  }

  async function redeemShares(params: {
    indexConfig: PublicKey;
    indexMint: PublicKey;
    userIndexAta: PublicKey;
    quantity: anchor.BN;
    assets: AssetAccounts[];
  }): Promise<void> {
    await program.methods
      .redeemShares(params.quantity)
      .accounts({
        indexConfig: params.indexConfig,
        indexMint: params.indexMint,
        user: payer.publicKey,
        userIndexTokenAccount: params.userIndexAta,
        feeCollectorIndexTokenAccount: params.userIndexAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      } as any)
      .remainingAccounts(
        params.assets.flatMap((asset) => [
          { pubkey: asset.mint, isSigner: false, isWritable: false },
          { pubkey: asset.vaultAta, isSigner: false, isWritable: true },
          { pubkey: asset.userAta, isSigner: false, isWritable: true },
        ])
      )
      .rpc();
  }

  it("tokenkeg-only basket issue/redeem succeeds", async () => {
    const mintA = await createAssetMint(TOKEN_PROGRAM_ID);
    const mintB = await createAssetMint(TOKEN_PROGRAM_ID);

    const assets: AssetSpec[] = [
      { mint: mintA, programId: TOKEN_PROGRAM_ID, units: one },
      { mint: mintB, programId: TOKEN_PROGRAM_ID, units: one },
    ];

    const { indexMint, indexConfig } = await createIndex(assets);
    const assetAccounts = await prepareAssetAccounts(indexConfig, assets);
    const userIndexAta = await getUserIndexAta(indexMint.publicKey);

    await issueShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    const indexAccountAfterIssue = await getAccount(provider.connection, userIndexAta, "confirmed", TOKEN_PROGRAM_ID);
    expect(indexAccountAfterIssue.amount).to.eq(BigInt(1_000_000));

    await redeemShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    const indexAccountAfterRedeem = await getAccount(provider.connection, userIndexAta, "confirmed", TOKEN_PROGRAM_ID);
    expect(indexAccountAfterRedeem.amount).to.eq(BigInt(0));
  });

  it("token-2022-only basket issue/redeem succeeds", async () => {
    const mint2022 = await createAssetMint(TOKEN_2022_PROGRAM_ID);
    const assets: AssetSpec[] = [
      { mint: mint2022, programId: TOKEN_2022_PROGRAM_ID, units: one },
    ];

    const { indexMint, indexConfig } = await createIndex(assets);
    const indexConfigAccount = (await program.account.indexConfig.fetch(indexConfig)) as any;
    expect(indexConfigAccount.assets[0].tokenProgram.toBase58()).to.eq(TOKEN_2022_PROGRAM_ID.toBase58());

    const assetAccounts = await prepareAssetAccounts(indexConfig, assets);
    const userIndexAta = await getUserIndexAta(indexMint.publicKey);

    await issueShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    await redeemShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    const indexAccount = await getAccount(provider.connection, userIndexAta, "confirmed", TOKEN_PROGRAM_ID);
    expect(indexAccount.amount).to.eq(BigInt(0));
  });

  it("mixed tokenkeg + token-2022 basket issue/redeem succeeds", async () => {
    const mintTokenkeg = await createAssetMint(TOKEN_PROGRAM_ID);
    const mintToken2022 = await createAssetMint(TOKEN_2022_PROGRAM_ID);

    const assets: AssetSpec[] = [
      { mint: mintTokenkeg, programId: TOKEN_PROGRAM_ID, units: one },
      { mint: mintToken2022, programId: TOKEN_2022_PROGRAM_ID, units: one },
    ];

    const { indexMint, indexConfig } = await createIndex(assets);
    const indexConfigAccount = (await program.account.indexConfig.fetch(indexConfig)) as any;
    expect(indexConfigAccount.assets[0].tokenProgram.toBase58()).to.eq(TOKEN_PROGRAM_ID.toBase58());
    expect(indexConfigAccount.assets[1].tokenProgram.toBase58()).to.eq(TOKEN_2022_PROGRAM_ID.toBase58());

    const assetAccounts = await prepareAssetAccounts(indexConfig, assets);
    const userIndexAta = await getUserIndexAta(indexMint.publicKey);

    await issueShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    await redeemShares({
      indexConfig,
      indexMint: indexMint.publicKey,
      userIndexAta,
      quantity: one,
      assets: assetAccounts,
    });

    const indexAccount = await getAccount(provider.connection, userIndexAta, "confirmed", TOKEN_PROGRAM_ID);
    expect(indexAccount.amount).to.eq(BigInt(0));
  });

  it("rejects unsupported token-2022 extension at create", async () => {
    const unsupportedMint = await createToken2022MintWithTransferFeeExtension();

    const indexMint = Keypair.generate();
    const [indexConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("index_config"), indexMint.publicKey.toBuffer()],
      program.programId
    );

    await expectFailure(
      program.methods
        .createIndex([unsupportedMint], [one])
        .accounts({
          admin: payer.publicKey,
          indexMint: indexMint.publicKey,
          indexConfig,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .remainingAccounts([{ pubkey: unsupportedMint, isSigner: false, isWritable: false }])
        .signers([indexMint])
        .rpc()
    );
  });

  it("rejects wrong remaining-account order for issue", async () => {
    const mintA = await createAssetMint(TOKEN_PROGRAM_ID);
    const mintB = await createAssetMint(TOKEN_PROGRAM_ID);

    const assets: AssetSpec[] = [
      { mint: mintA, programId: TOKEN_PROGRAM_ID, units: one },
      { mint: mintB, programId: TOKEN_PROGRAM_ID, units: one },
    ];

    const { indexMint, indexConfig } = await createIndex(assets);
    const assetAccounts = await prepareAssetAccounts(indexConfig, assets);
    const userIndexAta = await getUserIndexAta(indexMint.publicKey);

    await expectFailure(
      program.methods
        .issueShares(one)
        .accounts({
          indexConfig,
          indexMint: indexMint.publicKey,
          user: payer.publicKey,
          userIndexTokenAccount: userIndexAta,
          feeCollectorIndexTokenAccount: userIndexAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        } as any)
        .remainingAccounts(
          assetAccounts.flatMap((asset) => [
            { pubkey: asset.userAta, isSigner: false, isWritable: true },
            { pubkey: asset.vaultAta, isSigner: false, isWritable: true },
            { pubkey: asset.mint, isSigner: false, isWritable: false },
          ])
        )
        .rpc()
    );
  });
});
