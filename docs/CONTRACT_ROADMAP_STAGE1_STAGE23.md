# Contract Roadmap: Stage 1 Hardening + Stage 2/3 Architecture

## Purpose
This document is the execution plan for:

1. Fully hardening the Stage 1 contract (static index, no rebalancing).
2. Designing and implementing the Stage 2/3 contract (manual rebalancing and AI-driven rebalancing).

It is written as an implementation checklist so we can execute step by step without changing direction each week.

## Current Baseline
- Program: `index_protocol` (Anchor).
- Stage 1 mint/redeem vault ownership and canonical ATA checks are in place.
- Per-index `max_assets` is admin-editable, capped by protocol hard ceiling.
- Major unresolved Stage 1 risks remain in rebalancing surface and lifecycle controls.

## Guiding Architecture Decision
- Use separate production contracts:
1. Stage 1 Static Contract (minimal, strict, can be frozen later).
2. Stage 2/3 Dynamic Contract (upgradeable, policy-heavy).

Reason:
- Stage 1 users should not share risk with future rebalance/AI complexity.
- Upgrade blast radius is smaller.
- Audits are simpler and cheaper by scope.

---

## Stage 1 Contract: Complete Fix Plan

## Stage 1 Scope (must stay true)
- Static basket index.
- Users can create index, mint shares, redeem shares.
- No on-chain rebalancing flow.
- No `swap_assets` execution path.
- No weight changes once live, unless explicit controlled policy allows it when supply is zero.

## Stage 1 Security Goals
- Economic integrity: shares are always backed by required basket units.
- Admin cannot drain vault via hidden instructions.
- Arithmetic cannot truncate silently.
- Emergency controls exist (pause) and are test-covered.

## Workstream A: Remove/Revoke Rebalance Surface (Critical)
1. Disable `swap_assets` for Stage 1 runtime.
2. Disable `update_weights` for Stage 1 runtime.
3. Add explicit error codes for blocked instructions in Stage 1.
4. Keep code paths unavailable from UI and from program logic.

Acceptance criteria:
- Calling `swap_assets` reverts with stage-gated error.
- Calling `update_weights` reverts with stage-gated error.
- Tests assert both failures.

## Workstream B: Arithmetic Safety (Critical)
1. Replace all `u128 -> u64` unchecked casts with checked conversions.
2. Add explicit overflow/truncation error.
3. Add `quantity > 0` guard for mint/redeem.

Acceptance criteria:
- Large inputs fail cleanly, never truncate.
- Mint/redeem with zero quantity fails.
- Tests cover overflow and zero-quantity paths.

## Workstream C: Access Control + Lifecycle Safety
1. Add `paused` state to index config.
2. Add admin-only `pause` and `unpause` instructions.
3. Block mint/redeem while paused.
4. Add two-step admin transfer:
   - `set_pending_admin`
   - `accept_admin`
5. Emit events for admin changes and pause changes.

Acceptance criteria:
- Only current admin can pause/unpause or nominate new admin.
- Pending admin must explicitly accept.
- All state transitions are event-logged and tested.

## Workstream D: Stage 1 Immutability Strategy
1. Deploy dedicated Stage 1 program ID with only Stage 1 instructions.
2. Migrate frontend/client bindings to Stage 1 IDL and program ID.
3. Freeze upgrade authority after verification window (recommended).

Acceptance criteria:
- Frontend points to Stage 1 program only for Stage 1 app.
- Upgrade authority policy documented and executed.

## Workstream E: Test + Verification Matrix
1. Positive tests:
   - create index
   - issue shares
   - redeem shares
   - set max assets within allowed range
2. Negative tests:
   - blocked rebalance instructions
   - overflow/truncation attempts
   - invalid vault accounts
   - invalid owner accounts
   - pause blocks mint/redeem
   - unauthorized admin actions
3. Property checks:
   - For any successful mint/redeem, vault deltas match recipe * quantity.
4. Regression harness:
   - Keep all stage 1 tests mandatory in CI.

Acceptance criteria:
- Full Stage 1 test suite passes on local validator and devnet smoke run.

## Workstream F: Deployment and Operations
1. Prepare deployment runbook:
   - build hash
   - deploy tx ids
   - IDL checksum
   - program data authority
2. Add watcher alerts:
   - pause/unpause
   - admin transfer
   - failed tx spikes
3. Write incident procedure:
   - when to pause
   - how to communicate to users

Acceptance criteria:
- Runbook committed and executable by another engineer without tribal knowledge.

## Stage 1 Final Go-Live Checklist
- Rebalance instructions inaccessible.
- Overflow and zero checks merged.
- Pause/admin-transfer live.
- Dedicated Stage 1 program deployed.
- Frontend pinned to Stage 1 IDL/program.
- Test matrix green.
- Runbook complete.

