import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { SessionSummary, PermissionRequest, PermissionMode, ModelChoice, EffortLevel, StartChatOptions, SessionMeta, ChatContext, SlashCommandInfo, AgentChoice, ContentBlock, UserContent, Theme, GitChanges } from '@shared/types'
import { applySdkMessage, applyTranscript, emptyModel, findTool, type ChatModel, type Block } from './reduce'
import type { ImageAttachment } from './images'
import { basename } from './util'

export interface QueuedMessage {
  id: string
  text: string
  images: ImageAttachment[]
}

/** A note anchored to a diff line in the changes panel, sent to Claude in one batch. */
export interface ReviewComment {
  id: string
  path: string
  line: number
  side: 'old' | 'new'
  lineText: string
  text: string
}

/** Keep-warm gives up after this long without a real turn. */
export const KEEP_WARM_MAX_IDLE_MS = 12 * 3_600_000

export type ChangesEntry = GitChanges & { loading?: boolean; fetchedAt?: number }

export interface Chat extends ChatModel {
  chatId: string
  title: string
  cwd: string
  pending: PermissionRequest[]
  models: ModelChoice[]
  requestedModel?: string
  /** 'default' = the model's own default effort. */
  requestedEffort?: string
  requestedMode: PermissionMode
  transcriptLoaded: boolean
  context?: ChatContext
  closed?: boolean
  /** When this chat's current session started; used for the sidebar placeholder row before the transcript exists. */
  createdAt?: number
  draft: string
  unread: boolean
  /** From supportedCommands(); empty until the CLI answers. */
  commands: SlashCommandInfo[]
  /** From supportedAgents(); empty until the CLI answers. */
  agents: AgentChoice[]
  /** Images attached to the draft. */
  attachments: ImageAttachment[]
  /** Messages typed while the chat was busy, sent one per finished turn. */
  queue: QueuedMessage[]
  /** Review comments on the diff, not yet sent; not persisted. */
  comments: ReviewComment[]
  /** Generation of the current CLI runner; events from older runners are ignored. */
  gen?: number
}

function chatExtras(): Pick<Chat, 'commands' | 'agents' | 'attachments' | 'queue' | 'comments'> {
  return { commands: [], agents: [], attachments: [], queue: [], comments: [] }
}

interface State {
  sessions: SessionSummary[]
  sessionsLoaded: boolean
  meta: Record<string, SessionMeta>
  modelMax: Record<string, number>
  chats: Record<string, Chat>
  /** Open chats in opening order (persisted for restore; there is no tab strip). */
  tabs: string[]
  /** Open chats, most recently activated first. */
  recent: string[]
  activeChatId: string | null
  showNewDialog: boolean
  newDialogCwd: string | null
  /** Folder of the general (non-project) chats; '' until the main process has told us. */
  generalDir: string
  pinnedProjects: string[]
  projectOrder: string[]
  /** Custom display names (cwd -> name); the folder on disk is never renamed. */
  projectNames: Record<string, string>
  /** Session ids replaced by a /clear: transcript kept on disk, never listed in the sidebar. */
  hiddenSessions: string[]
  /** Sidebar sort-time override for a session that replaced a cleared one (keeps the row's slot). */
  sessionSortTime: Record<string, number>
  /** Session ids whose prompt cache is kept warm while idle. */
  keepWarm: string[]
  /** Per session: when the last keep-alive request started (cache refreshed). */
  warmedAt: Record<string, number>
  /** Keep-alive requests in flight (not persisted). */
  warming: Record<string, true>
  /** Do not retry a failed keep-alive before this time (not persisted). */
  warmRetryAt: Record<string, number>
  search: string
  recentHours: number
  lastModel: string
  lastEffort: string
  lastMode: PermissionMode
  lastCwd: string
  notifications: boolean
  theme: Theme
  findOpen: boolean
  /** Git working-tree changes keyed by cwd. */
  changes: Record<string, ChangesEntry>
  changesOpen: boolean
  changesWidth: number
  sidebarWidth: number

