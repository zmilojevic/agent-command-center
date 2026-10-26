import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { useStore } from '../store'

const MIN_PANE = 120

const ORDER = ['changes', 'terminal']
const sortIds = (ids: string[]): string[] => [...ids].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))

export type DockPane = { id: 'changes' | 'terminal'; node: ReactNode }

type PaneState = {
  key: string // ids of the open panes, joined; '' = dock closed
  list: string[] // rendered panes (open ones plus leaving ones)
  grown: string[] // panes at their target size (entering ones are not yet, leaving ones no longer)
  anim: boolean // a pane enter/leave transition is running
}

/**
 * Right-hand column: holds the Changes and Terminal panels. Slides open/closed like a drawer (same 180 ms ease as the sidebar
 * groups; content stays mounted ~200 ms while closing, first mount never animates). Owns the width drag handle (left edge)
 * and, when both panels are open, the horizontal splitter between them (`dockSplit` = fraction for the top panel).
 * Panes are diffed by `id`, never by React key, so switching chats does not animate.
 */
export default function RightDock({ panes }: { panes: DockPane[] }) {
  const width = useStore((s) => s.changesWidth)
  const setWidth = useStore((s) => s.setChangesWidth)
  const split = useStore((s) => s.dockSplit)
  const setSplit = useStore((s) => s.setDockSplit)
  const max = useStore((s) => s.changesMax && s.changesOpen)
  const dock = useRef<HTMLElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [splitDragging, setSplitDragging] = useState(false)

  const ids = sortIds(panes.map((p) => p.id))
  const key = ids.join(',')
  const open = ids.length > 0

  // Latest node per pane id; leaving panes keep rendering their last node.
  const nodes = useRef<Record<string, ReactNode>>({})
  for (const p of panes) nodes.current[p.id] = p.node

  // --- dock open/close (pattern of GroupBody in Sidebar) ---
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const [anim, setAnim] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    const wasFirst = first.current
    first.current = false
    let t1 = 0
    let t2 = 0
    let r1 = 0
    let r2 = 0
    if (!wasFirst) {
      setAnim(true)
      t2 = window.setTimeout(() => setAnim(false), 220)
    }
    if (open) {
      setMounted(true)
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setShown(true))
      })
    } else {
      setShown(false)
      t1 = window.setTimeout(() => setMounted(false), 200)
    }
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [open])

  // --- pane list (1 <-> 2 panes while open) ---
  const [ps, setPs] = useState<PaneState>(() => ({ key, list: ids, grown: ids, anim: false }))
  let cur = ps
  if (ps.key !== key) {
    if (!open) cur = { ...ps, key } // closing: keep the last panes for the exit animation
    else if (ps.key === '') cur = { key, list: ids, grown: ids, anim: false } // opening from closed: the dock animates
    else cur = { key, list: sortIds([...new Set([...ps.list, ...ids])]), grown: ids.filter((id) => ps.list.includes(id)), anim: true }
    setPs(cur)
  }
  const curRef = useRef(cur)
  curRef.current = cur
  useEffect(() => {
    if (!open) return
    const c = curRef.current
    const entering = ids.filter((id) => !c.grown.includes(id))
    const leaving = c.list.filter((id) => !ids.includes(id))
    if (!entering.length && !leaving.length) return
    let r1 = 0
    let r2 = 0
    const timers: number[] = []
    setPs((p) => (p.key === key ? { ...p, anim: true, grown: p.grown.filter((id) => ids.includes(id)) } : p))
    if (entering.length) {
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPs((p) => (p.key === key ? { ...p, grown: ids } : p)))
      })
    }
    if (leaving.length) timers.push(window.setTimeout(() => setPs((p) => (p.key === key ? { ...p, list: p.list.filter((id) => ids.includes(id)) } : p)), 200))
    timers.push(window.setTimeout(() => setPs((p) => (p.key === key ? { ...p, anim: false } : p)), 220))
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // --- width: measured from the parent .main-row so the aside keeps a fixed pixel width while the slot animates ---
  const [rowW, setRowW] = useState(0)
  useLayoutEffect(() => {
    const row = slot.current?.parentElement
    if (!row) return
    const measure = (): void => setRowW(row.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    return () => ro.disconnect()
  }, [mounted])
  // chat column keeps 300 px + the 44 px ToolStrip; at least min(300px, 50%)
  const W = Math.max(Math.min(300, rowW * 0.5), Math.min(width, rowW - 344))

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
    // chat column keeps 300 px; the 44 px ToolStrip sits in the row too
    setWidth(Math.min(r.right - e.clientX, r.width - 344))
  }
  const onSplitMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!splitDragging || !dock.current) return
    const r = dock.current.getBoundingClientRect()
    if (r.height <= MIN_PANE * 2) return
    const top = Math.min(r.height - MIN_PANE, Math.max(MIN_PANE, e.clientY - r.top))
    setSplit(top / r.height)
  }

  if (!mounted) return null

  const grown = cur.list.filter((id) => cur.grown.includes(id))
  const twoUp = grown.length > 1
  const showSplit = cur.list.length > 1 && cur.list.every((id) => ids.includes(id))
  const grow = (id: string): number => {
    if (!cur.grown.includes(id)) return 0
    return twoUp ? (grown[0] === id ? split : 1 - split) : 1
  }

  return (
    <div
      ref={slot}
      className={'dock-slot' + (shown ? ' open' : '') + (anim ? ' anim' : '') + (max ? ' max' : '')}
      style={{ width: shown && !max ? W : 0 }}
      inert={!open}
    >
      <aside ref={dock} className={'right-dock' + (max ? ' max' : '')} style={max ? undefined : { width: W }}>
        {!max && (
          <div
            className={'cp-resize' + (dragging ? ' dragging' : '')}
            onPointerDown={(e) => capture(e, setDragging)}
            onPointerMove={onMove}
            onPointerUp={(e) => release(e, setDragging)}
            onPointerCancel={(e) => release(e, setDragging)}
            onDoubleClick={() => setWidth(520)}
          />
        )}
        {rowW > 0 && cur.list.map((id, i) => (
          <div key={id} style={{ display: 'contents' }}>
            {i > 0 && showSplit && (
              <div
                className={'dock-split' + (splitDragging ? ' dragging' : '')}
                onPointerDown={(e) => capture(e, setSplitDragging)}
                onPointerMove={onSplitMove}
                onPointerUp={(e) => release(e, setSplitDragging)}
                onPointerCancel={(e) => release(e, setSplitDragging)}
                onDoubleClick={() => setSplit(0.5)}
              />
            )}
            <div
              className={'dock-pane' + (cur.anim ? ' anim' : '')}
              style={{ flexGrow: grow(id), minHeight: !cur.anim && twoUp ? MIN_PANE : 0 }}
            >
              {nodes.current[id]}
            </div>
          </div>
        ))}
      </aside>
    </div>
  )
}
