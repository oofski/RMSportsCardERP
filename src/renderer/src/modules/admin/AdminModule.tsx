import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { EmployeesTab } from './EmployeesTab'
import { CustomersTab } from './CustomersTab'
import { VendorsTab } from './VendorsTab'
import { OnboardingTab } from './OnboardingTab'
import { RolesTab } from './RolesTab'
import { ActivityTab } from './ActivityTab'
import { DeveloperTab } from './DeveloperTab'
import { NumberingTab } from './NumberingTab'

type SectionId =
  | 'employees'
  | 'customers'
  | 'vendors'
  | 'onboarding'
  | 'roles'
  | 'activity'
  | 'numbering'
  | 'developer'

interface SectionDef {
  id: SectionId
  label: string
  icon: string
  visible: boolean
  /**
   * The figure on the tile, or null for "there isn't one worth printing".
   *
   * NULL IS A REAL ANSWER AND MUST STAY REACHABLE. A tile is a door, and the
   * number on it is only worth the space if somebody can act on it — how many
   * people are on the roster, how many customers, how many vendors. Three of
   * the eight sections below have no such figure (a static checklist, a screen
   * about this device, a capped 300-row log), and a plausible-looking number
   * that is actually the page size or a constant from the source is worse than
   * no number at all: it is unfalsifiable on screen. So those show the section
   * name where the figure goes and say what is inside underneath.
   *
   * Undefined vs null matters too: undefined is "not loaded yet" and draws
   * nothing rather than a 0 that turns into a 7 a moment later.
   */
  count?: number | null
  /** What is behind the door, for tiles that have no figure. */
  hint: string
}

/**
 * Admin, as a grid of tiles.
 *
 * ## Why the tabs went
 *
 * Eight text tabs across the top of one module made every section look like a
 * setting of equal weight, and the strip was already too long to read at a
 * glance — the two most consequential screens in the app had to be hidden
 * behind a ninth called Developer to stop people clicking them by accident.
 * A landing page of tiles says what Admin CONTAINS before anything is clicked,
 * and gives each section room to carry its own count.
 *
 * ## The tiles are the app's existing stat card, not a new component
 *
 * `.stat` / `.stat-ico` / `.stat-val` / `.stat-label` inside `.stat-grid`, with
 * `.stat-btn` making it clickable — the same markup and the same CSS as the
 * "Inventory value / $158.2K" card and the Employees counts one screen deeper.
 * Deliberately not a parallel look: a second card style that was nearly the
 * same would be the thing that makes Admin feel like a different application.
 *
 * ## What happened to the rule between the two groups
 *
 * The tab strip drew a divider before Inventory activity, separating "who works
 * here and what they may touch" from the plumbing that ended up in Admin because
 * there was nowhere else for it. A grid has no gap to hang a line in without
 * inventing one, so the ORDER carries it instead: people first, plumbing last,
 * Developer last of all. The permission checks are unchanged, which is the half
 * of that separation that was ever load-bearing.
 *
 * ## Permissions
 *
 * Every section keeps exactly the check it had, and the two new ones use
 * `module.invoicing` — the permission that already gated the customer list when
 * it was a tab in Sales Orders. A tile is a place to stand and not a grant:
 * main re-checks on every call, so a hidden tile and a blocked call are two
 * independent defences rather than one.
 */
