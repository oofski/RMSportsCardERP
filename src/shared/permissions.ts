/**
 * Role-based access control (RBAC) for the RM Operations App.
 *
 * Owner, Operations, Staff and Shipping. Each role grants a set of permissions.
 * As new modules are built, add their permission keys here and grant them to the
 * appropriate roles; the UI reads exclusively from this file, so access rules
 * stay in one place.
 */

export type Role = 'owner' | 'operations' | 'staff' | 'shipping' | 'breaker'

export interface RoleDefinition {
  id: Role
  label: string
  description: string
  /** Higher rank = more authority. Used to decide who may assign which role. */
  rank: number
}

export const ROLES: RoleDefinition[] = [
  {
    id: 'owner',
    label: 'Owner',
    description: 'Full access to every module and all administrative controls.',
    rank: 3
  },
  {
    id: 'operations',
    label: 'Operations',
    description: 'Runs day-to-day operations. Manages staff and most modules.',
    rank: 2
  },
  {
    id: 'staff',
    label: 'Staff',
    description: 'Access to assigned modules and their own information.',
    rank: 1
  },
  // A sibling of Staff, not a rung below it — same rank, a different job. The
  // people at the packing computers work the picking and packing bench, and
  // that is the whole of it; ranking them lower would only mean Staff could
  // assign the role, which they have no business doing either way.
  {
    id: 'shipping',
    label: 'Shipping',
    description: 'Works the packing floor: the picking and packing bench.',
    rank: 1
  },
  // The person in front of the camera. Everything Shipping can do — they work
  // the floor between shows like everybody else — plus the one thing nobody
  // else on that floor may do: put the business on air and take it off again.
  //
  // Same rank as Shipping and Staff, and a sibling rather than a rung: opening
  // a stream is a different JOB, not more authority. Ranking it above Shipping
  // would only mean a breaker could hand the role out.
  {
    id: 'breaker',
    label: 'Breaker',
    description: 'Runs the shows. The packing floor, plus starting and ending a stream.',
    rank: 1
  }
]

export function getRole(role: Role): RoleDefinition {
  const found = ROLES.find((r) => r.id === role)
  if (!found) {
    // Unknown values get the lowest rank there is, and a label that reads as a
    // person rather than a job. (Rank is what this is consulted for; what an
    // unknown role may *do* is decided by permissionsForRole, which is
    // deliberately stricter — see there.)
    return ROLES.find((r) => r.id === 'staff') as RoleDefinition
  }
  return found
}

export function roleLabel(role: Role): string {
  return getRole(role).label
}

/**
 * Every permission recognised by the app. Grouped by area. Module-access
 * permissions gate the sidebar entries; admin permissions gate actions inside
 * the Admin module.
 */
export type Permission =
  // Admin module
  | 'admin.access'
  | 'admin.employees.view'
  | 'admin.employees.manage'
  | 'admin.hours.view'
  | 'admin.roles.manage'
  | 'notifications.clock'
  // Available to everyone
  | 'updates.check'
  // Module access (built out over time)
  | 'module.inventory'
  | 'inventory.manage'
  | 'inventory.pricing'
  | 'module.fulfillment'
  | 'shipping.manage'
  | 'shipping.find'
  | 'shipping.pack'
  | 'module.invoicing'
  | 'module.finance'
  | 'finance.manage'
  | 'module.streaming'
  | 'streaming.manage'
  | 'streaming.run'

export interface PermissionDefinition {
  key: Permission
  label: string
  description: string
  group: 'Administration' | 'Modules' | 'System'
}

