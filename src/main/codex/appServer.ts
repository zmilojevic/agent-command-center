import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import type { RpcId } from './protocol'

const REQUEST_TIMEOUT_MS = 60_000
/** Hearth's own connection / private child is closed after this long without subscribed runners or requests (a shared daemon keeps running). */
const IDLE_STOP_MS = 10 * 60_000

/** Locates the `codex` binary: PATH plus the usual user install dirs. */
export function codexBinary(): string | undefined {
  const exe = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra = process.platform === 'win32' ? [] : [join(homedir(), '.local', 'bin'), '/usr/bin', '/usr/local/bin', join(homedir(), '.npm-global', 'bin')]
  for (const d of [...dirs, ...extra]) {
    for (const n of exe) {
      const p = join(d, n)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

/** What a CodexRunner receives for its thread. */
export interface ThreadSubscriber {
  onNotification(method: string, params: any): void
  /** A server-to-client request (approvals); answer it with `respond` / `respondError`. */
  onRequest(id: RpcId, method: string, params: any): void
  /** The app-server connection or process died. */
  onExit(error: string): void
}

interface Waiter {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/** One connection to an app-server: the shared daemon's WebSocket or a private stdio child. */
interface Link {
  kind: 'daemon' | 'stdio'
  send(line: string): void
  close(): void
}

/** The daemon's control socket (`codex app-server daemon`, honours CODEX_HOME); a symlink to a socket under /tmp. */
export function daemonSocketPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock')
}

/**
 * One app-server connection shared by all Codex chats, started lazily and re-established on next use after a disconnect.
 * Transport order: (1) the user's shared Codex daemon over its unix socket (JSON-RPC in WebSocket text frames), so threads
 * the terminal app touched are not locked by "already has an active writer"; (2) if the socket is missing/refuses,
 * `codex app-server daemon start` once, then connect again; (3) a private `codex app-server` child over stdio.
 * Hearth never stops or restarts the daemon: closing only drops its own WebSocket.
 */
export class CodexServer {
  private link: Link | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private waiters = new Map<RpcId, Waiter>()
  private subs = new Map<string, ThreadSubscriber>()
  private globals = new Set<(method: string, params: any) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  /** `daemon`, `stdio` or null while not connected. */
  get transport(): 'daemon' | 'stdio' | null {
    return this.link?.kind ?? null
  }

  constructor(
    private log: (s: string) => void,
    private version: string,
  ) {}

  /** Connects and runs the initialize handshake (once; concurrent callers share it). */
  ensure(): Promise<void> {
    if (this.ready) return this.ready
    const bin = codexBinary()
    if (!bin) return Promise.reject(new Error('Codex CLI not found'))
    const p = this.open(bin)
    this.ready = p
    p.catch(() => {
      if (this.ready === p) this.ready = null
    })
    return p
  }

  private async open(bin: string): Promise<void> {
    if (process.platform !== 'win32' && process.env.CCD_CODEX_TRANSPORT !== 'stdio') {
      if (await this.tryDaemon(2)) return
      this.log('codex: daemon socket unavailable, running `codex app-server daemon start`')
      if (await this.startDaemon(bin)) {
        if (await this.tryDaemon(1)) return
      }
      this.log('codex: shared daemon unavailable, falling back to a private stdio app-server')
    }
    await this.attach(this.spawnStdio(bin))
    this.log('codex: transport = private stdio app-server')
  }

  private async tryDaemon(attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const link = await this.connectDaemon()
        if (await this.attach(link).then(() => true, () => false)) {
          this.log('codex: transport = shared daemon socket')
          return true
        }
      } catch (e) {
        this.log(`codex: daemon connect failed: ${e instanceof Error ? e.message : String(e)}`)
        if (e instanceof Error && /ENOENT|ECONNREFUSED/.test(e.message)) return false
      }
    }
    return false
  }

  private startDaemon(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(bin, ['app-server', 'daemon', 'start'], { timeout: 20_000, env: this.childEnv(), windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim()
        if (out) this.log(`codex daemon start: ${out.slice(0, 300)}`)
        resolve(!err)
      })
    })
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k.startsWith('CCD_')) delete env[k]
    return env
  }

  private connectDaemon(): Promise<Link> {
    return new Promise((resolve, reject) => {
      let sock: string
      try {
        sock = realpathSync(daemonSocketPath())
      } catch (e) {
        reject(e)
        return
      }
      const ws = new WebSocket('ws://localhost/', { createConnection: () => connect(sock), perMessageDeflate: false, handshakeTimeout: 5000 })
      let linked: Link | null = null
      ws.once('open', () => {
        const link: Link = {
          kind: 'daemon',
          send: (line) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(line)
          },
          close: () => {
            try {
              ws.close()
            } catch {
              /* gone */
            }
          },
        }
        linked = link
        resolve(link)
      })
      ws.on('message', (d) => this.onLine(String(d)))
      ws.on('error', (e) => {
        if (!linked) reject(e)
      })
      ws.on('close', (code) => {
        if (linked) this.died(linked, `codex app-server connection closed (${code})`)
        else reject(new Error(`closed before open (${code})`))
      })
    })
  }

  private spawnStdio(bin: string): Link {
    const proc = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: this.childEnv(), windowsHide: true, shell: process.platform === 'win32' && bin.endsWith('.cmd') })
    const link: Link = {
      kind: 'stdio',
      send: (line) => {
        proc.stdin?.write(line + '\n')
      },
      close: () => {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
      },
    }
    proc.stderr?.on('data', (d: Buffer) => this.log(`codex: ${String(d).trimEnd()}`))
    proc.stdin?.on('error', () => {
      /* the exit handler reports it */
    })
    proc.on('error', (e) => this.died(link, e.message))
    proc.on('exit', (code, sig) => this.died(link, `codex app-server exited (${sig ?? code})`))
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line))
    return link
  }

  /** Makes `link` current and runs the initialize handshake; on failure the link is dropped again. */
  private async attach(link: Link): Promise<void> {
    this.link = link
    try {
      await this.rawRequest('initialize', {
        clientInfo: { name: 'hearth', title: 'Hearth', version: this.version },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, 15_000)
      this.write({ method: 'initialized' })
      this.armIdle()
    } catch (e) {
      if (this.link === link) this.link = null
      link.close()
      throw e
    }
  }

  /** The connection or child went away (also a daemon restart/update): fail requests and tell every runner; the next use reconnects. */
  private died(link: Link, why: string): void {
    if (this.link !== link) return
    this.link = null
    this.ready = null
    clearTimeout(this.idleTimer)
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new Error(why))
      this.waiters.delete(id)
    }
    const subs = [...this.subs.values()]
    this.subs.clear()
    for (const s of subs) s.onExit(why)
  }

  private write(msg: object): void {
    this.link?.send(JSON.stringify(msg))
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.method !== undefined) {
      const params = m.params ?? {}
      const threadId: unknown = params.threadId
      const sub = typeof threadId === 'string' ? this.subs.get(threadId) : undefined
      if (m.id !== undefined) {
        // Server-to-client request.
        if (sub) sub.onRequest(m.id, m.method, params)
        else this.respondError(m.id, -32601, `Hearth does not handle ${m.method} here`)
      } else if (sub) {
        sub.onNotification(m.method, params)
      } else {
        for (const g of this.globals) g(m.method, params)
      }
      return
    }
    if (m.id !== undefined) {
      const w = this.waiters.get(m.id)
      if (!w) return
      this.waiters.delete(m.id)
      clearTimeout(w.timer)
      if (m.error) w.reject(new Error(`${w.method}: ${m.error.message ?? 'error'}`))
      else w.resolve(m.result)
    }
  }

  private rawRequest(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`${method}: timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(id, { resolve, reject, timer, method })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  /** Request after (lazily) starting the server. */
  async request<T = any>(method: string, params?: unknown): Promise<T> {
    await this.ensure()
    try {
      return (await this.rawRequest(method, params)) as T
    } finally {
      this.armIdle()
    }
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  subscribe(threadId: string, sub: ThreadSubscriber): void {
    this.subs.set(threadId, sub)
    clearTimeout(this.idleTimer)
  }

  /**
   * Only removes the subscription if it is still `sub` (a restarted runner may already hold the thread), then tells the server
   * (`thread/unsubscribe`, after `after` settles, e.g. an interrupt). That releases only Hearth's subscription; the thread is kept.
   */
  unsubscribe(threadId: string, sub: ThreadSubscriber, after?: Promise<unknown>): void {
    if (this.subs.get(threadId) === sub) {
      this.subs.delete(threadId)
      const link = this.link
      const run = (): void => {
        if (link && this.link === link && !this.subs.has(threadId)) this.rawRequest('thread/unsubscribe', { threadId }, 10_000).catch(() => undefined)
      }
      if (after) void after.then(run, run)
      else run()
    }
    this.armIdle()
  }

  /** Listener for thread-less notifications (`account/*`). Returns the remover. */
  onGlobal(cb: (method: string, params: any) => void): () => void {
    this.globals.add(cb)
    return () => this.globals.delete(cb)
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    if (!this.link || this.subs.size > 0) return
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
    this.idleTimer.unref?.()
  }

  /** Drops Hearth's connection (daemon: only the WebSocket, the daemon keeps running; stdio: kills the private child). */
  stop(): void {
    const l = this.link
    if (!l) return
    this.died(l, 'codex app-server stopped')
    l.close()
  }
}
