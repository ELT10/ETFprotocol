This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Jupiter API

To enable liquidity scoring and recommended investment ranges, add a Jupiter API key:

```bash
cp .env.example .env.local
```

Then set `SOLANA_RPC_URL`, `INDEX_PROTOCOL_PROGRAM_ID`, and `JUPITER_API_KEY` in `.env.local`. The same `SOLANA_RPC_URL` is used across app/scripts/bots, so changing this single value switches cluster everywhere. Optional tuning knobs are listed in `.env.example`.

Example:

```bash
SOLANA_RPC_URL=https://susanna-o2ib0i-fast-mainnet.helius-rpc.com
INDEX_PROTOCOL_PROGRAM_ID=8vDjxdoFPtdm4Ts4yBHn8GLPwFNaqRjkoiDPjm7w6PYD
JUPITER_API_KEY=...
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
