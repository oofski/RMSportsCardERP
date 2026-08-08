import type { InvoiceDetail } from '@shared/invoices'
import { qboInvoiceUrl, toQboInvoice } from '@shared/invoices'
import { qboRequest } from './client'
import { getQboConfig } from './store'

/**
 * Posting an invoice to QuickBooks, and the two lookups that make it possible.
 *
 * This is the ONLY file in the app that writes to somebody's books, and it is
 * written to fail loudly and early rather than half-succeed. An invoice either
 * goes over whole or does not go at all: there is no partial post, no retry
 * loop that could double it, and nothing that swallows an error and leaves our
 * copy claiming a document that is not there.
 *
 * ## Why the lookups exist
 *
 * QuickBooks does not accept names. A CustomerRef and an ItemRef are ids from
 * the connected company, and a payload built from what somebody typed here
 * would be rejected in a way whose error message ("Invalid Reference Id") says
 * nothing about which field was wrong. So the buyer and every line item are
 * resolved to real ids first, and an item that does not exist is reported by
 * NAME before anything is sent.
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
}

export interface QboItemRef {
  id: string
  name: string
  /** The list price, so the editor can offer it rather than make somebody type it. */
  rate: number | null
  description: string | null
}

interface RawCustomer {
  Id?: string
  DisplayName?: string
  Active?: boolean
  PrimaryEmailAddr?: { Address?: string }
}

interface RawItem {
  Id?: string
  Name?: string
  FullyQualifiedName?: string
  Active?: boolean
  Type?: string
  UnitPrice?: number
  Description?: string
}

/** Everybody this company can invoice. */
export async function fetchQboCustomers(): Promise<QboCustomerRef[]> {
  const rows = await queryAll<RawCustomer>('Customer', 'Active = true')
  return rows
    .filter((c) => c.Id && c.DisplayName)
    .map((c) => ({
      id: String(c.Id),
      name: String(c.DisplayName),
      email: c.PrimaryEmailAddr?.Address ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Everything sellable.
 *
 * FullyQualifiedName rather than Name, because a sub-item's plain name is not
 * unique — two parents can each have a "Design" — and the name is what the
 * operator picks from and what the payload is matched on.
 */
export async function fetchQboItems(): Promise<QboItemRef[]> {
  const rows = await queryAll<RawItem>('Item', 'Active = true')
  return rows
    .filter((i) => i.Id && (i.FullyQualifiedName || i.Name))
    .map((i) => ({
      id: String(i.Id),
      name: String(i.FullyQualifiedName || i.Name),
      rate: typeof i.UnitPrice === 'number' ? i.UnitPrice : null,
      description: i.Description ?? null
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface QboInvoiceResult {
  qboId: string
  docNumber: string | null
  /** Where to send the browser so somebody can look at it and press Send. */
  url: string
  /** True when the number QuickBooks used is not the one we asked for. */
  numberChanged: boolean
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
  const itemRefs = new Map(
    items.map((i) => [i.name.trim().toLowerCase(), { id: i.id, name: i.name }])
  )

  // Throws, by name, on any line QuickBooks could not resolve — before a single
  // byte is posted. Half an invoice is not a useful thing to have created.
  const payload = toQboInvoice(invoice, { id: customer.id, name: customer.name }, itemRefs)

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
    numberChanged: !!invoice.invoiceNumber && !!docNumber && docNumber !== invoice.invoiceNumber
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
