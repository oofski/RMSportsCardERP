import { useCallback, useEffect, useState } from 'react'
import type { BackupPreview } from '@shared/backup'
import { describeBackup, formatBackupSize } from '@shared/backup'
import type { RestoreCheck, RestoreStatus } from '@shared/restore'
import {
  RESTORE_CONFIRM_WORD,
  describeRestore,
  restoreConfirmed,
  restoreLosses
} from '@shared/restore'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * TAKE A COPY OF THE DATABASE AND KEEP IT SOMEWHERE ELSE.
 *
 * The owner asked for "backups in case something gets lost — something that
 * could just be re-uploaded". Everything this business runs on is one SQLite
 * file, and until now the only way to copy it was a command typed into a Render
 * shell: correct, documented, and not a thing anybody does at the moment they
 * need it.
 *
 * ## Its own tile rather than a corner of Developer
 *
 * The same argument the reset card makes one screen over: a backup is the
 * owner's insurance policy, not plumbing, and filing it behind a door labelled
 * Developer puts it where nobody looks for it. Somebody deciding to take a
 * backup is not doing developer work; they are worrying about their business.
 *
 * ## It says what is in the file BEFORE offering it
 *
 * A backup nobody can identify is a file nobody trusts. The counts are read
 * live, so what the panel says is what the download will hold, and the same
 * sentence is used again in the toast afterwards — see describeBackup, and the
 * note there about summaries that read differently before and after.
 *
 * ## And it says the two things that are NOT in it
 *
 * The photos, and the fact that the file is credential material. Both are
 * stated on the resting screen rather than buried in a confirm dialog, because
 * they change where somebody puts the file, and that decision is made before
 * the button is pressed.
 */
