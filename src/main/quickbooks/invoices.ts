import type { InvoiceAddress, InvoiceDetail, QboItemMatch } from '@shared/invoices'
import { qboInvoiceUrl, resolveLineItemRef, toQboInvoice } from '@shared/invoices'
import { qboRequest } from './client'
import { getQboConfig } from './store'
import {
  RM_CLASS_NAME,
  resolveClassPlacement,
  resolveInvoiceClass,
  resolveTermRef
} from './invoiceRefs'

/**
 * Posting an invoice to QuickBooks, and the lookups that make it possible.
 *
 * This is the ONLY file in the app that writes an invoice to somebody's books,
 * and it is written to fail loudly and early rather than half-succeed. An
 * invoice either goes over whole or does not go at all: there is no partial
 * post, no retry loop that could double it, and nothing that swallows an error
 * and leaves our copy claiming a document that is not there.
 *
 * ## Why the lookups exist
 *
 * QuickBooks does not accept names. A CustomerRef, an ItemRef, a SalesTermRef
 * and a ClassRef are ids from the connected company, and a payload built from
 * what somebody typed here would be rejected in a way whose error message
 * ("Invalid Reference Id") says nothing about which field was wrong. So the
 * buyer, every line item, the terms and the class are resolved to real ids
 * first, and an item that does not exist is reported by NAME before anything is
 * sent.
 *
 * ## What is REQUIRED and what is merely wanted
 *
 * The customer and the items are required: without them there is no invoice to
 * post, so a miss is an error and nothing goes. The terms and the class are
 * wanted: a miss omits the field and records a NOTE, because an invoice on the
 * company's default terms is a small visible problem and an invoice carrying an
 * id this app invented is an invisible one that surfaces at year end.
 */

interface QueryResponse<T> {
  QueryResponse?: Record<string, T[] | number | undefined>
}

const PAGE = 1000

