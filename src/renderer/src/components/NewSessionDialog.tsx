import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { useStore, engineFor } from '../store'
import { PERMISSION_MODES, CODEX_MODES, type PermissionMode, type CodexMode, type Engine } from '@shared/types'
import { latestModels, modelLabel, projectName, projectRoot, shortPath } from '../util'
import Dropdown from './Dropdown'

const MODELS = [
  { value: 'default', label: 'Default (from Claude Code settings)' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
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
  const codexOn = useStore((s) => !!s.codexStatus?.installed)
  const lastCodexModel = useStore((s) => s.lastCodexModel)
  const lastCodexMode = useStore((s) => s.lastCodexMode)
  const codexModels = useStore((s) => s.codexModels)
  const close = (): void => useStore.getState().setShowNewDialog(false)

  const [home, setHome] = useState('')
  const [cwd, setCwd] = useState(presetCwd ?? lastCwd)
  const [model, setModel] = useState(lastModel)
  const [mode, setMode] = useState<PermissionMode>(lastMode)
  const [engine, setEngine] = useState<Engine>(() => engineFor(presetCwd ?? lastCwd))
  const [codexModel, setCodexModel] = useState(lastCodexModel)
  const [codexMode, setCodexMode] = useState<CodexMode>(lastCodexMode)
  const codex = engine === 'codex' && codexOn
  useEffect(() => {
    if (codex) void useStore.getState().loadCodexModels()
  }, [codex])

  // Follow the picked folder's project default (else the last used model) whenever the folder changes.
  const projDefaults = useStore((s) => s.projectDefaults[projectRoot(cwd)])
  const defaultModel = projDefaults?.model
  const defaultEngine = projDefaults?.engine === 'codex' ? 'codex' : 'claude'
  useEffect(() => {
    if (defaultEngine === 'codex' && codexOn) setEngine('codex')
    else setEngine('claude')
    setModel(defaultEngine === 'claude' ? (defaultModel ?? lastModel) : lastModel)
    setCodexModel(defaultEngine === 'codex' ? (defaultModel ?? lastCodexModel) : lastCodexModel)
  }, [defaultModel, defaultEngine, lastModel, lastCodexModel, codexOn])
  const codexModelOptions = [
    { value: 'default', label: 'Default (from ~/.codex/config.toml)' },
    ...latestModels(codexModels).map((m) => ({ value: m.value, label: m.displayName, description: m.description })),
    ...(codexModel !== 'default' && !codexModels.some((m) => m.value === codexModel) ? [{ value: codexModel, label: modelLabel(codexModel) }] : []),
  ]
  const modelOptions = MODELS.some((m) => m.value === model) ? MODELS : [...MODELS, { value: model, label: modelLabel(model) }]

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
    if (codex) void newChat({ cwd: cwd.trim(), model: codexModel, permissionMode: mode, engine: 'codex', codexMode })
    else void newChat({ cwd: cwd.trim(), model, permissionMode: mode, engine: 'claude' })
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

        {codexOn && (
          <div className="field">
            <span>Engine</span>
            <div className="engine-seg" role="group" aria-label="Engine">
              <button className={engine === 'claude' ? 'on' : ''} onClick={() => setEngine('claude')}>
                Claude
              </button>
              <button className={engine === 'codex' ? 'on' : ''} onClick={() => setEngine('codex')}>
                Codex
              </button>
            </div>
          </div>
        )}

        <div className="field-grid">
          <div className="field">
            <span>Model</span>
            {codex ? (
              <Dropdown className="dd-field" value={codexModel} options={codexModelOptions} onChange={setCodexModel} />
            ) : (
              <Dropdown className="dd-field" value={model} options={modelOptions} onChange={setModel} />
            )}
          </div>
          <div className="field">
            <span>Permissions</span>
            {codex ? (
              <Dropdown
                className="dd-field"
                value={codexMode}
                options={CODEX_MODES.map((m) => ({ value: m.value, label: m.label, description: m.hint }))}
                onChange={(v) => setCodexMode(v as CodexMode)}
              />
            ) : (
              <Dropdown
                className="dd-field"
                value={mode}
                options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.hint }))}
                onChange={(v) => setMode(v as PermissionMode)}
              />
            )}
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
