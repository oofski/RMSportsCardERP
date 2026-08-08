/**
 * Put a break through the bench so its cards can be ticked.
 *
 * Since the bench checklist landed, `checked_off` cannot be written until the
 * break has been sleeved and sorted — the same gate whether it is a person
 * clicking, "check all", "next order", or packing a package. Suites that are
 * about something else (badge arithmetic, station handoff, queue order) still
 * have to get past it, and doing it through the real domain calls rather than
 * writing the columns directly is the point: a test that reached around the
 * gate would keep passing if the gate broke.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const domain = require('../../src/main/db/shippingDomain')

/** Sleeve and sort ONE break, so its teams may be bagged. */
export function readyBreak(breakId: string, by: string | null = null): void {
  domain.setBreakStep(breakId, 'sleeve', true, by)
  domain.setBreakStep(breakId, 'sort', true, by)
}

/** Sleeve and sort every break in the dataset. */
export function readyAllBreaks(by: string | null = null): void {
  for (const b of domain.listBreaks() as Array<{ id: string }>) readyBreak(b.id, by)
}

/**
 * Bag only the teams NOBODY BOUGHT, leaving the sold cards to be picked by
 * whatever flow the suite is actually testing.
 *
 * Useful where a test drives the picking station itself: the unsold teams are
 * bench work that has to happen for the break to finish, but ticking the sold
 * ones here would pre-empt the very thing under test.
 */
export function bagUnsoldTeams(by: string | null = null): void {
  for (const b of domain.listBreaks() as Array<{ id: string }>) {
    const bench = domain.getBench(b.id)
    for (const r of (bench?.rows ?? []) as Array<{
      teamName: string
      bagged: boolean
      slotId: string | null
    }>) {
      if (!r.slotId && !r.bagged) domain.setTeamBagged(b.id, r.teamName, true, by)
    }
  }
}

/**
 * Everything a package needs before it can be packed: every break it touches
 * off the bench, including the unsold teams nobody bought.
 */
export function finishAllBenches(by: string | null = null): void {
  for (const b of domain.listBreaks() as Array<{ id: string }>) {
    readyBreak(b.id, by)
    const bench = domain.getBench(b.id)
    for (const r of (bench?.rows ?? []) as Array<{ teamName: string; bagged: boolean }>) {
      if (!r.bagged) domain.setTeamBagged(b.id, r.teamName, true, by)
    }
  }
}
