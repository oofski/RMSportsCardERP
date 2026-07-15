import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  PERMISSIONS,
  ROLES,
  grantablePermissions,
  permissionsForRole,
  roleHas,
  type Permission,
  type PermissionDefinition
} from '@shared/permissions'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { Avatar, Button, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { initials, fullName } from '../../lib/format'

export function RolesTab({
  employees,
  onChanged
}: {
  employees: Employee[]
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const { user, can } = useSession()
  const canManageRoles = can('admin.roles.manage')

  const grouped = useMemo(() => {
    const groups: Record<string, PermissionDefinition[]> = {}
    for (const p of PERMISSIONS) {
      ;(groups[p.group] ??= []).push(p)
    }
    return groups
  }, [])

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Roles</h2>
          <p>Three roles to begin with. Grant extra access to individuals below.</p>
        </div>
      </div>

      <div className="role-cards">
        {ROLES.map((r) => (
          <div className="role-card" key={r.id}>
            <div className="r-head">
              <span className={`badge badge-${r.id}`}>
                <span className="dot" />
                {r.label}
              </span>
              <span className="r-count">{permissionsForRole(r.id).length} permissions</span>
            </div>
            <p>{r.description}</p>
          </div>
        ))}
      </div>

      {canManageRoles && (
        <IndividualAccess employees={employees} actorPerms={user?.permissions ?? []} onChanged={onChanged} />
      )}

      <div className="section-head">
        <div>
          <h2>Permission matrix</h2>
          <p>What each role can do by default. Individual grants add on top of this.</p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ minWidth: 260 }}>Permission</th>
              {ROLES.map((r) => (
                <th key={r.id} style={{ textAlign: 'center' }}>
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([group, perms]) => (
              <Fragment key={group}>
                <tr className="matrix-group-row">
                  <td colSpan={ROLES.length + 1}>{group}</td>
                </tr>
                {perms.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.label}</div>
                      <div className="muted text-sm">{p.description}</div>
                    </td>
                    {ROLES.map((r) => (
                      <td key={r.id} style={{ textAlign: 'center' }}>
                        {roleHas(r.id, p.key) ? (
                          <span className="perm-check">
                            <Icon name="Check" size={17} />
                          </span>
                        ) : (
                          <span className="perm-dash">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function IndividualAccess({
  employees,
  actorPerms,
  onChanged
}: {
  employees: Employee[]
  actorPerms: Permission[]
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [selectedId, setSelectedId] = useState<string>(employees[0]?.id ?? '')
  const [extras, setExtras] = useState<Set<Permission>>(new Set())
  const [saving, setSaving] = useState(false)

  const selected = employees.find((e) => e.id === selectedId) ?? null

  // Reset the working set whenever the chosen employee (or their saved data) changes.
  useEffect(() => {
    setExtras(new Set(selected?.extraPermissions ?? []))
  }, [selectedId, selected?.extraPermissions])

  const grantable = useMemo(() => grantablePermissions(), [])
  const groups = useMemo(() => {
    const g: Record<string, PermissionDefinition[]> = {}
    for (const p of grantable) (g[p.group] ??= []).push(p)
    return g
  }, [grantable])

  const dirty = useMemo(() => {
    const saved = new Set(selected?.extraPermissions ?? [])
    if (saved.size !== extras.size) return true
    for (const p of extras) if (!saved.has(p)) return true
    return false
  }, [extras, selected?.extraPermissions])

  if (employees.length === 0) return <></>

  const toggle = (perm: Permission): void => {
    setExtras((prev) => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    setSaving(true)
    try {
      const res = await api.employees.setPermissions(selected.id, [...extras])
      if (!res.ok) {
        toast.error(res.error ?? 'Could not update permissions.')
        return
      }
      toast.success(`Updated ${selected.firstName}'s access.`)
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel-card" style={{ marginBottom: 26 }}>
      <div className="panel-head">
        <div>
          <h3>Individual access</h3>
          <span className="ph-sub">Grant a specific person extra permissions on top of their role.</span>
        </div>
      </div>

      <div className="perm-picker">
        <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.firstName} {e.lastName} · {e.role}
            </option>
          ))}
        </Select>
      </div>

      {selected && (
        <>
          <div className="row" style={{ gap: 11, marginBottom: 6 }}>
            <Avatar text={initials(selected.firstName, selected.lastName)} small />
            <div>
              <div style={{ fontWeight: 600 }}>{fullName(selected.firstName, selected.lastName)}</div>
              <div className="muted text-sm" style={{ textTransform: 'capitalize' }}>
                {selected.role} · {selected.companyId}
              </div>
            </div>
          </div>

          {Object.entries(groups).map(([group, perms]) => (
            <div key={group}>
              <div className="pr-group">{group}</div>
              <div className="perm-list">
                {perms.map((p) => {
                  const viaRole = roleHas(selected.role, p.key)
                  const actorHas = actorPerms.includes(p.key)
                  const checked = viaRole || extras.has(p.key)
                  const locked = viaRole || !actorHas
                  return (
                    <div
                      key={p.key}
                      className={`perm-row ${locked ? 'disabled' : ''}`}
                      onClick={() => !locked && toggle(p.key)}
                    >
                      <span className="pr-box" data-checked={checked}>
                        <Icon name="Check" size={13} strokeWidth={3} />
                      </span>
                      <div className="pr-main">
                        <div className="pr-label">{p.label}</div>
                        <div className="pr-desc">{p.description}</div>
                      </div>
                      {viaRole ? (
                        <span className="pr-tag">Via role</span>
                      ) : !actorHas ? (
                        <span className="pr-tag">Unavailable</span>
                      ) : extras.has(p.key) ? (
                        <span className="pr-tag" style={{ color: 'var(--brand-600)', background: 'var(--brand-soft)' }}>
                          Granted
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          <div className="modal-foot" style={{ padding: '16px 0 0', borderTop: 'none' }}>
            <Button variant="primary" icon="Check" loading={saving} disabled={!dirty} onClick={save}>
              Save access
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
