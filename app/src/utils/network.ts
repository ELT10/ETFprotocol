const DEFAULT_SOLANA_RPC_URL = "https://susanna-o2ib0i-fast-mainnet.helius-rpc.com";
const DEFAULT_INDEX_PROTOCOL_PROGRAM_ID = "8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD";

export function getSolanaRpcUrl(): string {
    const value = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
    if (value) return value;
    return DEFAULT_SOLANA_RPC_URL;
}

export function getIndexProtocolProgramId(): string {
    const value = process.env.NEXT_PUBLIC_INDEX_PROTOCOL_PROGRAM_ID?.trim();
    if (value) return value;
    return DEFAULT_INDEX_PROTOCOL_PROGRAM_ID;
}

export function getExplorerCluster(): "devnet" | "testnet" | "mainnet-beta" {
    const rpcUrl = getSolanaRpcUrl().toLowerCase();
    if (rpcUrl.includes("testnet")) return "testnet";
    if (rpcUrl.includes("devnet")) return "devnet";
    return "mainnet-beta";
}

export function getNetworkLabel(): "Devnet" | "Testnet" | "Mainnet" {
    const cluster = getExplorerCluster();
    if (cluster === "devnet") return "Devnet";
    if (cluster === "testnet") return "Testnet";
    return "Mainnet";
}