export function BackupTab(): JSX.Element {
  const toast = useToast()
  const [preview, setPreview] = useState<BackupPreview | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setPreview(await api.backup.preview())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (preview === undefined) return <CenterLoader />

  // Null is the handler's answer to somebody who may not see this. See
  // backupIpc: a read nobody unauthorised opens on purpose should not throw a
  // banner over itself.
  if (preview === null) {
    return (
      <EmptyState
        icon="ShieldCheck"
        title="Backups are the owner's to take"
        message="The file holds the QuickBooks connection and the payment details, so only the owner can download one."
      />
    )
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      // Re-read at the moment of asking rather than trusting what was fetched
      // when the tab opened — somebody may have worked a whole shift since.
      const fresh = await api.backup.preview()
      const res = await api.backup.download()
      if (res.canceled) return
      if (!res.ok) {
        toast.error(res.error ?? 'Could not write the backup.')
        return
      }
      toast.success(`Backup saved — ${describeBackup((fresh ?? preview).counts)}.`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Backup</h2>
          <p className="section-sub">
            One file with everything in it, that you keep somewhere this app cannot reach.
          </p>
        </div>
      </div>

      <div className="bk-card">
        <div className="bk-what">
          <span className="bk-what-label">In the database right now</span>
          <span className="bk-what-value">{describeBackup(preview.counts)}</span>
          <span className="bk-what-size">
            About {formatBackupSize(preview.estimatedBytes)} · schema v{preview.schemaVersion}
          </span>
        </div>
        <Button variant="primary" icon="Download" loading={busy} onClick={() => void download()}>
          Download backup
        </Button>
      </div>

      {/* THE TWO THINGS THE FILE DOES NOT DO, said before the button is pressed
          rather than discovered later. Neither is a warning about this screen —
          they are facts about where the file should live and what it will
          restore, and both change what somebody does next. */}
      <div className="bk-note">
        <Icon name="Lock" size={15} />
        <div>
          <b>Keep it private.</b> The file contains the QuickBooks connection and your payment
          instructions in readable form. Treat it the way you would treat a password — not a
          shared drive everyone can open.
        </div>
      </div>

      <div className="bk-note">
        <Icon name="Camera" size={15} />
        <div>
          <b>Product photos are not in it.</b> Every number is — products, orders, costs,
          timesheets, the ledger — but the images are separate files. A restore would bring the
          business back and leave the pictures missing.
        </div>
      </div>

      <RestorePanel onRestored={() => void load()} />
    </>
  )
}

/**
 * THE OTHER HALF: putting a backup back.
 *
 * ## It shows what is being traded away, not just what is arriving
 *
 * A restore screen that only describes the incoming file is asking somebody to
 * do the subtraction themselves, at the exact moment they are least able to. So
 * the panel puts the two side by side and then says the difference out loud —
 * "you will lose 207 products" — because a pair of numbers does not read as a
 * loss and a sentence does.
 *
 * ## The refusals are not warnings
 *
 * A file from a newer version, a damaged file, a file from another program: the
 * button does not appear at all. These are not risks for the owner to weigh —
 * a newer file corrupts every OTHER machine through the relay, and the person
 * clicking cannot see that happen. Warnings, by contrast, are things worth
 * seeing but genuinely theirs to decide.
 *
 * ## And it states the limit it cannot fix
 *
 * This puts THIS machine back. It does not roll the team back. Somebody
 * restoring after a bad import needs to know that before they press the button,
 * not afterwards when the relay has filled the gaps back in.
 */
function RestorePanel({ onRestored }: { onRestored: () => void }): JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<RestoreStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')

  const load = useCallback(async () => {
    setStatus(await api.restore.status())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The result of the last swap is read once and cleared by the handler, so it
  // has to be reported the moment it arrives rather than left for a re-render.
  useEffect(() => {
    const outcome = status?.lastOutcome
    if (!outcome) return
    if (outcome.ok) {
      toast.success(`Restored from ${outcome.filename}. The app is running on that backup now.`)
      onRestored()
    } else {
      toast.error(outcome.error ?? 'The restore did not complete.')
    }
  }, [status?.lastOutcome, toast, onRestored])

  if (status === undefined || status === null) return <></>

  const staged: RestoreCheck | null = status.staged

  const pick = async (): Promise<void> => {
    setBusy(true)
    setTyped('')
    try {
      const res = await api.restore.stage()
      if (!res.ok) {
        // "No file chosen" is a cancel, not a failure worth a red banner.
        if (res.error && res.error !== 'No file chosen.') toast.error(res.error)
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.restore.cancel()
      setTyped('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!staged?.stageId) return
    setBusy(true)
    try {
      const res = await api.restore.confirm({ stageId: staged.stageId, typed })
      if (!res.ok) {
        toast.error(res.error ?? 'That backup could not be restored.')
        setBusy(false)
        return
      }
      // Deliberately left busy. The process is about to end, and re-enabling
      // the button would invite a second press into a closing app.
      toast.success('Restoring — the app is restarting.')
    } catch {
      // The connection dropping IS the restart, on the web. Not an error.
      toast.success('Restoring — the app is restarting.')
    }
  }

  const losses = staged ? restoreLosses(staged.current, staged.file.counts) : []

  return (
    <>
      <div className="section-head bk-restore-head">
        <div>
          <h2>Restore a backup</h2>
          <p className="section-sub">
            Put a downloaded file back. Nothing changes until you confirm.
          </p>
        </div>
      </div>

      {!staged && (
        <div className="bk-card">
          <div className="bk-what">
            <span className="bk-what-label">Choose a backup file</span>
            <span className="bk-what-size">
              The app checks it and shows you what would change before anything happens.
            </span>
          </div>
          <Button variant="secondary" icon="Upload" loading={busy} onClick={() => void pick()}>
            Choose file
          </Button>
        </div>
      )}

      {staged && (
        <div className={`bk-restore${staged.ok ? '' : ' is-blocked'}`}>
          <div className="bk-restore-file">
            <Icon name="Archive" size={15} />
            <b>{staged.file.filename}</b>
            <span className="bk-what-size">{formatBackupSize(staged.file.bytes)}</span>
          </div>

          {staged.blockers.map((b) => (
            <div key={b.code} className="bk-note bk-blocker">
              <Icon name="AlertTriangle" size={15} />
              <div>{b.message}</div>
            </div>
          ))}

          {staged.ok && (
            <>
              <div className="bk-compare">
                <div className="bk-compare-side">
                  <span className="bk-compare-label">On this machine now</span>
                  <span className="bk-compare-value">{describeBackup(staged.current)}</span>
                </div>
                <Icon name="ArrowRight" size={16} />
                <div className="bk-compare-side">
                  <span className="bk-compare-label">After restoring</span>
                  <span className="bk-compare-value">{describeRestore(staged.file)}</span>
                </div>
              </div>

              {/* The subtraction, done for them. See restoreLosses. */}
              {losses.length > 0 && (
                <div className="bk-note bk-loss">
                  <Icon name="AlertTriangle" size={15} />
                  <div>
                    <b>You would lose</b>{' '}
                    {losses
                      .map((l) => `${l.lost.toLocaleString()} ${l.label}`)
                      .join(', ')}
                    . Anything entered since this backup was taken is not in it.
                  </div>
                </div>
              )}

              {staged.warnings.map((w) => (
                <div key={w.code} className="bk-note">
                  <Icon name="Info" size={15} />
                  <div>{w.message}</div>
                </div>
              ))}

              <div className="bk-note">
                <Icon name="Users" size={15} />
                <div>
                  <b>This puts your copy back — not everyone else's.</b> Other machines keep what
                  they have, and this one will catch up with them afterwards. It is the fix for a
                  broken or lost copy, not a way to undo something for the whole team.
                </div>
              </div>

              <div className="bk-note">
                <Icon name="RefreshCw" size={15} />
                <div>
                  <b>The app restarts.</b> Your current database is kept alongside, so this can be
                  undone if the file turns out to be the wrong one.
                </div>
              </div>

              <div className="bk-confirm">
                <label htmlFor="bk-confirm-input">
                  Type <b>{RESTORE_CONFIRM_WORD}</b> to confirm
                </label>
                <input
                  id="bk-confirm-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={RESTORE_CONFIRM_WORD}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          <div className="bk-restore-actions">
            <Button variant="ghost" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </Button>
            {staged.ok && (
              <Button
                variant="danger"
                icon="RefreshCw"
                loading={busy}
                disabled={!restoreConfirmed(typed)}
                onClick={() => void confirm()}
              >
                Restore and restart
              </Button>
            )}
          </div>
        </div>
      )}

      {status.keptCopies.length > 0 && (
        <div className="bk-note">
          <Icon name="Archive" size={15} />
          <div>
            <b>Databases kept from earlier restores:</b>{' '}
            {status.keptCopies
              .map((c) => `${c.name} (${formatBackupSize(c.bytes)})`)
              .join(', ')}
            . They sit beside the live one and can be restored through this screen.
          </div>
        </div>
      )}
    </>
  )
}
