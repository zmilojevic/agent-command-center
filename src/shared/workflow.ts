/**
 * Workflow designer core: graph model, script generator, file parser, validation, reference helpers.
 * Pure TypeScript (no Node or DOM APIs), shared by main and renderer. Spec: docs/workflows.md.
 */

export type WfFieldType = 'string' | 'number' | 'boolean' | 'string[]'
export interface WfField {
  name: string
  type: WfFieldType
  description?: string
}

export interface WfAgentStep {
  kind: 'agent'
  /** Slug [a-z][a-z0-9_]*, unique in the graph; used in {{refs}} and as the result key. */
  id: string
  label: string
  prompt: string
  /** Absent = default workflow subagent. */
  agentType?: string
  /** Absent = inherit (agent definition, else session). */
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  worktree?: boolean
  /** Fields become a JSON schema, every field required. */
  output: 'text' | WfField[]
}

export interface WfForEachStep {
  kind: 'forEach'
  id: string
  label: string
  /** Reference without braces: 'args', 'args.<field>', '<stepId>', '<stepId>.<field>'. */
  over: string
  /** Pipeline stages (>= 1); stage ids are unique graph-wide too. */
  stages: WfAgentStep[]
  /** Adversarial check after the last stage; keeps the items a majority did not refute. */
  verify?: { votes: number; prompt: string }
}

export type WfStep = WfAgentStep | WfForEachStep
export interface WfPhase {
  id: string
  title: string
  detail?: string
  steps: WfStep[]
}

export interface WfGraph {
  version: 1
  /** [a-z0-9][a-z0-9-]*, equals the file name. */
  name: string
  description: string
  whenToUse?: string
  /** Free text shown in the Run dialog. */
  argsHint?: string
  phases: WfPhase[]
  /** Ids of top-level steps returned by the workflow; empty = all top-level steps. */
  output: string[]
  /** Reserved for the UI, ignored by the generator. */
  layout?: Record<string, unknown>
}

export type WorkflowScope = 'project' | 'user'
export type WorkflowKind = 'designer' | 'edited' | 'script'

export interface WorkflowFile {
  name: string
  scope: WorkflowScope
  path: string
  description: string
  mtime: number
  kind: WorkflowKind
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases: { title: string; detail?: string }[]
}

export interface WorkflowReadResult {
  /** The whole file text. */
  code: string
  graph?: WfGraph
  kind: WorkflowKind
  meta: WorkflowMeta
}

export interface WorkflowSaveRequest {
  root: string
  scope: WorkflowScope
  graph: WfGraph
  previousPath?: string
  force?: boolean
}

export type WorkflowSaveResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
  | { ok: false; conflict: 'edited' | 'script' | 'exists' }

export interface WorkflowAgent {
  name: string
  description: string
  model?: string
  source: 'project' | 'user' | 'other'
}

export interface WorkflowIssue {
  level: 'error' | 'warning'
  stepId?: string
  phaseId?: string
  message: string
}

// ---------------------------------------------------------------- helpers

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const ID_RE = /^[a-z][a-z0-9_]*$/
const IDENT_RE = /^[A-Za-z_$][\w$]*$/
const RESERVED_IDS = new Set(['args', 'item', 'prev', 'out'])
const REF_RE = /\{\{\s*([^{}]*?)\s*\}\}/g

/** FNV-1a 32-bit over UTF-16 code units, 8 hex chars. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Single-quoted JS string literal. */
function jsStr(s: string): string {
  return (
    "'" +
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') +
    "'"
  )
}

/** Escapes user text for the inside of a template literal. */
function escTpl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Property key: bare when it is an identifier. */
function jsKey(s: string): string {
  return IDENT_RE.test(s) ? s : jsStr(s)
}

/** The `{{…}}` references of a prompt, trimmed. */
export function referencesOf(prompt: string): string[] {
  return [...prompt.matchAll(REF_RE)].map((m) => m[1].trim())
}

/** JS expression for a reference, or null when it is not syntactically one. */
function refExpr(ref: string): string | null {
  const parts = ref.split('.')
  if (!parts.every((p) => /^[A-Za-z_][\w]*$/.test(p))) return null
  const base = parts[0]
  let expr = base === 'args' || base === 'item' || base === 'prev' ? base : `out.${base}`
  for (const seg of parts.slice(1)) expr += `?.${seg}`
  return expr
}

