import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { CAMERA_COOLDOWN_MS } from '@shared/upc'
import { Icon } from '../../components/Icon'

/** Only the symbologies that appear on a sports-card box. Restricting the set
 * materially cuts false positives and CPU compared with "try everything". */
const FORMATS = [
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128
]

type CamError = { title: string; detail: string } | null

/** Turn a getUserMedia failure into something a human can act on. */
function describe(err: unknown): CamError {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      title: 'Camera permission denied',
      detail: 'Allow camera access for RM Operations in your system settings, or use the handheld scanner.'
    }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { title: 'No camera found', detail: 'This computer has no webcam available. Use the handheld scanner instead.' }
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      title: 'Camera unavailable',
      detail: 'Another app is probably using it. Close that app and try again, or use the handheld scanner.'
    }
  }
  return {
    title: 'Camera unavailable',
    detail: 'Check that no other app is using it, or use the handheld scanner.'
  }
}

/**
 * Webcam barcode decoding via @zxing/browser. Feeds the SAME resolve flow as the
 * handheld scanner — it only differs in where the characters come from.
 *
 * Two things matter more than anything else here:
 *  - the decoder fires many times a second, so a repeat of the same code inside
 *    CAMERA_COOLDOWN_MS is suppressed (one physical box must not fire fifty
 *    commits);
 *  - teardown must stop the scanner loop AND every MediaStreamTrack, or the
 *    webcam light stays on after the modal closes.
 */
export function CameraScanner({
  active,
  onDecode
}: {
  active: boolean
  onDecode: (raw: string) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const cb = useRef(onDecode)
  const [error, setError] = useState<CamError>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    cb.current = onDecode
  }, [onDecode])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const video = videoRef.current
    if (!video) return

    // Restricting the format set is both a speed and an accuracy win — zxing
    // stops trying to read QR/PDF417/Aztec out of every frame.
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS)
    hints.set(DecodeHintType.TRY_HARDER, true)
    const reader = new BrowserMultiFormatReader(hints)

    setError(null)
    setStarting(true)
    reader
      // `undefined` device = the browser's default camera. zxing assigns the
      // stream with video.srcObject, never a blob: URL — srcObject is not a URL
      // fetch, so the app's `default-src 'self'` CSP does not block it.
      .decodeFromVideoDevice(undefined, video, (result) => {
        if (!result) return // no barcode in this frame — normal, ignore
        const text = result.getText()
        if (!text) return
        const now = Date.now()
        const same = text === lastRef.current.code
        const quiet = now - lastRef.current.at
        // Sliding window, refreshed on EVERY decode: a box held in frame keeps
        // resetting its own cooldown, so it fires once on arrival and cannot
        // fire again until it has been out of frame for CAMERA_COOLDOWN_MS. A
        // different code always fires immediately.
        lastRef.current = { code: text, at: now }
        if (same && quiet < CAMERA_COOLDOWN_MS) return
        cb.current(text)
      })
      .then((controls) => {
        if (cancelled) {
          controls.stop()
          return
        }
        controlsRef.current = controls
        setStarting(false)
      })
      .catch((err) => {
        if (cancelled) return
        setStarting(false)
        setError(describe(err))
      })

    return () => {
      cancelled = true
      setStarting(false)
      controlsRef.current?.stop()
      controlsRef.current = null
      // stop() alone can leave the tracks live — the webcam LED stays lit until
      // every track is stopped and the element is detached from the stream.
      const stream = video.srcObject
      if (stream instanceof MediaStream) stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      lastRef.current = { code: '', at: 0 }
    }
  }, [active])

  return (
    <div className="scan-cam">
      <video ref={videoRef} className="scan-cam-video" muted playsInline />
      {!error && <div className="scan-cam-frame" aria-hidden />}
      {!error && starting && <div className="scan-cam-hint">Starting camera…</div>}
      {!error && !starting && <div className="scan-cam-hint">Hold the barcode inside the frame</div>}
      {error && (
        <div className="scan-cam-error">
          <Icon name="CameraOff" size={24} />
          <div className="scan-cam-error-title">{error.title}</div>
          <div className="scan-cam-error-detail">{error.detail}</div>
        </div>
      )}
    </div>
  )
}
