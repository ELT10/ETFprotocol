import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import { getSolanaRpcUrl } from "../config/network";

// Fake Metadata Map
const TOKENS = [
    { symbol: "WBTC", name: "Wrapped Bitcoin" },
    { symbol: "WETH", name: "Wrapped Ethereum" },
    { symbol: "SOL", name: "Wrapped Solana" },
    { symbol: "USDC", name: "USD Coin" }, // We need this for the "payment" token mock
    { symbol: "BONK", name: "Bonk" },
    { symbol: "JUP", name: "Jupiter" },
    { symbol: "PYTH", name: "Pyth Network" },
    { symbol: "JTO", name: "Jito" },
    { symbol: "RENDER", name: "Render" },
    { symbol: "HNT", name: "Helium" },
    { symbol: "RAY", name: "Raydium" },
    { symbol: "ORCA", name: "Orca" },
    { symbol: "BLZE", name: "Blaze" },
    { symbol: "MNDE", name: "Marinade" },
    { symbol: "SHDW", name: "Shadow" },
];

function loadKeypair(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function main() {
    console.log("🪙  Initializing Mock Token Registry...");

    const keypairPath = `${os.homedir()}/.config/solana/id.json`;
    const walletKeypair = loadKeypair(keypairPath);
    const connection = new Connection(getSolanaRpcUrl(), "confirmed");

    console.log(`Wallet: ${walletKeypair.publicKey.toBase58()}`);

    const registry: any[] = [];

    for (const t of TOKENS) {
        console.log(`Creating ${t.symbol}...`);

        try {
            // Create Mint (6 Decimals)
            const mint = await createMint(
                connection,
                walletKeypair,
                walletKeypair.publicKey,
                null,
                6
            );

            // Mint to User (1M tokens)
            const ata = await getOrCreateAssociatedTokenAccount(
                connection,
                walletKeypair,
                mint,
                walletKeypair.publicKey
            );

            await mintTo(
                connection,
                walletKeypair,
                mint,
                ata.address,
                walletKeypair,
                1_000_000 * 1_000_000 // 1M tokens
            );

            registry.push({
                symbol: t.symbol,
                name: t.name,
                mint: mint.toBase58(),
                decimals: 6,
                logoURI: `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mint.toBase58()}/logo.png` // Fallback placeholder
            });

            console.log(`✅ ${t.symbol}: ${mint.toBase58()}`);

            // Rate Limit
            await new Promise(r => setTimeout(r, 1000));

        } catch (e) {
            console.error(`Failed to create ${t.symbol}:`, e);
        }
    }

    // Save to App
    const outPath = "./app/src/utils/token-registry.json";
    // Ensure folder exists
    if (!fs.existsSync("./app/src/utils")) {
        fs.mkdirSync("./app/src/utils", { recursive: true });
    }

    fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
    console.log(`Registry saved to ${outPath}`);
}

main().catch(console.error);
