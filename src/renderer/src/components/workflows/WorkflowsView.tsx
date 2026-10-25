import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Code, Copy, FileCode, Play, Plus, Save, Trash2, Workflow, X } from 'lucide-react'
import { emptyWorkflow, generateWorkflow, validateWorkflow } from '../../../../shared/workflow'
import type { WfGraph, WorkflowAgent, WorkflowFile, WorkflowScope } from '../../../../shared/workflow'
import type { ModelChoice } from '../../../../shared/types'
import { useStore } from '../../store'
import type { WorkflowDraft } from '../../store'
import { highlightLines } from '../../highlight'
import { copyText, modelLabel } from '../../util'
import Dropdown from '../Dropdown'
import WorkflowCanvas, { AGENT_MIME } from './WorkflowCanvas'
import WorkflowInspector from './WorkflowInspector'
import RunWorkflowDialog from './RunWorkflowDialog'
import { deleteStep, findStep, uniqueName } from './graphEdit'

type Doc = Omit<WorkflowDraft, 'selected'>

const keyOf = (scope: WorkflowScope, graph: WfGraph | null): string => (graph ? `${scope}\n${JSON.stringify(graph)}` : '')

interface ConfirmSpec {
  title: string
  text: ReactNode
  confirm: string
  danger?: boolean
  onConfirm: () => void
}