export const PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'admin.access',
    label: 'Open Admin module',
    description: 'View the Admin module.',
    group: 'Administration'
  },
  {
    key: 'admin.employees.view',
    label: 'View employees',
    description: 'See the employee directory and hours.',
    group: 'Administration'
  },
  {
    key: 'admin.employees.manage',
    label: 'Manage employees',
    description: 'Create, edit, invite and deactivate employees.',
    group: 'Administration'
  },
  {
    key: 'admin.hours.view',
    label: 'View hours',
    description: 'See logged hours for all employees.',
    group: 'Administration'
  },
  {
    key: 'admin.roles.manage',
    label: 'Manage roles & permissions',
    description: 'Change roles and (later) fine-grained permissions.',
    group: 'Administration'
  },
  // A permission of its own rather than a corner of admin.access, because what
  // it grants is a live feed of when named colleagues start and finish work,
  // delivered to a personal phone. That is a supervisory capability and a
  // privacy boundary — the same class of thing as the customer-list export —
  // and it should be possible to give somebody the roster screens without it,
  // or it without the roster screens.
  //
  // The screen lives inside the Admin module, so granting this to a person who
  // does not already have admin.access means granting that too.
  {
    key: 'notifications.clock',
    label: 'Clock-in notifications',
    description:
      'Turn on push notifications to your own phone when anyone clocks in or out. Shows who and when.',
    group: 'Administration'
  },
  {
    key: 'updates.check',
    label: 'Check for updates',
    description: 'Check for, download and install app updates.',
    group: 'System'
  },
  {
    key: 'module.inventory',
    label: 'Inventory',
    description: 'View the Inventory module and search stock.',
    group: 'Modules'
  },
  {
    key: 'inventory.manage',
    label: 'Manage inventory',
    description: 'Add products, record sales, restock and adjust stock.',
    group: 'Modules'
  },
  {
    key: 'inventory.pricing',
    label: 'Update market prices',
    description: 'Update daily high bids on the Pricing screen; recomputes inventory value and spread.',
    group: 'Modules'
  },
  {
    key: 'module.streaming',
    label: 'Streaming',
    description: 'Open the Streaming module — show sessions, breaks and giveaways.',
    group: 'Modules'
  },
  {
    key: 'streaming.run',
    label: 'Start and end a stream',
    description:
      'Put the business on air and take it off again. Does NOT open the Streaming module, which carries the cost of every box opened.',
    group: 'Modules'
  },
  {
    key: 'streaming.manage',
    label: 'Manage streams',
    description: 'Start and end streams, add stream times, and record breaks and giveaways (which consume stock).',
    group: 'Modules'
  },
  {
    key: 'module.fulfillment',
    label: 'Shipping',
    description: 'Open the Shipping workspace — orders, pick lists and shipment tracking.',
    group: 'Modules'
  },
  {
    key: 'shipping.manage',
    label: 'Manage shipping',
    description:
      'Upload packing-slip PDFs, assign breaks, move the queue and set shipment statuses. Implies the two below.',
    group: 'Modules'
  },
  {
    key: 'shipping.find',
    label: 'Find cards',
    description:
      'Work a break: check cards off as they are pulled and sorted into customer piles.',
    group: 'Modules'
  },
  {
    key: 'shipping.pack',
    label: 'Pack orders',
    description: 'Work the packing queue: assemble a customer package and mark it packed.',
    group: 'Modules'
  },
  {
    key: 'module.invoicing',
    label: 'Invoicing & POs',
    description: 'Access the Invoice & Purchase Order module.',
    group: 'Modules'
  },
  {
    key: 'module.finance',
    label: 'Finance',
    description: 'Access the Finance module (bookkeeping, ledger, chart of accounts and forecasting).',
    group: 'Modules'
  },
  {
    key: 'finance.manage',
    label: 'Manage finance data',
    description: 'Upload Whatnot ledgers and rebuild the P&L.',
    group: 'Modules'
  },
]

const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key)

/**
 * The floor, plus the camera.
 *
 * Everything Shipping has, and `streaming.run` on top — which is start and end,
 * and deliberately nothing else. A breaker does NOT get `module.streaming`:
 * that module is the P&L, the cost of every box opened and the giveaway losses,
 * and none of it is theirs to read. What they get is one button on their own
 * home page.
 */
