import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, GitBranch, MoreHorizontal, Plus, Repeat, ArrowLeft, ArrowRight, Trash2 } from 'lucide-react'
import { referencesOf } from '../../../../shared/workflow'
import type { WfAgentStep, WfGraph, WfPhase, WfStep, WorkflowIssue } from '../../../../shared/workflow'
import { modelLabel } from '../../util'
import {
  addAgentStep,
  addForEach,
  addPhase,
  allTopSteps,
  deletePhase,
  moveStep,
  movePhase,
  outputChecked,
  toggleOutput,
  updatePhase,
} from './graphEdit'

const STEP_MIME = 'application/x-ccd-step'
export const AGENT_MIME = 'application/x-ccd-agent'

function worst(issues: WorkflowIssue[], ids: string[]): 'error' | 'warning' | null {
  let res: 'error' | 'warning' | null = null
  for (const i of issues) {
    if (!i.stepId || !ids.includes(i.stepId)) continue
    if (i.level === 'error') return 'error'
    res = 'warning'
  }
  return res
}

function modelEffort(s: WfAgentStep): string {
  const parts: string[] = []
  if (s.model) parts.push(modelLabel(s.model))
  if (s.effort) parts.push(s.effort)
  return parts.join(' · ')
}

function AgentChips({ s }: { s: WfAgentStep }) {
  const me = modelEffort(s)
  return (
    <div className="wf-chips">
      <span className="wf-chip">{s.agentType ?? 'default'}</span>
      {me && <span className="wf-chip">{me}</span>}
      <span className="wf-chip">{s.output === 'text' ? 'text' : `${s.output.length} field${s.output.length === 1 ? '' : 's'}`}</span>
      {s.worktree && (
        <span className="wf-chip" title="Runs in a git worktree">
          <GitBranch size={10} />
        </span>
      )}
    </div>
  )
}

function Dot({ level }: { level: 'error' | 'warning' | null }) {
  return level ? <span className={`wf-dot ${level}`} title={level === 'error' ? 'Has errors' : 'Has warnings'} /> : null
}

function PhaseMenu({ onLeft, onRight, onDelete, canLeft, canRight }: { onLeft: () => void; onRight: () => void; onDelete: () => void; canLeft: boolean; canRight: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [open])
  const act = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="wf-menu-wrap" ref={ref}>
      <button className="icon-btn tiny" title="Phase menu" onClick={() => setOpen(!open)}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="context-menu wf-menu">
          <button disabled={!canLeft} onClick={act(onLeft)}>
            <ArrowLeft size={14} /> Move left
          </button>
          <button disabled={!canRight} onClick={act(onRight)}>
            <ArrowRight size={14} /> Move right
          </button>
          <div className="sep" />
          <button className="danger" onClick={act(onDelete)}>
            <Trash2 size={14} /> Delete phase
          </button>
        </div>
      )}
    </div>
  )
}

interface Props {
  graph: WfGraph | null
  /** Read-only scripts: phases from `meta`, no steps. */
  metaPhases?: { title: string; detail?: string }[]
  issues: WorkflowIssue[]
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (g: WfGraph) => void
}

interface Link {
  key: string
  from: string
  to: string
  d: string
  hot: boolean
}

