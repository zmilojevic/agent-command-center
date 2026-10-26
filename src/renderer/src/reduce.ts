// Turns raw Agent SDK messages (live stream or stored transcript) into the
// chat model the UI renders. All functions mutate an immer draft.

import type { TranscriptMessage } from '@shared/types'

export interface TextBlock {
  kind: 'text'
  text: string
}
export interface ThinkingBlock {
  kind: 'thinking'
  text: string
}
export interface ToolBlock {
  kind: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  partialJson?: string
  status: 'running' | 'done' | 'error' | 'denied'
  result?: { text: string; isError: boolean }
}
export interface ImageBlock {
  kind: 'image'
  mediaType: string
  /** base64 payload, without the data: prefix */
  data: string
}
export type Block = TextBlock | ThinkingBlock | ToolBlock | ImageBlock

export interface Subagent {
  /** tool_use id of the Agent/Task call in the main thread */
  toolUseId: string
  taskId?: string
  description: string
  type?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  lastTool?: string
  /** What it is doing now (task_progress description or summary). */
  activity?: string
  toolCalls: number
  tokens?: number
  /** Final report of a background subagent (task_notification summary). */
  summary?: string
  /** Tool call ids already counted from the subagent's own frames. */
  seen?: string[]
  /** No longer listed in the sidebar: the main turn that ran it is over. */
  hidden?: boolean
}

export interface BgTask {
  taskId: string
  /** local_bash, local_workflow, monitor_mcp, monitor_ws, remote_agent, local_command, ... */
  type: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'killed' | 'paused'
  toolUseId?: string
  startedAt: number
  endedAt?: number
  backgrounded: boolean
  ambient: boolean
  summary?: string
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'divider'
  blocks: Block[]
  apiId?: string
  streaming?: boolean
  finalized?: number
  label?: string
  /** Output of a local slash command (e.g. /cost, /context), not a model reply. */
  local?: boolean
  /** The summary the CLI writes after compaction (shown collapsed). */
  compactSummary?: boolean
}

export interface ChatModel {
  messages: ChatMessage[]
  status: 'starting' | 'idle' | 'running' | 'compacting'
  sessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  cwd?: string
  lastResponseAt?: number
  version?: string
  tools?: string[]
  totalCost: number
  lastTurn?: { durationMs: number; cost: number; inputTokens: number; freshInput: number; cacheRead: number; cacheWrite: number; outputTokens: number }
  error?: string
  /** Set when the user interrupted the running turn; its error result is expected. */
  interrupted?: boolean
  /** Subagents started by this chat while it was open (not restored from transcripts). */
  subagents: Subagent[]
  /** Background shells, monitors and workflows (everything except subagents). */
  tasks: BgTask[]
  /** Command names from the init message; a fallback for the slash-command picker. */
  slashCommands?: string[]
}

export function emptyModel(): ChatModel {
  return { messages: [], status: 'starting', totalCost: 0, subagents: [], tasks: [] }
}

function isLive(t: BgTask): boolean {
  return t.status === 'running' || t.status === 'pending' || t.status === 'paused'
}

const AGENT_TOOLS = new Set(['Agent', 'Task'])

function findSubagent(model: ChatModel, ids: { toolUseId?: string | null; taskId?: string | null }): Subagent | undefined {
  return model.subagents.find((a) => (ids.taskId && a.taskId === ids.taskId) || (ids.toolUseId && a.toolUseId === ids.toolUseId))
}

function trackAgentCall(model: ChatModel, b: Block): void {
  if (b.kind !== 'tool_use' || !AGENT_TOOLS.has(b.name)) return
  const i = b.input as any
  let a = findSubagent(model, { toolUseId: b.id })
  if (!a) {
    a = { toolUseId: b.id, description: '', status: 'running', startedAt: Date.now(), toolCalls: 0 }
    model.subagents.push(a)
  }
  if (i?.description) a.description = String(i.description)
  if (i?.subagent_type) a.type = String(i.subagent_type)
}

