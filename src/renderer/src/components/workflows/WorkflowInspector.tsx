import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { availableRefs } from '../../../../shared/workflow'
import type { WfAgentStep, WfField, WfFieldType, WfForEachStep, WfGraph, WorkflowAgent, WorkflowIssue } from '../../../../shared/workflow'
import type { ModelChoice } from '../../../../shared/types'
import Dropdown from '../Dropdown'
import type { DropdownOption } from '../Dropdown'
import { latestModels, modelLabel } from '../../util'
import { addStage, deleteStep, findStep, moveStage, renameStepId, updateAgent, updateForEach } from './graphEdit'

const ID_RE = /^[a-z][a-z0-9_]*$/
const RESERVED = new Set(['args', 'item', 'prev', 'out'])
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const FIELD_TYPES: WfFieldType[] = ['string', 'number', 'boolean', 'string[]']
const SOURCE_LABEL = { project: 'project agent', user: 'user agent', other: 'built-in / plugin' } as const

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
    </div>
  )
}

function IdField({ graph, id, onRename }: { graph: WfGraph; id: string; onRename: (next: string) => void }) {
  const [draft, setDraft] = useState(id)
  useEffect(() => setDraft(id), [id])
  let error = ''
  if (draft !== id) {
    if (!ID_RE.test(draft)) error = 'Lowercase letters, digits and underscores, starting with a letter'
    else if (RESERVED.has(draft)) error = `"${draft}" is reserved`
    else if (findStep(graph, draft)) error = `"${draft}" is already used`
  }
  const commit = (): void => {
    if (draft !== id && !error) onRename(draft)
    else setDraft(id)
  }
  return (
    <Field label="Id">
      <input
        className={`mono${error ? ' invalid' : ''}`}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setDraft(id)
        }}
      />
      {error && <span className="wf-field-error">{error}</span>}
    </Field>
  )
}

function PromptField({ value, onChange, refs, rows = 6, placeholder }: { value: string; onChange: (v: string) => void; refs?: { ref: string; label: string }[]; rows?: number; placeholder?: string }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  const insert = (ref: string): void => {
    const el = ta.current
    const text = `{{${ref}}}`
    const a = el?.selectionStart ?? value.length
    const b = el?.selectionEnd ?? value.length
    onChange(value.slice(0, a) + text + value.slice(b))
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(a + text.length, a + text.length)
    })
  }
  return (
    <div className="wf-prompt">
      <textarea ref={ta} className="wf-textarea" rows={rows} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {refs && (
        <Dropdown
          className="wf-ref-dd"
          value=""
          placement="up"
          labelOverride="Insert reference"
          options={refs.map((r) => ({ value: r.ref, label: `{{${r.ref}}}`, description: r.label }))}
          onChange={insert}
        />
      )}
    </div>
  )
}

function FieldsEditor({ fields, onChange }: { fields: WfField[]; onChange: (f: WfField[]) => void }) {
  const set = (i: number, patch: Partial<WfField>): void => {
    onChange(
      fields.map((f, k) => {
        if (k !== i) return f
        const n = { ...f, ...patch }
        if (!n.description) delete n.description
        return n
      }),
    )
  }
  return (
    <div className="wf-fields">
      {fields.map((f, i) => (
        <div className="wf-field-row" key={i}>
          <div className="wf-field-top">
            <input className="mono" value={f.name} placeholder="name" spellCheck={false} onChange={(e) => set(i, { name: e.target.value })} />
            <Dropdown
              className="dd-field wf-type-dd"
              value={f.type}
              options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
              onChange={(v) => set(i, { type: v as WfFieldType })}
            />
            <button className="icon-btn tiny" title="Remove field" onClick={() => onChange(fields.filter((_, k) => k !== i))}>
              <X size={13} />
            </button>
          </div>
          <input value={f.description ?? ''} placeholder="description (optional)" onChange={(e) => set(i, { description: e.target.value })} />
        </div>
      ))}
      <button className="btn plain small-btn" onClick={() => onChange([...fields, { name: '', type: 'string' }])}>
        <Plus size={12} /> Field
      </button>
    </div>
  )
}

