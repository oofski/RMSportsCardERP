import { Fragment, useMemo } from 'react'
import {
  PERMISSIONS,
  ROLES,
  permissionsForRole,
  roleHas,
  type PermissionDefinition
} from '@shared/permissions'
import { Icon } from '../../components/Icon'

export function RolesTab(): JSX.Element {
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
          <p>Three roles to begin with. More permissions are added as each module ships.</p>
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

      <div className="section-head">
        <div>
          <h2>Permission matrix</h2>
          <p>What each role can do today. This grid grows as new modules come online.</p>
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

      <p className="muted text-sm mt-16">
        Note: fine-grained, per-employee permission overrides will be introduced alongside the
        modules that need them. For now, access is governed by role.
      </p>
    </>
  )
}
