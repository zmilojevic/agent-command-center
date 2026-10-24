import {
  query,
  type Query,
  type SDKUserMessage,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { CHATS_DIR } from './paths'
import type { StartChatOptions, PermissionResponse, PermissionMode, ModelChoice, EffortLevel, SlashCommandInfo, AgentChoice, UserContent } from '../shared/types'

/** Minimal push-based async iterable used as the streaming prompt. */
class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
  suggestions: PermissionUpdate[]
}

export type Emit = (channel: string, payload: unknown) => void

/** System prompt of the general chats: a claude.ai-style assistant with web access, no coding-agent framing. */
function chatSystemPrompt(): string {
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return [
    'You are Claude, an AI assistant made by Anthropic, chatting with the user in the general chat window of their desktop app (like claude.ai).',
    'This is not a coding session and there is no project folder.',
    'Be helpful, direct and conversational; use Markdown (lists, tables, code blocks) where it helps and keep simple answers short.',
    'You can search the web with WebSearch and read pages with WebFetch: use them when a question needs current or specific facts you are unsure of (news, prices, versions, documentation, anything after your training data), not for things you already know well, and cite the sources you relied on as Markdown links.',
    `The current date is ${date}.`,
  ].join(' ')
}

export class ChatRunner {
  readonly chatId: string
  private queue = new PushQueue<SDKUserMessage>()
  private q: Query | null = null
  private abort = new AbortController()
  private pending = new Map<string, PendingPermission>()
  private closed = false
  private sentInitContext = false
  private resolveDone!: () => void
  /** Resolves once the CLI process loop has ended (or at once if it never started). */
  readonly done = new Promise<void>((res) => {
    this.resolveDone = res
  })

  constructor(
    private opts: StartChatOptions,
    private emit: Emit,
    private log: (s: string) => void,
    /** Distinguishes this runner from earlier ones for the same chat. */
    readonly gen: number,
  ) {
    this.chatId = opts.chatId
  }

  start(): void {
    const canUseTool: CanUseTool = (toolName, input, o) =>
      new Promise<PermissionResult>((resolve) => {
        const suggestions = (o.suggestions ?? []) as PermissionUpdate[]
        this.pending.set(o.requestId, { resolve, input, suggestions })
        this.emit('permission:request', {
          chatId: this.chatId,
          requestId: o.requestId,
          toolName,
          input,
          toolUseID: o.toolUseID,
          suggestions,
          canRemember: !o.suppressAlwaysAllowRule && suggestions.some((s) => (s as any).destination === 'localSettings'),
          decisionReason: o.decisionReason,
          blockedPath: o.blockedPath,
        })
        o.signal.addEventListener('abort', () => {
          if (!this.pending.has(o.requestId)) return
          this.pending.delete(o.requestId)
          this.emit('permission:cancel', { chatId: this.chatId, requestId: o.requestId })
          resolve({ behavior: 'deny', message: 'Request cancelled' })
        })
      })

    const options: Options = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      allowDangerouslySkipPermissions: this.opts.permissionMode === 'bypassPermissions',
      includePartialMessages: true,
      canUseTool,
      abortController: this.abort,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      stderr: (d) => this.log(d),
      // Thinking text is omitted by default; ask for summaries so the UI can show them.
      // Passed as a raw CLI flag so the user's own thinking settings stay in effect.
      extraArgs: { 'thinking-display': 'summarized' },
    }
    if (this.opts.cwd === CHATS_DIR) {
      // General chat: web tools only, no MCP servers, no project settings, no coding-agent prompt.
      options.tools = ['WebSearch', 'WebFetch']
      options.strictMcpConfig = true
      options.settingSources = ['user']
      options.systemPrompt = { type: 'custom', prompt: chatSystemPrompt(), snapshot: true }
    }
    if (this.opts.model && this.opts.model !== 'default') options.model = this.opts.model
    if (this.opts.effort) options.effort = this.opts.effort
    if (this.opts.resume) {
      options.resume = this.opts.resume
      if (this.opts.fork) options.forkSession = true
    } else {
      options.sessionId = this.opts.sessionId ?? this.chatId
    }

