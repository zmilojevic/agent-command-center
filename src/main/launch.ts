import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import type { LaunchTools } from '../shared/types'

type Os = 'linux' | 'darwin' | 'win32'
const ALL_OS: Os[] = ['linux', 'darwin', 'win32']
const os = process.platform as Os

interface ToolBase {
  id: string
  label: string
  /** Platforms the entry is offered on (default: linux only, like the original lists). */
  os?: Os[]
  /** CLI names looked up on PATH (default: [id]). */
  names?: Partial<Record<Os, string[]>>
  /** Fixed locations of the binary, e.g. inside macOS app bundles. */
  fixed?: Partial<Record<Os, string[]>>
  /** macOS .app bundles: used when no binary was found; launched through `open`. */
  apps?: string[]
}
interface EditorDef extends ToolBase {
  /** argv (after the binary) to open a file, optionally at a line. */
  file: (path: string, line?: number) => string[]
  dir: (dir: string) => string[]
}
interface TerminalDef extends ToolBase {
  args: (dir: string) => string[]
}

const at = (p: string, line?: number): string => (line && line > 0 ? `${p}:${line}` : p)

/** macOS app bundle paths in /Applications and ~/Applications. */
const bundle = (rel: string): string[] => [join('/Applications', rel), join(homedir(), 'Applications', rel)]

export const EDITORS: EditorDef[] = [
  {
    id: 'subl',
    label: 'Sublime Text',
    os: ALL_OS,
    fixed: { darwin: bundle('Sublime Text.app/Contents/SharedSupport/bin/subl') },
    file: (p, l) => [at(p, l)],
    dir: (d) => [d],
  },
  {
    id: 'code',
    label: 'VS Code',
    os: ALL_OS,
    fixed: { darwin: bundle('Visual Studio Code.app/Contents/Resources/app/bin/code') },
    file: (p, l) => ['-g', at(p, l)],
    dir: (d) => [d],
  },
  {
    id: 'zed',
    label: 'Zed',
    os: ALL_OS,
    fixed: { darwin: bundle('Zed.app/Contents/MacOS/cli') },
    file: (p, l) => [at(p, l)],
    dir: (d) => [d],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    os: ALL_OS,
    fixed: { darwin: bundle('Cursor.app/Contents/Resources/app/bin/cursor') },
    file: (p, l) => ['-g', at(p, l)],
    dir: (d) => [d],
  },
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    os: ['linux', 'darwin'],
    apps: [...bundle('IntelliJ IDEA.app'), ...bundle('IntelliJ IDEA CE.app')],
    file: (p, l) => (l && l > 0 ? ['--line', String(l), p] : [p]),
    dir: (d) => [d],
  },
  {
    id: 'codium',
    label: 'VSCodium',
    os: ALL_OS,
    fixed: { darwin: bundle('VSCodium.app/Contents/Resources/app/bin/codium') },
    file: (p, l) => ['-g', at(p, l)],
    dir: (d) => [d],
  },
]

export const TERMINALS: TerminalDef[] = [
  { id: 'kitty', label: 'kitty', os: ['linux', 'darwin'], args: (d) => ['--directory', d] },
  { id: 'alacritty', label: 'Alacritty', os: ['linux', 'darwin'], args: (d) => ['--working-directory', d] },
  { id: 'foot', label: 'foot', args: (d) => ['-D', d] },
  {
    id: 'ghostty',
    label: 'Ghostty',
    os: ['linux', 'darwin'],
    apps: ['/Applications/Ghostty.app'],
    args: (d) => [`--working-directory=${d}`],
  },
  { id: 'wezterm', label: 'WezTerm', os: ['linux', 'darwin'], args: (d) => ['start', '--cwd', d] },
  { id: 'konsole', label: 'Konsole', args: (d) => ['--workdir', d] },
  { id: 'gnome-terminal', label: 'GNOME Terminal', args: (d) => [`--working-directory=${d}`] },
  {
    id: 'terminal',
    label: 'Terminal',
    os: ['darwin'],
    apps: ['/System/Applications/Utilities/Terminal.app'],
    args: (d) => [d],
  },
  { id: 'iterm', label: 'iTerm', os: ['darwin'], apps: ['/Applications/iTerm.app'], args: (d) => [d] },
  { id: 'wt', label: 'Windows Terminal', os: ['win32'], names: { win32: ['wt'] }, args: (d) => ['-d', d] },
  { id: 'pwsh', label: 'PowerShell 7', os: ['win32'], names: { win32: ['pwsh'] }, args: () => ['-NoExit'] },
  { id: 'powershell', label: 'Windows PowerShell', os: ['win32'], names: { win32: ['powershell'] }, args: () => ['-NoExit'] },
  { id: 'cmd', label: 'Command Prompt', os: ['win32'], names: { win32: ['cmd'] }, args: () => ['/k'] },
]

