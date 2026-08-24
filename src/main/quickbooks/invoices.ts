import type {
  InvoiceAddress,
  InvoiceDetail,
  QboInvoicePreflight,
  QboItemMatch
} from '@shared/invoices'
import {
  missingQboItems,
  qboInvoiceUrl,
  skuReconciliation,
  toQboCustomerPayload,
  toQboInvoice,
  toQboItemPayload
} from '@shared/invoices'
import { activeRealmId, qboRequest, qboUpload } from './client'
import { buildInvoiceHtml } from '../invoicePdf'
import { renderDocumentForExport } from '../poPdf'
import { getAccountMap } from './mapping'
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

/**
 * Everything an invoice names, looked up against the live company at once.
 *
 * EXTRACTED SO THERE IS ONE ANSWER. The pre-flight panel and the post itself
 * both ask this, so "ready to send" and "actually sent" cannot come apart —
 * which they would within a month if the check re-implemented the matching, and
 * the failure would be the worst kind: a green tick followed by a refusal.
 *
 * The two sweeps run TOGETHER. They are independent queries against different
 * entities, and running them in series — which is what this did when only the
 * post needed them — made every invoice wait for the customer list before it
 * even asked for the items. Now that somebody sits and watches this run while
 * typing, that wait is in front of a person rather than behind a button.
 */
export interface QboInvoiceTargets {
  /** The matched buyer, or null when the company has nobody by that name. */
  customer: QboCustomerRef | null
  byName: Map<string, QboItemMatch>
  bySku: Map<string, QboItemMatch>
  /** Lines with nowhere to point. Empty means the post would not be refused. */
  missingItems: ReturnType<typeof missingQboItems>
  /** SKU disagreements — never blockers, always worth saying. */
  skuNotes: string[]
  /** The blank-SKU subset of those, each fixable in one press. */
  skuFixes: ReturnType<typeof skuReconciliation>['fixes']
}

export async function resolveQboInvoiceTargets(invoice: {
  customerName: string
  lines: readonly { item: string; sku?: string | null }[]
}): Promise<QboInvoiceTargets> {
  const [customers, items] = await Promise.all([fetchQboCustomers(), fetchQboItems()])

  const wanted = invoice.customerName.trim().toLowerCase()
  const customer = customers.find((c) => c.name.trim().toLowerCase() === wanted) ?? null
  const { byName, bySku } = itemLookups(items)

  // What the SKUs say about the items behind them. One shared function, so the
  // sentence shown before the send and the note recorded after it agree.
  const { notes: skuNotes, fixes: skuFixes } = skuReconciliation(invoice.lines, byName, bySku)

  return {
    customer,
    byName,
    bySku,
    missingItems: missingQboItems(invoice.lines, byName, bySku),
    skuNotes,
    skuFixes
  }
}

/**
 * Would QuickBooks take this invoice? Asked while it is still being written.
 *
 * READS ONLY. Two queries, no writes, nothing recorded — safe to run on every
 * edit, and safe to run against live books by somebody who has not decided to
 * send anything yet.
 *
 * This exists because the refusal it predicts used to arrive at the worst
 * possible moment: after Save, from a button labelled "Send to QuickBooks", by
 * which point the invoice is on the books here and the operator is looking at a
 * toast about a product name. The information was always knowable before the
 * press. Now it is shown there.
 */
