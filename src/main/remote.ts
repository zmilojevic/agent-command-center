// Remote Control: mirrors a chat to claude.ai/code (and the Claude mobile app) through the SDK's alpha
// `@anthropic-ai/claude-agent-sdk/bridge` export. The CLI's own `--remote-control` only works in the
// interactive REPL, so the app acts as the host itself (like Claude Desktop / VS Code do).
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renameSession, type SDKMessage, type SDKControlRequest, type SDKControlResponse } from '@anthropic-ai/claude-agent-sdk'
import {
  attachBridgeSession,
  createCodeSession,
  fetchRemoteCredentials,
  isCreateSessionFailure,
  isCredentialsFailure,
  isCredentialsRejection,
  type BridgeSessionHandle,
  type RemoteCredentials,
  type SessionState,
} from '@anthropic-ai/claude-agent-sdk/bridge'
import type { ChatRunner, Emit, RunnerRegistry, RemoteHooks } from './agent'
import type { PermissionMode, RemoteEnableInfo, RemoteStateEvent, UserContent } from '../shared/types'

// Same default the CLI uses (BASE_API_URL). Deliberately not overridable by env: the OAuth token is only ever sent here.
const BASE_URL = 'https://api.anthropic.com'
const HTTP_TIMEOUT = 15_000
const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json')
const TOKEN_EXPIRED = 'Claude login token expired – send a message in any chat to refresh it'

/** Fresh OAuth access token for the bridge HTTP calls only; never logged, never written, never sent to the renderer. */
function readAccessToken(): string {
  let o: { accessToken?: string; expiresAt?: number } | undefined
  if (process.platform === 'darwin') {
    // Claude Code keeps the OAuth credentials in the login Keychain on macOS.
    try {
      const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      o = JSON.parse(out).claudeAiOauth
    } catch {
      /* fall back to the file */
    }
  }
  if (!o) {
    try {
      o = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')).claudeAiOauth
    } catch {
      throw new Error(process.platform === 'darwin' ? 'Not logged in to Claude' : 'Not logged in to Claude (no ~/.claude/.credentials.json)')
    }
  }
  if (!o?.accessToken) throw new Error('Not logged in to Claude (no access token)')
  if (typeof o.expiresAt === 'number' && o.expiresAt < Date.now() + 30_000) throw new Error(TOKEN_EXPIRED)
  return o.accessToken
}

// session id -> cse id, so re-enabling or an app restart re-attaches the same claude.ai session.
const mapFile = (): string => join(app.getPath('userData'), 'remote-sessions.json')
function loadMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(mapFile(), 'utf8'))
  } catch {
    return {}
  }
}
function saveMap(m: Record<string, string>): void {
  try {
    mkdirSync(dirname(mapFile()), { recursive: true })
    writeFileSync(mapFile(), JSON.stringify(m, null, 2))
  } catch {
    /* best effort */
  }
}

const sessionUrl = (cse: string): string => `https://claude.ai/code/${cse.replace(/^cse_/, 'session_')}`

/** Human-readable reason for a failed createCodeSession / fetchRemoteCredentials result. */
function failureText(r: unknown, what: string): string {
  if (r === null || r === undefined) return `${what}: could not reach Anthropic (network or server error)`
  if (isCredentialsRejection(r)) return 'Claude login token rejected – send a message in any chat to refresh it'
  if (isCreateSessionFailure(r as never)) {
    const f = r as { reason: string; status: number; detail?: string }
    return `${what} failed (${f.reason}, HTTP ${f.status}${f.detail ? `: ${f.detail}` : ''})`
  }
  if (isCredentialsFailure(r as never)) {
    const f = r as { reason: string; status?: number }
    if (f.reason === 'untrusted_device') return `${what} failed: untrusted_device (this device is not enrolled as a trusted device for Remote Control)`
    if (f.reason === 'session_stale_relogin') return `${what} failed: session_stale_relogin (log in again with the Claude CLI: claude /login)`
    return `${what} failed (${f.reason}${f.status ? `, HTTP ${f.status}` : ''})`
  }
  return `${what} failed`
}

type Verdict = { ok: true } | { ok: false; error: string }

