import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { IndexProtocol } from "../target/types/index_protocol";
import * as fs from "fs";
import * as os from "os";
import { getExplorerCluster, getSolanaRpcUrl } from "../config/network";

// Load Keypair from default location
function loadKeypair(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
    // Configure client to use the provider.
    const keypairPath = `${os.homedir()}/.config/solana/id.json`;
    const wallet = new anchor.Wallet(loadKeypair(keypairPath));
    const connection = new anchor.web3.Connection(getSolanaRpcUrl(), "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const program = anchor.workspace.IndexProtocol as Program<IndexProtocol>;

    // Explicitly set program ID if workspace doesn't pick it up safely outside of anchor test
    // But since we are running with ts-node, we might need to manually load the IDL/Program if workspace isn't magical here.
    // Actually, `anchor.workspace` only works inside `anchor test`. 
    // We should load program manually.

    const idl = JSON.parse(fs.readFileSync("./target/idl/index_protocol.json", "utf8"));
    const programId = new PublicKey("8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD");
    const programManual = new Program(idl, provider); // programId is in IDL or we pass it? 
    // Anchor 0.30+ Program constructor: (idl, provider) where idl has address, or (idl, address, provider).
    // Let's use the explicit address to be safe.

    console.log("🚀 Initializing Devnet Environment...");
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // 1. Create Mock Tokens
    console.log("Creating Mock Tokens...");

    const mintA = await createMint(connection, wallet.payer, wallet.publicKey, null, 6);
    console.log(`Mint A (Mock BTC): ${mintA.toBase58()}`);

    const mintB = await createMint(connection, wallet.payer, wallet.publicKey, null, 6);
    console.log(`Mint B (Mock SOL): ${mintB.toBase58()}`);

    // 2. Mint Tokens to User
    console.log("Minting tokens to user...");
    const userTokenA = await getOrCreateAssociatedTokenAccount(connection, wallet.payer, mintA, wallet.publicKey);
    const userTokenB = await getOrCreateAssociatedTokenAccount(connection, wallet.payer, mintB, wallet.publicKey);

    await mintTo(connection, wallet.payer, mintA, userTokenA.address, wallet.payer, 1000 * 1_000_000); // 1000 BTC
    await mintTo(connection, wallet.payer, mintB, userTokenB.address, wallet.payer, 10000 * 1_000_000); // 10000 SOL

    console.log("Minuted 1000 BTC and 10000 SOL to user.");

    // 3. Create Index
    console.log("Creating Index...");

    // PDA for Index Config
    const indexMintKeypair = Keypair.generate();
    console.log(`New Index Mint: ${indexMintKeypair.publicKey.toBase58()}`);

    const [indexConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("index_config"), indexMintKeypair.publicKey.toBuffer()],
        programId
    );
    console.log(`Index Config PDA: ${indexConfigPda.toBase58()}`);

    // Recipe: 1 Share = 1 BTC + 10 SOL
    const assets = [mintA, mintB];
    const units = [new anchor.BN(1_000_000), new anchor.BN(10_000_000)]; // 1.000000, 10.000000

    try {
        const tx = await programManual.methods
            .createIndex(assets, units)
            .accounts({
                admin: wallet.publicKey,
                indexMint: indexMintKeypair.publicKey,
                indexConfig: indexConfigPda,
                systemProgram: SystemProgram.programId,
                tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .remainingAccounts(assets.map((mint) => ({
                pubkey: mint,
                isSigner: false,
                isWritable: false,
            })))
            .signers([indexMintKeypair])
            .rpc();

        console.log(`✅ Index Created! Tx: ${tx}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=${getExplorerCluster()}`);
    } catch (e) {
        console.error("Failed to create index:", e);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
