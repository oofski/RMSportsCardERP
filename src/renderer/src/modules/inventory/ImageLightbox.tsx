import { useEffect } from 'react'
import type { ProductImage } from '@shared/types'
import { Icon } from '../../components/Icon'

/**
 * Full-screen image viewer for a product's photos. Opens from the catalog
 * detail when a thumbnail is clicked. Supports prev/next navigation (buttons +
 * arrow keys), a counter, and Escape / backdrop-click to close.
 */
export function ImageLightbox({
  images,
  index,
  alt,
  onIndex,
  onClose
}: {
  images: ProductImage[]
  index: number
  alt: string
  onIndex: (i: number) => void
  onClose: () => void
}): JSX.Element | null {
  const count = images.length
  const safe = Math.max(0, Math.min(index, count - 1))
  const current = images[safe]

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (count > 1 && e.key === 'ArrowLeft') onIndex((safe - 1 + count) % count)
      else if (count > 1 && e.key === 'ArrowRight') onIndex((safe + 1) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [safe, count, onIndex, onClose])

  if (!current) return null

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${alt} — image viewer`} onClick={onClose}>
      <button type="button" className="lb-close" aria-label="Close image viewer" onClick={onClose}>
        <Icon name="X" size={22} />
      </button>

      {count > 1 && (
        <button
          type="button"
          className="lb-nav lb-prev"
          aria-label="Previous image"
          onClick={(e) => {
            e.stopPropagation()
            onIndex((safe - 1 + count) % count)
          }}
        >
          <Icon name="ArrowLeft" size={24} />
        </button>
      )}

      <figure className="lb-figure" onClick={(e) => e.stopPropagation()}>
        <img src={current.dataUrl} alt={alt} />
        <figcaption className="lb-caption">
          <span className="lb-title">{alt}</span>
          {count > 1 && (
            <span className="lb-count">
              {safe + 1} / {count}
            </span>
          )}
        </figcaption>
      </figure>

      {count > 1 && (
        <button
          type="button"
          className="lb-nav lb-next"
          aria-label="Next image"
          onClick={(e) => {
            e.stopPropagation()
            onIndex((safe + 1) % count)
          }}
        >
          <Icon name="ArrowRight" size={24} />
        </button>
      )}
    </div>
  )
}
