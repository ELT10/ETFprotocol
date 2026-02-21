import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SOLANA_RPC_URL:
      process.env.SOLANA_RPC_URL ?? "https://susanna-o2ib0i-fast-mainnet.helius-rpc.com",
    NEXT_PUBLIC_INDEX_PROTOCOL_PROGRAM_ID:
      process.env.INDEX_PROTOCOL_PROGRAM_ID ?? "8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD",
  },
};

export default nextConfig;
