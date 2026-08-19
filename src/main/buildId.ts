/**
 * WHICH BUILD IS RUNNING — the short commit, or null when nothing says.
 *
 * ## Why the version could not answer this
 *
 * `package.json`'s version is a RELEASE label: it moves when somebody cuts an
 * installer, which is a rare and deliberate act. The web app is the opposite —
 * every push to the deploy branch redeploys it — so a day of shipping produces a
 * dozen different builds all honestly reporting the same version.
 *
 * That is not cosmetic. `docs/RENDER.md` tells the operator to hit `/health` and
 * compare the version to decide whether a deploy landed, and with a label that
 * only moves on release days the answer is identical either way: a deploy that
 * succeeded and a deploy that never happened are indistinguishable, which is
 * exactly the question that endpoint exists to settle. The same is true of the
 * "v0.0.193" in the corner of the app — somebody reading it after a push has no
 * way to tell whether they are looking at their change or at yesterday's.
 *
 * ## Kept SEPARATE from the version, deliberately
 *
 * The obvious move is to fold the commit into the version string. It would break
 * the updater: `isNewer()` in services/updater.ts compares versions as semver to
 * decide whether the feed is offering something newer, and a build suffix makes
 * that comparison meaningless — which is how a browser tab once came to offer a
 * macOS installer it could not use. The version stays a version; this is a
 * second, different fact that sits beside it.
 *
 * ## Where the value comes from
 *
 * `RENDER_GIT_COMMIT` is provided by Render at runtime, so the web app gets this
 * with no configuration at all. `RMOPS_BUILD` is the manual override for any
 * other host. Both absent is the normal case for a desktop build and a local
 * checkout, and the honest answer there is null rather than a guess — those
 * builds are identified by their release label already.
 *
 * Deliberately imports NOTHING. It is read from both the Electron main process
 * and the headless server, and the server aliases 'electron' to a stub, so a
 * module in this path that reached for either would be a cycle waiting to
 * happen.
 */
let cached: string | null | undefined

export function buildId(): string | null {
  if (cached !== undefined) return cached
  const raw = (process.env.RMOPS_BUILD || process.env.RENDER_GIT_COMMIT || '').trim()
  // Seven characters, the length git itself abbreviates to, so it can be pasted
  // straight into `git show` and compared by eye against what was pushed.
  return (cached = raw ? raw.slice(0, 7) : null)
}