// ---- helpers --------------------------------------------------------------

const HIDDEN_USER_TEXT = ['<command-name>', '<command-message>', '<local-command-stdout>', '<system-reminder>', '<local-command-caveat>']

function visibleUserText(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  for (const tag of HIDDEN_USER_TEXT) if (t.startsWith(tag)) return null
  // Strip trailing system reminders that get appended to real prompts.
  const idx = t.indexOf('<system-reminder>')
  return idx > 0 ? t.slice(0, idx).trim() : t
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

export function findTool(model: ChatModel, toolUseId: string): ToolBlock | undefined {
  for (let i = model.messages.length - 1; i >= 0; i--) {
    for (const b of model.messages[i].blocks) {
      if (b.kind === 'tool_use' && b.id === toolUseId) return b
    }
  }
  return undefined
}

function attachResult(model: ChatModel, toolUseId: string, content: unknown, isError: boolean): void {
  const tool = findTool(model, toolUseId)
  if (!tool) return
  tool.result = { text: resultText(content), isError }
  // A denial comes back as an error result; keep the more specific status.
  if (tool.status !== 'denied') tool.status = isError ? 'error' : 'done'
  // A foreground subagent without task events ends with its tool result.
  const a = AGENT_TOOLS.has(tool.name) ? findSubagent(model, { toolUseId }) : undefined
  if (a && !a.taskId && a.status === 'running') {
    a.status = isError ? 'failed' : 'done'
    a.endedAt = Date.now()
  }
}

const INTERRUPT_MARKER = '[Request interrupted by user'
const COMPACT_SUMMARY_MARKER = 'This session is being continued from a previous conversation'

/** "<command-name>/x</command-name>…<command-args>y</command-args>" → "/x y" */
function commandEcho(text: string): string | null {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
  if (!name) return null
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

function addUserMessage(model: ChatModel, id: string, content: unknown): void {
  const blocks: Block[] = []
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')) : []
  if (texts.length === 1 && texts[0].trim().startsWith(COMPACT_SUMMARY_MARKER)) {
    model.messages.push({ id, role: 'assistant', blocks: [{ kind: 'text', text: texts[0].trim() }], local: true, compactSummary: true, finalized: 1 })
    return
  }
  if (texts.length === 1 && texts[0].trim().startsWith(INTERRUPT_MARKER)) {
    model.interrupted = true
    model.messages.push({ id, role: 'divider', blocks: [], label: 'Interrupted' })
    return
  }
  const pushText = (raw: string): void => {
    const cmd = raw.trimStart().startsWith('<command-name>') ? commandEcho(raw) : null
    const t = cmd ?? visibleUserText(raw)
    if (t) blocks.push({ kind: 'text', text: t })
  }
  if (typeof content === 'string') {
    pushText(content)
  } else if (Array.isArray(content)) {
    for (const c of content as any[]) {
      if (c?.type === 'text') {
        pushText(c.text ?? '')
      } else if (c?.type === 'tool_result') {
        attachResult(model, c.tool_use_id, c.content, !!c.is_error)
      } else if (c?.type === 'image') {
        const src = c.source ?? {}
        if (src.type === 'base64' && typeof src.data === 'string') blocks.push({ kind: 'image', mediaType: src.media_type ?? 'image/png', data: src.data })
        else blocks.push({ kind: 'text', text: '*[image attached]*' })
      }
    }
  }
  if (blocks.length) model.messages.push({ id, role: 'user', blocks })
}

function blockFromApi(c: any): TextBlock | ThinkingBlock | ToolBlock | null {
  if (c.type === 'text') return { kind: 'text', text: c.text ?? '' }
  if (c.type === 'thinking') return { kind: 'thinking', text: c.thinking ?? '' }
  if (c.type === 'redacted_thinking') return null
  if (c.type === 'tool_use') return { kind: 'tool_use', id: c.id, name: c.name, input: c.input ?? {}, status: 'running' }
  return null
}

function upsertAssistantBlocks(msg: ChatMessage, content: any[]): void {
  for (const c of content) {
    const nb = blockFromApi(c)
    if (!nb) continue
    if (nb.kind === 'tool_use') {
      const existing = msg.blocks.find((b) => b.kind === 'tool_use' && b.id === nb.id) as ToolBlock | undefined
      if (existing) {
        existing.input = nb.input
        existing.partialJson = undefined
        continue
      }
    }
    const pos = msg.finalized ?? 0
    const at = msg.blocks[pos]
    if (at && at.kind === nb.kind) {
      if (nb.kind === 'tool_use') {
        Object.assign(at, { input: nb.input, partialJson: undefined })
      } else if (nb.text || !(at as TextBlock).text) {
        // Final frames can carry empty thinking text (display omitted); keep what streamed.
        ;(at as TextBlock).text = nb.text
      }
    } else {
      msg.blocks.splice(pos, 0, nb)
    }
    msg.finalized = pos + 1
  }
}

// ---- live SDK messages ----------------------------------------------------

export function applySdkMessage(model: ChatModel, m: any): void {
  switch (m.type) {
    case 'system':
      return applySystem(model, m)
    case 'stream_event':
      if (m.parent_tool_use_id) return
      return applyStreamEvent(model, m)
    case 'assistant': {
      if (m.parent_tool_use_id) return applySubagentFrame(model, m)
      const apiId: string | undefined = m.message?.id
      let msg = apiId ? model.messages.find((x) => x.apiId === apiId) : undefined
      if (!msg) {
        msg = { id: m.uuid ?? crypto.randomUUID(), role: 'assistant', blocks: [], apiId, streaming: true, finalized: 0 }
        model.messages.push(msg)
      }
      // Local slash commands (/cost, /context, …) answer with a synthetic assistant frame.
      if (m.message?.model === '<synthetic>' && !m.error) msg.local = true
      upsertAssistantBlocks(msg, m.message?.content ?? [])
      for (const b of msg.blocks) trackAgentCall(model, b)
      if (m.error) {
        model.error = typeof m.error === 'string' ? m.error : JSON.stringify(m.error)
      }
      return
    }
    case 'user': {
      if (m.parent_tool_use_id) return
      const id: string = m.uuid ?? crypto.randomUUID()
      if (model.messages.some((x) => x.id === id)) return
      addUserMessage(model, id, m.message?.content)
      return
    }
    case 'tool_progress': {
      const a = m.parent_tool_use_id ? findSubagent(model, { toolUseId: m.parent_tool_use_id, taskId: m.task_id }) : undefined
      if (a && m.tool_name) a.lastTool = m.tool_name
      return
    }
    case 'result': {
      model.status = 'idle'
      model.lastResponseAt = Date.now()
      for (const msg of model.messages) msg.streaming = false
      // Tools still "running" after the turn ended never produced a result.
      for (const msg of model.messages) for (const b of msg.blocks) if (b.kind === 'tool_use' && b.status === 'running') b.status = 'done'
      // Foreground subagents (no task events) are over when the turn is; background ones report on their
      // own and stay listed while running. Everything finished is dropped from the sidebar now.
      for (const a of model.subagents) {
        if (a.status === 'running' && !a.taskId) {
          a.status = 'done'
          a.endedAt = Date.now()
        }
        if (a.status !== 'running') a.hidden = true
      }
      // total_cost_usd is cumulative for the CLI process, so the turn cost is the delta.
      const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : model.totalCost
      const turnCost = Math.max(0, total - model.totalCost)
      model.totalCost = total
      const freshInput = m.usage?.input_tokens ?? 0
      const cacheRead = m.usage?.cache_read_input_tokens ?? 0
      const cacheWrite = m.usage?.cache_creation_input_tokens ?? 0
      model.lastTurn = {
        durationMs: m.duration_ms ?? 0,
        cost: turnCost,
        inputTokens: freshInput + cacheRead + cacheWrite,
        freshInput,
        cacheRead,
        cacheWrite,
        outputTokens: m.usage?.output_tokens ?? 0,
      }
      if (model.interrupted) {
        // An interrupted turn ends with an error_during_execution result; not a real error.
        model.interrupted = false
        return
      }
      if (m.is_error && Array.isArray(m.errors) && m.errors.length) model.error = m.errors.join('\n')
      else if (m.is_error && m.subtype !== 'success') model.error = m.subtype
      return
    }
    default:
      return
  }
}

/** After a reload: bring back what only live events knew (running tools, subagents, task pills). */
export function restoreLive(model: ChatModel, info: { replay?: unknown[]; inFlight?: { id: string; at: number }[] }): void {
  const flight = new Map((info.inFlight ?? []).map((x) => [x.id, x.at]))
  if (flight.size) {
    for (const msg of model.messages) {
      for (const b of msg.blocks) {
        if (b.kind !== 'tool_use' || !flight.has(b.id)) continue
        b.status = 'running'
        if (AGENT_TOOLS.has(b.name)) {
          trackAgentCall(model, b)
          const a = findSubagent(model, { toolUseId: b.id })
          if (a) a.startedAt = flight.get(b.id)!
        }
      }
    }
  }
  for (const m of info.replay ?? []) applySdkMessage(model, m)
}

/** Plain text of a user entry's content (string, or text blocks / tool_result text). */
function entryText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (typeof c?.text === 'string' ? c.text : typeof c?.content === 'string' ? c.content : Array.isArray(c?.content) ? entryText(c.content) : ''))
    .join('\n')
}