/** Template literal (with backticks) for a prompt; references become `${fmt(...)}`. */
function tpl(prompt: string): string {
  let res = ''
  let last = 0
  for (const m of prompt.matchAll(REF_RE)) {
    const expr = refExpr(m[1].trim())
    res += escTpl(prompt.slice(last, m.index))
    res += expr ? '${fmt(' + expr + ')}' : escTpl(m[0])
    last = m.index + m[0].length
  }
  res += escTpl(prompt.slice(last))
  return '`' + res + '`'
}

function fieldSchema(f: WfField): string {
  const t = f.type === 'string[]' ? "type: 'array', items: { type: 'string' }" : `type: ${jsStr(f.type)}`
  return `{ ${t}${f.description ? `, description: ${jsStr(f.description)}` : ''} }`
}

function schemaOf(fields: WfField[]): string {
  const props = fields.map((f) => `${jsKey(f.name)}: ${fieldSchema(f)}`).join(', ')
  const req = fields.map((f) => jsStr(f.name)).join(', ')
  return `{ type: 'object', properties: { ${props} }, required: [${req}] }`
}

interface Ctx {
  phase: string
}

/** `agent(...)` call; `label` is a ready JS expression. */
function agentCall(s: WfAgentStep, ctx: Ctx, label: string): string {
  const opts = [`label: ${label}`, `phase: ${jsStr(ctx.phase)}`]
  if (s.agentType) opts.push(`agentType: ${jsStr(s.agentType)}`)
  if (s.model) opts.push(`model: ${jsStr(s.model)}`)
  if (s.effort) opts.push(`effort: ${jsStr(s.effort)}`)
  if (s.worktree) opts.push(`isolation: 'worktree'`)
  if (s.output !== 'text') opts.push(`schema: ${schemaOf(s.output)}`)
  return `agent(${tpl(s.prompt)}, { ${opts.join(', ')} })`
}

/** Source expression of a reference without braces (null when malformed). */
function overExpr(over: string): string {
  return refExpr(over.trim()) ?? 'undefined'
}

function forEachExpr(s: WfForEachStep, ctx: Ctx, ind: string): string {
  const lines: string[] = []
  const single = s.stages.length === 1
  lines.push(`(await pipeline(list(${overExpr(s.over)}),`)
  s.stages.forEach((st) => {
    const base = single ? s.label : st.label
    const label = '`' + escTpl(base) + ' ${i + 1}`'
    const call = agentCall(st, ctx, label)
    lines.push(`${ind}  (prev, item, i) => ${call},`)
  })
  if (s.verify) {
    const n = s.verify.votes
    const body =
      tpl(s.verify.prompt).slice(0, -1) +
      '\\n\\nItem:\\n${fmt(item)}\\n\\nResult to check:\\n${fmt(prev)}\\n\\nTry to refute it. If unsure, set refuted to true.`'
    lines.push(`${ind}  async (prev, item, i) => {`)
    lines.push(`${ind}    const votes = (await parallel(Array.from({ length: ${n} }, (_, v) => () =>`)
    lines.push(`${ind}      agent(${body},`)
    lines.push(`${ind}        { label: \`Verify \${i + 1}.\${v + 1}\`, phase: ${jsStr(ctx.phase)}, schema: VERDICT })))).filter(Boolean)`)
    lines.push(`${ind}    return votes.filter((x) => !x.refuted).length * 2 > ${n} ? prev : null`)
    lines.push(`${ind}  },`)
  }
  lines.push(`${ind})).filter((x) => x != null)`)
  return lines.join('\n')
}

function stepExpr(s: WfStep, ctx: Ctx, ind: string): string {
  return s.kind === 'agent' ? agentCall(s, ctx, jsStr(s.label)) : forEachExpr(s, ctx, ind)
}

function anyVerify(g: WfGraph): boolean {
  return g.phases.some((p) => p.steps.some((s) => s.kind === 'forEach' && s.verify))
}

