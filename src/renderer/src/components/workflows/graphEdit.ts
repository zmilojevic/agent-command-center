import { produce } from 'immer'
import { newStepId } from '../../../../shared/workflow'
import type { WfAgentStep, WfForEachStep, WfGraph, WfPhase, WfStep } from '../../../../shared/workflow'

export interface StepLoc {
  phase: WfPhase
  phaseIdx: number
  /** The top-level step (the for-each itself when `step` is one of its stages). */
  top: WfStep
  topIdx: number
  /** The step or stage with the requested id. */
  step: WfStep
  /** Set when `step` is a stage of the for-each `top`. */
  stageIdx?: number
}

export function findStep(g: WfGraph, id: string): StepLoc | undefined {
  for (let phaseIdx = 0; phaseIdx < g.phases.length; phaseIdx++) {
    const phase = g.phases[phaseIdx]
    for (let topIdx = 0; topIdx < phase.steps.length; topIdx++) {
      const top = phase.steps[topIdx]
      if (top.id === id) return { phase, phaseIdx, top, topIdx, step: top }
      if (top.kind === 'forEach') {
        const stageIdx = top.stages.findIndex((s) => s.id === id)
        if (stageIdx >= 0) return { phase, phaseIdx, top, topIdx, step: top.stages[stageIdx], stageIdx }
      }
    }
  }
  return undefined
}

export function allTopSteps(g: WfGraph): WfStep[] {
  return g.phases.flatMap((p) => p.steps)
}

function uniquePhaseId(g: WfGraph): string {
  const used = new Set(g.phases.map((p) => p.id))
  for (let n = g.phases.length + 1; ; n++) if (!used.has(`p${n}`)) return `p${n}`
}

function uniquePhaseTitle(g: WfGraph): string {
  const used = new Set(g.phases.map((p) => p.title))
  for (let n = g.phases.length + 1; ; n++) if (!used.has(`Phase ${n}`)) return `Phase ${n}`
}

export function addPhase(g: WfGraph): WfGraph {
  return produce(g, (d) => {
    d.phases.push({ id: uniquePhaseId(g), title: uniquePhaseTitle(g), steps: [] })
  })
}

export function updatePhase(g: WfGraph, phaseId: string, patch: { title?: string; detail?: string }): WfGraph {
  return produce(g, (d) => {
    const p = d.phases.find((x) => x.id === phaseId)
    if (!p) return
    if (patch.title !== undefined) p.title = patch.title
    if (patch.detail !== undefined) {
      if (patch.detail) p.detail = patch.detail
      else delete p.detail
    }
  })
}

export function movePhase(g: WfGraph, phaseId: string, dir: -1 | 1): WfGraph {
  return produce(g, (d) => {
    const i = d.phases.findIndex((p) => p.id === phaseId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= d.phases.length) return
    ;[d.phases[i], d.phases[j]] = [d.phases[j], d.phases[i]]
  })
}

export function deletePhase(g: WfGraph, phaseId: string): WfGraph {
  return produce(g, (d) => {
    const i = d.phases.findIndex((p) => p.id === phaseId)
    if (i < 0) return
    const ids = new Set(d.phases[i].steps.map((s) => s.id))
    d.phases.splice(i, 1)
    d.output = d.output.filter((o) => !ids.has(o))
  })
}

function newAgent(g: WfGraph, label: string, agentType?: string): WfAgentStep {
  const step: WfAgentStep = { kind: 'agent', id: newStepId(g, label), label, prompt: '', output: 'text' }
  if (agentType) step.agentType = agentType
  return step
}

export function addAgentStep(g: WfGraph, phaseId: string, opts: { agentType?: string; label?: string; index?: number } = {}): { graph: WfGraph; id: string } {
  const step = newAgent(g, opts.label ?? 'Agent', opts.agentType)
  const graph = produce(g, (d) => {
    const p = d.phases.find((x) => x.id === phaseId)
    if (!p) return
    p.steps.splice(opts.index ?? p.steps.length, 0, step)
  })
  return { graph, id: step.id }
}

export function addForEach(g: WfGraph, phaseId: string): { graph: WfGraph; id: string } {
  const id = newStepId(g, 'for_each')
  const withId = produce(g, (d) => {
    d.phases.find((x) => x.id === phaseId)?.steps.push({ kind: 'forEach', id, label: 'For each', over: 'args', stages: [] })
  })
  const stage = newAgent(withId, 'Stage')
  const graph = produce(withId, (d) => {
    for (const p of d.phases) for (const s of p.steps) if (s.id === id && s.kind === 'forEach') s.stages.push(stage)
  })
  return { graph, id }
}