/**
 * Renderer-only fallback for restoreLive: a background subagent whose latest launch (or SendMessage resume) has no
 * task-notification after it is still running. Rebuilt from the parent transcript so a reload against a main process
 * with no (or a truncated) replay keeps the sidebar rows. Call only when the runner is live.
 */
export function restoreBackgroundAgents(model: ChatModel, entries: TranscriptMessage[]): void {
  const calls = new Map<string, { description: string; type?: string; at?: number }>()
  /** toolUseId -> agent id and whether it is currently running. */
  const bg = new Map<string, { taskId: string; running: boolean }>()
  const ts = (e: any): number | undefined => {
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : typeof e.timestamp === 'number' ? e.timestamp : NaN
    return Number.isFinite(t) ? t : undefined
  }
  for (const e of entries as any[]) {
    if (e.parent_tool_use_id || e.parent_agent_id) continue
    const content = e.message?.content
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue
        if (AGENT_TOOLS.has(c.name)) {
          calls.set(c.id, { description: String(c.input?.description ?? ''), type: c.input?.subagent_type ? String(c.input.subagent_type) : undefined, at: ts(e) })
        } else if (c.name === 'SendMessage' && typeof c.input?.to === 'string') {
          for (const x of bg.values()) if (x.taskId === c.input.to) x.running = true
        }
      }
    } else if (e.type === 'user') {
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type !== 'tool_result' || !calls.has(c.tool_use_id)) continue
          const text = entryText(c.content)
          const id = text.startsWith('Async agent launched') ? /agentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] : undefined
          if (id) bg.set(c.tool_use_id, { taskId: id, running: true })
        }
      }
      const text = entryText(content)
      if (!text.includes('<task-notification>')) continue
      for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>|<task-notification>[\s\S]*$/g)) {
        const taskId = /<task-id>([^<]+)<\/task-id>/.exec(m[0])?.[1]?.trim()
        const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[0])?.[1]?.trim()
        for (const [id, x] of bg) if ((taskId && x.taskId === taskId) || (toolUseId && id === toolUseId)) x.running = false
      }
    }
  }
  for (const [toolUseId, x] of bg) {
    if (!x.running) continue
    const call = calls.get(toolUseId)!
    let a = findSubagent(model, { toolUseId, taskId: x.taskId })
    if (!a) {
      a = { toolUseId, description: call.description, status: 'running', startedAt: call.at ?? Date.now(), toolCalls: 0 }
      model.subagents.push(a)
    }
    if (a.status !== 'running') continue
    a.taskId = x.taskId
    a.hidden = false
    if (!a.description) a.description = call.description
    if (!a.type && call.type) a.type = call.type
  }
}

