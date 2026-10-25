export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** Display name of a project: the custom name if one was set, else the folder name. */
export function projectName(names: Record<string, string>, cwd: string): string {
  return names[cwd] || basename(cwd)
}

export function shortPath(p: string, home?: string): string {
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.round(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

/** Context window to assume before the CLI reports the real one. */
export function defaultContextWindow(model?: string): number {
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (/fable|mythos|opus-(5|4-[678])|sonnet-(5|4-6)|haiku-5/.test(m)) return 1_000_000
  return 200_000
}

export function modelLabel(id?: string): string {
  if (!id || id === 'default') return 'Default model'
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (m) {
    const name = m[1][0].toUpperCase() + m[1].slice(1)
    return `${name} ${m[2]}${m[3] ? '.' + m[3] : ''}`
  }
  return id[0].toUpperCase() + id.slice(1)
}

/** Whole-second elapsed time for live counters: "8s", "2m 05s", "1h 03m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const PATH_EXTS =
  'ts tsx js jsx mjs cjs json jsonl md css scss html py rs go java kt c h cpp hpp sh fish zsh bash toml yaml yml lock txt svg png jpg jpeg gif webp log conf ini env sql xml vue rb php lua'.split(' ')
const PATH_EXT_RE = new RegExp(`\\.(?:${PATH_EXTS.join('|')})(?::\\d+(?::\\d+)?)?$`)

// Heuristic for inline code spans that name a file or directory (tints them like paths).
export function looksLikePath(s: string): boolean {
  const t = s.trim()
  if (!t || /[\s()=<>{},;'"`]/.test(t)) return false
  return t.startsWith('/') || t.startsWith('~/') || t.includes('/') || PATH_EXT_RE.test(t)
}

/** A chat cwd inside `<repo>/.claude/worktrees/<name>` belongs to the project at `<repo>`. */
export function worktreeOf(cwd: string): { root: string; name: string } | null {
  const m = cwd.match(/^(.*)\/\.claude\/worktrees\/([^/]+)$/)
  return m && m[1] ? { root: m[1], name: m[2] } : null
}

export function projectRoot(cwd: string): string {
  return worktreeOf(cwd)?.root ?? cwd
}
