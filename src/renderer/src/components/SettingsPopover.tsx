import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useStore } from '../store'
import Dropdown from './Dropdown'
import type { Theme } from '@shared/types'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Gear menu in the top bar for app preferences. */
export default function SettingsPopover() {
  const notifications = useStore((s) => s.notifications)
  const setNotifications = useStore((s) => s.setNotifications)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

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
        </div>
      )}
    </div>
  )
}