export function AdminModule(): JSX.Element {
  const { can } = useSession()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [customerCount, setCustomerCount] = useState<number | null>()
  const [vendorCount, setVendorCount] = useState<number | null>()
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState<SectionId | null>(null)

  const canPeople = can('admin.employees.view')
  const canInvoicing = can('module.invoicing')

  const loadEmployees = useCallback(async () => {
    const list = await api.employees.list()
    setEmployees(list)
  }, [])

  /**
   * The two figures the landing page cannot get from the roster.
   *
   * The customer count comes from the same call the Customers section makes
   * rather than a count-only channel of its own, on purpose: the tile and the
   * screen behind it then cannot disagree, and a tile that says 41 above a list
   * of 40 is the kind of discrepancy nobody can explain afterwards.
   *
   * A rejection leaves the count NULL, so the tile loses its figure and keeps
   * its door. Both calls also return an empty list rather than throwing when the
   * permission is missing — which is why they are skipped entirely in that case;
   * an empty list would otherwise be indistinguishable from "no customers".
   */
  const loadCounts = useCallback(async () => {
    if (!canInvoicing) return
    const [customers, vendors] = await Promise.all([
      api.invoices.customers().then(
        (list) => list.length,
        () => null
      ),
      api.purchaseOrders.vendors().then(
        (list) => list.length,
        () => null
      )
    ])
    setCustomerCount(customers)
    setVendorCount(vendors)
  }, [canInvoicing])

  // The roster is shared, so somebody added on another machine belongs here now.
  useLiveRefresh(LIVE.people, loadEmployees)
  // And so are the other two counts: a purchase order raised at the office adds
  // a vendor, and a contact import run on another laptop moves the customer
  // figure. A tile showing last week's number is the one failure that makes the
  // whole landing page not worth reading.
  useLiveRefresh([...LIVE.invoices, ...LIVE.purchasing, 'inventory_lots'], loadCounts)

  useEffect(() => {
    ;(async () => {
      // A rejected roster read must never strand the whole module on a spinner —
      // the sections that do not need employees still work, so always clear
      // loading. Same for the counts: a tile without its figure is a working
      // door, and a spinner that never ends is not.
      try {
        await loadEmployees()
      } catch {
        setEmployees([])
      }
      try {
        await loadCounts()
      } catch {
        setCustomerCount(null)
        setVendorCount(null)
      }
      setLoading(false)
    })()
  }, [loadEmployees, loadCounts])

  const sections: SectionDef[] = [
    // ---- People. This is what Admin IS --------------------------------------
    {
      id: 'employees',
      label: 'Employees',
      icon: 'Users',
      visible: canPeople,
      // The roster, everybody on it. The same figure the Employees screen prints
      // as "Total employees", so the tile and the screen agree by construction —
      // an "active only" count here would differ from the first thing you see
      // after clicking it, with nothing on either to explain the gap.
      count: employees.length,
      hint: 'Who works here'
    },
    // Moved out of Sales Orders, where it was the "Buyers" tab. One list, one
    // place — see CustomersTab for the whole argument and for what it cost.
    {
      id: 'customers',
      label: 'Customers',
      icon: 'ShoppingCart',
      visible: canInvoicing,
      count: customerCount,
      hint: 'Who buys from us'
    },
    // Half derived, half imported, and the tile prints the union. See VendorsTab
    // and listVendors(): distinct names across purchase orders, stock receipts
    // and the contacts flagged as vendors by the directory import. Deliberately
    // NOT the size of the contact list — a customer who has never sold us
    // anything is not a vendor, and a tile labelled Vendors showing the buyer
    // count is the exact failure the separate query exists to avoid.
    {
      id: 'vendors',
      label: 'Vendors',
      icon: 'Truck',
      visible: canInvoicing,
      count: vendorCount,
      hint: 'Who we buy from'
    },
    // No figure: it is a written checklist of five steps, not a list of people
    // mid-onboarding. Counting the steps would be counting a constant in the
    // source, and counting pending invites would promise a list this screen
    // does not show.
    {
      id: 'onboarding',
      label: 'Onboarding',
      icon: 'UserPlus',
      visible: canPeople,
      count: null,
      hint: 'The order a new hire happens in'
    },
    // No figure: the honest ones are constants — four roles, N permissions —
    // and a number that only changes when this repository changes is decoration.
    {
      id: 'roles',
      label: 'Roles & Permissions',
      icon: 'ShieldCheck',
      visible: can('admin.access'),
      count: null,
      hint: 'What each role may reach'
    },
    // ---- Everything else ----------------------------------------------------
    // No figure: the screen reads the last 300 movements and there is no count
    // behind it, so anything printed here would either be the page size dressed
    // up as a total or a second query run for decoration.
    {
      id: 'activity',
      label: 'Inventory activity',
      icon: 'Layers',
      visible: can('module.inventory'),
      count: null,
      hint: 'Every sale, restock and adjustment'
    },
    // WHERE THE DOCUMENT SERIES START. Admin rather than a corner of Finance or
    // Sales Orders, because it is one setting spanning three modules and it is
    // the kind of thing set once when the app takes over from whatever came
    // before — not a thing anybody touches in an ordinary week.
    //
    // No figure on the tile. There are THREE numbers behind it and no honest way
    // to pick one, and a tile showing the deal-ticket number above a door
    // labelled Numbering would read as though that were the only series.
    {
      id: 'numbering',
      label: 'Numbering',
      icon: 'Hash',
      visible: can('admin.access'),
      count: null,
      hint: 'Where deal tickets, invoices and POs start'
    },
    // THE BACK OF THE HOUSE, in one tile.
    //
    // Cloud sync and the inventory reset are not administration in the sense the
    // sections above are — nobody opens either in an ordinary week. One decides
    // which company's data this machine reads and writes; the other rewrites
    // stock and cost for the whole catalog in a single action. They are the two
    // most consequential screens in the app and the two least visited, which is
    // exactly the pair that should be behind one clearly-labelled door.
    //
    // Gated on the WIDER of the two permissions, and each screen re-checks its
    // own inside — the tile is a place to stand, not a grant.
    {
      id: 'developer',
      label: 'Developer',
      icon: 'Terminal',
      visible: can('admin.access') || can('inventory.manage') || can('shipping.manage'),
      count: null,
      hint: 'Cloud sync and the inventory reset'
    }
  ]
  const visible = sections.filter((s) => s.visible)
  // A section stays open only while the account can still see it. Permissions
  // are refreshed under a live session, so this is not theoretical: without the
  // check, revoking access would leave the screen already open on it.
  const open = visible.find((s) => s.id === section) ?? null

  if (loading) return <CenterLoader />

  if (visible.length === 0) {
    return <EmptyState icon="ShieldCheck" title="Nothing in here is yours to change." />
  }

  if (open) {
    return (
      <div className="content-narrow">
        {/* The way back, above the section's own heading rather than inside it —
            each section below renders its own `section-head`, and threading a
            back control through eight of them would be eight chances to forget
            one and strand somebody on a screen with no exit. */}
        <div className="row" style={{ marginBottom: 10 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={() => setSection(null)}>
            Admin
          </Button>
        </div>

        {open.id === 'employees' && (
          <EmployeesTab employees={employees} onChanged={loadEmployees} />
        )}
        {open.id === 'customers' && <CustomersTab />}
        {open.id === 'vendors' && <VendorsTab />}
        {open.id === 'onboarding' && <OnboardingTab />}
        {open.id === 'roles' && <RolesTab employees={employees} onChanged={loadEmployees} />}
        {open.id === 'activity' && <ActivityTab />}
        {open.id === 'numbering' && <NumberingTab />}
        {open.id === 'developer' && <DeveloperTab />}
      </div>
    )
  }

  return (
    <div className="content-narrow">
      <div className="stat-grid admin-tiles">
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            className="stat stat-btn"
            onClick={() => setSection(s.id)}
          >
            <div className="stat-ico">
              <Icon name={s.icon} size={21} />
            </div>
            <div>
              {/* One figure or the other, never both: with a count the name is
                  the quiet line under it (the shape of every stat card in the
                  app); without one the name takes the headline and the quiet
                  line says what is inside. */}
              {typeof s.count === 'number' ? (
                <>
                  <div className="stat-val">{s.count}</div>
                  <div className="stat-label">{s.label}</div>
                </>
              ) : (
                <>
                  <div className="stat-val stat-val-name">{s.label}</div>
                  <div className="stat-label">{s.hint}</div>
                </>
              )}
            </div>
            <Icon name="ChevronRight" size={17} className="stat-go" />
          </button>
        ))}
      </div>
    </div>
  )
}
