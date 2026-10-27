import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { ensureTerminal, mountTerminal, fitTerminal, focusTerminal, disposeTerminal } from '../terminals'

type Phase = 'starting' | 'running' | 'failed' | 'done'

/** Runs `claude auth login` in a pty and shows it in an xterm (the CLI opens the browser and may ask for a pasted code). */
export default function LoginDialog() {
  const closeLogin = useStore((s) => s.closeLogin)
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [ptyId, setPtyId] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const current = useRef<string | null>(null)

  const close = (): void => {
    if (current.current) void window.desktop.ptyKill(current.current)
    closeLogin()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation() // also keeps xterm's Esc handler (close the terminal panel) from seeing it
        closeLogin()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [closeLogin])

  // Kill the login process when the dialog goes away, whichever way.
  useEffect(
    () => () => {
      if (current.current) {
        void window.desktop.ptyKill(current.current)
        disposeTerminal(current.current)
      }
    },
    [],
  )

  useEffect(() => {
    let alive = true
    let id: string | null = null
    const early: string[] = []
    const onExit = (): void => {
      setPhase('running')
      void useStore.getState().checkAuth().then(() => {
        if (!alive) return
        if (useStore.getState().auth === 'in') {
          setPhase('done')
          void window.desktop.getUsage(true).catch(() => null)
          closeLogin()
        } else setPhase('failed')
      })
    }
    // Subscribed before the pty exists, so an immediate exit is not missed.
    const off = window.desktop.onPtyExit((e) => {
      if (id === null) early.push(e.id)
      else if (e.id === id) onExit()
    })
    setPhase('starting')
    setError('')
    void window.desktop.authLogin().then((r) => {
      if (!alive) {
        if (r.id) void window.desktop.ptyKill(r.id)
        return
      }
      if (!r.id) {
        setError(r.error ?? 'Could not start the login')
        setPhase('failed')
        return
      }
      id = r.id
      current.current = r.id
      ensureTerminal(r.id)
      setPtyId(r.id)
      setPhase('running')
      if (early.includes(r.id)) onExit()
    })
    return () => {
      alive = false
      off()
      if (id) {
        void window.desktop.ptyKill(id)
        disposeTerminal(id)
        if (current.current === id) current.current = null
      }
    }
  }, [attempt, closeLogin])

  useEffect(() => {
    const el = host.current
    if (!ptyId || !el) return
    mountTerminal(ptyId, el)
    let n = 0
    const focus = (): void => {
      if (!focusTerminal(ptyId) && n++ < 20) requestAnimationFrame(focus)
    }
    focus()
    const ro = new ResizeObserver(() => fitTerminal(ptyId))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ptyId])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal login-modal">
        <div className="modal-head">
          <h3>Log in to Claude</h3>
          <button className="icon-btn" onClick={close} title="Close">
            <X size={16} />
          </button>
        </div>
        <p className="modal-text">
          Hearth uses your Claude Code login. A browser window opens; if it doesn't, open the link below and paste the code you get back here.
        </p>
        {error && <p className="modal-text login-err">{error}</p>}
        <div className="login-term" ref={host} />
        <div className="modal-actions">
          {phase === 'failed' && (
            <button
              className="btn"
              onClick={() => {
                if (current.current) {
                  void window.desktop.ptyKill(current.current)
                  disposeTerminal(current.current)
                  current.current = null
                }
                setPtyId(null)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </button>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
