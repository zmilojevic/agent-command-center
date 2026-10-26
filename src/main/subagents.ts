import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SubagentTranscript, TranscriptMessage } from '../shared/types'

const ID_RE = /^[A-Za-z0-9_-]+$/

/** `<sessionId>/<toolUseId>` -> transcript path; rebuilt by rescanning the dir when a toolUseId is unknown. */
const pathCache = new Map<string, string>()
/** Parsed transcript per path, valid while mtime and size match. */
const parsed = new Map<string, { mtimeMs: number; size: number; result: SubagentTranscript }>()

async function locate(dir: string, key: string, toolUseId: string): Promise<string | null> {
  const cached = pathCache.get(key)
  if (cached) return cached
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let found: string | null = null
  for (const n of names) {
    if (!n.startsWith('agent-') || !n.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, n), 'utf8'))
      if (typeof meta?.toolUseId !== 'string') continue
      const file = join(dir, n.slice(0, -'.meta.json'.length) + '.jsonl')
      pathCache.set(`${key.slice(0, key.indexOf('/'))}/${meta.toolUseId}`, file)
      if (meta.toolUseId === toolUseId) found = file
    } catch {
      /* unreadable meta: skip */
    }
  }
  return found
}

export async function readSubagentTranscript(
  cwd: string,
  sessionId: string,
  toolUseId: string,
  sinceMtime?: number,
): Promise<SubagentTranscript> {
  if (!ID_RE.test(sessionId) || !ID_RE.test(toolUseId) || typeof cwd !== 'string' || !cwd) return { found: false }
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), sessionId, 'subagents')
  const file = await locate(dir, `${sessionId}/${toolUseId}`, toolUseId)
  if (!file) return { found: false }
  let st
  try {
    st = await stat(file)
  } catch {
    pathCache.delete(`${sessionId}/${toolUseId}`)
    return { found: false }
  }
  if (sinceMtime !== undefined && sinceMtime === st.mtimeMs) return { found: true, unchanged: true, mtimeMs: st.mtimeMs }
  const hit = parsed.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { found: false }
  }
  const messages: TranscriptMessage[] = []
  let model: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if ((o?.type !== 'user' && o?.type !== 'assistant') || !o.message || typeof o.uuid !== 'string') continue
    messages.push({ type: o.type, uuid: o.uuid, session_id: sessionId, message: o.message, parent_tool_use_id: null, parent_agent_id: null })
    if (o.type === 'assistant' && typeof o.message.model === 'string' && o.message.model !== '<synthetic>') model = o.message.model
  }
  const result: SubagentTranscript = { found: true, mtimeMs: st.mtimeMs, messages, model }
  try {
    const meta = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    if (typeof meta?.agentType === 'string') result.agentType = meta.agentType
    if (typeof meta?.description === 'string') result.description = meta.description
  } catch {
    /* no meta */
  }
  parsed.set(file, { mtimeMs: st.mtimeMs, size: st.size, result })
  return result
}
