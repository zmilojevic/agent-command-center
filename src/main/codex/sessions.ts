import type { SessionMeta, SessionSummary, TranscriptMessage } from '../../shared/types'
import { codexBinary, type CodexServer } from './appServer'
import type { Thread } from './protocol'
import { threadToTranscript } from './translate'

/**
 * Ids of Codex threads seen so far (listed or started). Session-id routing in index.ts: an explicit `engine` argument wins,
 * otherwise an id in this set is a Codex thread.
 */
const codexIds = new Set<string>()
const metaById = new Map<string, SessionMeta>()
let listCache: { at: number; rows: SessionSummary[] } | undefined
let listing: Promise<SessionSummary[]> | undefined

const LIST_TTL_MS = 3000
const LIST_LIMIT = 300
const PAGE = 100

export const rememberCodexId = (id: string): void => void codexIds.add(id)
export const isCodexId = (id: string): boolean => codexIds.has(id)

/** Drop the cached list (the Codex session files changed). */
export function invalidateCodexList(): void {
  listCache = undefined
}

function metaOf(t: Thread): SessionMeta {
  return {
    sessionId: t.id,
    model: t.model ?? undefined,
    effort: t.reasoningEffort ?? undefined,
    lastAt: t.updatedAt * 1000,
    gitBranch: t.gitInfo?.branch ?? undefined,
    assistantTurns: 0,
  }
}

function summaryOf(t: Thread): SessionSummary {
  const preview = (t.preview ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    sessionId: t.id,
    summary: t.name || preview || 'Codex chat',
    customTitle: t.name || undefined,
    firstPrompt: preview || undefined,
    lastModified: t.updatedAt * 1000,
    createdAt: t.createdAt * 1000,
    cwd: t.cwd,
    gitBranch: t.gitInfo?.branch ?? undefined,
    engine: 'codex',
  }
}

/** Newest Codex threads (CLI, IDE and app-server sources). Never throws: any failure is an empty list. Cached for a few seconds. */
export function listCodexSessions(server: CodexServer, log: (s: string) => void): Promise<SessionSummary[]> {
  if (!codexBinary()) return Promise.resolve([])
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return Promise.resolve(listCache.rows)
  if (listing) return listing
  listing = (async () => {
    try {
      const rows: SessionSummary[] = []
      let cursor: string | null = null
      while (rows.length < LIST_LIMIT) {
        const res: { data: Thread[]; nextCursor: string | null } = await server.request('thread/list', {
          limit: PAGE,
          cursor,
          sortKey: 'updated_at',
          sourceKinds: ['cli', 'vscode', 'appServer'],
        })
        for (const t of res.data) {
          if (t.ephemeral || !t.cwd) continue
          codexIds.add(t.id)
          metaById.set(t.id, metaOf(t))
          rows.push(summaryOf(t))
        }
        cursor = res.nextCursor
        if (!cursor || res.data.length === 0) break
      }
      listCache = { at: Date.now(), rows }
      return rows
    } catch (e) {
      log(`codex sessions: ${e instanceof Error ? e.message : String(e)}`)
      return []
    } finally {
      listing = undefined
    }
  })()
  return listing
}

export async function codexMessages(server: CodexServer, threadId: string): Promise<TranscriptMessage[]> {
  const res = await server.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: true })
  return threadToTranscript(res.thread)
}

export async function codexSessionMeta(server: CodexServer, threadId: string): Promise<SessionMeta | null> {
  const hit = metaById.get(threadId)
  if (hit) return hit
  try {
    const res = await server.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: false })
    const m = metaOf(res.thread)
    metaById.set(threadId, m)
    return m
  } catch {
    return null
  }
}

export async function codexRename(server: CodexServer, threadId: string, name: string): Promise<void> {
  await server.request('thread/name/set', { threadId, name })
  invalidateCodexList()
  metaById.delete(threadId)
}

export async function codexDelete(server: CodexServer, threadId: string): Promise<void> {
  await server.request('thread/delete', { threadId })
  codexIds.delete(threadId)
  metaById.delete(threadId)
  invalidateCodexList()
}
