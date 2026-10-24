import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const DELAY = 450
const GAP = 6
const MARGIN = 8

interface Tip {
  content: React.ReactNode
  rect: DOMRect
}

/**
 * Styled hover tooltip. Call once per component, spread `bind(content)` on any element(s) and render `node`
 * somewhere in the tree (it portals into document.body). Handlers are additive: compose with existing ones.
 * Hidden while the pointer is over a descendant that has its own native `title`.
 */
export function useTooltip(): {
  bind: (content: React.ReactNode) => Pick<
    React.HTMLAttributes<HTMLElement>,
    'onMouseEnter' | 'onMouseMove' | 'onMouseLeave' | 'onMouseDown' | 'onDragStart' | 'onWheel'
  >
  hide: () => void
  node: React.ReactNode
} {
  const [tip, setTip] = useState<Tip | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef(false)

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    pending.current = false
    setTip(null)
  }, [])

  const schedule = useCallback((content: React.ReactNode, el: HTMLElement) => {
    window.clearTimeout(timer.current)
    pending.current = true
    timer.current = window.setTimeout(() => {
      pending.current = false
      if (el.isConnected) setTip({ content, rect: el.getBoundingClientRect() })
    }, DELAY)
  }, [])

  useEffect(() => {
    if (!tip) return
    window.addEventListener('blur', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [tip, hide])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const bind = useCallback(
    (content: React.ReactNode) => ({
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
        if (!(e.target as HTMLElement).closest('[title]')) schedule(content, e.currentTarget)
      },
      onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
        const t = (e.target as HTMLElement).closest?.('[title]')
        if (t && e.currentTarget.contains(t) && t !== e.currentTarget) {
          if (pending.current || tip) hide()
        } else if (!pending.current && !tip) schedule(content, e.currentTarget)
      },
      onMouseLeave: hide,
      onMouseDown: hide,
      onDragStart: hide,
      onWheel: hide
    }),
    [schedule, hide, tip]
  )

  const node = tip ? <TooltipBubble tip={tip} /> : null
  return { bind, hide, node }
}

function TooltipBubble({ tip }: { tip: Tip }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = tip.rect.left + 4
    let top = tip.rect.bottom + GAP
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))
    if (top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, tip.rect.top - GAP - h)
    setPos({ left, top })
  }, [tip])

  return createPortal(
    <div
      ref={ref}
      className="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {tip.content}
    </div>,
    document.body
  )
}
