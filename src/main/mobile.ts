import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { dispatch } from './ipc'
import { PHONE_BLOCKED, DESKTOP_ONLY_EVENTS } from '../shared/channels'
import type { MobileStatus, PairInfo } from '../shared/types'

interface Device {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeen: number
}
interface Settings {
  enabled: boolean
  port: number
  devices: Device[]
}
interface Conn {
  deviceId?: string
  alive: boolean
  warned: boolean
  authTimer?: ReturnType<typeof setTimeout>
}

const DEFAULT_PORT = 47615
const PAIR_TTL_MS = 5 * 60_000
const MAX_BUFFERED = 8 * 1024 * 1024
// No 0/O/1/I/L.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function stripV4Mapped(addr: string): string {
  return addr.toLowerCase().startsWith('::ffff:') ? addr.slice(7) : addr
}

/** Parses a dotted IPv4 address, or null. */
function v4(addr: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p.every((n) => n <= 255) ? (p as [number, number, number, number]) : null
}

function isPrivateV4(a: [number, number, number, number]): boolean {
  return a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127)
}

/** Loopback, 10/8, 172.16/12, 192.168/16 or 100.64/10 only. */
function peerAllowed(remote: string | undefined): boolean {
  if (!remote) return false
  const a = stripV4Mapped(remote)
  if (a === '::1') return true
  const p = v4(a)
  if (!p) return false
  return p[0] === 127 || isPrivateV4(p)
}