  loadSessions(): Promise<void>
  restoreTabs(): Promise<void>
  loadMeta(items: { sessionId: string; cwd: string }[]): Promise<void>
  /** Open a session in a tab; `background` leaves the active chat alone (startup restore). */
  openSession(s: SessionSummary, fork?: boolean, background?: boolean): Promise<void>
  newChat(opts: { cwd: string; model: string; permissionMode: PermissionMode }): Promise<void>
  /** A general chat (no project folder) with the last-used model, effort and mode. */
  newGeneralChat(): Promise<void>
  activate(chatId: string | null): void
  closeTab(chatId: string): void
  clearChat(chatId: string): Promise<void>
  setKeepWarm(sessionId: string, on: boolean): void
  tickKeepWarm(): Promise<void>
  sendMessage(chatId: string, text: string, images?: ImageAttachment[], fromDraft?: boolean): Promise<void>
  /** Queue a message; fromDraft (default) also clears the composer. */
  enqueue(chatId: string, text: string, images: ImageAttachment[], fromDraft?: boolean): void
  removeQueued(chatId: string, id: string): void
  sendQueuedNow(chatId: string, id: string): Promise<void>
  addAttachments(chatId: string, images: ImageAttachment[]): void
  removeAttachment(chatId: string, id: string): void
  setNotifications(v: boolean): void
  setTheme(theme: Theme): void
  setFindOpen(v: boolean): void
  respond(chatId: string, requestId: string, response: Parameters<Window['desktop']['respond']>[2]): Promise<void>
  interrupt(chatId: string): Promise<void>
  setModel(chatId: string, model: string): Promise<void>
  setEffort(chatId: string, effort: string): Promise<void>
  setMode(chatId: string, mode: PermissionMode): Promise<void>
  setDraft(chatId: string, text: string): void
  setSearch(q: string): void
  setRecentHours(h: number): void
  toggleChanges(): void
  setChangesWidth(px: number): void
  setSidebarWidth(px: number): void
  refreshChanges(cwd: string): Promise<void>
  addComment(chatId: string, c: Omit<ReviewComment, 'id'>): void
  updateComment(chatId: string, id: string, text: string): void
  removeComment(chatId: string, id: string): void
  /** Send all review comments as one message (queued while busy) and clear them. */
  sendComments(chatId: string): void
  setShowNewDialog(v: boolean, cwd?: string): void
  pinProject(dir: string): void
  unpinProject(dir: string): void
  setProjectOrder(order: string[]): void
  renameSession(s: SessionSummary, title: string): Promise<void>
  deleteSession(s: SessionSummary): Promise<void>
  /** Close its chats, delete all its transcripts, forget pin and order. */
  removeProject(cwd: string): Promise<void>
  /** Display name only; empty or the folder name resets it. */
  renameProject(cwd: string, name: string): void
}

const prefs = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k)
      return v == null ? d : (JSON.parse(v) as T)
    } catch {
      return d
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* ignore */
    }
  },
}

// Stale pref: the sidebar can no longer be hidden.
try {
  localStorage.removeItem('sidebarOpen')
} catch {
  /* ignore */
}

// Move `d` in projectOrder to just after the last pinned project (front if none), persisting it.
function placeAfterPinned(s: { pinnedProjects: string[]; projectOrder: string[] }, d: string): void {
  const order = s.projectOrder.filter((c) => c !== d)
  let at = 0
  order.forEach((c, i) => {
    if (s.pinnedProjects.includes(c)) at = i + 1
  })
  order.splice(at, 0, d)
  s.projectOrder = order
  prefs.set('projectOrder', order)
}

function titleFor(s: SessionSummary): string {
  return s.customTitle || s.summary || s.firstPrompt || 'Untitled session'
}

/** True for the folder of the general chats (identity of a general chat is purely its cwd). */
export function isGeneral(cwd?: string): boolean {
  const dir = useStore.getState().generalDir
  return !!cwd && !!dir && cwd === dir
}

