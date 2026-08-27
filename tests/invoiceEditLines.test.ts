/**
 * Editing the lines of a sales order that is already in QuickBooks.
 *
 * The owner's words: "add an edit button on sales orders that I can edit the
 * price in the software — I know I would have to manually do that in
 * QuickBooks." Then: "can we also edit the quantity there, and if there are 2+
 * units, be able to set individual prices if we don't sell them at each."
 *
 * ## The rule this changes, and the rule it does not
 *
 * `saveInvoice` throws the moment an invoice is not a draft, and the reason
 * written above it stands: it rewrites EVERY column — buyer, number, dates,
 * terms, class — and reaches QuickBooks, and this app is not the system of
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
 *   3. A PRICE CHANGE MOVES NO UNIT. Nothing that costs a shelf reads a rate or
 *      an amount, and a price edit that quietly re-picked inventory would be the
 *      worst possible failure of this screen. Measured on the shelf and on the
 *      stock-move rows, not trusted from a flag.
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
 *   9. A QUANTITY CHANGE DOES MOVE STOCK, and moves exactly the difference. The
 *      one input here with a consequence outside the document, and it goes
 *      through the identical release-then-apply `saveInvoice` uses — so selling
 *      six instead of four takes two more off the shelf and no more.
 *
 *  10. TWO PRICES FOR ONE PRODUCT IS TWO LINES. The split makes real invoice
 *      lines, because that is what an invoice is and what somebody has to retype
 *      into QuickBooks — and the parts inherit the parent's routing, so a split
 *      about price does not silently become a different answer about sourcing.
 *
 *  11. AND A SPLIT CLEARS THE LINE'S PER-CASE SOURCING. Those slices must sum to
 *      the line, so they cannot survive a line that no longer exists at that
 *      quantity. Deleted rather than scaled, because nothing could say which of
 *      the new cases were the dropship ones.
 *
 *  12. A LINE CAN BE TAKEN OFF, AND THE LAST ONE CANNOT. Removal is what makes a
 *      mis-typed split recoverable from the app instead of by hand; an order
 *      with no lines is not corrected, it is void, and voiding has its own path.
 *
 * Every name here is invented.
 *
 * Run: npm run test:invoice-edit
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/invoice-edit-db')
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
  const cut = inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, rate: 850 }], null)
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
  const agreed = inv.setInvoiceLines(
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
    !inv.setInvoiceLines(sale.id, [{ lineId: feeLine.id, rate: 75 }], null).error,
    'the fee line is corrected on its own'
  )
  ok(
    inv.getInvoice(sale.id).total === 3375,
    'AND THE TOTAL IS THE SUM OF WHAT IS ACTUALLY STORED — 3300 agreed plus 75',
    String(inv.getInvoice(sale.id).total)
  )

  // --- 6. refusals, and they change nothing -------------------------------
  const totalBefore = inv.getInvoice(sale.id).total
  const notANumber = inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, rate: NaN }], null)
  ok(!!notANumber.error, 'A FIGURE THAT IS NOT A NUMBER IS REFUSED', String(notANumber.error))
  ok(
    /not a number/i.test(notANumber.error ?? '') && /Priced Hobby Box/.test(notANumber.error ?? ''),
    'and the refusal names the line — a blank read as zero would mark it free and look like a save',
    String(notANumber.error)
  )
  const absurd = inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, rate: 99_000_000 }], null)
  ok(!!absurd.error, 'AND SO IS A FIGURE THAT IS NOT A PRICE', String(absurd.error))
  ok(
    inv.getInvoice(sale.id).total === totalBefore,
    'AND A REFUSAL CHANGES NOTHING — the whole change is one transaction',
    String(inv.getInvoice(sale.id).total)
  )
  ok(
    !!inv.setInvoiceLines(sale.id, [{ lineId: 'not-a-line', rate: 10 }], null).error,
    'a line that is not on this order is refused'
  )
  ok(
    !inv.setInvoiceLines(sale.id, [], null).error,
    'and changing nothing is not an error'
  )
  /**
   * A CHANGE THAT SETS THE SAME NUMBERS WRITES NOTHING. A log that gains a line
   * every time somebody opens a screen and presses save is a log nobody reads.
   */
  const quietBefore = soEvents(sale.id).length
  inv.setInvoiceLines(sale.id, [{ lineId: feeLine.id, rate: 75 }], null)
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
    !!inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, rate: 1 }], null).error,
    'A VOID ORDER IS REFUSED — nothing is being sold, so there is no price to agree'
  )
  ok(
    qtyAt() === shelfBefore,
    'and voiding handed back the four cases the sale took, price changes and all',
    `${qtyAt()} vs ${shelfBefore}`
  )
}

