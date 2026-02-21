import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    VersionedTransaction,
} from "@solana/web3.js";
import {
    getAccount,
    getAssociatedTokenAddress,
    getMint,
    getOrCreateAssociatedTokenAccount,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createJupiterApiClient } from "@jup-ag/api";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";
import { getSolanaRpcUrl } from "../../config/network";

dotenv.config();

type TokenRegistryItem = {
    symbol: string;
    mint: string;
    decimals?: number;
};

type AssetPlan = {
    mint: PublicKey;
    symbol: string;
    decimals: number;
    unitsPerShare: bigint;
    vaultAta: PublicKey;
    adminAta: PublicKey;
    current: bigint;
    target: bigint;
    delta: bigint; // current - target
};

const SLIPPAGE_START_BPS = Number(process.env.SLIPPAGE_START_BPS ?? 100);
const SLIPPAGE_MAX_BPS = Number(process.env.SLIPPAGE_MAX_BPS ?? 250);
const SLIPPAGE_STEP_BPS = Number(process.env.SLIPPAGE_STEP_BPS ?? 50);
const MIN_TRADE_USD = Number(process.env.MIN_TRADE_USD ?? 5);
const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";

function loadKeypair(pathname: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(pathname, "utf-8"));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

function toBn(value: bigint): anchor.BN {
    return new anchor.BN(value.toString());
}

function pow10(decimals: number): bigint {
    return BigInt(10) ** BigInt(decimals);
}

function abs(value: bigint): bigint {
    return value < 0n ? -value : value;
}