export class MobileServer {
  private settings: Settings = { enabled: false, port: DEFAULT_PORT, devices: [] }
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private conns = new Map<WebSocket, Conn>()
  private running = false
  private error: string | undefined
  private pairing: { code: string; expiresAt: number; fails: number } | null = null
  private lastPersist = 0
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private readonly file = join(app.getPath('userData'), 'mobile.json')
  private readonly webRoot = resolve(join(import.meta.dirname, '../renderer'))

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private log: (s: string) => void,
  ) {
    try {
      if (existsSync(this.file)) {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
        this.settings = {
          enabled: j.enabled === true,
          port: typeof j.port === 'number' && j.port > 0 && j.port < 65536 ? j.port : DEFAULT_PORT,
          devices: Array.isArray(j.devices) ? j.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : [],
        }
      }
    } catch (e) {
      this.log(`mobile: could not read settings: ${String(e)}`)
    }
  }

  // ---- settings / status

  private async persist(): Promise<void> {
    this.lastPersist = Date.now()
    const tmp = `${this.file}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
      await rename(tmp, this.file)
    } catch (e) {
      this.log(`mobile: could not write settings: ${String(e)}`)
    }
  }

  private addresses(): string[] {
    const out: string[] = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (/^(docker|br-|veth|virbr)/.test(name)) continue
      for (const i of list ?? []) {
        if (i.family !== 'IPv4' || i.internal) continue
        const p = v4(i.address)
        if (p && isPrivateV4(p)) out.push(i.address)
      }
    }
    return out
  }

  status(): MobileStatus {
    return {
      enabled: this.settings.enabled,
      port: this.settings.port,
      running: this.running,
      ...(this.error ? { error: this.error } : {}),
      addresses: this.addresses(),
      devices: this.settings.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen })),
    }
  }

  private changed(): void {
    this.emit('mobile:changed', this.status())
  }

  async setEnabled(on: boolean): Promise<MobileStatus> {
    this.settings.enabled = on
    await this.persist()
    if (on) await this.start()
    else this.stop()
    this.changed()
    return this.status()
  }

  // ---- server lifecycle

  /** Starts listening if enabled. */
  start(): Promise<void> {
    if (!this.settings.enabled || this.server) return Promise.resolve()
    this.error = undefined
    const server = createServer((req, res) => void this.onRequest(req, res))
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    this.server = server
    this.wss = wss
    server.on('upgrade', (req, socket, head) => {
      if (!peerAllowed(req.socket.remoteAddress)) return void socket.destroy()
      if ((req.url ?? '').split('?')[0] !== '/ws') return void socket.destroy()
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws))
    })
    this.pingTimer = setInterval(() => this.pingAll(), 30_000)
    this.pingTimer.unref?.()
    return new Promise<void>((done) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error = `${e.code ?? 'error'}: ${e.message}`
        this.log(`mobile: server error: ${this.error}`)
        this.teardown()
        this.changed()
        done()
      })
      server.listen(this.settings.port, '0.0.0.0', () => {
        this.running = true
        this.log(`mobile: listening on :${this.settings.port}`)
        this.changed()
        done()
      })
    })
  }

  private teardown(): void {
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
    for (const [ws, c] of this.conns) {
      clearTimeout(c.authTimer)
      try {
        ws.close(1001)
      } catch {
        /* gone */
      }
    }
    this.conns.clear()
    this.wss?.close()
    this.server?.close()
    this.server?.closeAllConnections?.()
    this.wss = null
    this.server = null
    this.running = false
  }

  stop(): void {
    const was = this.server !== null
    this.teardown()
    if (was) this.log('mobile: stopped')
  }

  // ---- HTTP (static UI)

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!peerAllowed(req.socket.remoteAddress)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    try {
      let rel = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0])
      if (rel === '/' || rel === '') rel = '/mobile.html'
      const file = resolve(join(this.webRoot, rel))
      if (file !== this.webRoot && !file.startsWith(this.webRoot + sep)) {
        res.writeHead(403).end('Forbidden')
        return
      }
      const st = await stat(file)
      if (!st.isFile()) throw new Error('not a file')
      const ext = extname(file).toLowerCase()
      const headers: Record<string, string | number> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': st.size }
      if (ext === '.html') headers['Cache-Control'] = 'no-cache'
      res.writeHead(200, headers)
      if (req.method === 'HEAD') return void res.end()
      res.end(await readFile(file))
    } catch {
      if (!res.headersSent) res.writeHead(404).end('Not found')
      else res.end()
    }
  }

  // ---- WebSocket

  private pingAll(): void {
    for (const [ws, c] of this.conns) {
      if (!c.alive) {
        ws.terminate()
        continue
      }
      c.alive = false
      try {
        ws.ping()
      } catch {
        /* closing */
      }
    }
  }

  private reply(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  private onSocket(ws: WebSocket): void {
    const conn: Conn = { alive: true, warned: false }
    this.conns.set(ws, conn)
    // Unauthenticated sockets do not linger.
    conn.authTimer = setTimeout(() => {
      if (!conn.deviceId) ws.close(4401)
    }, 15_000)
    ws.on('pong', () => (conn.alive = true))
    ws.on('close', () => {
      clearTimeout(conn.authTimer)
      this.conns.delete(ws)
    })
    ws.on('error', () => ws.terminate())
    ws.on('message', (data) => {
      conn.alive = true
      let msg: any
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return void ws.close(4400)
      }
      if (!msg || typeof msg !== 'object') return void ws.close(4400)
      if (!conn.deviceId) return void this.preAuth(ws, conn, msg)
      void this.onMessage(ws, conn.deviceId, msg)
    })
  }

  private preAuth(ws: WebSocket, conn: Conn, msg: any): void {
    if (msg.type === 'pair') return this.onPair(ws, msg)
    if (msg.type === 'auth' && typeof msg.token === 'string') {
      const h = sha256(msg.token)
      const dev = this.settings.devices.find((d) => d.tokenHash === h)
      if (!dev) return void ws.close(4401)
      conn.deviceId = dev.id
      clearTimeout(conn.authTimer)
      dev.lastSeen = Date.now()
      if (Date.now() - this.lastPersist > 60_000) void this.persist()
      this.reply(ws, { type: 'hello', deviceId: dev.id, platform: process.platform })
      return
    }
    ws.close(4401)
  }

  private onPair(ws: WebSocket, msg: any): void {
    const p = this.pairing
    const code = typeof msg.code === 'string' ? msg.code.replace(/\s+/g, '').toUpperCase() : ''
    if (!p || Date.now() > p.expiresAt) {
      this.pairing = null
      return this.reply(ws, { type: 'error', error: 'Invalid or expired code' })
    }
    if (code !== p.code) {
      if (++p.fails >= 5) this.pairing = null
      return this.reply(ws, { type: 'error', error: 'Invalid or expired code' })
    }
    this.pairing = null
    const name = (typeof msg.name === 'string' ? msg.name.trim() : '').slice(0, 40) || 'Phone'
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const dev: Device = { id: randomUUID(), name, tokenHash: sha256(token), createdAt: now, lastSeen: now }
    this.settings.devices.push(dev)
    void this.persist()
    this.reply(ws, { type: 'paired', deviceId: dev.id, token })
    this.changed()
  }

  private async onMessage(ws: WebSocket, deviceId: string, msg: any): Promise<void> {
    if (msg.type !== 'invoke' && msg.type !== 'send') return
    const channel = typeof msg.channel === 'string' ? msg.channel : ''
    const args = Array.isArray(msg.args) ? msg.args : []
    const allowed = channel && !PHONE_BLOCKED.has(channel) && !channel.startsWith('mobile:')
    if (msg.type === 'send') {
      if (!allowed) return
      try {
        await dispatch(channel, { client: 'phone:' + deviceId }, args)
      } catch (e) {
        this.log(`mobile: send ${channel} failed: ${String(e)}`)
      }
      return
    }
    if (!allowed) return this.reply(ws, { id: msg.id, type: 'result', ok: false, error: 'not allowed' })
    try {
      const value = await dispatch(channel, { client: 'phone:' + deviceId }, args)
      this.reply(ws, { id: msg.id, type: 'result', ok: true, value })
    } catch (e) {
      this.reply(ws, { id: msg.id, type: 'result', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Sends a main-process event to every authenticated phone. */
  broadcast(channel: string, payload: unknown): void {
    if (!this.running || DESKTOP_ONLY_EVENTS.has(channel) || channel.startsWith('mobile:')) return
    let frame: string | undefined
    for (const [ws, c] of this.conns) {
      if (!c.deviceId || ws.readyState !== ws.OPEN) continue
      if (ws.bufferedAmount > MAX_BUFFERED) {
        if (!c.warned) {
          c.warned = true
          this.log(`mobile: skipping events for a stalled phone (${ws.bufferedAmount} bytes buffered)`)
        }
        continue
      }
      c.warned = false
      frame ??= JSON.stringify({ type: 'event', channel, payload })
      ws.send(frame)
    }
  }

  // ---- pairing / devices

  pairStart(): PairInfo {
    let code = ''
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const expiresAt = Date.now() + PAIR_TTL_MS
    this.pairing = { code, expiresAt, fails: 0 }
    const host = this.addresses()[0] ?? 'localhost'
    return { code, url: `http://${host}:${this.settings.port}/#pair=${code}`, expiresAt }
  }

  revoke(id: string): MobileStatus {
    this.settings.devices = this.settings.devices.filter((d) => d.id !== id)
    void this.persist()
    for (const [ws, c] of this.conns) if (c.deviceId === id) ws.close(4401)
    this.changed()
    return this.status()
  }
}
