/**
 * Which cost layer a consumption comes out of — the operator's decision, and the
 * arithmetic that decides whether they need to be asked at all.
 *
 * ## The problem this exists for
 *
 * We hold several cases of the same product bought at different prices: three at
 * $1,400, five at $1,550, two at $1,600. Until now, taking stock out consumed
 * the OLDEST layer first (see `consumeFifo` in main/db/lots.ts) and said nothing
 * about it. Rip the $1,600 case, book $1,400, and that break's margin is wrong —
 * as is every figure built on it, including the per-break P&L in
 * @shared/breakPnl, which sums the cost each line recorded.
 *
 * Nobody notices, because the number that is wrong is one nobody was shown.
 *
 * So the operator is asked which layers a consumption comes out of, and may
 * split it: two from the $1,400 lot, one from the $1,600 lot.
 *
 * ## Why this file is pure
 *
 * The renderer decides whether to prompt and the main process decides whether to
 * honour what came back, and those two must agree exactly. A dialog that appears
 * when main would refuse the answer, or a main process that accepts an
 * allocation the dialog would never have produced, is a disagreement that shows
 * up as a booked cost nobody chose. One copy of the rules, importable from both
 * sides, is what stops that.
 *
 * Quantities here are in the PRODUCT'S OWN STOCK UNIT — the same unit
 * `inventory_lots.qty_remaining` counts — because that is the unit the layers are
 * held in. Converting a case/box/pack entry into it is @shared/units' job and has
 * already happened by the time anything here is called.
 */

import { QTY_EPS, QTY_STORED_DP, quantizationSlack } from './units'

/**
 * One open cost layer, as the picker needs to show it.
 *
 * `vendor` is nullable and stays that way. Only a layer opened by receiving a
 * purchase order knows who it was bought from; one opened by a count sheet, an
 * opening balance or a found-stock adjustment genuinely does not, and inventing
 * a name for it would be worse than the dash the picker prints. `note` and
 * `source` are carried so a vendorless layer can still be told apart from
 * another vendorless layer — "Opening balance" and "Counted cost" are different
 * things and the operator has to be able to see which is which.
 */
export interface CostLot {
  lotId: string
  /** Who it was bought from, when that is known. Never guessed. */
  vendor: string | null
  /** Per one stock unit, at UNIT_DP (four places) — a rate, not a cent value. */
  unitCost: number
  /** How many stock units of this layer are still on the shelf. */
  qtyRemaining: number
  /** ISO instant. Ordering key: FIFO is oldest-first, and so is the picker. */
  receivedAt: string
  /** restock | opening | adjustment | backfill — how the layer came to exist. */
  source: string
  note: string | null
}

/** "Take this many stock units out of this exact layer." */
export interface LotPick {
  lotId: string
  qty: number
}

export type PickCheck = { ok: true } | { ok: false; error: string }

const QTY_SCALE = 10 ** QTY_STORED_DP

/**
 * Round a quantity the way the database stores one.
 *
 * Mirrors `normQty` in main/db/lots.ts. It has to match: a pick this file calls
 * exactly right and the database then re-rounds differently is a pick that
 * validates here and comes up short there, rolling back a consumption the
 * operator had already confirmed.
 */
export function normPickQty(qty: number): number {
  if (!Number.isFinite(qty)) return NaN
  return Math.round(qty * QTY_SCALE) / QTY_SCALE
}

/** Cent-rounding, for money totals. Per-unit costs stay at their own precision. */
const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * Do these layers present a real choice?
 *
 * TRUE only when two layers with stock left carry DIFFERENT unit costs. One
 * layer, or five layers all bought at the same price, is not a decision — it is
 * a dialog with one possible answer.
 *
 * That distinction is the whole feature, not a nicety. A dialog that appears
 * when there is nothing to decide is dismissed unread within a week, and then it
 * is useless on the day it matters — which is the day the two prices differ by
 * two hundred dollars a case. Under-prompting loses one break's margin;
 * over-prompting loses the mechanism.
 *
 * COMPARED AT CENTS, not at the four decimal places a layer is stored to. A
 * layer opened at a blended average (found stock, a backfill, a count sheet's
 * extended total) lands on $1,399.9998 where the case beside it is $1,400.0000,
 * and prompting over a fiftieth of a cent per unit would be exactly the
 * dismissal-training this guards against. A difference that cannot move a
 * break's margin by a cent is not a difference the operator is asked about.
 */
export function needsLotChoice(lots: CostLot[]): boolean {
  const open = openLots(lots)
  if (open.length < 2) return false
  const first = cents(open[0].unitCost)
  return open.some((l) => cents(l.unitCost) !== first)
}