function formatAmount(value: bigint, decimals: number, maxFrac = 6): string {
    const sign = value < 0n ? "-" : "";
    const base = abs(value);
    const whole = base / pow10(decimals);
    const frac = base % pow10(decimals);
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac);
    return `${sign}${whole.toString()}.${fracStr}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadTokenRegistry(): TokenRegistryItem[] {
    try {
        const registryPath = path.resolve(__dirname, "../../app/src/utils/token-registry.json");
        const raw = fs.readFileSync(registryPath, "utf-8");
        return JSON.parse(raw) as TokenRegistryItem[];
    } catch {
        return [];
    }
}

async function getTokenDecimals(
    connection: Connection,
    mint: PublicKey,
    registryMap: Map<string, TokenRegistryItem>
): Promise<number> {
    try {
        const mintInfo = await getMint(connection, mint);
        return mintInfo.decimals;
    } catch {
        const fallback = registryMap.get(mint.toBase58());
        return fallback?.decimals ?? 6;
    }
}

async function getTokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
    try {
        const account = await getAccount(connection, ata);
        return account.amount;
    } catch {
        return 0n;
    }
}

async function sendSwapTransaction(
    connection: Connection,
    wallet: Keypair,
    swapTransaction: string,
    lastValidBlockHeight: number
): Promise<string> {
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
    });

    await connection.confirmTransaction(
        {
            signature: sig,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight,
        },
        "confirmed"
    );

    return sig;
}

async function executeSwapWithRetry(params: {
    jupiter: ReturnType<typeof createJupiterApiClient>;
    connection: Connection;
    wallet: Keypair;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amount: bigint;
    swapMode: "ExactIn" | "ExactOut";
    label: string;
}): Promise<void> {
    const {
        jupiter,
        connection,
        wallet,
        inputMint,
        outputMint,
        amount,
        swapMode,
        label,
    } = params;

    let bps = SLIPPAGE_START_BPS;
    let lastErr: unknown;

    while (bps <= SLIPPAGE_MAX_BPS) {
        try {
            const quote = await jupiter.quoteGet({
                inputMint: inputMint.toBase58(),
                outputMint: outputMint.toBase58(),
                amount: amount.toString(),
                swapMode,
                slippageBps: bps,
            });

            const swap = await jupiter.swapPost({
                swapRequest: {
                    userPublicKey: wallet.publicKey.toBase58(),
                    quoteResponse: quote,
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                },
            });

            const sig = await sendSwapTransaction(connection, wallet, swap.swapTransaction, swap.lastValidBlockHeight);
            console.log(`✅ Swap ok (${label}) at ${bps}bps: ${sig}`);
            return;
        } catch (err) {
            lastErr = err;
            console.warn(`Swap failed at ${bps}bps (${label}). Retrying...`);
            bps += SLIPPAGE_STEP_BPS;
            await sleep(500);
        }
    }

    throw lastErr;
}

async function main() {
    const rpcUrl = getSolanaRpcUrl();
    const walletPath = process.env.WALLET_PATH ?? `${os.homedir()}/.config/solana/id.json`;
    const indexConfigEnv = process.env.INDEX_CONFIG;
    const indexMintEnv = process.env.INDEX_MINT;
    const usdcMintEnv = process.env.USDC_MINT;

    if (!indexConfigEnv && !indexMintEnv) {
        throw new Error("Set INDEX_CONFIG or INDEX_MINT in your environment.");
    }

    const wallet = loadKeypair(walletPath);
    const connection = new Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
        commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const idlPath = path.resolve(__dirname, "../../target/idl/index_protocol.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const programId = new PublicKey(process.env.PROGRAM_ID ?? idl.address);
    const program = new Program(idl, programId, provider);

    let indexConfigPda: PublicKey;
    let indexMint: PublicKey;

    if (indexConfigEnv) {
        indexConfigPda = new PublicKey(indexConfigEnv);
        const indexConfig = await program.account.indexConfig.fetch(indexConfigPda);
        indexMint = indexConfig.indexMint as PublicKey;
    } else {
        indexMint = new PublicKey(indexMintEnv as string);
        [indexConfigPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("index_config"), indexMint.toBuffer()],
            programId
        );
    }

    const indexConfig = await program.account.indexConfig.fetch(indexConfigPda);
    const mintInfo = await getMint(connection, indexMint);
    const indexSupply = mintInfo.supply;
    const indexDecimals = mintInfo.decimals;

    const registry = loadTokenRegistry();
    const registryMap = new Map(registry.map((t) => [t.mint, t]));
    const symbolMap = new Map(registry.map((t) => [t.mint, t.symbol]));

    const usdcMintString =
        usdcMintEnv ??
        registry.find((t) => t.symbol === "USDC")?.mint ??
        "";

    if (!usdcMintString) {
        throw new Error("USDC_MINT not found. Set USDC_MINT in your environment.");
    }

    const usdcMint = new PublicKey(usdcMintString);
    const usdcSymbol = "USDC";
    const usdcDecimals = await getTokenDecimals(connection, usdcMint, registryMap);

    const assets = (indexConfig.assets as Array<{ mint: PublicKey; units: anchor.BN }>).map(
        (a) => ({
            mint: a.mint,
            units: BigInt(a.units.toString()),
        })
    );

    const assetPlans: AssetPlan[] = [];

    for (const asset of assets) {
        const decimals = await getTokenDecimals(connection, asset.mint, registryMap);
        const symbol = symbolMap.get(asset.mint.toBase58()) ?? asset.mint.toBase58().slice(0, 6);
        const vaultAta = await getOrCreateAssociatedTokenAccount(
            connection,
            wallet,
            asset.mint,
            indexConfigPda,
            true
        );
        const adminAta = await getOrCreateAssociatedTokenAccount(
            connection,
            wallet,
            asset.mint,
            wallet.publicKey
        );

        const current = await getTokenBalance(connection, vaultAta);
        const target = (asset.units * BigInt(indexSupply.toString())) / pow10(indexDecimals);
        const delta = current - target;

        assetPlans.push({
            mint: asset.mint,
            symbol,
            decimals,
            unitsPerShare: asset.units,
            vaultAta: vaultAta.address,
            adminAta: adminAta.address,
            current,
            target,
            delta,
        });
    }

    console.log("---- REBALANCE PLAN ----");
    console.log(`Index Mint: ${indexMint.toBase58()}`);
    console.log(`Index Config: ${indexConfigPda.toBase58()}`);
    console.log(`Supply: ${formatAmount(BigInt(indexSupply.toString()), indexDecimals, 6)} index tokens`);
    console.log(`Dry Run: ${DRY_RUN}`);
    console.log("");

    for (const asset of assetPlans) {
        console.log(
            `${asset.symbol} ${asset.mint.toBase58()}\n` +
            `  current: ${formatAmount(asset.current, asset.decimals)}\n` +
            `  target:  ${formatAmount(asset.target, asset.decimals)}\n` +
            `  delta:   ${formatAmount(asset.delta, asset.decimals)}`
        );
    }

    const jupiter = createJupiterApiClient();

    const usdcAta = await getOrCreateAssociatedTokenAccount(connection, wallet, usdcMint, wallet.publicKey);

    const nonBaseAssets = assetPlans.filter((a) => a.mint.toBase58() !== usdcMint.toBase58());
    const baseAsset = assetPlans.find((a) => a.mint.toBase58() === usdcMint.toBase58());

    const surpluses = nonBaseAssets.filter((a) => a.delta > 0n);
    const deficits = nonBaseAssets.filter((a) => a.delta < 0n);

    // Helper to move tokens between vault and admin using swap_assets
    const vaultTransfer = async (mint: PublicKey, amountIn: bigint, amountOut: bigint) => {
        if (amountIn === 0n && amountOut === 0n) return;
        const vaultAta = await getAssociatedTokenAddress(mint, indexConfigPda, true);
        const adminAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

        await program.methods
            .swapAssets(toBn(amountIn), toBn(amountOut))
            .accounts({
                indexConfig: indexConfigPda,
                admin: wallet.publicKey,
                vaultInputAccount: vaultAta,
                vaultOutputAccount: vaultAta,
                externalInputAccount: adminAta,
                externalOutputAccount: adminAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    };

    // SELL surpluses to USDC
    for (const asset of surpluses) {
        const amountToSell = asset.delta;
        const label = `${asset.symbol}->${usdcSymbol}`;

        console.log(`\nSelling ${formatAmount(amountToSell, asset.decimals)} ${asset.symbol} (${label})`);

        if (DRY_RUN) continue;

        try {
            const quote = await jupiter.quoteGet({
                inputMint: asset.mint.toBase58(),
                outputMint: usdcMint.toBase58(),
                amount: amountToSell.toString(),
                swapMode: "ExactIn",
                slippageBps: SLIPPAGE_START_BPS,
            });

            const outUsd = Number(quote.outAmount) / 10 ** usdcDecimals;
            if (outUsd < MIN_TRADE_USD) {
                console.log(`Skipping small trade (${outUsd.toFixed(2)} USD).`);
                continue;
            }

            // Withdraw from vault
            await vaultTransfer(asset.mint, 0n, amountToSell);

            // Swap via Jupiter
            await executeSwapWithRetry({
                jupiter,
                connection,
                wallet,
                inputMint: asset.mint,
                outputMint: usdcMint,
                amount: amountToSell,
                swapMode: "ExactIn",
                label,
            });
        } catch (err) {
            console.error(`Sell failed for ${asset.symbol}. Attempting to return funds to vault.`);
            try {
                await vaultTransfer(asset.mint, amountToSell, 0n);
            } catch (rollbackErr) {
                console.error("Rollback failed:", rollbackErr);
            }
            console.error(err);
        }
    }

    // BUY deficits with USDC
    for (const asset of deficits) {
        const amountToBuy = abs(asset.delta);
        const label = `${usdcSymbol}->${asset.symbol}`;

        console.log(`\nBuying ${formatAmount(amountToBuy, asset.decimals)} ${asset.symbol} (${label})`);

        if (DRY_RUN) continue;

        try {
            const usdcBalBefore = await getTokenBalance(connection, usdcAta.address);
            if (usdcBalBefore === 0n) {
                console.warn("No USDC available for buys.");
                continue;
            }

            const preQuote = await jupiter.quoteGet({
                inputMint: usdcMint.toBase58(),
                outputMint: asset.mint.toBase58(),
                amount: amountToBuy.toString(),
                swapMode: "ExactOut",
                slippageBps: SLIPPAGE_START_BPS,
            });

            const requiredIn = BigInt(preQuote.inAmount);
            if (requiredIn > usdcBalBefore) {
                console.warn("Not enough USDC for this buy. Skipping.");
                continue;
            }

            const adminAta = await getAssociatedTokenAddress(asset.mint, wallet.publicKey);
            const beforeAmount = await getTokenBalance(connection, adminAta);

            // Execute swap with retry (ExactOut)
            await executeSwapWithRetry({
                jupiter,
                connection,
                wallet,
                inputMint: usdcMint,
                outputMint: asset.mint,
                amount: amountToBuy,
                swapMode: "ExactOut",
                label,
            });

            const afterAmount = await getTokenBalance(connection, adminAta);
            const boughtAmount = afterAmount - beforeAmount;

            if (boughtAmount > 0n) {
                await vaultTransfer(asset.mint, boughtAmount, 0n);
            }
        } catch (err) {
            console.error(`Buy failed for ${asset.symbol}:`, err);
        }
    }

    // Adjust USDC in vault if USDC is part of the index
    if (baseAsset) {
        const vaultUsdc = await getTokenBalance(connection, baseAsset.vaultAta);
        const delta = vaultUsdc - baseAsset.target;

        if (delta !== 0n) {
            const label = delta > 0n ? "withdrawing excess USDC" : "depositing USDC shortfall";
            console.log(`\nUSDC vault adjustment: ${label}`);

            if (!DRY_RUN) {
                if (delta > 0n) {
                    await vaultTransfer(usdcMint, 0n, delta);
                } else {
                    const amountIn = abs(delta);
                    await vaultTransfer(usdcMint, amountIn, 0n);
                }
            }
        }
    }

    console.log("\nRebalance complete.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
