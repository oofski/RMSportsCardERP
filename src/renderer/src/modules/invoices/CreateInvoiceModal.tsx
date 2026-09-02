import { useEffect, useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { Carrier, PaymentTiming } from '@shared/freight'
import { carrierLabel } from '@shared/freight'
import type {
  InvoiceAddress,
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTerms,
  NewInvoice,
  NewInvoiceLine
} from '@shared/invoices'
import {
  DEFAULT_INVOICE_TERMS,
  EMPTY_ADDRESS,
  INVOICE_STAGES,
  formatAddress,
  hasAddress,
  shipToAddress,
  shipsElsewhere,
  termsOptionsFor,
  dueDateFor,
  lineAmount,
  money,
  stockLineForProduct
} from '@shared/invoices'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { SALES_QTY_FLOOR, canStep, stepDownBlockedReason, stepQty } from '@shared/lineQty'
import { formatDate, formatMoney } from '../../lib/format'
import { describeLineSources, sourceName } from '@shared/lineSources'
import type { LineSources } from '@shared/lineSources'
import { FreightFields } from '../../components/FreightFields'
import { PaymentBar } from '../../components/PaymentProgress'
import { OrderHistory } from '../orders/OrderHistory'
import { OrderLabels } from '../orders/OrderLabels'
import { labelRecipientFor } from '@shared/orders'
import { OrderShipments } from '../orders/OrderShipments'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { DestinationSelect } from '../invoicing/PartySelect'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { POCatalogTypeahead } from '../invoicing/POCatalogTypeahead'
import { SourceOrderPicker } from './SourceOrderPicker'
import { StockOnHand } from './StockOnHand'
import { PickSourceModal } from './PickSourceModal'
import type { ShelfSlice } from '@shared/pickSource'
import { CustomerTypeahead } from './CustomerTypeahead'
import { QboReadiness } from './QboReadiness'
import { InvoiceStatusChip, formatDay } from './helpers'

/**
 * One invoice, in the shape of a purchase order.
 *
 * The owner pointed at the PO modal and said "this", so this is that, down to
 * the class names: the same header block with the number, the party and a
 * status chip; the same compact date strip; the same shipping fields with their
 * helper text and the same boxed PAYMENT pair; the same line rows with a
 * product name over its SKU; the same grand total; the same footer.
 *
 * ## Two faces, because the backend has two answers
 *
 * A DRAFT is a form. Anything past draft is a RECEIPT — read-only, laid out
 * exactly like `PurchaseOrderReceipt`. That is not a styling preference:
 * `saveInvoice` refuses any invoice that has already gone to QuickBooks, so the
 * editable form on a posted invoice was a screenful of inputs whose only
 * possible outcome was an error at the end. Showing what it says instead is the
 * honest version of the same screen.
 *
 * ## Every field QuickBooks needs, and no more
 *
 * Invoice number, customer, email, terms, invoice date, due date, location,
 * memo, message, class — Intuit's own import template, which is the definition
 * of "enough to create it over there". A field that is not on their template is
 * a field that cannot travel.
 *
 * ## Picking a buyer fills five things in
 *
 * Terms, email, location, class and their standing message. All are properties
 * of the RELATIONSHIP rather than of one sale, and every one stays editable —
 * the point of an agreed price is that this sale might be different.
 */

/** A working line. Quantity and prices are strings so the inputs stay
 *  controlled and empty-while-typing is allowed, exactly as the PO modal does. */
interface DraftLine {
  key: string
  /**
   * The catalog product this line came from. Empty for a line somebody typed
   * freehand, which stays legal — plenty of what gets billed here is a service
   * that was never stock. It is what the picker de-duplicates on, so an empty
   * one must never match another empty one; see `addLine`.
   */
  productId: string
  item: string
  sku: string
  /**
   * Shown beside the SKU while the line is being built. Not stored on the saved
   * line — `InvoiceLine` snapshots the name and SKU because those print on the
   * document, and a category does not — so it is blank on reopen rather than
   * fetched back, which would be a catalog read per line to decorate a subtitle.
   */
  category: string
  description: string
  quantity: string
  rate: string
  amount: string
  /** True once somebody types an amount that is not quantity × rate. */
  amountEdited: boolean
  /**
   * Where this line is fulfilled FROM. Empty means the order's location.
   *
   * The sell-side mirror of a purchase order line's destination. 'RM' or 'AM'
   * draws that shelf down; any other name is a DROPSHIP — the supplier sent it
   * straight to the buyer and no stock moves here.
   */
  destination: string
  /** Who shipped a dropshipped line. Empty means nobody has said. */
  supplier: string
  /**
   * WHICH PURCHASE ORDER'S CASES this line is selling. Empty is ordinary stock.
   *
   * Only ever set to an OPEN roadshow order that actually has some of this
   * product on the shelf — see @shared/poStock. Naming one makes the sale take
   * that order's cost layers rather than whatever is oldest, which is what lets
   * the week with that shop be costed against its own cases.
   */
  sourcePoId: string
  /**
   * THE LINE'S UNITS SPREAD ACROSS SHELVES, when somebody spread them.
   *
   * Empty on almost every line, which is the whole back-compat mechanism: no
   * rows means one implicit slice of the whole quantity at `destination`, which
   * is exactly what a line has always meant. See @shared/invoiceAllocations.
   */
  allocations: ShelfSlice[]
}

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Quantity × rate, unless somebody has taken the amount over.
 *
 * Pulled out of the change handler because the picker bumps a quantity too, and
 * a second copy of this rule there was how adding the same product twice left a
 * line whose amount still said one unit.
 */
function withAmount(line: DraftLine): DraftLine {
  if (line.amountEdited) return line
  const q = parseFloat(line.quantity)
  const r = parseFloat(line.rate)
  if (!Number.isFinite(q) || !Number.isFinite(r)) return line
  return { ...line, amount: String(lineAmount(q, r)) }
}

export function CreateInvoiceModal({
  invoice,
  prefill,
  onSavedInvoice,
  customers,
  nextNumber,
  thumbnails,
  onClose,
  onSaved,
  onDelete,
  onOpenQuickBooks
}: {
  /** Null for a new one; an existing invoice to open otherwise. */
  invoice: InvoiceDetail | null
  /**
   * A new order that arrives PART-FILLED, for the second screen of a dropship.
   *
   * Ignored entirely when `invoice` is set — an existing document has its own
   * values and a prefill on top of them would be a form quietly disagreeing with
   * what is stored. Every field remains editable; this only saves typing what
   * the purchase order already said.
   */
  prefill?: NewInvoice | null
  /**
   * What was saved, handed back so a caller can do something with it — the
   * dropship flow uses it to link the two halves. `onSaved` is still called for
   * the ordinary "reload the board" job, because most callers want only that.
   */
  onSavedInvoice?: (invoice: InvoiceDetail) => void | Promise<void>
  customers: InvoiceCustomer[]
  /** Suggested number for a new invoice, already fetched by the board. */
  nextNumber: string
  /** Catalog thumbnails by product id, loaded once by the board. */
  thumbnails: Record<string, string>
  onClose: () => void
  onSaved: () => void | Promise<void>
  /**
   * Ask to delete this invoice. Absent when there is nothing to delete yet (a
   * new invoice) — the board owns the confirmation, because it also owns the
   * list that has to lose a row afterwards.
   */
  onDelete?: (invoice: InvoiceDetail) => void
  onOpenQuickBooks: () => void
}): JSX.Element {
  const toast = useToast()

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber || nextNumber)
  const [customerId, setCustomerId] = useState(invoice?.customerId ?? '')
  const [customerName, setCustomerName] = useState(
    invoice?.customerName ?? prefill?.customerName ?? ''
  )
  const [email, setEmail] = useState(invoice?.email ?? '')
  const [terms, setTerms] = useState<InvoiceTerms>(invoice?.terms ?? DEFAULT_INVOICE_TERMS)
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? today())
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? dueDateFor(today(), DEFAULT_INVOICE_TERMS))
  const [location, setLocation] = useState(invoice?.location ?? '')
  const [className, setClassName] = useState(invoice?.className ?? '')
  const [memo, setMemo] = useState(invoice?.memo ?? '')
  const [message, setMessage] = useState(invoice?.message ?? '')
  /**
   * WHERE THE BOX GOES, which is not always where the bill goes.
   *
   * The floor's words: "the QBO invoice will have the customer's typical billing
   * address, but the SO must be referred to prior to making a label." Blank is
   * the ordinary state and means "the same place the bill goes" — `shipToAddress`
   * resolves that, so an untouched order behaves exactly as it did.
   */
  const [shipAddr, setShipAddr] = useState<InvoiceAddress>(
    invoice?.shipAddr ?? EMPTY_ADDRESS
  )
  const setShipPart = (k: keyof InvoiceAddress, v: string): void =>
    setShipAddr((prev) => ({ ...prev, [k]: v.trim() === '' ? null : v }))
  const [carrier, setCarrier] = useState<Carrier | null>(invoice?.carrier ?? null)
  const [service, setService] = useState<string | null>(invoice?.service ?? null)
  const [trackingNumber, setTrackingNumber] = useState<string | null>(
    invoice?.trackingNumber ?? null
  )
  /**
   * What POSTING it cost us — a cost we carry, not a charge to the buyer.
   *
   * Deliberately not in the invoice total and never sent to QuickBooks: adding
   * it to our copy and not Intuit's is how the two come to disagree about a
   * document somebody has already been sent.
   */
  const [shippingCost, setShippingCost] = useState(
    invoice?.shippingCost != null ? String(invoice.shippingCost) : ''
  )
  const [paymentTiming, setPaymentTiming] = useState<PaymentTiming | null>(
    invoice?.paymentTiming ?? null
  )
  // Defaults to allowed on a new order, and reads the saved answer on an
  // existing one. Never derived from the prefill: a dropship is billed the same
  // way as anything else, and quietly changing how a buyer may pay because the
  // goods came from a supplier would be a decision nobody made.
  /**
   * OFF ON A NEW ORDER. The owner's call: the card fee is a percentage, so
   * offering it is the decision worth making deliberately, not the one that
   * happens by not looking.
   *
   * An order being EDITED keeps its own answer — `getInvoice` always returns a
   * boolean, so the fallback below only ever fires for a new order, and nothing
   * raised before this change reopens with the box quietly unticked.
   */
  const [allowCreditCard, setAllowCreditCard] = useState(invoice?.allowCreditCard ?? false)
  const [lines, setLines] = useState<DraftLine[]>(() => {
    // A PREFILLED ORDER SEEDS ITS OWN LINES, and every one of them carries the
    // destination the purchase order implied. That destination is what makes
    // each line a dropship and stops it drawing stock off a shelf this business
    // never put the units on — see dropshipSaleFromPurchase, which is the one
    // place that rule is applied.
    if (!invoice && prefill) {
      return prefill.lines.map((l, i) => ({
        key: `pre_${i}`,
        productId: l.productId ?? '',
        item: l.item,
        sku: l.sku ?? '',
        category: '',
        description: l.description ?? '',
        quantity: String(l.quantity),
        rate: l.rate ? String(l.rate) : '',
        amount: l.rate ? String(lineAmount(l.quantity, l.rate)) : '',
        amountEdited: false,
        destination: l.destination ?? '',
        supplier: l.supplier ?? '',
        // A prefill comes from a DROPSHIP purchase, which is the other kind of
        // link entirely — those units never touched a shelf, so there is no
        // order's cases to sell out of.
        sourcePoId: '',
        allocations: []
      }))
    }
    return (invoice?.lines ?? []).map((l) => ({
      key: l.id,
      productId: l.productId ?? '',
      item: l.item,
      sku: l.sku ?? '',
      category: '',
      description: l.description ?? '',
      quantity: String(l.quantity),
      rate: String(l.rate),
      amount: String(l.amount),
      amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate),
      // Read back RESOLVED — `toLine` has already turned an inherited NULL into
      // the order's location — so the picker shows what the line actually says
      // rather than a blank that means "ask the header".
      destination: l.destination ?? '',
      supplier: l.supplier ?? '',
      // Read back so reopening an order shows which cases it sold, and re-saving
      // it does not quietly turn them into ordinary stock.
      sourcePoId: l.sourcePoId ?? '',
      allocations: []
    }))
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * Whether this screen is a form or a receipt.
   *
   * The condition is `saveInvoice`'s, not a guess: it throws on any invoice that
   * is no longer a draft, so anything else has to be shown rather than edited.
   */
  const editable = !invoice || invoice.status === 'draft'

  /** Choosing a saved buyer takes everything the relationship already knows. */
  const pick = (c: InvoiceCustomer): void => {
    setCustomerId(c.id)
    setCustomerName(c.name)
    setEmail(c.email ?? '')
    setTerms(c.terms)
    setDueDate(dueDateFor(invoiceDate, c.terms))
    setLocation(c.location ?? '')
    setClassName(c.className ?? '')
    if (c.message) setMessage(c.message)
    // The buyer's usual ship-to comes across with them. Only when THIS order has
    // none typed yet: picking the buyer again after correcting an address must
    // not throw the correction away.
    if (hasAddress(c.shipAddr) && !hasAddress(shipAddr)) setShipAddr(c.shipAddr as InvoiceAddress)
  }

  /** Typing over the name detaches it from the saved record — otherwise a
   *  one-off "Chris Smith: Job A" would rename the buyer on the next save. */
  const typeName = (name: string): void => {
    setCustomerName(name)
    setCustomerId('')
  }

  const setTermsAndDue = (t: InvoiceTerms): void => {
    setTerms(t)
    setDueDate(dueDateFor(invoiceDate, t))
  }

  const setDateAndDue = (d: string): void => {
    setInvoiceDate(d)
    setDueDate(dueDateFor(d, terms))
  }

  /**
   * Append a catalog pick, exactly as `CreatePurchaseOrderModal` does it: the
   * product's own name, SKU and category come across, the sale price is offered
   * as the rate, and picking something already on the invoice bumps its
   * quantity rather than opening a second row for the same box.
   *
   * The SKU is the point of the change. Before this the picker put a NAME on
   * the line and dropped everything else, so two products filed a word apart
   * were indistinguishable on the finished document — which is the whole reason
   * the PO rows carry a SKU under the name.
   */
  /**
   * Add a product, or add one to the line that is already selling it THE SAME
   * WAY.
   *
   * ## Why "the same way" is the whole rule
   *
   * One order can sell the same product from two different places at once. A
   * dropship of three cases straight from the supplier, plus two off our own
   * shelf, is one sale to one buyer — and it is two lines, because the two
   * halves are fulfilled differently and only one of them draws stock.
   * `saveInvoice` already decides that per LINE, and the backend has always
   * handled it.
   *
   * The screen did not. Picking a product that was already on the order bumped
   * the quantity of whatever line held it, so on a dropship-prefilled order the
   * only way to add two from stock was to turn three dropshipped cases into
   * five — invoicing the buyer correctly by accident while drawing no stock at
   * all, and leaving the shelf up for units that had been sold.
   *
   * So a pick merges only into a line fulfilled the way the NEW line would be:
   * from our own shelf. A dropship line is never absorbed, which is what makes
   * the second line possible at all. `destinationHoldsStock` is the same test
   * the save path uses, so the screen and the stock engine cannot disagree
   * about which lines are which.
   *
   * Merging targets ONE line by key rather than every line with that product.
   * The old rule mapped across all of them, so once an order legitimately held
   * two lines of a product, a single pick added one to BOTH.
   */
  /**
   * The product somebody just clicked in the search, waiting to be sized and
   * sourced. Null the rest of the time. See PickSourceModal.
   */
  const [picking, setPicking] = useState<InventoryProduct | null>(null)

  const addLine = (
    p: InventoryProduct,
    choice?: { quantity: number; location: string; allocations?: ShelfSlice[] }
  ): void => {
    const wanted = Math.max(1, Math.round(choice?.quantity ?? 1))
    const where = choice?.location ?? ''
    const split = choice?.allocations ?? []
    setLines((prev) => {
      // Only a real id counts as "already here". Saved lines carry an empty one
      // and would otherwise all collapse onto whichever was picked first.
      //
      // A SPLIT IS NEVER MERGED INTO AN EXISTING LINE. Merging adds to the
      // quantity, and the shelves the operator just chose would go with the
      // discarded half — the line would claim more units than its slices place.
      // Two lines of the same product is already legal here, and a second line
      // saying what it says is better than one line quietly saying less.
      const mergeInto = split.length > 0 ? null : stockLineForProduct(prev, p.id ?? '', location)
      if (mergeInto) {
        return prev.map((l) =>
          l.key === mergeInto.key
            ? withAmount({ ...l, quantity: String((parseFloat(l.quantity) || 0) + wanted) })
            : l
        )
      }
      return [
        ...prev,
        withAmount({
          key: `${p.id}-${prev.length}-${p.sku ?? ''}`,
          productId: p.id,
          item: p.name,
          sku: p.sku ?? '',
          category: p.category ?? '',
          description: '',
          quantity: String(wanted),
          // The catalog's sale price is OFFERED. It is a starting point, not the
          // deal — which is why the amount stops following it the moment
          // somebody types over either field.
          rate: p.salePrice ? String(p.salePrice) : '',
          amount: '',
          amountEdited: false,
          // Empty inherits the order's location, which is what nearly every line
          // wants — and is exactly what the picker sends back when somebody
          // leaves it on the order's own shelf. Somebody drop-shipping, or
          // selling out of a roadshow shop, has already chosen by now.
          destination: where,
          supplier: '',
          // ORDINARY STOCK until somebody says otherwise. A line that names no
          // order walks FIFO exactly as every sale always has.
          sourcePoId: '',
          allocations: split
        })
      ]
    })
  }

  const patch = (key: string, next: Partial<DraftLine>): void => {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const merged = { ...l, ...next }
        // Quantity and rate recompute the amount only while nobody has taken it
        // over. Once they have, it is the agreed price and this form stops
        // arguing with the person who made the deal.
        return 'quantity' in next || 'rate' in next ? withAmount(merged) : merged
      })
    )
  }

  const total = useMemo(
    () => money(lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0)),
    [lines]
  )

  const build = (): Parameters<typeof api.invoices.save>[0] => ({
    id: invoice?.id ?? null,
    invoiceNumber: invoiceNumber.trim() || null,
    customerId: customerId || null,
    customerName: customerName.trim(),
    email: email.trim() || null,
    terms,
    invoiceDate,
    dueDate,
    location: location.trim() || null,
    // Sent as null when nothing was typed, so the stored columns stay empty and
    // shipToAddress goes on falling back to the bill-to. An empty shell would
    // make every order claim a ship-to it was never given.
    shipAddr: hasAddress(shipAddr) ? shipAddr : null,
    memo: memo.trim() || null,
    message: message.trim() || null,
    sendLater: false,
    className: className.trim() || null,
    carrier,
    service: service?.trim() || null,
    trackingNumber: trackingNumber?.trim() || null,
    paymentTiming,
    allowCreditCard,
    shippingCost: shippingCost.trim() === '' ? null : parseFloat(shippingCost),
    // productId and sku travel with every line. They are what makes the SKU
    // under a product name survive a reload — and what lets the posting code
    // match a QuickBooks Item on its SKU before falling back to a name somebody
    // may have edited over there.
    lines: lines.map((l): NewInvoiceLine => {
      /**
       * THE SUPPLIER IS DERIVED FROM WHERE THE LINE IS FULFILLED FROM.
       *
       * There is no Supplier column on this form any more — on a sales order it
       * asked the same question as Fulfilled from and got the same answer, and
       * `dropshipSaleFromPurchase` has always written both fields to the same
       * party for exactly that reason.
       *
       * The COLUMN still exists and is still written, because `dropshipSuppliersOf`
       * reads it to work out who to raise a purchase order against when a
       * dropship sale is billed before it is bought. Dropping the field as well
       * as the column would have broken that flow silently — it would have found
       * no supplier on any line and refused to prefill anything.
       *
       * NULL on a line off our own shelf. Those goods came from stock; naming a
       * supplier on them would offer to buy what we already own.
       */
      const from = (l.destination || location || 'RM').trim()
      const shipsItself = destinationHoldsStock(from)
      return {
        item: l.item,
        productId: l.productId || null,
        sourcePoId: l.sourcePoId || null,
        sku: l.sku || null,
        description: l.description || null,
        quantity: parseFloat(l.quantity) || 0,
        rate: parseFloat(l.rate) || 0,
        amount: parseFloat(l.amount) || 0,
        taxRate: null,
        className: null,
        destination: l.destination || null,
        // A supplier the operator already typed on a saved line is kept — it may
        // name a party the destination does not, on a line entered before this
        // column went away.
        supplier: shipsItself ? null : l.supplier || from,
        // Empty on an ordinary line, so `saveInvoice` writes no allocation rows
        // and the sale behaves byte for byte as it did before splitting existed.
        allocations: l.allocations.map((a) => ({ location: a.location, quantity: a.quantity }))
      }
    })
  })

  /** Validate here so the message names the line, not just "something is wrong". */
  const check = (): string => {
    if (!customerName.trim()) return 'Pick a buyer, or type who this is for.'
    if (lines.length === 0) return 'Add at least one thing they are buying.'
    for (const l of lines) {
      const q = parseFloat(l.quantity)
      if (!Number.isFinite(q) || q <= 0) return `Quantity for ${l.item} must be above zero.`
      const r = parseFloat(l.rate)
      if (l.rate.trim() !== '' && (!Number.isFinite(r) || r < 0)) {
        return `Rate for ${l.item} must be 0 or more.`
      }
    }
    if (dueDate < invoiceDate) return 'The due date cannot be before the invoice date.'
    return ''
  }

  const save = async (): Promise<InvoiceDetail | null> => {
    const problem = check()
    if (problem) {
      setError(problem)
      return null
    }
    setError('')
    // SAVE PUTS IT ON THE BOOKS. There is no separate "send to QuickBooks"
    // step any more — the document exists in both places or the reason is on
    // screen.
    //
    // The result shape is the load-bearing part: a QuickBooks failure comes
    // back as ok:true with pushed:false, because the invoice IS saved and only
    // the push has to be retried. Reading that as a failed save would tell
    // somebody their work was lost while it sat on disk, and they would type
    // it again.
    const res = await api.invoices.saveAndPush(build())
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Could not save the invoice.')
      return null
    }
    if (!res.data.pushed) {
      // Saved locally, not in QuickBooks. Said out loud rather than swallowed:
      // an invoice that only exists here will not be on the books, and the
      // board's retry is the way out.
      toast.error(
        res.data.error
          ? `Saved here, but QuickBooks refused it: ${res.data.error}`
          : 'Saved here, but it did not reach QuickBooks. Retry it from the invoice card.'
      )
    } else if (
      // THE NUMBER MOVED BEFORE IT EVER LEFT THIS APP. saveInvoice claims the
      // number inside its transaction, so a value this form pre-filled can turn
      // out to be taken — by an order raised at another bench, or by the
      // dropship step, which fetches its own suggestion independently. Saying
      // nothing would leave somebody looking at a board row that disagrees with
      // the form they just filled in.
      invoiceNumber.trim() &&
      res.data.invoice.invoiceNumber &&
      res.data.invoice.invoiceNumber !== invoiceNumber.trim()
    ) {
      toast.success(
        `${invoiceNumber.trim()} was already taken, so this order is ${res.data.invoice.invoiceNumber}.`
      )
    } else if (res.data.numberChanged) {
      // QuickBooks assigns its own document numbers and will not always take
      // ours. Silently keeping the old one on screen means the number in the
      // app and the number the buyer receives disagree.
      toast.success(`Sent to QuickBooks as invoice ${res.data.docNumber}.`)
    }
    for (const note of res.data.notes ?? []) toast.error(note)
    // Handed to the caller BEFORE the modal closes, so a flow that has more to
    // do with this order — linking a dropship pair, say — acts on the document
    // that was actually written rather than on the draft that was submitted.
    if (onSavedInvoice) await onSavedInvoice(res.data.invoice)
    return res.data.invoice
  }

  /**
   * Save and close. The only Save there is.
   *
   * It was "Save draft" beside a "PDF" that also saved, which read as three
   * ways out of one form and hid which of them was the ordinary one. The PDF
   * lives on the board card now, where it can be reached without opening
   * anything.
   */
  const saveIt = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await save()
      if (!saved) return
      await onSaved()
      toast.success(`Saved invoice ${saved.invoiceNumber || ''}.`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Save, post, then open the browser on it.
   *
   * Saving first is not a convenience: QuickBooks is sent what is in the
   * DATABASE, so posting without saving would bill somebody for the previous
   * version of the invoice on screen.
   */
  const createInQbo = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await save()
      if (!saved) return
      const res = await api.invoices.createInQbo(saved.id)
      if (!res.ok) {
        // The draft IS saved by this point, which is the useful half — say so,
        // or somebody retypes an invoice already sitting in the list.
        await onSaved()
        const why = res.error ?? 'QuickBooks would not take that.'
        setError(`${why} The draft is saved.`)
        // "Not connected" is the one failure with an obvious next step.
        if (/not connected|reconnect|consent|client id/i.test(why)) {
          onClose()
          onOpenQuickBooks()
        }
        return
      }
      await onSaved()
      toast.success(
        res.data?.numberChanged
          ? `Created in QuickBooks as ${res.data.docNumber} — it renumbered ours. Opening it now.`
          : 'Created in QuickBooks. Opening it now — press Send there.'
      )
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Delete is offered only where it can succeed.
   *
   * `deleteInvoice` refuses anything with a QuickBooks id — deleting it here
   * would leave the invoice in the accounts with nothing on this side — and the
   * PO board settled the same question the same way: a button whose only
   * outcome is a refusal teaches the operator that delete is broken rather than
   * that this invoice is posted. Void it in QuickBooks instead.
   */
  const deletable = invoice !== null && onDelete !== undefined && !invoice.qboId

  return (
    <Modal
      title={
        invoice ? `Invoice ${invoice.qboDocNumber || invoice.invoiceNumber || ''}` : 'New invoice'
      }
      subtitle={
        editable
          ? 'Pick a buyer, add what they bought, and set the price you agreed.'
          : // Not "already in QuickBooks": an invoice settled in cash goes
            // draft → paid without ever being posted, and is just as uneditable.
            `${invoice?.customerName ?? ''} · no longer a draft, so this is a record rather than a form`
      }
      onClose={onClose}
      wide
      // THE SAME WIDTH AS A PURCHASE ORDER, and for the same stated reason.
      // At .modal-lg's 620px the money columns were squeezed to three characters
      // and the description had to be exiled under the product name. The two
      // documents are mirror images and are entered by the same person on the
      // same afternoon; they should not be two different shapes.
      className="modal-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </Button>
          {deletable && (
            <Button
              variant="danger"
              icon="Trash2"
              disabled={busy}
              onClick={() => onDelete?.(invoice)}
            >
              Delete
            </Button>
          )}
          {editable && (
            <>
              <Button variant="secondary" icon="Save" loading={busy} onClick={saveIt}>
                Save
              </Button>
              <Button
                variant="primary"
                icon="ReceiptText"
                loading={busy}
                disabled={lines.length === 0}
                onClick={createInQbo}
              >
                Create in QuickBooks
              </Button>
            </>
          )}
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      {/* Fed from the LIVE fields, not from `invoice`. A header sourced from the
          saved record kept showing the buyer and dates the invoice had when it
          was opened, so retyping the buyer left the top of the modal naming
          somebody else until the form was saved and reopened. */}
      <InvoiceHead
        number={invoice?.qboDocNumber || invoiceNumber}
        customerName={customerName}
        invoiceDate={invoiceDate}
        dueDate={dueDate}
        location={location}
        status={invoice?.status ?? 'draft'}
      />

      {editable ? (
        <>
          {/* ---- Who, and on what terms --------------------------------- */}
          <CustomerTypeahead
            customers={customers}
            value={customerName}
            onPick={pick}
            onType={typeName}
          />

          <div className="field-row">
            <Field label="Email" hint="Where QuickBooks sends it">
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="buyer@example.com"
              />
            </Field>
            <Field label="Terms" hint="Sets the due date">
              <Select value={terms} onChange={(e) => setTermsAndDue(e.target.value as InvoiceTerms)}>
                {termsOptionsFor(invoice?.terms).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Invoice number" hint="Yours, unless QuickBooks renumbers it">
              <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            </Field>
          </div>

          <div className="field-row">
            <Field label="Invoice date" hint="The day it was billed">
              <Input
                type="date"
                value={invoiceDate}
                onChange={(e) => setDateAndDue(e.target.value)}
              />
            </Field>
            <Field label="Due date" hint="From the terms — change it if you agreed something else">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
            <Field label="Location" hint="Optional">
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. West"
              />
            </Field>
          </div>

          {/* ---- WHERE THE BOX GOES ---------------------------------------
              Beside the freight fields, not beside the buyer: this is a fact
              about the parcel, and the address the buyer is BILLED at already
              travels to QuickBooks without anybody typing it here.

              Blank is the ordinary state and the hint says what blank means, so
              nobody fills it in defensively on an order that ships where it
              bills — which is nearly all of them. */}
          <div className="field-row">
            <Field
              label="Ship to — street"
              hint="Leave blank if it goes to the billing address"
            >
              <Input
                value={shipAddr.line1 ?? ''}
                onChange={(e) => setShipPart('line1', e.target.value)}
                placeholder="123 Main St"
              />
            </Field>
            <Field label="Apt / suite" hint="Optional">
              <Input
                value={shipAddr.line2 ?? ''}
                onChange={(e) => setShipPart('line2', e.target.value)}
              />
            </Field>
          </div>
          <div className="field-row">
            <Field label="City">
              <Input
                value={shipAddr.city ?? ''}
                onChange={(e) => setShipPart('city', e.target.value)}
              />
            </Field>
            <Field label="State">
              <Input
                value={shipAddr.region ?? ''}
                onChange={(e) => setShipPart('region', e.target.value)}
                placeholder="TX"
              />
            </Field>
            <Field label="ZIP">
              <Input
                value={shipAddr.postalCode ?? ''}
                onChange={(e) => setShipPart('postalCode', e.target.value)}
              />
            </Field>
          </div>

          {/* ---- How it gets there, and when it gets paid for ------------- */}
          <FreightFields
            carrier={carrier}
            service={service}
            trackingNumber={trackingNumber}
            paymentTiming={paymentTiming}
            hint="Who is taking it to them"
            onChange={(p) => {
              if ('carrier' in p) setCarrier(p.carrier ?? null)
              if ('service' in p) setService(p.service ?? null)
              if ('trackingNumber' in p) setTrackingNumber(p.trackingNumber ?? null)
              if ('paymentTiming' in p) setPaymentTiming(p.paymentTiming ?? null)
            }}
          />

          {/* ---- How the buyer is allowed to pay -------------------------- */}
          {/* BESIDE the payment box, not inside FreightFields: that component is
              shared with purchase orders, and how a BUYER may pay has no meaning
              on an order where we are the ones paying.

              Card fees are a percentage, so they scale with the invoice — noise
              on a single box, real money on a wholesale case order. That is the
              split this business bills across, which is why it is per order. */}
          <Checkbox
            checked={allowCreditCard}
            onChange={setAllowCreditCard}
            label="Allow payment by credit card"
            /* The unticked wording is the one most people will read now that it
               is the default, so it says what IS happening rather than what has
               been turned off — an order that was never going to offer a card
               has not had anything withdrawn from it. */
            hint={
              allowCreditCard
                ? 'QuickBooks shows this buyer a Pay-by-card button, and the card fee comes with it.'
                : 'Bank transfer and anything arranged off-invoice. Tick it to let this buyer pay by card.'
            }
          />

          {/* WHAT POSTING IT COST US — a cost, not a charge.
              It is not in the total above and never goes to QuickBooks: adding
              it to our copy and not Intuit's is how the two come to disagree
              about a document somebody has already been sent. Leave it empty and
              the parcels answer instead; see orderShippingCost. */}
          <Field
            label="Shipping cost"
            hint="What postage cost US — not billed to the buyer, and not sent to QuickBooks"
          >
            <Input
              value={shippingCost}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => setShippingCost(e.target.value)}
            />
          </Field>

          {/* ---- What they are buying ------------------------------------ */}
          {/* CLICK A RESULT AND SAY HOW MANY AND FROM WHERE, in one step.
              Adding straight to the table put a line of 1 on the order pointed
              at whatever the header said, which is right almost every time and
              silently wrong the moment the stock is somewhere else — and fixing
              it afterwards meant finding a dropdown three columns away that
              never said which shelf had any. See PickSourceModal. */}
          <POCatalogTypeahead onSelect={setPicking} />

          {lines.length === 0 ? (
            <div className="po-lines-empty">
              No line items yet — search your inventory above to add products.
            </div>
          ) : (
            <div className="po-lines">
              {/* `po-lines-so` is not styling — it is what tells the phone layer
                  WHICH of the two routed tables this is. Both carry
                  po-lines-routed and they no longer have the same number of
                  columns: a purchase order line names a supplier AND a
                  destination, a sales order line names only where it is
                  fulfilled from. mobile.css hides routing columns BY POSITION,
                  so without this the sales form would lose its Remove button on
                  a phone — column 6 there is the bin, and column 6 on a purchase
                  order is the destination. */}
              <table className="data po-lines-table po-lines-routed po-lines-so">
                {/* THE SAME COLGROUP AS A PURCHASE ORDER. Fixed widths declared
                    once, product takes the slack — without it the money columns
                    were sized by whatever text happened to be in them, so typing
                    a longer supplier name shoved the rate field sideways and
                    every row re-flowed under the cursor. */}
                <colgroup>
                  <col />
                  <col className="po-col-qty" />
                  <col className="po-col-price" />
                  <col className="po-col-total" />
                  <col className="po-col-dest" />
                  <col className="po-col-remove" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Rate</th>
                    <th className="num">Amount</th>
                    {/* "Fulfilled from", not "Destination". On a purchase order
                        the column is where the goods GO; on a sales order they
                        always go to the buyer, so the open question is where they
                        COME FROM — our shelf, or a supplier who ships direct.

                        AND IT IS THE ONLY ROUTING COLUMN HERE, where a purchase
                        order has two. On a PO the supplier and the destination
                        are different parties answering different questions — who
                        we buy from, and where it goes. On a SALES order they
                        collapse: the goods always go to the buyer, so a line
                        naming anything but a shelf here is already saying which
                        party ships it, and a Supplier column beside it asked the
                        same question twice. It was answered twice too — see
                        `build`, which fills the stored supplier from this. */}
                    <th>Fulfilled from</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const from = l.destination || location || 'RM'
                    // DERIVED from where it comes from, exactly as the buy side
                    // derives it. A stored flag would be a second truth that
                    // drifts the first time a line is re-routed.
                    const drop = !destinationHoldsStock(from)
                    return (
                    <tr key={l.key}>
                      <td>
                        <div className="po-line-name">{l.item}</div>
                        {(l.sku || l.category) && (
                          <div className="po-line-sub">
                            {l.sku && <span className="mono">{l.sku}</span>}
                            {l.sku && l.category && <span> · </span>}
                            {l.category && <span>{l.category}</span>}
                          </div>
                        )}
                        {/* Description sits UNDER the name rather than in a
                            column of its own. Six columns inside a 620px modal
                            squeezed the money to three characters wide, and the
                            description is the one field on the row that is
                            usually empty. */}
                        <Input
                          value={l.description}
                          placeholder="Description (optional)"
                          className="inv-line-desc"
                          onChange={(e) => patch(l.key, { description: e.target.value })}
                        />
                        {/* WHICH CASES. Renders nothing at all unless an open
                            roadshow order actually holds some of this product
                            on this shelf, which is almost never — so an
                            ordinary line is exactly what it always was. A
                            DROPSHIPPED line never gets it either: those units
                            went supplier-to-buyer and never sat on a shelf, so
                            there is no order's stock to sell out of. */}
                        {/* HOW MANY WE HAVE AND WHERE, but only when the number
                            typed is more than is downstairs. "I have 4 in RM
                            and I need 7" is the case this exists for, and the
                            answer names the shop holding the other three. Silent
                            on every line the shelf covers, which is almost all
                            of them. See StockOnHand. */}
                        {l.productId && (
                          <StockOnHand
                            productId={l.productId}
                            quantity={parseFloat(l.quantity) || 0}
                            location={from}
                          />
                        )}
                      </td>
                      {/* `data-label` is what the phone prints above the field
                          once the heading row is gone — see mobile.css. It is
                          on the markup rather than generated from an nth-child
                          in CSS so the words a person reads live where the rest
                          of this form's words live. */}
                      <td className="num" data-label="Qty">
                        {/* The box stays for "make it 40"; the arrows are for
                            the change somebody actually makes, and the one that
                            is fiddly to type on a phone. Down stops at one —
                            below one is not a smaller sale, it is no sale, and
                            the bin at the end of the row is what does that. */}
                        <span className="inv-qty-step">
                          <button
                            type="button"
                            className="po-rl-step"
                            aria-label="One fewer"
                            title={
                              stepDownBlockedReason(
                                parseFloat(l.quantity) || 0,
                                SALES_QTY_FLOOR,
                                0
                              ) ?? 'One fewer'
                            }
                            disabled={
                              !canStep(parseFloat(l.quantity) || 0, -1, SALES_QTY_FLOOR)
                            }
                            onClick={() =>
                              patch(l.key, {
                                quantity: String(
                                  stepQty(parseFloat(l.quantity) || 0, -1, SALES_QTY_FLOOR)
                                )
                              })
                            }
                          >
                            <Icon name="Minus" size={12} />
                          </button>
                          <Input
                            value={l.quantity}
                            inputMode="decimal"
                            className="po-qty-input"
                            onChange={(e) => patch(l.key, { quantity: e.target.value })}
                          />
                          <button
                            type="button"
                            className="po-rl-step"
                            aria-label="One more"
                            title="One more"
                            onClick={() =>
                              patch(l.key, {
                                quantity: String(
                                  stepQty(parseFloat(l.quantity) || 0, 1, SALES_QTY_FLOOR)
                                )
                              })
                            }
                          >
                            <Icon name="Plus" size={12} />
                          </button>
                        </span>
                      </td>
                      <td className="num" data-label="Rate">
                        <Input
                          value={l.rate}
                          inputMode="decimal"
                          placeholder="0.00"
                          className="po-price-input"
                          onChange={(e) => patch(l.key, { rate: e.target.value })}
                        />
                      </td>
                      <td className="num" data-label="Amount">
                        <Input
                          value={l.amount}
                          inputMode="decimal"
                          placeholder="0.00"
                          className="po-price-input"
                          title={
                            l.amountEdited
                              ? `Agreed price — quantity × rate would be ${formatMoney(
                                  lineAmount(parseFloat(l.quantity) || 0, parseFloat(l.rate) || 0)
                                )}`
                              : undefined
                          }
                          onChange={(e) =>
                            patch(l.key, { amount: e.target.value, amountEdited: true })
                          }
                        />
                      </td>
                      {/* Inheritance-first, the same as a purchase order's: the
                          opening option IS "same as the order", it is what a new
                          line is set to, and choosing it stores NULL rather than
                          a copy of the header. Muted while inherited, solid once
                          overridden — readable down the column without opening a
                          row. */}
                      <td data-label="Fulfilled from">
                        <DestinationSelect
                          className={`po-route-party${l.destination ? '' : ' is-inherited'}`}
                          ariaLabel={`Fulfilled from, for ${l.item}`}
                          value={l.destination || null}
                          blankLabel={`Same as order (${location || 'RM'})`}
                          drop={drop}
                          onChange={(d) => patch(l.key, { destination: d ?? '' })}
                        />
                        {/* WHICH CASES, directly under WHERE FROM.
                            
                            These are one question in two halves — the place,
                            and then which of that place's cases — and they used
                            to sit at opposite ends of the row: a "Sell from"
                            dropdown tucked under the product name, and
                            "Fulfilled from" three columns away. Two dropdowns
                            that far apart read as two competing answers to
                            "where does this come from", which is exactly how
                            the owner read them.

                            It still renders nothing at all unless an open
                            roadshow order actually holds some of this product
                            on this shelf, which is almost never, and never on a
                            dropshipped line — those units went
                            supplier-to-buyer and never sat on a shelf, so there
                            is no order's stock to sell out of. */}
                        {l.productId && !drop && (
                          <SourceOrderPicker
                            productId={l.productId}
                            productName={l.item}
                            location={from}
                            quantity={parseFloat(l.quantity) || 0}
                            value={l.sourcePoId}
                            onChange={(poId) => patch(l.key, { sourcePoId: poId })}
                          />
                        )}
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          title="Remove line"
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="po-total">
                <span>Grand total</span>
                <span className="mono">{formatMoney(total)}</span>
              </div>
            </div>
          )}

          {/* Directly under the lines, because that is what it is about. The
              refusal it predicts used to arrive after Save as a toast, by which
              point the invoice existed here and not there. */}
          <QboReadiness
            customerName={customerName}
            lines={lines}
            email={email}
            onOpenQuickBooks={() => {
              onClose()
              onOpenQuickBooks()
            }}
          />

          {/* ---- What it says -------------------------------------------- */}
          <div className="field-row">
            <Field label="Message on the invoice" hint="The buyer sees this">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="e.g. Thank you for your business!"
              />
            </Field>
            <Field label="Memo" hint="Internal — never shown to them">
              <Input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="e.g. Paid half up front"
              />
            </Field>
            <Field label="Class" hint="Optional, for QuickBooks">
              <Input
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                placeholder="e.g. Class A:Subclass B"
              />
            </Field>
          </div>
        </>
      ) : (
        invoice && <InvoiceReceipt invoice={invoice} thumbnails={thumbnails} />
      )}

      {/* Sits inside the form's own dialog rather than beside it, so closing
          the order closes this with it and there is never a picker left
          floating over a screen its product no longer belongs to. */}
      {picking && (
        <PickSourceModal
          product={picking}
          defaultLocation={location || 'RM'}
          onCancel={() => setPicking(null)}
          onAdd={(choice) => {
            addLine(picking, choice)
            setPicking(null)
          }}
        />
      )}
    </Modal>
  )
}

/**
 * The header every invoice gets, form or receipt: the number, who owes, when it
 * was billed and when it falls due, and where it has got to.
 *
 * Same block as `po-receipt-head` — number large and monospaced, party under
 * it, dates under that, status chip pinned right — because a person who has
 * opened a PO should recognise this before reading a word of it.
 */
function InvoiceHead({
  number,
  customerName,
  invoiceDate,
  dueDate,
  location,
  status
}: {
  number: string
  customerName: string
  invoiceDate: string
  dueDate: string
  location: string
  status: InvoiceStatus
}): JSX.Element {
  return (
    <div className="po-receipt-head">
      <div className="po-rh-left">
        <div className="po-rh-num mono">{number || 'No number'}</div>
        {/* Says so rather than collapsing to nothing: an empty line here reads
            as a rendering fault, and "who is this for" is the one question a
            brand-new invoice most needs asked. */}
        <div className="po-rh-supplier">{customerName || 'No buyer yet'}</div>
        <div className="po-rh-date">
          {formatDay(invoiceDate)} · due {formatDay(dueDate)}
          {location ? ` · ${location}` : ''}
        </div>
      </div>
      <InvoiceStatusChip status={status} />
    </div>
  )
}

/**
 * A posted invoice as a document: the date strip, how it travels, the lines
 * with a thumbnail and a SKU under each name, and the grand total.
 *
 * Deliberately the same markup as `PurchaseOrderReceipt` rather than a
 * lookalike — the grid that lines those five columns up lives in `.po-receipt-*`
 * and a second copy of it would drift the first time a column moved.
 */
/**
 * What POSTING this sale cost us, corrected on the document itself.
 *
 * ## Why it has to be editable here
 *
 * It was reachable from exactly one place — the invoice form — and that form is
 * refused the moment an order posts, correctly: this app is not the system of
 * record for a document a buyer has been billed against. But postage is bought
 * when the PARCEL goes, which is always after that. So the one cost on a sales
 * order that cannot be known at draft time was the one cost only a draft could
 * record, and every real postage figure had nowhere to land.
 *
 * ## Why it is safe where a line edit is not
 *
 * This is not on the buyer's invoice. It is deliberately absent from the order
 * total and never sent to Intuit, so unlike a price correction it cannot leave
 * our copy of a posted document disagreeing with QuickBooks' — which is the
 * whole reason EditOrderModal has to announce itself. Nothing here touches a
 * line, a stock move or a cost lot.
 *
 * ## Empty is not zero
 *
 * With nothing typed the per-parcel label costs answer instead, so the box says
 * so rather than showing $0.00 — see orderShippingCost, where a typed figure
 * wins and the parcels are the fallback. Printing a zero here would be this
 * screen quietly asserting that a parcel went for free.
 */
function SalePostageEditor({ invoice }: { invoice: InvoiceDetail }): JSX.Element | null {
  const toast = useToast()
  const [saved, setSaved] = useState<number | null>(invoice.shippingCost ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(invoice.shippingCost != null ? String(invoice.shippingCost) : '')
  const [busy, setBusy] = useState(false)

  // A void order keeps whatever was recorded and offers no way to move it —
  // the repository refuses, and a button that is always refused is worse than
  // no button. Absent entirely when there is also nothing to show.
  const editable = invoice.status !== 'void'
  if (!editable && saved === null) return null

  const save = async (): Promise<void> => {
    const raw = draft.trim()
    const next = raw === '' ? null : Number(raw)
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      toast.error('Postage has to be a number, and not a negative one.')
      return
    }
    if (next === saved) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      const res = await api.invoices.setShippingCost(invoice.id, next)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not save the postage cost.')
        return
      }
      setSaved(res.data.shippingCost ?? null)
      setEditing(false)
      toast.success(next === null ? 'Postage cost cleared.' : 'Postage cost saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`po-money-row po-money-ship so-postage${editing ? ' is-editing' : ''}`}>
      <span>
        Postage cost
        {/* Said every time, not on hover. This figure sitting under a grand
            total is exactly the place somebody could mistake a cost for a
            charge, and the sentence that prevents it costs one line. */}
        <em className="so-postage-note">what it cost us — not billed to the buyer</em>
      </span>
      {editing ? (
        <div className="po-ship-form">
          <Input
            value={draft}
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Postage cost"
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') {
                setDraft(saved != null ? String(saved) : '')
                setEditing(false)
              }
            }}
          />
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(saved != null ? String(saved) : '')
              setEditing(false)
            }}
          >
            Cancel
          </Button>
        </div>
      ) : editable ? (
        <button
          type="button"
          className={`po-ship-edit${saved === null ? ' is-empty' : ''}`}
          title="Click to record what postage cost"
          onClick={() => {
            setDraft(saved != null ? String(saved) : '')
            setEditing(true)
          }}
        >
          <span className="mono">{saved === null ? 'From parcel labels' : formatMoney(saved)}</span>
          <Icon name="Pencil" size={11} />
        </button>
      ) : (
        <span className="mono">{formatMoney(saved ?? 0)}</span>
      )}
    </div>
  )
}