function applySystem(model: ChatModel, m: any): void {
  switch (m.subtype) {
    case 'init':
      model.sessionId = m.session_id
      model.model = m.model
      model.permissionMode = m.permissionMode
      if (m.effort) model.effort = m.effort
      model.cwd = m.cwd
      model.version = m.claude_code_version
      model.tools = m.tools
      if (Array.isArray(m.slash_commands)) model.slashCommands = m.slash_commands
      if (model.status === 'starting') model.status = 'idle'
      return
    case 'local_command_output':
      model.messages.push({ id: m.uuid ?? crypto.randomUUID(), role: 'assistant', blocks: [{ kind: 'text', text: String(m.content ?? '') }], local: true, finalized: 1 })
      return
    case 'task_started': {
      // Only subagents; background shells and monitors are tasks too.
      if (m.task_type && m.task_type !== 'local_agent') {
        let t = model.tasks.find((x) => x.taskId === m.task_id)
        if (!t) {
          t = { taskId: m.task_id, type: m.task_type, description: '', status: 'running', startedAt: m._ccdAt ?? Date.now(), backgrounded: false, ambient: false }
          model.tasks.push(t)
        }
        t.type = m.task_type
        if (m.description) t.description = m.description
        if (m.tool_use_id) t.toolUseId = m.tool_use_id
        t.backgrounded = !!m.is_backgrounded
        t.ambient = !!(m.ambient || m.skip_transcript)
        return
      }
      if (m.skip_transcript || m.ambient) return
      let a = findSubagent(model, { toolUseId: m.tool_use_id, taskId: m.task_id })
      if (!a) {
        a = { toolUseId: m.tool_use_id ?? m.task_id, description: '', status: 'running', startedAt: m._ccdAt ?? Date.now(), toolCalls: 0 }
        model.subagents.push(a)
      }
      if (a.status !== 'running') {
        // Resumed with SendMessage: same task_id, new run. Bring it back to the list.
        a.status = 'running'
        a.hidden = false
        a.endedAt = undefined
        a.activity = undefined
        a.summary = undefined
        a.startedAt = Date.now()
        a.toolCalls = 0
        a.tokens = undefined
      }
      a.taskId = m.task_id
      if (m.description) a.description = m.description
      if (m.subagent_type) a.type = m.subagent_type
      return
    }
    case 'task_progress': {
      const a = findSubagent(model, { toolUseId: m.tool_use_id, taskId: m.task_id })
      if (!a) return
      a.taskId ??= m.task_id
      if (m.last_tool_name) a.lastTool = m.last_tool_name
      if (m.summary || m.description) a.activity = m.summary || m.description
      if (m.usage) {
        a.toolCalls = Math.max(a.toolCalls, m.usage.tool_uses ?? 0)
        a.tokens = m.usage.total_tokens
      }
      return
    }
    case 'task_updated': {
      const t = model.tasks.find((x) => x.taskId === m.task_id)
      if (t) {
        const p = m.patch ?? {}
        if (p.description) t.description = String(p.description)
        if (typeof p.is_backgrounded === 'boolean') t.backgrounded = p.is_backgrounded
        if (p.error) t.error = String(p.error)
        if (p.status) {
          t.status = p.status
          if (!isLive(t)) t.endedAt = typeof p.end_time === 'number' ? p.end_time : (t.endedAt ?? Date.now())
        }
        return
      }
      const a = findSubagent(model, { taskId: m.task_id })
      const st = m.patch?.status
      if (!a || !st) return
      if (st === 'completed' || st === 'failed' || st === 'killed') {
        a.status = st === 'completed' ? 'done' : 'failed'
        a.endedAt = typeof m.patch.end_time === 'number' ? m.patch.end_time : Date.now()
        a.activity = undefined
        if (model.status === 'idle') a.hidden = true
      }
      return
    }
    case 'task_notification': {
      const t = model.tasks.find((x) => x.taskId === m.task_id)
      if (t) {
        // The preceding task_updated usually set killed/failed already; keep the more specific one.
        if (isLive(t) || t.status === 'completed') t.status = m.status === 'completed' ? 'completed' : m.status === 'failed' ? 'failed' : 'stopped'
        t.endedAt ??= Date.now()
        if (m.summary) t.summary = String(m.summary)
        return
      }
      const a = findSubagent(model, { toolUseId: m.tool_use_id, taskId: m.task_id })
      if (!a) return
      a.status = m.status === 'completed' ? 'done' : 'failed'
      a.endedAt ??= Date.now()
      a.activity = undefined
      if (model.status === 'idle') a.hidden = true
      if (m.summary) a.summary = String(m.summary)
      if (m.usage) {
        a.toolCalls = Math.max(a.toolCalls, m.usage.tool_uses ?? 0)
        a.tokens = m.usage.total_tokens
      }
      return
    }
    case 'background_tasks_changed': {
      const live = new Map<string, any>((Array.isArray(m.tasks) ? m.tasks : []).map((x: any) => [x.task_id, x]))
      for (const [id, x] of live) {
        if (x.task_type === 'local_agent' || model.tasks.some((t) => t.taskId === id)) continue
        model.tasks.push({ taskId: id, type: x.task_type, description: x.description ?? '', status: 'running', startedAt: m._ccdAt ?? Date.now(), backgrounded: true, ambient: !!x.ambient })
      }
      for (const t of model.tasks) {
        if (t.backgrounded && isLive(t) && !live.has(t.taskId)) {
          t.status = 'completed'
          t.endedAt ??= Date.now()
        }
      }
      return
    }
    case 'status':
      if (m.status === 'compacting') model.status = 'compacting'
      else if (m.status === 'requesting') model.status = 'running'
      else if (model.status === 'compacting') model.status = 'running'
      if (m.permissionMode) model.permissionMode = m.permissionMode
      return
    case 'compact_boundary':
      model.messages.push({ id: m.uuid ?? crypto.randomUUID(), role: 'divider', blocks: [], label: 'Context compacted' })
      return
    case 'permission_denied': {
      const t = findTool(model, m.tool_use_id)
      if (t) t.status = 'denied'
      return
    }
    default:
      return
  }
}

