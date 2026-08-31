import { useCallback, useEffect, useState } from 'react'
import type { BackupPreview } from '@shared/backup'
import { describeBackup, formatBackupSize } from '@shared/backup'
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

      <div className="bk-note">
        <Icon name="Info" size={15} />
        <div>
          <b>Putting one back is a manual job for now.</b> The steps are in{' '}
          <span className="mono">docs/RENDER.md</span>. Restoring is not a button yet because it
          overwrites everything and has to be done carefully — that is its own piece of work.
        </div>
      </div>
    </>
  )
}
