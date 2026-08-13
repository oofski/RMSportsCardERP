/**
 * The server can turn a document into PDF bytes — or says it cannot.
 *
 * ## Why this is a suite and not a "looks fine"
 *
 * The web server had no Chromium for most of this app's life, deliberately, and
 * handed the browser HTML to print instead. That was fine while a PERSON was the
 * only consumer of the document. It stopped being fine when the PDF acquired a
 * consumer that cannot press File → Print: attaching an invoice to its
 * QuickBooks record needs actual bytes.
 *
 * So the server now renders. Two things about that have to hold, and each fails
 * in a way that would otherwise be found by a customer:
 *
 *   1. WHEN A BROWSER IS THERE, the bytes are a real PDF — not an empty file,
 *      not a truncated one, and not HTML wearing a .pdf extension. Chromium has
 *      been known to exit 0 having written nothing when a flag it did not like
 *      was passed, which is exactly the shape of failure that reaches a user as
 *      "this file is damaged".
 *
 *   2. WHEN IT IS NOT, the answer is HTML and NOT an error. A checkout running
 *      `npm run server` on a laptop has no Chromium, and a missing browser must
 *      never turn a button somebody presses in front of a customer into a
 *      failure.
 *
 * The document's own CSS decides A4 and the margins — `@page { size: A4 }` — so
 * a page size passed as a flag here would be a second opinion about the same
 * document. That is asserted too: the PDF's MediaBox has to come out A4, which
 * is what proves the CSS is being honoured rather than Chromium's Letter default
 * quietly winning.
 *
 * Run: npm run test:server-pdf
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { existsSync } = require('node:fs')

let pass = 0
let fail = 0
let skipped = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

/**
 * A browser to test against.
 *
 * The container the app deploys to installs `chromium`; a developer machine may
 * have Chrome, and CI here carries Playwright's copy. Any of them proves the
 * same thing, so the first one found is used and the whole browser section is
 * SKIPPED rather than failed when there is none — a suite that goes red because
 * the machine running it has no browser teaches people to ignore it.
 */
const BROWSERS = [
  process.env.RMOPS_CHROMIUM ?? '',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
].filter(Boolean)

/**
 * Both branches are exercised on every run, not whichever one this machine
 * happens to fall into.
 *
 * `npm run test:server-pdf` runs this file twice — once as it is, and once with
 * RMOPS_TEST_NO_BROWSER=1, which makes the probe find nothing. Otherwise the
 * fallback would only ever be covered on a laptop with no Chromium, and the
 * container would only ever cover the render — so each half would be verified
 * exclusively on the machine where it does NOT run in production.
 */
const forceNone = process.env.RMOPS_TEST_NO_BROWSER === '1'
if (forceNone) process.env.RMOPS_CHROMIUM = '/nonexistent/chromium'
const found = forceNone ? undefined : BROWSERS.find((p: string) => existsSync(p))

// A4 at 72dpi: 210mm x 297mm is 595.276 x 841.89 points. Letter would be
// 612 x 792 — visibly different numbers, which is the point of checking.
const A4_W = 595
const A4_H = 842

/** The smallest document that still exercises @page, colour and text. */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .band { background: #123456; color: #fff; padding: 8px; }
</style></head><body>
  <h1>Invoice 2293</h1>
  <div class="band">Riverside Cards LLC</div>
  <p>2025 Bowman Draft Baseball Mega 20-Box Case</p>
</body></html>`

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  console.log('=== 1. finding the browser ===')
  // ---------------------------------------------------------------------------
  if (process.env.RMOPS_CHROMIUM) {
    console.log(`  (RMOPS_CHROMIUM=${process.env.RMOPS_CHROMIUM})`)
  }

  if (!found) {
    console.log('  --   no Chromium on this machine; the browser section is skipped')
  } else {
    console.log(`  --   using ${found}`)
    process.env.RMOPS_CHROMIUM = found
  }

  // Required AFTER the env var is set: the path is resolved once and cached for
  // the life of the process, which is the behaviour being relied on in
  // production and therefore the behaviour worth testing.
  const { renderServerDocument, chromiumPath } = require('../src/server/pdfRenderer')

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. rendering ===')
  // ---------------------------------------------------------------------------
  ok(
    found ? chromiumPath() === found : chromiumPath() === null,
    'the probe agrees with what is actually on disk',
    String(chromiumPath())
  )

  const doc = await renderServerDocument(HTML)

  if (!found) {
    // The degraded path, which is the one a laptop takes.
    ok(doc.extension === '.html', 'with no browser it falls back to HTML')
    ok(doc.mime.startsWith('text/html'), 'and says so in the MIME type')
    ok(doc.bytes.length > 0, 'and the HTML is actually there')
    ok(
      Buffer.from(doc.bytes).toString('utf8').includes('Invoice 2293'),
      'unchanged, so the browser prints the same document'
    )
    skipped += 5
    console.log('  --   5 browser assertions skipped')
  } else {
    ok(doc.extension === '.pdf', 'with a browser it renders a PDF', doc.extension)
    ok(doc.mime === 'application/pdf', 'and says so in the MIME type', doc.mime)

    const bytes = Buffer.from(doc.bytes)
    // NOT just "length > 0". Chromium has exited 0 having written an empty file
    // when it disliked a flag, and an empty .pdf reaches a user as "damaged".
    ok(bytes.length > 1000, 'and it is a real document rather than a stub', `${bytes.length} bytes`)
    ok(bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'starting with the PDF magic number')
    // A truncated write is the other failure that looks like success.
    ok(
      bytes.subarray(-1024).toString('latin1').includes('%%EOF'),
      'and ending with %%EOF, so it is complete rather than truncated'
    )

    // THE PAGE SIZE COMES FROM THE DOCUMENT, not from a flag. Chromium's own
    // default is US Letter; A4 here proves the CSS @page is being honoured, which
    // is what keeps the server's output identical to the desktop's.
    const text = bytes.toString('latin1')
    const box = /MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(text)
    if (box) {
      const w = Math.round(Number(box[1]))
      const h = Math.round(Number(box[2]))
      ok(
        Math.abs(w - A4_W) <= 2 && Math.abs(h - A4_H) <= 2,
        'the page is A4, from the document’s own @page rule',
        `${w}x${h}, wanted ~${A4_W}x${A4_H}`
      )
    } else {
      // Compressed object streams can hide it. Not a failure — the assertion
      // simply could not be made, and saying so is better than a false green.
      console.log('  --   MediaBox not readable (compressed); page size unchecked')
      skipped++
    }
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. it never throws ===')
  // ---------------------------------------------------------------------------
  // Every failure path returns null internally and falls back. A renderer that
  // throws takes out the button that called it.
  for (const nasty of ['', '<html>', '<p>' + 'x'.repeat(200_000) + '</p>']) {
    let threw = false
    let out: { extension?: string } = {}
    try {
      out = await renderServerDocument(nasty)
    } catch {
      threw = true
    }
    ok(!threw, `a ${nasty.length}-character document does not throw`)
    ok(
      out.extension === '.pdf' || out.extension === '.html',
      'and still comes back as one of the two shapes'
    )
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`)
  if (fail > 0) process.exit(1)
}

void main()
