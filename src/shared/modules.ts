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
    name: 'Fulfillment',
    shortName: 'Fulfillment',
    description: 'Orders, fulfillment, shipment tracking and customer relationships.',
    icon: 'PackageCheck',
    permission: 'module.fulfillment',
    status: 'coming-soon'
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

export function getModule(id: string): AppModule | undefined {
  return MODULES.find((m) => m.id === id)
}
