import type { Permission } from './permissions'

/**
 * The major modules of the RM Operations App. Related areas are grouped into
 * single modules — Fulfillment (orders + shipping/CRM) and Finance
 * (bookkeeping/ledger + chart of accounts + forecasting) — except where two
 * things share a subject but not a QUESTION, which is why Pay and Schedule are
 * two doors rather than one tab called Hours.
 */
export interface AppModule {
  id: string
  name: string
  /** Compact label for tight spaces. */
  shortName: string
  description: string
  /** lucide-react icon name, resolved in the renderer. */
  icon: string
  /** Permission required to open the module. null = always available. */
  permission: Permission | null
  status: 'active' | 'coming-soon'
  /**
   * Which workspace the module belongs to. 'ops' is the day-to-day operations
   * business; 'shipping' is the RM Cardz Shipping (break fulfilment) business,
   * which is a separate workflow with its own people and its own screens.
   * Defaults to 'ops' when omitted.
   *
   * 'both' is for the modules that are about the PERSON rather than either
   * business — your pay and your schedule. Filing those under one workspace
   * would mean somebody working the packing floor has to switch companies to
   * find out what they are owed, which is the sort of friction that ends with
   * them asking a lead instead of opening the app.
   */
  workspace?: 'ops' | 'shipping' | 'both'
}

export const MODULES: AppModule[] = [
  {
    /**
     * TEAM: the people, and the two things everybody asks about themselves.
     *
     * Contacts, Pay and Schedule were three doors in the sidebar. They are one
     * subject — who works here, what they are owed, when they are in — and three
     * entries spent three slots of a list somebody has to read at eight in the
     * morning while the answer to "where is Ada's number" and "when am I in"
     * lived two apart.
     *
     * ## Why these three and not, say, Performance
     *
     * Every tab here is about a PERSON and is mostly about the person looking at
     * it. Performance is a report ABOUT people for whoever runs the floor, which
     * is a different question with a different audience and a different
     * permission; folding it in would have put a table comparing packers one tap
     * from the packers it compares.
     *
     * ## The permission is on the TABS, not the door
     *
     * `permission: null`, because two of the three tabs have no permission
     * either — your own pay and your own availability are yours. Contacts needs
     * `module.messages`, which everybody has. So the door is open to everyone
     * and each tab decides for itself; a role that somehow held none of them
     * would see the module with nothing in it, which is why TEAM_TABS is
     * filtered rather than assumed.
     */
    id: 'team',
    name: 'Team',
    shortName: 'Team',
    description: 'Who works here, what they are owed, and when they are in.',
    icon: 'Users',
    permission: null,
    status: 'active',
    // BOTH workspaces. A packer needs to reach the office and check their own
    // hours without switching companies to do it.
    workspace: 'both'
  },
  {
    id: 'admin',
    name: 'Admin',
    shortName: 'Admin',
    description: 'Employees, hours, roles and permissions.',
    icon: 'ShieldCheck',
    permission: 'admin.access',
    status: 'active'
  },
  {
    id: 'inventory',
    name: 'Inventory',
    shortName: 'Inventory',
    description: 'Cards, boxes and cases — stock, value and sales.',
    icon: 'Boxes',
    permission: 'module.inventory',
    status: 'active'
  },
  {
    id: 'fulfillment',
    name: 'Shipping',
    shortName: 'Shipping',
    description: 'Break packing slips, pick lists, package queue and shipment tracking.',
    icon: 'PackageCheck',
    permission: 'module.fulfillment',
    status: 'active',
    // Lives in its own workspace: break fulfilment is a separate business from
    // day-to-day operations, so it should not sit in the Operations sidebar.
    workspace: 'shipping'
  },
  {
    id: 'streaming',
    name: 'Streaming',
    shortName: 'Streaming',
    description: 'Show sessions, what was broken on them, and giveaways.',
    icon: 'CircleDot',
    permission: 'module.streaming',
    status: 'active'
  },
  // TWO MODULES, not one with a tab strip. A purchase order is money owed to a
  // supplier and an invoice is money owed to us — mirror images, and never
  // asked about in the same breath. Sharing a door meant the sell side was
  // always one extra click away and looked like a footnote to the buy side.
  //
  // The PO module keeps the id `invoicing` so every existing `navigate()` call
  // and every saved sidebar position still lands where it did.
  {
    id: 'invoicing',
    name: 'Purchase Orders',
    shortName: 'POs',
    description: 'What we have ordered from suppliers, and what we owe on it.',
    icon: 'ClipboardList',
    permission: 'module.invoicing',
    status: 'active'
  },
  {
    id: 'invoices',
    // DISPLAY ONLY. The id, the permission and every table behind this stay
    // `invoices` — the owner renamed what the screen is CALLED, not what it is.
    // Renaming the id would orphan saved nav state and every reference to it
    // for a change nobody asked for.
    name: 'Sales Orders',
    shortName: 'Sales Orders',
    description: 'Billing buyers: who they are, what they bought, and who has paid.',
    icon: 'ReceiptText',
    // The same permission the buy side uses. Somebody who may commit this
    // business to paying a supplier may also bill a buyer; splitting it would
    // invent a role that can spend but not collect, which is nobody's job.
    permission: 'module.invoicing',
    status: 'active'
  },
  // How long the work takes, and who did it.
  //
  // Its own door rather than a tab inside Shipping, and gated on 'admin.access'
  // rather than on any shipping permission, because it is a report ABOUT PEOPLE
  // rather than a tool for doing the work. Somebody at a packing bench needs the
  // pick list; they do not need — and should not casually find — a table
  // comparing their team-bagging against the person next to them, on numbers
  // that cannot say who was helping.
  //
  // Ops workspace, deliberately, for the same reason: it belongs where the
  // timesheets are, not where the night's work is.
  {
    id: 'performance',
    name: 'Performance',
    shortName: 'Performance',
    description: 'How long each step of the night takes, and who did it.',
    icon: 'Gauge',
    permission: 'admin.access',
    status: 'active'
  },
  {
    id: 'finance',
    name: 'Finance',
    shortName: 'Finance',
    description: 'Streaming, wholesale and the complete P&L.',
    icon: 'Wallet',
    permission: 'module.finance',
    status: 'active'
  }
]