/**
 * The layers worth showing: those with stock actually left in them, oldest
 * first.
 *
 * Sorted here rather than trusted from the caller, because the order the picker
 * lists them in IS the FIFO order — the operator reads the top row as "the one
 * the app would have taken" — and a list that arrived in insertion order would
 * quietly make that read false.
 */
export function openLots(lots: CostLot[]): CostLot[] {
  return lots
    .filter((l) => Number.isFinite(l.qtyRemaining) && l.qtyRemaining > QTY_EPS)
    .slice()
    .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0))
}

/**
 * What FIFO would have done — oldest layers first, until the quantity is met.
 *
 * NOT used to prefill the picker. It is here so a screen can SAY what the old
 * behaviour would have booked, and so a test can assert that an untouched
 * allocation and the FIFO walk agree.
 *
 * Deliberately not the dialog's starting state: the whole complaint was that the
 * app answered this question by itself, and a pre-filled answer with a live
 * Confirm button answers it again, just with an extra click. The picker starts
 * at zero and makes the operator say what they took.
 */
export function fifoPicks(lots: CostLot[], quantity: number): LotPick[] {
  let need = normPickQty(quantity)
  if (!Number.isFinite(need) || need <= 0) return []
  const picks: LotPick[] = []
  for (const lot of openLots(lots)) {
    if (need <= QTY_EPS) break
    const take = normPickQty(Math.min(need, lot.qtyRemaining))
    if (!(take > 0)) continue
    picks.push({ lotId: lot.lotId, qty: take })
    need = normPickQty(need - take)
  }
  return picks
}

/** Total stock units an allocation accounts for. */
export function pickedQty(picks: LotPick[]): number {
  return normPickQty(picks.reduce((sum, p) => sum + (Number.isFinite(p.qty) ? p.qty : 0), 0))
}

/**
 * What an allocation costs, in money, rounded to cents.
 *
 * A TOTAL, so cents. Unknown lot ids contribute nothing rather than throwing:
 * this feeds a running figure in a dialog that is being edited, and a preview
 * that explodes half-way through a keystroke is worse than one that is briefly
 * low. `validatePicks` is what refuses an unknown lot, and it runs before
 * anything is written.
 */
export function pickedCost(lots: CostLot[], picks: LotPick[]): number {
  const byId = new Map(lots.map((l) => [l.lotId, l]))
  let total = 0
  for (const p of picks) {
    const lot = byId.get(p.lotId)
    if (!lot || !Number.isFinite(p.qty)) continue
    total += p.qty * lot.unitCost
  }
  return cents(total)
}

/**
 * What one unit of this allocation works out at — the number the operator is
 * actually deciding, and the one to compare against the product's average.
 *
 * Zero when nothing is allocated yet, which is the honest answer: there is no
 * blend of nothing.
 */
export function blendedUnitCost(lots: CostLot[], picks: LotPick[]): number {
  const qty = pickedQty(picks)
  if (!(qty > 0)) return 0
  return pickedCost(lots, picks) / qty
}

/**
 * How much of `quantity` is still unallocated. Never negative — the picker
 * clamps every increment to it, so a negative here would mean an allocation that
 * arrived from somewhere other than the dialog.
 */
export function outstandingQty(picks: LotPick[], quantity: number): number {
  const left = normPickQty(quantity - pickedQty(picks))
  return left > 0 ? left : 0
}

/**
 * Does the allocation add up to exactly the quantity being consumed?
 *
 * The gate on the Confirm button. "Exactly" carries the repo's usual
 * quantization slack rather than being a float equality: a stored layer balance
 * is re-rounded to four places on every movement, so the last piece of a
 * fractionally-held product legitimately lands a few ten-thousandths under a
 * full-precision ask. Demanding exact equality there would leave Confirm
 * permanently disabled on the sixth box of a six-box case — the same arithmetic
 * that once made that box impossible to record at all.
 */
export function allocationIsComplete(picks: LotPick[], quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0) return false
  return Math.abs(pickedQty(picks) - quantity) <= quantizationSlack(quantity)
}

/**
 * Every way an allocation can be wrong, checked in one place, with the message
 * the operator sees.
 *
 * Called by the dialog (to explain itself) and again by the write path (because
 * the renderer is not a trust boundary and a browser tab left open across a
 * shift is holding numbers from before lunch).
 */