/** An assistant frame from inside a subagent: count its tool calls. */
function applySubagentFrame(model: ChatModel, m: any): void {
  const a = findSubagent(model, { toolUseId: m.parent_tool_use_id })
  if (!a) return
  for (const c of m.message?.content ?? []) {
    if (c?.type !== 'tool_use') continue
    a.lastTool = c.name
    a.seen ??= []
    if (a.seen.includes(c.id)) continue
    a.seen.push(c.id)
    a.toolCalls = Math.max(a.toolCalls, a.seen.length)
  }
}

function applyStreamEvent(model: ChatModel, m: any): void {
  const e = m.event
  if (!e) return
  model.status = model.status === 'compacting' ? 'compacting' : 'running'
  switch (e.type) {
    case 'message_start': {
      const apiId = e.message?.id
      if (apiId && !model.messages.some((x) => x.apiId === apiId)) {
        model.messages.push({ id: m.uuid ?? crypto.randomUUID(), role: 'assistant', blocks: [], apiId, streaming: true, finalized: 0 })
      }
      return
    }
    case 'content_block_start': {
      const msg = streamTarget(model, m, true)!
      const b = blockFromApi(e.content_block ?? {})
      if (b) {
        if (b.kind === 'tool_use') b.partialJson = ''
        msg.blocks[e.index] = b
      }
      return
    }
    case 'content_block_delta': {
      const msg = streamTarget(model, m, true)!
      const b = msg.blocks[e.index]
      if (!b) return
      const d = e.delta ?? {}
      if (d.type === 'text_delta' && b.kind === 'text') b.text += d.text ?? ''
      else if (d.type === 'thinking_delta' && b.kind === 'thinking') b.text += d.thinking ?? ''
      else if (d.type === 'input_json_delta' && b.kind === 'tool_use') b.partialJson = (b.partialJson ?? '') + (d.partial_json ?? '')
      return
    }
    case 'content_block_stop': {
      // May arrive after an interrupt, when the turn already moved on.
      const msg = streamTarget(model, m, false)
      const b = msg?.blocks[e.index]
      if (b && b.kind === 'tool_use' && b.partialJson) {
        try {
          b.input = JSON.parse(b.partialJson)
        } catch {
          /* keep partial */
        }
      }
      return
    }
    case 'message_stop': {
      const msg = streamTarget(model, m, false)
      if (msg) msg.streaming = false
      return
    }
    default:
      return
  }
}

