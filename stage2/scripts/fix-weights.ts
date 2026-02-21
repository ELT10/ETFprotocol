import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { IndexProtocol } from "../../target/types/index_protocol";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getSolanaRpcUrl } from "../../config/network";

// Same config
const PROGRAM_ID = new PublicKey("8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD");
const INDEX_CONFIG_PDA = new PublicKey("CNxXfJrpSqc5MfN5CWE3DJK3BA1JH8bZPBjKxr3mWgFH");
const ASSET_A_MINT = new PublicKey("4RbMmjQkMH1ftndKtg5ZVvfaCz2ex2rTKsC4gDVBDw92");
const ASSET_B_MINT = new PublicKey("Ax7Efx3NXbngTr32gLy9MdyofT6kRuaxa5tcTJpP3NSD");

function loadKeypair(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
    console.log("🛠️ Fixing Index Weights...");

    // Connect
    const keypairPath = `${os.homedir()}/.config/solana/id.json`;
    const walletKeypair = loadKeypair(keypairPath);
    const wallet = new anchor.Wallet(walletKeypair);
    const connection = new Connection(getSolanaRpcUrl(), "confirmed");
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    // Program
    const idlPath = path.resolve(__dirname, "../../target/idl/index_protocol.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    const program = new Program(idl, provider);

    // new units: [1, 10]
    const newAssets = [ASSET_A_MINT, ASSET_B_MINT];
    const newUnits = [new anchor.BN(1), new anchor.BN(10)];

    try {
        const tx = await program.methods
            .updateWeights(newAssets, newUnits)
            .accounts({
                admin: wallet.publicKey,
                indexConfig: INDEX_CONFIG_PDA,
            })
            .rpc();

        console.log(`✅ Weights Updated! Tx: ${tx}`);
    } catch (e) {
        console.error("Failed to update weights:", e);
    }
}

main().catch(console.error);