export const useStore = create<State>()(
  immer((set, get) => ({
    sessions: [],
    sessionsLoaded: false,
    meta: {},
    modelMax: {},
    chats: {},
    tabs: [],
    recent: [],
    activeChatId: null,
    showNewDialog: false,
    newDialogCwd: null,
    generalDir: '',
    pinnedProjects: prefs.get<string[]>('pinnedProjects', []),
    projectOrder: prefs.get<string[]>('projectOrder', []),
    projectNames: prefs.get<Record<string, string>>('projectNames', {}),
    hiddenSessions: prefs.get<string[]>('hiddenSessions', []),
    sessionSortTime: prefs.get<Record<string, number>>('sessionSortTime', {}),
    keepWarm: prefs.get<string[]>('keepWarm', []),
    warmedAt: prefs.get<Record<string, number>>('warmedAt', {}),
    warming: {},
    warmRetryAt: {},
    changes: {},
    changesOpen: prefs.get('changesOpen', false),
    changesWidth: prefs.get('changesWidth', 520),
    sidebarWidth: prefs.get('sidebarWidth', 390),
    search: '',
    recentHours: prefs.get('recentHours', 14),
    lastModel: prefs.get('lastModel', 'default'),
    lastEffort: prefs.get('lastEffort', 'default'),
    // Always start sessions with permissions bypassed (--dangerously-skip-permissions).
    lastMode: 'bypassPermissions' as PermissionMode,
    lastCwd: prefs.get('lastCwd', ''),
    notifications: prefs.get('notifications', true),
    theme: prefs.get<Theme>('theme', 'system'),
    findOpen: false,

    async loadSessions() {
      const sessions = await window.desktop.listSessions()
      set((s) => {
        s.sessions = sessions
        s.sessionsLoaded = true
        // Prune /clear bookkeeping against what is on disk (and open chats, whose new
        // session has no transcript yet); this runs only after a successful load.
        const disk = new Set(sessions.map((x) => x.sessionId))
        const open = new Set(Object.values(s.chats).filter((c) => !c.closed && c.sessionId).map((c) => c.sessionId as string))
        const hidden = s.hiddenSessions.filter((id) => disk.has(id))
        if (hidden.length !== s.hiddenSessions.length) {
          s.hiddenSessions = hidden
          prefs.set('hiddenSessions', hidden)
        }
        const keys = Object.keys(s.sessionSortTime)
        const live = keys.filter((id) => disk.has(id) || open.has(id))
        if (live.length !== keys.length) {
          for (const id of keys) if (!live.includes(id)) delete s.sessionSortTime[id]
          prefs.set('sessionSortTime', s.sessionSortTime)
        }
        const kw = s.keepWarm.filter((id) => disk.has(id) || open.has(id))
        if (kw.length !== s.keepWarm.length) {
          s.keepWarm = kw
          prefs.set('keepWarm', kw)
        }
        const wk = Object.keys(s.warmedAt)
        if (wk.some((id) => !disk.has(id) && !open.has(id))) {
          for (const id of wk) if (!disk.has(id) && !open.has(id)) delete s.warmedAt[id]
          prefs.set('warmedAt', s.warmedAt)
        }
        for (const c of Object.values(s.chats)) {
          const match = sessions.find((x) => x.sessionId === c.sessionId)
          if (match && !c.title.trim()) c.title = titleFor(match)
          if (match && match.customTitle) c.title = match.customTitle
        }
      })
    },

    async restoreTabs() {
      const saved = prefs.get<{ sessions: string[]; active: string | null }>('openTabs', { sessions: [], active: null })
      const list = get().sessions
      // Open in the background so a chat the user clicks meanwhile keeps the focus;
      // only the chat that was active before the restart gets activated, and only if
      // the user has not picked another one by then.
      for (const id of saved.sessions) {
        const sess = list.find((x) => x.sessionId === id)
        if (!sess) continue
        if (Object.values(get().chats).some((c) => c.sessionId === id && !c.closed)) continue
        await get().openSession(sess, false, true)
        if (id === saved.active && !get().activeChatId) {
          const chat = Object.values(get().chats).find((c) => c.sessionId === id && !c.closed)
          if (chat) get().activate(chat.chatId)
        }
      }
      tabsRestored = true
    },

    async loadMeta(items) {
      if (!items.length) return
      const metas = await window.desktop.getSessionMeta(items)
      set((s) => {
        for (const m of metas) s.meta[m.sessionId] = m
      })
    },

    async openSession(sess, fork = false, background = false) {
      const existing = Object.values(get().chats).find((c) => c.sessionId === sess.sessionId && !c.closed)
      if (existing && !fork) {
        if (!background) get().activate(existing.chatId)
        return
      }
      const chatId = crypto.randomUUID()
      const cwd = sess.cwd || (await window.desktop.homeDir())
      const mode = get().lastMode
      set((s) => {
        s.chats[chatId] = {
          ...emptyModel(),
          chatId,
          createdAt: Date.now(),
          title: fork ? `Fork of ${titleFor(sess)}` : titleFor(sess),
          cwd,
          sessionId: fork ? undefined : sess.sessionId,
          pending: [],
          models: [],
          requestedModel: get().lastModel,
          requestedEffort: get().lastEffort,
          requestedMode: mode,
          transcriptLoaded: false,
          draft: '',
          unread: false,
          ...chatExtras(),
        }
        s.tabs.push(chatId)
        if (background) {
          s.recent = [...s.recent.filter((x) => x !== chatId), chatId]
        } else {
          s.activeChatId = chatId
          s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
        }
      })
      const entries = await window.desktop.getMessages(sess.sessionId, sess.cwd)
      set((s) => {
        const c = s.chats[chatId]
        if (!c) return
        applyTranscript(c, entries)
        c.transcriptLoaded = true
      })
      const opts: StartChatOptions = { chatId, cwd, permissionMode: mode, resume: sess.sessionId, fork }
      if (get().lastModel !== 'default') opts.model = get().lastModel
      if (get().lastEffort !== 'default') opts.effort = get().lastEffort as EffortLevel
      await startRunner(chatId, opts)
      refreshAfterStart(chatId)
    },

    async newChat({ cwd, model, permissionMode }) {
      const chatId = crypto.randomUUID()
      prefs.set('lastModel', model)
      prefs.set('lastMode', permissionMode)
      prefs.set('lastCwd', cwd)
      set((s) => {
        s.lastModel = model
        s.lastMode = permissionMode
        s.lastCwd = cwd
        s.chats[chatId] = {
          ...emptyModel(),
          chatId,
          createdAt: Date.now(),
          title: 'New chat',
          cwd,
          sessionId: chatId,
          pending: [],
          models: [],
          requestedModel: model,
          requestedEffort: get().lastEffort,
          requestedMode: permissionMode,
          transcriptLoaded: true,
          draft: '',
          unread: false,
          ...chatExtras(),
        }
        s.tabs.push(chatId)
        s.activeChatId = chatId
        s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
        s.showNewDialog = false
      })
      const opts: StartChatOptions = { chatId, cwd, permissionMode }
      if (model !== 'default') opts.model = model
      if (get().lastEffort !== 'default') opts.effort = get().lastEffort as EffortLevel
      await startRunner(chatId, opts)
      refreshAfterStart(chatId)
    },

    async newGeneralChat() {
      const chatId = crypto.randomUUID()
      const { generalDir: cwd, lastModel: model, lastMode: permissionMode } = get()
      if (!cwd) return
      set((s) => {
        s.chats[chatId] = {
          ...emptyModel(),
          chatId,
          createdAt: Date.now(),
          title: 'New chat',
          cwd,
          sessionId: chatId,
          pending: [],
          models: [],
          requestedModel: model,
          requestedEffort: get().lastEffort,
          requestedMode: permissionMode,
          transcriptLoaded: true,
          draft: '',
          unread: false,
          ...chatExtras(),
        }
        s.tabs.push(chatId)
        s.activeChatId = chatId
        s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
      })
      const opts: StartChatOptions = { chatId, cwd, permissionMode }
      if (model !== 'default') opts.model = model
      if (get().lastEffort !== 'default') opts.effort = get().lastEffort as EffortLevel
      await startRunner(chatId, opts)
      refreshAfterStart(chatId)
    },

    activate(chatId) {
      set((s) => {
        s.activeChatId = chatId
        if (chatId && s.chats[chatId]) {
          s.chats[chatId].unread = false
          s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
        }
      })
    },

    closeTab(chatId) {
      void window.desktop.closeChat(chatId)
      set((s) => {
        delete s.chats[chatId]
        s.tabs = s.tabs.filter((t) => t !== chatId)
        s.recent = s.recent.filter((t) => t !== chatId && s.tabs.includes(t))
        // Fall back to the chat used most recently before this one, else the welcome screen.
        if (s.activeChatId === chatId) s.activeChatId = s.recent[0] ?? null
        if (s.activeChatId && s.chats[s.activeChatId]) s.chats[s.activeChatId].unread = false
      })
    },

    async clearChat(chatId) {
      const c = get().chats[chatId]
      if (!c) return
      await window.desktop.closeChat(chatId)
      const sessionId = crypto.randomUUID()
      // The cleared chat keeps its sidebar slot: the old session is hidden and the new
      // one inherits its sort time (chains A -> B -> C keep A's slot).
      const oldId = c.sessionId
      const keep =
        (oldId ? get().sessionSortTime[oldId] : undefined) ??
        get().sessions.find((x) => x.sessionId === oldId)?.createdAt ??
        c.createdAt ??
        Date.now()
      set((s) => {
        const x = s.chats[chatId]
        if (!x) return
        if (oldId) {
          if (!s.hiddenSessions.includes(oldId)) s.hiddenSessions.push(oldId)
          delete s.sessionSortTime[oldId]
        }
        s.sessionSortTime[sessionId] = keep
        if (oldId) {
          const i = s.keepWarm.indexOf(oldId)
          if (i >= 0) {
            s.keepWarm[i] = sessionId
            prefs.set('keepWarm', s.keepWarm)
          }
          if (oldId in s.warmedAt) {
            delete s.warmedAt[oldId]
            prefs.set('warmedAt', s.warmedAt)
          }
        }
        prefs.set('hiddenSessions', s.hiddenSessions)
        prefs.set('sessionSortTime', s.sessionSortTime)
        Object.assign(x, emptyModel(), {
          sessionId,
          createdAt: keep,
          title: 'New chat',
          pending: [],
          context: undefined,
          closed: false,
          transcriptLoaded: true,
          unread: false,
          queue: [],
          commands: x.commands,
        })
      })
      const opts: StartChatOptions = { chatId, cwd: c.cwd, permissionMode: c.requestedMode, sessionId }
      if (c.requestedModel && c.requestedModel !== 'default') opts.model = c.requestedModel
      if (c.requestedEffort && c.requestedEffort !== 'default') opts.effort = c.requestedEffort as EffortLevel
      await startRunner(chatId, opts)
      refreshAfterStart(chatId)
    },

    async sendMessage(chatId, text, images = [], fromDraft = false) {
      const uuid = crypto.randomUUID()
      const before = get().chats[chatId]
      if (!before) return
      // The CLI process ended (crash, error, or it was closed): start it again
      // on the same session before queueing the message.
      if (before.closed) {
        set((s) => {
          const c = s.chats[chatId]
          c.closed = false
          c.status = 'starting'
          c.totalCost = 0 // cost counter restarts with the new CLI process
          c.error = undefined
        })
        const opts: StartChatOptions = { chatId, cwd: before.cwd, permissionMode: before.requestedMode }
        // A chat that never got a turn has no transcript to resume yet.
        if (before.sessionId && before.messages.length) opts.resume = before.sessionId
        if (before.requestedModel && before.requestedModel !== 'default') opts.model = before.requestedModel
        if (before.requestedEffort && before.requestedEffort !== 'default') opts.effort = before.requestedEffort as EffortLevel
        await startRunner(chatId, opts)
        // Start failed (chat:exit already arrived with the reason): keep the draft.
        if (get().chats[chatId]?.closed) return
        refreshAfterStart(chatId)
      }
      const blocks: Block[] = images.map((im) => ({ kind: 'image', mediaType: im.mediaType, data: im.data }))
      if (text) blocks.push({ kind: 'text', text })
      let content: UserContent = text
      if (images.length) {
        const parts: ContentBlock[] = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }))
        if (text) parts.push({ type: 'text', text })
        content = parts
      }
      set((s) => {
        const c = s.chats[chatId]
        if (!c) return
        c.messages.push({ id: uuid, role: 'user', blocks })
        c.status = 'running'
        c.error = undefined
        c.interrupted = false
        if (fromDraft) {
          c.draft = ''
          c.attachments = []
        }
        const t = text || 'Image'
        if (c.title === 'New chat') c.title = t.length > 60 ? t.slice(0, 57) + '…' : t
      })
      await window.desktop.send(chatId, content, uuid)
    },

    enqueue(chatId, text, images, fromDraft = true) {
      set((s) => {
        const c = s.chats[chatId]
        if (!c) return
        c.queue.push({ id: crypto.randomUUID(), text, images })
        if (fromDraft) {
          c.draft = ''
          c.attachments = []
        }
      })
    },

    removeQueued(chatId, id) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.queue = c.queue.filter((q) => q.id !== id)
      })
    },

    async sendQueuedNow(chatId, id) {
      const q = get().chats[chatId]?.queue.find((x) => x.id === id)
      if (!q) return
      get().removeQueued(chatId, id)
      // The CLI folds a message sent mid-turn into the running turn.
      await get().sendMessage(chatId, q.text, q.images)
    },

    addAttachments(chatId, images) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.attachments.push(...images)
      })
    },

    removeAttachment(chatId, id) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.attachments = c.attachments.filter((a) => a.id !== id)
      })
    },

    setKeepWarm(sessionId, on) {
      set((s) => {
        const has = s.keepWarm.includes(sessionId)
        if (on && !has) s.keepWarm.push(sessionId)
        else if (!on && has) s.keepWarm = s.keepWarm.filter((id) => id !== sessionId)
        prefs.set('keepWarm', s.keepWarm)
      })
    },

    async tickKeepWarm() {
      const st = get()
      for (const chat of Object.values(st.chats)) {
        const sid = chat.sessionId
        if (chat.closed || !sid || !st.keepWarm.includes(sid)) continue
        if (chat.status !== 'idle' || chat.pending.length) continue
        const now = Date.now()
        if (get().warming[sid] || now < (get().warmRetryAt[sid] ?? 0)) continue
        const lastReal = chat.lastResponseAt || get().meta[sid]?.lastAt
        if (!lastReal || now - lastReal > KEEP_WARM_MAX_IDLE_MS) continue
        const last = Math.max(lastReal, get().warmedAt[sid] ?? 0)
        const ttl = get().meta[sid]?.cacheTtlMs ?? 300_000
        const left = last + ttl - now
        if (left <= 0 || left > Math.min(300_000, ttl * 0.2)) continue
        set((s) => {
          s.warming[sid] = true
        })
        const start = Date.now()
        let ok = false
        try {
          ok = await window.desktop.warmCache(chat.chatId)
        } catch {
          ok = false
        }
        set((s) => {
          delete s.warming[sid]
          if (ok) {
            s.warmedAt[sid] = start
            prefs.set('warmedAt', s.warmedAt)
          } else s.warmRetryAt[sid] = Date.now() + 120_000
        })
      }
    },

    setNotifications(v) {
      prefs.set('notifications', v)
      set((s) => {
        s.notifications = v
      })
    },

    setTheme(theme) {
      prefs.set('theme', theme)
      set((s) => {
        s.theme = theme
      })
    },

    setFindOpen(v) {
      set((s) => {
        s.findOpen = v
      })
    },

    async respond(chatId, requestId, response) {
      set((s) => {
        const c = s.chats[chatId]
        if (!c) return
        const req = c.pending.find((p) => p.requestId === requestId)
        c.pending = c.pending.filter((p) => p.requestId !== requestId)
        if (req && response.behavior === 'deny') {
          const tool = findTool(c, req.toolUseID)
          if (tool) tool.status = 'denied'
        }
      })
      await window.desktop.respond(chatId, requestId, response)
    },

    async interrupt(chatId) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.interrupted = true
      })
      await window.desktop.interrupt(chatId)
    },

    async setModel(chatId, model) {
      prefs.set('lastModel', model)
      set((s) => {
        s.lastModel = model
        const c = s.chats[chatId]
        if (c) c.requestedModel = model
      })
      await window.desktop.setModel(chatId, model)
    },

    async setEffort(chatId, effort) {
      prefs.set('lastEffort', effort)
      set((s) => {
        s.lastEffort = effort
        const c = s.chats[chatId]
        if (!c) return
        c.requestedEffort = effort
        // No new init message arrives mid-session, so show the pick right away.
        c.effort = effort !== 'default' ? effort : undefined
      })
      await window.desktop.setEffort(chatId, effort)
    },

    async setMode(chatId, mode) {
      prefs.set('lastMode', mode)
      set((s) => {
        s.lastMode = mode
        const c = s.chats[chatId]
        if (c) {
          c.requestedMode = mode
          c.permissionMode = mode
        }
      })
      await window.desktop.setPermissionMode(chatId, mode)
    },

    setDraft(chatId, text) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.draft = text
      })
    },

    setSearch(q) {
      set((s) => {
        s.search = q
      })
    },

    setRecentHours(h) {
      prefs.set('recentHours', h)
      set((s) => {
        s.recentHours = h
      })
    },

    setChangesWidth(px) {
      const w = Math.round(Math.min(1000, Math.max(300, px)))
      set((s) => {
        s.changesWidth = w
      })
      prefs.set('changesWidth', w)
    },

    setSidebarWidth(px) {
      const w = Math.round(Math.min(640, Math.max(320, px)))
      set((s) => {
        s.sidebarWidth = w
      })
      prefs.set('sidebarWidth', w)
    },

    toggleChanges() {
      const active = get().activeChatId ? get().chats[get().activeChatId!] : undefined
      if (active && isGeneral(active.cwd)) return
      set((s) => {
        s.changesOpen = !s.changesOpen
        prefs.set('changesOpen', s.changesOpen)
      })
      const c = get().activeChatId ? get().chats[get().activeChatId!] : undefined
      if (get().changesOpen && c) void get().refreshChanges(c.cwd)
    },

    async refreshChanges(cwd) {
      if (isGeneral(cwd) || changesInFlight.has(cwd)) return
      changesInFlight.add(cwd)
      set((s) => {
        s.changes[cwd] = { ...(s.changes[cwd] ?? { isRepo: true, files: [] }), loading: true }
      })
      let res: GitChanges
      try {
        res = await window.desktop.gitChanges(cwd)
      } catch (e) {
        res = { isRepo: true, files: [], error: e instanceof Error ? e.message : String(e) }
      }
      changesInFlight.delete(cwd)
      set((s) => {
        s.changes[cwd] = { ...res, fetchedAt: Date.now() }
      })
    },

    addComment(chatId, c) {
      set((s) => {
        s.chats[chatId]?.comments.push({ ...c, id: crypto.randomUUID() })
      })
    },

    updateComment(chatId, id, text) {
      set((s) => {
        const c = s.chats[chatId]?.comments.find((x) => x.id === id)
        if (c) c.text = text
      })
    },

    removeComment(chatId, id) {
      set((s) => {
        const c = s.chats[chatId]
        if (c) c.comments = c.comments.filter((x) => x.id !== id)
      })
    },

    sendComments(chatId) {
      const c = get().chats[chatId]
      if (!c || !c.comments.length) return
      const text = formatComments(c.comments)
      set((s) => {
        const x = s.chats[chatId]
        if (x) x.comments = []
      })
      if (c.status === 'running' || c.status === 'compacting') get().enqueue(chatId, text, [], false)
      else void get().sendMessage(chatId, text)
    },

    pinProject(dir) {
      set((s) => {
        const d = dir.replace(/\/+$/, '')
        if (!s.pinnedProjects.includes(d)) s.pinnedProjects.push(d)
        prefs.set('pinnedProjects', s.pinnedProjects)
        placeAfterPinned(s, d)
      })
    },

    unpinProject(dir) {
      set((s) => {
        s.pinnedProjects = s.pinnedProjects.filter((d) => d !== dir)
        prefs.set('pinnedProjects', s.pinnedProjects)
        placeAfterPinned(s, dir)
      })
    },

    setProjectOrder(order) {
      prefs.set('projectOrder', order)
      set((s) => {
        s.projectOrder = order
      })
    },

    setShowNewDialog(v, cwd) {
      set((s) => {
        s.showNewDialog = v
        s.newDialogCwd = v ? (cwd ?? null) : null
      })
    },

    async renameSession(sess, title) {
      await window.desktop.renameSession(sess.sessionId, title, sess.cwd)
      set((s) => {
        const x = s.sessions.find((y) => y.sessionId === sess.sessionId)
        if (x) x.customTitle = title
        for (const c of Object.values(s.chats)) if (c.sessionId === sess.sessionId) c.title = title
      })
    },

    async deleteSession(sess) {
      // An open chat would otherwise reappear as a placeholder row once its transcript is gone.
      // Wait for the CLI to exit first: it writes to the transcript as it shuts down.
      const exits: Promise<void>[] = []
      for (const c of Object.values(get().chats)) {
        if (c.sessionId !== sess.sessionId) continue
        exits.push(window.desktop.closeChat(c.chatId))
        get().closeTab(c.chatId)
      }
      await Promise.all(exits)
      await window.desktop.deleteSession(sess.sessionId, sess.cwd)
      set((s) => {
        s.sessions = s.sessions.filter((y) => y.sessionId !== sess.sessionId)
      })
    },

    async removeProject(cwd) {
      const st = get()
      const exits: Promise<void>[] = []
      for (const c of Object.values(st.chats)) {
        if (c.cwd !== cwd) continue
        exits.push(window.desktop.closeChat(c.chatId))
        st.closeTab(c.chatId)
      }
      await Promise.all(exits)
      const ids = st.sessions.filter((x) => x.cwd === cwd).map((x) => x.sessionId)
      await window.desktop.deleteProject(cwd, ids)
      set((s) => {
        s.sessions = s.sessions.filter((x) => x.cwd !== cwd)
        s.pinnedProjects = s.pinnedProjects.filter((d) => d !== cwd)
        s.projectOrder = s.projectOrder.filter((d) => d !== cwd)
        prefs.set('pinnedProjects', s.pinnedProjects)
        prefs.set('projectOrder', s.projectOrder)
        delete s.projectNames[cwd]
        prefs.set('projectNames', s.projectNames)
      })
    },

    renameProject(cwd, name) {
      const n = name.trim()
      set((s) => {
        if (!n || n === basename(cwd)) delete s.projectNames[cwd]
        else s.projectNames[cwd] = n
        prefs.set('projectNames', s.projectNames)
      })
    },
  })),
)

