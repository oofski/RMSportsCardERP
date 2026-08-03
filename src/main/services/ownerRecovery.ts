import { app, dialog } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import bcrypt from 'bcryptjs'
import { getDb } from '../db/database'
import { generateTempPassword } from '../util'
import { newId, nowIso } from '../util'

/**
 * Getting back in when the Owner password is lost.
 *
 * The obvious request is a fixed account with a known password baked into the
 * build. This app cannot have one: the repository is public and so is the
 * installer, so a constant password is a login every reader of the source
 * already knows, on every install, and Owner carries `shipping.manage` — the
 * customer export with every buyer's name, address and spend. A backdoor into
 * other people's data is not a password reset.
 *
 * What the request actually wants is to never be locked out without help, and
 * that only needs a gate an attacker cannot pass. This one is **physical access
 * to the machine**: drop a file next to the database, start the app, read the
 * new password off the screen. Somebody sitting at the PC does it in seconds.
 * Somebody on the internet cannot do it at all, because they cannot create the
 * file — and if they could, they could read the database directly and would
 * have no need of a password.
 *
 * The password is generated per run and never stored anywhere but the hash, so
 * there is nothing to leak from the source, the repo or a release.
 */
const TRIGGER_FILE = 'reset-owner.txt'
const BCRYPT_ROUNDS = 12

interface OwnerRow {
  id: string
  first_name: string
  last_name: string
  company_id: string
  email: string
}

/**
 * Honour a reset request left on disk, once, and report what to type.
 *
 * Runs before the window opens so the answer is on screen when the login form
 * is. Every exit path removes the trigger file — including the failures. A file
 * that stayed behind would reset the password again on the next launch, and the
 * owner would be locked out by the very thing meant to let them in.
 */
export function honourOwnerReset(): void {
  const file = join(app.getPath('userData'), TRIGGER_FILE)
  if (!existsSync(file)) return

  let message = ''
  let password: string | null = null
  try {
    password = generateTempPassword()
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
    const db = getDb()
    const ts = nowIso()

    // Prefer resetting the Owner that already exists — it owns the history, the
    // audit trail and the permissions. Only invent an account when there is no
    // owner at all, which is the genuinely locked-out case.
    const owner = db
      .prepare(
        `SELECT id, first_name, last_name, company_id, email FROM employees
          WHERE role = 'owner' AND status <> 'disabled'
          ORDER BY created_at ASC LIMIT 1`
      )
      .get() as OwnerRow | undefined

    if (owner) {
      db.prepare(
        `UPDATE employees
            SET password_hash = ?, must_change_password = 1, status = 'active', updated_at = ?
          WHERE id = ?`
      ).run(hash, ts, owner.id)
      message =
        `The Owner account has been reset.\n\n` +
        `Sign in as:  ${owner.company_id}\n` +
        `Password:    ${password}\n\n` +
        `You will be asked to choose a new password straight away.`
    } else {
      const companyId = 'RM-RESET'
      db.prepare(
        `INSERT INTO employees
           (id, first_name, last_name, company_id, title, email, role, status,
            password_hash, must_change_password, created_at, updated_at)
         VALUES (?, 'Recovery', 'Owner', ?, 'Owner', ?, 'owner', 'active', ?, 1, ?, ?)`
      ).run(newId(), companyId, `no-email:${companyId.toLowerCase()}`, hash, ts, ts)
      message =
        `No Owner account existed, so a recovery Owner has been created.\n\n` +
        `Sign in as:  ${companyId}\n` +
        `Password:    ${password}\n\n` +
        `You will be asked to choose a new password straight away. Rename this\n` +
        `account, or make your own Owner and delete it.`
    }
  } catch (err) {
    message =
      `The reset could not be completed.\n\n` +
      `${err instanceof Error ? err.message : String(err)}`
    password = null
  } finally {
    // Best effort, and deliberately not fatal: a reset that worked must not be
    // reported as a failure because the file could not be removed. The warning
    // below is what stops it running twice unnoticed.
    try {
      unlinkSync(file)
    } catch {
      message +=
        `\n\nNOTE: ${TRIGGER_FILE} could not be deleted. Remove it by hand, or ` +
        `the password will be reset again next time the app starts.`
    }
  }

  dialog.showMessageBoxSync({
    type: password ? 'info' : 'error',
    title: 'RM Operations — Owner recovery',
    message: password ? 'Owner password reset' : 'Owner recovery failed',
    detail: message,
    buttons: ['OK'],
    noLink: true
  })
}