/** The full file text: script plus the trailing graph comment. */
export function generateWorkflow(graph: WfGraph): string {
  const L: string[] = []
  const metaLines = [`  name: ${jsStr(graph.name)},`, `  description: ${jsStr(graph.description)},`]
  if (graph.whenToUse) metaLines.push(`  whenToUse: ${jsStr(graph.whenToUse)},`)
  const phases = graph.phases
    .map((p) => `{ title: ${jsStr(p.title)}${p.detail ? `, detail: ${jsStr(p.detail)}` : ''} }`)
    .join(', ')
  metaLines.push(`  phases: [${phases}],`)
  L.push('export const meta = {', ...metaLines, '}', '')
  L.push(
    '// Generated by the Agent Command Center workflow designer. Edit it there: the designer detects hand edits',
    '// and asks before overwriting them.',
    "const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))",
    'const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])',
  )
  if (anyVerify(graph)) {
    L.push("const VERDICT = { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted', 'reason'] }")
  }
  L.push('const out = {}', '')
  for (const p of graph.phases) {
    const ctx = { phase: p.title }
    L.push(`phase(${jsStr(p.title)})`)
    if (p.steps.length === 1) {
      L.push(`out.${p.steps[0].id} = ${p.steps[0].kind === 'agent' ? 'await ' : ''}${stepExpr(p.steps[0], ctx, '')}`)
    } else if (p.steps.length > 1) {
      L.push('await parallel([')
      for (const s of p.steps) {
        if (s.kind === 'agent') L.push(`  async () => { out.${s.id} = await ${agentCall(s, ctx, jsStr(s.label))} },`)
        else {
          L.push('  async () => {')
          L.push(`    out.${s.id} = ${forEachExpr(s, ctx, '    ')}`)
          L.push('  },')
        }
      }
      L.push('])')
    }
    L.push('')
  }
  const top = graph.phases.flatMap((p) => p.steps.map((s) => s.id))
  const ids = graph.output.length ? graph.output : top
  L.push(`return { ${ids.map((id) => `${id}: out.${id}`).join(', ')} }`)
  const code = L.join('\n').trim()
  const json = JSON.stringify(graph, null, 2).replace(/\*\//g, '*\\/')
  return `${code}\n\n/* ccd-workflow-graph v1 ${fnv1a(code)}\n${json}\n*/\n`
}

// ---------------------------------------------------------------- parsing

const MARKER = '/* ccd-workflow-graph v1 '

function unquote(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, c: string) => {
    if (c[0] === 'u' || c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16))
    return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
  })
}

function strProp(src: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(['"\`])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1`).exec(src)
  return m ? unquote(m[2]) : undefined
}

/** Index of the bracket matching the one at `start`, skipping strings and comments (-1 when unbalanced). */
function matchBracket(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      if (e < 0) return -1
      i = e + 1
    } else if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function metaFromGraph(g: WfGraph): WorkflowMeta {
  return {
    name: g.name,
    description: g.description,
    ...(g.whenToUse ? { whenToUse: g.whenToUse } : {}),
    phases: g.phases.map((p) => ({ title: p.title, ...(p.detail ? { detail: p.detail } : {}) })),
  }
}

/** Pulls meta out of a hand-written script by regex; nothing is executed. */
function metaFromScript(text: string): WorkflowMeta {
  const meta: WorkflowMeta = { name: '', description: '', phases: [] }
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(text)
  if (!m) return meta
  const open = m.index + m[0].length - 1
  const close = matchBracket(text, open)
  let body = text.slice(open, close < 0 ? undefined : close + 1)
  const pm = /\bphases\s*:\s*\[/.exec(body)
  if (pm) {
    const pOpen = pm.index + pm[0].length - 1
    const pClose = matchBracket(body, pOpen)
    const arr = body.slice(pOpen, pClose < 0 ? undefined : pClose + 1)
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] !== '{') continue
      const e = matchBracket(arr, i)
      if (e < 0) break
      const obj = arr.slice(i, e + 1)
      const title = strProp(obj, 'title')
      if (title !== undefined) {
        const detail = strProp(obj, 'detail')
        meta.phases.push({ title, ...(detail ? { detail } : {}) })
      }
      i = e
    }
    body = body.slice(0, pm.index) + (pClose < 0 ? '' : body.slice(pClose + 1))
  }
  meta.name = strProp(body, 'name') ?? ''
  meta.description = strProp(body, 'description') ?? ''
  const w = strProp(body, 'whenToUse')
  if (w) meta.whenToUse = w
  return meta
}

