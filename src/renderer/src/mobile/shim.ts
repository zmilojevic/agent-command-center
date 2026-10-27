import { INVOKES, SENDS, EVENTS } from '@shared/channels'
import type { DesktopApi } from '@shared/types'

export type ConnectionState = 'connecting' | 'open' | 'closed'

const wsUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

// ---- connection state (for a status pill later)
let state: ConnectionState = 'connecting'
const stateListeners = new Set<(s: ConnectionState) => void>()
const setState = (s: ConnectionState): void => {
  if (state === s) return
  state = s
  for (const cb of [...stateListeners]) cb(s)
}
export const connectionState = {
  get: (): ConnectionState => state,
  subscribe(cb: (s: ConnectionState) => void): () => void {
    stateListeners.add(cb)
    return () => stateListeners.delete(cb)
  },
}

// ---- pairing (separate short-lived socket)
/** Exchanges a pairing code for a device token. */
export function pair(code: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    let done = false
    const finish = (err?: Error, token?: string): void => {
      if (done) return
      done = true
      ws.close()
      if (err) reject(err)
      else resolve(token!)
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', code, name }))
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data))
      if (m.type === 'paired') finish(undefined, m.token)
      else if (m.type === 'error') finish(new Error(m.error))
    }
    ws.onerror = () => finish(new Error('Could not reach the desktop'))
    ws.onclose = () => finish(new Error('Connection closed'))
  })
}

// ---- main connection
let token = ''
let ws: WebSocket | null = null
let everOpen = false
let nextId = 1
let backoff = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const listeners = new Map<string, Set<(p: unknown) => void>>()
const openWaiters = new Set<() => void>()

function dispatchEvent(channel: string, payload: unknown): void {
  for (const cb of [...(listeners.get(channel) ?? [])]) cb(payload)
}

function rejectPending(msg: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(msg))
    pending.delete(id)
  }
}

/** Opens one authenticated socket; resolves with the hello, rejects with `.code` set when closed before it. */
function connectOnce(): Promise<{ platform: string; deviceId: string }> {
  return new Promise((resolve, reject) => {
    setState('connecting')
    const sock = new WebSocket(wsUrl())
    ws = sock
    let hello = false
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token }))
    sock.onmessage = (ev) => {
      let m: any
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (m.type === 'hello') {
        hello = true
        backoff = 1000
        setState('open')
        const wasOpen = everOpen
        everOpen = true
        resolve({ platform: m.platform, deviceId: m.deviceId })
        for (const w of [...openWaiters]) w()
        openWaiters.clear()
        if (wasOpen) dispatchEvent('mobile:reconnected', null)
      } else if (m.type === 'result') {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(m.error ?? 'Request failed'))
      } else if (m.type === 'event') {
        dispatchEvent(m.channel, m.payload)
      }
    }
    sock.onclose = (ev) => {
      if (ws === sock) ws = null
      setState('closed')
      rejectPending('Connection lost')
      if (ev.code === 4401) {
        // Token revoked or unknown.
        if (!hello) reject(Object.assign(new Error('Unauthorized'), { code: 4401 }))
        else {
          localStorage.removeItem('ccd.mobile.token')
          location.reload()
        }
        return
      }
      if (!hello) reject(Object.assign(new Error('Could not connect'), { code: ev.code }))
      scheduleReconnect()
    }
    sock.onerror = () => {
      /* onclose follows */
    }
  })
}

function scheduleReconnect(immediate = false): void {
  if (!everOpen) return // the initial connect() loop does its own retrying
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const delay = immediate ? 0 : backoff
  backoff = Math.min(backoff * 2, 10_000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    if (state === 'open' || state === 'connecting') return
    void connectOnce().catch(() => {
      /* retried by onclose */
    })
  }, delay)
}

/** Connects and authenticates. Retries network failures; rejects with code 4401 when the token is not accepted. */
export async function connect(t: string): Promise<{ platform: string; deviceId: string }> {
  token = t
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'closed') scheduleReconnect(true)
  })
  window.addEventListener('online', () => {
    if (state === 'closed') scheduleReconnect(true)
  })
  for (;;) {
    try {
      return await connectOnce()
    } catch (e) {
      if ((e as { code?: number }).code === 4401) throw e
      if (reconnectTimer) clearTimeout(reconnectTimer) // onclose scheduled one; this loop does the retrying
      reconnectTimer = undefined
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 10_000)
    }
  }
}

function whenOpen(): Promise<void> {
  if (state === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      openWaiters.delete(ok)
      reject(new Error('Not connected to the desktop'))
    }, 15_000)
    const ok = (): void => {
      clearTimeout(timer)
      resolve()
    }
    openWaiters.add(ok)
  })
}

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  await whenOpen()
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Request timed out'))
    }, 60_000)
    pending.set(id, { resolve, reject, timer })
    ws!.send(JSON.stringify({ id, type: 'invoke', channel, args }))
  })
}

function send(channel: string, args: unknown[]): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'send', channel, args }))
}

function subscribe(channel: string, cb: (p: unknown) => void): () => void {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(cb)
  return () => set!.delete(cb)
}

/** Builds window.desktop over the socket. Call after `connect` resolved. */
export function installDesktop(platform: string): void {
  const api: Record<string, unknown> = { platform, client: 'mobile' }
  for (const [name, ch] of Object.entries(INVOKES)) api[name] = (...a: unknown[]) => invoke(ch, a)
  for (const [name, ch] of Object.entries(SENDS)) api[name] = (...a: unknown[]) => send(ch, a)
  for (const [name, ch] of Object.entries(EVENTS)) api[name] = (cb: (p: unknown) => void) => subscribe(ch, cb)
  api.connectionState = () => state
  api.onConnectionState = (cb: (s: ConnectionState) => void) => connectionState.subscribe(cb)
  api.onReconnected = (cb: () => void) => subscribe('mobile:reconnected', cb)
  // Not available on the phone (the server refuses these channels too).
  const unavailable = 'Not available on the phone'
  Object.assign(api, {
    notify: () => Promise.resolve(),
    pickFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(),
    openInEditor: () => Promise.resolve(unavailable),
    openTerminal: () => Promise.resolve(unavailable),
    appTools: () => Promise.resolve({ editors: [], terminals: [] }),
    window: () => {},
    setTheme: () => {},
    checkUpdate: () => Promise.reject(new Error(unavailable)),
    authStatus: () => Promise.resolve({ state: 'unknown' }),
    authLogin: () => Promise.resolve({ error: unavailable }),
    ptyCreate: () => Promise.reject(new Error(unavailable)),
    ptyWrite: () => {},
    ptyResize: () => {},
    ptyKill: () => Promise.resolve(),
    ptyList: () => Promise.resolve([]),
    ptyReplay: () => Promise.resolve({ data: '', end: 0 }),
  })
  ;(window as unknown as { desktop: DesktopApi }).desktop = api as unknown as DesktopApi
}