function AgentFields({
  graph,
  step,
  agents,
  models,
  onChange,
}: {
  graph: WfGraph
  step: WfAgentStep
  agents: WorkflowAgent[] | null
  models: ModelChoice[]
  onChange: (g: WfGraph) => void
}) {
  const up = (patch: Partial<WfAgentStep>): void => onChange(updateAgent(graph, step.id, patch))
  const refs = useMemo(() => availableRefs(graph, step.id), [graph, step.id])

  const agentOptions: DropdownOption[] = [{ value: '', label: 'Default', description: 'The default workflow subagent' }]
  for (const a of agents ?? []) agentOptions.push({ value: a.name, label: a.name, description: `${SOURCE_LABEL[a.source]}${a.model ? ` · ${a.model}` : ''}` })
  if (step.agentType && !agentOptions.some((o) => o.value === step.agentType)) agentOptions.push({ value: step.agentType, label: step.agentType, description: 'not found' })

  const modelOptions: DropdownOption[] = [{ value: '', label: 'Inherit' }]
  for (const m of latestModels(models)) modelOptions.push({ value: m.value, label: m.displayName })
  if (step.model && !modelOptions.some((o) => o.value === step.model)) modelOptions.push({ value: step.model, label: modelLabel(step.model) })

  const effortOptions: DropdownOption[] = [{ value: '', label: 'Inherit' }, ...EFFORTS.map((e) => ({ value: e as string, label: e }))]
  const fields = step.output === 'text' ? null : step.output

  return (
    <>
      <Field label="Agent">
        <Dropdown className="dd-field" value={step.agentType ?? ''} options={agentOptions} onChange={(v) => up({ agentType: v || undefined })} />
      </Field>
      <div className="field-grid">
        <Field label="Model">
          <Dropdown className="dd-field" value={step.model ?? ''} options={modelOptions} onChange={(v) => up({ model: v || undefined })} />
        </Field>
        <Field label="Effort">
          <Dropdown className="dd-field" value={step.effort ?? ''} options={effortOptions} onChange={(v) => up({ effort: (v || undefined) as WfAgentStep['effort'] })} />
        </Field>
      </div>
      <div className="toggle-row">
        <span className="toggle-text">
          <span>Run in a worktree</span>
          <span className="muted small">Isolated git worktree for this agent</span>
        </span>
        <Switch on={!!step.worktree} onChange={(v) => up({ worktree: v })} />
      </div>
      <Field label="Prompt">
        <PromptField value={step.prompt} onChange={(v) => up({ prompt: v })} refs={refs} placeholder="What should this agent do?" />
      </Field>
      <Field label="Output">
        <div className="wf-seg">
          <button className={step.output === 'text' ? 'on' : ''} onClick={() => step.output !== 'text' && up({ output: 'text' })}>
            Text
          </button>
          <button className={step.output !== 'text' ? 'on' : ''} onClick={() => step.output === 'text' && up({ output: [{ name: 'result', type: 'string' }] })}>
            Fields
          </button>
        </div>
        {fields && <FieldsEditor fields={fields} onChange={(f) => up({ output: f })} />}
      </Field>
    </>
  )
}

interface Props {
  graph: WfGraph
  selected: string
  issues: WorkflowIssue[]
  agents: WorkflowAgent[] | null
  models: ModelChoice[]
  onChange: (g: WfGraph) => void
  onSelect: (id: string | null) => void
}

