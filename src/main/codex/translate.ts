// Pure translation of Codex app-server items/notifications into the SDK-shaped messages the renderer's reducer
// (reduce.ts: applySdkMessage / applyStreamEvent / applyTranscript) already understands. No electron, no I/O.

import { randomUUID } from 'node:crypto'
import type { FileUpdateChange, Thread, ThreadItem, ThreadTokenUsage, TokenUsageBreakdown, Turn, UserInput } from './protocol'
import type { TranscriptMessage } from '../../shared/types'

type Json = Record<string, unknown>

export interface ToolUse {
  id: string
  name: string
  input: Json
}
export interface ToolResult {
  text: string
  isError: boolean
}

const fileKind = (c: FileUpdateChange): string => c.kind.type

/** The tool_use a thread item is shown as, or null for items that are not tool calls. */
export function itemToolUse(item: ThreadItem): ToolUse | null {
  const it = item as any
  switch (item.type) {
    case 'commandExecution':
      return { id: item.id, name: 'Bash', input: { command: it.command, cwd: it.cwd } }
    case 'fileChange':
      return {
        id: item.id,
        name: 'ApplyPatch',
        input: { changes: (it.changes as FileUpdateChange[]).map((c) => ({ path: c.path, kind: fileKind(c), diff: c.diff, ...(c.kind.type === 'update' && c.kind.move_path ? { move_path: c.kind.move_path } : {}) })) },
      }
    case 'mcpToolCall': {
      const args = it.arguments
      return { id: item.id, name: `mcp__${it.server}__${it.tool}`, input: args && typeof args === 'object' && !Array.isArray(args) ? (args as Json) : { value: args } }
    }
    case 'webSearch': {
      const a = it.action ?? {}
      const query = it.query || a.query || (Array.isArray(a.queries) ? a.queries.join(', ') : '') || a.url || ''
      return { id: item.id, name: 'WebSearch', input: { query } }
    }
    default:
      return null
  }
}

