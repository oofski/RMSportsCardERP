import type { Permission } from './permissions'

/**
 * The major modules of the RM Operations App. Admin, Inventory and Time &
 * Payroll are built; the rest are registered here as "coming soon" so they
 * appear in the navigation and can be filled in one at a time. Related areas are
 * grouped into single modules — Fulfillment (orders + shipping/CRM) and Finance
 * (bookkeeping/ledger + chart of accounts + forecasting).
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
   */
  workspace?: 'ops' | 'shipping'
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
    description: 'Invoice and purchase-order automation.',
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
  {
    id: 'timepay',
    name: 'Time & Payroll',
    shortName: 'Hours',
    description: 'Your shifts and pay periods; timesheets and Gusto export for leads.',
    icon: 'Clock',
    // NO PERMISSION. Everybody has their own hours and everybody may see them —
    // a packer checking what they are owed is not an administrative act. The
    // TEAM timesheet inside is still gated on admin.hours.view; what changed is
    // that the door is no longer locked to the person whose hours are behind it.
    permission: null,
    status: 'active'
  }
]

/** Modules belonging to a workspace ('ops' is the default for untagged ones). */
export function modulesForWorkspace(workspace: 'ops' | 'shipping'): AppModule[] {
  return MODULES.filter((m) => (m.workspace ?? 'ops') === workspace)
}

export function getModule(id: string): AppModule | undefined {
  return MODULES.find((m) => m.id === id)
}
