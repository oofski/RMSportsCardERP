/**
 * THE KPI ROW ON FINANCE, AND THE TWO WAYS IT GOES GREY.
 *
 * The four tiles — revenue, fees, cost of goods, net profit — are an auto-fit
 * grid. auto-fit is the right choice: it reflows from four across to two to one
 * without a breakpoint that has to be kept in step with how many tiles there
 * are, which earned its keep the day the shipping tile was removed. But it has
 * two failure modes that share one symptom, a grey slab where a tile should be,
 * and BOTH ship silently. The stylesheet parses, the bundle builds, the suite
 * passes, and the first evidence is the owner sending a screenshot.
 *
 * ## Failure one: an item that spans the grid
 *
 * Grid L1 7.2.3.2: auto-fit collapses a repeated track only when it has no
 * in-flow item placed into OR SPANNING ACROSS it. The standing sentence under
 * the tiles used to be a cell of the same grid at "grid-column: 1 / -1", so it
 * spanned every track, so no track was ever empty, so nothing collapsed. The row
 * declared six 172px tracks, the four tiles took the first four, and the last
 * two rendered as 378px of the grid's own --border ground. It went unnoticed for
 * as long as the only spanning item was the drift alert, which appears only when
 * the checksum fails; the standing sentence appears always.
 *
 * ## Failure two: the ground the grid stands on
 *
 * The hairlines between tiles used to be drawn by a 1px gap over a --border
 * background. That draws a line between two tiles — and it also paints every
 * cell no tile ever reached. Four tiles over three columns leaves one such cell,
 * so the identical grey slab came back at any width that wraps, which on the web
 * app is a 1024x768 screen or half of a 1920 one. The fix is a white ground with
 * each tile drawing its own ring, so an unreached cell is empty space.
 *
 * ## What is asserted, and why it is asserted against the CSS text
 *
 * There is no DOM in this suite and no renderer test harness, so section 1 works
 * the arithmetic — it is a model of the collapse rule, and it is what explains
 * the bug to whoever reads this next. Sections 2 to 4 then hold the stylesheet
 * and the component to the shape that arithmetic says is safe. A regex over CSS
 * is a blunt instrument, but the alternative here is no instrument: the thing
 * being guarded is a property of the rules themselves, and it is invisible to
 * every other check the repo runs.
 *
 * Run: npm run test:widget-row
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** Relative to the repo root, like every other suite that reads a source file:
 *  the bundle these run from lives in out/tests, so __dirname is no use. */
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
const rawCss = read('src/renderer/src/styles/app.css')
const tsx = read('src/renderer/src/modules/finance/Widgets.tsx')

