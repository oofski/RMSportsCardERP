/**
 * Role-based access control (RBAC) for the RM Operations App.
 *
 * There are three roles to begin with — Owner, Operations, and Staff. Each role
 * grants a set of permissions. As new modules are built, add their permission
 * keys here and grant them to the appropriate roles; the UI reads exclusively
 * from this file, so access rules stay in one place.
 */

export type Role = 'owner' | 'operations' | 'staff'

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
  }
]

export function getRole(role: Role): RoleDefinition {
  const found = ROLES.find((r) => r.id === role)
  if (!found) {
    // Fall back to the least-privileged role for unknown values.
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
  // Available to everyone
  | 'updates.check'
  // Module access (built out over time)
  | 'module.orders'
  | 'module.shipping'
  | 'module.bookkeeping'
  | 'module.invoicing'
  | 'module.accounts'
  | 'module.sops'
  | 'module.forecasting'

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
  {
    key: 'updates.check',
    label: 'Check for updates',
    description: 'Check for, download and install app updates.',
    group: 'System'
  },
  {
    key: 'module.orders',
    label: 'Order & Fulfillment',
    description: 'Access the Order & Fulfillment module.',
    group: 'Modules'
  },
  {
    key: 'module.shipping',
    label: 'Shipping & CRM',
    description: 'Access the Shipping Tracking & CRM module.',
    group: 'Modules'
  },
  {
    key: 'module.bookkeeping',
    label: 'Bookkeeping & Ledger',
    description: 'Access the Bookkeeping / Business Ledger module.',
    group: 'Modules'
  },
  {
    key: 'module.invoicing',
    label: 'Invoicing & POs',
    description: 'Access the Invoice & Purchase Order module.',
    group: 'Modules'
  },
  {
    key: 'module.accounts',
    label: 'Chart of Accounts',
    description: 'Access the Chart of Accounts module.',
    group: 'Modules'
  },
  {
    key: 'module.sops',
    label: 'SOP Creation',
    description: 'Access the SOP Creation module.',
    group: 'Modules'
  },
  {
    key: 'module.forecasting',
    label: 'Financial Forecasting',
    description: 'Access the Financial Forecasting module.',
    group: 'Modules'
  }
]

const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key)

const OPERATIONS_PERMISSIONS: Permission[] = [
  'admin.access',
  'admin.employees.view',
  'admin.employees.manage',
  'admin.hours.view',
  'updates.check',
  'module.orders',
  'module.shipping',
  'module.bookkeeping',
  'module.invoicing',
  'module.accounts',
  'module.sops',
  'module.forecasting'
]

const STAFF_PERMISSIONS: Permission[] = [
  'updates.check',
  'module.orders',
  'module.shipping',
  'module.sops'
]

/** The permissions granted by each role. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  operations: OPERATIONS_PERMISSIONS,
  staff: STAFF_PERMISSIONS
}

/** Resolve the effective permission set for a role. */
export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? STAFF_PERMISSIONS
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
