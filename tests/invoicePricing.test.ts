/**
 * Correcting the money on a sales order that is already in QuickBooks.
 *
 * The owner's words: "add an edit button on sales orders that I can edit the
 * price in the software — I know I would have to manually do that in
 * QuickBooks."
 *
 * ## The rule this changes, and the rule it does not
 *
 * `saveInvoice` throws the moment an invoice is not a draft, and the reason
 * written above it stands: it rewrites EVERY column — buyer, number, dates,
 * terms, quantities, lines added and removed — and this app is not the system of
 * record for a document somebody has been billed against. That is an argument
 * against rewriting the document. It is not an argument for the app holding a
 * figure it knows to be wrong, and a price renegotiated after the invoice went
 * out is ordinary trade on this floor.
 *
 * So the gate MOVED rather than opened, and the whole safety of this feature is
 * in how narrow the new one is.
 *
 * ## What is pinned here, and how each one fails if it is wrong
 *
 *   1. A POSTED SALE'S PRICE CAN BE CORRECTED, and the header total follows.
 *      This is the feature. Without it the app reports a number nobody agreed.
 *
 *   2. SAVE IS STILL REFUSED ON THE SAME ORDER. If widening this had widened
 *      `saveInvoice` too, a buyer, a number or a date could drift silently on a
 *      document somebody is holding a copy of.
 *
 *   3. NOT ONE UNIT MOVES. The load-bearing one. There is no path from a price
 *      to `applyInvoiceStock` — the inputs are a rate and an amount and nothing
 *      that costs a shelf reads either — and a price edit that quietly re-picked
 *      inventory would be the worst possible failure of this screen. Measured on
 *      the shelf, and on the stock-move rows, not trusted from a flag.
 *
 *   4. THE AGREED AMOUNT SURVIVES. `amount` on this table has always been what
 *      was agreed rather than quantity × rate — "a buyer talked down to a round
 *      number" — so a screen that could only set the rate would make that number
 *      unreachable on exactly the orders somebody is here to correct.
 *
 *   5. THE TOTAL IS RE-DERIVED FROM THE LINES, never patched by a delta. An
 *      arithmetic patch stays right until the first untouched line and is then
 *      wrong for ever with nothing to show it.
 *
 *   6. A BLANK OR ABSURD FIGURE IS REFUSED BY NAME, and the refusal changes
 *      nothing. Read as zero, a blank box marks a line free and the save looks
 *      like it worked.
 *
 *   7. THE HISTORY SAYS WHAT HAPPENED IN DOLLARS, and says QuickBooks was not
 *      changed. The trail has to outlive the person who made the correction.
 *
 *   8. AND THE GAP TO QUICKBOOKS IS VISIBLE. `qboTotalMismatch` is the other
 *      half of the bargain: nothing here can reach Intuit, so the operator
 *      corrects it there by hand, and the only thing stopping that being
 *      forgotten is that the disagreement shows on the card until it is fixed.
 *
 * Every name here is invented.
 *
 * Run: npm run test:invoice-pricing
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/invoice-pricing-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const database = require('../src/main/db/database')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const extrasRepo = require('../src/main/db/orderExtras')
const { qboTotalMismatch } = require('../src/shared/invoices')

const db = database.getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_p', 'SKU-P', 'Priced Hobby Box', 'Baseball', 400,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
invStock.addStock('p_p', 'RM', 50, 400, null)

const qtyAt = (): number => invStock.stockQty('p_p', 'RM')
const soEvents = (id: string): string[] =>
  extrasRepo.listOrderEvents('so', id).map((e: any) => e.detail ?? '')

console.log('\n=== CORRECTING THE MONEY ON A POSTED SALE ===')
// ---------------------------------------------------------------------------
{
  const shelfBefore = qtyAt()
  const sale = inv.saveInvoice(
    {
      customerName: 'Renegotiating Buyer',
      invoiceNumber: 'SO-7100',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        { item: 'Priced Hobby Box', productId: 'p_p', quantity: 4, rate: 900 },
        { item: 'Grading fee', quantity: 1, rate: 50 }
      ]
    },
    null
  )
  ok(sale.total === 3650, 'the sale is written at 4 × $900 plus a $50 fee', String(sale.total))
  const shelfAfterSale = qtyAt()
  ok(shelfAfterSale === shelfBefore - 4, 'and drew four cases off the shelf', String(shelfAfterSale))

  // POSTED. Everything below happens to a document somebody has been billed
  // against, which is the entire point of the feature.
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-7100' WHERE id = ?`).run(sale.id)

  // --- 2. save is still refused, and that must not have changed -----------
  /**
   * PINNED FIRST, deliberately. The risk in adding a price editor is that
   * somebody widens `saveInvoice` to get it, and then a buyer, a number, a date
   * or a whole line can drift on a posted document with nothing on either
   * screen to say which copy is true. The narrow write exists precisely so this
   * refusal can stay exactly as strict as it was.
   */
  let saveThrew = ''
  try {
    inv.saveInvoice(
      {
        id: sale.id,
        customerName: 'Somebody Else Entirely',
        invoiceNumber: 'SO-7100',
        invoiceDate: '2026-08-27',
        location: 'RM',
        lines: [{ item: 'Priced Hobby Box', productId: 'p_p', quantity: 4, rate: 900 }]
      },
      null
    )
  } catch (err) {
    saveThrew = err instanceof Error ? err.message : String(err)
  }
  ok(
    /already gone to QuickBooks/i.test(saveThrew),
    'THE ORDINARY SAVE IS STILL REFUSED ON A POSTED ORDER — the gate moved, it did not open',
    saveThrew
  )
  ok(
    inv.getInvoice(sale.id).customerName === 'Renegotiating Buyer',
    'and the buyer it tried to change is untouched'
  )

  // --- 1. the price is corrected, and the total follows -------------------
  const lines = inv.getInvoice(sale.id).lines
  const boxLine = lines.find((l: any) => l.productId === 'p_p')
  const feeLine = lines.find((l: any) => !l.productId)
  const cut = inv.setInvoicePricing(sale.id, [{ lineId: boxLine.id, rate: 850 }], null)
  ok(!cut.error, 'A POSTED SALE’S PRICE CAN BE CORRECTED', String(cut.error))
  const afterCut = inv.getInvoice(sale.id)
  const cutLine = afterCut.lines.find((l: any) => l.id === boxLine.id)
  ok(cutLine.rate === 850, 'the line carries the new price', String(cutLine.rate))
  ok(
    cutLine.amount === 3400,
    'AND THE LINE AMOUNT FOLLOWS THE RATE — nobody should have to retype the multiplication',
    String(cutLine.amount)
  )
  ok(
    afterCut.total === 3450,
    'AND THE HEADER TOTAL IS THE SUM OF EVERY LINE, including the fee this change never mentioned',
    String(afterCut.total)
  )
  ok(
    afterCut.lines.find((l: any) => l.id === feeLine.id).amount === 50,
    'the untouched line is exactly as it was'
  )

  // --- 3. and not one unit moved ------------------------------------------
  /**
   * THE LOAD-BEARING ASSERTION. A sale of four cases whose price was cut is
   * still a sale of four cases: the FIFO layers it consumed are the layers it
   * consumed, and re-picking them would silently re-cost the order and move
   * somebody else's boxes. Structural rather than promised — the only inputs
   * here are a rate and an amount, and nothing that costs a shelf reads either.
   */
  ok(
    qtyAt() === shelfAfterSale,
    'NOT ONE UNIT MOVED FOR A PRICE CHANGE — the shelf is exactly where the sale left it',
    `${shelfAfterSale} -> ${qtyAt()}`
  )
  const moves = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q
                FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(sale.id) as { n: number; q: number }
  ok(
    moves.q === 4,
    'and the stock moves behind it still say four, not eight and not zero',
    `${moves.n} rows, ${moves.q} units`
  )
  ok(
    inv.getInvoice(sale.id).lines.find((l: any) => l.id === boxLine.id).quantity === 4,
    'THE QUANTITY IS UNTOUCHED — this screen changes money and nothing else'
  )

  // --- 4. an amount that is not quantity × rate ---------------------------
  /**
   * "A buyer talked down to a round number is a real thing that happens on this
   * floor." `amount` has always been what was AGREED, and a price editor that
   * could only set the rate would leave that number unreachable on exactly the
   * orders somebody opens this screen to fix.
   */
  const agreed = inv.setInvoicePricing(
    sale.id,
    [{ lineId: boxLine.id, rate: 850, amount: 3300 }],
    null
  )
  ok(!agreed.error, 'AN AGREED AMOUNT MAY DIFFER FROM QUANTITY × RATE', String(agreed.error))
  const roundLine = inv.getInvoice(sale.id).lines.find((l: any) => l.id === boxLine.id)
  ok(
    roundLine.rate === 850 && roundLine.amount === 3300,
    'both are stored, and the amount is NOT recomputed over the top of what was agreed',
    `${roundLine.rate} / ${roundLine.amount}`
  )
  ok(
    inv.getInvoice(sale.id).total === 3350,
    'AND THE TOTAL IS RE-DERIVED FROM THE AMOUNTS, not from quantity × rate',
    String(inv.getInvoice(sale.id).total)
  )

  // --- 5. the total is summed, never patched ------------------------------
  /**
   * PINNED THROUGH A SECOND LINE that this change never mentions. A delta patch
   * would agree with a sum on a one-line order and diverge for ever the moment
   * an order has two, which is most of them.
   */
  ok(
    !inv.setInvoicePricing(sale.id, [{ lineId: feeLine.id, rate: 75 }], null).error,
    'the fee line is corrected on its own'
  )
  ok(
    inv.getInvoice(sale.id).total === 3375,
    'AND THE TOTAL IS THE SUM OF WHAT IS ACTUALLY STORED — 3300 agreed plus 75',
    String(inv.getInvoice(sale.id).total)
  )

  // --- 6. refusals, and they change nothing -------------------------------
  const totalBefore = inv.getInvoice(sale.id).total
  const notANumber = inv.setInvoicePricing(sale.id, [{ lineId: boxLine.id, rate: NaN }], null)
  ok(!!notANumber.error, 'A FIGURE THAT IS NOT A NUMBER IS REFUSED', String(notANumber.error))
  ok(
    /not a number/i.test(notANumber.error ?? '') && /Priced Hobby Box/.test(notANumber.error ?? ''),
    'and the refusal names the line — a blank read as zero would mark it free and look like a save',
    String(notANumber.error)
  )
  const absurd = inv.setInvoicePricing(sale.id, [{ lineId: boxLine.id, rate: 99_000_000 }], null)
  ok(!!absurd.error, 'AND SO IS A FIGURE THAT IS NOT A PRICE', String(absurd.error))
  ok(
    inv.getInvoice(sale.id).total === totalBefore,
    'AND A REFUSAL CHANGES NOTHING — the whole change is one transaction',
    String(inv.getInvoice(sale.id).total)
  )
  ok(
    !!inv.setInvoicePricing(sale.id, [{ lineId: 'not-a-line', rate: 10 }], null).error,
    'a line that is not on this order is refused'
  )
  ok(
    !inv.setInvoicePricing(sale.id, [], null).error,
    'and changing nothing is not an error'
  )
  /**
   * A CHANGE THAT SETS THE SAME NUMBERS WRITES NOTHING. A log that gains a line
   * every time somebody opens a screen and presses save is a log nobody reads.
   */
  const quietBefore = soEvents(sale.id).length
  inv.setInvoicePricing(sale.id, [{ lineId: feeLine.id, rate: 75 }], null)
  ok(
    soEvents(sale.id).length === quietBefore,
    'RE-SAVING THE SAME PRICE LEAVES THE LOG ALONE',
    `${quietBefore} -> ${soEvents(sale.id).length}`
  )

  // --- 7. the history, in dollars -----------------------------------------
  const said = soEvents(sale.id)
  ok(
    said.some((d) => /\$900\.00 → \$850\.00 each/.test(d)),
    'THE HISTORY NAMES THE OLD FIGURE AND THE NEW ONE, so the trail outlives the person',
    said.join(' | ')
  )
  ok(
    said.some((d) => /QuickBooks was NOT changed/i.test(d)),
    'AND SAYS QUICKBOOKS WAS NOT CHANGED — the other half of the bargain, in the record',
    said.join(' | ')
  )
  ok(
    said.some((d) => /Order total .* → .*/.test(d)),
    'and the order total, before and after'
  )

  // --- 8. the gap to QuickBooks -------------------------------------------
  /**
   * NOTHING HERE CAN REACH INTUIT — `pushToQbo` refuses an invoice that already
   * has an id and there is no update path at all — so the operator corrects it
   * there by hand. The only thing stopping that being forgotten is that the
   * disagreement is visible, and stays visible until the two agree.
   */
  const live = inv.getInvoice(sale.id)
  ok(
    qboTotalMismatch(live) === null,
    'NO MISMATCH IS REPORTED BEFORE QUICKBOOKS HAS BEEN READ — an absence of evidence is not agreement',
    String(qboTotalMismatch(live))
  )
  db.prepare(`UPDATE invoices SET qbo_total_amt = 3650 WHERE id = ?`).run(sale.id)
  const seen = inv.getInvoice(sale.id)
  ok(
    qboTotalMismatch(seen) === -275,
    'ONCE IT HAS, THE GAP IS REPORTED SIGNED — negative means QuickBooks is HIGHER and needs lowering',
    String(qboTotalMismatch(seen))
  )
  db.prepare(`UPDATE invoices SET qbo_total_amt = ? WHERE id = ?`).run(seen.total, sale.id)
  ok(
    qboTotalMismatch(inv.getInvoice(sale.id)) === null,
    'AND IT CLEARS THE MOMENT THE TWO AGREE — the reminder stops when the job is done'
  )
  db.prepare(`UPDATE invoices SET qbo_voided = 1 WHERE id = ?`).run(sale.id)
  ok(
    qboTotalMismatch({ ...inv.getInvoice(sale.id), total: 1 }) === null,
    'A VOIDED QUICKBOOKS INVOICE IS NOT A MISMATCH — there is no live document over there to disagree with'
  )
  db.prepare(`UPDATE invoices SET qbo_voided = 0 WHERE id = ?`).run(sale.id)
  ok(
    qboTotalMismatch({ ...inv.getInvoice(sale.id), qboId: null, total: 1 }) === null,
    'AND NEITHER IS AN ORDER THAT NEVER WENT TO QUICKBOOKS'
  )

  // --- and a voided order is refused outright -----------------------------
  inv.setInvoiceStatus(sale.id, 'void', null)
  ok(
    !!inv.setInvoicePricing(sale.id, [{ lineId: boxLine.id, rate: 1 }], null).error,
    'A VOID ORDER IS REFUSED — nothing is being sold, so there is no price to agree'
  )
  ok(
    qtyAt() === shelfBefore,
    'and voiding handed back the four cases the sale took, price changes and all',
    `${qtyAt()} vs ${shelfBefore}`
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