export async function preflightQboInvoice(invoice: {
  customerName: string
  lines: readonly { item: string; sku?: string | null }[]
}): Promise<QboInvoicePreflight> {
  const targets = await resolveQboInvoiceTargets(invoice)
  const realmId = activeRealmId()
  return {
    ready: !!targets.customer && targets.missingItems.length === 0,
    customerName: invoice.customerName,
    customerFound: !!targets.customer,
    missingItems: targets.missingItems,
    // The one slot createQboItem needs. Read here so the panel can say it
    // before offering a button that cannot work — see QboInvoicePreflight.
    canAddItems: !!(realmId && (getAccountMap(realmId).salesIncome ?? '').trim()),
    notes: targets.skuNotes,
    skuFixes: targets.skuFixes
  }
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

  // The same lookup the pre-flight panel runs, so a screen that said "ready"
  // and a post that refuses cannot disagree about what is in the company.
  const { customer, byName, bySku, skuNotes } = await resolveQboInvoiceTargets(invoice)
  if (!customer) {
    throw new Error(
      `QuickBooks has no customer called “${invoice.customerName}”. Add them in QuickBooks ` +
        'first, or export the CSV and import it instead.'
    )
  }

  const notes: string[] = [...skuNotes]

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

// ---------------------------------------------------------------------------
// Creating what is missing
//
// THE RULE THIS DOES NOT BREAK. `createQboInvoice` still refuses to invent a
// customer or an item as a SIDE EFFECT of posting — see its doc comment, and the
// reason stands: a misspelling that quietly becomes a permanent contact in
// somebody's accounting system is a mess no error message can undo.
//
// What changed is that "add it in QuickBooks first" now has a button, and the
// button is a SEPARATE, DELIBERATE press with the name it is about to create
// written on it. That is a different act from a send that silently creates six
// items nobody reviewed. The distinction is the whole design here, so anything
// added later must keep it: no creation from inside a post.
// ---------------------------------------------------------------------------

/**
 * Add a Product/Service, so the next send resolves instead of refusing.
 *
 * ## NonInventory, deliberately
 *
 * QuickBooks would also take `Inventory`, and it is the wrong choice here. An
 * Inventory item makes QuickBooks track quantity on hand and value it — a job
 * this app already does, against FIFO cost lots, per location. Two systems
 * counting the same boxes disagree the first time one of them is not told
 * something, and the one people would then trust is the accounting system,
 * which has never seen a break. `Inventory` also demands an asset account and
 * an inventory start date, which is a decision about somebody's balance sheet
 * that a button beside an invoice line has no business making.
 *
 * NonInventory sells exactly the same on an invoice. It just does not pretend to
 * know where the stock is.
 *
 * ## The income account is NOT guessed
 *
 * Same rule as everywhere else in this integration: an account id this app
 * invented posts real revenue somewhere nobody chose. It comes from the
 * operator's own mapping, and when that is unset the answer is a sentence saying
 * where to set it — not a plausible-looking Income account picked off the list.
 */
export async function createQboItem(input: {
  name: string
  sku?: string | null
  rate?: number | null
  description?: string | null
}): Promise<QboItemRef> {
  const realmId = activeRealmId()
  // Throws by name on a blank one. The mapping screen is where that is chosen,
  // and the message says so — nothing here picks an Income account.
  const body = toQboItemPayload({
    ...input,
    incomeAccountId: (realmId ? getAccountMap(realmId).salesIncome : '') ?? ''
  })

  const res = await qboRequest<{ Item?: RawItem }>({ method: 'POST', path: 'item', body })

  const created = res.Item
  if (!created?.Id) {
    throw new Error('QuickBooks created the item but did not say what its id is.')
  }
  return {
    id: String(created.Id),
    name: String(created.FullyQualifiedName || created.Name || input.name.trim()),
    rate: typeof created.UnitPrice === 'number' ? created.UnitPrice : null,
    description: created.Description ?? null,
    sku: (created.Sku ?? '').trim() || null
  }
}

/**
 * Give an existing Product/Service the SKU we hold for it.
 *
 * ## Why this is a separate press and not part of posting
 *
 * It edits a record in somebody's accounting system. The rule this integration
 * runs on is that posting an invoice never changes anything else as a side
 * effect, and "it is only a blank field" is exactly the reasoning that ends with
 * a send quietly rewriting six items nobody looked at.
 *
 * ## Sparse, and with the CURRENT SyncToken
 *
 * A full update would blank every field not sent — name, price, income account,
 * the lot. `sparse: true` changes only what is named. The SyncToken is
 * QuickBooks' optimistic-lock version and it moves every time anything touches
 * the item, including edits made over there, so it is read immediately before
 * the write rather than cached and hoped over. A stale one is refused outright,
 * which is the correct outcome — it means somebody else changed the item since
 * this screen last looked.
 *
 * The caller only ever offers this for an item whose SKU is BLANK; see
 * skuReconciliation for why a disagreement gets a sentence instead of a button.
 */
export async function setQboItemSku(itemId: string, sku: string): Promise<QboItemRef> {
  const id = (itemId ?? '').trim()
  // Interpolated into a path, so it is checked rather than trusted.
  if (!/^[0-9]+$/.test(id)) throw new Error('That is not a QuickBooks item id.')
  const value = (sku ?? '').trim()
  if (!value) throw new Error('There is no SKU to set.')

  const read = await qboRequest<{ Item?: RawItem & { SyncToken?: string } }>({
    path: `item/${id}`
  })
  const current = read?.Item
  if (!current?.Id) throw new Error('That item is no longer in QuickBooks.')
  if (current.SyncToken === undefined) {
    throw new Error('QuickBooks did not return a version for that item, so it was not changed.')
  }
  // Re-checked against what QuickBooks says RIGHT NOW, not against what the
  // screen was showing. Somebody may have set it by hand in the meantime, and
  // overwriting a real SKU is the one thing this must not do.
  const theirs = (current.Sku ?? '').trim()
  if (theirs && theirs.toLowerCase() !== value.toLowerCase()) {
    throw new Error(
      `That item already has SKU ${theirs} in QuickBooks. Change it there if ${value} is the ` +
        'one you want — this app will not overwrite a SKU somebody set.'
    )
  }

  const res = await qboRequest<{ Item?: RawItem }>({
    method: 'POST',
    path: 'item',
    body: { Id: id, SyncToken: current.SyncToken, sparse: true, Sku: value }
  })

  const saved = res.Item
  return {
    id: String(saved?.Id ?? id),
    name: String(saved?.FullyQualifiedName || saved?.Name || current.Name || ''),
    rate: typeof saved?.UnitPrice === 'number' ? saved.UnitPrice : null,
    description: saved?.Description ?? null,
    sku: (saved?.Sku ?? value).trim() || null
  }
}

/**
 * Add a customer.
 *
 * DisplayName is the field the invoice matches on, so it is the field that is
 * set — not GivenName/FamilyName, which QuickBooks would then compose a display
 * name from in an order that may not be the one written here.
 */
export async function createQboCustomer(input: {
  name: string
  email?: string | null
  billAddr?: InvoiceAddress | null
}): Promise<QboCustomerRef> {
  const res = await qboRequest<{ Customer?: RawCustomer }>({
    method: 'POST',
    path: 'customer',
    body: toQboCustomerPayload(input)
  })

  const created = res.Customer
  if (!created?.Id) {
    throw new Error('QuickBooks created the customer but did not say what its id is.')
  }
  return {
    id: String(created.Id),
    // `input.name`, NOT `name` — there is no local `name` here, and TypeScript
    // accepted the bare identifier only because lib.dom declares a global one.
    // The main process has no such global, so this threw a ReferenceError AFTER
    // the customer had already been created, and the operator's natural retry
    // made the duplicate contact this file's own comment says cannot be undone.
    name: String(created.DisplayName || input.name),
    email: created.PrimaryEmailAddr?.Address ?? null,
    billAddr: fromRawAddress(created.BillAddr)
  }
}

/**
 * Put our own invoice document on the QuickBooks record.
 *
 * ## Why our PDF and not theirs
 *
 * QuickBooks generates its own PDF of every invoice, so this is not about having
 * a PDF — it is about having OURS. The document this app produces is the one the
 * buyer was sent, with this business's layout and the SKUs as they stand here.
 * Keeping it on the transaction means the record in the accounting system and
 * the paper the customer holds are the same piece of paper, which is exactly the
 * question somebody is trying to answer when they go looking a year later.
 *
 * ## It is never allowed to fail the invoice
 *
 * By the time this runs the invoice IS in QuickBooks. Throwing here would mark a
 * successful post as failed, and a retry would then either be refused as a
 * duplicate or — worse — create the invoice twice. So the caller treats a
 * failure as a NOTE, and this returns the sentence rather than raising it.
 *
 * On the web the document may come back as HTML rather than PDF when the image
 * has no Chromium; it is attached either way, because a readable HTML copy on
 * the record beats nothing on the record.
 */
export async function attachInvoiceDocument(
  invoice: InvoiceDetail,
  qboId: string
): Promise<string | null> {
  try {
    const doc = await renderDocumentForExport(buildInvoiceHtml(invoice))
    const number = invoice.qboDocNumber || invoice.invoiceNumber || qboId
    await qboUpload({
      entityType: 'Invoice',
      entityId: qboId,
      fileName: `invoice-${number}${doc.extension}`,
      // The MIME carries a charset for HTML, which Intuit stores verbatim as the
      // ContentType. Only the type itself belongs on the record.
      mimeType: doc.mime.split(';')[0].trim(),
      bytes: doc.bytes
    })
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `The invoice is in QuickBooks, but the PDF could not be attached: ${message}`
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

/**
 * Remove an invoice from QuickBooks.
 *
 * Two calls, not one, and the first is not optional: Intuit's delete needs the
 * CURRENT SyncToken, and sending a stale one is refused with a version error
 * rather than silently doing nothing. The app does not store the token — it
 * changes every time anything touches the invoice, including edits made in
 * QuickBooks itself — so it is read immediately before the delete rather than
 * cached and hoped over.
 *
 * An invoice that is already gone from QuickBooks resolves rather than throws.
 * The caller is deleting it locally next, and refusing because the remote copy
 * has already been removed by hand would strand a row nobody can get rid of.
 */
export async function deleteQboInvoice(qboId: string): Promise<void> {
  const id = (qboId ?? '').trim()
  // Interpolated into a query string, so it is checked rather than trusted.
  if (!/^[0-9]+$/.test(id)) throw new Error('That is not a QuickBooks invoice id.')

  let syncToken: string | null = null
  try {
    const read = await qboRequest<{ Invoice?: { Id?: string; SyncToken?: string } }>({
      path: `invoice/${id}`
    })
    syncToken = read?.Invoice?.SyncToken ?? null
    if (!read?.Invoice?.Id) return
  } catch (err) {
    // Gone already is a success for what the caller is trying to achieve.
    if (/\b404\b/.test(err instanceof Error ? err.message : String(err))) return
    throw err
  }
  if (syncToken === null) {
    throw new Error('QuickBooks did not return a version for that invoice, so it was not deleted.')
  }

  await qboRequest({
    method: 'POST',
    path: 'invoice',
    query: { operation: 'delete' },
    body: { Id: id, SyncToken: syncToken }
  })
}
