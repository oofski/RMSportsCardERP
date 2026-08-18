/**
 * Team: three sidebar entries becoming one door, without orphaning anything.
 *
 * Contacts, Pay and Schedule were three top-level modules. They are one subject
 * — who works here, what they are owed, when they are in — and three slots of a
 * list somebody reads at eight in the morning is a real cost for a grouping
 * nobody argued for.
 *
 * ## The thing that breaks quietly when screens are regrouped
 *
 * Every `navigate('timepay')` in the app. There are several — the home board,
 * the staff board, Admin's Hours tab — plus whatever position somebody's browser
 * last remembered. If the id stops naming something real, those links land on
 * Home with no error anywhere, and the only symptom is a card that "does
 * nothing" when you tap it.
 *
 * So the tab ids ARE the old module ids, and the shell translates them. Section
 * 2 is that assertion, and section 3 checks the real call sites still name
 * something the translation understands.
 *
 * ## The other half: My account stopped being a screen
 *
 * Not moved, not hidden — gone. It is a panel the shell opens over whatever you
 * were looking at, from the name in the top right, because nobody navigates AWAY
 * from a half-finished order to change a password. Section 4 pins that there is
 * no module left to find and no route left to take.
 *
 * Run: npm run test:team
 */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  MODULES,
  TEAM_TABS,
  teamTabFor,
  getModule,
  modulesForWorkspace,
  inWorkspace
} = require('../src/shared/modules')
const { permissionsForRole, ROLES } = require('../src/shared/permissions')

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

// ---------------------------------------------------------------------------
console.log('=== 1. one door where there were three ===')
// ---------------------------------------------------------------------------
const team = getModule('team')
ok(!!team, 'there is a Team module')
ok(team.name === 'Team', 'called Team', team?.name)
ok(team.workspace === 'both', 'in both workspaces — the floor needs it too', String(team?.workspace))
ok(
  team.permission === null,
  'with no permission on the door, because the tabs gate themselves',
  String(team?.permission)
)

for (const id of ['contacts', 'timepay', 'schedule']) {
  ok(!getModule(id), `${id} is no longer a module of its own`)
  ok(
    !modulesForWorkspace('ops').some((m: any) => m.id === id),
    `and is not drawn in the sidebar`
  )
}