/**
 * Start the chat's CLI process. In streaming-input mode the CLI only sends its
 * init message once the first turn starts, so the chat counts as ready as soon
 * as the process is up.
 */
async function startRunner(chatId: string, opts: StartChatOptions): Promise<void> {
  const gen = await window.desktop.startChat(opts)
  useStore.setState((s) => {
    const c = s.chats[chatId]
    if (!c) return
    if (typeof gen === 'number') c.gen = Math.max(c.gen ?? 0, gen)
    if (!c.closed && c.status === 'starting') c.status = 'idle'
  })
}

/** True when an event comes from a runner that has since been replaced. */
function stale(c: Chat, gen: number | undefined): boolean {
  return typeof gen === 'number' && typeof c.gen === 'number' && gen < c.gen
}

function refreshAfterStart(chatId: string): void {
  // The CLI answers control requests once it is up; fill the context meter
  // before the first turn (the init message only arrives with a turn).
  void refreshModels(chatId).then(() => {
    const c = useStore.getState().chats[chatId]
    if (c && !c.closed && !c.context) void window.desktop.requestContext?.(chatId)
  })
  void refreshCommands(chatId)
  void refreshAgents(chatId)
}

async function refreshCommands(chatId: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 900))
    const c = useStore.getState().chats[chatId]
    if (!c || c.closed) return
    try {
      const commands = (await window.desktop.listCommands?.(chatId)) ?? []
      if (commands.length) {
        useStore.setState((s) => {
          const cc = s.chats[chatId]
          if (cc) cc.commands = commands
        })
        return
      }
    } catch {
      /* not ready yet */
    }
  }
}

