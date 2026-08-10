/**
 * The browser's half of clock-in notifications.
 *
 * Everything here is capability detection and one subscribe call. The signing
 * and the encryption happen in the Cloudflare Worker; this file's real job is to
 * be able to say WHY notifications are not available, in a sentence somebody can
 * act on, because the ways they can be unavailable are numerous, silent, and
 * mostly not the user's fault.
 *
 * ## iOS, which is the whole reason this file has a diagnosis instead of a boolean
 *
 * Safari supports web push since 16.4, and ONLY for a site the user has added to
 * their Home Screen. In an ordinary Safari tab, `Notification` and
 * `PushManager` are undefined — not "permission denied", undefined. So the
 * honest failure is not a dead toggle: it is a short instruction, and this file
 * exists to produce it.
 *
 * The detection is deliberately positive rather than user-agent sniffing, with
 * one exception: telling "iPhone in a tab" apart from "desktop browser with
 * notifications switched off at the OS level" cannot be done from feature
 * detection alone, and those two need completely different advice.
 */

/** Why the toggle cannot be offered, or null when it can. */
export type PushBlocker =
  | 'electron'
  | 'insecure'
  | 'ios-needs-home-screen'
  | 'unsupported'
  | 'permission-denied'
  | null

export interface PushCapability {
  /** Can this browser subscribe at all, right now? */
  usable: boolean
  blocker: PushBlocker
  /** What to tell the person looking at the screen. */
  message: string
  /** The browser's current answer, when it has one. */
  permission: NotificationPermission | 'unavailable'
}

/** True on an iPhone or iPad, including iPadOS pretending to be a Mac. */
function isApplePhoneOrTablet(): boolean {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ reports itself as a Mac. A Mac with a touchscreen is the tell.
  return /Macintosh/.test(ua) && typeof document !== 'undefined' && navigator.maxTouchPoints > 1
}

/** Running from the Home Screen (or any installed PWA) rather than in a tab. */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true
  const displayMode =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  return iosStandalone || displayMode
}

const IOS_INSTRUCTIONS =
  'On an iPhone or iPad, notifications only work once this app has been added to the Home ' +
  'Screen — Apple allows nothing else. Tap the Share button at the bottom of Safari, choose ' +
  '"Add to Home Screen", then open the app from the new icon and come back to this screen. ' +
  'It has to be Safari; Chrome on iOS cannot do it.'

/**
 * What this browser can do, and what to say when it cannot.
 *
 * Ordered from most specific to least, because the generic "your browser does
 * not support notifications" is true of the iOS case too and is exactly the
 * unhelpful answer this whole file exists to avoid.
 */
export function pushCapability(): PushCapability {
  // The desktop build loads over file://, where service workers do not exist at
  // all. Not a fault — it is simply the wrong door, and the phone is the point.
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return {
      usable: false,
      blocker: 'electron',
      permission: 'unavailable',
      message:
        'Notifications are set up in the browser version of the app, on the phone that should ' +
        'receive them. Open the web address on your phone and come back to this screen there.'
    }
  }

  // A service worker needs a secure context. localhost counts; a bare LAN
  // address over http does not, and that is a real way to reach this app.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      usable: false,
      blocker: 'insecure',
      permission: 'unavailable',
      message:
        'This page is not on a secure (https) connection, and browsers only allow notifications ' +
        'on one. Open the app at its https address.'
    }
  }

  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  const hasPushManager = typeof window !== 'undefined' && 'PushManager' in window
  const hasNotification = typeof window !== 'undefined' && 'Notification' in window

  if (!hasServiceWorker || !hasPushManager || !hasNotification) {
    // THE support question this screen exists to answer. On an iPhone in an
    // ordinary tab these three are simply absent, and "unsupported" would be a
    // lie — the phone supports it perfectly, one tap away.
    if (isApplePhoneOrTablet() && !isStandalone()) {
      return {
        usable: false,
        blocker: 'ios-needs-home-screen',
        permission: 'unavailable',
        message: IOS_INSTRUCTIONS
      }
    }
    return {
      usable: false,
      blocker: 'unsupported',
      permission: 'unavailable',
      message:
        'This browser cannot receive notifications. Chrome, Edge, Firefox and Safari 16.4 or ' +
        'newer can; older Safari and most in-app browsers cannot.'
    }
  }

  // Added to the Home Screen but on an iOS old enough to lack push: the APIs
  // exist on newer versions only, so reaching here on an Apple device in a tab
  // means the browser is not Safari's engine or the version is fine — either
  // way the instruction below is still the useful one.
  if (isApplePhoneOrTablet() && !isStandalone()) {
    return {
      usable: false,
      blocker: 'ios-needs-home-screen',
      permission: 'unavailable',
      message: IOS_INSTRUCTIONS
    }
  }

  if (Notification.permission === 'denied') {
    return {
      usable: false,
      blocker: 'permission-denied',
      permission: 'denied',
      message:
        'Notifications are blocked for this site in your browser settings, and the app cannot ' +
        'ask again — the browser only offers that once. Allow notifications for this site in ' +
        'the site settings (the icon beside the address), then reload.'
    }
  }

  return { usable: true, blocker: null, permission: Notification.permission, message: '' }
}

