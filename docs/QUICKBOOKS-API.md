# What the QuickBooks connection can and cannot do

Written because "it says connected but it won't send" turned out to be two very
different questions wearing one word. This is the map.

Everything under **What the app calls today** is read off this repository and is
therefore true of this build. Everything under **What the API offers** is
Intuit's Accounting API surface — check
[their entity reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities)
before relying on a detail, because it is theirs to change and not ours.

---

## The connection

One OAuth scope: `com.intuit.quickbooks.accounting` (`QBO_SCOPE`,
`src/shared/quickbooks.ts`). That single scope decides the whole answer to "can
it do X":

| Product | In scope? |
| --- | --- |
| **Accounting** — invoices, customers, items, bills, accounts, reports | **Yes.** This is what we hold. |
| **Payments** — actually charging a card | **No.** Different API, different scope (`com.intuit.quickbooks.payment`), separate Intuit approval. |
| **Payroll** | **No.** Not part of this API at all. |
| **Time tracking** | **No.** That is QuickBooks Time (TSheets), a separate product and API. |

So anything below that says "cannot" for scope reasons is not a missing feature
in this app — it is a different Intuit product.

---

## What the app calls today

Verified against `src/main/quickbooks/`. This is the entire surface.

### Reads

| Entity | Where | Why |
| --- | --- | --- |
| `CompanyInfo` | `client.ts` | The connection test. Answers "which company am I?" and nothing else — which is why it passes while a send fails. |
| `Customer` | `invoices.ts` | Match the buyer by exact DisplayName. |
| `Item` | `invoices.ts` | Match every line, SKU first then name. |
| `Term` | `invoiceRefs.ts` | Turn "Net 30" into a SalesTermRef id. |
| `Class` | `invoiceRefs.ts` | Resolve the "United States" class. |
| `Preferences` | `invoiceRefs.ts` | Ask whether class tracking is on, and where a class goes. |
| `Account` | `accounts.ts` | The chart of accounts for the mapping screen. |
| `Vendor` | `accounts.ts` | Supplier directory. |
| `Invoice` (by id) | `invoices.ts`, `invoiceStatus.ts` | Read status back; fetch SyncToken before a delete. |

### Writes

| Call | Where | Notes |
| --- | --- | --- |
| `POST /invoice` | `createQboInvoice` | The main event. Refuses before posting if any name is unresolved. |
| `POST /invoice?operation=delete` | `deleteQboInvoice` | Needs the **current** SyncToken, read immediately beforehand. |
| `POST /invoice/{id}/send` | `sendQboInvoice` | Asks QuickBooks to email it. Separate from creating on purpose. |
| `POST /customer` | `createQboCustomer` | Added v0.0.171. Explicit press only. |
| `POST /item` | `createQboItem` | Added v0.0.171. NonInventory, against the mapped income account. |

**That is all of it.** Nine reads, five writes.

---

## What is mapped but NOT wired up

The Account mapping screen lists three flows and says "Nothing posts until every
account a flow needs is chosen". That sentence is true but incomplete, and the
incompleteness matters:

- Inventory purchase orders → supplier bill
- Supply orders → expense
- Break sales → sales receipt

**None of these post anything today.** There is no `POST /bill`, no
`POST /purchase` and no `POST /salesreceipt` anywhere in this repository. The
mapping is stored and validated, and the only code that reads it is
`createQboItem`, which needs `salesIncome` to create a Product/Service.

So filling the mapping in is worth doing — it unblocks creating items, and it is
a prerequisite for those flows — but it does not switch them on. They have to be
built.

---

## What the API offers that we do not use

Everything here is available under the scope we already hold. Roughly in the
order it would be worth building for this business:

| Entity | What it would give us |
| --- | --- |
| `Bill` | A received PO becomes a supplier bill. The mapping's `accountsPayable` + `inventoryAsset` slots exist for exactly this. |
| `Payment` | Record a customer paying an invoice, so "paid" here means paid there. |
| `SalesReceipt` | A break paid at the point of sale — no invoice, no receivable. |
| `Purchase` | A card or bank expense: mailers, sleeves, tape. |
| `Estimate` | A quote that later converts to an invoice. |
| `CreditMemo` / `RefundReceipt` | Returns and refunds. |
| `Attachable` | Attach a PDF (our own invoice or a supplier's) to the QuickBooks record. |
| `Deposit`, `JournalEntry`, `Transfer` | Lower-level ledger moves. |
| `PurchaseOrder` | QuickBooks has its own PO entity. Ours is richer (per-line routing, dropship), so mirroring is a decision, not an obligation. |
| Reports (`/reports/ProfitAndLoss`, `AgedReceivables`, …) | Read-only reporting straight off their books. |
| CDC (`/cdc`) | "What changed since this timestamp" — one call instead of re-sweeping every entity. |
| Webhooks | Intuit pushes us a notification when an entity changes, instead of us polling. |
| Batch (`/batch`) | Up to 30 operations in one request. |

---

## What it genuinely cannot do

These are limits, not gaps. Several were learned the hard way and are already
written into the code.

**There is no SKU field on an invoice line.** `SalesItemLineDetail` carries
ItemRef, ClassRef, TaxCodeRef, MarkupInfo, ItemAccountRef, ServiceDate, Qty,
UnitPrice, TaxClassificationRef, TaxInclusiveAmt, DiscountAmt and DiscountRate —
that is the whole list. The SKU printed on a QuickBooks invoice is read off the
**Item** (`Item.Sku`). The only way to get the right SKU on the document is to
point the line at the right item, which is why matching resolves by SKU first.

**Our invoice number is not guaranteed to survive.** QuickBooks silently
replaces `DocNumber` unless the company has *Custom transaction numbers* switched
on. Whatever comes back is what we record, and `numberChanged` says so.

**A ClassRef in the wrong slot is dropped without complaint.** Whether a class
goes on the transaction or on each line is *their* preference, read from
`Preferences`. Send it to the wrong place and the invoice posts with no class at
all — no error. Worse than a failure, because it looks like success.

**Terms are references, not words.** Sending the string "Net 30" does nothing;
the term must exist in their company and be resolved to an id. A term we have
that they do not — **Net 2 is currently one of these** — means the invoice posts
on the customer's own default terms and we record a note saying so. Add "Net 2"
under Sales → Terms in QuickBooks to close that gap.

**Names must match exactly.** No fuzzy matching, no "did you mean". A customer or
item that differs by a character is a customer or item that does not exist. This
is the single most common reason a send fails.

**Deleting needs the current SyncToken.** It changes every time anything touches
the record, including edits made inside QuickBooks, so it is read immediately
before the delete rather than cached.

**An invoice already in QuickBooks is not ours to edit.** `saveInvoice` refuses
it, which is why a posted invoice shows as a receipt rather than a form.

**Sandbox and production are different companies** with different ids for
everything. Account id "80" means unrelated things in each — which is why the
mapping is keyed by realm.

**Query is not SQL.** No joins, no aggregates, and paging is
`STARTPOSITION`/`MAXRESULTS` with a hard ceiling of 1000 rows per page —
`queryAll` loops for this reason.

**There are rate limits**, per realm and per app, and a batch caps at 30
operations. Check Intuit's current numbers before designing anything that sweeps
in bulk; treat 429 as a real response rather than an anomaly.

**Item names are unique and capped at 100 characters.** Creating one that already
exists is refused, which is the correct behaviour and why `createQboItem`
surfaces the error rather than swallowing it.

---

## Where the connection lives

Not an API limit, but the other half of "it works here and not there". The grant
is stored in the `meta` table, and `meta` is **deliberately excluded from cloud
sync** — so it does not travel between machines the way the rest of the company's
data does. On the desktop it is sealed with the OS keychain, which is bound to
that machine anyway.

The relay is the fix: move the connection to it once (Invoices → QuickBooks →
*Move it to the relay*) and every machine uses it, desktop installs and the web
app alike. See `docs/WEB.md` and `src/main/quickbooks/relay.ts`.