console.log('\n=== CHANGING A QUANTITY, AND SPLITTING ONE LINE INTO TWO PRICES ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "can we also edit the quantity there, and if there are 2+ units,
 * be able to set individual prices if we don't sell them at each."
 *
 * Four cases where two went at $900 and two at $850 is, on any invoice ever
 * written, two lines — so the split makes real lines rather than a list of
 * prices hanging off one. It is also the only shape somebody can retype into
 * QuickBooks, which is the job this whole screen hands them.
 */
{
  const shelfBefore = qtyAt()
  const sale = inv.saveInvoice(
    {
      customerName: 'Half And Half Buyer',
      invoiceNumber: 'SO-7200',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        { item: 'Priced Hobby Box', productId: 'p_p', quantity: 4, rate: 900 },
        { item: 'Grading fee', quantity: 1, rate: 50 }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-7200' WHERE id = ?`).run(sale.id)
  ok(qtyAt() === shelfBefore - 4, 'the sale drew its four cases', String(qtyAt()))
  const boxLine = inv.getInvoice(sale.id).lines.find((l: any) => l.productId === 'p_p')

  // --- 9. a quantity change moves stock, and moves exactly the difference --
  const up = inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, quantity: 6 }], null)
  ok(!up.error, 'A QUANTITY CAN BE CORRECTED ON A POSTED ORDER', String(up.error))
  ok(
    qtyAt() === shelfBefore - 6,
    'AND THE SHELF MOVES BY EXACTLY THE DIFFERENCE — two more off, not six more and not none',
    `${shelfBefore - 4} -> ${qtyAt()}`
  )
  const raised = inv.getInvoice(sale.id)
  ok(raised.lines[0].quantity === 6, 'the line sells six now')
  ok(
    raised.lines[0].amount === 5400 && raised.total === 5450,
    'AND THE AMOUNT AND THE TOTAL FOLLOW — 6 × $900 plus the $50 fee',
    `${raised.lines[0].amount} / ${raised.total}`
  )
  ok(
    raised.lines[0].qtyFulfilled === 6,
    'AND THE PICKING RECORD SAYS SIX, read off what the shelf actually gave',
    String(raised.lines[0].qtyFulfilled)
  )
  const down = inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, quantity: 3 }], null)
  ok(!down.error, 'and it can go down again', String(down.error))
  ok(
    qtyAt() === shelfBefore - 3,
    'PUTTING THREE BACK ON THE SHELF — release-then-apply, so the layers land where they came from',
    String(qtyAt())
  )
  ok(
    inv.getInvoice(sale.id).total === 2750,
    'and the total follows down as well',
    String(inv.getInvoice(sale.id).total)
  )
  ok(
    !!inv.setInvoiceLines(sale.id, [{ lineId: boxLine.id, quantity: 0 }], null).error,
    'A LINE CANNOT BE SET TO NOTHING — that is a removal, and it has its own instruction'
  )

  // --- 10. two prices for one product is two lines ------------------------
  /**
   * PINNED ON THE ROUTING AS WELL AS THE MONEY. A part of a line that came off
   * the RM shelf is still coming off the RM shelf; a split about PRICE that
   * quietly changed the answer about SOURCING would re-cost half the order
   * against whatever FIFO offered next.
   */
  db.prepare(`UPDATE invoice_lines SET destination = 'RM' WHERE id = ?`).run(boxLine.id)
  const split = inv.setInvoiceLines(
    sale.id,
    [
      {
        lineId: boxLine.id,
        splitInto: [
          { quantity: 2, rate: 900 },
          { quantity: 2, rate: 850 }
        ]
      }
    ],
    null
  )
  ok(!split.error, 'A LINE CAN BE SPLIT INTO TWO PRICES', String(split.error))
  const afterSplit = inv.getInvoice(sale.id)
  const boxes = afterSplit.lines.filter((l: any) => l.productId === 'p_p')
  ok(
    boxes.length === 2,
    'AND IT BECOMES TWO REAL INVOICE LINES — which is what an invoice is, and what gets retyped into QuickBooks',
    String(boxes.length)
  )
  ok(
    boxes[0].id === boxLine.id,
    'THE FIRST PART KEEPS THE ORIGINAL ROW, so anything holding that line id still finds it',
    `${boxes[0].id} vs ${boxLine.id}`
  )
  ok(
    boxes[0].quantity === 2 && boxes[0].rate === 900 && boxes[1].quantity === 2 && boxes[1].rate === 850,
    'each part carries its own quantity and its own price',
    boxes.map((b: any) => `${b.quantity}@${b.rate}`).join(' ')
  )
  ok(
    boxes[1].item === boxLine.item && boxes[1].sku === boxLine.sku,
    'and the new line is the same product, not a blank one'
  )
  ok(
    afterSplit.total === 3550,
    'the total is 2 × $900 plus 2 × $850 plus the $50 fee',
    String(afterSplit.total)
  )
  ok(
    qtyAt() === shelfBefore - 4,
    'AND THE SHELF GAVE FOUR — the split raised the line from three to two-and-two, so one more went out',
    String(qtyAt())
  )
  /**
   * POSITIONS ARE RENUMBERED, and it matters more than it looks:
   * `invoice_stock_moves.line_position` is how a move finds its line, so two
   * lines sharing a position would have the stock land on whichever came back
   * from the database first.
   */
  const positions = afterSplit.lines.map((l: any) => l.position)
  ok(
    positions.join() === '0,1,2' ,
    'EVERY LINE IS RENUMBERED FROM ZERO, so no two share a position',
    positions.join()
  )
  const movePositions = db
    .prepare(
      `SELECT DISTINCT line_position AS p FROM invoice_stock_moves WHERE invoice_id = ? ORDER BY p`
    )
    .all(sale.id)
    .map((r: any) => r.p)
  ok(
    movePositions.every((p: number) => positions.includes(p)),
    'and every stock move points at a line that exists',
    movePositions.join()
  )
  ok(
    !!inv.setInvoiceLines(
      sale.id,
      [{ lineId: boxLine.id, splitInto: [{ quantity: 4, rate: 900 }] }],
      null
    ).error,
    'A SPLIT OF ONE PART IS REFUSED — that is just the line, set the price on it instead'
  )

  // --- 11. and the split clears the line's per-case sourcing ---------------
  /**
   * `allocationProblem` refuses slices that do not sum to the line, and it is
   * right to. Change the quantity and those rows describe a line that no longer
   * exists — and nothing could say which of the new cases were the dropship
   * ones, so they are deleted rather than scaled.
   */
  const sourced = inv.getInvoice(sale.id).lines.find((l: any) => l.productId === 'p_p')
  inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId: sourced.id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 1, destination: 'RM', sourcePoId: null },
          { quantity: 1, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(
    inv.getInvoice(sale.id).lines.find((l: any) => l.id === sourced.id).allocations.length === 2,
    'the line is split across two places on Fulfilled from'
  )
  ok(
    !inv.setInvoiceLines(sale.id, [{ lineId: sourced.id, quantity: 5 }], null).error,
    'and its quantity is then changed'
  )
  ok(
    inv.getInvoice(sale.id).lines.find((l: any) => l.id === sourced.id).allocations.length === 0,
    'A QUANTITY CHANGE CLEARS THE PER-CASE SOURCING — slices that must sum to the line cannot outlive it',
    String(inv.getInvoice(sale.id).lines.find((l: any) => l.id === sourced.id).allocations.length)
  )
  ok(
    inv.getInvoice(sale.id).lines.find((l: any) => l.id === sourced.id).destination === 'RM',
    'AND THE LINE FALLS BACK TO ITS OWN DESTINATION, the answer it had before anybody split it'
  )
  /**
   * BUT A PRICE CHANGE ALONE DOES NOT. The slices still sum to the line, so
   * throwing somebody's sourcing away because they corrected a dollar figure
   * would be gratuitous.
   */
  const keeper = inv.getInvoice(sale.id).lines.find((l: any) => l.rate === 850)
  inv.setInvoiceLineRouting(
    sale.id,
    [
      {
        lineId: keeper.id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 1, destination: 'RM', sourcePoId: null },
          { quantity: 1, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  ok(
    !inv.setInvoiceLines(sale.id, [{ lineId: keeper.id, rate: 800 }], null).error,
    'a price-only change on a split line is accepted'
  )
  ok(
    inv.getInvoice(sale.id).lines.find((l: any) => l.id === keeper.id).allocations.length === 2,
    'AND LEAVES THE SOURCING EXACTLY WHERE IT WAS — the slices still sum to the line',
    String(inv.getInvoice(sale.id).lines.find((l: any) => l.id === keeper.id).allocations.length)
  )

  // --- 12. removing a line, and the last one -------------------------------
  const before12 = inv.getInvoice(sale.id)
  const feeLine = before12.lines.find((l: any) => !l.productId)
  ok(
    !inv.setInvoiceLines(sale.id, [{ lineId: feeLine.id, remove: true }], null).error,
    'A LINE CAN BE TAKEN OFF — which is what makes a mis-typed split recoverable from the app'
  )
  const after12 = inv.getInvoice(sale.id)
  ok(
    after12.lines.length === before12.lines.length - 1 &&
      !after12.lines.some((l: any) => l.id === feeLine.id),
    'and it is the right one that went',
    String(after12.lines.length)
  )
  ok(
    after12.total === before12.total - 50,
    'the total drops by exactly that line',
    `${before12.total} -> ${after12.total}`
  )
  ok(
    after12.lines.map((l: any) => l.position).join() === '0,1',
    'AND THE SURVIVORS ARE RENUMBERED, leaving no gap for a stock move to fall into',
    after12.lines.map((l: any) => l.position).join()
  )
  /**
   * AND A REMOVED LINE TAKES ITS PER-CASE SOURCING WITH IT.
   *
   * `keeper` still carries the two slices set in section 11. Nothing would ever
   * READ rows belonging to a line id that no longer exists — `readLineAllocations`
   * keys them by line — so this leak is invisible from every screen, which is
   * exactly why it needs an assertion of its own: rows describing nothing would
   * sit in the table and sync between machines for ever.
   */
  const orphanBefore = db
    .prepare(`SELECT COUNT(*) AS n FROM invoice_line_allocations WHERE invoice_line_id = ?`)
    .get(keeper.id) as { n: number }
  ok(orphanBefore.n === 2, 'the line being removed has sourcing rows behind it', String(orphanBefore.n))
  ok(
    !inv.setInvoiceLines(sale.id, [{ lineId: keeper.id, remove: true }], null).error,
    'and it is removed'
  )
  const orphanAfter = db
    .prepare(`SELECT COUNT(*) AS n FROM invoice_line_allocations WHERE invoice_line_id = ?`)
    .get(keeper.id) as { n: number }
  ok(
    orphanAfter.n === 0,
    'A REMOVED LINE TAKES ITS SOURCING ROWS WITH IT — nothing reads them, so nothing would ever have noticed them piling up',
    String(orphanAfter.n)
  )
  // Read live rather than reusing `after12`: two lines have gone since, and a
  // change naming one of them would be refused for that instead — which would
  // have this assertion passing for the wrong reason.
  const left = inv.getInvoice(sale.id).lines
  const removeAll = inv.setInvoiceLines(
    sale.id,
    left.map((l: any) => ({ lineId: l.id, remove: true })),
    null
  )
  ok(
    !!removeAll.error && /at least one line/i.test(removeAll.error ?? ''),
    'THE LAST LINE CANNOT BE REMOVED — an order with no lines is not corrected, it is void',
    String(removeAll.error)
  )
  ok(
    inv.getInvoice(sale.id).lines.length === left.length,
    'and the refusal left every line where it was — one transaction, all or nothing',
    `${left.length} -> ${inv.getInvoice(sale.id).lines.length}`
  )

  // --- the history says all of it -----------------------------------------
  const said = soEvents(sale.id)
  ok(
    said.some((d) => /split into 2 at \$900\.00 and 2 at \$850\.00/.test(d)),
    'THE HISTORY NAMES THE SPLIT, part by part, in dollars',
    said.join(' | ')
  )
  ok(
    said.some((d) => /Priced Hobby Box: 4 → 6/.test(d)),
    'and the quantity, before and after',
    said.join(' | ')
  )
  ok(
    said.some((d) => /Grading fee: removed/.test(d)),
    'and what was taken off',
    said.join(' | ')
  )

  // --- and voiding still hands back exactly what is on the order ----------
  const owed = inv
    .getInvoice(sale.id)
    .lines.filter((l: any) => l.productId === 'p_p' && !l.dropship)
    .reduce((n: number, l: any) => n + l.qtyFulfilled, 0)
  inv.setInvoiceStatus(sale.id, 'void', null)
  ok(
    qtyAt() === shelfBefore,
    'VOIDING HANDS BACK EXACTLY WHAT THE ORDER HELD after all the editing, not what it first sold',
    `${qtyAt()} vs ${shelfBefore} (order held ${owed})`
  )
}


console.log('\n=== A SPLIT PART INHERITS WHERE ITS GOODS COME FROM ===')
// ---------------------------------------------------------------------------
/**
 * ON ITS OWN FIXTURES, and deliberately not folded into the block above.
 *
 * A null destination means "the order's location", so a part of an RM line that
 * inherited NOTHING would still read as RM and a test on that line would pass
 * while the code threw the answer away. Both sales here are routed somewhere the
 * header is not — one shipping direct, one taking a named purchase order's cases
 * — which is where inheriting and not inheriting actually differ.
 */
{
  /**
   * THE PART INHERITS THE PARENT'S ROUTING, and this is pinned on a DROPSHIP
   * parent rather than a shelf one.
   *
   * A null destination means "the order's location" — so a part of an RM line
   * that inherited nothing at all would still read as RM, and the assertion
   * would pass while the code was throwing the answer away. A parent shipping
   * direct from Kestrel is the case where inheriting and not inheriting differ:
   * lose it and the part silently falls back to the RM shelf and draws cases
   * this business never held.
   */
  const dropSale = inv.saveInvoice(
    {
      customerName: 'Split Dropship Buyer',
      invoiceNumber: 'SO-7201',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        {
          item: 'Priced Hobby Box',
          productId: 'p_p',
          quantity: 4,
          rate: 900,
          destination: 'Kestrel Cards'
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-7201' WHERE id = ?`).run(dropSale.id)
  const shelfAtDropSplit = qtyAt()
  const dropLine = inv.getInvoice(dropSale.id).lines[0]
  ok(
    !inv.setInvoiceLines(
      dropSale.id,
      [
        {
          lineId: dropLine.id,
          splitInto: [
            { quantity: 3, rate: 900 },
            { quantity: 1, rate: 700 }
          ]
        }
      ],
      null
    ).error,
    'a dropship line splits too'
  )
  const dropParts = inv.getInvoice(dropSale.id).lines
  ok(
    dropParts.length === 2 &&
      dropParts.every((l: any) => l.destination === 'Kestrel Cards' && l.dropship === true),
    'THE PART INHERITS THE PARENT’S ROUTING — the split was about price, and where the goods come from is a different question',
    dropParts.map((l: any) => `${l.destination}/${l.dropship}`).join(' ')
  )
  ok(
    dropParts.every((l: any) => l.supplier === dropLine.supplier),
    'and the supplier column is whatever the parent had, copied rather than re-derived',
    `${dropParts.map((l: any) => String(l.supplier)).join(' ')} vs ${String(dropLine.supplier)}`
  )
  ok(
    qtyAt() === shelfAtDropSplit,
    'AND NOT ONE UNIT MOVED — losing the inherited destination would have dropped the part onto the RM shelf and drawn cases this business never held',
    `${shelfAtDropSplit} -> ${qtyAt()}`
  )
  /**
   * AND THE SOURCE PURCHASE ORDER COMES WITH IT TOO — the half that costs
   * money. A part that lost its parent's `source_po_id` would walk ordinary
   * FIFO and be costed against whatever layer happened to be oldest.
   */
  const tabPo = require('../src/main/db/purchaseOrders').createPurchaseOrder(
    {
      supplier: 'Roadshow Tulsa',
      location: 'RM',
      lines: [{ productId: 'p_p', item: 'Priced Hobby Box', quantity: 6, unitPrice: 400 }]
    },
    null
  )
  require('../src/main/db/purchaseOrders').setPurchaseOrderStatus(tabPo.id, 'received', null)
  const sourcedSale = inv.saveInvoice(
    {
      customerName: 'Split Sourced Buyer',
      invoiceNumber: 'SO-7202',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [
        {
          item: 'Priced Hobby Box',
          productId: 'p_p',
          quantity: 4,
          rate: 900,
          sourcePoId: tabPo.id
        }
      ]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-7202' WHERE id = ?`).run(
    sourcedSale.id
  )
  const sourcedLine = inv.getInvoice(sourcedSale.id).lines[0]
  ok(sourcedLine.sourcePoId === tabPo.id, 'the sale is taking that order’s cases')
  ok(
    !inv.setInvoiceLines(
      sourcedSale.id,
      [
        {
          lineId: sourcedLine.id,
          splitInto: [
            { quantity: 3, rate: 900 },
            { quantity: 1, rate: 800 }
          ]
        }
      ],
      null
    ).error,
    'and it splits'
  )
  ok(
    inv.getInvoice(sourcedSale.id).lines.every((l: any) => l.sourcePoId === tabPo.id),
    'BOTH PARTS STILL TAKE THAT ORDER’S CASES — losing it would re-cost half the sale against whatever FIFO offered next',
    inv.getInvoice(sourcedSale.id).lines.map((l: any) => String(l.sourcePoId)).join(' ')
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