function Confirm({ spec, onCancel }: { spec: ConfirmSpec; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal rename-modal" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <div className="modal-head">
          <h3>{spec.title}</h3>
        </div>
        <p className="modal-text">{spec.text}</p>
        <div className="modal-actions">
          <button className="btn" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${spec.danger ? 'danger' : 'primary'}`} onClick={spec.onConfirm}>
            {spec.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}

function CodeView({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const nodes = useMemo(() => highlightLines(lines, 'javascript'), [lines])
  const [open, setOpen] = useState(false)
  // The trailing designer-data comment is folded into one line by default.
  const foldAt = lines.findIndex((l) => l.startsWith('/* ccd-workflow-graph'))
  const foldCount = foldAt < 0 ? 0 : lines.slice(foldAt).filter((l, i, a) => i < a.length - 1 || l !== '').length
  const shown = foldAt >= 0 && !open ? foldAt : lines.length
  return (
    <div className="wf-code-wrap">
      <button className="btn small-btn wf-copy" onClick={() => void copyText(text)}>
        <Copy size={12} /> Copy
      </button>
      <pre className="wf-code">
        <code>
          {lines.slice(0, shown).map((l, i) => (
            <div
              key={i}
              className={`wf-code-line${i === foldAt ? ' wf-fold' : ''}`}
              title={i === foldAt ? 'Collapse' : undefined}
              onClick={i === foldAt ? () => setOpen(false) : undefined}
            >
              {nodes ? nodes[i] : l}
              {'\n'}
            </div>
          ))}
          {foldAt >= 0 && !open && (
            <div className="wf-code-line wf-fold" title="Expand" onClick={() => setOpen(true)}>
              {`/* designer data · ${foldCount} lines */`}
            </div>
          )}
        </code>
      </pre>
    </div>
  )
}

export default function WorkflowsView({ root }: { root: string }) {
  const closeWorkflows = useStore((s) => s.closeWorkflows)
  const projectNames = useStore((s) => s.projectNames)
  const [files, setFiles] = useState<WorkflowFile[] | null>(null)
  const [agents, setAgents] = useState<WorkflowAgent[] | null>(null)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [initial] = useState(() => useStore.getState().workflowDrafts[root])
  const [doc, setDoc] = useState<Doc | null>(() => (initial ? { file: initial.file, scope: initial.scope, graph: initial.graph, read: initial.read, savedKey: initial.savedKey } : null))
  const [selected, setSelected] = useState<string | null>(initial?.selected ?? null)
  const [showCode, setShowCode] = useState(false)
  const [more, setMore] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshList = useCallback(async (): Promise<WorkflowFile[]> => {
    const list = await window.desktop.workflowList(root).catch(() => [] as WorkflowFile[])
    setFiles(list)
    return list
  }, [root])

  useEffect(() => {
    let alive = true
    void refreshList()
    window.desktop
      .workflowAgents(root)
      .then((a) => alive && setAgents(a))
      .catch(() => alive && setAgents([]))
    window.desktop
      .listAllModels()
      .then((m) => alive && setModels(m))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root, refreshList])

  const graph = doc?.graph ?? null
  const dirty = !!doc && !!doc.graph && keyOf(doc.scope, doc.graph) !== doc.savedKey
  const issues = useMemo(() => (graph && doc ? validateWorkflow(graph, agents ?? undefined, doc.scope) : []), [graph, agents, doc?.scope])
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors
  const readOnly = !!doc && !doc.graph

  const setGraph = useCallback((g: WfGraph): void => setDoc((d) => (d ? { ...d, graph: g } : d)), [])

  // Unsaved work survives leaving the view (e.g. opening a chat): keep the dirty draft in the store.
  useEffect(() => {
    useStore.getState().setWorkflowDraft(root, doc && dirty ? { ...doc, selected } : null)
  }, [root, doc, dirty, selected])

  // Selection must exist in the graph.
  useEffect(() => {
    if (selected && (!graph || !findStep(graph, selected))) setSelected(null)
  }, [graph, selected])

  /** Runs `action` now, or after the user agreed to drop unsaved changes. */
  const guard = (action: () => void): void => {
    if (!dirty) return action()
    setConfirm({
      title: 'Discard unsaved changes?',
      text: 'This workflow has changes that were not saved.',
      confirm: 'Discard',
      danger: true,
      onConfirm: () => {
        setConfirm(null)
        useStore.getState().setWorkflowDraft(root, null)
        action()
      },
    })
  }

  const openFile = async (f: WorkflowFile): Promise<void> => {
    setError('')
    try {
      const read = await window.desktop.workflowRead(f.path)
      const g = read.graph ?? null
      setDoc({ file: f, scope: f.scope, graph: g, read, savedKey: keyOf(f.scope, g) })
      setSelected(null)
      setShowCode(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const newWorkflow = (): void => {
    const g = emptyWorkflow(uniqueName('new-workflow', (files ?? []).map((f) => f.name)))
    setDoc({ file: null, scope: 'project', graph: g, savedKey: keyOf('project', g) })
    setSelected(null)
    setShowCode(false)
    setError('')
  }

  const save = async (force = false): Promise<void> => {
    if (!doc || !doc.graph || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await window.desktop.workflowSave({ root, scope: doc.scope, graph: doc.graph, previousPath: doc.file?.path, force })
      if (res.ok) {
        const list = await refreshList()
        const file =
          list.find((f) => f.path === res.path) ??
          ({ name: doc.graph.name, scope: doc.scope, path: res.path, description: doc.graph.description, mtime: Date.now(), kind: 'designer' } as WorkflowFile)
        const saved = doc
        setDoc((d) => (d ? { ...d, file, read: undefined, savedKey: keyOf(saved.scope, saved.graph) } : d))
      } else if ('conflict' in res) {
        const name = doc.graph.name
        const text: Record<string, string> = {
          edited: `The file for "${name}" was changed by hand after the designer wrote it. Overwrite it with the workflow from the designer?`,
          script: `A hand-written script named "${name}" already exists. Overwrite it?`,
          exists: `Another workflow named "${name}" already exists. Overwrite it?`,
        }
        setConfirm({
          title: 'Overwrite existing file?',
          text: text[res.conflict],
          confirm: 'Overwrite',
          danger: true,
          onConfirm: () => {
            setConfirm(null)
            void save(true)
          },
        })
      } else setError(res.error)
    } finally {
      setBusy(false)
    }
  }

  const askDelete = (): void => {
    const file = doc?.file
    if (!file) return
    setConfirm({
      title: `Delete ${file.name}?`,
      text: (
        <>
          This removes <span className="mono">{file.path}</span> from disk.
        </>
      ),
      confirm: 'Delete',
      danger: true,
      onConfirm: () => {
        setConfirm(null)
        void window.desktop.workflowDelete(file.path).then((err) => {
          if (err) return setError(err)
          setDoc(null)
          setSelected(null)
          void refreshList()
        })
      },
    })
  }

  // Ctrl+S and Delete/Backspace on the selected card.
  const latest = useRef({ save, selected, graph, setGraph })
  latest.current = { save, selected, graph, setGraph }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('.modal-backdrop, .dd-menu, .context-menu')) return
      const L = latest.current
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void L.save()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && L.selected && L.graph && !e.defaultPrevented) {
        const t = e.target instanceof HTMLElement ? e.target : null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        const loc = findStep(L.graph, L.selected)
        const next = deleteStep(L.graph, L.selected)
        if (next === L.graph) return
        L.setGraph(next)
        setSelected(loc && loc.stageIdx !== undefined ? loc.top.id : null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rootName = projectNames[root] ?? root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const byScope = (s: WorkflowScope): WorkflowFile[] => (files ?? []).filter((f) => f.scope === s)

  const row = (f: WorkflowFile) => (
    <button key={f.path} className={`wf-row${doc?.file?.path === f.path ? ' selected' : ''}`} onClick={() => guard(() => void openFile(f))}>
      <span className="wf-row-top">
        <span className="wf-row-name">{f.name}</span>
        {f.kind !== 'designer' && <span className="wf-chip">{f.kind}</span>}
      </span>
      {f.description && <span className="wf-row-desc">{f.description}</span>}
    </button>
  )

  const section = (title: string, scope: WorkflowScope) => {
    const list = byScope(scope)
    return (
      <div className="wf-section">
        <div className="wf-section-title">{title}</div>
        {list.map(row)}
        {files && list.length === 0 && <div className="wf-none">None</div>}
      </div>
    )
  }

  const agentGroup = (title: string, source: WorkflowAgent['source']) => {
    const list = (agents ?? []).filter((a) => a.source === source)
    if (list.length === 0) return null
    return (
      <div className="wf-section" key={source}>
        <div className="wf-section-title">{title}</div>
        {list.map((a) => (
          <div
            key={`${source}:${a.name}`}
            className="wf-agent"
            draggable
            title={a.description}
            onDragStart={(e) => {
              e.dataTransfer.setData(AGENT_MIME, a.name)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <span className="wf-agent-name">{a.name}</span>
            {a.model && <span className="wf-chip">{modelLabel(a.model)}</span>}
          </div>
        ))}
      </div>
    )
  }

  const codeText = !doc ? '' : doc.graph ? (doc.read?.kind === 'edited' && !dirty ? doc.read.code : generateWorkflow(doc.graph)) : (doc.read?.code ?? '')
  const runName = doc?.file ? doc.file.name : ''
  const upd = (patch: Partial<WfGraph>): void => {
    if (graph) setGraph({ ...graph, ...patch })
  }
  const optional = (key: 'whenToUse' | 'argsHint', v: string): void => {
    if (!graph) return
    const g = { ...graph }
    if (v) g[key] = v
    else delete g[key]
    setGraph(g)
  }

  return (
    <div className="wf-view">
      <aside className="wf-left">
        <div className="wf-left-head">
          <span className="wf-left-title">
            <Workflow size={14} /> Workflows
          </span>
          <span className="muted small wf-left-root" title={root}>
            {rootName}
          </span>
        </div>
        <div className="wf-lists">
          <button className="btn wide" onClick={() => guard(newWorkflow)}>
            <Plus size={14} /> New workflow
          </button>
          {files === null ? <div className="wf-none">Loading…</div> : (
            <>
              {section('Project', 'project')}
              {section('User', 'user')}
            </>
          )}
        </div>
        <div className="wf-palette">
          <div className="wf-palette-title">Agents</div>
          {agents === null ? (
            <div className="wf-none">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="wf-none">No agents found</div>
          ) : (
            <>
              {agentGroup('Project', 'project')}
              {agentGroup('User', 'user')}
              {agentGroup('Built-in & plugins', 'other')}
              <div className="wf-none">Drag an agent onto a phase</div>
            </>
          )}
        </div>
      </aside>

      <section className="wf-center">
        {!doc ? (
          <div className="wf-blank">
            <FileCode size={28} />
            <div>Select a workflow or create a new one.</div>
            <button className="btn small-btn" onClick={() => guard(closeWorkflows)}>
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="wf-header">
              <div className="wf-header-row">
                <input
                  className={`wf-name mono${graph && issues.some((i) => !i.stepId && !i.phaseId && i.message.startsWith('Name')) ? ' invalid' : ''}`}
                  value={graph ? graph.name : (doc.read?.meta.name ?? '')}
                  disabled={readOnly}
                  placeholder="workflow-name"
                  spellCheck={false}
                  onChange={(e) => upd({ name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                />
                {dirty && <span className="wf-dirty" title="Unsaved changes">•</span>}
                <input
                  className="wf-desc"
                  value={graph ? graph.description : (doc.read?.meta.description ?? '')}
                  disabled={readOnly}
                  placeholder="Description"
                  onChange={(e) => upd({ description: e.target.value })}
                />
                <Dropdown
                  className="wf-scope-dd"
                  value={doc.scope}
                  title={doc.scope === 'project' ? `${root}/.claude/workflows` : '~/.claude/workflows'}
                  options={[
                    { value: 'project', label: 'Project', description: '.claude/workflows in this project' },
                    { value: 'user', label: 'User', description: '~/.claude/workflows, all projects' },
                  ]}
                  onChange={(v) => !readOnly && setDoc({ ...doc, scope: v as WorkflowScope })}
                />
              </div>
              <div className="wf-header-row">
                <button className="btn plain small-btn" onClick={() => setMore(!more)}>
                  {more ? <ChevronDown size={12} /> : <ChevronRight size={12} />} More
                </button>
                <span className="wf-spacer" />
                <button className="btn primary" disabled={readOnly || errors > 0 || busy || (!dirty && !!doc.file)} title={errors > 0 ? 'Fix the errors first' : 'Save (Ctrl+S)'} onClick={() => void save()}>
                  <Save size={13} /> Save
                </button>
                <button className={`btn${showCode ? ' on' : ''}`} onClick={() => setShowCode(!showCode)}>
                  <Code size={13} /> Code
                </button>
                <button className="btn" disabled={!doc.file || dirty} title={!doc.file || dirty ? 'Save first' : 'Run in a new chat'} onClick={() => setRunning(true)}>
                  <Play size={13} /> Run…
                </button>
                {doc.file && (
                  <button className="btn danger-outline" onClick={askDelete}>
                    <Trash2 size={13} /> Delete…
                  </button>
                )}
                <button className="icon-btn" title="Close workflows" onClick={() => guard(closeWorkflows)}>
                  <X size={15} />
                </button>
              </div>
              {more && graph && (
                <div className="wf-header-row wf-more">
                  <label className="wf-more-field">
                    <span>When to use</span>
                    <input value={graph.whenToUse ?? ''} placeholder="When should Claude pick this workflow?" onChange={(e) => optional('whenToUse', e.target.value)} />
                  </label>
                  <label className="wf-more-field">
                    <span>Args hint</span>
                    <input value={graph.argsHint ?? ''} placeholder="e.g. a path, or JSON {topic, depth}" onChange={(e) => optional('argsHint', e.target.value)} />
                  </label>
                </div>
              )}
            </div>
            {error && (
              <div className="wf-banner error">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            {readOnly && <div className="wf-banner">This script was not made in the designer, so it is read-only here.</div>}
            {doc.read?.kind === 'edited' && !dirty && (
              <div className="wf-banner">This file was edited by hand after the designer wrote it. Saving replaces those edits.</div>
            )}
            <div className="wf-body">
              <div className="wf-main">
                {showCode ? (
                  <CodeView text={codeText} />
                ) : (
                  <WorkflowCanvas
                    graph={graph}
                    metaPhases={doc.read?.meta.phases}
                    issues={issues}
                    selected={selected}
                    onSelect={setSelected}
                    onChange={setGraph}
                  />
                )}
                {graph && (
                  <div className="wf-footer">
                    <button className="wf-footer-bar" onClick={() => issues.length > 0 && setIssuesOpen(!issuesOpen)}>
                      {issues.length === 0 ? (
                        <span className="muted">No issues</span>
                      ) : (
                        <>
                          {errors > 0 && (
                            <span>
                              <span className="wf-dot error" /> {errors} error{errors === 1 ? '' : 's'}
                            </span>
                          )}
                          {warnings > 0 && (
                            <span>
                              <span className="wf-dot warning" /> {warnings} warning{warnings === 1 ? '' : 's'}
                            </span>
                          )}
                          {issuesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </>
                      )}
                    </button>
                    {issuesOpen && issues.length > 0 && (
                      <div className="wf-issue-list">
                        {issues.map((i, k) => (
                          <button
                            key={k}
                            className={`wf-issue ${i.level}`}
                            disabled={!i.stepId || !findStep(graph, i.stepId)}
                            onClick={() => {
                              if (i.stepId && findStep(graph, i.stepId)) {
                                setSelected(i.stepId)
                                setShowCode(false)
                              }
                            }}
                          >
                            <span className={`wf-dot ${i.level}`} /> {i.message}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {graph && selected && !showCode && (
                <WorkflowInspector graph={graph} selected={selected} issues={issues} agents={agents} models={models} onChange={setGraph} onSelect={setSelected} />
              )}
            </div>
          </>
        )}
      </section>

      {confirm && <Confirm spec={confirm} onCancel={() => setConfirm(null)} />}
      {running && doc && (
        <RunWorkflowDialog root={root} name={runName} argsHint={graph?.argsHint} onClose={() => setRunning(false)} />
      )}
    </div>
  )
}