const BREAKER_PERMISSIONS: Permission[] = [
  'updates.check',
  'module.fulfillment',
  'shipping.find',
  'shipping.pack',
  'streaming.run'
]

const OPERATIONS_PERMISSIONS: Permission[] = [
  'admin.access',
  'admin.employees.view',
  'admin.employees.manage',
  'admin.hours.view',
  // Whoever runs the floor is the person who needs to know a shift started.
  'notifications.clock',
  'updates.check',
  'module.inventory',
  'inventory.manage',
  'module.fulfillment',
  'shipping.manage',
  'shipping.find',
  'shipping.pack',
  'module.invoicing',
  'module.finance',
  'module.streaming',
  'streaming.manage',
  'streaming.run',
  'finance.manage'
]

// The floor. A sorter hired to pull and pack cards has to be able to check them
// off — before this, Staff could open the Shipping workspace and change nothing
// in it, because every write in shippingIpc.ts required shipping.manage. They
// still cannot import a PDF, assign work, or set a shipment's status; those stay
// with whoever runs the show.
const STAFF_PERMISSIONS: Permission[] = [
  'updates.check',
  'module.inventory',
  'module.fulfillment',
  'shipping.find',
  'shipping.pack'
]

// The packing bench, and nothing else. Someone hired to ship gets the today
// board and the pick/pack screens; they do not get Inventory, and they pointedly
// do not get shipping.manage, which is what gates the exports carrying customer
// names and addresses. That boundary was closed on purpose and this role does
// not reopen it.
const SHIPPING_PERMISSIONS: Permission[] = [
  'updates.check',
  'module.fulfillment',
  'shipping.find',
  'shipping.pack'
]

/** The permissions granted by each role. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  operations: OPERATIONS_PERMISSIONS,
  staff: STAFF_PERMISSIONS,
  shipping: SHIPPING_PERMISSIONS,
  breaker: BREAKER_PERMISSIONS
}

/**
 * Resolve the effective permission set for a role.
 *
 * The fallback is the narrowest set in the file, which is no longer Staff's —
 * a role string this build does not recognise is stale or corrupt data, and the
 * safe reading of it is the least access, not the least *seniority*.
 */
export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? SHIPPING_PERMISSIONS
}

const KNOWN_PERMISSIONS = new Set<Permission>(PERMISSIONS.map((p) => p.key))

/** Keep only recognised permission keys (defends against stale stored data). */
export function sanitizePermissions(list: unknown): Permission[] {
  if (!Array.isArray(list)) return []
  return list.filter((p): p is Permission => KNOWN_PERMISSIONS.has(p as Permission))
}

/**
 * The effective permissions for an employee: everything their role grants, plus
 * any individually-granted overrides. Overrides are additive — they can only
 * grant access, never remove what a role provides.
 */
export function effectivePermissions(role: Role, overrides: Permission[] = []): Permission[] {
  const set = new Set<Permission>(permissionsForRole(role))
  for (const p of sanitizePermissions(overrides)) set.add(p)
  return [...set]
}

/** Overrides worth surfacing individually — the module/admin grants a role may
 * lack. (Excludes 'updates.check' which everyone already has.) */
export function grantablePermissions(): PermissionDefinition[] {
  return PERMISSIONS.filter((p) => p.key !== 'updates.check')
}

/** Whether a role grants a specific permission. */
export function roleHas(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission)
}

/**
 * Which roles a given actor is allowed to assign. An actor may assign any role
 * with a rank at or below their own, except that only an Owner may create
 * another Owner.
 */
export function assignableRoles(actorRole: Role): Role[] {
  const actorRank = getRole(actorRole).rank
  return ROLES.filter((r) => {
    if (r.id === 'owner') return actorRole === 'owner'
    return r.rank <= actorRank
  }).map((r) => r.id)
}
