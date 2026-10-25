import { Children, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { useStore } from '../store'

const MIN_PANE = 120

/**
 * Right-hand column: holds the Changes and Terminal panels. Owns the width drag handle (left edge) and, when both
 * panels are open, the horizontal splitter between them (`dockSplit` = fraction for the top panel).
 */
export default function RightDock({ children }: { children: ReactNode }) {
  const width = useStore((s) => s.changesWidth)
  const setWidth = useStore((s) => s.setChangesWidth)
  const split = useStore((s) => s.dockSplit)
  const setSplit = useStore((s) => s.setDockSplit)
  const dock = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const [splitDragging, setSplitDragging] = useState(false)
  const panes = Children.toArray(children)

  const capture = (e: RPointerEvent<HTMLDivElement>, set: (v: boolean) => void): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
    set(true)
  }
  const release = (e: RPointerEvent<HTMLDivElement>, set: (v: boolean) => void): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.userSelect = ''
    set(false)
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const row = e.currentTarget.closest('.main-row')
    if (!row) return
    const r = row.getBoundingClientRect()
    setWidth(Math.min(r.right - e.clientX, r.width * 0.6))
  }
  const onSplitMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!splitDragging || !dock.current) return
    const r = dock.current.getBoundingClientRect()
    if (r.height <= MIN_PANE * 2) return
    const top = Math.min(r.height - MIN_PANE, Math.max(MIN_PANE, e.clientY - r.top))
    setSplit(top / r.height)
  }

  return (
    <aside ref={dock} className="right-dock" style={{ '--cp-w': `${width}px` } as CSSProperties}>
      <div
        className={'cp-resize' + (dragging ? ' dragging' : '')}
        onPointerDown={(e) => capture(e, setDragging)}
        onPointerMove={onMove}
        onPointerUp={(e) => release(e, setDragging)}
        onPointerCancel={(e) => release(e, setDragging)}
        onDoubleClick={() => setWidth(520)}
      />
      {panes.map((p, i) => (
        <div key={(p as { key?: string }).key ?? i} style={{ display: 'contents' }}>
          {i > 0 && (
            <div
              className={'dock-split' + (splitDragging ? ' dragging' : '')}
              onPointerDown={(e) => capture(e, setSplitDragging)}
              onPointerMove={onSplitMove}
              onPointerUp={(e) => release(e, setSplitDragging)}
              onPointerCancel={(e) => release(e, setSplitDragging)}
              onDoubleClick={() => setSplit(0.5)}
            />
          )}
          <div className="dock-pane" style={{ flexGrow: panes.length > 1 ? (i === 0 ? split : 1 - split) : 1, minHeight: panes.length > 1 ? MIN_PANE : 0 }}>
            {p}
          </div>
        </div>
      ))}
    </aside>
  )
}
