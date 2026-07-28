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
    description: 'Bookkeeping, business ledger, chart of accounts and financial forecasting.',
    icon: 'Wallet',
    permission: 'module.finance',
    status: 'coming-soon'
  },
  {
    id: 'sops',
    name: 'SOP Creation',
    shortName: 'SOPs',
    description: 'Author and manage standard operating procedures.',
    icon: 'ClipboardList',
    permission: 'module.sops',
    status: 'coming-soon'
  },
  {
    id: 'timepay',
    name: 'Time & Payroll',
    shortName: 'Payroll',
    description: 'Timesheets, pay periods and Gusto export.',
    icon: 'Clock',
    permission: 'admin.hours.view',
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
