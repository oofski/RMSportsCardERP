/**
 * A SHOW — one stream, one packing slip, one night's worth of breaks.
 *
 * ## Why this exists
 *
 * The workspace was built around one upload at a time, and that was true of the
 * business for exactly as long as the business ran one stream a night. It does
 * not any more: a Saturday can be two streams, and a bench can be working
 * Thursday's slips and Saturday's at the same time. Uploading the second slip
 * threw the first one away.
 *
 * So a show becomes a thing with a name. It is not a new table — it is the
 * PDF the breaks came out of — but it needs an identity, because everything
 * that identifies a break inside one slip repeats in the next one:
 *
 *   Break #4 on Thursday and Break #4 on Saturday are different breaks.
 *   The same buyer appears in both. The same team is sold in both.
 *
 * ## What is per-show and what is not
 *
 * A BREAK belongs to exactly one show — it is a thing that happened at a time,
 * on a stream. So do the cards in it and the orders that bought them.
 *
 * A BUYER does not. One person who bought in Thursday's stream and Saturday's
 * gets ONE box with both nights' cards in it, which is what the floor already
 * does and what the customer already expects. So customers and their packages
 * stay keyed by the handle alone and are deliberately SHARED across the shows
 * loaded together.
 *
 * That split is the whole design. Everything below follows from it.
 */

import type {
  ShipBreakDraft,
  ShipCustomer,
  ShipOrder,
  ShipShipmentDraft,
  ShipTeamSlotDraft,
  ShipWarningInput,
  ShippingDataset
} from './shippingTypes'

/**
 * The separator between a break's own id and the show it ran in.
 *
 * `~` and not `_` or `-`: break labels are operator-typed and routinely contain
 * both ("11A", "MLB-2"), and an id that can be split two ways cannot be split
 * at all. `~` appears in no label the parser has ever produced.
 *
 * It goes on the END so that `giveaway_<handle>` still starts with `giveaway_`
 * and `break_<label>` still starts with `break_` — screens test those prefixes
 * to tell a real break from a promo rider, and a leading token would silently
 * turn every one of those tests false.
 */
export const SHOW_SEP = '~'

/** `break_4` in show `s2` becomes `break_4~s2`. An empty show is a no-op. */
export function scopeToShow(id: string, showId: string): string {
  const raw = String(id ?? '')
  const show = String(showId ?? '').trim()
  if (!show || !raw) return raw
  // Already scoped — re-scoping would nest the token and break the round trip.
  return raw.includes(SHOW_SEP) ? raw : `${raw}${SHOW_SEP}${show}`
}

/** The show an id was scoped to, or null when it carries none. */
export function showOfId(id: string): string | null {
  const raw = String(id ?? '')
  const at = raw.indexOf(SHOW_SEP)
  return at === -1 ? null : raw.slice(at + SHOW_SEP.length) || null
}

/** The id without its show — what the slip actually printed. */
export function unscopedId(id: string): string {
  const raw = String(id ?? '')
  const at = raw.indexOf(SHOW_SEP)
  return at === -1 ? raw : raw.slice(0, at)
}

/**
 * One show in the workspace, as the bench groups by.
 *
 * `id` is what break ids are scoped with. `date` and `name` come off the upload;
 * `stream` distinguishes two shows that share both, which is the case this whole
 * file exists for — a Saturday that ran a morning stream and an evening one.
 */
export interface ShipShow {
  id: string
  name: string
  /** ISO `YYYY-MM-DD`, or empty when the upload named no date. */
  date: string
  /** 1 for the only show on its date, 2 for the second stream, and so on. */
  stream: number
  /** How many shows ran on this date. 1 means the stream number is not shown. */
  streamsOnDate: number
  /** The file it came out of, for the operator to recognise it by. */
  filename: string
}

/**
 * What a show is CALLED on screen.
 *
 * The date first, because a bench working two nights is sorting by night. The
 * stream number appears only when there is another show on the same date to
 * tell it apart from — a lone Thursday show reading "Thursday · stream 1" is
 * noise about a distinction that does not exist.
 */
export function showLabel(show: ShipShow): string {
  const parts: string[] = []
  if (show.name.trim()) parts.push(show.name.trim())
  else if (show.date) parts.push(show.date)
  else if (show.filename) parts.push(show.filename)
  else parts.push('Show')
  if (show.streamsOnDate > 1) parts.push(`stream ${show.stream}`)
  return parts.join(' · ')
}

/** One parsed slip, waiting to be merged with the others in the same upload. */
export interface ParsedShow {
  /** Stable within one merge — the caller supplies it (an index is enough). */
  id: string
  filename: string
  dataset: ShippingDataset
}

export interface MergedUpload {
  dataset: ShippingDataset
  shows: ShipShow[]
}