ok(TEAM_TABS.length === 3, 'Team has three tabs', String(TEAM_TABS.length))
ok(
  TEAM_TABS.map((t: any) => t.id).join(',') === 'contacts,timepay,schedule',
  'AND THEY ARE THE THREE THAT MOVED, in that order',
  TEAM_TABS.map((t: any) => t.id).join(',')
)
ok(
  TEAM_TABS.map((t: any) => t.label).join(',') === 'Contacts,Pay,Schedule',
  'labelled as they were in the sidebar',
  TEAM_TABS.map((t: any) => t.label).join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE OLD IDS STILL NAME SOMETHING ===')
// ---------------------------------------------------------------------------
// The whole reason the tab ids were not renamed. navigate('timepay') has to keep
// working or a Home card silently stops doing anything.
ok(teamTabFor('timepay') === 'timepay', 'navigate(timepay) resolves to the Pay tab')
ok(teamTabFor('schedule') === 'schedule', 'navigate(schedule) resolves to the Schedule tab')
ok(teamTabFor('contacts') === 'contacts', 'navigate(contacts) resolves to the Contacts tab')
ok(teamTabFor('team') === null, 'Team itself is not a tab id')
ok(teamTabFor('inventory') === null, 'and an unrelated module is left alone')
ok(teamTabFor('') === null, 'as is nothing at all')

// ---------------------------------------------------------------------------
console.log('\n=== 3. the real call sites still land somewhere ===')
// ---------------------------------------------------------------------------
// Read the shell and check the translation is actually wired, then check every
// navigate() target in the app names either a module or a tab. A link to an id
// that is neither falls through to Home with nothing logged.
const shell = read('src/renderer/src/screens/AppShell.tsx')
ok(shell.includes('teamTabFor('), 'the shell translates a tab id before routing')
ok(shell.includes("<TeamModule"), 'and mounts the Team module')

const sources = [
  'src/renderer/src/screens/AppShell.tsx',
  'src/renderer/src/modules/home/HomeModule.tsx',
  'src/renderer/src/modules/home/OwnerBoard.tsx',
  'src/renderer/src/modules/home/StaffBoard.tsx',
  'src/renderer/src/modules/admin/HoursTab.tsx'
]
const targets = new Set<string>()
for (const f of sources) {
  for (const m of read(f).matchAll(/navigate\('([a-z-]+)'\)/g)) targets.add(m[1])
}
ok(targets.size > 0, 'there are navigate() calls to check', [...targets].join(','))
const orphans = [...targets].filter(
  (id) => id !== 'home' && !getModule(id) && !teamTabFor(id)
)
ok(
  orphans.length === 0,
  'EVERY navigate() TARGET NAMES A MODULE OR A TAB — none fall through to Home',
  orphans.join(', ')
)
// The specific ones the regrouping put at risk, named so a failure says which.
for (const id of ['timepay', 'schedule']) {
  ok(targets.has(id), `${id} is still linked to from somewhere`, [...targets].join(','))
  ok(!!teamTabFor(id), `and still resolves after the move`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. My account is not a screen at all ===')
// ---------------------------------------------------------------------------
// It was a module briefly, then a hidden module, and now neither. The sidebar
// is a list of places the WORK happens; a password is housekeeping somebody
// opens twice a year, and it belongs where every other application puts it —
// off your own name, opening over whatever you were looking at rather than
// replacing it.
ok(!getModule('account'), 'THERE IS NO ACCOUNT MODULE')
ok(!MODULES.some((m: any) => m.id === 'account'), 'nothing named account is in the registry')
ok(
  !modulesForWorkspace('ops').some((m: any) => m.id === 'account'),
  'so no sidebar can draw it'
)
ok(shell.includes('My account'), 'the name menu offers it')
ok(shell.includes('setAccountOpen(true)'), 'AND OPENS IT WHERE IT WAS CLICKED')
ok(shell.includes('<AccountPanel'), 'mounting the panel over the page')
ok(
  !/navigate\('account'\)/.test(shell),
  'and nothing navigates to it — there is nowhere to navigate to'
)

// The `hidden` flag existed for exactly one module. With that module gone it is
// dead code, and a dead extension point rots: the next person to need one will
// find a half-remembered mechanism nothing exercises.
ok(
  !MODULES.some((m: any) => 'hidden' in m),
  'and the hidden flag went with it rather than being left lying around',
  MODULES.filter((m: any) => 'hidden' in m).map((m: any) => m.id).join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. nobody lost a screen they had ===')
// ---------------------------------------------------------------------------
// The regrouping must not have narrowed access. For every role, each tab is
// reachable exactly when the screen it replaced was.
for (const r of ROLES) {
  const perms = permissionsForRole(r.id)
  const canOpenTeam = team.permission === null || perms.includes(team.permission)
  ok(canOpenTeam, `${r.id} can open Team`)
  const tabs = TEAM_TABS.filter((t: any) => !t.permission || perms.includes(t.permission))
  ok(
    tabs.length === 3,
    `and sees all three tabs — the same three screens they had before`,
    tabs.map((t: any) => t.id).join(',')
  )
}
// Pay and Schedule keep having no permission at all: a packer checking what they
// are owed is not an administrative act, and an availability screen behind a
// grant is one nobody fills in.
ok(
  TEAM_TABS.find((t: any) => t.id === 'timepay').permission === null,
  'Pay is still ungated'
)
ok(
  TEAM_TABS.find((t: any) => t.id === 'schedule').permission === null,
  'and so is Schedule'
)
ok(
  TEAM_TABS.find((t: any) => t.id === 'contacts').permission === 'module.messages',
  'while Contacts keeps the permission it had',
  String(TEAM_TABS.find((t: any) => t.id === 'contacts').permission)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the sidebar actually got shorter ===')
// ---------------------------------------------------------------------------
// The point of the exercise, stated as a number so it cannot quietly reverse.
const ops = modulesForWorkspace('ops').map((m: any) => m.id)
ok(ops.includes('team'), 'Team is in the ops sidebar')
ok(
  !ops.some((id: string) => ['contacts', 'timepay', 'schedule', 'account'].includes(id)),
  'AND NONE OF THE FOUR IT REPLACED ARE',
  ops.join(', ')
)
const ship = modulesForWorkspace('shipping').map((m: any) => m.id)
ok(ship.includes('team'), 'the shipping sidebar has it too — the floor needs all three')
ok(
  !ship.some((id: string) => ['contacts', 'timepay', 'schedule', 'account'].includes(id)),
  'and none of the old entries',
  ship.join(', ')
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