/** Moves a top-level step to `toIndex` of `toPhaseId` (index in the list before removal). */
export function moveStep(g: WfGraph, stepId: string, toPhaseId: string, toIndex: number): WfGraph {
  return produce(g, (d) => {
    let from: { p: WfPhase; i: number } | undefined
    for (const p of d.phases) {
      const i = p.steps.findIndex((s) => s.id === stepId)
      if (i >= 0) from = { p, i }
    }
    const to = d.phases.find((p) => p.id === toPhaseId)
    if (!from || !to) return
    const [step] = from.p.steps.splice(from.i, 1)
    let idx = toIndex
    if (from.p === to && from.i < idx) idx--
    to.steps.splice(Math.max(0, Math.min(idx, to.steps.length)), 0, step)
  })
}

/** Deletes a top-level step, or a stage (not the last one of its for-each). */
export function deleteStep(g: WfGraph, id: string): WfGraph {
  const loc = findStep(g, id)
  if (!loc) return g
  if (loc.stageIdx !== undefined && (loc.top as WfForEachStep).stages.length <= 1) return g
  return produce(g, (d) => {
    const l = findStep(d, id)!
    if (l.stageIdx !== undefined) {
      ;(l.top as WfForEachStep).stages.splice(l.stageIdx, 1)
    } else {
      d.phases[l.phaseIdx].steps.splice(l.topIdx, 1)
      d.output = d.output.filter((o) => o !== id)
    }
  })
}

const OPTIONAL = new Set(['agentType', 'model', 'effort', 'worktree'])

export function updateAgent(g: WfGraph, id: string, patch: Partial<WfAgentStep>): WfGraph {
  return produce(g, (d) => {
    const l = findStep(d, id)
    if (!l || l.step.kind !== 'agent') return
    const s = l.step as WfAgentStep
    const rec = s as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) {
      if (OPTIONAL.has(k) && (v === undefined || v === '' || v === false)) delete rec[k]
      else rec[k] = v
    }
  })
}

export function updateForEach(g: WfGraph, id: string, patch: Partial<Omit<WfForEachStep, 'kind' | 'id' | 'stages'>>): WfGraph {
  return produce(g, (d) => {
    const l = findStep(d, id)
    if (!l || l.step.kind !== 'forEach') return
    const s = l.step as WfForEachStep
    Object.assign(s, patch)
    if (!s.verify) delete s.verify
  })
}

export function addStage(g: WfGraph, forEachId: string): { graph: WfGraph; id: string } {
  const stage = newAgent(g, 'Stage')
  const graph = produce(g, (d) => {
    const l = findStep(d, forEachId)
    if (l?.step.kind === 'forEach') l.step.stages.push(stage)
  })
  return { graph, id: stage.id }
}

export function moveStage(g: WfGraph, forEachId: string, idx: number, dir: -1 | 1): WfGraph {
  return produce(g, (d) => {
    const l = findStep(d, forEachId)
    if (l?.step.kind !== 'forEach') return
    const st = l.step.stages
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= st.length) return
    ;[st[idx], st[j]] = [st[j], st[idx]]
  })
}

/** Checked state of the Output column: an empty list means every top-level step. */
export function outputChecked(g: WfGraph, id: string): boolean {
  return g.output.length === 0 || g.output.includes(id)
}

export function toggleOutput(g: WfGraph, id: string): WfGraph {
  const all = allTopSteps(g).map((s) => s.id)
  const cur = new Set(g.output.length ? g.output : all)
  if (cur.has(id)) cur.delete(id)
  else cur.add(id)
  if (cur.size === 0) return g
  return produce(g, (d) => {
    d.output = cur.size === all.length ? [] : all.filter((x) => cur.has(x))
  })
}

/** Renames a step id and rewrites `{{old…}}` references, `over` and `output` entries. */
export function renameStepId(g: WfGraph, oldId: string, newId: string): WfGraph {
  if (oldId === newId) return g
  const rewriteRef = (ref: string): string => (ref === oldId ? newId : ref.startsWith(oldId + '.') ? newId + ref.slice(oldId.length) : ref)
  const rewriteText = (text: string): string =>
    text.replace(/\{\{(\s*)([^{}]*?)(\s*)\}\}/g, (_m, a: string, ref: string, b: string) => `{{${a}${rewriteRef(ref)}${b}}}`)
  return produce(g, (d) => {
    const l = findStep(d, oldId)
    if (l) l.step.id = newId
    for (const p of d.phases) {
      for (const s of p.steps) {
        if (s.kind === 'agent') s.prompt = rewriteText(s.prompt)
        else {
          s.over = rewriteRef(s.over.trim())
          for (const st of s.stages) st.prompt = rewriteText(st.prompt)
          if (s.verify) s.verify.prompt = rewriteText(s.verify.prompt)
        }
      }
    }
    d.output = d.output.map((o) => (o === oldId ? newId : o))
  })
}

/** Unique workflow name `base`, `base-2`, … against existing names. */
export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}