/**
 * COMMENTS COME OUT FIRST, and that is not tidiness.
 *
 * The comment block explaining this very bug contains the string
 * "grid-column: 1 / -1", because explaining it requires naming it. Scanning the
 * raw file would find that text and call the bug present forever after — a test
 * that fails on its own documentation is a test somebody deletes.
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration block whose selector list names exactly this selector. */
const bodiesFor = (selector: string): string[] => {
  const out: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const parts = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.includes(selector)) out.push(m[2])
  }
  return out
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(body)
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. the collapse rule, worked out ===')
// ---------------------------------------------------------------------------
// A model of the two lines of the spec that decide this. It is here so the
// numbers in the stylesheet's comment can be checked rather than believed.
{
  /** How many tracks `repeat(auto-fit, minmax(min, 1fr))` declares. */
  const declared = (row: number, min: number, gap = 1): number =>
    Math.max(1, Math.floor((row + gap) / (min + gap)))

  /** Fraction of the row the tiles cover once auto-fit has had its say. */
  const covered = (row: number, min: number, tiles: number, spanning: boolean): number => {
    const n = declared(row, min)
    if (!spanning && n > tiles) return 1 // the spare tracks and their gutters collapse
    const track = (row - (n - 1)) / n
    return (tiles * track + (tiles - 1)) / row
  }

  // Finance sits inside .content-narrow, capped at 1180px, which leaves the row
  // 1136px however wide the window is. That is the number the stylesheet quotes.
  const ROW = 1136
  ok(declared(ROW, 172) === 6, 'the widest the row ever gets declares six 172px tracks', String(declared(ROW, 172)))

  const broken = covered(ROW, 172, 4, true)
  const fixed = covered(ROW, 172, 4, false)
  ok(
    Math.abs(broken - 2 / 3) < 0.02,
    'WITH A SPANNING ITEM the four tiles cover two thirds of the row — the screenshot',
    broken.toFixed(3)
  )
  ok(fixed === 1, 'WITHOUT ONE they cover all of it', fixed.toFixed(3))

  // The slab itself: the two tracks nothing was placed in, plus the gutter
  // between them. This is the figure the stylesheet's comment quotes, so the
  // comment is checked here rather than trusted.
  const track = (ROW - (declared(ROW, 172) - 1)) / declared(ROW, 172)
  const spare = declared(ROW, 172) - 4
  ok(
    Math.round(spare * track + (spare - 1)) === 378,
    'and the two tracks left open come to the 378px the stylesheet names',
    String(Math.round(spare * track + (spare - 1)))
  )

  // THE SECOND FAILURE. Collapsing is about tracks that are empty across the
  // WHOLE grid, so it can do nothing about the leftover cells of a wrapped band.
  // Any width that wraps four tiles into three columns leaves one cell over, and
  // no arrangement of auto-fit avoids it — which is why the ground had to change
  // colour rather than the track count.
  const wrapped = 684 // a 1024px browser window with the sidebar showing
  ok(declared(wrapped, 172) === 3, 'a 1024px window wraps the four tiles onto three columns', String(declared(wrapped, 172)))
  ok(
    4 % declared(wrapped, 172) !== 0,
    'which leaves a cell no tile reaches, at any tile count that does not divide',
    String(4 % declared(wrapped, 172))
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. nothing spans the tile grid ===')
// ---------------------------------------------------------------------------
{
  for (const sel of ['.fin-widgets-standing', '.fin-widgets-drift', '.fin-widget']) {
    const bodies = bodiesFor(sel)
    ok(bodies.length > 0, `${sel} is still a rule in the sheet`, 'selector missing')
    ok(
      bodies.every((b) => decl(b, 'grid-column') === null),
      `${sel} DOES NOT SET grid-column — one that spans keeps every track alive`,
      bodies.map((b) => decl(b, 'grid-column')).filter(Boolean).join(' / ')
    )
  }

  // The two full-width lines get their width by being siblings of the grid, so
  // the card itself has to be the thing that stacks them.
  const card = bodiesFor('.fin-widgets')[0] ?? ''
  ok(decl(card, 'display') === 'flex', 'the card is a flex column, not the grid', String(decl(card, 'display')))
  ok(decl(card, 'flex-direction') === 'column', 'stacking the tile row and the lines under it')
  ok(decl(card, 'gap') === '1px', 'with the 1px gap that draws the rule between them')
  ok(
    decl(card, 'background') === 'var(--border)',
    'over a --border ground, which is what that gap shows',
    String(decl(card, 'background'))
  )
  ok(decl(card, 'grid-template-columns') === null, 'and the card no longer declares any tracks itself')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. an unreached cell is white, not grey ===')
// ---------------------------------------------------------------------------
{
  const row = bodiesFor('.fin-widgets-row')[0] ?? ''
  ok(row !== '', 'the tile grid has a rule of its own')
  ok(
    /repeat\(\s*auto-fit\s*,\s*minmax\(\s*172px\s*,\s*1fr\s*\)\s*\)/.test(
      decl(row, 'grid-template-columns') ?? ''
    ),
    'it is still auto-fit — no breakpoint counting tiles',
    String(decl(row, 'grid-template-columns'))
  )
  // THE ONE THAT MATTERS. Over --border every cell no tile reached is a grey
  // slab; over --surface it is empty space, at any tile count and any width.
  ok(
    decl(row, 'background') === 'var(--surface)',
    'AND IT STANDS ON --surface, so a leftover cell reads as space',
    String(decl(row, 'background'))
  )
  ok(decl(row, 'gap') === '1px', 'the 1px gap stays — it is where the tiles draw their lines')
  ok(
    decl(row, 'grid-template-rows') === 'auto auto auto auto',
    'and the four bands the tiles share by subgrid are still declared here',
    String(decl(row, 'grid-template-rows'))
  )

  // With a white ground the gaps show nothing, so each tile has to draw its own
  // hairline or the row becomes four figures floating in a box.
  const tile = bodiesFor('.fin-widget')[0] ?? ''
  const shadow = decl(tile, 'box-shadow')
  ok(
    shadow !== null && /0\s+0\s+0\s+1px\s+var\(--border\)/.test(shadow),
    'each tile draws its own 1px hairline into that gap',
    String(shadow)
  )
  ok(decl(tile, 'grid-template-rows') === 'subgrid', 'and still shares the row bands, so the figures line up')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. every override points at the grid, not the card ===')
// ---------------------------------------------------------------------------
// A responsive rule left on .fin-widgets after the grid moved to
// .fin-widgets-row is not an error — it is a no-op, and the row simply stops
// reflowing at that width with nothing to say it has.
{
  const strays = bodiesFor('.fin-widgets').filter((b) => decl(b, 'grid-template-columns') !== null)
  ok(strays.length === 0, 'NO MEDIA RULE STILL SETS TRACKS ON .fin-widgets', String(strays.length))

  const rowRules = bodiesFor('.fin-widgets-row')
  ok(
    rowRules.filter((b) => decl(b, 'grid-template-columns') !== null).length >= 2,
    'and the narrow-window overrides did move across with it',
    String(rowRules.length)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. the markup is the shape the CSS assumes ===')
// ---------------------------------------------------------------------------
{
  ok(/className="fin-widgets-row"/.test(tsx), 'the component renders the inner grid')

  // The two lines must be OUTSIDE it. Checked by position rather than by
  // nesting depth: the wrapper closes before either paragraph is written.
  const rowAt = tsx.indexOf('className="fin-widgets-row"')
  const closeAt = tsx.indexOf('</div>', rowAt)
  const standingAt = tsx.indexOf('className="fin-widgets-standing"')
  const driftAt = tsx.indexOf('className="fin-widgets-drift"')
  ok(rowAt > -1 && closeAt > -1, 'the wrapper is opened and closed')
  ok(standingAt > closeAt, 'THE STANDING SENTENCE IS OUTSIDE THE GRID', `${standingAt} vs ${closeAt}`)
  ok(driftAt > closeAt, 'and so is the drift alert', `${driftAt} vs ${closeAt}`)

  // The group label describes the whole card, lines included, so it stays on
  // the outer element rather than following the tiles inward.
  ok(
    /className="fin-widgets"\s+role="group"/.test(tsx),
    'and the group label is still on the card, not on the tile row'
  )
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