class RemoteBridge implements RemoteHooks {
  state: RemoteStateEvent['state'] = 'off'
  private handle: BridgeSessionHandle | null = null
  private cse = ''
  private refreshTimer: NodeJS.Timeout | null = null
  private jwtDeadline = 0
  private disposed = false
  private finished = false
  private running = false
  private reported: SessionState | null = null
  /** uuids of user messages that came from claude.ai: already visible there, so not echoed back. */
  private inbound = new Set<string>()
  /** can_use_tool requests we forwarded and that are still unanswered. */
  private pendingReqs = new Set<string>()
  /** Requests answered from claude.ai: no cancel needed. */
  private answeredRemotely = new Set<string>()

  constructor(
    readonly chatId: string,
    private runner: ChatRunner,
    private info: RemoteEnableInfo,
    private emit: Emit,
    private log: (s: string) => void,
    private onDispose: (b: RemoteBridge) => void,
  ) {}

  private setState(state: RemoteStateEvent['state'], error?: string): void {
    this.state = state
    const ev: RemoteStateEvent = { chatId: this.chatId, state }
    if (error) ev.error = error
    if (this.cse && state !== 'off') ev.url = sessionUrl(this.cse)
    this.emit('remote:state', ev)
  }

  async connect(): Promise<void> {
    this.setState('connecting')
    try {
      const map = loadMap()
      let cse = map[this.info.sessionId]
      let creds: RemoteCredentials | null = null
      if (cse) {
        const r = await fetchRemoteCredentials(cse, BASE_URL, readAccessToken(), HTTP_TIMEOUT)
        if (r && 'worker_jwt' in r) creds = r
        // A stored session that was archived or deleted server-side: start a new one. Auth problems are not that.
        else if (r === null || isCredentialsRejection(r) || (isCredentialsFailure(r) && r.reason !== 'request_rejected')) throw new Error(failureText(r, 'Remote Control credentials'))
        else cse = ''
      }
      if (!creds) {
        const model = this.info.model && this.info.model !== 'default' ? this.info.model : undefined
        const created = await createCodeSession(BASE_URL, readAccessToken(), this.info.title || 'Hearth', HTTP_TIMEOUT, undefined, undefined, this.info.cwd, model)
        if (typeof created !== 'string') throw new Error(failureText(created, 'Creating the claude.ai session'))
        cse = created
        map[this.info.sessionId] = cse
        saveMap(map)
        const r = await fetchRemoteCredentials(cse, BASE_URL, readAccessToken(), HTTP_TIMEOUT)
        if (!r || !('worker_jwt' in r)) throw new Error(failureText(r, 'Remote Control credentials'))
        creds = r
      }
      this.cse = cse
      if (this.disposed) return
      this.handle = await attachBridgeSession({
        sessionId: cse,
        ingressToken: creds.worker_jwt,
        apiBaseUrl: creds.api_base_url,
        epoch: creds.worker_epoch,
        outboundOnly: false,
        onInboundMessage: (m) => this.onInbound(m),
        onPermissionResponse: (r) => this.onPermissionResponse(r),
        onInterrupt: () => void this.runner.interrupt().catch(() => {}),
        onSetModel: (model) => this.onSetModel(model),
        onSetPermissionMode: (mode) => this.onSetPermissionMode(mode),
        onRenameSession: (title) => this.onRename(title),
        onClose: (code) => void this.onTransportClose(code),
      })
      if (this.disposed) {
        this.handle.close()
        return
      }
      this.scheduleRefresh(creds.expires_in)
      this.handle.reportMetadata({ ...(this.info.branch ? { branch: this.info.branch } : {}), dir: this.info.cwd })
      this.reportState(this.running ? 'running' : 'idle')
      this.setState('on')
    } catch (e) {
      if (this.disposed) return
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`remote: connect failed: ${msg}`)
      this.teardown(false)
      this.setState('error', msg)
    }
  }

  private scheduleRefresh(expiresInSec: number, delayMs?: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (delayMs === undefined) {
      this.jwtDeadline = Date.now() + expiresInSec * 1000
      delayMs = Math.max(60_000, Math.min(expiresInSec * 750, 3 * 3_600_000))
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), delayMs)
    this.refreshTimer.unref?.()
  }

  /** New worker JWT (bumps the epoch) and swap the transport in place; used for expiry and for 401 / 4090 / 4094 closes. */
  private async refresh(): Promise<void> {
    if (this.disposed || !this.handle) return
    try {
      const r = await fetchRemoteCredentials(this.cse, BASE_URL, readAccessToken(), HTTP_TIMEOUT)
      if (!r || !('worker_jwt' in r)) throw new Error(failureText(r, 'Refreshing Remote Control credentials'))
      await this.handle.reconnectTransport({ ingressToken: r.worker_jwt, apiBaseUrl: r.api_base_url, epoch: r.worker_epoch })
      this.scheduleRefresh(r.expires_in)
      if (this.state !== 'on') this.setState('on')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`remote: refresh failed: ${msg}`)
      if (this.disposed) return
      if (Date.now() > this.jwtDeadline) {
        this.teardown(false)
        this.setState('error', msg)
      } else this.scheduleRefresh(0, 120_000)
    }
  }

  private async onTransportClose(code?: number): Promise<void> {
    if (this.disposed) return
    this.log(`remote: transport closed (${code ?? 'no code'})`)
    if (code === 401 || code === 4094 || code === 4090) return this.refresh()
    this.teardown(false)
    this.setState('error', `Remote Control disconnected (code ${code ?? 'unknown'})`)
  }

  // ---- outbound (RemoteHooks) ----

  private reportState(s: SessionState): void {
    if (this.reported === s) return
    this.reported = s
    this.handle?.reportState(s)
  }

  private markRunning(): void {
    this.running = true
    this.reportState(this.pendingReqs.size ? 'requires_action' : 'running')
  }

  message(m: SDKMessage): void {
    const h = this.handle
    if (!h) return
    try {
      switch (m.type) {
        case 'stream_event':
          // Partial deltas are not forwarded (the CLI REPL bridge only sends them behind a flag); just track the turn.
          if (!this.running) this.markRunning()
          break
        case 'assistant':
          if (!this.running) this.markRunning()
          h.write(m)
          break
        case 'user':
          if (!this.running) this.markRunning()
          if (!this.inbound.has(String(m.uuid))) h.write(m)
          break
        case 'system':
          if (m.subtype === 'init' || m.subtype === 'compact_boundary') h.write(m)
          break
        case 'result':
          this.running = false
          h.sendResult()
          this.reportState('idle')
          break
        default:
          break
      }
    } catch (e) {
      this.log(`remote: write failed: ${String(e)}`)
    }
  }

  userSent(content: UserContent, uuid: string): void {
    if (!this.handle) return
    try {
      if (!this.inbound.has(uuid)) {
        this.handle.write({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          uuid,
          session_id: this.info.sessionId,
        } as unknown as SDKMessage)
      }
      this.markRunning()
    } catch (e) {
      this.log(`remote: write failed: ${String(e)}`)
    }
  }

  permissionRequest(req: Parameters<RemoteHooks['permissionRequest']>[0]): void {
    if (!this.handle) return
    try {
      this.pendingReqs.add(req.requestId)
      this.handle.sendControlRequest({
        type: 'control_request',
        request_id: req.requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: req.toolName,
          input: req.input,
          tool_use_id: req.toolUseID,
          ...(req.suggestions.length ? { permission_suggestions: req.suggestions } : {}),
          ...(req.decisionReason ? { decision_reason: req.decisionReason } : {}),
          ...(req.blockedPath ? { blocked_path: req.blockedPath } : {}),
        },
      } as SDKControlRequest)
      this.reportState('requires_action')
    } catch (e) {
      this.log(`remote: permission forward failed: ${String(e)}`)
    }
  }

  permissionDone(requestId: string): void {
    if (!this.pendingReqs.delete(requestId)) return
    if (this.answeredRemotely.delete(requestId)) {
      /* answered on claude.ai, nothing to dismiss */
    } else {
      try {
        this.handle?.sendControlCancelRequest(requestId)
      } catch {
        /* transport gone */
      }
    }
    if (!this.pendingReqs.size) this.reportState(this.running ? 'running' : 'idle')
  }

  closed(): void {
    this.teardown(true)
  }

  // ---- inbound ----

  private onInbound(m: SDKMessage): void {
    if (m.type !== 'user') return
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (content === undefined || content === null) return
    const uuid = (m as { uuid?: string }).uuid ?? randomUUID()
    this.inbound.add(uuid)
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
              .filter(Boolean)
              .join('\n')
          : ''
    this.emit('chat:remoteMessage', { chatId: this.chatId, text, uuid })
    this.runner.send(content as UserContent, uuid)
  }

  private onPermissionResponse(res: SDKControlResponse): boolean | void {
    const r = res.response as { subtype: string; request_id: string; response?: Record<string, unknown>; error?: string }
    if (!this.pendingReqs.has(r.request_id)) return false
    this.answeredRemotely.add(r.request_id)
    if (r.subtype === 'success' && r.response?.behavior === 'allow') {
      this.runner.respond(r.request_id, {
        behavior: 'allow',
        ...(r.response.updatedInput ? { updatedInput: r.response.updatedInput as Record<string, unknown> } : {}),
      })
    } else {
      const message = typeof r.response?.message === 'string' ? r.response.message : (r.error ?? 'Denied from claude.ai')
      this.runner.respond(r.request_id, { behavior: 'deny', message, interrupt: r.response?.interrupt === true })
    }
    this.emit('permission:cancel', { chatId: this.chatId, requestId: r.request_id })
  }

  private onSetModel(model: string | undefined): Verdict {
    void this.runner.setModel(model).catch((e) => this.log(`remote: setModel failed: ${String(e)}`))
    this.emit('remote:setting', { chatId: this.chatId, model: model ?? 'default' })
    return { ok: true }
  }

  private onSetPermissionMode(mode: PermissionMode): Verdict {
    void this.runner.setPermissionMode(mode).catch((e) => this.log(`remote: setPermissionMode failed: ${String(e)}`))
    this.emit('remote:setting', { chatId: this.chatId, permissionMode: mode })
    return { ok: true }
  }

  private onRename(title: string): Verdict {
    renameSession(this.info.sessionId, title, { dir: this.info.cwd })
      .then(() => this.emit('sessions:changed', null))
      .catch((e) => this.log(`remote: rename failed: ${String(e)}`))
    return { ok: true }
  }

  // ---- lifecycle ----

  /** Stops everything. `off` emits state 'off' (deliberate close); otherwise the caller sets the error state itself. */
  teardown(off: boolean): void {
    if (off) {
      if (this.finished) return
      this.finished = true
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    const h = this.handle
    this.handle = null
    if (h) {
      try {
        h.reportState('idle')
        void h.flush().catch(() => {}).finally(() => h.close())
      } catch {
        try {
          h.close()
        } catch {
          /* gone */
        }
      }
    }
    if (this.runner.remote === this) this.runner.remote = null
    if (off) {
      this.disposed = true
      this.onDispose(this)
      this.setState('off')
    }
  }

  dispose(): void {
    this.disposed = true
    this.teardown(true)
  }
}

export class RemoteManager {
  private bridges = new Map<string, RemoteBridge>()

  constructor(
    private runners: RunnerRegistry,
    private emit: Emit,
    private log: (s: string) => void,
  ) {}

  async enable(chatId: string, info: RemoteEnableInfo): Promise<void> {
    const runner = this.runners.get(chatId)
    if (!runner) {
      this.emit('remote:state', { chatId, state: 'error', error: 'The chat is not running' } satisfies RemoteStateEvent)
      return
    }
    const old = this.bridges.get(chatId)
    if (old && old.state !== 'error') return
    old?.dispose()
    const b = new RemoteBridge(chatId, runner, info, this.emit, this.log, (x) => {
      if (this.bridges.get(chatId) === x) this.bridges.delete(chatId)
    })
    this.bridges.set(chatId, b)
    runner.remote = b
    await b.connect()
  }

  disable(chatId: string): void {
    this.bridges.get(chatId)?.dispose()
    this.bridges.delete(chatId)
    this.emit('remote:state', { chatId, state: 'off' } satisfies RemoteStateEvent)
  }
}