/** The tool_result of a finished tool item; null while it is still running. */
export function itemToolResult(item: ThreadItem): ToolResult | null {
  const it = item as any
  switch (item.type) {
    case 'commandExecution': {
      if (it.status === 'inProgress') return null
      if (it.status === 'declined') return { text: 'The command was declined.', isError: true }
      const code = typeof it.exitCode === 'number' ? it.exitCode : 0
      const out = String(it.aggregatedOutput ?? '')
      return { text: code !== 0 ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}[exit code ${code}]` : out, isError: it.status === 'failed' || code !== 0 }
    }
    case 'fileChange': {
      if (it.status === 'inProgress') return null
      const files = (it.changes as FileUpdateChange[]).map((c) => c.path).join(', ')
      if (it.status === 'declined') return { text: 'The patch was declined.', isError: true }
      if (it.status === 'failed') return { text: `Patch failed: ${files}`, isError: true }
      return { text: `Applied patch: ${files}`, isError: false }
    }
    case 'mcpToolCall': {
      if (it.status === 'inProgress') return null
      if (it.error?.message) return { text: String(it.error.message), isError: true }
      const parts: unknown[] = it.result?.content ?? []
      const text = parts.map((p: any) => (p && typeof p.text === 'string' ? p.text : JSON.stringify(p))).join('\n')
      return { text: text || (it.result?.structuredContent ? JSON.stringify(it.result.structuredContent) : ''), isError: it.status === 'failed' }
    }
    case 'webSearch':
      return { text: `Searched: ${(itemToolUse(item)?.input.query as string) || 'the web'}`, isError: false }
    default:
      return null
  }
}

export function assistantMessage(sessionId: string, msgId: string, content: unknown[], model = 'codex'): Json {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { id: msgId, role: 'assistant', model, content },
  }
}

export function toolUseMessage(sessionId: string, t: ToolUse): Json {
  return assistantMessage(sessionId, t.id, [{ type: 'tool_use', id: t.id, name: t.name, input: t.input }])
}

export function toolResultMessage(sessionId: string, toolUseId: string, r: ToolResult): Json {
  return {
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: r.text, is_error: r.isError }] },
  }
}

export function streamEvent(sessionId: string, msgId: string, event: Json): Json {
  return { type: 'stream_event', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, api_message_id: msgId, event }
}

export const messageStart = (sid: string, msgId: string): Json => streamEvent(sid, msgId, { type: 'message_start', message: { id: msgId, role: 'assistant' } })
export const blockStart = (sid: string, msgId: string, kind: 'text' | 'thinking'): Json =>
  streamEvent(sid, msgId, { type: 'content_block_start', index: 0, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } })
export const blockDelta = (sid: string, msgId: string, kind: 'text' | 'thinking', delta: string): Json =>
  streamEvent(sid, msgId, { type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text: delta } : { type: 'thinking_delta', thinking: delta } })
export const blockStop = (sid: string, msgId: string): Json => streamEvent(sid, msgId, { type: 'content_block_stop', index: 0 })
export const messageStop = (sid: string, msgId: string): Json => streamEvent(sid, msgId, { type: 'message_stop' })

export const initMessage = (sessionId: string, model: string | undefined, cwd: string, effort?: string | null): Json => ({
  type: 'system',
  subtype: 'init',
  uuid: randomUUID(),
  session_id: sessionId,
  model: model ?? 'codex',
  cwd,
  tools: [],
  slash_commands: [],
  ...(effort ? { effort } : {}),
})

/** `update_plan` steps as a TodoWrite call (same id every time, so the card updates in place). */
export function planToolUse(turnId: string, plan: { step: string; status: string }[]): ToolUse {
  return {
    id: `plan-${turnId}`,
    name: 'TodoWrite',
    input: { todos: plan.map((p) => ({ content: p.step, activeForm: p.step, status: p.status === 'inProgress' ? 'in_progress' : p.status })) },
  }
}

/** Claude-style usage split: fresh input / cache read / cache write / output. */
export function sdkUsage(b: TokenUsageBreakdown | undefined): Json {
  if (!b) return { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  return {
    input_tokens: Math.max(0, b.inputTokens - b.cachedInputTokens - b.cacheWriteInputTokens),
    cache_read_input_tokens: b.cachedInputTokens,
    cache_creation_input_tokens: b.cacheWriteInputTokens,
    output_tokens: b.outputTokens,
  }
}

export function resultMessage(sessionId: string, turn: Turn, usage: ThreadTokenUsage | undefined): Json {
  const failed = turn.status === 'failed'
  const interrupted = turn.status === 'interrupted'
  return {
    type: 'result',
    subtype: failed || interrupted ? 'error_during_execution' : 'success',
    is_error: failed || interrupted,
    ...(failed ? { errors: [turn.error?.message ?? 'The turn failed'] } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
    duration_ms: turn.durationMs ?? 0,
    total_cost_usd: 0,
    usage: sdkUsage(usage?.last),
  }
}

/** Context meter numbers from the last token-usage report; null when the window is unknown. */
export function contextFromUsage(chatId: string, model: string, u: ThreadTokenUsage | undefined): Json | null {
  if (!u || !u.modelContextWindow) return null
  const used = u.last.totalTokens
  return {
    chatId,
    model,
    totalTokens: used,
    maxTokens: u.modelContextWindow,
    percentage: Math.min(100, (used / u.modelContextWindow) * 100),
    categories: [{ name: 'Messages', tokens: used, kind: 'used' }],
  }
}

/** User input as the plain text the renderer shows (images become a generic placeholder block). */
function userContent(input: UserInput[]): unknown[] {
  return input.map((i) => (i.type === 'text' ? { type: 'text', text: i.text } : { type: 'image', source: { type: 'url', url: '' } }))
}

/** A stored thread (thread/read with turns) as renderer-ready transcript lines. */
export function threadToTranscript(thread: Thread): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  const sid = thread.id
  const line = (type: 'user' | 'assistant', uuid: string, message: unknown): void => {
    out.push({ type, uuid, session_id: sid, message, parent_tool_use_id: null, parent_agent_id: null })
  }
  const assistant = (id: string, content: unknown[]): void => line('assistant', `a-${id}`, { id, role: 'assistant', model: thread.model ?? 'codex', content })
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case 'userMessage': {
          const it = item as Extract<ThreadItem, { type: 'userMessage' }>
          line('user', it.clientId ?? it.id, { role: 'user', content: userContent(it.content) })
          break
        }
        case 'agentMessage':
          assistant(item.id, [{ type: 'text', text: (item as any).text ?? '' }])
          break
        case 'reasoning': {
          const text = ((item as any).summary as string[]).join('\n\n')
          if (text) assistant(item.id, [{ type: 'thinking', thinking: text }])
          break
        }
        default: {
          const t = itemToolUse(item)
          if (!t) break
          assistant(t.id, [{ type: 'tool_use', id: t.id, name: t.name, input: t.input }])
          const r = itemToolResult(item)
          if (r) line('user', `r-${t.id}`, { role: 'user', content: [{ type: 'tool_result', tool_use_id: t.id, content: r.text, is_error: r.isError }] })
        }
      }
    }
  }
  return out
}
