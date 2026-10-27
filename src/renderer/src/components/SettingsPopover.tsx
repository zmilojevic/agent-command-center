import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings, X } from 'lucide-react'
import { renderSVG } from 'uqr'
import { useStore } from '../store'
import Dropdown from './Dropdown'
import { playChime } from '../sound'
import { relativeTime, isPhone } from '../util'
import type { Theme, LaunchTools, MobileStatus, PairInfo } from '@shared/types'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Modal with the pairing QR code, the code itself and a countdown; closes itself once a new device shows up. */
function PairDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<PairInfo | null>(null)
  const [now, setNow] = useState(Date.now())
  const [paired, setPaired] = useState<string | null>(null)
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    let alive = true
    void window.desktop.mobileStatus().then((s) => {
      known.current = new Set(s.devices.map((d) => d.id))
      return window.desktop.mobilePairStart().then((i) => alive && setInfo(i))
    })
    const off = window.desktop.onMobileChanged((s) => {
      const seen = known.current
      if (!seen) return
      const fresh = s.devices.find((d) => !seen.has(d.id))
      if (fresh) {
        setPaired(fresh.name)
        known.current = new Set(s.devices.map((d) => d.id))
      }
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      alive = false
      off()
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    if (!paired) return
    const t = setTimeout(onClose, 1500)
    return () => clearTimeout(t)
  }, [paired, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const left = info ? Math.max(0, Math.ceil((info.expiresAt - now) / 1000)) : 0
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pair-modal">
        <div className="modal-head">
          <h3>Pair phone</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        {paired ? (
          <p className="modal-text pair-done">Paired with {paired}</p>
        ) : !info ? (
          <p className="modal-text">Preparing…</p>
        ) : (
          <>
            <p className="modal-text">Scan the code with your phone's camera, or open the address and type the code.</p>
            <div className="pair-qr" dangerouslySetInnerHTML={{ __html: renderSVG(info.url) }} />
            <div className="pair-code">{info.code}</div>
            <div className="pair-url mono">{info.url}</div>
            <div className="muted small">
              {left > 0 ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired. Close this and start again.'}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Gear menu in the top bar for app preferences. */
export default function SettingsPopover() {
  const notifications = useStore((s) => s.notifications)
  const setNotifications = useStore((s) => s.setNotifications)
  const notifySound = useStore((s) => s.notifySound)
  const setNotifySound = useStore((s) => s.setNotifySound)
  const updateCheck = useStore((s) => s.updateCheck)
  const setUpdateCheck = useStore((s) => s.setUpdateCheck)
  const update = useStore((s) => s.update)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const editor = useStore((s) => s.editor)
  const setEditor = useStore((s) => s.setEditor)
  const terminal = useStore((s) => s.terminal)
  const setTerminal = useStore((s) => s.setTerminal)
  const [tools, setTools] = useState<LaunchTools | null>(null)
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState<MobileStatus | null>(null)
  const [pairing, setPairing] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && !tools) void window.desktop.appTools().then(setTools)
  }, [open, tools])

  useEffect(() => {
    if (!open || isPhone) return
    void window.desktop.mobileStatus().then(setMobile)
    return window.desktop.onMobileChanged(setMobile)
  }, [open])

  const editorOptions = [...(tools?.editors ?? []).map((e) => ({ value: e.id, label: e.label })), { value: 'system', label: 'System default' }]
  const terminalOptions = (tools?.terminals ?? []).map((t) => ({ value: t.id, label: t.label }))
  // Empty pref = first detected (main picks the same one).
  const editorValue = editor || tools?.editors[0]?.id || 'system'
  const terminalValue = terminal || tools?.terminals[0]?.id || ''

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="settings" ref={root}>
      <button className={`icon-btn ${open ? 'on' : ''}`} title="Settings" onClick={() => setOpen(!open)}>
        <Settings size={15} />
      </button>
      {open && (
        <div className="settings-pop">
          <div className="toggle-row">
            <span className="toggle-text">
              <span>Theme</span>
              <span className="muted small">System follows the desktop setting</span>
            </span>
            <Dropdown
              className="theme-dd"
              value={theme}
              options={THEMES}
              onChange={(v) => setTheme(v as Theme)}
              title="Theme"
            />
          </div>
          {!isPhone && (
            <>
          <div className="toggle-row">
            <span className="toggle-text">
              <span>Editor</span>
              <span className="muted small">For file paths and folders</span>
            </span>
            <Dropdown className="theme-dd" value={editorValue} options={editorOptions} onChange={setEditor} title="Editor" />
          </div>
          {terminalOptions.length > 0 && (
            <div className="toggle-row">
              <span className="toggle-text">
                <span>Terminal</span>
                <span className="muted small">For "Open terminal here"</span>
              </span>
              <Dropdown className="theme-dd" value={terminalValue} options={terminalOptions} onChange={setTerminal} title="Terminal" />
            </div>
          )}
          <label className="toggle-row">
            <span className="toggle-text">
              <span>Desktop notifications</span>
              <span className="muted small">When a turn finishes or Claude needs you, and that chat isn't in view</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={notifications}
              className={`switch ${notifications ? 'on' : ''}`}
              onClick={() => setNotifications(!notifications)}
            >
              <span className="knob" />
            </button>
          </label>
          {notifications && (
            <label className="toggle-row">
              <span className="toggle-text">
                <span>Notification sound</span>
                <span className="muted small">Hearth's own chime instead of the system sound</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={notifySound}
                className={`switch ${notifySound ? 'on' : ''}`}
                onClick={() => {
                  setNotifySound(!notifySound)
                  if (!notifySound) playChime('done')
                }}
              >
                <span className="knob" />
              </button>
            </label>
          )}
          <label className="toggle-row">
            <span className="toggle-text">
              <span>Check for updates</span>
              {update && <span className="muted small version-line">
                Hearth {update.current}
                {update.newer && update.latest && (
                  <>
                    {' · '}
                    <a onClick={() => update.url && window.open(update.url)}>{update.latest} available</a>
                  </>
                )}
              </span>}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={updateCheck}
              className={`switch ${updateCheck ? 'on' : ''}`}
              onClick={() => setUpdateCheck(!updateCheck)}
            >
              <span className="knob" />
            </button>
          </label>
          <label className="toggle-row">
            <span className="toggle-text">
              <span>Phone access</span>
              <span className="muted small">Use this app from your phone on the same network</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={!!mobile?.enabled}
              className={`switch ${mobile?.enabled ? 'on' : ''}`}
              onClick={() => void window.desktop.mobileSetEnabled(!mobile?.enabled).then(setMobile)}
            >
              <span className="knob" />
            </button>
          </label>
          {mobile?.enabled && (
            <div className="mobile-block">
              {mobile.error && <div className="mobile-err small">{mobile.error}</div>}
              {mobile.running && (
                <div className="muted small mobile-addrs">
                  {(mobile.addresses.length ? mobile.addresses : ['localhost']).map((a) => (
                    <div key={a} className="mono">{`http://${a}:${mobile.port}`}</div>
                  ))}
                </div>
              )}
              {mobile.running && (
                <button className="btn" onClick={() => setPairing(true)}>
                  Pair phone…
                </button>
              )}
              {mobile.devices.map((d) => (
                <div key={d.id} className="mobile-device">
                  <span className="mobile-device-name">{d.name}</span>
                  <span className="muted small">last seen {relativeTime(d.lastSeen)}</span>
                  <button className="icon-btn tiny" title="Revoke" onClick={() => void window.desktop.mobileRevoke(d.id).then(setMobile)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
            </>
          )}
        </div>
      )}
      {pairing && <PairDialog onClose={() => setPairing(false)} />}
    </div>
  )
}
