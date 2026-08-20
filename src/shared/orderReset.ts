/**
 * Clearing the decks: every purchase order, every sales order, every deal
 * ticket, gone.
 *
 * ## What this is for, and what it is not
 *
 * It is for starting the paperwork over — a season of test orders, a migration
 * that went in twice, a set of numbers somebody wants to begin again from. It
 * is NOT an undo. Deleting one order means "this did not happen" and hands its
 * stock back; deleting all of them at once cannot mean that, because handing
 * back every unit ever sold would double the shelf.
 *
 * ## So THE SHELF IS NOT TOUCHED, and that is the whole design
 *
 * On-hand quantities, FIFO cost layers and the inventory ledger are left
 * exactly as they stand. That is not an oversight to be tidied up later: the
 * cost layers reference PRODUCTS, never orders, so they survive on their own,
 * and the shelf is right — it is the paperwork that is being started again.
 *
 * Anybody who wants the stock reset as well has Admin → Inventory reset, which
 * is a different job with a different preview.
 *
 * ## Two things it cannot undo, and says so
 *
 * IT TRAVELS. Deleting a synced row enqueues that delete for every other
 * machine, so this is not local housekeeping — it empties the boards everywhere.
 *
 * QUICKBOOKS KEEPS ITS COPIES. Every invoice that reached Intuit stays there.
 * This clears our side, which means the two stop agreeing, permanently.
 */

/** What a reset would remove, counted before anybody commits to it. */
export interface OrderResetPreview {
  purchaseOrders: number
  salesOrders: number
  dealTickets: number
  /** Events, parcels and uploaded labels attached to those orders. */
  events: number
  shipments: number
  documents: number
  /** How many of the sales orders have a QuickBooks copy that will survive. */
  inQuickBooks: number
  /** On-hand units the shelf keeps regardless. Stated so nobody assumes. */
  stockUnitsKept: number
}

export function orderResetTotal(p: OrderResetPreview): number {
  return p.purchaseOrders + p.salesOrders + p.dealTickets
}

export function orderResetIsEmpty(p: OrderResetPreview): boolean {
  return orderResetTotal(p) === 0
}

/**
 * What has to be typed to arm it.
 *
 * A TYPED PHRASE rather than a second "are you sure", because this is the one
 * screen in the app that can delete every order the business has ever raised
 * and there is no way back from it. A dialog with a button is dismissed by
 * somebody who is already reaching for the mouse; a phrase has to be read.
 */
export const ORDER_RESET_PHRASE = 'DELETE ALL ORDERS'

export function orderResetArmed(typed: string): boolean {
  return typed.trim().toUpperCase() === ORDER_RESET_PHRASE
}

/** What the operator is choosing, beyond the deletion itself. */
export interface OrderResetInput {
  /**
   * Send the numbering back to its starting points as well.
   *
   * Off by default. Wiping the documents and RESTARTING the count are two
   * different intentions — plenty of resets exist to clear a mess while keeping
   * the sequence honest, and a number that has been on a supplier's paperwork
   * should not come round a second time by accident.
   */
  restartNumbering?: boolean
}

/** What actually happened, for the sentence afterwards. */
export interface OrderResetResult extends OrderResetPreview {
  restartedNumbering: boolean
}

/**
 * The sentence a preview reads as.
 *
 * Built here so the confirmation and the result afterwards are worded by one
 * function — a summary that says something different before and after is how
 * somebody comes to believe a different thing happened.
 */
export function describeOrderReset(p: OrderResetPreview): string {
  const bits: string[] = []
  const n = (count: number, one: string, many: string): void => {
    if (count > 0) bits.push(`${count} ${count === 1 ? one : many}`)
  }
  n(p.purchaseOrders, 'purchase order', 'purchase orders')
  n(p.salesOrders, 'sales order', 'sales orders')
  n(p.dealTickets, 'deal ticket', 'deal tickets')
  if (bits.length === 0) return 'There is nothing to delete.'
  if (bits.length === 1) return bits[0]
  return `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
}
