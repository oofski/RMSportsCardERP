import { useEffect, useRef } from 'react'
import { WEDGE_GAP_MS, WEDGE_MAX_TOTAL_MS, isLikelyScan } from '@shared/upc'

/**
 * The keyboard-wedge timing state machine, kept separate from the React hook so
 * it can be reasoned about (and tested) without a DOM.
 *
 * A handheld scanner is an HID keyboard — there is no device event to listen
 * for, so the ONLY way to tell a scan from typing is timing: every keystroke in
 * a burst lands within WEDGE_GAP_MS of the last, and the whole burst finishes
 * inside WEDGE_MAX_TOTAL_MS. Any slower gap resets the buffer, so ordinary
 * typing can never accumulate into a false scan.
 */
export interface WedgeBuffer {
  /** Feed one keydown. Returns the code when a burst terminates, else null. */
  push(key: string, at: number): string | null
  reset(): void
}

export function createWedgeBuffer(): WedgeBuffer {
  let buffer = ''
  let firstAt = 0
  let lastAt = 0

  const reset = (): void => {
    buffer = ''
    firstAt = 0
    lastAt = 0
  }

  return {
    reset,
    push(key, at) {
      if (key === 'Enter' || key === 'Tab') {
        const code = buffer
        const span = lastAt - firstAt
        reset()
        // A CR+LF scanner sends two terminators; the second finds an empty
        // buffer and is simply discarded.
        if (!code || !isLikelyScan(code) || span > WEDGE_MAX_TOTAL_MS) return null
        return code
      }
      // Printable characters only — Shift, arrows, F-keys and the like are noise.
      if (key.length !== 1) return null
      // Too long a pause: this is new input, not a continuation.
      if (buffer && at - lastAt > WEDGE_GAP_MS) reset()
      if (!buffer) firstAt = at
      buffer += key
      lastAt = at
      return null
    }
  }
}

/**
 * Keyboard-wedge capture — the PRIMARY scan path.
 *
 * The listener is capture-phase on window so it sees the burst before React
 * does, which is what lets it swallow the terminator (stopping Tab from moving
 * focus and Enter from submitting a form) — but only on a burst it actually
 * emits. Anything else propagates untouched.
 */
export function useScanInput({
  enabled,
  onScan
}: {
  enabled: boolean
  /** The raw buffered characters — cleaning/normalising is the backend's job. */
  onScan: (raw: string) => void
}): void {
  // Keep the callback in a ref so a new closure each render doesn't tear the
  // listener down mid-burst and lose the buffer.
  const cb = useRef(onScan)
  useEffect(() => {
    cb.current = onScan
  }, [onScan])

  useEffect(() => {
    if (!enabled) return
    const wedge = createWedgeBuffer()

    const onKey = (e: KeyboardEvent): void => {
      // Ctrl/Cmd/Alt combos are app shortcuts — a scanner never sends them.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        wedge.reset()
        return
      }

      // Never hijack real typing. The one exception is the scan station's own
      // field, which opts in with data-scan-target="true" so the wedge still
      // works while it holds focus.
      const el = e.target instanceof HTMLElement ? e.target : (document.activeElement as HTMLElement | null)
      const armed = el?.getAttribute('data-scan-target') === 'true'
      if (!armed && isEditable(el)) return

      const code = wedge.push(e.key, e.timeStamp || performance.now())
      if (!code) return

      // Inside the armed field, the field's own value is the truth. A person
      // typing "00887521098765" can finish the tail fast enough to look like a
      // burst, and emitting just that tail would silently submit a TRUNCATED
      // barcode (and wipe the field, hiding the mistake). So when the buffer
      // does not account for the whole value, stand down and let the field's
      // Enter handler submit what the user actually sees.
      if (armed && el instanceof HTMLInputElement) {
        const typed = el.value.trim()
        if (typed && typed.length !== code.length) return
      }

      e.preventDefault()
      // Stop the terminator reaching React: the scan is handled here, and the
      // field's own Enter handler is for hand-typed codes only.
      e.stopPropagation()
      cb.current(code)
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      wedge.reset()
    }
  }, [enabled])
}

function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