export default function WorkflowInspector({ graph, selected, issues, agents, models, onChange, onSelect }: Props) {
  const loc = findStep(graph, selected)
  if (!loc) return null
  const step = loc.step
  const mine = issues.filter((i) => i.stepId && (i.stepId === step.id || (step.kind === 'forEach' && step.stages.some((s) => s.id === i.stepId))))
  const isStage = loc.stageIdx !== undefined
  const parent = loc.top as WfForEachStep
  const setLabel = (label: string): void =>
    onChange(step.kind === 'agent' ? updateAgent(graph, step.id, { label }) : updateForEach(graph, step.id, { label }))
  const rename = (next: string): void => {
    onChange(renameStepId(graph, step.id, next))
    onSelect(next)
  }
  const overOptions: DropdownOption[] = [{ value: 'args', label: 'args', description: 'run input' }]
  if (step.kind === 'forEach') {
    for (const r of availableRefs(graph, step.id)) {
      if (r.ref === 'args' || r.ref === 'item' || r.ref === 'prev' || r.ref.startsWith('item.') || r.ref.startsWith('prev.')) continue
      overOptions.push({ value: r.ref, label: r.ref, description: r.label })
    }
    if (!overOptions.some((o) => o.value === step.over)) overOptions.push({ value: step.over, label: step.over, description: 'not available here' })
  }

  return (
    <aside className="wf-inspector" onClick={(e) => e.stopPropagation()}>
      <div className="wf-insp-head">
        <h3>{step.kind === 'forEach' ? 'For each' : isStage ? 'Stage' : 'Agent step'}</h3>
        <button className="icon-btn tiny" title="Close" onClick={() => onSelect(null)}>
          <X size={14} />
        </button>
      </div>
      {mine.length > 0 && (
        <div className="wf-insp-issues">
          {mine.map((i, k) => (
            <div key={k} className={`wf-issue ${i.level}`}>
              <span className={`wf-dot ${i.level}`} /> {i.message}
            </div>
          ))}
        </div>
      )}
      {isStage && (
        <div className="wf-parent">
          Part of{' '}
          <button className="wf-parent-link" onClick={() => onSelect(parent.id)}>
            {parent.label || parent.id}
          </button>
        </div>
      )}
      <Field label="Label">
        <input value={step.label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <IdField graph={graph} id={step.id} onRename={rename} />
      {step.kind === 'agent' ? (
        <AgentFields graph={graph} step={step} agents={agents} models={models} onChange={onChange} />
      ) : (
        <>
          <Field label="Over">
            <Dropdown className="dd-field" value={step.over} options={overOptions} onChange={(v) => onChange(updateForEach(graph, step.id, { over: v }))} />
          </Field>
          <Field label="Stages">
            <div className="wf-stage-list">
              {step.stages.map((st, i) => (
                <div key={st.id} className="wf-stage-item" onClick={() => onSelect(st.id)}>
                  <span className="wf-stage-item-label">{st.label || st.id}</span>
                  <span className="wf-stage-agent">{st.agentType ?? 'default'}</span>
                  <button className="icon-btn tiny" title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); onChange(moveStage(graph, step.id, i, -1)) }}>
                    <ArrowUp size={12} />
                  </button>
                  <button className="icon-btn tiny" title="Move down" disabled={i === step.stages.length - 1} onClick={(e) => { e.stopPropagation(); onChange(moveStage(graph, step.id, i, 1)) }}>
                    <ArrowDown size={12} />
                  </button>
                  <button className="icon-btn tiny" title="Remove stage" disabled={step.stages.length <= 1} onClick={(e) => { e.stopPropagation(); onChange(deleteStep(graph, st.id)) }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                className="btn plain small-btn"
                onClick={() => {
                  const r = addStage(graph, step.id)
                  onChange(r.graph)
                  onSelect(r.id)
                }}
              >
                <Plus size={12} /> Stage
              </button>
            </div>
          </Field>
          <div className="toggle-row">
            <span className="toggle-text">
              <span>Verify</span>
              <span className="muted small">Adversarial check after the last stage; keeps items most voters cannot refute</span>
            </span>
            <Switch
              on={!!step.verify}
              onChange={(v) => onChange(updateForEach(graph, step.id, { verify: v ? { votes: 3, prompt: 'Check whether this result is correct and well supported.' } : undefined }))}
            />
          </div>
          {step.verify && (
            <>
              <Field label="Votes (1–9)">
                <input
                  type="number"
                  min={1}
                  max={9}
                  value={step.verify.votes}
                  onChange={(e) => {
                    const n = Math.max(1, Math.min(9, Math.round(Number(e.target.value) || 1)))
                    onChange(updateForEach(graph, step.id, { verify: { ...step.verify!, votes: n } }))
                  }}
                />
              </Field>
              <Field label="Verify prompt">
                <PromptField value={step.verify.prompt} onChange={(v) => onChange(updateForEach(graph, step.id, { verify: { ...step.verify!, votes: step.verify!.votes, prompt: v } }))} />
              </Field>
            </>
          )}
        </>
      )}
    </aside>
  )
}
