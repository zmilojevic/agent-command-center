import pty from 'node-pty'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { PtyInfo } from '../shared/types'

const RING_MAX = 200 * 1024
const BATCH_MS = 10

interface Term {
  id: string
  cwd: string
  shell: string
  proc: pty.IPty
  exited: boolean
  code?: number
  /** Last RING_MAX chars of output, replayed when the renderer re-attaches after a reload. */
  ring: string
  /** Total chars ever emitted for this terminal; lets the renderer drop chunks already covered by a replay. */
  total: number
  pending: string
  timer: NodeJS.Timeout | null
}

/** Integrated terminals: one node-pty process per id, output batched to the renderer. */
export class PtyManager {
  private terms = new Map<string, Term>()
  private seq = 0

  constructor(private emit: (channel: string, payload: unknown) => void) {}

  create(cwd: string, cols: number, rows: number): string {
    const shell = process.env.SHELL || '/bin/bash'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('CCD_') || k === 'CHROME_DESKTOP') continue
      env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    const dir = cwd && existsSync(cwd) ? cwd : homedir()
    const proc = pty.spawn(shell, [], { name: 'xterm-256color', cols: Math.max(2, cols), rows: Math.max(1, rows), cwd: dir, env })
    const id = `pty-${++this.seq}`
    const t: Term = { id, cwd, shell: basename(shell), proc, exited: false, ring: '', total: 0, pending: '', timer: null }
    this.terms.set(id, t)
    proc.onData((d) => {
      t.ring += d
      if (t.ring.length > RING_MAX) t.ring = t.ring.slice(t.ring.length - RING_MAX)
      t.total += d.length
      t.pending += d
      if (!t.timer) t.timer = setTimeout(() => this.flush(t), BATCH_MS)
    })
    proc.onExit(({ exitCode }) => {
      this.flush(t)
      t.exited = true
      t.code = exitCode
      this.emit('pty:exit', { id, code: exitCode })
    })
    return id
  }

  private flush(t: Term): void {
    if (t.timer) clearTimeout(t.timer)
    t.timer = null
    if (!t.pending) return
    const data = t.pending
    t.pending = ''
    this.emit('pty:data', { id: t.id, data, end: t.total })
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id)
    if (t && !t.exited) t.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (!t || t.exited || cols < 2 || rows < 1) return
    try {
      t.proc.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* process already gone */
    }
  }

  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    if (t.timer) clearTimeout(t.timer)
    if (!t.exited) {
      try {
        t.proc.kill()
      } catch {
        /* already dead */
      }
    }
  }

  list(): PtyInfo[] {
    return [...this.terms.values()].map((t) => ({ id: t.id, cwd: t.cwd, pid: t.proc.pid, shell: t.shell, exited: t.exited, code: t.code }))
  }

  /** Buffered output so far; pending output is flushed first so every later `pty:data` chunk has `end` > the returned `end`. */
  replay(id: string): { data: string; end: number } {
    const t = this.terms.get(id)
    if (!t) return { data: '', end: 0 }
    this.flush(t)
    return { data: t.ring, end: t.total }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}
