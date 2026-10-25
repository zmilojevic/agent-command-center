import { spawn } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import type { LaunchTools } from '../shared/types'

interface EditorDef {
  id: string
  label: string
  /** argv (after the binary) to open a file, optionally at a line. */
  file: (path: string, line?: number) => string[]
  dir: (dir: string) => string[]
}
interface TerminalDef {
  id: string
  label: string
  args: (dir: string) => string[]
}

const at = (p: string, line?: number): string => (line && line > 0 ? `${p}:${line}` : p)

export const EDITORS: EditorDef[] = [
  { id: 'subl', label: 'Sublime Text', file: (p, l) => [at(p, l)], dir: (d) => [d] },
  { id: 'code', label: 'VS Code', file: (p, l) => ['-g', at(p, l)], dir: (d) => [d] },
  { id: 'zed', label: 'Zed', file: (p, l) => [at(p, l)], dir: (d) => [d] },
  { id: 'cursor', label: 'Cursor', file: (p, l) => ['-g', at(p, l)], dir: (d) => [d] },
  { id: 'idea', label: 'IntelliJ IDEA', file: (p, l) => (l && l > 0 ? ['--line', String(l), p] : [p]), dir: (d) => [d] },
  { id: 'codium', label: 'VSCodium', file: (p, l) => ['-g', at(p, l)], dir: (d) => [d] },
]

export const TERMINALS: TerminalDef[] = [
  { id: 'kitty', label: 'kitty', args: (d) => ['--directory', d] },
  { id: 'alacritty', label: 'Alacritty', args: (d) => ['--working-directory', d] },
  { id: 'foot', label: 'foot', args: (d) => ['-D', d] },
  { id: 'ghostty', label: 'Ghostty', args: (d) => [`--working-directory=${d}`] },
  { id: 'wezterm', label: 'WezTerm', args: (d) => ['start', '--cwd', d] },
  { id: 'konsole', label: 'Konsole', args: (d) => ['--workdir', d] },
  { id: 'gnome-terminal', label: 'GNOME Terminal', args: (d) => [`--working-directory=${d}`] },
]

/** A .desktop launch can have a short PATH, so the usual user/system bin dirs are always scanned too. */
function searchDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const d of [join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin']) if (!dirs.includes(d)) dirs.push(d)
  return dirs
}

async function findBinary(name: string): Promise<string | null> {
  for (const d of searchDirs()) {
    const p = join(d, name)
    try {
      await access(p, constants.X_OK)
      if ((await stat(p)).isFile()) return p
    } catch {
      /* not here */
    }
  }
  return null
}

async function available<T extends { id: string }>(defs: T[]): Promise<(T & { bin: string })[]> {
  const found = await Promise.all(defs.map(async (d) => ({ d, bin: await findBinary(d.id) })))
  return found.filter((f) => f.bin).map((f) => ({ ...f.d, bin: f.bin! }))
}

export async function launchTools(): Promise<LaunchTools> {
  const [editors, terminals] = await Promise.all([available(EDITORS), available(TERMINALS)])
  return {
    editors: editors.map((e) => ({ id: e.id, label: e.label })),
    terminals: terminals.map((t) => ({ id: t.id, label: t.label })),
  }
}

function detach(bin: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((done) => {
    try {
      const p = spawn(bin, args, { detached: true, stdio: 'ignore', cwd })
      p.on('error', (e) => done(e.message))
      p.on('spawn', () => {
        p.unref()
        done(null)
      })
    } catch (e) {
      done(e instanceof Error ? e.message : String(e))
    }
  })
}

async function checkAbs(path: string): Promise<{ error: string } | { isDir: boolean }> {
  if (!path || !isAbsolute(path)) return { error: 'Path must be absolute' }
  try {
    return { isDir: (await stat(path)).isDirectory() }
  } catch {
    return { error: `Not found: ${path}` }
  }
}

/** Open a file (at `line`) or folder in the chosen editor; undefined id = first detected, else the system handler. */
export async function openInEditor(path: string, line?: number, editorId?: string): Promise<string | null> {
  const c = await checkAbs(path)
  if ('error' in c) return c.error
  const list = await available(EDITORS)
  const ed = (editorId && editorId !== 'system' ? list.find((e) => e.id === editorId) : undefined) ?? (editorId === 'system' ? undefined : list[0])
  if (!ed) return (await shell.openPath(path)) || null
  return detach(ed.bin, c.isDir ? ed.dir(path) : ed.file(path, line))
}

export async function openTerminal(dir: string, terminalId?: string): Promise<string | null> {
  const c = await checkAbs(dir)
  if ('error' in c) return c.error
  const list = await available(TERMINALS)
  const t = (terminalId ? list.find((x) => x.id === terminalId) : undefined) ?? list[0]
  if (!t) return 'No supported terminal found'
  return detach(t.bin, t.args(dir), dir)
}
