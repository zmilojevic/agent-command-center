import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/** A rounded image thumbnail that opens full-size in an overlay on click. */
export default function ImageThumb({ src, alt = 'Image', className = '' }: { src: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  return (
    <>
      <button type="button" className={`img-thumb ${className}`} title="Open image" onClick={() => setOpen(true)}>
        <img src={src} alt={alt} draggable={false} />
      </button>
      {open &&
        createPortal(
          <div className="lightbox" onMouseDown={() => setOpen(false)}>
            <img src={src} alt={alt} onMouseDown={(e) => e.stopPropagation()} />
            <button type="button" className="lightbox-close icon-btn" title="Close (Esc)" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
