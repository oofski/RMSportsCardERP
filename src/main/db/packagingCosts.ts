/**
 * The inputs the packaging model needs, read out of the two places that hold
 * them: the ledger, and the shipping dataset.
 *
 * `@shared/packagingCosts` owns the rates and the arithmetic and knows nothing
 * about a database. This file is the other half — it answers "how many cards,
 * how many breaks, how big was each break's slate, how many packages" for every
 * business day the P&L covers, and it is where every honesty decision about
 * those counts lives.
 *
 * ## Two sources, and they answer different questions
 *
 * CARDS and BREAKS come from `ledger_rows`. A `sale` row is one break spot is
 * one card, and the break number is already parsed onto the row at import.
 *
 * PACKAGES cannot come from the ledger and the reason is worth stating, because
 * it looks like it should. One ledger order id is one SPOT, not one package: a
 * buyer who took six teams has six rows and six order ids and receives one
 * envelope. The only giveaway trace in the export is a postage deduction whose
 * message carries an order id nothing parses. So packages are read from the
 * shipping module, which is built from the packing slips and therefore knows
 * exactly what went in each envelope.
 *
 * ## Which is why most days cannot answer for packages
 *
 * The shipping workspace holds ONE dataset at a time — the next upload replaces
 * it wholesale. So a package count exists only for the day the loaded dataset
 * belongs to, and every other day genuinely does not know. That is reported as
 * NOT KNOWN and never as zero; zero would read as "nothing shipped that night",
 * which on a break night is a lie the statement would be telling on its own
 * initiative.
 */
import type { Database } from 'better-sqlite3'
import { parseSaleTeamName } from '@shared/financeStreaming'
import { detectSlate } from '../shipping/teams'
import { getDb } from './database'

/**
 * Everything one business day contributes to the packaging model.
 *
 * `packages` is null — not zero — when no shipping dataset covers the day. The
 * distinction survives all the way to the statement.
 */
export interface PackagingDayFacts {
  /** Break spots sold: one `sale` row, one spot, one card. */
  cards: number
  /** Distinct numbered breaks that ran on the day. */
  breaks: number
  /** How many of those had a league the app could actually identify. The rest
   *  are reported as skipped and billed for nothing. */
  breaksPriced: number
  /** Σ over the priced breaks of that break's full slate — 32 for NFL and NHL,
   *  30 for MLB and NBA. This is the unit count for team bags and stickers, and
   *  it is a SLATE rather than what sold: every team in a break is pulled,
   *  bagged and stickered whether or not anybody bought it. */
  slateTeams: number
  /**
   * Physical envelopes that went out, or NULL when no shipping dataset covers
   * this day.
   *
   * NULL IS NOT ZERO and the difference is the whole point. Zero says nothing
   * shipped, which on a night that sold three hundred spots is a claim the app
   * has no business making. Null says the app cannot see the packing slips for
   * that night any more, which is the truth: the shipping workspace holds one
   * dataset and the next upload replaces it.
   */
  packages: number | null
  /**
   * Of those, the ones holding at least one PAID card. Null exactly when
   * `packages` is.
   *
   * Everything else — giveaway-only packages and the occasional package with no
   * cards at all — is `packages - paidPackages`, and the two mailer rates fall
   * out of that split.
   */
  paidPackages: number | null
}

/** A day key the statement can group by. Anything else is not a business day. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The packaging inputs for every business day the ledger knows about.
 *
 * Three reads and no more, because this runs inside `buildView`, which is
 * already the most expensive query in the app. Cards are counted in SQL. Breaks
 * are not, and cannot be: identifying a league means scoring a whole break's
 * worth of team strings against four canonical slates, which is not something
 * SQLite can be asked. So that one read returns rows and the grouping happens
 * here — bounded by the number of `sale` rows, which is the same set already
 * being walked for the fee derivation next door.
 *
 * A day with no `sale` rows is absent from the result entirely rather than
 * present at zero, which is what lets the caller distinguish "no packaging was
 * needed" from "this day was never looked at".
 */
