/**
 * The phone layer, at the level where it can actually be wrong.
 *
 * One renderer bundle serves the Electron desktop app and the web app, and the
 * web app is installed to a phone's home screen. styles/mobile.css makes that
 * second surface usable, and the whole design of it rests on ONE promise: none
 * of it can reach a desktop window. That promise is not something a reviewer
 * can hold in their head across 700 lines of CSS, and it fails silently — a
 * rule that escapes the media query does not error, it just quietly reshapes
 * the app everybody uses at a desk, and the first evidence is somebody saying
 * the sidebar looks odd.
 *
 * So this suite does not check that the CSS parses. It checks the things that
 * would be invisible until they had already shipped:
 *
 *   1. the breakpoint helper's boundary, including the two inputs that are not
 *      measurements at all;
 *   2. that EVERY declaration in mobile.css sits inside the query, and that no
 *      query in the file is wider than the breakpoint;
 *   3. that the desktop's own stylesheets know nothing about any name the
 *      phone layer introduced — so the classes and attributes added to the
 *      components are provably inert at a desktop width; and, since it is the
 *      same question asked of the same three files, that none of them has
 *      grown a second palette — this app is light for everyone, and a rule
 *      keyed to the viewer's OS is the other way a stylesheet renders
 *      differently for one person than for whoever wrote it;
 *   4. that the Electron window still cannot be narrow enough to match, which
 *      is what makes (2) a guarantee rather than a convention;
 *   5. the handful of one-line details that are individually trivial and each
 *      break the whole thing: the iOS 16px font-size floor, viewport-fit, and
 *      the import order that decides whether any of it applies.
 *
 * Run: npm run test:mobile
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PHONE_MAX_WIDTH, PHONE_MEDIA_QUERY, isPhoneWidth } from '../src/renderer/src/lib/viewport'

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

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const MOBILE_CSS_PATH = 'src/renderer/src/styles/mobile.css'
const mobileCss = read(MOBILE_CSS_PATH)

/** Comments hold prose about colours and widths; only the CSS itself is under test. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Split a stylesheet into its outermost `prelude { body }` blocks, plus
 * whatever text sits between them. The between-text matters: a declaration
 * loose at the top level would land there rather than in any block.
 */
function topLevel(css: string): { blocks: { prelude: string; body: string }[]; between: string } {
  const blocks: { prelude: string; body: string }[] = []
  let between = ''
  let depth = 0
  let mark = 0
  let prelude = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '{') {
      if (depth === 0) {
        between += css.slice(mark, i).replace(/[^{}]*$/, '')
        prelude = css.slice(mark, i).trim()
        mark = i + 1
      }
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        blocks.push({ prelude, body: css.slice(mark, i) })
        mark = i + 1
      }
    }
  }
  between += css.slice(mark)
  return { blocks, between }
}

