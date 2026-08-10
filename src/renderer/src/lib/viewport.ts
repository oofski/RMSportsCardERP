/**
 * The one place the phone breakpoint is written down.
 *
 * ONE renderer bundle serves the Electron desktop app and the web app, and the
 * web app is now installed to a phone's home screen. Everything that makes the
 * app usable there lives in styles/mobile.css, behind a single media query. The
 * number below is that query's width, and it exists in TypeScript as well
 * because a handful of behaviours (see AppShell's bottom-bar scroll) have to
 * agree with the layout the CSS chose.
 *
 * ## Why 820, and why the desktop cannot reach it
 *
 * The Electron window is created with `minWidth: 1040` (src/main/index.ts), so
 * a desktop window is never narrower than 1040 CSS pixels and a
 * `max-width: 820px` rule can never match there. That is the structural
 * guarantee the mobile layer rests on: it is not that the rules are written
 * carefully enough to leave the desktop alone, it is that they are unreachable
 * from it.
 *
 * 820 rather than 640 because it also takes in a phone held sideways (844 on
 * the newer iPhones is over it, 736–812 on everything else is under) and an
 * iPad in portrait at 768 or 810 — all of which want the stacked layout far
 * more than they want a 244px sidebar eating a third of the screen. Rules that
 * only make sense on a genuinely small screen may nest a narrower query inside;
 * nothing may use a WIDER one, or it would start reaching the desktop.
 *
 * The one way a desktop window can see these rules is somebody zooming the app
 * in past ~130%, which shrinks the CSS viewport. That is a layout that has
 * already given up on the sidebar, so getting the phone one is the better
 * outcome rather than a bug.
 */
export const PHONE_MAX_WIDTH = 820

/** The media query styles/mobile.css opens with. Kept here so the two cannot drift. */
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`

/**
 * Is a viewport this wide getting the phone layout?
 *
 * Inclusive at the boundary, because `max-width: 820px` is. A width that is not
 * a real measurement — NaN from an unmeasurable element, a negative from a
 * window mid-teardown — is answered "no": guessing "phone" there would run
 * phone-only behaviour on a desktop, and the whole point of this file is that
 * that cannot happen.
 */
export function isPhoneWidth(width: number): boolean {
  if (!Number.isFinite(width) || width < 0) return false
  return width <= PHONE_MAX_WIDTH
}