/**
 * Bytes → base64url, for the two keys the subscription hands over.
 *
 * The relay stores these as text and decodes them again when it encrypts, so
 * the alphabet has to survive the trip. base64url because these end up in JSON
 * and in log lines, and `+` and `/` are the two characters that get mangled.
 */
function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The VAPID public key has to reach `subscribe()` as raw bytes.
 *
 * `applicationServerKey` accepts a BufferSource, not the base64url string every
 * server hands you. Passing the string produces a subscription that looks
 * perfectly fine and that no notification is ever delivered to.
 */
function applicationServerKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  // An ArrayBuffer rather than the Uint8Array view over it: TypeScript's DOM
  // types only accept a view whose backing buffer is provably not shared, and
  // handing over the buffer itself sidesteps that without a cast that could
  // hide a real mistake later.
  const out = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(out)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return out
}

/** A name a person will recognise in a list of their own devices. */
export function deviceLabel(): string {
  const ua = navigator.userAgent || ''
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Device'
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua) && !/Edg/.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  return `${platform} (${browser})`
}

export const SERVICE_WORKER_URL = '/sw.js'

/**
 * Register the service worker, once, and hand back the registration.
 *
 * `navigator.serviceWorker.ready` rather than the register() promise: register
 * resolves as soon as the file is fetched, which can be BEFORE the worker is
 * active, and subscribing against an installing worker fails intermittently —
 * the worst kind of bug to have on somebody else's phone.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' })
  return navigator.serviceWorker.ready
}

export interface SubscribeResult {
  ok: boolean
  error?: string
  subscription?: { endpoint: string; p256dh: string; auth: string; label: string }
}

/**
 * Ask permission, register the worker, subscribe, and return the three public
 * values the relay needs.
 *
 * The permission prompt has to come from a user gesture — a button press — or
 * browsers refuse it silently. That is why this is one function called from an
 * onClick rather than something that runs when the screen mounts.
 */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeResult> {
  if (!publicKey) {
    return { ok: false, error: 'The relay did not provide a notification key.' }
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return {
      ok: false,
      error:
        permission === 'denied'
          ? 'You blocked notifications for this site. Allow them in the browser settings and try again.'
          : 'Notifications were not allowed.'
    }
  }

  const registration = await ensureServiceWorker()

  // An existing subscription made against a DIFFERENT VAPID key is worse than
  // no subscription: subscribe() rejects rather than replacing it, and the
  // device silently keeps a dead one. Rotating the key pair is exactly when
  // this happens, so drop and re-make.
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    const same =
      existing.options &&
      existing.options.applicationServerKey &&
      toBase64Url(existing.options.applicationServerKey as ArrayBuffer) === publicKey
    if (!same) await existing.unsubscribe()
  }

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Non-negotiable everywhere. A subscription that could deliver silently
      // is one browsers do not issue to a web app.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey)
    }))

  const p256dh = toBase64Url(subscription.getKey('p256dh'))
  const auth = toBase64Url(subscription.getKey('auth'))
  if (!p256dh || !auth) {
    return { ok: false, error: 'The browser produced a subscription with no keys.' }
  }
  return {
    ok: true,
    subscription: { endpoint: subscription.endpoint, p256dh, auth, label: deviceLabel() }
  }
}

/**
 * What this device is currently subscribed to, if anything.
 *
 * Read from the browser rather than from the server, because the browser is the
 * authority on its OWN subscription — the relay's list can contain rows for
 * three phones and says nothing about which one is in your hand.
 */
export async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL)
  if (!registration) return null
  const subscription = await registration.pushManager.getSubscription()
  return subscription ? subscription.endpoint : null
}

/** Turn it off here: unsubscribe in the browser, then tell the relay to forget it. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL)
  if (!registration) return null
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return null
  const endpoint = subscription.endpoint
  // The browser first. If this fails the relay row stays, which is recoverable;
  // the reverse leaves a phone receiving notifications with nothing on any
  // screen offering to stop them.
  await subscription.unsubscribe()
  return endpoint
}
