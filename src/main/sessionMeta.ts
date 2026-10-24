import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionMeta } from '../shared/types'

const TAIL_BYTES = 512 * 1024
const cache = new Map<string, { mtimeMs: number; meta: SessionMeta }>()

/** Claude Code stores transcripts under ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>. */
export function transcriptPath(sessionId: string, cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
}

/** Reads the tail of a transcript and derives model, effort, context size and cache TTL from the last assistant turn. */
export async function readSessionMeta(sessionId: string, cwd: string): Promise<SessionMeta | null> {
  const file = transcriptPath(sessionId, cwd)
  let st
  try {
    st = await stat(file)
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta

  const fh = await open(file, 'r')
  try {
    const len = Math.min(st.size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    const lines = buf.toString('utf8').split('\n')
    if (st.size > TAIL_BYTES) lines.shift() // first line may be cut mid-way
    const meta: SessionMeta = { sessionId, assistantTurns: 0 }
    let lastAssistant: any = null
    let ttlMs: number | undefined
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"type":"assistant"')) continue
      let e: any
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e.type !== 'assistant' || e.isSidechain || !e.message?.usage) continue
      meta.assistantTurns++
      if (!lastAssistant) lastAssistant = e
      // Only turns that wrote to the cache say which tier (5 min or 1 h) the session uses.
      if (ttlMs === undefined) {
        const cc = e.message.usage.cache_creation
        const wrote1h = cc?.ephemeral_1h_input_tokens ?? 0
        const wrote5m = cc?.ephemeral_5m_input_tokens ?? 0
        if (wrote1h > 0) ttlMs = 3600_000
        else if (wrote5m > 0) ttlMs = 300_000
      }
      if (ttlMs !== undefined && lastAssistant) break
    }
    if (lastAssistant) {
      const u = lastAssistant.message.usage
      meta.model = lastAssistant.message.model ?? lastAssistant.requestedModel
      meta.effort = lastAssistant.perTurnEffort ?? lastAssistant.effort ?? undefined
      meta.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      meta.outputTokens = u.output_tokens ?? 0
      meta.lastAt = lastAssistant.timestamp ? Date.parse(lastAssistant.timestamp) : st.mtimeMs
      meta.cacheTtlMs = ttlMs ?? 3600_000
      meta.gitBranch = lastAssistant.gitBranch
      meta.version = lastAssistant.version
    }
    cache.set(file, { mtimeMs: st.mtimeMs, meta })
    return meta
  } finally {
    await fh.close()
  }
}