/** The assistant message a stream event belongs to (matched by API message id when present). */
function streamTarget(model: ChatModel, m: any, create: boolean): ChatMessage | undefined {
  const apiId: string | undefined = m.api_message_id
  if (apiId) {
    for (let i = model.messages.length - 1; i >= 0; i--) if (model.messages[i].apiId === apiId) return model.messages[i]
  }
  const last = model.messages[model.messages.length - 1]
  if (last && last.role === 'assistant' && last.streaming && (!apiId || !last.apiId)) {
    if (apiId) last.apiId = apiId
    return last
  }
  if (!create) return undefined
  const msg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', blocks: [], apiId, streaming: true, finalized: 0 }
  model.messages.push(msg)
  return msg
}


// ---- stored transcript ----------------------------------------------------

export function applyTranscript(model: ChatModel, entries: TranscriptMessage[], opts?: { live?: boolean }): void {
  for (const e of entries) {
    if (e.parent_tool_use_id || e.parent_agent_id) continue
    const msg: any = e.message
    if (!msg) continue
    if (e.type === 'user') {
      if (model.messages.some((x) => x.id === e.uuid)) continue
      addUserMessage(model, e.uuid, msg.content)
    } else if (e.type === 'assistant') {
      const apiId: string | undefined = msg.id
      let target = apiId ? model.messages.find((x) => x.apiId === apiId) : undefined
      const last = model.messages[model.messages.length - 1]
      if (!target && last && last.role === 'assistant' && apiId && last.apiId === apiId) target = last
      if (!target) {
        target = { id: e.uuid, role: 'assistant', blocks: [], apiId, finalized: 0 }
        model.messages.push(target)
      }
      const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []
      for (const c of content) {
        const b = blockFromApi(c)
        if (!b) continue
        if (b.kind === 'thinking' && !b.text) continue
        if (b.kind === 'tool_use' && target.blocks.some((x) => x.kind === 'tool_use' && x.id === b.id)) continue
        target.blocks.push(b)
      }
      target.finalized = target.blocks.length
    }
  }
  if (opts?.live) return
  for (const msg of model.messages) for (const b of msg.blocks) if (b.kind === 'tool_use' && b.status === 'running') b.status = 'done'
}

// ---- summaries for cards --------------------------------------------------

export function toolSummary(b: ToolBlock): string {
  const i = b.input as any
  switch (b.name) {
    case 'Bash':
      return i.description || (typeof i.command === 'string' ? i.command.split('\n')[0] : '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return String(i.file_path ?? i.notebook_path ?? '')
    case 'Glob':
    case 'Grep':
      return String(i.pattern ?? '')
    case 'WebFetch':
      return String(i.url ?? '')
    case 'WebSearch':
      return String(i.query ?? '')
    case 'Agent':
    case 'Task':
      return String(i.description ?? '')
    case 'Skill':
      return String(i.skill ?? '')
    case 'TodoWrite':
      return 'Updated task list'
    case 'AskUserQuestion':
      return Array.isArray(i.questions) ? i.questions.map((q: any) => q.header).join(', ') : ''
    default:
      return b.partialJson ? '…' : ''
  }
}
