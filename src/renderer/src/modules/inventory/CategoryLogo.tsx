import { Boxes, Clapperboard } from 'lucide-react'

/**
 * A simple, generic line-logo per product category, drawn in the same stroke
 * style as the rest of the app's icons. Falls back to a boxes glyph for any
 * category without a dedicated logo.
 */
export function CategoryLogo({
  category,
  size = 18
}: {
  category: string
  size?: number
}): JSX.Element {
  if (category === 'Entertainment') return <Clapperboard size={size} strokeWidth={1.7} />

  const path = LOGOS[category]
  if (!path) return <Boxes size={size} strokeWidth={1.7} />

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

const LOGOS: Record<string, JSX.Element> = {
  Baseball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6.6 5c2.4 3.6 2.4 10.4 0 14" />
      <path d="M17.4 5c-2.4 3.6-2.4 10.4 0 14" />
    </>
  ),
  Basketball: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M5.6 5.6c3 3.3 3 9.5 0 12.8" />
      <path d="M18.4 5.6c-3 3.3-3 9.5 0 12.8" />
    </>
  ),
  Football: (
    <>
      <ellipse cx="12" cy="12" rx="9" ry="5.5" />
      <path d="M8.5 12h7" />
      <path d="M10 10.6v2.8" />
      <path d="M12 10.4v3.2" />
      <path d="M14 10.6v2.8" />
    </>
  ),
  Soccer: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.4l3 2.2-1.15 3.5h-3.7L9 10.6z" />
      <path d="M12 3.1v3.3" />
      <path d="M20.4 9.2l-3.4 1.4" />
      <path d="M16.9 19.4l-2.9-1.3" />
      <path d="M7.1 19.4l2.9-1.3" />
      <path d="M3.6 9.2l3.4 1.4" />
    </>
  ),
  UFC: (
    <>
      <path d="M15 20H9a4 4 0 0 1-4-4v-2a2 2 0 0 1 2-2h2V8.5a3 3 0 0 1 6 0V11a3 3 0 0 1 3 3v2a4 4 0 0 1-3 4z" />
      <path d="M9 14H6.6" />
      <path d="M8.6 17.3h6.8" />
    </>
  ),
  Pokemon: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h5.4" />
      <path d="M15.6 12H21" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  )
}
