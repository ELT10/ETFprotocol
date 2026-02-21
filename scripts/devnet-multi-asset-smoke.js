const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { PublicKey, Keypair, SystemProgram } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} = require('@solana/spl-token');

const PROGRAM_ID = new PublicKey('8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD');
const RPC_URL = 'https://api.devnet.solana.com';
const SHARE_DECIMALS = 6;
const ONE_SHARE_ATOMIC = new anchor.BN(10 ** SHARE_DECIMALS);

function loadWallet() {
  const keypairPath = path.join(process.env.HOME, '.config/solana/id.json');
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

async function resolveTokenProgramForMint(connection, mintPubkey) {
  const info = await connection.getAccountInfo(mintPubkey, 'confirmed');
  if (!info) {
    throw new Error(`Mint account missing: ${mintPubkey.toBase58()}`);
  }
  return info.owner;
}

async function ensureAssetSetup(connection, payer, owner, mintPubkey, indexConfigPda, tokenProgram) {
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPubkey,
    owner,
    false,
    'confirmed',
    undefined,
    tokenProgram
  );

  // Mint 25 tokens to guarantee collateral for test.
  const amount = BigInt(25) * (BigInt(10) ** BigInt(6));
  await mintTo(connection, payer, mintPubkey, userAta.address, payer, amount, [], 'confirmed', undefined, tokenProgram);

  const vaultAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPubkey,
    indexConfigPda,
    true,
    'confirmed',
    undefined,
    tokenProgram
  );

  return { userAta, vaultAta };
}

async function runCase(program, connection, payer, tokens, assetCount) {
  const selected = tokens.slice(0, assetCount);
  const assets = selected.map((t) => new PublicKey(t.mint));
  const units = selected.map(() => new anchor.BN(1_000_000)); // 1 token/share (6 decimals)

  const indexMint = Keypair.generate();
  const [indexConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('index_config'), indexMint.publicKey.toBuffer()],
    program.programId
  );

  const createSig = await program.methods
    .createIndex(assets, units)
    .accounts({
      admin: payer.publicKey,
      indexMint: indexMint.publicKey,
      indexConfig,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .remainingAccounts(assets.map((mint) => ({ pubkey: mint, isSigner: false, isWritable: false })))
    .signers([indexMint])
    .rpc();

  const userIndexAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    indexMint.publicKey,
    payer.publicKey,
    false,
    'confirmed'
  );

  const issueRemaining = [];
  const redeemRemaining = [];
  const vaultAddresses = [];

  for (const token of selected) {
    const mint = new PublicKey(token.mint);
    const tokenProgram = await resolveTokenProgramForMint(connection, mint);
    const { userAta, vaultAta } = await ensureAssetSetup(connection, payer, payer.publicKey, mint, indexConfig, tokenProgram);

    issueRemaining.push(
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: userAta.address, isSigner: false, isWritable: true },
      { pubkey: vaultAta.address, isSigner: false, isWritable: true }
    );

    redeemRemaining.push(
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultAta.address, isSigner: false, isWritable: true },
      { pubkey: userAta.address, isSigner: false, isWritable: true }
    );

    vaultAddresses.push(vaultAta.address);
  }

  const issueSig = await program.methods
    .issueShares(ONE_SHARE_ATOMIC)
    .accounts({
      indexConfig,
      indexMint: indexMint.publicKey,
      user: payer.publicKey,
      userIndexTokenAccount: userIndexAta.address,
      feeCollectorIndexTokenAccount: userIndexAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(issueRemaining)
    .rpc();

  const redeemSig = await program.methods
    .redeemShares(ONE_SHARE_ATOMIC)
    .accounts({
      indexConfig,
      indexMint: indexMint.publicKey,
      user: payer.publicKey,
      userIndexTokenAccount: userIndexAta.address,
      feeCollectorIndexTokenAccount: userIndexAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(redeemRemaining)
    .rpc();

  const userIndexBalance = await getAccount(connection, userIndexAta.address, 'confirmed');
  const vaultBalances = await Promise.all(vaultAddresses.map((addr) => getAccount(connection, addr, 'confirmed')));
  const nonZeroVaults = vaultBalances.filter((b) => b.amount !== BigInt(0)).length;

  console.log(`CASE ${assetCount}: create=${createSig}`);
  console.log(`CASE ${assetCount}: issue=${issueSig}`);
  console.log(`CASE ${assetCount}: redeem=${redeemSig}`);
  console.log(`CASE ${assetCount}: user_index_balance=${userIndexBalance.amount.toString()} nonzero_vaults=${nonZeroVaults}`);

  if (userIndexBalance.amount !== BigInt(0)) {
    throw new Error(`Case ${assetCount} failed: user index balance expected 0 after redeem.`);
  }
  if (nonZeroVaults !== 0) {
    throw new Error(`Case ${assetCount} failed: ${nonZeroVaults} vaults still non-zero after full redeem.`);
  }
}

async function main() {
  const payer = loadWallet();
  const connection = new anchor.web3.Connection(RPC_URL, 'confirmed');
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.resolve('/Users/eltonthomas/Developer/crypto-ETF/index-protocol/target/idl/index_protocol.json'), 'utf8'));
  idl.address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl, provider);
  const tokens = JSON.parse(fs.readFileSync(path.resolve('/Users/eltonthomas/Developer/crypto-ETF/index-protocol/app/src/utils/token-registry.json'), 'utf8'));

  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  for (const n of [5, 7, 10]) {
    await runCase(program, connection, payer, tokens, n);
  }

  console.log('SMOKE PASS: 5/7/10 asset create+issue+redeem succeeded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
