import { useEffect, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { useStore } from '../store'
import { mountTerminal, unmountTerminal, fitTerminal, focusTerminal, setDismissHandler } from '../terminals'

/** Terminals of the active chat's folder: tab strip plus the xterm view of the active tab. */
export default function TerminalPanel({ chatId }: { chatId: string }) {
  const cwd = useStore((s) => s.chats[chatId]?.cwd ?? '')
  const folder = useStore((s) => s.terminals[cwd])
  const loaded = useStore((s) => s.terminalsLoaded)
  const termOpen = useStore((s) => s.terminalOpen)
  const newTerminal = useStore((s) => s.newTerminal)
  const killTerminal = useStore((s) => s.killTerminal)
  const setActive = useStore((s) => s.setActiveTerminal)
  const toggle = useStore((s) => s.toggleTerminal)
  const host = useRef<HTMLDivElement>(null)
  const active = folder?.active ?? null
  const empty = !folder || folder.tabs.length === 0

  // Opening the panel for a folder without shells starts one.
  useEffect(() => {
    if (loaded && termOpen && cwd && empty) void newTerminal(cwd)
  }, [loaded, termOpen, cwd, empty, newTerminal])

  useEffect(() => {
    const el = host.current
    if (!el || !active) return
    mountTerminal(active, el)
    setDismissHandler(active, () => killTerminal(active))
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fitTerminal(active))
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      unmountTerminal(active)
    }
  }, [active, killTerminal])

  return (
    <section className="term-panel">
      <div className="cp-head term-head">
        <span className="cp-title">Terminal</span>
        <div className="term-tabs">
          {folder?.tabs.map((t) => (
            <div key={t.id} className={'term-tab' + (t.id === active ? ' active' : '')} onClick={() => { setActive(cwd, t.id); setTimeout(() => focusTerminal(t.id), 0) }}>
              <span>
                {t.shell} {t.n}
              </span>
              <button
                className="term-tab-x"
                title="Kill this shell"
                onClick={(e) => {
                  e.stopPropagation()
                  killTerminal(t.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button className="icon-btn tiny" title="New terminal" onClick={() => void newTerminal(cwd)}>
          <Plus size={14} />
        </button>
        <div className="grow" />
        <button className="icon-btn tiny" title="Close (Ctrl+`)" onClick={toggle}>
          <X size={14} />
        </button>
      </div>
      <div className="term-body" ref={host} />
    </section>
  )
}
