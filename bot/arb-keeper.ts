import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { IndexProtocol } from "../target/types/index_protocol";
import * as fs from "fs";
import * as os from "os";
import * as dotenv from "dotenv";
import { getSolanaRpcUrl } from "../config/network";

dotenv.config();

// Configuration (From Devnet Init)
const PROGRAM_ID = new PublicKey("8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD");
const INDEX_CONFIG_PDA = new PublicKey("CNxXfJrpSqc5MfN5CWE3DJK3BA1JH8bZPBjKxr3mWgFH");
const INDEX_MINT = new PublicKey("7omZrxWi6EXTkgJ97Awci5WosYUpn5UgSBRRKeML6ji3");
const ASSET_A_MINT = new PublicKey("4RbMmjQkMH1ftndKtg5ZVvfaCz2ex2rTKsC4gDVBDw92");
const ASSET_B_MINT = new PublicKey("Ax7Efx3NXbngTr32gLy9MdyofT6kRuaxa5tcTJpP3NSD");

function loadKeypair(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
    console.log("🤖 Starting ETF Arbitrage Bot (Devnet)...");

    const keypairPath = `${os.homedir()}/.config/solana/id.json`;
    const walletKeypair = loadKeypair(keypairPath);
    const wallet = new anchor.Wallet(walletKeypair);

    // Connect to Devnet
    const connection = new Connection(getSolanaRpcUrl(), "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    // Load Program
    const idl = JSON.parse(fs.readFileSync("./target/idl/index_protocol.json", "utf8"));
    const program = new Program(idl, provider);

    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`Index Config: ${INDEX_CONFIG_PDA.toBase58()}`);

    // Ensure ATAs exist
    console.log("Ensuring ATAs exist...");

    // User ATAs
    const userAssetA = await getOrCreateAssociatedTokenAccount(connection, walletKeypair, ASSET_A_MINT, wallet.publicKey);
    const userAssetB = await getOrCreateAssociatedTokenAccount(connection, walletKeypair, ASSET_B_MINT, wallet.publicKey);
    const userIndexToken = await getOrCreateAssociatedTokenAccount(connection, walletKeypair, INDEX_MINT, wallet.publicKey);

    // Check Balances
    const balA = await connection.getTokenAccountBalance(userAssetA.address);
    const balB = await connection.getTokenAccountBalance(userAssetB.address);
    console.log(`User Balance A: ${balA.value.uiAmount}`);
    console.log(`User Balance B: ${balB.value.uiAmount}`);

    // Check Vault Balances (Optional - expected 0)

    // Vault ATAs (Owned by Index Config PDA)
    const vaultAssetA = await getOrCreateAssociatedTokenAccount(connection, walletKeypair, ASSET_A_MINT, INDEX_CONFIG_PDA, true);
    const vaultAssetB = await getOrCreateAssociatedTokenAccount(connection, walletKeypair, ASSET_B_MINT, INDEX_CONFIG_PDA, true);

    console.log("ATAs Ready.");
    console.log("Monitoring Loop Started...");

    let running = true;

    // Loop
    while (running) {
        try {
            // Fetch On-chain State
            // 1. Calculate NAV
            // Prices (Mocked)
            const priceA = 60000; // BTC
            const priceB = 150;   // SOL

            // Recipe: 1 Share = 1 BTC + 10 SOL
            // Real Units: 1_000_000, 10_000_000 (Decimals 6)
            // NAV = (1 * 60000) + (10 * 150) = 60000 + 1500 = 61500 USD per share.
            const nav = 61500;

            console.log(`\n📊 NAV: $${nav}`);

            // 2. Mock Market Price (Random Fluctuation)
            const random = Math.random();
            let action = "NONE";
            let marketPrice = nav;

            if (random > 0.7) {
                marketPrice = nav * 1.02; // Premium
                action = "MINT";
            } else if (random < 0.3) {
                marketPrice = nav * 0.98; // Discount
                action = "REDEEM";
            }

            console.log(`📈 Market Price: $${marketPrice.toFixed(2)}`);

            if (action === "MINT") {
                console.log("🚀 ARB OPPORTUNITY: Premium! Buying Assets -> Minting Share.");

                // MINT 1 Share
                const quantity = new anchor.BN(1_000_000); // 1.0 Unit of Index

                const tx = await program.methods
                    .issueShares(quantity)
                    .accounts({
                        indexConfig: INDEX_CONFIG_PDA,
                        indexMint: INDEX_MINT,
                        user: wallet.publicKey,
                        userIndexTokenAccount: userIndexToken.address,
                        feeCollectorIndexTokenAccount: userIndexToken.address,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        token2022Program: TOKEN_2022_PROGRAM_ID,
                    })
                    .remainingAccounts([
                        { pubkey: ASSET_A_MINT, isSigner: false, isWritable: false },
                        { pubkey: userAssetA.address, isSigner: false, isWritable: true },
                        { pubkey: vaultAssetA.address, isSigner: false, isWritable: true },
                        { pubkey: ASSET_B_MINT, isSigner: false, isWritable: false },
                        { pubkey: userAssetB.address, isSigner: false, isWritable: true },
                        { pubkey: vaultAssetB.address, isSigner: false, isWritable: true },
                    ])
                    .transaction();

                const sig = await provider.sendAndConfirm(tx);
                console.log(`✅ Minted! Tx: ${sig}`);

            } else if (action === "REDEEM") {
                console.log("📉 ARB OPPORTUNITY: Discount! Buying Index -> Redeeming Assets.");

                // REDEEM 1 Share
                // Ensure we have shares first!
                const tokenBal = await connection.getTokenAccountBalance(userIndexToken.address);
                if ((tokenBal.value.uiAmount || 0) < 1) {
                    console.log("   ❌ Not enough Index Tokens to redeem. Skipping.");
                } else {
                    const quantity = new anchor.BN(1_000_000); // 1.0 Unit

                    const tx = await program.methods
                        .redeemShares(quantity)
                        .accounts({
                            indexConfig: INDEX_CONFIG_PDA,
                            indexMint: INDEX_MINT,
                            user: wallet.publicKey,
                            userIndexTokenAccount: userIndexToken.address,
                            feeCollectorIndexTokenAccount: userIndexToken.address,
                            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                            token2022Program: TOKEN_2022_PROGRAM_ID,
                        })
                        .remainingAccounts([
                            { pubkey: ASSET_A_MINT, isSigner: false, isWritable: false },
                            { pubkey: vaultAssetA.address, isSigner: false, isWritable: true },
                            { pubkey: userAssetA.address, isSigner: false, isWritable: true },
                            { pubkey: ASSET_B_MINT, isSigner: false, isWritable: false },
                            { pubkey: vaultAssetB.address, isSigner: false, isWritable: true },
                            { pubkey: userAssetB.address, isSigner: false, isWritable: true },
                        ])
                        .transaction();

                    const sig = await provider.sendAndConfirm(tx);
                    console.log(`✅ Redeemed! Tx: ${sig}`);
                }
            } else {
                console.log("😴 Price aligned. No Action.");
            }

            await new Promise(r => setTimeout(r, 10000)); // Sleep 10s

        } catch (e) {
            console.error("Error:", e);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

main().catch(console.error);
