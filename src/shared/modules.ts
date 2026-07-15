import type { Permission } from './permissions'

/**
 * The nine major modules of the RM Operations App. The Admin module is built
 * first; the remaining eight are registered here as "coming soon" so they
 * appear in the navigation and can be filled in one at a time.
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
    id: 'orders',
    name: 'Order & Fulfillment',
    shortName: 'Orders',
    description: 'Track orders from placement through fulfillment.',
    icon: 'PackageCheck',
    permission: 'module.orders',
    status: 'coming-soon'
  },
  {
    id: 'shipping',
    name: 'Shipping & CRM',
    shortName: 'Shipping',
    description: 'Shipment tracking and customer relationships.',
    icon: 'Truck',
    permission: 'module.shipping',
    status: 'coming-soon'
  },
  {
    id: 'bookkeeping',
    name: 'Bookkeeping & Ledger',
    shortName: 'Ledger',
    description: 'Business ledger and day-to-day bookkeeping.',
    icon: 'BookOpen',
    permission: 'module.bookkeeping',
    status: 'coming-soon'
  },
  {
    id: 'invoicing',
    name: 'Invoicing & POs',
    shortName: 'Invoices',
    description: 'Invoice and purchase-order automation.',
    icon: 'ReceiptText',
    permission: 'module.invoicing',
    status: 'coming-soon'
  },
  {
    id: 'accounts',
    name: 'Chart of Accounts',
    shortName: 'Accounts',
    description: 'Chart of accounts and general categorization.',
    icon: 'ListTree',
    permission: 'module.accounts',
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
    description: 'Time tracking and payroll automation.',
    icon: 'Clock',
    permission: 'module.timepay',
    status: 'coming-soon'
  },
  {
    id: 'forecasting',
    name: 'Financial Forecasting',
    shortName: 'Forecast',
    description: 'Model and forecast the financial future.',
    icon: 'TrendingUp',
    permission: 'module.forecasting',
    status: 'coming-soon'
  }
]

export function getModule(id: string): AppModule | undefined {
  return MODULES.find((m) => m.id === id)
}
