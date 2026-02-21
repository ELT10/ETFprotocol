# Stage 1 Share Math Hardening Plan

## Objective
Eliminate the `10000x` scaling bug and remove rounding-based economic exploits without relying on frontend behavior for safety.

## Non-Negotiable Invariants
1. Collateral conservation: share minting/redeeming must be fully backed by deterministic asset transfers.
2. Path independence: splitting one trade into many smaller trades must not improve economic outcome.
3. UI/on-chain parity: previewed basket amounts must match contract execution exactly.
4. No hidden rounding leak: there must be no exploitable round-trip gain path.
5. Stage 2/3 compatibility: same math model must stay valid after rebalancing logic is introduced.

## Chosen Math Model (Exact Proportional With Quantity Granularity)
Definitions:
1. `S = 10^INDEX_MINT_DECIMALS` (currently `1_000_000`).
2. `units_i` = atomic amount of asset `i` required for exactly `1.0` share.
3. `q` = atomic share quantity (`u64`) passed to `issue_shares` and `redeem_shares`.

Execution formula for each asset `i`:
1. `product_i = units_i * q` in `u128` with checked math.
2. Require `product_i % S == 0`.
3. `amount_i = product_i / S`.

Apply same formula in both issue and redeem.

Result:
1. No ceil/floor drift.
2. No split-trade arbitrage.
3. Mint then redeem same `q` returns exact component amounts.

## Why Frontend-Only Is Not Sufficient
1. Current over-scaling originates in contract math, not display-only logic.
2. Any wallet/integration can call contract directly and bypass frontend checks.
3. Economic safety must be enforced on-chain; UI is guidance, not security boundary.

## Implementation Plan

### Phase 0: Safety Freeze
1. Do not deploy current `ceil/ceil` logic.
2. Replace it with exact proportional model in contract before next deploy.

### Phase 1: Contract Hardening
1. Add a single shared helper (or inline equivalent) for per-asset amount calculation:
   `checked_mul -> divisibility check -> checked division -> u64 cast`.
2. Use this exact helper in both:
   `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/programs/index-protocol/src/instructions/issue_shares.rs`
   `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/programs/index-protocol/src/instructions/redeem_shares.rs`
3. Add new error code:
   `InvalidShareQuantityGranularity` with message indicating quantity is not compatible with this index composition.
4. Keep `INDEX_MINT_DECIMALS` as a single constant in:
   `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/programs/index-protocol/src/constants.rs`
5. Keep `create_index` mint decimals wired to this constant in:
   `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/programs/index-protocol/src/instructions/create_index.rs`

### Phase 2: Frontend Consistency
1. Centralize share math utility in app:
   one function for required/returned component amount using same formula.
2. Replace ad-hoc multiplication in:
   `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/app/src/app/index/[address]/page.tsx`
3. Compute and display minimum valid share step:
   `step_i = S / gcd(S, units_i)`, `step = lcm(step_i...)`.
4. Block trade submission if `quantityAtomic % step != 0`.
5. Show explicit validation message and nearest valid quantity hint.
6. Use exact computed component amounts for Quick Buy/Quick Exit quote inputs.

### Phase 3: Create Flow Guardrails
1. In `/Users/eltonthomas/Developer/crypto-ETF/index-protocol/app/src/app/create/page.tsx`, show resulting trade step before index creation.
2. Warn creator when resulting step is coarse (example: only whole-share trades).
3. Optional policy flag: block creation if step exceeds configured UX threshold.

### Phase 4: Test Matrix
Contract tests in:
`/Users/eltonthomas/Developer/crypto-ETF/index-protocol/tests/index-protocol.ts`
1. Regression: 0.01 share no longer scales by 10,000x.
2. Rejection: non-divisible quantities fail with `InvalidShareQuantityGranularity`.
3. Symmetry: issue `q`, redeem `q`, net component movement is zero (excluding tx fees).
4. Split invariance: `trade(q1 + q2)` equals `trade(q1) + trade(q2)` for valid quantities.
5. Overflow: max-bound math still safely rejects overflow paths.
6. Existing checks (vault ownership, pause, admin transfer) remain green.

Frontend tests:
1. Amount preview matches contract formula for buy and sell.
2. Validation and step hints render for invalid quantity.
3. Quick Buy/Quick Exit quote request amounts match exact basket math.

### Phase 5: Deployment and Cutover
1. Build, test, and regenerate IDL/types.
2. Deploy upgraded program to devnet.
3. Update app IDL and program ID config if changed.
4. End-to-end smoke test:
   create index -> buy valid fractional quantity -> redeem same quantity -> verify balances.

## Stage 2/3 Compatibility Notes
1. Rebalancing (manual or AI) only updates `units`; the same exact quantity-granularity math remains valid.
2. Any rebalance UI/agent must recalculate and surface new minimum trade step.
3. Stage 3 agent policy should include a constraint to avoid compositions that produce unusably coarse quantity steps.

## Go/No-Go Checklist
1. All contract and app tests pass.
2. No rounding arbitrage path remains.
3. Previewed amounts equal executed amounts.
4. Invalid quantity paths fail fast in both UI and contract.
5. Devnet smoke test confirms expected mint/redeem deltas.
