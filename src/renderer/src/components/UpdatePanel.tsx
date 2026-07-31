import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { DOWNLOAD_URL } from '@shared/config'
import { Modal, Button } from './ui'
import { Icon } from './Icon'
import { api } from '../lib/api'
import { useToast } from './Toast'

export function UpdatePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    let active = true
    api.updates.getStatus().then((s) => {
      if (active) setStatus(s)
    })
    const off = api.updates.onStatus((s) => setStatus(s))
    return () => {
      active = false
      off()
    }
  }, [])

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.updates.check()
    } catch {
      toast.error('Could not check for updates.')
    } finally {
      setBusy(false)
    }
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.updates.download()
    } finally {
      setBusy(false)
    }
  }

  const install = async (): Promise<void> => {
    await api.updates.install()
  }

  const openDownload = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.updates.openDownload(status?.downloadUrl)
      if (!res.ok) toast.error(res.error ?? 'No download link available.')
      else toast.success('Opening the download in your browser…')
    } finally {
      setBusy(false)
    }
  }

  const phase = status?.phase ?? 'idle'
  const version = status?.currentVersion ?? '—'
  // Whether the app can install its own update — decided by main, because on
  // macOS it depends on whether the build was signed, not on the OS.
  const isWin = status?.selfUpdating ?? status?.platform === 'win32'

  let tone = ''
  let icon = 'RefreshCw'
  let title = 'Check for updates'
  let message = 'See if a newer version of the RM Operations App is available.'

  switch (phase) {
    case 'checking':
      icon = 'Loader2'
      title = 'Checking…'
      message = 'Looking for the latest version.'
      break
    case 'available':
      tone = 'warn'
      icon = 'DownloadCloud'
      title = `Version ${status?.availableVersion} available`
      message = status?.message ?? 'A new version is ready to download.'
      break
    case 'downloading':
      icon = 'Download'
      title = 'Downloading update…'
      message = status?.message ?? 'Please wait.'
      break
    case 'downloaded':
      tone = 'ok'
      icon = 'CheckCircle2'
      title = 'Update ready to install'
      message = 'The app will restart to finish installing.'
      break
    case 'not-available':
      tone = 'ok'
      icon = 'CheckCircle2'
      title = "You're up to date"
      message = status?.message ?? 'You have the latest version.'
      break
    case 'unsupported':
      tone = 'warn'
      icon = 'Info'
      title = 'Automatic install not available'
      message =
        status?.message ??
        'This build cannot install its own update — download the new version instead.'
      break
    case 'error':
      tone = 'warn'
      icon = 'AlertCircle'
      title = 'Update check failed'
      message = status?.message ?? 'Something went wrong.'
      break
  }

  return (
    <Modal
      title="Software updates"
      subtitle={`RM Operations App · version ${version}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!isWin && (
            <Button variant="secondary" icon="DownloadCloud" onClick={() => api.updates.openDownload(DOWNLOAD_URL)}>
              Downloads page
            </Button>
          )}
          {phase === 'available' &&
            (isWin ? (
              <Button variant="primary" icon="Download" loading={busy} onClick={download}>
                Download update
              </Button>
            ) : (
              <Button variant="primary" icon="DownloadCloud" loading={busy} onClick={openDownload}>
                Download v{status?.availableVersion}
              </Button>
            ))}
          {phase === 'downloaded' && (
            <Button variant="primary" icon="RefreshCw" onClick={install}>
              Restart & install
            </Button>
          )}
          {(phase === 'idle' ||
            phase === 'not-available' ||
            phase === 'error' ||
            phase === 'unsupported') && (
            <Button variant="primary" icon="RefreshCw" loading={busy} onClick={check}>
              Check now
            </Button>
          )}
        </>
      }
    >
      <div className={`update-status ${tone}`}>
        <span className="u-ico">
          <Icon name={icon} size={20} className={phase === 'checking' ? 'spin-ico' : ''} />
        </span>
        <div>
          <div className="u-title">{title}</div>
          <div className="u-msg">{message}</div>
        </div>
      </div>

      {phase === 'downloading' && (
        <div>
          <div className="progress">
            <div className="bar" style={{ width: `${status?.percent ?? 0}%` }} />
          </div>
          <div className="muted text-sm">{status?.percent ?? 0}% downloaded</div>
        </div>
      )}

      {phase === 'available' && status?.releaseNotes && (
        <div className="mt-16">
          <div className="field">
            <label>Release notes</label>
            <div className="email-preview">{status.releaseNotes}</div>
          </div>
        </div>
      )}

      {phase === 'available' && !isWin && (
        <div className="auth-note mt-16">
          Downloads the new installer — open it and drag the app to Applications to finish updating.
        </div>
      )}

      <p className="muted text-sm mt-16">
        {isWin
          ? 'Updates are delivered from the RM Cardz release channel and install automatically.'
          : 'Updates are delivered from the RM Cardz release channel. This build downloads the new version for you to reinstall — macOS only allows an app to replace itself when it is code-signed by Apple.'}
      </p>
    </Modal>
  )
}