async function refreshAgents(chatId: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 900))
    const c = useStore.getState().chats[chatId]
    if (!c || c.closed) return
    try {
      const agents = (await window.desktop.listAgents?.(chatId)) ?? []
      if (agents.length) {
        useStore.setState((s) => {
          const cc = s.chats[chatId]
          if (cc) cc.agents = agents
        })
        return
      }
    } catch {
      /* not ready yet */
    }
  }
}

// ---- desktop notifications -------------------------------------------------

function lastAssistantText(c: Chat): string {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i]
    if (m.role === 'user') break
    if (m.role !== 'assistant') continue
    for (let k = m.blocks.length - 1; k >= 0; k--) {
      const b = m.blocks[k]
      if (b.kind === 'text' && b.text.trim()) return b.text
    }
  }
  return ''
}

function clip120(s: string): string {
  const t = s.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim()
  return t.length > 120 ? t.slice(0, 117) + '…' : t
}

function permissionText(req: PermissionRequest): string {
  if (req.toolName === 'AskUserQuestion') return 'Claude has a question'
  const i = req.input as Record<string, unknown>
  if (req.toolName === 'Bash' && typeof i.command === 'string') return clip120(`Claude wants to run ${i.command.split('\n')[0]}`)
  const target = i.file_path ?? i.url ?? i.pattern
  return clip120(`Claude wants to use ${req.toolName}${typeof target === 'string' ? ` on ${target}` : ''}`)
}