    this.q = query({ prompt: this.queue, options })
    void this.loop()
  }

  private async loop(): Promise<void> {
    let error: string | undefined
    try {
      for await (const m of this.q!) {
        if (process.env.CCD_LOG_EVENTS) this.log(`event ${JSON.stringify(m).slice(0, m.type === 'result' ? 4000 : 600)}`)
        this.emit('agent:event', { chatId: this.chatId, gen: this.gen, message: m })
        if (m.type === 'result') void this.emitContext()
        // Fill the context meter before the first turn, too.
        else if (m.type === 'system' && m.subtype === 'init' && !this.sentInitContext) {
          this.sentInitContext = true
          void this.emitContext()
        }
      }
    } catch (e) {
      if (!this.closed) error = e instanceof Error ? e.message : String(e)
    } finally {
      for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: 'Session ended' })
      this.pending.clear()
      // A deliberate close (tab closed, /clear, replaced by a new runner) is not an exit
      // the renderer should hear about: it would mark the replacement chat as ended.
      if (!this.closed) this.emit('chat:exit', { chatId: this.chatId, gen: this.gen, error })
      this.resolveDone()
    }
  }

  send(content: UserContent, uuid: string): void {
    this.queue.push({
      type: 'user',
      // ContentBlock is a subset of the Messages API content block params.
      message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
      parent_tool_use_id: null,
      uuid: uuid as never,
    })
  }

  respond(requestId: string, response: PermissionResponse): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (response.behavior === 'allow') {
      const updatedPermissions = response.remember
        ? p.suggestions.filter((s) => (s as any).destination === 'localSettings')
        : undefined
      p.resolve({
        behavior: 'allow',
        updatedInput: response.updatedInput ?? p.input,
        ...(updatedPermissions && updatedPermissions.length ? { updatedPermissions } : {}),
      })
    } else {
      p.resolve({ behavior: 'deny', message: response.message, interrupt: response.interrupt })
    }
  }

  async emitContext(): Promise<void> {
    if (!this.q) return
    try {
      const u = await this.q.getContextUsage({ detail: 'summary' })
      this.emit('chat:context', {
        chatId: this.chatId,
        model: u.model,
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        percentage: u.percentage,
        autoCompactThreshold: u.autoCompactThreshold,
        categories: (u.categories ?? []).map((c) => ({ id: c.id, name: c.name, tokens: c.tokens, kind: c.kind })),
      })
    } catch {
      /* CLI too old or session gone */
    }
  }

  usage(): Promise<unknown> | undefined {
    return this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt()
  }

  async setModel(model?: string): Promise<void> {
    await this.q?.setModel(model && model !== 'default' ? model : undefined)
  }

  /** Session-scoped (flag layer): never written to the user's settings files. */
  async setEffort(effort?: string): Promise<void> {
    await this.q?.applyFlagSettings({ effortLevel: effort && effort !== 'default' ? (effort as EffortLevel) : null })
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q?.setPermissionMode(mode)
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = (await this.q?.supportedModels()) ?? []
    return models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      supportsEffort: m.supportsEffort,
      efforts: m.supportedEffortLevels,
    }))
  }

  async listCommands(): Promise<SlashCommandInfo[]> {
    const cmds = (await this.q?.supportedCommands()) ?? []
    return cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }))
  }

  async listAgents(): Promise<AgentChoice[]> {
    const agents = (await this.q?.supportedAgents()) ?? []
    return agents.map((a) => ({ name: a.name, description: a.description, model: a.model }))
  }

  /** Keep-alive: an (undocumented) /btw side question reuses the cache prefix and leaves no transcript entry. */
  async warmCache(): Promise<boolean> {
    const q = this.q as any
    if (!q || typeof q.askSideQuestion !== 'function') return false
    try {
      await q.askSideQuestion('Cache keep-alive ping from the desktop app; no action needed. Reply with only: ok', {
        signal: AbortSignal.timeout(90_000),
      })
      return true
    } catch (e) {
      this.log(`warmCache failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /** Resolves when the CLI has exited, or after 5 s so a hung process never blocks the caller. */
  close(): Promise<void> {
    this.closed = true
    this.queue.close()
    try {
      this.q?.close()
    } catch {
      /* already closed */
    }
    this.abort.abort()
    if (!this.q) this.resolveDone()
    return Promise.race([this.done, new Promise<void>((res) => setTimeout(res, 5000).unref?.())])
  }
}

export class RunnerRegistry {
  private runners = new Map<string, ChatRunner>()
  private closing = new Map<string, Promise<void>>()
  private nextGen = 1

  constructor(private emit: Emit, private log: (s: string) => void) {}

  /** Starts (or restarts) the chat's CLI process and returns the runner's generation. */
  start(opts: StartChatOptions): number {
    const gen = this.nextGen++
    void this.close(opts.chatId)
    // Spawning the CLI in a missing directory fails with a misleading
    // "native binary failed to launch" error, so report it plainly.
    if (!existsSync(opts.cwd)) {
      this.runners.delete(opts.chatId)
      this.emit('chat:exit', { chatId: opts.chatId, gen, error: `Project folder ${opts.cwd} does not exist.` })
      return gen
    }
    const r = new ChatRunner(opts, this.emit, this.log, gen)
    this.runners.set(opts.chatId, r)
    r.start()
    return gen
  }

  get(chatId: string): ChatRunner | undefined {
    return this.runners.get(chatId)
  }

  /** Resolves when the chat's CLI process has exited; a repeated close awaits the same exit. */
  close(chatId: string): Promise<void> {
    const r = this.runners.get(chatId)
    if (!r) return this.closing.get(chatId) ?? Promise.resolve()
    this.runners.delete(chatId)
    const p = r.close().finally(() => {
      if (this.closing.get(chatId) === p) this.closing.delete(chatId)
    })
    this.closing.set(chatId, p)
    return p
  }

  /** Any live runner (first started). */
  any(): ChatRunner | undefined {
    return this.runners.values().next().value
  }

  closeAll(): void {
    for (const id of [...this.runners.keys()]) void this.close(id)
  }
}
