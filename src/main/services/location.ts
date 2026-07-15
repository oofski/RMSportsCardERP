import type { PunchLocation } from '@shared/types'

const EMPTY: PunchLocation = { place: null, lat: null, lng: null }

/**
 * Best-effort, rough (city-level) location for a clock punch. Uses IP-based
 * geolocation from the main process so it works without prompting for browser
 * geolocation permission and without a Google API key. Never throws — if the
 * lookup fails or the machine is offline, the punch is still recorded with a
 * null location.
 */
export async function roughLocation(): Promise<PunchLocation> {
  const providers = [fromIpapiCo, fromIpApiCom]
  for (const provider of providers) {
    try {
      const result = await provider()
      if (result && (result.place || result.lat != null)) return result
    } catch {
      // try the next provider
    }
  }
  return { ...EMPTY }
}

async function withTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fromIpapiCo(): Promise<PunchLocation> {
  const res = await withTimeout('https://ipapi.co/json/', 3000)
  if (!res.ok) throw new Error(`ipapi.co ${res.status}`)
  const d = (await res.json()) as {
    city?: string
    region?: string
    country_name?: string
    latitude?: number
    longitude?: number
  }
  return {
    place: joinPlace([d.city, d.region, d.country_name]),
    lat: typeof d.latitude === 'number' ? d.latitude : null,
    lng: typeof d.longitude === 'number' ? d.longitude : null
  }
}

async function fromIpApiCom(): Promise<PunchLocation> {
  const res = await withTimeout(
    'https://ip-api.com/json/?fields=status,country,regionName,city,lat,lon',
    3000
  )
  if (!res.ok) throw new Error(`ip-api.com ${res.status}`)
  const d = (await res.json()) as {
    status?: string
    city?: string
    regionName?: string
    country?: string
    lat?: number
    lon?: number
  }
  if (d.status !== 'success') throw new Error('ip-api.com lookup failed')
  return {
    place: joinPlace([d.city, d.regionName, d.country]),
    lat: typeof d.lat === 'number' ? d.lat : null,
    lng: typeof d.lon === 'number' ? d.lon : null
  }
}

function joinPlace(parts: Array<string | undefined>): string | null {
  const clean = parts.filter((p): p is string => !!p && p.trim().length > 0)
  return clean.length ? clean.join(', ') : null
}