;(() => {
  console.log('=== 1. the breakpoint helper ===')

  ok(isPhoneWidth(PHONE_MAX_WIDTH), 'the breakpoint itself is a phone — `max-width` is inclusive')
  ok(!isPhoneWidth(PHONE_MAX_WIDTH + 1), 'one pixel over is not')
  ok(isPhoneWidth(PHONE_MAX_WIDTH - 1), 'one pixel under is')
  ok(isPhoneWidth(390), 'an iPhone in portrait is')
  ok(isPhoneWidth(768), 'an iPad in portrait is — it wants the stacked layout too')
  ok(!isPhoneWidth(1040), 'the narrowest window Electron will create is not')
  ok(!isPhoneWidth(1280), 'nor the default one')
  ok(isPhoneWidth(0), 'a zero-width viewport counts as narrow rather than throwing')

  // The two inputs that are not measurements. Answering "phone" to either would
  // run phone-only behaviour on a desktop, which is the one thing the whole
  // arrangement exists to prevent.
  ok(!isPhoneWidth(Number.NaN), 'an unmeasurable width is not a phone')
  ok(!isPhoneWidth(Number.POSITIVE_INFINITY), 'nor an infinite one')
  ok(!isPhoneWidth(Number.NEGATIVE_INFINITY), 'nor a negatively infinite one')
  ok(!isPhoneWidth(-1), 'nor a negative one — a window mid-teardown is not a phone')

  console.log('\n=== 2. nothing in the phone layer can reach a desktop width ===')

  const stripped = stripComments(mobileCss)
  const { blocks, between } = topLevel(stripped)

  ok(blocks.length > 0, 'the stylesheet has at least one top-level block', String(blocks.length))
  ok(
    between.trim() === '',
    'nothing sits loose at the top level of the file',
    JSON.stringify(between.trim().slice(0, 120))
  )

  const outsideQuery = blocks.filter((b) => !b.prelude.startsWith('@media'))
  ok(
    outsideQuery.length === 0,
    'every top-level block is a media query, so no rule applies unconditionally',
    outsideQuery.map((b) => b.prelude).join(' | ')
  )

  const outermost = blocks.map((b) => b.prelude.replace(/^@media\s*/, '').trim())
  ok(
    outermost.every((p) => p === PHONE_MEDIA_QUERY),
    `every top-level query is exactly ${PHONE_MEDIA_QUERY}`,
    outermost.join(' | ')
  )

  // Nested queries are allowed to be NARROWER — a rule that only makes sense on
  // a genuinely small screen. One that is wider would start reaching the desktop
  // through the outer query's back door on a resized web window.
  const widths = [...stripped.matchAll(/@media[^{]*?max-width:\s*(\d+)px/g)].map((m) => Number(m[1]))
  ok(widths.length === blocks.length, 'every query in the file declares a max-width', String(widths))
  ok(
    widths.every((w) => w <= PHONE_MAX_WIDTH),
    'and none of them is wider than the breakpoint',
    String(widths.filter((w) => w > PHONE_MAX_WIDTH))
  )
  ok(
    widths.includes(PHONE_MAX_WIDTH),
    `the CSS and src/renderer/src/lib/viewport.ts agree on ${PHONE_MAX_WIDTH}px`,
    String(widths)
  )

  // The house rule, made mechanical. A hex or an rgb() here is a colour that
  // opts out of the palette, so it stops tracking the tokens the moment one is
  // retuned — and it is a phone-only rule, so nobody at a desk ever sees it.
  const literals = [
    // `(?!-)` so `white-space` is a property, not the colour keyword `white`.
    ...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\b(?:white|black|silver)\b(?!-)/g)
  ].map((m) => m[0])
  ok(
    literals.length === 0,
    'no colour literal anywhere in it — every colour is a theme token',
    literals.join(', ')
  )

  console.log('\n=== 3. the desktop stylesheets know none of these names ===')

  // What the components gained is a class and a set of data-labels. They are
  // inert on the desktop only for as long as nothing outside the media query
  // selects them, which is exactly what this checks.
  const appCss = read('src/renderer/src/styles/app.css')
  const themeCss = read('src/renderer/src/styles/theme.css')
  const desktopCss = stripComments(appCss) + stripComments(themeCss)

  for (const name of ['as-cards', 'data-label', '--rm-tap', '--rm-bar-h', '--rm-safe', 'env(safe-area']) {
    ok(!desktopCss.includes(name), `app.css and theme.css never mention ${name}`)
  }

  // And the reverse: a data-label with no table to stack is a label that never
  // renders, which looks like the phone layout failing on that one screen.
  const stacked = [
    'src/renderer/src/modules/admin/HoursTab.tsx',
    'src/renderer/src/modules/admin/EmployeeTimesheet.tsx',
    'src/renderer/src/modules/admin/ActivityTab.tsx',
    'src/renderer/src/modules/admin/EmployeesTab.tsx',
    // Both people-lists, now filed together under Admin. Customers moved here
    // from the Sales Orders module (it was BuyersTab); Vendors is new and is
    // just as wide, so it stacks under the same section-3 rules.
    'src/renderer/src/modules/admin/CustomersTab.tsx',
    'src/renderer/src/modules/admin/VendorsTab.tsx',
    'src/renderer/src/modules/finance/BreakPnl.tsx',
    'src/renderer/src/modules/inventory/SuppliesTab.tsx',
    'src/renderer/src/modules/inventory/InventoryOverview.tsx',
    'src/renderer/src/modules/timepay/TimePayrollModule.tsx'
  ]
  for (const file of stacked) {
    const src = read(file)
    ok(
      src.includes('as-cards') && src.includes('data-label='),
      `${file.split('/').pop()} carries both the class and its labels`
    )
  }

  console.log('\n=== 3b. there is exactly one palette, and it is light ===')

  // Two hooks a second theme could hang off, and they fail in opposite ways —
  // which is why both are checked rather than just the one that was removed. A
  // `data-theme` rule is inert unless something sets the attribute, and the
  // module that set it is gone, so it would sit in the stylesheet applying to
  // nobody and looking like it worked. A `prefers-color-scheme` block needs no
  // attribute at all: it applies on its own to whoever has their laptop or
  // phone in OS dark mode, repainting part of one screen for some of the team
  // and not the rest. Neither is visible on the machine that wrote it.
  for (const sheet of [MOBILE_CSS_PATH, 'src/renderer/src/styles/app.css', 'src/renderer/src/styles/theme.css']) {
    const css = stripComments(read(sheet))
    const name = sheet.split('/').pop()
    ok(!css.includes('data-theme'), `${name} has no data-theme rule`)
    ok(!css.includes('prefers-color-scheme'), `${name} has no prefers-color-scheme query`)
  }

  // The positive half. CSS owns the page; it does not own the canvas behind it,
  // the scrollbars, the overscroll or the native picker behind an
  // <input type="date">. Without this declaration the engine draws all four
  // from the SYSTEM palette, so a phone in dark mode frames a light app in dark
  // grey and offers a date picker nobody can read.
  ok(
    /:root\s*\{[^}]*color-scheme:\s*light/.test(stripComments(themeCss)),
    'theme.css tells the browser this app is light, so native chrome follows'
  )

  console.log('\n=== 4. the desktop window still cannot be that narrow ===')

  // This is the load-bearing fact behind every claim above. Lower minWidth past
  // the breakpoint and the phone layout becomes reachable on the desktop with
  // nothing else in the repo changing.
  const mainIndex = read('src/main/index.ts')
  const minWidth = Number(/minWidth:\s*(\d+)/.exec(mainIndex)?.[1])
  ok(Number.isFinite(minWidth), 'the Electron window still declares a minWidth', String(minWidth))
  ok(
    minWidth > PHONE_MAX_WIDTH,
    `and it is wider than the breakpoint (${minWidth} > ${PHONE_MAX_WIDTH})`,
    String(minWidth)
  )

  console.log('\n=== 5. the one-liners that decide whether any of it works ===')

  // Safari zooms the page when a field under 16px takes focus, and does not
  // zoom back. One missed control brings it back for the whole page.
  ok(
    /input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px\s*!important/.test(stripped),
    'every form control is pinned to 16px so iOS cannot zoom on focus'
  )

  // Without viewport-fit=cover every safe-area inset reports 0px and iOS
  // letterboxes instead — which looks exactly like the insets working.
  const html = read('src/renderer/index.html')
  ok(/name="viewport"[^>]*viewport-fit=cover/.test(html), 'index.html opts into the full screen')
  ok(!/user-scalable\s*=\s*no/.test(html), 'and does not take zoom away from anyone')

  // The bars sit in the two strips the system draws over, so both have to
  // reserve their inset or half the controls stop being tappable.
  ok(stripped.includes('--rm-safe-t: env(safe-area-inset-top'), 'the top inset is read')
  ok(stripped.includes('--rm-safe-b: env(safe-area-inset-bottom'), 'and the bottom one')
  ok(
    /\.sidebar\s*\{[^}]*var\(--rm-safe-b\)/.test(stripped),
    'the bottom bar clears the home indicator'
  )
  ok(
    /\.topbar\s*\{[^}]*var\(--rm-safe-t\)/.test(stripped),
    'and the top bar clears the notch'
  )
  ok(
    /\.content\s*\{[^}]*var\(--rm-bar-clear\)/.test(stripped),
    'and the page reserves the height of the fixed bar, or its last row is behind it'
  )

  // Every rule in the phone layer overrides one app.css just made, at the same
  // specificity. Imported first it would lose all of them, silently.
  const main = read('src/renderer/src/main.tsx')
  const appAt = main.indexOf("styles/app.css")
  const mobileAt = main.indexOf("styles/mobile.css")
  ok(mobileAt > -1, 'main.tsx imports the phone layer at all')
  ok(mobileAt > appAt, 'and does it AFTER app.css, or every override loses the cascade')

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
