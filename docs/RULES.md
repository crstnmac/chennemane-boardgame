# Chennamane rules (Bule Perga / engine v1)

This document matches the TypeScript engine in `src/engine`. For product design details see `design-chennamane-browser-game.md`.

## Board

- 2 rows × 7 pits (14 total).
- **South** owns pits `0–6` (bottom of screen).
- **North** owns pits `7–13` (top of screen).
- Wikipedia labels: South = B1–B7, North = A1–A7.
- Scores are **off-board** only (not sown into).

## Setup

- Default: **5 seeds** in each pit (70 total). Settings allow 4 or 6.
- First player: random (hot-seat) or human (vs AI, human is South by default).

## Sowing (pussa kanawa)

1. Choose an owned non-empty pit and a direction (`cw` or `ccw`, unless direction mode is fixed).
2. Pick up all seeds; drop one per successive pit along the ring (both rows form one loop).
3. When the hand is empty, inspect the **next** pit in that direction:
   - **Non-empty:** pick up those seeds and continue (do not pick up from the pit you just landed in).
   - **Empty (saada):** end the sowing and capture.

## Capture

On saada at empty pit `E`:

1. Capture pit `C = next(E, direction)`.
2. Capture `opposite(C)` (same column on the other row).
3. Add both amounts to your score (0+0 still emits a capture event).

## Second sowing

- If capture total **> 0** and you still have a legal pit, you **must** sow again.
- Engine bookkeeping: `sowingsUsedThisTurn === 1` means a second sowing is required (`needsSecondSowing`).
- After the second saada (any capture result), the turn ends.
- If capture is 0, the turn ends immediately (no second sowing).

## Pass

If you have no seeds on your row but the board is not terminal, you **pass** and the opponent plays.

## End of match

- Terminal when:
  - a player resigns, or
  - the board is empty, or
  - **exactly one residual seed** remains **and** the player is not mid forced second sowing (`sowingsUsedThisTurn === 0`), or
  - **deadlock**: too many consecutive turn-ends (passes included) without a capture — 12 when ≤4 seeds remain on the board, 40 otherwise.
- A true empty board is effectively unreachable under saada/capture: every sowing leaves the last drop in place. A lone residual seed ends the match (or board in multi-round).
- **Residual policy** (settings):
  - `unclaimed` (default): leftover seed stays on the board but is not scored (single); multi-round drops it before reseed.
  - `to-last-mover`: leftover board seeds are credited to the player who just moved (`previousPlayer(toMove)` after turn switch).
- The deadlock rule exists because low-seed endgames (e.g. one bead per side) can cycle forever with both players dodging each other's saada — verified exhaustively for board totals 2–4. Deadlock ends the **match** (single) or **board** (multi-round reseed), with residual policy applied.
- If a capture leaves one seed on your row, you still take the forced second sowing; the match ends when that turn completes.
- Winner: higher score (resign → opponent wins). Ties are draws.

## Direction rings (locked)

Engine `ccw` is Wikipedia “anti-clockwise”:

`S0→S1→…→S6→N6→N5→…→N0→S0`

Golden check: A5 → A4 → A3 under `ccw`.