function InvoiceReceipt({
  invoice,
  thumbnails
}: {
  invoice: InvoiceDetail
  thumbnails: Record<string, string>
}): JSX.Element {
  // WHERE EACH LINE'S UNITS CAME FROM, fetched once for the whole order rather
  // than per line: one query answers every row, and a fetch per line on an order
  // with twenty of them is twenty round trips for one popover nobody may open.
  // A failure degrades to no hover at all, which is the honest outcome — an
  // empty popover would claim the line drew nothing.
  const [sources, setSources] = useState<Map<number, LineSources>>(new Map())
  useEffect(() => {
    let live = true
    void api.invoices
      .lineSources(invoice.id)
      .then((rows) => {
        if (live) setSources(new Map(rows.map((r) => [r.position, r])))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [invoice.id])

  const shipsWith = [carrierLabel(invoice.carrier), invoice.service].filter(Boolean).join(' · ')
  // The buyer on a stock sale, the supplier on a dropship — see labelRecipientFor
  // for why the buyer is not the fallback when a dropship's supplier is unknown.
  const labelRecipient = labelRecipientFor(invoice)
  // The order's own ship-to when it has one, the bill-to otherwise. One rule,
  // asked once — see shipToAddress for why no screen decides this for itself.
  const shipTo = shipToAddress(invoice)

  return (
    <div className="po-receipt">
      {/* WHICH DEAL THIS BELONGS TO — the mirror of the same line on the
          purchase receipt. The register can fold several documents under one
          number, and until now that was only visible from Finance. The number
          shown is the GROUP's when it has one, because that is the number
          somebody writes on paperwork; printing its own retired one would send
          them looking for a ticket the register no longer lists. */}
      {invoice.dealTicket && (
        <div className="dt-line">
          <Icon name="Hash" size={13} />
          <span className="mono">{invoice.dealTicket}</span>
          <span>
            {invoice.dealTicketMerged
              ? 'Deal ticket — shared with other documents'
              : 'Deal ticket'}
          </span>
        </div>
      )}

      {/* WHERE THE BOX GOES, on the receipt a packer actually opens.
          
          The whole point of the ship-to: "the SO must be referred to prior to
          making a label." A posted sales order is a record rather than a form,
          so this is the only place the address can be READ on one — and it has
          to be here, or the packer is back to hunting for it in an email.
          
          shipToAddress resolves the fallback, so an order that ships where it
          bills shows the billing address rather than nothing. `shipsElsewhere`
          only badges the ones that genuinely differ, because a "ships elsewhere"
          note on every order is a note nobody reads. */}
      {shipTo && (
        <div className="so-shipto">
          <div className="so-shipto-head">
            <Icon name="Truck" size={14} />
            <span>Ship to</span>
            {shipsElsewhere(invoice) && (
              <span className="so-shipto-flag">not the billing address</span>
            )}
          </div>
          <div className="so-shipto-body">
            <div className="so-shipto-name">{invoice.customerName}</div>
            {formatAddress(shipTo)
              .split('\n')
              .map((line, i) => (
                <div key={i}>{line}</div>
              ))}
          </div>
        </div>
      )}

      <div className="po-receipt-timeline">
        <TimeRow icon="ReceiptText" label="Invoiced" value={formatDay(invoice.invoiceDate)} />
        <TimeRow icon="CalendarClock" label="Due" value={formatDay(invoice.dueDate)} />
        {/* QuickBooks' day beats our instant when there is one. `qboPaidAt` is
            Payment.TxnDate — the calendar day the money is dated in the books,
            so formatDay — while `paidAt` is the instant somebody here ticked
            the box, which is often days later and is the wrong answer to "when
            was this paid". */}
        <TimeRow
          icon="DollarSign"
          label="Paid"
          value={
            invoice.qboPaidAt
              ? formatDay(invoice.qboPaidAt)
              : invoice.paidAt
                ? formatDate(invoice.paidAt)
                : '—'
          }
        />
      </div>

      {/* SHOWN ONLY WHEN CARD WAS OFFERED, which is the exception now that the
          box starts unticked. The rule is unchanged — print the rare answer,
          not the common one — but the two answers have swapped places, and a
          warning triangle reading "no card button" on almost every receipt
          would be crying wolf about the normal case.

          It stays useful on the back catalogue for the opposite reason: every
          invoice raised before this default flipped DID offer a card, and this
          line is what explains a card fee against one of them. */}
      {invoice.allowCreditCard === true && (
        <p className="inv-card-ok">
          <Icon name="CreditCard" size={13} />
          <span>
            This buyer was <b>offered payment by card</b>, so QuickBooks showed a Pay-by-card
            button and its fee applies.
          </span>
        </p>
      )}

      {/* How much of it has actually been collected, on the same rail the buy
          side draws a part-received shipment with. Absent entirely until
          QuickBooks has said something — see PaymentBar. */}
      <PaymentBar invoice={invoice} className="po-ship-recv" />

      {/* Shipping is READ-ONLY here, which is a gap rather than a decision: the
          buy side can edit a PO's carrier from its receipt because
          api.purchaseOrders.setFreight exists, and there is no invoice
          equivalent yet. A tracking number typically arrives after the invoice
          has been sent, so this is exactly where it would be typed. */}
      {(shipsWith || invoice.trackingNumber) && (
        <div className="po-receipt-timeline">
          <TimeRow icon="Truck" label="Ships with" value={shipsWith || '—'} />
          <TimeRow icon="Hash" label="Tracking" value={invoice.trackingNumber || '—'} mono />
        </div>
      )}

      {invoice.message && <div className="po-receipt-notes">{invoice.message}</div>}

      <div className="po-receipt-lines">
        <div className="po-receipt-line po-receipt-line-head">
          <span className="po-rl-img" aria-hidden="true" />
          <span className="po-rl-name">Product</span>
          <span className="po-rl-qty">Qty</span>
          <span className="po-rl-price">Rate</span>
          <span className="po-rl-total">Amount</span>
        </div>
        {invoice.lines.map((line) => (
          <ReceiptLine
            key={line.id}
            line={line}
            thumbnails={thumbnails}
            sources={sources.get(line.position)}
          />
        ))}
      </div>

      <div className="po-money">
        <div className="po-grand-total">
          <span>Grand total</span>
          <span className="mono">{formatMoney(invoice.total)}</span>
        </div>
        {/* BELOW the total, and outside it, because that is what it is.
            On a purchase order freight joins the total — the supplier is
            charging us for it. On a sale it is the opposite: postage is a cost
            WE carry, it is not on the buyer's invoice and it never goes to
            QuickBooks. Putting it in the same stack as the items, the way the
            buy-side receipt does, would read as a line the buyer is paying,
            which is the one thing this figure must never look like. */}
        <SalePostageEditor invoice={invoice} />
      </div>

      {/* The same three panels the buy side carries, in the same order and at
          the same place. A purchase order and a sales order are mirror images
          and somebody who has read one receipt should not have to learn the
          other. */}
      <OrderShipments
        side="so"
        orderId={invoice.id}
        canEdit={invoice.status !== 'void'}
        lines={invoice.lines.map((l) => ({ id: l.id, label: l.item, quantity: l.quantity }))}
      />
      {/* WHO THE LABEL GOES TO, and on a dropship it is NOT the buyer.

          This used to hand down the buyer's address on every sale, with a
          comment saying "on a dropship the label usually goes to the SUPPLIER
          instead" — which described the problem rather than fixing it. The
          supplier has the boxes; a label emailed to the buyer reaches somebody
          who cannot put it on anything.

          The buyer's own address is not offered as a fallback on a dropship,
          deliberately. Falling back to it would put the wrong party in the To
          box whenever the supplier is not in the directory, which is the exact
          case where nobody is expecting an address to appear. An empty box asks
          a question; a plausible wrong one does not. */}
      <OrderLabels
        side="so"
        orderId={invoice.id}
        defaultTo={labelRecipient.email}
        lookupName={labelRecipient.name}
        recipientNote={labelRecipient.note}
        canEdit={invoice.status !== 'void'}
      />
      <OrderHistory side="so" orderId={invoice.id} stageLabel={invoiceStageLabel} />
    </div>
  )
}

/**
 * How this board names a stage, for the history log.
 *
 * Its own translation rather than one shared with purchase orders: 'sent' means
 * something here and nothing there, and an id with no entry prints itself so a
 * stage renamed after an event was written still reads.
 */
function invoiceStageLabel(id: string): string {
  return INVOICE_STAGES.find((s) => s.id === id)?.label ?? (id === 'void' ? 'Void' : id)
}

function TimeRow({
  icon,
  label,
  value,
  mono
}: {
  icon: string
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="po-rt-row">
      <Icon name={icon} size={14} />
      <span className="po-rt-label">{label}</span>
      <span className={`po-rt-date${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}

function ReceiptLine({
  line,
  thumbnails,
  sources
}: {
  line: InvoiceLine
  thumbnails: Record<string, string>
  /** Which cost layers this line drew, if it drew any. */
  sources?: LineSources
}): JSX.Element {
  const thumb = line.productId ? thumbnails[line.productId] : undefined

  return (
    <div className="po-receipt-line">
      <span className="po-rl-img po-line-img">
        {/* A line typed freehand has no product and so no picture. The category
            glyph is the same fallback the PO receipt uses, and an empty
            category resolves to its generic boxes mark — a filled cell keeps
            the five columns aligned where a missing one would not. */}
        {thumb ? <img src={thumb} alt={line.item} /> : <CategoryLogo category="" size={34} />}
      </span>
      <span className="po-rl-name">
        <span className="po-rl-pname">{line.item}</span>
        {line.sku && <span className="po-rl-sku mono">{line.sku}</span>}
        {line.description && <span className="po-line-sub">{line.description}</span>}
      </span>
      {/* THE QUANTITY IS THE HANDLE, because it is the number somebody is
          questioning: "three cases — three cases of what, from where?".
          A button rather than a hovered span so it answers to the keyboard and
          to a finger as well as to a mouse; the popover shows on hover AND on
          focus, in CSS, so nothing here depends on a pointer existing. */}
      <span className="po-rl-qty">
        {sources ? (
          <button type="button" className="src-handle" aria-label={`Where these ${line.quantity} came from`}>
            {line.quantity}
            <LineSourcePop sources={sources} />
          </button>
        ) : (
          line.quantity
        )}
      </span>
      <span className="po-rl-price mono">{formatMoney(line.rate)}</span>
      <span className="po-rl-total mono">{formatMoney(line.amount)}</span>
    </div>
  )
}

/**
 * Where one line's units came from.
 *
 * Rendered ALWAYS and revealed by CSS rather than mounted on hover: a popover
 * that mounts on mouseover flickers when the pointer crosses its own edge, and
 * the amount of markup here is trivial next to the shipping panels already on
 * this screen.
 */
function LineSourcePop({ sources }: { sources: LineSources }): JSX.Element {
  return (
    <span className="src-pop" role="tooltip">
      <span className="src-pop-head">{describeLineSources(sources)}</span>
      {sources.sources.map((s, i) => (
        <span className="src-pop-row" key={`${s.poId ?? 'none'}-${i}`}>
          <span className="src-pop-name">{sourceName(s)}</span>
          <span className="src-pop-meta mono">
            {s.quantity} @ {formatMoney(s.unitCost)}
          </span>
          <span className="src-pop-where">
            {s.location}
            {/* Said only when it was a decision. FIFO running unasked is the
                default and does not need announcing on every row. */}
            {s.picked ? ' · picked' : ''}
            {s.supplier && !s.poNumber ? ` · ${s.supplier}` : ''}
          </span>
        </span>
      ))}
    </span>
  )
}
