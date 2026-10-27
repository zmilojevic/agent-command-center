import { app, net } from 'electron'
import type { UpdateInfo } from '../shared/types'

const URL = 'https://api.github.com/repos/zmilojevic/hearth/releases/latest'
const TTL = 6 * 60 * 60 * 1000

let cache: { at: number; info: UpdateInfo } | null = null

function parts(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0)
}

function isNewer(latest: string, current: string): boolean {
  const a = parts(latest)
  const b = parts(current)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Looks up the latest GitHub release; never throws, only successful answers are cached (6 h). */
export async function checkUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion()
  if (cache && Date.now() - cache.at < TTL) return { ...cache.info, current }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const res = await net.fetch(URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Hearth/${current}` },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const j = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!j.tag_name) throw new Error('No release found')
    const latest = j.tag_name.replace(/^v/i, '')
    const info: UpdateInfo = { current, latest, url: j.html_url, newer: isNewer(latest, current) }
    cache = { at: Date.now(), info }
    return info
  } catch (e) {
    return { current, newer: false, error: ctl.signal.aborted ? 'Timed out' : e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}
