import { useStore, isGeneral } from './store'

let homeCache = ''
async function home(): Promise<string> {
  if (!homeCache) homeCache = await window.desktop.homeDir()
  return homeCache
}

/** Makes `p` absolute: `~/` against the home dir, relative paths against `cwd`. */
export async function absolutePath(p: string, cwd: string): Promise<string> {
  if (p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p)) return p
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return (await home()) + p.slice(1)
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${p.replace(/^\.[\\/]/, '')}`
}

/** Splits a `path:line[:col]` suffix off. */
export function splitLine(s: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(s)
  return m ? { path: m[1], line: Number(m[2]) } : { path: s }
}

function report(err: string | null): void {
  if (err) console.warn('[open]', err)
}

/** Opens a file (relative paths resolve against `cwd`) in the preferred editor. */
export async function openFileInEditor(path: string, cwd: string, line?: number): Promise<void> {
  report(await window.desktop.openInEditor(await absolutePath(path, cwd), line, useStore.getState().editor || undefined))
}

export async function openFolderInEditor(dir: string): Promise<void> {
  report(await window.desktop.openInEditor(dir, undefined, useStore.getState().editor || undefined))
}

export async function openTerminalAt(dir: string): Promise<void> {
  report(await window.desktop.openTerminal(dir, useStore.getState().terminal || undefined))
}

/** The active chat's folder when it is a project chat, else undefined. */
export function activeProjectCwd(chatId?: string): string | undefined {
  const s = useStore.getState()
  const c = s.chats[chatId ?? s.activeChatId ?? '']
  return c && !isGeneral(c.cwd) ? c.cwd : undefined
}