---

## Stage 2/3 Contract Plan (Dynamic Rebalancing + AI Executor)

## Stage 2/3 Scope
- Stage 2: creator/admin manually triggers rebalances.
- Stage 3: AI agent proposes/executes rebalances under strict on-chain policy.
- Same core mint/redeem semantics as Stage 1.

## Core Principle
AI must never have unrestricted token movement authority.
AI can only operate within on-chain limits and state machine transitions.

## Workstream G: New Dynamic Contract State Model
Add or redesign these fields/accounts:

1. `IndexConfigV2`
- `admin`
- `index_mint`
- `bump`
- `paused`
- `mode` (`manual`, `agent`)
- `max_assets`
- `policy` params:
  - `max_turnover_bps`
  - `max_asset_changes`
  - `min_rebalance_interval_slots`
  - optional mint allowlist policy mode
- `last_rebalance_slot`
- `current_recipe`

2. `PendingRebalance` account
- `index`
- `nonce`
- `proposer`
- `created_slot`
- `expires_slot`
- `from_recipe_hash`
- `to_recipe_hash`
- `status` (`proposed`, `executing`, `ready_to_finalize`, `cancelled`, `finalized`)

## Workstream H: Rebalance State Machine
Implement instruction flow:

1. `propose_rebalance(new_assets, new_units, constraints)`
2. `start_rebalance(nonce)`
3. `execute_rebalance_leg(...)` (possibly multiple calls)
4. `finalize_rebalance(nonce)`
5. `cancel_rebalance(nonce)`

Hard invariants:
- Cannot finalize unless vault balances satisfy new recipe against current supply.
- Rebalance must expire if not finalized in window.
- Only one active rebalance per index.
- Policy bounds enforced every time.

## Workstream I: Safe Swap Execution Design
1. Remove free-form `swap_assets`.
2. Replace with constrained leg execution:
   - validated vault accounts
   - validated expected input/output mints
   - bounded slippage parameters
3. Optional:
   - trusted router CPI list
   - per-leg limits

Acceptance criteria:
- No path exists for arbitrary admin drain.
- All outflows are tied to active rebalance plan and bounds.

## Workstream J: AI Agent Authorization Model (Stage 3)
1. Add `agent_authority` role separate from `admin`.
2. Agent can only call:
   - propose/start/execute/finalize rebalance
   - within policy and mode checks.
3. Admin retains:
   - policy updates
   - agent rotation
   - pause controls

Optional hardening:
- Signed off-chain plan digest committed on-chain.
- Cooldown between proposals.

Acceptance criteria:
- Rotating/removing agent immediately revokes ability to act.
- Agent cannot bypass policy.

## Workstream K: Economic and Oracle Policy
1. Define whether pricing is:
   - informational off-chain only, or
   - enforced on-chain via oracle constraints.
2. If on-chain constraints are used:
   - include stale price checks
   - include confidence bounds
3. Always enforce vault solvency invariant regardless of price source.

## Workstream L: Migration Strategy from Stage 1
Choose one:

1. User-driven migration:
- redeem Stage 1 shares
- mint Stage 2 shares in new index

2. Controlled migration tool:
- temporary pause
- verify 1:1 mapping
- move vaults and reissue shares

Recommendation:
- Start with user-driven migration first (lower contract complexity).

## Workstream M: Stage 2/3 Test Matrix
1. State machine tests:
   - invalid transitions rejected
   - expiry and cancellation behavior
2. Solvency tests:
   - finalize fails if undercollateralized
   - finalize passes when exact/overcollateralized
3. Authorization tests:
   - admin vs agent permissions
4. Policy limit tests:
   - turnover and interval limits
   - max asset change bounds
5. Adversarial tests:
   - fake vaults
   - replay nonce
   - stale proposal execution

## Stage 2/3 Delivery Milestones
1. Milestone 1: state + mode + policy primitives.
2. Milestone 2: rebalance state machine.
3. Milestone 3: constrained swap execution.
4. Milestone 4: agent role and policy enforcement.
5. Milestone 5: migration tooling + launch playbook.

---

## Execution Order From Here
1. Finish Stage 1 Workstreams A through C in current branch.
2. Validate Stage 1 test matrix and deploy dedicated Stage 1 program.
3. Freeze or strictly govern Stage 1 upgrades.
4. Start Stage 2/3 dynamic contract on separate program ID.

## Non-Negotiables
- No unrestricted vault outflow instructions in Stage 1.
- No AI direct custody powers in Stage 3.
- Every privileged action must be explicit, gated, and test-covered.