export function packagingFactsByDay(db: Database = getDb()): Map<string, PackagingDayFacts> {
  const out = new Map<string, PackagingDayFacts>()

  // --- cards, from the ledger ------------------------------------------------
  //
  // `bucket = 'sale'` and nothing else. `product_sale` is a sealed box bought
  // outright, which ships in its own wrap and gets no sleeve, no toploader and
  // no team bag — folding it in would put a card's worth of packaging against a
  // case. `sale_reversal` is its own bucket and is deliberately not netted off
  // either: a refunded spot was still pulled, sleeved and bagged before anybody
  // asked for their money back, so the packaging was spent whatever happened to
  // the sale.
  //
  // ATTRIBUTED rows only, matching the money above it in `buildView`. A row with
  // no session is in `unattributed`, has no business day, and must not be able
  // to conjure packaging onto a day it was never assigned to.
  const cardRows = db
    .prepare(
      `SELECT stream_date AS d, COUNT(*) AS cards
         FROM ledger_rows
        WHERE bucket = 'sale' AND stream_date IS NOT NULL
          AND (session_id IS NOT NULL OR attribution = 'own_day')
        GROUP BY stream_date`
    )
    .all() as Array<{ d: string; cards: number }>

  for (const r of cardRows) {
    if (!ISO_DATE.test(r.d)) continue
    out.set(r.d, {
      cards: r.cards,
      breaks: 0,
      breaksPriced: 0,
      slateTeams: 0,
      packages: null,
      paidPackages: null
    })
  }

  // --- breaks, and how big each one's slate was ------------------------------
  //
  // PER BREAK, NOT PER DAY, and that is not a refinement. One night routinely
  // runs a football break and a baseball break back to back, and a day-level
  // detection would give both of them one slate — 32 teams' worth of bags for a
  // 30-team break, or the reverse, on every mixed night the business runs.
  //
  // The league is read off the TEAM NAMES the spots were sold as, because
  // nothing else in the ledger records it: the message carries a listing title
  // and a team, and the listing title says "FINEST FOOTBALL" on some nights and
  // nothing useful on others. `detectSlate` scores every league over the whole
  // break's worth of names at once, so one odd string cannot swing it.
  //
  // A break with NO break number contributes nothing here, which is correct
  // rather than a gap: a `sale` row with no number is a numbered lot ("... #7"),
  // one pack out of a box being sold a pack at a time. There is no slate to bag
  // for it. Its card still counts above, because it still gets a sleeve.
  const breakRows = db
    .prepare(
      `SELECT stream_date AS d, break_number AS n, message
         FROM ledger_rows
        WHERE bucket = 'sale' AND stream_date IS NOT NULL AND break_number IS NOT NULL
          AND (session_id IS NOT NULL OR attribution = 'own_day')`
    )
    .all() as Array<{ d: string; n: number; message: string }>

  /** date -> break number -> the team strings that break sold. */
  const teamsByBreak = new Map<string, Map<number, string[]>>()
  for (const r of breakRows) {
    if (!ISO_DATE.test(r.d)) continue
    const day = teamsByBreak.get(r.d) ?? new Map<number, string[]>()
    const names = day.get(r.n) ?? []
    // '' for a message with no team on the tail. Kept OUT of the candidate list
    // rather than pushed as an empty string: `detectSportDetailed` skips blanks
    // anyway, and a list whose length no longer means "spots with a team on
    // them" is a list somebody will eventually read the wrong way.
    const team = parseSaleTeamName(r.message)
    if (team) names.push(team)
    day.set(r.n, names)
    teamsByBreak.set(r.d, day)
  }

  for (const [date, breaks] of teamsByBreak) {
    const facts = out.get(date)
    // Every day here has `sale` rows, so it was created by the loop above.
    if (!facts) continue
    for (const [, names] of breaks) {
      facts.breaks += 1
      const slate = detectSlate(names)
      // NOT DEFAULTED. `detectSlate` returns null rather than guessing, and the
      // guess it is refusing to make is 32 — which would be a plausible figure
      // in the right column with nothing anywhere to say it was invented. The
      // break is counted as run and priced at nothing, and the statement says
      // how many it skipped.
      if (!slate) continue
      facts.breaksPriced += 1
      facts.slateTeams += slate.slateSize
    }
  }

  // --- packages, from the shipping dataset -----------------------------------
  //
  // ONE DAY, AT MOST. `ship_event.date` is the day the operator assigned to the
  // dataset currently loaded in the shipping workspace, and that workspace holds
  // exactly one dataset — the next upload overwrites `ship_team_slots` and
  // `ship_shipments` wholesale. So this can answer for that day and no other,
  // and every other day's package count stays null.
  //
  // That looks like a limitation and is really the honest reading. The counts
  // are not recorded per day anywhere; there is no history table to consult.
  // Inventing one from an average, or carrying the last known figure forward,
  // would put a made-up cost on a real night.
  //
  // `ship_event.date` rather than `ship_breaks.event_date` deliberately: it is
  // the day the operator ASSIGNED the show to, which is the same day the ledger
  // rows for that night land on, so the envelopes and the cards they held can
  // never be booked to two different days. A blank event date means the dataset
  // is not assigned to a day yet, and then nothing here answers for anything —
  // which is the safe direction to be wrong in, because these figures are now
  // inside net profit and a mis-keyed one would move a bottom line.
  const eventDate = String(
    (db.prepare(`SELECT date FROM ship_event WHERE id = 1`).get() as { date?: string } | undefined)
      ?.date ?? ''
  ).trim()

  if (ISO_DATE.test(eventDate)) {
    // ONE ROW PER PACKAGE, counted off `ship_shipments` — the table that IS one
    // row per customer envelope. Counting distinct customers on the slot table
    // instead would silently drop a package holding no cards, which is rare but
    // real and still costs a label and a mailer.
    //
    // A package is GIVEAWAY-ONLY when every one of its slots is a giveaway, and
    // PAID when at least one is not. That is the owner's rule stated literally,
    // and it is why this cannot come from the ledger: one ledger order id is one
    // SPOT, so a buyer who took six teams looks like six orders and receives one
    // envelope.
    const packageRows = db
      .prepare(
        `SELECT COUNT(*) AS packages,
                COALESCE(SUM(CASE WHEN paid > 0 THEN 1 ELSE 0 END), 0) AS paid
           FROM (SELECT sh.id AS id,
                        (SELECT COUNT(*) FROM ship_team_slots sl
                          WHERE sl.customer_id = sh.customer_id
                            AND sl.is_giveaway = 0) AS paid
                   FROM ship_shipments sh)`
      )
      .get() as { packages: number; paid: number }

    // A dataset with no packages in it is not a dataset — it is an empty
    // workspace with a date typed into it, or a show whose slips have already
    // been replaced while the date lingered. Reporting "0 packages" for that day
    // would be the exact false zero this whole block exists to avoid, so it
    // stays unknown.
    if (packageRows.packages > 0) {
      const facts = out.get(eventDate) ?? {
        cards: 0,
        breaks: 0,
        breaksPriced: 0,
        slateTeams: 0,
        packages: null,
        paidPackages: null
      }
      facts.packages = packageRows.packages
      facts.paidPackages = packageRows.paid
      out.set(eventDate, facts)
    }
  }

  return out
}