/**
 * What lives inside Team, in the order it is drawn.
 *
 * These were three top-level modules — `contacts`, `timepay`, `schedule` — and
 * the ids are UNCHANGED on purpose. Every `navigate('timepay')` in the app, and
 * any position somebody's browser remembered, still names something real; the
 * shell translates the id into "Team, on that tab" rather than every call site
 * being rewritten to know about the regrouping.
 *
 * The permission is per tab because the door has none. Two of these are yours
 * by definition — your pay, your availability — and Contacts needs
 * `module.messages`, which every role holds.
 */
export interface TeamTab {
  id: string
  label: string
  icon: string
  description: string
  permission: Permission | null
}

export const TEAM_TABS: TeamTab[] = [
  {
    id: 'contacts',
    label: 'Contacts',
    icon: 'Users',
    description: 'Everybody who works here, and the conversations you are in.',
    permission: 'module.messages'
  },
  {
    id: 'timepay',
    label: 'Pay',
    icon: 'DollarSign',
    description: 'Your hours and what each pay period came to.',
    // NO PERMISSION. A packer checking what they are owed is not an
    // administrative act. The TEAM timesheet inside is still gated on
    // admin.hours.view; what is open is the door to your own figures.
    permission: null
  },
  {
    id: 'schedule',
    label: 'Schedule',
    icon: 'CalendarDays',
    description: 'When you are in, and the days you can and cannot work.',
    // No permission, for a stronger reason than Pay's. This is the one screen
    // the floor WRITES to about themselves, and the failure mode of an
    // availability system is that nobody fills it in.
    permission: null
  }
]

/**
 * The Team tab a module id names, or null if it names something else.
 *
 * This is what keeps `navigate('timepay')` working now that Pay is a tab rather
 * than a door. Returning null for everything else is what lets the caller use
 * it as a plain test.
 */
export function teamTabFor(moduleId: string): string | null {
  return TEAM_TABS.some((t) => t.id === moduleId) ? moduleId : null
}

/** Whether a module shows in a given workspace's sidebar. */
export function inWorkspace(module: AppModule, workspace: 'ops' | 'shipping'): boolean {
  const home = module.workspace ?? 'ops'
  return home === 'both' || home === workspace
}

/**
 * Modules belonging to a workspace ('ops' is the default for untagged ones).
 *
 * Every module in this file is a place the WORK happens and every one of them
 * is drawn. My account used to be an exception — a module marked hidden,
 * reachable only from the name menu — and carrying a flag for one entry was
 * worse than the thing it bought: it is not a screen at all now, it is a panel
 * the shell opens over whatever you were doing. See AccountPanel.
 */
export function modulesForWorkspace(workspace: 'ops' | 'shipping'): AppModule[] {
  return MODULES.filter((m) => inWorkspace(m, workspace))
}

export function getModule(id: string): AppModule | undefined {
  return MODULES.find((m) => m.id === id)
}