/** Notify only when the user can't see that chat right now. */
function maybeNotify(chatId: string, body: string): void {
  const s = useStore.getState()
  if (!s.notifications) return
  const c = s.chats[chatId]
  if (!c) return
  // Main checks window focus; an inactive chat is out of view either way.
  void window.desktop.notify?.({ chatId, title: c.title || 'Claude Code', body: body || 'Claude finished', onlyIfUnfocused: s.activeChatId === chatId })
}

async function refreshModels(chatId: string): Promise<void> {
  // The CLI answers supportedModels only once it has initialised; retry briefly.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 700))
    const c = useStore.getState().chats[chatId]
    if (!c || c.closed) return
    try {
      const models = await window.desktop.listModels(chatId)
      if (models.length) {
        useStore.setState((s) => {
          const cc = s.chats[chatId]
          if (cc) cc.models = models
        })
        return
      }
    } catch {
      /* not ready yet */
    }
  }
}

const changesInFlight = new Set<string>()

function formatComments(comments: ReviewComment[]): string {
  const items = comments.map((c, i) => {
    const t = c.lineText.trim()
    const code = t.length > 120 ? t.slice(0, 119) + '…' : t
    const where = `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`
    const body = c.text.trim().split('\n').join('\n   ')
    return `${i + 1}. ${where} — \`${code}\`\n   ${body}`
  })
  return `Review comments on the uncommitted changes. Please address each one:\n\n${items.join('\n\n')}`
}

