import pty from 'node-pty'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, delimiter } from 'node:path'
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
  /** Login ptys run `claude auth login`; they are never listed as terminals. */
  hidden: boolean
}

function pickShell(): { shell: string; args: string[] } {
  if (process.platform === 'darwin') return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'] }
  if (process.platform === 'win32') {
    for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const p = join(d, 'pwsh.exe')
      if (existsSync(p)) return { shell: p, args: [] }
    }
    return { shell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: [] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: [] }
}

/** Integrated terminals: one node-pty process per id, output batched to the renderer. */
export class PtyManager {
  private terms = new Map<string, Term>()
  private seq = 0

  constructor(private emit: (channel: string, payload: unknown) => void) {}

  create(cwd: string, cols: number, rows: number, run?: { command: string; args: string[]; kind: 'login' }): string {
    const { shell, args } = run ? { shell: run.command, args: run.args } : pickShell()
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('CCD_') || k === 'CHROME_DESKTOP') continue
      env[k] = v
    }
    if (process.platform !== 'win32') {
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'
    }
    const dir = cwd && existsSync(cwd) ? cwd : homedir()
    const proc = pty.spawn(shell, args, { name: 'xterm-256color', cols: Math.max(2, cols), rows: Math.max(1, rows), cwd: dir, env })
    const id = `pty-${++this.seq}`
    const t: Term = { id, cwd, shell: basename(shell).replace(/\.exe$/i, ''), proc, exited: false, ring: '', total: 0, pending: '', timer: null, hidden: run?.kind === 'login' }
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
    return [...this.terms.values()].filter((t) => !t.hidden).map((t) => ({ id: t.id, cwd: t.cwd, pid: t.proc.pid, shell: t.shell, exited: t.exited, code: t.code }))
  }

  /** True when the shell is the foreground process of its tty (idle prompt, no program running). */
  isIdle(id: string): boolean {
    const t = this.terms.get(id)
    if (!t || t.exited) return false
    try {
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${t.proc.pid}/stat`, 'utf8')
        // comm (field 2) may contain spaces/parens: parse after the last ')'; then state, ppid, pgrp, session, tty_nr, tpgid
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return Number(f[5]) === t.proc.pid
      }
      if (process.platform === 'darwin') return basename(t.proc.process) === t.shell
      return false
    } catch {
      return false
    }
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
