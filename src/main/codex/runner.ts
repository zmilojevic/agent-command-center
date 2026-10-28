import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexMode, ContentBlock, LiveChat, AttachResult, ModelChoice, PermissionRequest, PermissionResponse, StartChatOptions, UserContent, AgentChoice, McpServerInfo, SlashCommandInfo } from '../../shared/types'
import type { Runner } from '../runnerTypes'
import type { CodexServer, ThreadSubscriber } from './appServer'
import type { RpcId, ThreadItem, ThreadStartedResponse, ThreadTokenUsage, Turn, UserInput } from './protocol'
import { listCodexModels } from './account'
import { rememberCodexId } from './sessions'
import {
  assistantMessage,
  blockDelta,
  blockStart,
  blockStop,
  contextFromUsage,
  initMessage,
  itemToolResult,
  itemToolUse,
  messageStart,
  messageStop,
  planToolUse,
  resultMessage,
  toolResultMessage,
  toolUseMessage,
} from './translate'

type Emit = (channel: string, payload: unknown) => void

interface PendingApproval {
  rpcId: RpcId
  kind: 'command' | 'file'
  payload: PermissionRequest
}

/** `thread/start` / `thread/resume` / `thread/fork` overrides for a mode. `config` passes nothing (config.toml decides). */
export function modeThreadParams(mode: CodexMode): Record<string, unknown> {
  if (mode === 'read-only') return { approvalPolicy: 'on-request', sandbox: 'read-only' }
  if (mode === 'auto') return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  if (mode === 'full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  return {}
}

/** `turn/start` overrides for a mode (the sandbox is a policy object here). */
export function modeTurnParams(mode: CodexMode): Record<string, unknown> {
  if (mode === 'read-only') return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (mode === 'auto') return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
  if (mode === 'full-access') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
  return {}
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** A chat backed by a Codex thread on the shared `codex app-server` (docs/codex.md). Same surface as ChatRunner. */
export class CodexRunner implements Runner {
  readonly chatId: string
  readonly holders = new Set<string>()
  sessionId: string | undefined
  status: LiveChat['status'] = 'starting'
  lastModel: string | undefined
  lastEffort: string | undefined
  codexMode: CodexMode
  lastActivity = Date.now()
  exited = false
  private closed = false
  private activeTurnId: string | undefined
  private pending = new Map<string, PendingApproval>()
  private inFlight = new Map<string, number>()
  /** Items seen so far this turn (file approvals need the item's changes). */
  private items = new Map<string, ThreadItem>()
  /** Items currently streamed as an open message: item id -> kind. */
  private streaming = new Map<string, { kind: 'text' | 'thinking'; summaryIndex: number; text: string }>()
  private tokenUsage: ThreadTokenUsage | undefined
  private tempFiles: string[] = []
  private sub: ThreadSubscriber | undefined
  private chain: Promise<void> = Promise.resolve()
  private ready!: Promise<void>
  private resolveDone!: () => void
  readonly done = new Promise<void>((res) => {
    this.resolveDone = res
  })

  constructor(
    private opts: StartChatOptions & { ephemeral?: boolean },
    private server: CodexServer,
    private emit: Emit,
    private log: (s: string) => void,
    readonly gen: number,
    private onChange: () => void = () => {},
  ) {
    this.chatId = opts.chatId
    this.codexMode = opts.codexMode ?? 'full-access'
    this.lastModel = opts.model && opts.model !== 'default' ? opts.model : undefined
    this.lastEffort = opts.effort
    if (opts.resume && !opts.fork) this.sessionId = opts.resume
  }

  private setStatus(status: LiveChat['status']): void {
    if (this.status === status) return
    this.status = status
    this.onChange()
  }

  summary(): LiveChat {
    return {
      chatId: this.chatId,
      gen: this.gen,
      sessionId: this.sessionId,
      cwd: this.opts.cwd,
      status: this.status,
      pendingCount: this.pending.size,
      model: this.lastModel,
      // Not meaningful for Codex; the real mode is `codexMode`.
      permissionMode: 'default',
      holders: this.holders.size,
      engine: 'codex',
      codexMode: this.codexMode,
    }
  }

  attachInfo(): AttachResult {
    return { ...this.summary(), pending: this.pendingRequests(), replay: [], inFlight: [...this.inFlight].map(([id, at]) => ({ id, at })) }
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.payload)
  }

  private get sid(): string {
    return this.sessionId ?? this.chatId
  }

  private forward(m: any): void {
    this.lastActivity = Date.now()
    this.emit('agent:event', { chatId: this.chatId, gen: this.gen, message: m })
  }

  start(): void {
    this.ready = this.init()
    this.ready.catch(() => {
      /* reported through chat:exit in init */
    })
  }

  private async init(): Promise<void> {
    try {
      await this.server.ensure()
      const o = this.opts
      const base: Record<string, unknown> = { cwd: o.cwd, ...modeThreadParams(this.codexMode) }
      if (this.lastModel) base.model = this.lastModel
      let res: ThreadStartedResponse
      if (o.resume && !o.fork) res = await this.server.request('thread/resume', { threadId: o.resume, ...base })
      else if (o.resume) res = await this.server.request('thread/fork', { threadId: o.resume, ...base })
      else res = await this.server.request('thread/start', { ...base, ...(o.ephemeral ? { ephemeral: true } : {}) })
      if (this.closed) return
      this.sessionId = res.thread.id
      rememberCodexId(res.thread.id)
      this.lastModel = res.model ?? this.lastModel
      this.sub = {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (id, method, params) => this.onRequest(id, method, params),
        onExit: (why) => this.onServerExit(why),
      }
      this.server.subscribe(res.thread.id, this.sub)
      this.forward(initMessage(res.thread.id, res.model, res.cwd ?? o.cwd, res.reasoningEffort))
      this.setStatus('idle')
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.fail(error)
      throw e
    }
  }

  private fail(error: string): void {
    this.exited = true
    this.cleanupTemp()
    this.onChange()
    if (!this.closed) this.emit('chat:exit', { chatId: this.chatId, gen: this.gen, error })
    this.resolveDone()
  }

  private onServerExit(why: string): void {
    for (const p of this.pending.values()) this.emit('permission:cancel', { chatId: this.chatId, requestId: p.payload.requestId })
    this.pending.clear()
    this.fail(why)
  }

  // ---- notifications ------------------------------------------------------

  private onNotification(method: string, p: any): void {
    switch (method) {
      case 'turn/started':
        this.activeTurnId = p.turn?.id
        this.items.clear()
        this.setStatus('running')
        return
      case 'item/started':
        return this.itemStarted(p.item as ThreadItem)
      case 'item/agentMessage/delta':
        return this.delta(p.itemId, 'text', String(p.delta ?? ''), 0)
      case 'item/reasoning/summaryTextDelta':
        return this.delta(p.itemId, 'thinking', String(p.delta ?? ''), typeof p.summaryIndex === 'number' ? p.summaryIndex : 0)
      case 'item/fileChange/patchUpdated': {
        const it = this.items.get(p.itemId)
        if (it && it.type === 'fileChange' && Array.isArray(p.changes)) this.items.set(p.itemId, { ...it, changes: p.changes } as ThreadItem)
        return
      }
      case 'item/completed':
        return this.itemCompleted(p.item as ThreadItem)
      case 'turn/plan/updated': {
        if (!Array.isArray(p.plan)) return
        this.forward(toolUseMessage(this.sid, planToolUse(String(p.turnId), p.plan)))
        return
      }
      case 'thread/tokenUsage/updated':
        this.tokenUsage = p.tokenUsage
        return
      case 'turn/completed':
        return this.turnCompleted(p.turn as Turn)
      case 'serverRequest/resolved': {
        const key = String(p.requestId)
        for (const [rid, a] of this.pending) {
          if (String(a.rpcId) === key) {
            this.pending.delete(rid)
            this.emit('permission:cancel', { chatId: this.chatId, requestId: rid })
            this.onChange()
          }
        }
        return
      }
      case 'thread/name/updated':
        this.emit('sessions:changed', null)
        return
      default:
        if (process.env.CCD_LOG_EVENTS) this.log(`codex event ${method} ${JSON.stringify(p).slice(0, 300)}`)
    }
  }

  private itemStarted(item: ThreadItem): void {
    this.items.set(item.id, item)
    if (item.type === 'agentMessage') return this.openStream(item.id, 'text')
    // Reasoning opens its stream on the first summary delta: most items carry no summary and would leave an empty message.
    if (item.type === 'reasoning') return
    const t = itemToolUse(item)
    if (!t) return
    this.inFlight.set(t.id, Date.now())
    this.forward(toolUseMessage(this.sid, t))
  }

  private openStream(id: string, kind: 'text' | 'thinking'): void {
    if (this.streaming.has(id)) return
    this.streaming.set(id, { kind, summaryIndex: 0, text: '' })
    this.forward(messageStart(this.sid, id))
    this.forward(blockStart(this.sid, id, kind))
  }

  private delta(id: string, kind: 'text' | 'thinking', delta: string, summaryIndex: number): void {
    if (!delta) return
    this.openStream(id, kind)
    const s = this.streaming.get(id)!
    let text = delta
    if (kind === 'thinking' && summaryIndex > s.summaryIndex) {
      text = '\n\n' + delta
      s.summaryIndex = summaryIndex
    }
    s.text += text
    this.forward(blockDelta(this.sid, id, kind, text))
  }

  private closeStream(id: string, finalText: string, kind: 'text' | 'thinking' = 'text'): void {
    const s = this.streaming.get(id)
    if (!s) {
      // Never streamed (e.g. a resumed turn): the completed frame alone carries the text.
      if (finalText) this.forward(assistantMessage(this.sid, id, [kind === 'text' ? { type: 'text', text: finalText } : { type: 'thinking', thinking: finalText }], this.lastModel))
      return
    }
    this.streaming.delete(id)
    this.forward(blockStop(this.sid, id))
    const text = finalText || s.text
    if (text) this.forward(assistantMessage(this.sid, id, [s.kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text }], this.lastModel))
    this.forward(messageStop(this.sid, id))
  }

  private itemCompleted(item: ThreadItem): void {
    const it = item as any
    if (item.type === 'agentMessage') return this.closeStream(item.id, String(it.text ?? ''))
    if (item.type === 'reasoning') {
      const text = (it.summary as string[] | undefined)?.join('\n\n') ?? ''
      if (!this.streaming.has(item.id) && !text) return
      return this.closeStream(item.id, text, 'thinking')
    }
    const t = itemToolUse(item)
    if (!t) return
    this.items.set(item.id, item)
    // The completed item may carry the final input (patch changes, search query).
    this.forward(toolUseMessage(this.sid, t))
    const r = itemToolResult(item)
    if (r) {
      this.inFlight.delete(t.id)
      this.forward(toolResultMessage(this.sid, t.id, r))
    }
  }

  private turnCompleted(turn: Turn): void {
    // Anything still open (interrupt) is closed so the reducer stops showing it as streaming.
    for (const id of [...this.streaming.keys()]) this.closeStream(id, '')
    this.inFlight.clear()
    this.activeTurnId = undefined
    for (const p of this.pending.values()) this.emit('permission:cancel', { chatId: this.chatId, requestId: p.payload.requestId })
    this.pending.clear()
    this.cleanupTemp()
    this.forward(resultMessage(this.sid, turn, this.tokenUsage))
    this.setStatus('idle')
    void this.emitContext()
  }

  // ---- approvals ----------------------------------------------------------

  private onRequest(id: RpcId, method: string, p: any): void {
    if (method === 'item/commandExecution/requestApproval') {
      const input: Record<string, unknown> = { command: p.command ?? p.reason ?? '', cwd: p.cwd ?? this.opts.cwd }
      this.addApproval(id, 'command', 'Bash', input, String(p.itemId ?? ''), p.reason ?? undefined)
    } else if (method === 'item/fileChange/requestApproval') {
      const item = this.items.get(String(p.itemId))
      const t = item ? itemToolUse(item) : null
      const input: Record<string, unknown> = { ...(t?.input ?? { changes: [] }), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) }
      this.addApproval(id, 'file', 'ApplyPatch', input, String(p.itemId ?? ''), p.reason ?? undefined)
    } else {
      this.server.respondError(id, -32601, `Hearth does not support ${method}`)
    }
  }

  private addApproval(rpcId: RpcId, kind: 'command' | 'file', toolName: string, input: Record<string, unknown>, itemId: string, reason?: string): void {
    const requestId = `codex-${rpcId}`
    // A turn started under another mode (or rejoined after a restart) still asks; in full access the user is never asked.
    if (this.codexMode === 'full-access') {
      this.server.respond(rpcId, { decision: 'acceptForSession' })
      this.lastActivity = Date.now()
      this.log(`codex ${toolName} approval ${requestId} auto-accepted (full-access)`)
      return
    }
    const payload: PermissionRequest = { chatId: this.chatId, requestId, toolName, input, toolUseID: itemId, suggestions: [], canRemember: true, decisionReason: reason }
    this.pending.set(requestId, { rpcId, kind, payload })
    this.lastActivity = Date.now()
    this.emit('permission:request', payload)
    this.onChange()
  }

  respond(requestId: string, response: PermissionResponse): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    this.lastActivity = Date.now()
    this.emit('permission:cancel', { chatId: this.chatId, requestId })
    this.onChange()
    const decision = response.behavior === 'allow' ? (response.remember ? 'acceptForSession' : 'accept') : response.interrupt ? 'cancel' : 'decline'
    this.server.respond(p.rpcId, { decision })
  }

  // ---- sending ------------------------------------------------------------

  private toInput(content: UserContent): UserInput[] {
    if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }]
    const out: UserInput[] = []
    for (const b of content as ContentBlock[]) {
      if (b.type === 'text') out.push({ type: 'text', text: b.text, text_elements: [] })
      else if (b.type === 'image') {
        const dir = join(tmpdir(), 'hearth-codex')
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${randomUUID()}.${IMAGE_EXT[b.source.media_type] ?? 'png'}`)
        writeFileSync(path, Buffer.from(b.source.data, 'base64'))
        this.tempFiles.push(path)
        out.push({ type: 'localImage', path })
      }
    }
    return out
  }

  private cleanupTemp(): void {
    for (const f of this.tempFiles.splice(0)) void rm(f, { force: true })
  }

  send(content: UserContent, uuid: string): void {
    this.lastActivity = Date.now()
    this.setStatus('running')
    this.chain = this.chain.then(() => this.doSend(content, uuid)).catch((e) => this.sendFailed(e))
  }

  private async doSend(content: UserContent, uuid: string): Promise<void> {
    await this.ready
    if (this.closed || this.exited) return
    const input = this.toInput(content)
    const threadId = this.sessionId!
    if (this.activeTurnId) {
      try {
        await this.server.request('turn/steer', { threadId, input, expectedTurnId: this.activeTurnId, clientUserMessageId: uuid })
        return
      } catch (e) {
        // The turn may have just ended; fall through to a new turn.
        this.log(`codex turn/steer failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const params: Record<string, unknown> = { threadId, input, clientUserMessageId: uuid, ...modeTurnParams(this.codexMode) }
    if (this.lastModel) params.model = this.lastModel
    if (this.lastEffort && this.lastEffort !== 'default') params.effort = this.lastEffort
    const res = await this.server.request<{ turn: Turn }>('turn/start', params)
    this.activeTurnId = res.turn?.id
  }

  private sendFailed(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    this.log(`codex send failed: ${msg}`)
    this.activeTurnId = undefined
    this.forward({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [msg], uuid: randomUUID(), session_id: this.sid, duration_ms: 0, total_cost_usd: 0, usage: {} })
    this.setStatus('idle')
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId
    if (!turnId || !this.sessionId) return
    // Cancelling a pending approval is part of interrupting.
    for (const [rid, p] of [...this.pending]) {
      this.pending.delete(rid)
      this.emit('permission:cancel', { chatId: this.chatId, requestId: rid })
      this.server.respond(p.rpcId, { decision: 'cancel' })
    }
    this.onChange()
    await this.server.request('turn/interrupt', { threadId: this.sessionId, turnId })
  }

  async setModel(model?: string): Promise<void> {
    this.lastModel = model && model !== 'default' ? model : undefined
    this.onChange()
  }

  async setEffort(effort?: string): Promise<void> {
    this.lastEffort = effort && effort !== 'default' ? effort : undefined
  }

  /**
   * Applies from the next turn. Switching back to `config` cannot unset an override already sent to the thread
   * (the app-server has no "clear"), so it only takes effect again when the thread is resumed.
   * Switching to `full-access` also accepts (for the session) every approval still pending.
   */
  async setPermissionMode(mode: string): Promise<void> {
    if (mode !== 'config' && mode !== 'read-only' && mode !== 'auto' && mode !== 'full-access') return
    this.codexMode = mode
    if (mode === 'full-access') {
      for (const [requestId, p] of this.pending) {
        this.emit('permission:cancel', { chatId: this.chatId, requestId })
        this.server.respond(p.rpcId, { decision: 'acceptForSession' })
      }
      this.pending.clear()
    }
    this.onChange()
  }

  async emitContext(): Promise<void> {
    const c = contextFromUsage(this.chatId, this.lastModel ?? 'codex', this.tokenUsage)
    if (c) this.emit('chat:context', c)
  }

  async listModels(): Promise<ModelChoice[]> {
    try {
      return await listCodexModels(this.server)
    } catch {
      return []
    }
  }

  async listCommands(): Promise<SlashCommandInfo[]> {
    return []
  }
  async listAgents(): Promise<AgentChoice[]> {
    return []
  }
  async fileSuggestions(_query: string): Promise<string[]> {
    return []
  }
  async mcpStatus(): Promise<McpServerInfo[]> {
    return []
  }
  async toggleMcp(_name: string, _enabled: boolean): Promise<void> {}
  async reconnectMcp(_name: string): Promise<void> {}
  async warmCache(): Promise<boolean> {
    return false
  }
  async taskOutput(_taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean } | null> {
    return null
  }
  async stopTask(_taskId: string): Promise<void> {}
  async backgroundTasks(_toolUseId?: string): Promise<boolean> {
    return false
  }

  close(): Promise<void> {
    if (this.closed) return this.done
    this.closed = true
    const threadId = this.sessionId
    // Stop a running turn (best effort), then release only Hearth's subscription (`thread/unsubscribe`; never archives anything).
    // Requests share one ordered connection, so a restarted runner's thread/resume still comes after this.
    const interrupt = threadId && !this.exited && this.activeTurnId ? this.server.request('turn/interrupt', { threadId, turnId: this.activeTurnId }).catch(() => undefined) : undefined
    if (threadId && this.sub) this.server.unsubscribe(threadId, this.sub, interrupt)
    for (const p of this.pending.values()) this.server.respond(p.rpcId, { decision: 'cancel' })
    this.pending.clear()
    this.cleanupTemp()
    this.exited = true
    this.onChange()
    this.resolveDone()
    return this.done
  }
}
