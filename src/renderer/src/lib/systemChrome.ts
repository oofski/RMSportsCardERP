/**
 * The two things the renderer still has to say about colour.
 *
 * This file is what is left of the old theme module. The app had a light and a
 * dark palette, a toggle in the top bar, a stored preference and a system
 * fallback; it now has exactly one palette (see styles/theme.css) and no way to
 * ask for another. Two jobs survived that removal, and both of them are about
 * the pixels the APP does not own — the strip the phone's operating system
 * paints around it, and a preference left behind on machines that had the
 * toggle.
 *
 * Called once from main.tsx before React mounts. Deliberately not a provider and
 * not a hook: nothing renders differently because of it, so there is no state
 * for a component to read and nothing to re-render when it runs.
 */

/** The key the old toggle wrote its preference to. Read by nothing now. */
const LEGACY_THEME_KEY = 'rmops-theme'

/**
 * Undo dark mode on a machine that was already in it.
 *
 * This is the part of the removal that outlives the feature. Every operator who
 * ever pressed the toggle has `rmops-theme: dark` sitting in localStorage, and
 * on the build they are running right this second that string is what puts
 * `data-theme="dark"` on <html> at startup. Nothing in this build reads either
 * one — which is exactly why they are dangerous rather than merely untidy: the
 * stale preference is invisible, it survives an update, and the first thing to
 * key off it again inherits an answer given long ago to a question this app no
 * longer asks. The screen it produces is half-repainted rather than obviously
 * broken, and the only fix an operator can find alone is clearing site data,
 * which on the web app also signs them out.
 *
 * So the key is DELETED rather than ignored. The attribute is removed in the
 * same breath: within one document load nothing writes it any more, so this is
 * usually a no-op, but it costs a single call and it turns "no code sets this"
 * from an assumption spread across the bundle into a fact asserted here, before
 * the first render.
 */
function evictDarkMode(): void {
  document.documentElement.removeAttribute('data-theme')
  try {
    localStorage.removeItem(LEGACY_THEME_KEY)
  } catch {
    // Private mode, or storage disabled. Nothing reads the key either way.
  }
}

/**
 * Repaint the system chrome around an installed web app.
 *
 * On an iPhone running this from the Home Screen, `theme-color` is the colour
 * iOS fills the notch strip and the home-indicator strip with — the two bands
 * this app deliberately draws its top bar and its bottom navigation into (see
 * styles/mobile.css). Get it wrong and the app has a coloured band above it
 * that belongs to no element on the page.
 *
 * index.html carries the same value statically, because the tag has to be right
 * before any script runs or the bands flash. This re-reads it from --surface
 * once the stylesheet is loaded so the two cannot drift: the static tag is a
 * hex nobody would think to update when theme.css is retuned, and this is the
 * copy that is definitionally correct. A no-op in Electron, which has real
 * window chrome and never reads this tag.
 */
function paintSystemChrome(): void {
  const tag = document.querySelector('meta[name="theme-color"]')
  if (!tag) return
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()
  if (surface) tag.setAttribute('content', surface)
}

export function initSystemChrome(): void {
  evictDarkMode()
  paintSystemChrome()
}
