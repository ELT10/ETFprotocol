import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";

// Load from a single canonical env file for scripts and bots.
const envPaths = Array.from(
  new Set([
    path.resolve(process.cwd(), "app/.env.local"),
    path.resolve(__dirname, "../app/.env.local"),
  ])
);

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

export function getSolanaRpcUrl(): string {
  const raw = process.env.SOLANA_RPC_URL?.trim();
  if (raw) return raw;
  return DEFAULT_SOLANA_RPC_URL;
}

export function getExplorerCluster(): "devnet" | "testnet" | "mainnet-beta" {
  const rpcUrl = getSolanaRpcUrl().toLowerCase();
  if (rpcUrl.includes("testnet")) return "testnet";
  if (rpcUrl.includes("devnet")) return "devnet";
  return "mainnet-beta";
}