export default function WorkflowCanvas({ graph, metaPhases, issues, selected, onSelect, onChange }: Props) {
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const [links, setLinks] = useState<Link[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drop, setDrop] = useState<{ phaseId: string; index: number } | null>(null)

  // top-level card id owning a selection (a stage belongs to its for-each)
  const owner = useMemo(() => {
    const m = new Map<string, string>()
    if (graph) for (const s of allTopSteps(graph)) {
      m.set(s.id, s.id)
      if (s.kind === 'forEach') for (const st of s.stages) m.set(st.id, s.id)
    }
    return m
  }, [graph])
  const selectedCard = selected ? owner.get(selected) : undefined

  const pairs = useMemo(() => {
    const res: { from: string; to: string }[] = []
    if (!graph) return res
    const tops = new Set(allTopSteps(graph).map((s) => s.id))
    for (const s of allTopSteps(graph)) {
      const refs = new Set<string>()
      if (s.kind === 'agent') referencesOf(s.prompt).forEach((r) => refs.add(r))
      else {
        refs.add(s.over.trim())
        for (const st of s.stages) referencesOf(st.prompt).forEach((r) => refs.add(r))
        if (s.verify) referencesOf(s.verify.prompt).forEach((r) => refs.add(r))
      }
      const bases = new Set([...refs].map((r) => r.split('.')[0]))
      for (const b of bases) if (b !== s.id && tops.has(b)) res.push({ from: b, to: s.id })
    }
    return res
  }, [graph])

  const measure = useCallback(() => {
    const inner = innerRef.current
    if (!inner) return
    const base = inner.getBoundingClientRect()
    const out: Link[] = []
    for (const p of pairs) {
      const a = cardRefs.current.get(p.from)
      const b = cardRefs.current.get(p.to)
      if (!a || !b) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const x1 = ra.right - base.left
      const y1 = ra.top + ra.height / 2 - base.top
      const x2 = rb.left - base.left
      const y2 = rb.top + rb.height / 2 - base.top
      const dx = Math.max(36, Math.abs(x2 - x1) / 2)
      out.push({
        key: `${p.from}>${p.to}`,
        from: p.from,
        to: p.to,
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        hot: false,
      })
    }
    setLinks(out)
    setSize({ w: inner.scrollWidth, h: inner.scrollHeight })
  }, [pairs])

  const raf = useRef(0)
  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(measure)
  }, [measure])

  useLayoutEffect(() => {
    schedule()
  }, [graph, schedule])
  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (!inner || !scroller) return
    const ro = new ResizeObserver(schedule)
    ro.observe(inner)
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      ro.disconnect()
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(raf.current)
    }
  }, [schedule])

  const regCard = (id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }

  const change = (g: WfGraph): void => onChange(g)

  // ---- drag and drop
  const accepts = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(STEP_MIME) || e.dataTransfer.types.includes(AGENT_MIME)
  const indexAt = (body: HTMLElement, y: number): number => {
    const cards = [...body.querySelectorAll<HTMLElement>(':scope > .wf-card')]
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) return i
    }
    return cards.length
  }
  const onDragOver = (phase: WfPhase) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(AGENT_MIME) ? 'copy' : 'move'
    const index = indexAt(e.currentTarget, e.clientY)
    setDrop((d) => (d && d.phaseId === phase.id && d.index === index ? d : { phaseId: phase.id, index }))
  }
  const onDrop = (phase: WfPhase) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!graph || !accepts(e)) return
    e.preventDefault()
    const index = indexAt(e.currentTarget, e.clientY)
    setDrop(null)
    const agent = e.dataTransfer.getData(AGENT_MIME)
    const step = e.dataTransfer.getData(STEP_MIME)
    if (agent) {
      const r = addAgentStep(graph, phase.id, { agentType: agent, label: agent, index })
      change(r.graph)
      onSelect(r.id)
    } else if (step) change(moveStep(graph, step, phase.id, index))
  }

  const stepCard = (phase: WfPhase, s: WfStep, i: number) => {
    const ids = s.kind === 'forEach' ? [s.id, ...s.stages.map((x) => x.id)] : [s.id]
    const level = worst(issues, ids)
    const cls = `wf-card${selected === s.id ? ' selected' : ''}${drop && drop.phaseId === phase.id && drop.index === i ? ' drop-before' : ''}`
    return (
      <div
        key={s.id}
        ref={regCard(s.id)}
        className={cls}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(STEP_MIME, s.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDrop(null)}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(s.id)
        }}
      >
        <div className="wf-card-head">
          {s.kind === 'forEach' && <Repeat size={12} className="wf-card-icon" />}
          <span className="wf-card-label">{s.label || s.id}</span>
          <Dot level={level} />
        </div>
        {s.kind === 'agent' ? (
          <AgentChips s={s} />
        ) : (
          <>
            <div className="wf-card-sub">
              for each <span className="mono">{s.over}</span>
            </div>
            <div className="wf-stages">
              {s.stages.map((st) => (
                <div
                  key={st.id}
                  className={`wf-stage${selected === st.id ? ' selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(st.id)
                  }}
                >
                  <span className="wf-stage-label">{st.label || st.id}</span>
                  <span className="wf-stage-agent">{st.agentType ?? 'default'}</span>
                  <Dot level={worst(issues, [st.id])} />
                </div>
              ))}
            </div>
            {s.verify && (
              <div className="wf-chips">
                <span className="wf-chip">verify ×{s.verify.votes}</span>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  if (!graph) {
    return (
      <div className="wf-canvas" ref={scrollRef}>
        <div className="wf-canvas-inner" ref={innerRef}>
          {(metaPhases ?? []).map((p, i) => (
            <div className="wf-col-wrap" key={i}>
              {i > 0 && <ChevronRight size={16} className="wf-arrow" />}
              <div className="wf-col readonly">
                <div className="wf-col-head">
                  <div className="wf-col-title static">{p.title}</div>
                  {p.detail && <div className="wf-col-detail static">{p.detail}</div>}
                </div>
                <div className="wf-col-body empty" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const tops = allTopSteps(graph)
  const hotLinks = links.map((l) => ({ ...l, hot: !!selectedCard && (l.from === selectedCard || l.to === selectedCard) }))
  const sorted = [...hotLinks.filter((l) => !l.hot), ...hotLinks.filter((l) => l.hot)]

  return (
    <div className="wf-canvas" ref={scrollRef} onClick={() => onSelect(null)}>
      <div className="wf-canvas-inner" ref={innerRef}>
        <svg className="wf-links" width={size.w} height={size.h}>
          {sorted.map((l) => (
            <path key={l.key} d={l.d} className={`wf-link${l.hot ? ' hot' : ''}`} />
          ))}
        </svg>
        {graph.phases.map((p, pi) => (
          <div className="wf-col-wrap" key={p.id}>
            {pi > 0 && <ChevronRight size={16} className="wf-arrow" />}
            <div className="wf-col">
              <div className="wf-col-head" onClick={(e) => e.stopPropagation()}>
                <div className="wf-col-row">
                  <input
                    className="wf-col-title"
                    value={p.title}
                    placeholder="Phase title"
                    spellCheck={false}
                    onChange={(e) => change(updatePhase(graph, p.id, { title: e.target.value }))}
                  />
                  <PhaseMenu
                    canLeft={pi > 0}
                    canRight={pi < graph.phases.length - 1}
                    onLeft={() => change(movePhase(graph, p.id, -1))}
                    onRight={() => change(movePhase(graph, p.id, 1))}
                    onDelete={() => {
                      change(deletePhase(graph, p.id))
                      if (selected && p.steps.some((s) => owner.get(selected) === s.id)) onSelect(null)
                    }}
                  />
                </div>
                <input
                  className="wf-col-detail"
                  value={p.detail ?? ''}
                  placeholder="Detail (optional)"
                  spellCheck={false}
                  onChange={(e) => change(updatePhase(graph, p.id, { detail: e.target.value }))}
                />
              </div>
              <div
                className={`wf-col-body${drop && drop.phaseId === p.id && drop.index >= p.steps.length ? ' drop-end' : ''}`}
                onDragOver={onDragOver(p)}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop((d) => (d?.phaseId === p.id ? null : d))
                }}
                onDrop={onDrop(p)}
              >
                {p.steps.map((s, i) => stepCard(p, s, i))}
                {p.steps.length === 0 && <div className="wf-empty">Drop an agent here</div>}
              </div>
              <div className="wf-col-foot">
                <button
                  className="btn plain small-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = addAgentStep(graph, p.id)
                    change(r.graph)
                    onSelect(r.id)
                  }}
                >
                  <Plus size={12} /> Agent
                </button>
                <button
                  className="btn plain small-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = addForEach(graph, p.id)
                    change(r.graph)
                    onSelect(r.id)
                  }}
                >
                  <Plus size={12} /> For each
                </button>
              </div>
            </div>
          </div>
        ))}
        <div className="wf-col-wrap">
          <ChevronRight size={16} className="wf-arrow" />
          <button
            className="wf-col wf-ghost"
            onClick={(e) => {
              e.stopPropagation()
              change(addPhase(graph))
            }}
          >
            <Plus size={14} /> Phase
          </button>
        </div>
        <div className="wf-col-wrap">
          <ChevronRight size={16} className="wf-arrow" />
          <div className="wf-col wf-output" onClick={(e) => e.stopPropagation()}>
            <div className="wf-col-head">
              <div className="wf-col-title static">Output</div>
              <div className="wf-col-detail static">Steps whose results the workflow returns</div>
            </div>
            <div className="wf-col-body">
              {tops.length === 0 && <div className="wf-empty">No steps yet</div>}
              {tops.map((s) => (
                <label key={s.id} className="wf-out-row">
                  <input type="checkbox" checked={outputChecked(graph, s.id)} onChange={() => change(toggleOutput(graph, s.id))} />
                  <span className="wf-out-label">{s.label || s.id}</span>
                  <span className="mono wf-out-id">{s.id}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
