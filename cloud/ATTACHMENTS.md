# Attaching invoice PDFs to QuickBooks

The app now puts its own invoice PDF onto the QuickBooks record when it posts an
invoice. Half of that is in the app and deploys itself. The other half is one new
route in the relay Worker, which is deployed by hand.

## Deploying it

Exactly what you did the first time:

1. Cloudflare dashboard → Workers & Pages → your relay Worker → **Edit code**.
2. Replace the contents with `cloud/worker.js` from this repo.
3. Deploy.

**No new bindings, no new secrets, no D1 console step.** The route uses the
QuickBooks connection the relay already holds.

## How to tell it worked

Open **Invoices → QuickBooks** in the app. The relay now reports what it can do,
and the app checks that before trying to upload — so a Worker that has not been
redeployed says so in a sentence instead of failing with a 404 from a button
labelled "Send to QuickBooks".

If you see this after posting an invoice:

> The invoice is in QuickBooks, but the PDF could not be attached: The cloud
> relay is running an older copy of the Worker…

…the deploy has not landed. Nothing is broken and nothing needs undoing — the
invoice itself posted fine.

## What it does

`POST /v1/qbo/upload`, taking the file base64-encoded inside JSON:

```json
{
  "entityType": "Invoice",
  "entityId": "145",
  "fileName": "invoice-2293.pdf",
  "mimeType": "application/pdf",
  "contentBase64": "JVBERi0xLjQ..."
}
```

The Worker frames it as the multipart body Intuit's `/upload` wants — two parts,
`file_metadata_01` and `file_content_01` — and returns the attachment id.

**Why base64 in JSON rather than a multipart body from the app.** It costs a
third in transfer and buys two things worth more: the relay's request framing
stays uniform, so there is one shape, one auth check and one place that reads a
body; and the app never builds a multipart body it would then have to keep in
step with this file.

**Why the metadata matters more than it looks.** `AttachableRef` is what LINKS
the file to the transaction. Without it the upload succeeds, gets an id, and
lands in the company's Attachments list attached to nothing — where nobody
looking at the invoice will ever find it. That is the failure that looks most
like success, which is why the payload is built in one shared place and pinned by
a test.

## The limits it enforces, and why they are here and not only in the app

This route is a boundary. The app checks the same things, but that check catches
a bug in the app; **this** one is what stands between somebody holding the shared
key and a malformed or oversized upload aimed at the connected company. Same
reasoning as `qboSafePath`.

| Limit | Value | Why |
| --- | --- | --- |
| Entity types | Invoice, PurchaseOrder, Bill, SalesReceipt, Estimate | A whitelist. Anything else is something this app does not create. |
| Entity id | digits only | Intuit's ids are numeric; anything else is a bug or a probe. |
| Content types | pdf, html, csv, plain, png, jpeg | Sanity, not security. |
| Size | 8 MB decoded | Intuit's own ceiling is 100 MB, which is not the number that matters — a Worker holds the whole thing in memory. An invoice PDF is tens of kilobytes. |

The size check runs on the **encoded** string before anything is decoded.
Checking after decoding means a caller who sends 200 MB has already had 200 MB
allocated inside the isolate by the time it is refused.

File names are stripped of quotes, newlines and slashes rather than rejected: the
name travels into a `Content-Disposition` header, where a quote or a newline
would break the multipart framing itself — but failing an upload over a
punctuation mark in a customer's name would be the worse outcome.

## Capability reporting

`/v1/qbo/status` now includes `features: ['upload']`.

The relay is deployed separately from the app, by hand, so the two are routinely
different ages — and nothing in the Cloudflare dashboard tells you the running
code is older than the repository. Announcing capabilities **by name** means the
app asks "can you do this" rather than "are you new enough", which is the
question it actually has. A relay deployed before this field answers with
nothing, and an absent feature reads correctly as "no".
