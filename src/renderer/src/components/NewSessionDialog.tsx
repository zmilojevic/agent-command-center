import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { useStore } from '../store'
import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { projectName, shortPath } from '../util'
import Dropdown from './Dropdown'

const MODELS = [
  { value: 'default', label: 'Default (from Claude Code settings)' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export default function NewSessionDialog() {
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.projectNames)
  const generalDir = useStore((s) => s.generalDir)
  const lastCwd = useStore((s) => s.lastCwd)
  const presetCwd = useStore((s) => s.newDialogCwd)
  const lastModel = useStore((s) => s.lastModel)
  const lastMode = useStore((s) => s.lastMode)
  const newChat = useStore((s) => s.newChat)
  const close = (): void => useStore.getState().setShowNewDialog(false)

  const [home, setHome] = useState('')
  const [cwd, setCwd] = useState(presetCwd ?? lastCwd)
  const [model, setModel] = useState(lastModel)
  const [mode, setMode] = useState<PermissionMode>(lastMode)

  useEffect(() => {
    void window.desktop.homeDir().then((h) => {
      setHome(h)
      if (!cwd) setCwd(h)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recentDirs = useMemo(() => {
    const seen = new Map<string, number>()
    for (const s of sessions) if (s.cwd && s.cwd !== generalDir) seen.set(s.cwd, Math.max(seen.get(s.cwd) ?? 0, s.lastModified))
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d)
  }, [sessions, generalDir])

  const pick = async (): Promise<void> => {
    const d = await window.desktop.pickFolder(cwd || home)
    if (d) setCwd(d)
  }

  const start = (): void => {
    if (!cwd.trim()) return
    void newChat({ cwd: cwd.trim(), model, permissionMode: mode })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="modal-head">
          <h3>New chat</h3>
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>

        <label className="field">
          <span>Project folder</span>
          <div className="field-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" spellCheck={false} />
            <button className="btn" onClick={() => void pick()}>
              <FolderOpen size={14} /> Browse
            </button>
          </div>
        </label>
        {recentDirs.length > 0 && (
          <div className="chips">
            {recentDirs.map((d) => (
              <button key={d} className={`chip clickable ${d === cwd ? 'on' : ''}`} title={d} onClick={() => setCwd(d)}>
                {projectName(projectNames, d)} <span className="muted">{shortPath(d, home)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="field-grid">
          <div className="field">
            <span>Model</span>
            <Dropdown className="dd-field" value={model} options={MODELS} onChange={setModel} />
          </div>
          <div className="field">
            <span>Permissions</span>
            <Dropdown
              className="dd-field"
              value={mode}
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.hint }))}
              onChange={(v) => setMode(v as PermissionMode)}
            />
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={!cwd.trim()}>
            Start chat
          </button>
        </div>
      </div>
    </div>
  )
}