export function validatePicks(lots: CostLot[], picks: LotPick[], quantity: number): PickCheck {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: 'There is no quantity to allocate.' }
  }
  const byId = new Map(lots.map((l) => [l.lotId, l]))
  const seen = new Set<string>()
  for (const p of picks) {
    const lot = byId.get(p.lotId)
    if (!lot) {
      return {
        ok: false,
        error: 'One of those cost layers is no longer on the shelf. Reopen this and choose again.'
      }
    }
    // Two rows naming one layer can each look legal while their SUM walks past
    // what the layer holds — and the consumption would then take stock out of a
    // lot that did not have it, which is the one thing the FIFO engine's
    // invariant cannot survive.
    if (seen.has(p.lotId)) {
      return { ok: false, error: 'That cost layer is listed twice.' }
    }
    seen.add(p.lotId)
    if (!Number.isFinite(p.qty) || p.qty < 0) {
      return { ok: false, error: 'A layer cannot supply a negative quantity.' }
    }
    // Slack on the ceiling, for the same reason allocationIsComplete has it:
    // taking a fractional layer's entire balance can land a dust-width over the
    // stored figure, and refusing that would make the last pack unallocatable.
    if (p.qty > lot.qtyRemaining + quantizationSlack(p.qty)) {
      return {
        ok: false,
        error: `That layer only has ${lot.qtyRemaining} left.`
      }
    }
  }
  if (!allocationIsComplete(picks, quantity)) {
    const total = pickedQty(picks)
    return {
      ok: false,
      error:
        total < quantity
          ? `Allocate all ${quantity} — ${normPickQty(quantity - total)} still to place.`
          : `That allocates ${total}, which is more than the ${quantity} being taken.`
    }
  }
  return { ok: true }
}

/**
 * Drop the empty rows and round what is left.
 *
 * The dialog holds a quantity for every layer on screen, most of them zero. A
 * zero pick is not a decision about that layer, it is the absence of one, and
 * sending it would put a row in the consumption's record claiming a layer
 * supplied nothing.
 */
export function tidyPicks(picks: LotPick[]): LotPick[] {
  return picks
    .filter((p) => Number.isFinite(p.qty) && p.qty > QTY_EPS)
    .map((p) => ({ lotId: p.lotId, qty: normPickQty(p.qty) }))
}

/**
 * How much one press of + adds to a row.
 *
 * A whole unit, EXCEPT that it is clamped to what is left to allocate and to
 * what the layer holds. Both clamps are what make a fractional consumption
 * expressible at all: a giveaway of three packs out of a twelve-pack box is 0.25
 * of a box, and a stepper that could only move in whole units would leave the
 * operator staring at a Confirm button that never lights up.
 *
 * It also removes over-allocation as a state the dialog can be in. The operator
 * can be short, and the button says so; they cannot be over, because + will not
 * take them there.
 */
export function plusStep(lot: CostLot, current: number, picks: LotPick[], quantity: number): number {
  const room = normPickQty(lot.qtyRemaining - current)
  const left = outstandingQty(picks, quantity)
  const step = Math.min(1, room, left)
  return step > QTY_EPS ? normPickQty(step) : 0
}

/**
 * How much one press of − takes off a row.
 *
 * A whole unit, or whatever is there if that is less. Coming back down from 2.25
 * therefore goes 1.25, 0.25, 0 — every step reachable, and zero always reachable,
 * which matters because "I picked the wrong layer" has to be undoable without
 * closing the dialog and losing the rest of the allocation.
 */
export function minusStep(current: number): number {
  if (!(current > QTY_EPS)) return 0
  return normPickQty(Math.min(1, current))
}

/** Set one layer's quantity in an allocation, dropping it when it reaches zero. */
export function withPick(picks: LotPick[], lotId: string, qty: number): LotPick[] {
  const q = normPickQty(qty)
  const rest = picks.filter((p) => p.lotId !== lotId)
  if (!(q > QTY_EPS)) return rest
  return [...rest, { lotId, qty: q }]
}

/** What one layer currently has allocated to it. */
export function pickFor(picks: LotPick[], lotId: string): number {
  return picks.find((p) => p.lotId === lotId)?.qty ?? 0
}

/**
 * What to print in the picker's vendor column.
 *
 * Falls back through what the layer actually knows rather than to a blank: a row
 * with no label is indistinguishable from the row above it, and the operator is
 * being asked to tell them apart. Never invents a vendor — "Opening balance" is
 * a true statement about where the layer came from, "Unknown vendor" would be a
 * true one too, and neither is a supplier's name.
 */
export function lotLabel(lot: CostLot): string {
  const vendor = (lot.vendor ?? '').trim()
  if (vendor) return vendor
  const note = (lot.note ?? '').trim()
  if (note) return note
  switch (lot.source) {
    case 'opening':
      return 'Opening stock'
    case 'adjustment':
      return 'Stock correction'
    case 'backfill':
      return 'Opening balance'
    default:
      return 'No vendor recorded'
  }
}
