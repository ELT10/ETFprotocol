# Stage 2/3 Workspace

This folder contains code that is intentionally excluded from the Stage 1 surface.

Moved here:
- `stage2/scripts/fix-weights.ts` (manual composition updates)
- `stage2/bot/rebalance.ts` (rebalance bot flow)
- `stage2/app/index-edit.page.stage2.tsx` (previous Stage 2 edit UI implementation)

Notes:
- Stage 1 program no longer exposes `update_weights` or `swap_assets`.
- Stage 2 scripts here are retained for future Stage 2/3 contract work and may require adapting to the new Stage 2 program IDL.
