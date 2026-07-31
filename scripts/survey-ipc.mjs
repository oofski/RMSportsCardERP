/**
 * Measure the work of moving the app's backend onto a server.
 *
 * Every screen already talks to the backend through one boundary — 180 IPC
 * channels — so "how hard is a browser version" is really "how many of those
 * handlers depend on being on a desktop". This counts them rather than guessing,
 * and the answer drives docs/SERVER.md.
 *
 *   node scripts/survey-ipc.mjs
 */
import { readFileSync, readdirSync } from 'fs'
const ROOT = '/home/user/RMSportsCardERP/src/main'
const files = readdirSync(ROOT).filter((f) => f.endsWith('.ts'))

const DESKTOP = [
  ['dialog.showOpenDialog', 'file picker'],
  ['dialog.showSaveDialog', 'save dialog'],
  ['shell.openExternal', 'open browser'],
  ['shell.openPath', 'open file'],
  ['shell.showItemInFolder', 'reveal in folder'],
  ['clipboard.', 'clipboard'],
  ['safeStorage', 'OS keychain'],
  ['nativeTheme', 'OS theme'],
  ['BrowserWindow', 'window control'],
  ['app.relaunch', 'relaunch'],
  ['autoUpdater', 'auto-update']
]

let total = 0
const desktopBound = []
const perFile = {}

for (const f of files) {
  const src = readFileSync(`${ROOT}/${f}`, 'utf8')
  // Split on handler registrations so each chunk is one handler body.
  const parts = src.split(/ipcMain\.handle\(/).slice(1)
  perFile[f] = parts.length
  total += parts.length
  for (const part of parts) {
    const chan = /^\s*IPC\.(\w+)/.exec(part)?.[1] ?? '(dynamic)'
    // Body = up to the next handler; good enough to spot desktop calls.
    const body = part.slice(0, 4000)
    const hits = DESKTOP.filter(([needle]) => body.includes(needle)).map(([, label]) => label)
    if (hits.length) desktopBound.push({ file: f, chan, needs: [...new Set(hits)] })
  }
}

console.log(`IPC handlers registered: ${total}`)
for (const [f, n] of Object.entries(perFile).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${f}`)
}
console.log(`\nHandlers that touch a DESKTOP-ONLY API (need a browser equivalent): ${desktopBound.length}`)
for (const d of desktopBound) console.log(`  ${d.chan.padEnd(26)} ${d.needs.join(', ')}   [${d.file}]`)
console.log(`\nPortable as-is: ${total - desktopBound.length} of ${total}  (${Math.round(100*(total-desktopBound.length)/total)}%)`)

// Push channels — these need a websocket rather than request/response.
const preload = readFileSync('/home/user/RMSportsCardERP/src/preload/index.ts', 'utf8')
const events = [...preload.matchAll(/ipcRenderer\.on\(\s*IPC\.(\w+)/g)].map((m) => m[1])
console.log(`\nPush/event channels (need a WebSocket): ${new Set(events).size}`)
for (const e of new Set(events)) console.log(`  ${e}`)