// ---- wire IPC events into the store once ---------------------------------

let wired = false
let tabsRestored = false
let lastTabsKey = ''
export function wireEvents(): void {
  if (wired) return
  wired = true
  // Remember which sessions are open so they come back after a reload or restart.
  useStore.subscribe((s) => {
    if (!tabsRestored) return
    const sessions = s.tabs.map((id) => s.chats[id]?.sessionId).filter((x): x is string => !!x)
    const active = s.activeChatId ? (s.chats[s.activeChatId]?.sessionId ?? null) : null
    const key = JSON.stringify({ sessions, active })
    if (key === lastTabsKey) return
    lastTabsKey = key
    prefs.set('openTabs', { sessions, active })
  })
  // Prompt-cache keep-alive for chats that opted in.
  setInterval(() => void useStore.getState().tickKeepWarm(), 30_000)
  // Keep the changes badge fresh: refresh the folder whenever another chat becomes active.
  let lastChangesChat: string | null = null
  useStore.subscribe((s) => {
    if (s.activeChatId === lastChangesChat) return
    lastChangesChat = s.activeChatId
    const cwd = s.activeChatId ? s.chats[s.activeChatId]?.cwd : undefined
    if (cwd) void s.refreshChanges(cwd)
  })
  window.desktop.onAgentEvent(({ chatId, gen, message }) => {
    const before = useStore.getState().chats[chatId]
    if (!before || stale(before, gen)) return
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (!c) return
      applySdkMessage(c, message)
      if (message.type === 'result' && (s.activeChatId !== chatId || !document.hasFocus())) c.unread = true
      if (message.type === 'system' && message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
        c.commands = message.commands.map((x: SlashCommandInfo) => ({ name: x.name, description: x.description, argumentHint: x.argumentHint, aliases: x.aliases }))
      }
    })
    if (message.type !== 'result') return
    const c = useStore.getState().chats[chatId]
    if (!c) return
    void useStore.getState().refreshChanges(c.cwd)
    // Send the next queued message; it starts the next turn.
    const next = c.queue[0]
    if (next && !c.closed) {
      useStore.getState().removeQueued(chatId, next.id)
      void useStore.getState().sendMessage(chatId, next.text, next.images)
      return
    }
    maybeNotify(chatId, clip120(lastAssistantText(c)))
  })
  window.desktop.onPermissionRequest((req) => {
    useStore.setState((s) => {
      const c = s.chats[req.chatId]
      if (!c) return
      c.pending.push(req)
      if (s.activeChatId !== req.chatId || !document.hasFocus()) c.unread = true
    })
    maybeNotify(req.chatId, permissionText(req))
  })
  window.desktop.onNotificationClick?.(({ chatId }) => {
    if (useStore.getState().chats[chatId]) useStore.getState().activate(chatId)
  })
  window.desktop.onPermissionCancel(({ chatId, requestId }) => {
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (c) c.pending = c.pending.filter((p) => p.requestId !== requestId)
    })
  })
  window.desktop.onChatContext((ctx) => {
    useStore.setState((s) => {
      const c = s.chats[ctx.chatId]
      if (c) c.context = ctx
      if (ctx.model && ctx.maxTokens) s.modelMax[ctx.model] = ctx.maxTokens
    })
  })
  window.desktop.onChatExit(({ chatId, gen, error }) => {
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (!c || stale(c, gen)) return
      c.closed = true
      c.status = 'idle'
      c.pending = []
      if (error) c.error = error
      for (const a of c.subagents) {
        a.hidden = true
        if (a.status !== 'running') continue
        a.status = 'failed'
        a.endedAt = Date.now()
      }
    })
  })
  // Coming back to the window counts as seeing the active chat.
  window.addEventListener('focus', () => {
    useStore.setState((s) => {
      const c = s.activeChatId ? s.chats[s.activeChatId] : undefined
      if (c) c.unread = false
    })
  })
  window.desktop.onSessionsChanged(() => {
    void useStore.getState().loadSessions()
  })
}