export function parseWorkflowFile(text: string): { graph?: WfGraph; kind: WorkflowKind; meta: WorkflowMeta } {
  const idx = text.lastIndexOf(MARKER)
  if (idx >= 0) {
    const rest = text.slice(idx + MARKER.length)
    const nl = rest.indexOf('\n')
    const end = rest.lastIndexOf('*/')
    if (nl > 0 && end > nl) {
      const hash = rest.slice(0, nl).trim()
      try {
        const graph = JSON.parse(rest.slice(nl + 1, end).replace(/\*\\\//g, '*/')) as WfGraph
        if (graph && graph.version === 1 && Array.isArray(graph.phases)) {
          const code = text.slice(0, idx).trim()
          return { graph, kind: fnv1a(code) === hash ? 'designer' : 'edited', meta: metaFromGraph(graph) }
        }
      } catch {
        /* fall through to a plain script */
      }
    }
  }
  return { kind: 'script', meta: metaFromScript(text) }
}

// ---------------------------------------------------------------- validation

interface StepLoc {
  step: WfStep
  phaseIdx: number
}

function topSteps(g: WfGraph): Map<string, StepLoc> {
  const m = new Map<string, StepLoc>()
  g.phases.forEach((p, phaseIdx) => p.steps.forEach((step) => m.set(step.id, { step, phaseIdx })))
  return m
}

export function validateWorkflow(graph: WfGraph, agents?: WorkflowAgent[], scope?: WorkflowScope): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const err = (message: string, stepId?: string, phaseId?: string): void => {
    issues.push({ level: 'error', message, ...(stepId ? { stepId } : {}), ...(phaseId ? { phaseId } : {}) })
  }
  const warn = (message: string, stepId?: string, phaseId?: string): void => {
    issues.push({ level: 'warning', message, ...(stepId ? { stepId } : {}), ...(phaseId ? { phaseId } : {}) })
  }
  if (!NAME_RE.test(graph.name)) err('Name must be lowercase letters, digits and dashes, starting with a letter or digit')
  const tops = topSteps(graph)

  const seenPhaseIds = new Set<string>()
  const seenTitles = new Set<string>()
  const seenIds = new Set<string>()
  const checkId = (id: string, phaseId: string): void => {
    if (!ID_RE.test(id)) err(`Bad id "${id}": use lowercase letters, digits and underscores, starting with a letter`, id, phaseId)
    else if (RESERVED_IDS.has(id)) err(`Id "${id}" is reserved`, id, phaseId)
    if (seenIds.has(id)) err(`Duplicate id "${id}"`, id, phaseId)
    seenIds.add(id)
  }

  const checkRef = (ref: string, where: { stepId: string; phaseId: string; phaseIdx: number; inForEach: boolean }): void => {
    const parts = ref.split('.')
    const bad = (why: string): void => err(`Reference {{${ref}}}: ${why}`, where.stepId, where.phaseId)
    if (parts.length > 2 || !parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) return bad('unknown reference')
    const [base, field] = parts
    if (base === 'args') return
    if (base === 'item' || base === 'prev') {
      if (!where.inForEach) return bad(`only available inside a for-each step`)
      return
    }
    const loc = tops.get(base)
    if (!loc) return bad('unknown step')
    if (loc.phaseIdx === where.phaseIdx) return bad('refers to a step of the same phase')
    if (loc.phaseIdx > where.phaseIdx) return bad('refers to a step of a later phase')
    if (field !== undefined) {
      if (loc.step.kind === 'forEach' || loc.step.output === 'text') return bad(`step "${base}" has no fields`)
      if (!loc.step.output.some((f) => f.name === field)) return bad(`step "${base}" has no field "${field}"`)
    }
  }

  const checkPrompt = (prompt: string, what: string, where: { stepId: string; phaseId: string; phaseIdx: number; inForEach: boolean }): void => {
    if (!prompt.trim()) err(`${what} is empty`, where.stepId, where.phaseId)
    for (const ref of referencesOf(prompt)) checkRef(ref, where)
  }

  const checkAgent = (s: WfAgentStep, phase: WfPhase, phaseIdx: number, inForEach: boolean): void => {
    checkId(s.id, phase.id)
    if (!s.label.trim()) err('Label is empty', s.id, phase.id)
    checkPrompt(s.prompt, 'Prompt', { stepId: s.id, phaseId: phase.id, phaseIdx, inForEach })
    if (s.output !== 'text') {
      const names = new Set<string>()
      for (const f of s.output) {
        if (!f.name.trim()) err('Output field with an empty name', s.id, phase.id)
        else if (names.has(f.name)) err(`Duplicate output field "${f.name}"`, s.id, phase.id)
        names.add(f.name)
      }
    }
    if (scope === 'user' && s.agentType && agents?.some((a) => a.name === s.agentType && a.source === 'project')) {
      warn(`Agent "${s.agentType}" is a project agent but this is a user workflow`, s.id, phase.id)
    }
  }

  graph.phases.forEach((p, phaseIdx) => {
    if (seenPhaseIds.has(p.id)) err(`Duplicate phase id "${p.id}"`, undefined, p.id)
    seenPhaseIds.add(p.id)
    if (!p.title.trim()) err('Phase title is empty', undefined, p.id)
    else if (seenTitles.has(p.title)) err(`Duplicate phase title "${p.title}"`, undefined, p.id)
    seenTitles.add(p.title)
    if (!p.steps.length) warn(`Phase "${p.title}" has no steps`, undefined, p.id)
    for (const s of p.steps) {
      if (s.kind === 'agent') {
        checkAgent(s, p, phaseIdx, false)
        continue
      }
      checkId(s.id, p.id)
      if (!s.label.trim()) err('Label is empty', s.id, p.id)
      const over = s.over.trim()
      if (!over) err('"Over" is empty', s.id, p.id)
      else {
        const parts = over.split('.')
        const where = { stepId: s.id, phaseId: p.id, phaseIdx, inForEach: false }
        if (parts[0] === 'item' || parts[0] === 'prev') err(`"Over" cannot be ${over}`, s.id, p.id)
        else checkRef(over, where)
        const src = tops.get(parts[0])
        if (src && src.step.kind === 'agent' && src.step.output === 'text' && src.phaseIdx < phaseIdx && parts.length === 1) {
          warn(`"${over}" has text output: it becomes a one-element list`, s.id, p.id)
        }
      }
      if (!s.stages.length) err('For-each step has no stages', s.id, p.id)
      for (const st of s.stages) checkAgent(st, p, phaseIdx, true)
      if (s.verify) {
        if (!Number.isInteger(s.verify.votes) || s.verify.votes < 1) err('Verify needs at least 1 vote', s.id, p.id)
        checkPrompt(s.verify.prompt, 'Verify prompt', { stepId: s.id, phaseId: p.id, phaseIdx, inForEach: true })
      }
    }
  })

  for (const id of graph.output) if (!tops.has(id)) err(`Output refers to unknown step "${id}"`, id)
  return issues
}

// ---------------------------------------------------------------- UI helpers

/** References a step's prompt can use: args, steps of earlier phases (and their fields), item/prev inside a for-each stage. */
export function availableRefs(graph: WfGraph, stepId: string): { ref: string; label: string }[] {
  const res: { ref: string; label: string }[] = [{ ref: 'args', label: 'args (run input)' }]
  let phaseIdx = -1
  let forEach: WfForEachStep | undefined
  let stageIdx = -1
  graph.phases.forEach((p, pi) =>
    p.steps.forEach((s) => {
      if (s.id === stepId) phaseIdx = pi
      if (s.kind === 'forEach') {
        const k = s.stages.findIndex((st) => st.id === stepId)
        if (k >= 0) {
          phaseIdx = pi
          forEach = s
          stageIdx = k
        }
      }
    }),
  )
  if (phaseIdx < 0) return res
  const tops = topSteps(graph)
  const fieldRefs = (base: string, label: string, output: WfAgentStep['output']): void => {
    if (output !== 'text') for (const f of output) res.push({ ref: `${base}.${f.name}`, label: `${label} › ${f.name}` })
  }
  if (forEach) {
    res.push({ ref: 'item', label: 'item (current element)' })
    const over = forEach.over.trim().split('.')
    const src = over.length === 1 ? tops.get(over[0])?.step : undefined
    if (src?.kind === 'forEach') {
      const last = src.stages[src.stages.length - 1]
      if (last) fieldRefs('item', 'item', last.output)
    }
    res.push({ ref: 'prev', label: stageIdx === 0 ? 'prev (the item)' : 'prev (previous stage result)' })
    if (stageIdx > 0) fieldRefs('prev', 'prev', forEach.stages[stageIdx - 1].output)
  }
  for (const p of graph.phases.slice(0, phaseIdx)) {
    for (const s of p.steps) {
      res.push({ ref: s.id, label: s.label })
      if (s.kind === 'agent') fieldRefs(s.id, s.label, s.output)
    }
  }
  return res
}

export function emptyWorkflow(name: string): WfGraph {
  return { version: 1, name, description: '', phases: [{ id: 'p1', title: 'Phase 1', steps: [] }], output: [] }
}

/** A step id derived from `base` (slugified) that is unused in the graph. */
export function newStepId(graph: WfGraph, base: string): string {
  const used = new Set<string>(RESERVED_IDS)
  for (const p of graph.phases) {
    for (const s of p.steps) {
      used.add(s.id)
      if (s.kind === 'forEach') for (const st of s.stages) used.add(st.id)
    }
  }
  let slug = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(slug)) slug = `step${slug ? '_' + slug : ''}`
  if (!used.has(slug)) return slug
  for (let n = 2; ; n++) if (!used.has(`${slug}_${n}`)) return `${slug}_${n}`
}