async function queryAll<T>(entity: string, where = ''): Promise<T[]> {
  const out: T[] = []
  let start = 1
  for (;;) {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ''} startposition ${start} maxresults ${PAGE}`
    const body = await qboRequest<QueryResponse<T>>({ path: 'query', query: { query: sql } })
    const page = (body.QueryResponse?.[entity] as T[] | undefined) ?? []
    out.push(...page)
    if (page.length < PAGE) return out
    start += page.length
  }
}

export interface QboCustomerRef {
  id: string
  name: string
  email: string | null
  /**
   * Their bill-to, as QuickBooks holds it.
   *
   * Carried so the posted invoice can be given the SAME address their own form
   * would fill in. QuickBooks does default it from the customer when BillAddr is
   * omitted — but "usually the same" is not the same, and the point of this work
   * is that what this app sends matches what their screen shows.
   */
  billAddr: InvoiceAddress | null
}

export interface QboItemRef {
  id: string
  name: string
  /** The list price, so the editor can offer it rather than make somebody type it. */
  rate: number | null
  description: string | null
  /**
   * Item.Sku — the field the SKU column on a printed invoice is read from.
   *
   * There is NO SKU field on an invoice line: SalesItemLineDetail carries
   * ItemRef, ClassRef, TaxCodeRef, MarkupInfo, ItemAccountRef, ServiceDate, Qty,
   * UnitPrice, TaxClassificationRef, TaxInclusiveAmt, DiscountAmt and
   * DiscountRate, and that is the whole list. So the only way to get the right
   * SKU onto an invoice is to point the line at the right ITEM, which is why
   * this comes back and why the match is made on it first.
   */
  sku: string | null
}

interface RawAddress {
  Line1?: string
  Line2?: string
  City?: string
  CountrySubDivisionCode?: string
  PostalCode?: string
  Country?: string
}

interface RawCustomer {
  Id?: string
  DisplayName?: string
  Active?: boolean
  PrimaryEmailAddr?: { Address?: string }
  BillAddr?: RawAddress
}

interface RawItem {
  Id?: string
  Name?: string
  FullyQualifiedName?: string
  Active?: boolean
  Type?: string
  UnitPrice?: number
  Description?: string
  Sku?: string
}

function fromRawAddress(a: RawAddress | undefined): InvoiceAddress | null {
  if (!a) return null
  const pick = (v: string | undefined): string | null => {
    const s = (v ?? '').trim()
    return s === '' ? null : s
  }
  const addr: InvoiceAddress = {
    line1: pick(a.Line1),
    line2: pick(a.Line2),
    city: pick(a.City),
    region: pick(a.CountrySubDivisionCode),
    postalCode: pick(a.PostalCode),
    country: pick(a.Country)
  }
  return Object.values(addr).some((v) => v !== null) ? addr : null
}

/** Everybody this company can invoice. */
export async function fetchQboCustomers(): Promise<QboCustomerRef[]> {
  const rows = await queryAll<RawCustomer>('Customer', 'Active = true')
  return rows
    .filter((c) => c.Id && c.DisplayName)
    .map((c) => ({
      id: String(c.Id),
      name: String(c.DisplayName),
      email: c.PrimaryEmailAddr?.Address ?? null,
      billAddr: fromRawAddress(c.BillAddr)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Everything sellable.
 *
 * FullyQualifiedName rather than Name, because a sub-item's plain name is not
 * unique — two parents can each have a "Design" — and the name is what the
 * operator picks from and what the payload falls back to matching on.
 */
export async function fetchQboItems(): Promise<QboItemRef[]> {
  const rows = await queryAll<RawItem>('Item', 'Active = true')
  return rows
    .filter((i) => i.Id && (i.FullyQualifiedName || i.Name))
    .map((i) => ({
      id: String(i.Id),
      name: String(i.FullyQualifiedName || i.Name),
      rate: typeof i.UnitPrice === 'number' ? i.UnitPrice : null,
      description: i.Description ?? null,
      sku: (i.Sku ?? '').trim() || null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The two lookup maps a payload is built against.
 *
 * Both keyed lowercased. The SKU map DROPS duplicates rather than letting a
 * later item win: a company with the same SKU on two items has an ambiguity this
 * app cannot resolve, and picking one silently would attach a line to whichever
 * happened to sort second. Falling back to the name match in that case is at
 * least a rule somebody can predict.
 */
function itemLookups(items: QboItemRef[]): {
  byName: Map<string, QboItemMatch>
  bySku: Map<string, QboItemMatch>
} {
  const byName = new Map<string, QboItemMatch>()
  const bySku = new Map<string, QboItemMatch>()
  const ambiguous = new Set<string>()
  for (const i of items) {
    const match: QboItemMatch = { id: i.id, name: i.name, sku: i.sku }
    byName.set(i.name.trim().toLowerCase(), match)
    const sku = (i.sku ?? '').trim().toLowerCase()
    if (!sku) continue
    if (bySku.has(sku)) ambiguous.add(sku)
    bySku.set(sku, match)
  }
  for (const sku of ambiguous) bySku.delete(sku)
  return { byName, bySku }
}

export interface QboInvoiceResult {
  qboId: string
  docNumber: string | null
  /** Where to send the browser so somebody can look at it and press Send. */
  url: string
  /** True when the number QuickBooks used is not the one we asked for. */
  numberChanged: boolean
  /**
   * Everything that was WANTED and could not be resolved, in plain sentences.
   *
   * The invoice posted — these are not errors. They exist so an omission has a
   * voice: an invoice that quietly went up with no class on it looks identical
   * to one that went up correctly, and the difference only shows at year end
   * when somebody runs a report by class and the numbers are short.
   */
  notes: string[]
}

interface RawInvoiceResponse {
  Invoice?: { Id?: string; DocNumber?: string }
}

/**
 * Create the invoice in QuickBooks and hand back where to find it.
 *
 * ## The buyer
 *
 * Matched on the name we hold, case-insensitively, against the live customer
 * list. NOT created automatically when it is missing: adding a customer to
 * somebody's accounting system as a side effect of raising an invoice is a
 * write nobody asked for, and a misspelling would leave a duplicate contact
 * behind for ever. A clear "add them in QuickBooks first" is the honest answer.
 *
 * ## The number
 *
 * QuickBooks silently replaces DocNumber unless the company has "Custom
 * transaction numbers" switched on — which is exactly what Intuit's own import
 * template warns about. So whatever comes BACK is recorded, and `numberChanged`
 * lets the screen say so rather than leaving two different numbers in two
 * systems for somebody to discover later.
 */
export async function createQboInvoice(invoice: InvoiceDetail): Promise<QboInvoiceResult> {
  if (invoice.qboId) {
    throw new Error('That invoice is already in QuickBooks.')
  }

  const wanted = invoice.customerName.trim().toLowerCase()
  const customers = await fetchQboCustomers()
  const customer = customers.find((c) => c.name.trim().toLowerCase() === wanted)
  if (!customer) {
    throw new Error(
      `QuickBooks has no customer called “${invoice.customerName}”. Add them in QuickBooks ` +
        'first, or export the CSV and import it instead.'
    )
  }

  const items = await fetchQboItems()
  const { byName, bySku } = itemLookups(items)

  const notes: string[] = []

  // The class, the terms and where a class goes. All three are WANTED rather
  // than required, so each is asked for independently and a failure contributes
  // a note instead of stopping the invoice.
  const [klass, placement, term] = await Promise.all([
    resolveInvoiceClass(),
    resolveClassPlacement(),
    resolveTermRef(invoice.terms)
  ])
  if (klass.reason) notes.push(klass.reason)
  if (term.reason) notes.push(term.reason)
  if (klass.ref && placement === 'none') {
    notes.push(
      `Class tracking is switched off in QuickBooks, so the “${RM_CLASS_NAME}” class was not ` +
        'put on this invoice. Turn on Settings → Advanced → Categories → Track classes.'
    )
  }

  // A line that matched an item by NAME whose SKU disagrees with ours is the one
  // case worth saying out loud. The invoice is fine and posts against the item
  // the name found — but the SKU printed on it will be QuickBooks', not ours,
  // and somebody reconciling the two lists later needs to know which won.
  for (const line of invoice.lines) {
    const ours = (line.sku ?? '').trim()
    if (!ours) continue
    const ref = resolveLineItemRef(line, byName, bySku)
    const theirs = (ref?.sku ?? '').trim()
    if (ref && theirs && theirs.toLowerCase() !== ours.toLowerCase()) {
      notes.push(
        `“${line.item}” is SKU ${ours} here and ${theirs} in QuickBooks. The invoice will show ` +
          `${theirs}, because the SKU on an invoice belongs to the QuickBooks item.`
      )
    } else if (ref && !theirs) {
      notes.push(
        `The QuickBooks item for “${line.item}” has no SKU, so SKU ${ours} will not appear on ` +
          'the invoice. Set it on the item in QuickBooks.'
      )
    }
  }

  // Throws, by name, on any line QuickBooks could not resolve — before a single
  // byte is posted. Half an invoice is not a useful thing to have created.
  const payload = toQboInvoice(invoice, { id: customer.id, name: customer.name }, byName, {
    termRef: term.ref,
    classRef: klass.ref,
    classOn: placement,
    itemsBySku: bySku,
    // The buyer's QuickBooks record is the fallback for both, used only when the
    // invoice carries nothing of its own — which is what their form does when
    // you pick a customer, and the reason the posted document matches the screen.
    billAddr: customer.billAddr,
    billEmail: customer.email
  })

  const res = await qboRequest<RawInvoiceResponse>({
    method: 'POST',
    path: 'invoice',
    body: payload
  })

  const qboId = res.Invoice?.Id
  if (!qboId) {
    throw new Error('QuickBooks accepted the invoice but did not say what it was called.')
  }
  const docNumber = res.Invoice?.DocNumber ?? null

  const config = getQboConfig()
  return {
    qboId: String(qboId),
    docNumber,
    url: qboInvoiceUrl(config?.environment ?? 'production', String(qboId)),
    numberChanged: !!invoice.invoiceNumber && !!docNumber && docNumber !== invoice.invoiceNumber,
    notes
  }
}

/**
 * Ask QuickBooks to email the invoice.
 *
 * Separate from creating it on purpose. "Create" and "send" are two decisions —
 * somebody may want to look at it first, which is why the browser opens on it —
 * and folding them together would mean a mistyped price reaches the buyer
 * before anybody has seen the document.
 */
export async function sendQboInvoice(qboId: string, email?: string | null): Promise<void> {
  await qboRequest({
    method: 'POST',
    path: `invoice/${encodeURIComponent(qboId)}/send`,
    ...(email ? { query: { sendTo: email } } : {})
  })
}
