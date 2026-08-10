/**
 * The service worker. Its entire job is to be awake when the tab is not.
 *
 * A push notification is delivered to the BROWSER, not to a page — the phone is
 * locked, the app is closed, and there is nothing running to receive anything.
 * The browser starts this file, hands it the encrypted payload it has already
 * decrypted with the device's own keys, and gives it a few seconds to draw a
 * notification. That is the whole of it: no caching, no offline shell, no fetch
 * handler.
 *
 * ## Why there is deliberately no fetch handler
 *
 * The usual advice is to add one so a browser will call the site installable.
 * It is not worth it here. A fetch handler sits in front of EVERY navigation,
 * and a service worker that throws in one has taken the whole app off the air
 * for everybody it is installed on — recoverable only by clearing site data on
 * each phone, which is not a thing you can talk somebody through. This app has
 * no offline story to gain in exchange: every screen is a live query against a
 * server. Installing from the browser's own menu works without one, and on iOS
 * — the platform this exists for — "Add to Home Screen" has never cared.
 *
 * Deliberately NOT part of the Vite bundle. A service worker is fetched by URL
 * and versioned by its bytes, so it must be a stable path (/sw.js) with no
 * content hash — a hashed filename would register a brand-new worker on every
 * deploy and orphan the old one, which is how a phone ends up with two workers
 * and duplicate notifications. It lives in the renderer's `public` folder, which
 * Vite copies verbatim.
 *
 * It is plain ES5-ish JavaScript for the same reason: nothing compiles it.
 *
 * ## The one thing worth reading twice
 *
 * The Worker sends a UTC INSTANT and this file formats it. A clock-in is a
 * physical event that happened at a moment in time; the relay has no idea what
 * timezone the phone is in, and the phone knows exactly. Formatting on the
 * server would mean guessing, and a wrong guess puts "clocked in at 2:30am" on
 * somebody's lock screen for a shift that started at 7:30. Same reasoning as the
 * timesheet in cloud/worker.js, written down again here because this is the
 * other end of it.
 */

/* global self, clients */

const FALLBACK_TITLE = 'RM Operations'

/**
 * Take over immediately rather than waiting for every tab to close.
 *
 * Without these two, a newly deployed worker sits in "waiting" until the last
 * tab using the old one is gone — and on a phone that has an app on the home
 * screen, that can be weeks. A fix to this file would ship and do nothing.
 */
self.addEventListener('install', function () {
  self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim())
})

function formatLocalTime(iso) {
  try {
    const when = new Date(iso)
    if (isNaN(when.getTime())) return ''
    return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch (err) {
    return ''
  }
}

/**
 * Turn the payload into the two lines a person actually reads.
 *
 * Defensive about every field, because this runs on a payload that came off the
 * network and a thrown exception here is a notification that never appears with
 * nowhere to see why — there is no console attached to a locked phone.
 */
function describe(data) {
  if (!data || typeof data !== 'object') {
    return { title: FALLBACK_TITLE, body: 'Someone clocked in or out.', tag: 'rmops-clock' }
  }
  const name = typeof data.name === 'string' && data.name ? data.name : 'Someone'
  const at = formatLocalTime(data.at)

  if (data.kind === 'test') {
    return {
      title: 'Notifications are working',
      body: at ? 'Sent at ' + at + '.' : 'This is a test.',
      tag: 'rmops-test'
    }
  }

  const action = data.kind === 'out' ? 'clocked out' : 'clocked in'
  let body = at ? 'at ' + at : ''
  if (data.place) body = body ? body + ' · ' + data.place : String(data.place)
  return {
    title: name + ' ' + action,
    body: body || 'Just now.',
    // One tag per person, so somebody punching in and straight back out
    // REPLACES their own notification instead of stacking two. renotify keeps
    // the second one audible — silently swapping the text would mean a
    // clock-out nobody noticed.
    tag: 'rmops-clock-' + (name || 'x'),
    renotify: true
  }
}

self.addEventListener('push', function (event) {
  let data = null
  if (event.data) {
    try {
      data = event.data.json()
    } catch (err) {
      // A payload that will not parse is still a real event. Showing the
      // generic notification is far better than showing nothing, because on
      // most platforms a push handler that displays nothing at all eventually
      // costs the site its permission to send any.
      data = null
    }
  }
  const shown = describe(data)
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: shown.body,
      tag: shown.tag,
      renotify: shown.renotify === true,
      icon: '/app-icon-192.png',
      // A BADGE is not a small icon. Android draws it in the status bar from
      // the ALPHA CHANNEL ONLY and tints it, so a full-colour icon here comes
      // out as a solid grey square — the app-icon-badge file is the wordmark
      // keyed down to a silhouette for exactly this. See
      // scripts/make-pwa-icons.mjs.
      badge: '/app-icon-badge-96.png',
      // No sound and no vibration pattern: these arrive through a working day
      // and one that buzzes for every punch is one everybody turns off.
      silent: false,
      data: data || {}
    })
  )
})

/**
 * Tapping the notification opens the app rather than a second copy of it.
 *
 * Focusing an existing window matters on a phone: without it, every tap since
 * breakfast is another entry in the app switcher.
 */
self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      for (let i = 0; i < windows.length; i++) {
        if ('focus' in windows[i]) return windows[i].focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow('/')
      return undefined
    })
  )
})

/**
 * The browser rotated the subscription behind our back.
 *
 * Push services expire endpoints, and when that happens the browser fires this
 * ONCE and then forgets. There is no session and no cookie guaranteed here, so
 * this cannot re-register on its own — it tells any open tab, and the
 * notifications screen re-subscribes through the ordinary authenticated path.
 * If no tab is open the toggle simply reads as off next time somebody looks,
 * which is honest: it IS off.
 */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      for (let i = 0; i < windows.length; i++) {
        windows[i].postMessage({ type: 'rmops-push-subscription-changed' })
      }
    })
  )
})