/**
 * Merge several parsed slips into ONE workspace.
 *
 * The rules, in the order they matter:
 *
 *  1. Every break, card and order is re-keyed into its show, so two shows that
 *     both ran a "#4" stay two breaks. Without this the second show's #4 hits
 *     the first one's primary key and the import dies — or worse, merges, and
 *     the bench is told to pull forty cards for a break that sold twenty.
 *
 *  2. Buyers are merged, not duplicated. The LAST slip wins on the address,
 *     because a buyer who moved between Thursday and Saturday moved: the newer
 *     slip is the newer truth. Their page list is unioned so the picker can
 *     still open either slip.
 *
 *  3. Packages are merged the same way, and the FIRST one wins on everything
 *     the floor has touched — tracking, weight, hold, notes. A second slip is
 *     not a reason to forget that somebody already weighed the box.
 *
 *  4. The event on the merged dataset is the FIRST show's. It is a single field
 *     and several shows are now in play, so it can only ever be one of them;
 *     the per-break event name and date are what the screens actually group by.
 *
 * Pure: it reads N datasets and returns one. Nothing here touches the store.
 */
export function mergeShows(parsed: ParsedShow[]): MergedUpload {
  const shows: ShipShow[] = []
  const breaks: ShipBreakDraft[] = []
  const teamSlots: ShipTeamSlotDraft[] = []
  const orders: ShipOrder[] = []
  const warnings: ShipWarningInput[] = []
  const customers = new Map<string, ShipCustomer>()
  const shipments = new Map<string, ShipShipmentDraft>()

  // Stream numbers are per DATE, so they have to be counted before any show is
  // labelled — the second Saturday stream is only "stream 2" once both exist.
  const onDate = new Map<string, number>()
  for (const p of parsed) {
    const date = String(p.dataset.event?.date ?? '').trim()
    onDate.set(date, (onDate.get(date) ?? 0) + 1)
  }
  const seenOnDate = new Map<string, number>()

  for (const p of parsed) {
    const ds = p.dataset
    const date = String(ds.event?.date ?? '').trim()
    const stream = (seenOnDate.get(date) ?? 0) + 1
    seenOnDate.set(date, stream)
    const show: ShipShow = {
      id: p.id,
      name: String(ds.event?.name ?? '').trim(),
      date,
      stream,
      streamsOnDate: onDate.get(date) ?? 1,
      filename: p.filename
    }
    shows.push(show)

    for (const b of ds.breaks) {
      breaks.push({
        ...b,
        id: scopeToShow(b.id, show.id),
        showId: show.id,
        // Written onto the break so a screen can group without holding the
        // show list, and so a break keeps its own night after the workspace
        // has moved on.
        eventName: String(b.eventName ?? '').trim() || show.name,
        eventDate: String(b.eventDate ?? '').trim() || show.date
      })
    }

    for (const s of ds.teamSlots) {
      teamSlots.push({
        ...s,
        id: scopeToShow(s.id, show.id),
        breakId: scopeToShow(s.breakId, show.id)
      })
    }

    for (const o of ds.orders) {
      orders.push({
        ...o,
        id: scopeToShow(o.id, show.id),
        breakId: scopeToShow(o.breakId, show.id)
      })
    }

    for (const c of ds.customers) {
      const prev = customers.get(c.id)
      customers.set(
        c.id,
        prev
          ? {
              ...c,
              // A buyer is only NEW if no slip in the upload has seen them
              // before. Two slips disagreeing means the earlier one knew them.
              isNew: prev.isNew && c.isNew,
              pages: [...new Set([...(prev.pages ?? []), ...(c.pages ?? [])])].sort(
                (a, b) => a - b
              )
            }
          : c
      )
    }

    for (const sh of ds.shipments) {
      if (!shipments.has(sh.id)) shipments.set(sh.id, sh)
    }

    for (const w of ds.warnings) warnings.push(w)
  }

  const first = parsed[0]?.dataset
  return {
    shows,
    dataset: {
      event: {
        name: String(first?.event?.name ?? '').trim(),
        date: String(first?.event?.date ?? '').trim()
      },
      sport: first?.sport ?? null,
      breaks,
      customers: [...customers.values()],
      teamSlots,
      shipments: [...shipments.values()],
      orders,
      // Regenerated by the store from the merged shipment list — a per-slip
      // batch of tracking URLs describes one slip's packages and would be a
      // partial answer here.
      batchUrls: [],
      /**
       * The audit follows its break. Only the ID moves — the LABEL is what the
       * screen prints, and "#4~s2" is not what the slip said. This is the whole
       * reason the audit was re-keyed off the label: two shows both have a #4,
       * and one of the two slates was landing on the other's primary key.
       */
      breakAudit: parsed.flatMap((p) =>
        p.dataset.breakAudit.map((a) => ({ ...a, breakId: scopeToShow(a.breakId, p.id) }))
      ),
      warnings
    }
  }
}