/** A .desktop launch can have a short PATH, so the usual user/system bin dirs are always scanned too. */
function searchDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra =
    os === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin']
      : os === 'win32'
        ? []
        : [join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin']
  for (const d of extra) if (!dirs.includes(d)) dirs.push(d)
  return dirs
}

const WIN_EXTS = ['.exe', '.cmd', '.bat']

async function isFile(p: string, exec: boolean): Promise<boolean> {
  try {
    if (exec) await access(p, constants.X_OK)
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function findBinary(name: string): Promise<string | null> {
  for (const d of searchDirs()) {
    if (os === 'win32') {
      for (const ext of WIN_EXTS) {
        const p = join(d, name + ext)
        if (await isFile(p, false)) return p
      }
    } else {
      const p = join(d, name)
      if (await isFile(p, true)) return p
    }
  }
  return null
}

type Found<T> = T & { bin: string; /** argv inserted before the tool's own args */ pre: string[]; viaOpen: boolean }

async function resolveTool(d: ToolBase): Promise<{ bin: string; pre: string[]; viaOpen: boolean } | null> {
  for (const n of d.names?.[os] ?? [d.id]) {
    const bin = await findBinary(n)
    if (bin) return { bin, pre: [], viaOpen: false }
  }
  for (const p of d.fixed?.[os] ?? []) if (await isFile(p, true)) return { bin: p, pre: [], viaOpen: false }
  if (os === 'darwin') {
    for (const app of d.apps ?? []) if (existsSync(app)) return { bin: '/usr/bin/open', pre: [app], viaOpen: true }
  }
  return null
}

async function available<T extends ToolBase>(defs: T[]): Promise<Found<T>[]> {
  const list = defs.filter((d) => (d.os ?? ['linux']).includes(os))
  const found = await Promise.all(list.map(async (d) => ({ d, r: await resolveTool(d) })))
  return found.filter((f) => f.r).map((f) => ({ ...f.d, ...f.r! }))
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
      let opts: SpawnOptions = { detached: true, stdio: 'ignore', cwd }
      if (os === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
        // Node refuses to spawn batch files without a shell (EINVAL); go through cmd.exe with explicit quoting.
        args = ['/d', '/s', '/c', '"' + [bin, ...args].map((a) => '"' + a + '"').join(' ') + '"']
        bin = process.env.ComSpec || 'cmd.exe'
        opts = { ...opts, windowsVerbatimArguments: true, windowsHide: true }
      }
      const p = spawn(bin, args, opts)
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
  const args = c.isDir ? ed.dir(path) : ed.file(path, line)
  // IntelliJ without a CLI: `open -na <app> --args ...`
  return detach(ed.bin, ed.viaOpen ? ['-na', ...ed.pre, '--args', ...args] : args)
}

export async function openTerminal(dir: string, terminalId?: string): Promise<string | null> {
  const c = await checkAbs(dir)
  if ('error' in c) return c.error
  const list = await available(TERMINALS)
  const t = (terminalId ? list.find((x) => x.id === terminalId) : undefined) ?? list[0]
  if (!t) return 'No supported terminal found'
  // macOS apps without a CLI: `open -a <app> <dir>`
  if (t.viaOpen) return detach(t.bin, ['-a', ...t.pre, dir], dir)
  return detach(t.bin, t.args(dir), dir)
}
