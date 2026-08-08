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
  {
    id: 'invoicing',
    name: 'Invoicing & POs',
    shortName: 'Invoices',
    description: 'What we owe suppliers, and what buyers owe us.',
    icon: 'ReceiptText',
    permission: 'module.invoicing',
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
  },
  // TWO DOORS, not one, and the split is by QUESTION rather than by data.
  //
  // "What am I owed" and "when am I in" were behind the same tab because they
  // are both about time, which is a filing decision rather than a use one.
  // Nobody opens an app to think about time; they open it to check their pay,
  // or to find out whether they are working Thursday. Those are asked on
  // different days, by different people, for different reasons — and one of
  // them is now a place the floor WRITES to rather than only reads, which a tab
  // called "Hours" gives no hint of.
  {
    id: 'timepay',
    name: 'Pay',
    shortName: 'Pay',
    description: 'Your hours and what each pay period came to.',
    // NOT Wallet — Finance already has it, and two identical icons in one
    // sidebar is a sidebar somebody has to read rather than glance at.
    icon: 'DollarSign',
    // NO PERMISSION. Everybody has their own hours and everybody may see them —
    // a packer checking what they are owed is not an administrative act. The
    // TEAM timesheet inside is still gated on admin.hours.view; what changed is
    // that the door is no longer locked to the person whose hours are behind it.
    permission: null,
    status: 'active',
    // Yours, not either business's — see the note on AppModule.workspace.
    workspace: 'both'
  },
  {
    id: 'schedule',
    name: 'Schedule',
    shortName: 'Schedule',
    description: 'When you are in, and the days you can and cannot work.',
    icon: 'CalendarDays',
    // No permission, for a stronger reason than Pay's. This is the one screen in
    // the app the floor WRITES to about themselves, and the failure mode of an
    // availability system is that nobody fills it in. A door somebody has to be
    // granted is a door that goes back to being a text message.
    permission: null,
    status: 'active',
    // Yours, not either business's — see the note on AppModule.workspace.
    workspace: 'both'
  }
]

/** Whether a module shows in a given workspace's sidebar. */
export function inWorkspace(module: AppModule, workspace: 'ops' | 'shipping'): boolean {
  const home = module.workspace ?? 'ops'
  return home === 'both' || home === workspace
}

/** Modules belonging to a workspace ('ops' is the default for untagged ones). */
export function modulesForWorkspace(workspace: 'ops' | 'shipping'): AppModule[] {
  return MODULES.filter((m) => inWorkspace(m, workspace))
}

export function getModule(id: string): AppModule | undefined {
  return MODULES.find((m) => m.id === id)
}
