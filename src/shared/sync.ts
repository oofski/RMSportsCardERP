/**
 * Types for cloud sync — shared by the main process, the preload bridge and
 * the renderer.
 *
 * The model, in one paragraph: every laptop keeps its own complete SQLite
 * database and never stops working when the internet does. A tiny Cloudflare
 * Worker in front of a D1 database acts as a relay — each laptop pushes the
 * rows it changed and pulls the rows everyone else changed, every few seconds.
 * Nothing runs the business but the laptops; the Worker only carries rows.
 *
 * That is deliberately NOT "one central database with thin clients". A central
 * database needs a machine that is always on, reachable from every location,
 * and whose outage stops all work. A relay needs neither, costs nothing while
 * idle, and degrades to "you are working on yesterday's data" instead of
 * "nobody can work".
 */

/** How the local app is configured to talk to the relay. */
export interface SyncConfig {
  /** Worker origin, e.g. https://rm-operations.<subdomain>.workers.dev */
  url: string
  /** This machine's name in the change log — "Front counter", "Sid's Mac". */
  device: string
  /** Seconds between sync rounds. */
  intervalSeconds: number
  /** Master switch. Off means fully standalone, exactly as before. */
  enabled: boolean
}

/**
 * What the settings screen is allowed to see.
 *
 * The shared key is deliberately absent: it is write-only from the UI's point
 * of view. A screen that can display it is a screen that can leak it over a
 * shoulder or a screen-share, and nothing in the UI needs its value — only
 * whether one is set.
 */
export interface SyncConfigView extends SyncConfig {
  keySet: boolean
  /** Last 4 characters, so someone can tell two keys apart without seeing either. */
  keyHint: string
}

export type SyncPhase = 'off' | 'idle' | 'pushing' | 'pulling' | 'error' | 'unconfigured'

export interface SyncStatus {
  phase: SyncPhase
  config: SyncConfigView
  /** Rows waiting to go up. */
  pending: number
  /** How far through the relay's change log this machine has read. */
  cursor: number
  lastPushAt: string | null
  lastPullAt: string | null
  /** Rows pulled in the most recent round that actually changed something. */
  lastPulledRows: number
  lastError: string | null
  /** Consecutive failed rounds — drives the backoff and the UI's severity. */
  failures: number
  /** Rows the relay sent that this database refused; they need a human. */
  rejects: number
  /** Server-side row count and cursor, when the last round reached it. */
  remoteRows: number | null
  remoteCursor: number | null
}

/** One row the relay refused to let in. Surfaced so it is never silent. */
export interface SyncReject {
  kind: string
  id: string
  seq: number
  reason: string
  at: string
}

// ---------------------------------------------------------------------------
// Public intake (the customer-facing form)
// ---------------------------------------------------------------------------

/** A public form link. One per event; revocable; never guessable. */
export interface IntakeLink {
  id: string
  token: string
  label: string
  eventName: string
  eventDate: string | null
  active: boolean
  createdAt: string
  createdBy: string | null
  /** Full public URL, assembled from the configured Worker origin. */
  url: string
  /** How many submissions have come in, and how many still need review. */
  submissions: number
  newSubmissions: number
}

export type IntakeStatus = 'new' | 'accepted' | 'rejected'

/**
 * One customer submission.
 *
 * These land in their own table and are reviewed by a person before anything
 * operational changes. The form is unauthenticated by necessity — customers do
 * not have logins — and an unauthenticated write that could edit a real
 * customer's shipping address is a way to have someone else's cards mailed to
 * you. Review is the control that makes a public form safe here.
 */
export interface IntakeSubmission {
  id: string
  linkId: string
  linkLabel: string
  handle: string
  realName: string
  email: string
  phone: string
  address1: string
  address2: string
  city: string
  state: string
  postalCode: string
  country: string
  request: string
  status: IntakeStatus
  statusNote: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  createdAt: string
  /** Set when accepting created or updated a shipping customer. */
  customerId: string | null
}

export interface IntakeLinkInput {
  label: string
  eventName: string
  eventDate: string | null
}
