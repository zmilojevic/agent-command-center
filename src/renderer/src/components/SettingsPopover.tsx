import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useStore } from '../store'
import Dropdown from './Dropdown'
import type { Theme, LaunchTools } from '@shared/types'

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
  const editor = useStore((s) => s.editor)
  const setEditor = useStore((s) => s.setEditor)
  const terminal = useStore((s) => s.terminal)
  const setTerminal = useStore((s) => s.setTerminal)
  const [tools, setTools] = useState<LaunchTools | null>(null)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && !tools) void window.desktop.appTools().then(setTools)
  }, [open, tools])

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
        </div>
      )}
    </div>
  )
}
