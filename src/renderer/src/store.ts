import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { RemoteStateEvent, SessionSummary, LiveChat, PermissionRequest, PermissionMode, ModelChoice, EffortLevel, StartChatOptions, SessionMeta, ChatContext, SlashCommandInfo, AgentChoice, ContentBlock, UserContent, Theme, GitChanges } from '@shared/types'
import { applySdkMessage, applyTranscript, emptyModel, findTool, type ChatModel, type Block } from './reduce'
import type { WfGraph, WorkflowFile, WorkflowReadResult, WorkflowScope } from '../../shared/workflow'
import type { ImageAttachment } from './images'
import { basename, projectRoot, isPhone } from './util'
import { playChime } from './sound'
import { SHARED_PREFS } from '../../shared/channels'
import { ensureTerminal, disposeTerminal, terminalExited, whenTerminalReady, pasteToTerminal, focusTerminal } from './terminals'

/** Working copy of a workflow in the designer (`file` null = not saved yet); `savedKey` is the snapshot the dirty marker compares against. */
export interface WorkflowDraft {
  file: WorkflowFile | null
  scope: WorkflowScope
  graph: WfGraph | null
  read?: WorkflowReadResult
  savedKey: string
  selected: string | null
}

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

export interface TermTab {
  id: string
  shell: string
  /** Stable number within the folder, shown in the tab label ("zsh 2"). */
  n: number
}

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
  /** Live runners in the main process by session id (also those this client has not opened). */
  live: Record<string, LiveChat>
  setLive(list: LiveChat[]): void
  meta: Record<string, SessionMeta>
  modelMax: Record<string, number>
  chats: Record<string, Chat>
  /** Open chats in opening order (persisted for restore; there is no tab strip). */
  tabs: string[]
  /** Open chats, most recently activated first. */
  recent: string[]
  activeChatId: string | null
  /** Project root whose workflow designer replaces the chat pane (not persisted). */
  workflowsRoot: string | null
  /** Read-only view of a subagent's transcript replacing the chat pane of `chatId` (not persisted). */
  agentView: { chatId: string; toolUseId: string } | null
  /** Unsaved workflow designer drafts per project root (not persisted). */
  workflowDrafts: Record<string, WorkflowDraft>
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
  /** Session ids with Remote Control switched on (restored when the chat's runner starts). */
  remoteSessions: string[]
  /** Live Remote Control state per chat (not persisted). */
  remote: Record<string, RemoteStateEvent>
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
  /** Per project root: default model/effort for new, resumed and worktree chats ('default' = CLI default, absent = follow last used). */
  projectDefaults: Record<string, ProjectDefaults>
  lastMode: PermissionMode
  lastCwd: string
  notifications: boolean
  notifySound: boolean
  theme: Theme
  diffTint: DiffTint
  /** Preferred editor / terminal ids ('' = first detected; editor 'system' = OS handler). */
  editor: string
  terminal: string
  setEditor(id: string): void
  setTerminal(id: string): void
  findOpen: boolean
  /** Git working-tree changes keyed by cwd. */
  changes: Record<string, ChangesEntry>
  changesOpen: boolean
  /** Changes dock covers the window below the title row (not persisted). */
  changesMax: boolean
  changesWidth: number
  diffLayout: 'unified' | 'split'
  /** Fraction of the right dock's height given to the top panel (Changes) when Changes and Terminal are both open. */
  dockSplit: number
  /** Integrated terminals per folder (not persisted; the shells live in the main process). */
  terminals: Record<string, { tabs: TermTab[]; active: string | null; counter: number }>
  terminalOpen: boolean
  terminalsLoaded: boolean
  sidebarWidth: number

  loadSessions(): Promise<void>
  restoreTabs(): Promise<void>
  loadMeta(items: { sessionId: string; cwd: string }[]): Promise<void>
  /** Open a session in a tab; `background` leaves the active chat alone (startup restore). */
  openSession(s: SessionSummary, fork?: boolean, background?: boolean): Promise<void>
  newChat(opts: { cwd: string; model?: string; permissionMode: PermissionMode }): Promise<void>
  /** A general chat (no project folder) with the last-used model, effort and mode. */
  newGeneralChat(): Promise<void>
  activate(chatId: string | null): void
  openAgentView(chatId: string, toolUseId: string): void
  closeAgentView(): void
  openWorkflows(root: string): void
  closeWorkflows(): void
  setWorkflowDraft(root: string, draft: WorkflowDraft | null): void
  closeTab(chatId: string): void
  toggleTerminal(): void
  restoreTerminals(): Promise<void>
  newTerminal(cwd: string): Promise<void>
  runInTerminal(cwd: string, text: string, run: boolean): Promise<void>
  killTerminal(id: string): void
  setActiveTerminal(cwd: string, id: string): void
  clearChat(chatId: string): Promise<void>
  setKeepWarm(sessionId: string, on: boolean): void
  /** Remote Control (claude.ai/code, mobile app) for a session; project chats only. */
  setRemote(sessionId: string, on: boolean): void
  tickKeepWarm(): Promise<void>
  sendMessage(chatId: string, text: string, images?: ImageAttachment[], fromDraft?: boolean): Promise<void>
  /** Queue a message; fromDraft (default) also clears the composer. */
  enqueue(chatId: string, text: string, images: ImageAttachment[], fromDraft?: boolean): void
  removeQueued(chatId: string, id: string): void
  sendQueuedNow(chatId: string, id: string): Promise<void>
  addAttachments(chatId: string, images: ImageAttachment[]): void
  removeAttachment(chatId: string, id: string): void
  setNotifications(v: boolean): void
  setNotifySound(v: boolean): void
  setTheme(theme: Theme): void
  setDiffTint(v: DiffTint): void
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
  toggleChangesMax(): void
  setChangesMax(v: boolean): void
  setChangesWidth(px: number): void
  setDiffLayout(l: 'unified' | 'split'): void
  setDockSplit(f: number): void
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
  setProjectDefaults(root: string, d: ProjectDefaults | null): void
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
    if (SHARED_PREFS.includes(k)) void Promise.resolve(window.desktop.setSharedPref(k, JSON.stringify(v))).catch(() => {})
  },
}

function applyShared(key: string, value: unknown): void {
  const cur = (useStore.getState() as unknown as Record<string, unknown>)[key]
  if (JSON.stringify(value) === JSON.stringify(cur)) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
  useStore.setState({ [key]: value } as never)
}

/** Pull the shared prefs from main; the desktop seeds main with its own values for keys main lacks. */
export async function syncSharedPrefs(): Promise<void> {
  let remote: Record<string, unknown>
  try {
    remote = await window.desktop.getSharedPrefs()
  } catch {
    return
  }
  for (const key of SHARED_PREFS) {
    if (key in remote) applyShared(key, remote[key])
    else if (!isPhone) {
      const v = (useStore.getState() as unknown as Record<string, unknown>)[key]
      void Promise.resolve(window.desktop.setSharedPref(key, JSON.stringify(v))).catch(() => {})
    }
  }
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

export interface ProjectDefaults {
  model?: string
  effort?: string
}

/** Model a new/resumed chat in this folder starts with: the project's default, else the last used. */
export function modelFor(cwd: string): string {
  const st = useStore.getState()
  return st.projectDefaults[projectRoot(cwd)]?.model ?? st.lastModel
}

export function effortFor(cwd: string): string {
  const st = useStore.getState()
  return st.projectDefaults[projectRoot(cwd)]?.effort ?? st.lastEffort
}

/** Diff add/remove coloring: whole row or only the line-number gutter. */
export type DiffTint = 'row' | 'gutter'

export const useStore = create<State>()(
  immer((set, get) => ({
    sessions: [],
    sessionsLoaded: false,
    live: {},
    setLive(list) {
      set((s) => {
        const next: Record<string, LiveChat> = {}
        for (const l of list) if (l.sessionId) next[l.sessionId] = l
        s.live = next
      })
    },
    meta: {},
    modelMax: {},
    chats: {},
    tabs: [],
    recent: [],
    activeChatId: null,
    workflowsRoot: null,
    agentView: null,
    workflowDrafts: {},
    showNewDialog: false,
    newDialogCwd: null,
    generalDir: '',
    pinnedProjects: prefs.get<string[]>('pinnedProjects', []),
    projectOrder: prefs.get<string[]>('projectOrder', []),
    projectNames: prefs.get<Record<string, string>>('projectNames', {}),
    hiddenSessions: prefs.get<string[]>('hiddenSessions', []),
    sessionSortTime: prefs.get<Record<string, number>>('sessionSortTime', {}),
    keepWarm: prefs.get<string[]>('keepWarm', []),
    remoteSessions: prefs.get<string[]>('remoteSessions', []),
    remote: {},
    warmedAt: prefs.get<Record<string, number>>('warmedAt', {}),
    warming: {},
    warmRetryAt: {},
    changes: {},
    changesOpen: prefs.get('changesOpen', false),
    changesMax: false,
    changesWidth: prefs.get('changesWidth', 520),
    diffLayout: prefs.get<'unified' | 'split'>('diffLayout', 'unified'),
    dockSplit: prefs.get('dockSplit', 0.5),
    terminals: {},
    terminalOpen: prefs.get('terminalOpen', false),
    terminalsLoaded: false,
    sidebarWidth: prefs.get('sidebarWidth', 390),
    search: '',
    recentHours: prefs.get('recentHours', 14),
    lastModel: prefs.get('lastModel', 'default'),
    lastEffort: prefs.get('lastEffort', 'default'),
    projectDefaults: prefs.get<Record<string, ProjectDefaults>>('projectDefaults', {}),
    // Always start sessions with permissions bypassed (--dangerously-skip-permissions).
    lastMode: 'bypassPermissions' as PermissionMode,
    lastCwd: prefs.get('lastCwd', ''),
    notifications: prefs.get('notifications', true),
    notifySound: prefs.get('notifySound', true),
    theme: prefs.get<Theme>('theme', 'system'),
    diffTint: prefs.get<DiffTint>('diffTint', 'row'),
    editor: prefs.get('editor', ''),
    terminal: prefs.get('terminal', ''),
    setEditor(id) {
      prefs.set('editor', id)
      set((s) => {
        s.editor = id
      })
    },
    setTerminal(id) {
      prefs.set('terminal', id)
      set((s) => {
        s.terminal = id
      })
    },
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
        const hidden = isPhone ? s.hiddenSessions : s.hiddenSessions.filter((id) => disk.has(id))
        if (hidden.length !== s.hiddenSessions.length) {
          s.hiddenSessions = hidden
          prefs.set('hiddenSessions', hidden)
        }
        const keys = Object.keys(s.sessionSortTime)
        const live = isPhone ? keys : keys.filter((id) => disk.has(id) || open.has(id))
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
      // A phone must not start runners on the PC for tabs it had open earlier.
      if (isPhone) return
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
      if (!fork) {
        // A runner for this session already lives in the main process (started here before a reload, or by another client).
        const liveChat = (await window.desktop.liveChats().catch(() => [] as LiveChat[])).find((l) => l.sessionId === sess.sessionId)
        if (liveChat && (await attachLive(liveChat.chatId, { background, title: titleFor(sess) }))) return
      }
      const chatId = crypto.randomUUID()
      const cwd = sess.cwd || (await window.desktop.homeDir())
      const mode = get().lastMode
      const model = modelFor(cwd)
      const effort = effortFor(cwd)
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
          requestedModel: model,
          requestedEffort: effort,
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
          s.workflowsRoot = null
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
      if (model !== 'default') opts.model = model
      if (effort !== 'default') opts.effort = effort as EffortLevel
      await startRunner(chatId, opts)
      refreshAfterStart(chatId)
    },

    async newChat({ cwd, model: picked, permissionMode }) {
      const chatId = crypto.randomUUID()
      const model = picked ?? modelFor(cwd)
      const effort = effortFor(cwd)
      if (picked !== undefined) prefs.set('lastModel', model)
      prefs.set('lastMode', permissionMode)
      const rootCwd = projectRoot(cwd)
      prefs.set('lastCwd', rootCwd)
      set((s) => {
        if (picked !== undefined) s.lastModel = model
        s.lastMode = permissionMode
        s.lastCwd = rootCwd
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
          requestedEffort: effort,
          requestedMode: permissionMode,
          transcriptLoaded: true,
          draft: '',
          unread: false,
          ...chatExtras(),
        }
        s.tabs.push(chatId)
        s.activeChatId = chatId
        s.workflowsRoot = null
        s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
        s.showNewDialog = false
      })
      const opts: StartChatOptions = { chatId, cwd, permissionMode }
      if (model !== 'default') opts.model = model
      if (effort !== 'default') opts.effort = effort as EffortLevel
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
        s.workflowsRoot = null
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
        s.agentView = null
        if (chatId) s.workflowsRoot = null
        if (chatId && s.chats[chatId]) {
          s.chats[chatId].unread = false
          s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
        }
      })
    },

    openAgentView(chatId, toolUseId) {
      if (!get().chats[chatId]) return
      get().activate(chatId)
      set((s) => {
        s.agentView = { chatId, toolUseId }
      })
    },

    closeAgentView() {
      set((s) => {
        s.agentView = null
      })
    },

    openWorkflows(root) {
      set((s) => {
        s.workflowsRoot = root
        s.agentView = null
      })
    },

    setWorkflowDraft(root, draft) {
      set((s) => {
        if (draft) s.workflowDrafts[root] = draft
        else delete s.workflowDrafts[root]
      })
    },

    closeWorkflows() {
      set((s) => {
        s.workflowsRoot = null
      })
    },

    closeTab(chatId) {
      closedHere.add(chatId)
      void window.desktop.closeChat(chatId)
      set((s) => {
        delete s.chats[chatId]
        if (s.agentView?.chatId === chatId) s.agentView = null
        s.tabs = s.tabs.filter((t) => t !== chatId)
        s.recent = s.recent.filter((t) => t !== chatId && s.tabs.includes(t))
        // Fall back to the chat used most recently before this one, else an empty pane.
        // The phone falls back to the list.
        if (s.activeChatId === chatId) s.activeChatId = isPhone ? null : (s.recent[0] ?? null)
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
          // Remote Control does not carry over to the new session id.
          if (s.remoteSessions.includes(oldId)) {
            s.remoteSessions = s.remoteSessions.filter((id) => id !== oldId)
            prefs.set('remoteSessions', s.remoteSessions)
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
      let content: UserContent = text
      if (images.length) {
        const parts: ContentBlock[] = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }))
        if (text) parts.push({ type: 'text', text })
        content = parts
      }
      set((s) => {
        const c = s.chats[chatId]
        if (!c) return
        appendUserMessage(c, uuid, text, blocks)
        if (fromDraft) {
          c.draft = ''
          c.attachments = []
        }
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

    setRemote(sessionId, on) {
      set((s) => {
        const has = s.remoteSessions.includes(sessionId)
        if (on && !has) s.remoteSessions.push(sessionId)
        else if (!on && has) s.remoteSessions = s.remoteSessions.filter((id) => id !== sessionId)
        prefs.set('remoteSessions', s.remoteSessions)
      })
      const chat = Object.values(get().chats).find((c) => c.sessionId === sessionId && !c.closed)
      if (!chat) return // enabled when the chat's runner starts
      if (on) void enableRemote(chat.chatId)
      else void window.desktop.remoteDisable(chat.chatId)
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

    setNotifySound(v) {
      prefs.set('notifySound', v)
      set((s) => {
        s.notifySound = v
      })
    },

    setTheme(theme) {
      prefs.set('theme', theme)
      set((s) => {
        s.theme = theme
      })
    },

    setDiffTint(v) {
      prefs.set('diffTint', v)
      set((s) => {
        s.diffTint = v
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
        // Plan approval switches the session mode (the runner sends a setMode update with the allow).
        if (response.behavior === 'allow' && response.mode) {
          c.requestedMode = response.mode
          c.permissionMode = response.mode
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
      const w = Math.round(Math.max(300, px))
      set((s) => {
        s.changesWidth = w
      })
      prefs.set('changesWidth', w)
    },

    setDiffLayout(l) {
      prefs.set('diffLayout', l)
      set((s) => {
        s.diffLayout = l
      })
      if (l === 'split' && get().changesWidth < 760) get().setChangesWidth(760)
    },

    setDockSplit(f) {
      const v = Math.round(Math.min(0.9, Math.max(0.1, f)) * 1000) / 1000
      set((s) => {
        s.dockSplit = v
      })
      prefs.set('dockSplit', v)
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
        if (!s.changesOpen) s.changesMax = false
        prefs.set('changesOpen', s.changesOpen)
      })
      const c = get().activeChatId ? get().chats[get().activeChatId!] : undefined
      if (get().changesOpen && c) void get().refreshChanges(c.cwd)
    },

    toggleChangesMax() {
      set((s) => {
        s.changesMax = !s.changesMax
      })
    },

    setChangesMax(v) {
      set((s) => {
        s.changesMax = v
      })
    },

    toggleTerminal() {
      const active = get().activeChatId ? get().chats[get().activeChatId!] : undefined
      if (active && isGeneral(active.cwd)) return
      set((s) => {
        s.terminalOpen = !s.terminalOpen
        prefs.set('terminalOpen', s.terminalOpen)
      })
    },

    async restoreTerminals() {
      const list = await window.desktop.ptyList().catch(() => [])
      for (const info of list) ensureTerminal(info.id, info.exited ? (info.code ?? 0) : undefined)
      set((s) => {
        for (const info of list) {
          const f = (s.terminals[info.cwd] ??= { tabs: [], active: null, counter: 0 })
          f.tabs.push({ id: info.id, shell: info.shell, n: ++f.counter })
          f.active ??= info.id
        }
        s.terminalsLoaded = true
      })
    },

    async newTerminal(cwd) {
      if (isGeneral(cwd) || terminalCreating.has(cwd)) return
      terminalCreating.add(cwd)
      try {
        const id = await window.desktop.ptyCreate(cwd, 80, 24)
        ensureTerminal(id)
        const shell = (await window.desktop.ptyList().catch(() => [])).find((i) => i.id === id)?.shell ?? 'shell'
        set((s) => {
          const f = (s.terminals[cwd] ??= { tabs: [], active: null, counter: 0 })
          f.tabs.push({ id, shell, n: ++f.counter })
          f.active = id
        })
      } finally {
        terminalCreating.delete(cwd)
      }
    },

    async runInTerminal(cwd, text, run) {
      if (isPhone || isGeneral(cwd) || !text.trim()) return
      set((s) => {
        s.terminalOpen = true
        prefs.set('terminalOpen', true)
      })
      const current = (): string | null => get().terminals[cwd]?.active ?? null
      let id = current()
      if (!id || terminalExited(id)) {
        await get().newTerminal(cwd)
        id = current()
        if (!id) return
        await whenTerminalReady(id)
      }
      if (!pasteToTerminal(id, text, run)) return
      const target = id
      for (let n = 0; n < 15; n++) {
        await new Promise((r) => requestAnimationFrame(r))
        if (focusTerminal(target)) break
      }
    },

    killTerminal(id) {
      const cwd = Object.keys(get().terminals).find((k) => get().terminals[k].tabs.some((t) => t.id === id))
      if (!cwd) return
      void window.desktop.ptyKill(id)
      disposeTerminal(id)
      set((s) => {
        const f = s.terminals[cwd]
        const i = f.tabs.findIndex((t) => t.id === id)
        f.tabs.splice(i, 1)
        if (f.active === id) f.active = f.tabs[Math.min(i, f.tabs.length - 1)]?.id ?? null
        const activeCwd = s.activeChatId ? s.chats[s.activeChatId]?.cwd : undefined
        // Closing the last shell of the visible folder closes the panel (no respawn).
        if (!f.tabs.length && cwd === activeCwd && s.terminalOpen) {
          s.terminalOpen = false
          prefs.set('terminalOpen', false)
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 0)
        }
      })
    },

    setActiveTerminal(cwd, id) {
      set((s) => {
        if (s.terminals[cwd]) s.terminals[cwd].active = id
      })
    },

    async refreshChanges(cwd) {
      if (isPhone || isGeneral(cwd) || changesInFlight.has(cwd)) return
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
        const d = dir.replace(/[\\/]+$/, '')
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
        if (projectRoot(c.cwd) !== cwd) continue
        exits.push(window.desktop.closeChat(c.chatId))
        st.closeTab(c.chatId)
      }
      await Promise.all(exits)
      // Worktree chats of the project live under their own cwd (and ~/.claude/projects slug).
      const mine = st.sessions.filter((x) => x.cwd && projectRoot(x.cwd) === cwd)
      const dirs = [...new Set([cwd, ...mine.map((x) => x.cwd!)])]
      for (const dir of dirs) {
        await window.desktop.deleteProject(dir, mine.filter((x) => x.cwd === dir).map((x) => x.sessionId))
      }
      set((s) => {
        s.sessions = s.sessions.filter((x) => !x.cwd || projectRoot(x.cwd) !== cwd)
        s.pinnedProjects = s.pinnedProjects.filter((d) => d !== cwd)
        s.projectOrder = s.projectOrder.filter((d) => d !== cwd)
        prefs.set('pinnedProjects', s.pinnedProjects)
        prefs.set('projectOrder', s.projectOrder)
        delete s.projectNames[cwd]
        prefs.set('projectNames', s.projectNames)
        delete s.projectDefaults[cwd]
        prefs.set('projectDefaults', s.projectDefaults)
      })
    },

    setProjectDefaults(root, d) {
      set((s) => {
        if (d && (d.model || d.effort)) s.projectDefaults[root] = { ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}) }
        else delete s.projectDefaults[root]
        prefs.set('projectDefaults', s.projectDefaults)
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

/** Chats this client closed itself; a runner kept alive by another client must not pull them back in. */
const closedHere = new Set<string>()
const autoAttached = new Set<string>()

/** Applies a transcript to the chat, keeping messages that arrived live and are not in it. */
function mergeTranscript(c: Chat, entries: Parameters<typeof applyTranscript>[1]): void {
  const meanwhile = c.messages
  c.messages = []
  applyTranscript(c, entries)
  for (const m of meanwhile) {
    const dup = c.messages.findIndex((x) => x.id === m.id || (!!m.apiId && x.apiId === m.apiId))
    if (dup < 0) c.messages.push(m)
    else if (m.streaming) c.messages[dup] = m
  }
}

/** Joins the runner that already lives in the main process under chatId, without starting one. */
async function attachLive(chatId: string, o: { background: boolean; title?: string }): Promise<boolean> {
  if (useStore.getState().chats[chatId]) return true
  const res = await window.desktop.attachChat(chatId)
  if (!res) return false
  // Another path (event-driven attach vs. openSession) may have created it meanwhile.
  if (useStore.getState().chats[chatId]) return true
  closedHere.delete(chatId)
  const st = useStore.getState()
  const sess = res.sessionId ? st.sessions.find((x) => x.sessionId === res.sessionId) : undefined
  const title = o.title ?? (sess ? titleFor(sess) : 'New chat')
  const model = res.model ?? modelFor(res.cwd)
  const effort = effortFor(res.cwd)
  useStore.setState((s) => {
    s.chats[chatId] = {
      ...emptyModel(),
      chatId,
      createdAt: Date.now(),
      title,
      cwd: res.cwd,
      sessionId: res.sessionId,
      status: res.status,
      gen: res.gen,
      pending: res.pending,
      models: [],
      requestedModel: model,
      requestedEffort: effort,
      requestedMode: res.permissionMode,
      permissionMode: res.permissionMode,
      transcriptLoaded: false,
      draft: '',
      unread: false,
      ...chatExtras(),
    }
    s.tabs.push(chatId)
    if (o.background) s.recent = [...s.recent.filter((x) => x !== chatId), chatId]
    else {
      s.activeChatId = chatId
      s.workflowsRoot = null
      s.recent = [chatId, ...s.recent.filter((x) => x !== chatId)]
    }
  })
  let entries: Awaited<ReturnType<Window['desktop']['getMessages']>> = []
  if (res.sessionId) {
    try {
      entries = await window.desktop.getMessages(res.sessionId, res.cwd)
    } catch {
      /* a brand-new session has no transcript yet */
    }
  }
  useStore.setState((s) => {
    const c = s.chats[chatId]
    if (!c) return
    mergeTranscript(c, entries)
    c.transcriptLoaded = true
    if (c.title === 'New chat' && c.sessionId) {
      const x = s.sessions.find((y) => y.sessionId === c.sessionId)
      if (x) c.title = titleFor(x)
    }
  })
  refreshAfterStart(chatId)
  return true
}

/** Desktop: a chat started elsewhere (the phone) shows up in the background, once per chatId. */
function autoAttach(chatId: string): void {
  if (isPhone || autoAttached.has(chatId) || closedHere.has(chatId)) return
  autoAttached.add(chatId)
  void attachLive(chatId, { background: true })
    .then((ok) => {
      if (!ok) autoAttached.delete(chatId)
    })
    .catch(() => autoAttached.delete(chatId))
}

/** Phone: after the socket came back, rejoin every open chat and reload its transcript. */
async function reattachAll(): Promise<void> {
  for (const chatId of Object.keys(useStore.getState().chats)) {
    let res: Awaited<ReturnType<Window['desktop']['attachChat']>> = null
    try {
      res = await window.desktop.attachChat(chatId)
    } catch {
      continue
    }
    if (!res) {
      useStore.setState((s) => {
        const c = s.chats[chatId]
        if (!c) return
        c.closed = true
        c.status = 'idle'
        c.pending = []
      })
      continue
    }
    const sessionId = res.sessionId
    let entries: Awaited<ReturnType<Window['desktop']['getMessages']>> | null = null
    if (sessionId) {
      try {
        entries = await window.desktop.getMessages(sessionId, res.cwd)
      } catch {
        entries = null
      }
    }
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (!c) return
      c.closed = false
      c.gen = res!.gen
      c.status = res!.status
      c.pending = res!.pending
      if (res!.model) c.requestedModel = res!.model
      c.requestedMode = res!.permissionMode
      c.permissionMode = res!.permissionMode
      if (sessionId) c.sessionId = sessionId
      if (entries) {
        c.messages = []
        applyTranscript(c, entries)
        c.transcriptLoaded = true
      }
    })
  }
  void useStore.getState().loadSessions()
  void window.desktop.liveChats().then((l) => useStore.getState().setLive(l))
}

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
  const c = useStore.getState().chats[chatId]
  if (c?.sessionId && !c.closed && useStore.getState().remoteSessions.includes(c.sessionId)) void enableRemote(chatId)
}

/** Appends a user message and marks the chat running; shared by locally typed and remote (claude.ai) messages. */
function appendUserMessage(c: Chat, uuid: string, text: string, blocks?: Block[]): void {
  c.messages.push({ id: uuid, role: 'user', blocks: blocks ?? (text ? [{ kind: 'text', text }] : []) })
  if (blocks && text) c.messages[c.messages.length - 1].blocks.push({ kind: 'text', text })
  c.status = 'running'
  c.error = undefined
  c.interrupted = false
  const t = text || 'Image'
  if (c.title === 'New chat') c.title = t.length > 60 ? t.slice(0, 57) + '…' : t
}

/** Connects the chat to claude.ai (Remote Control); project chats only. */
async function enableRemote(chatId: string): Promise<void> {
  const st = useStore.getState()
  const c = st.chats[chatId]
  if (!c || c.closed || !c.sessionId || isGeneral(c.cwd)) return
  const sid = c.sessionId
  const branch = st.meta[sid]?.gitBranch ?? st.sessions.find((x) => x.sessionId === sid)?.gitBranch
  await window.desktop.remoteEnable(chatId, {
    sessionId: sid,
    title: c.title,
    cwd: c.cwd,
    model: c.requestedModel,
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
  })
}

/** True when an event comes from a runner that has since been replaced. */
function stale(c: Chat, gen: number | undefined): boolean {
  return typeof gen === 'number' && typeof c.gen === 'number' && gen < c.gen
}

/** A chat with nothing typed, sent or on disk (a non-empty draft keeps it so typed text is never lost). */
function isEmptyChat(c: Chat, sessions: SessionSummary[]): boolean {
  return (
    c.messages.length === 0 &&
    c.queue.length === 0 &&
    c.pending.length === 0 &&
    c.attachments.length === 0 &&
    c.comments.length === 0 &&
    !c.draft.trim() &&
    c.status !== 'running' &&
    c.status !== 'compacting' &&
    (!c.sessionId || !sessions.some((x) => x.sessionId === c.sessionId))
  )
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
function maybeNotify(chatId: string, body: string, kind: 'done' | 'attention'): void {
  const s = useStore.getState()
  if (isPhone || !s.notifications) return
  const c = s.chats[chatId]
  if (!c) return
  // Main checks window focus; an inactive chat is out of view either way.
  void window.desktop
    .notify?.({ chatId, title: c.title || 'Claude Code', body: body || 'Claude finished', onlyIfUnfocused: s.activeChatId === chatId })
    .then((shown) => {
      if (shown && useStore.getState().notifySound) playChime(kind)
    })
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
const terminalCreating = new Set<string>()

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
  if (!isPhone) setInterval(() => void useStore.getState().tickKeepWarm(), 30_000)
  // Live runners (also those this client has not opened) drive the sidebar dots.
  void window.desktop.liveChats().then((l) => useStore.getState().setLive(l)).catch(() => {})
  window.desktop.onLiveChanged((l) => useStore.getState().setLive(l))
  window.desktop.onSharedPrefChanged(({ key, value }) => {
    if (SHARED_PREFS.includes(key)) applyShared(key, value)
  })
  if (isPhone) {
    window.desktop.onReconnected?.(() => {
      void syncSharedPrefs()
      void reattachAll()
    })
    // Android back = leave the chat for the list. One history entry per open chat view.
    let inChatEntry = false
    let ignorePop = false
    useStore.subscribe((s) => {
      if (s.activeChatId && !inChatEntry) {
        inChatEntry = true
        history.pushState({ ccdChat: s.activeChatId }, '')
      } else if (!s.activeChatId && inChatEntry) {
        inChatEntry = false
        ignorePop = true
        history.back()
      }
    })
    window.addEventListener('popstate', () => {
      if (ignorePop) {
        ignorePop = false
        return
      }
      if (inChatEntry) {
        inChatEntry = false
        useStore.getState().activate(null)
      }
    })
  }
  // Keep the changes badge fresh: refresh the folder whenever another chat becomes active.
  let lastChangesChat: string | null = null
  useStore.subscribe((s) => {
    if (s.activeChatId === lastChangesChat) return
    lastChangesChat = s.activeChatId
    const cwd = s.activeChatId ? s.chats[s.activeChatId]?.cwd : undefined
    if (cwd) void s.refreshChanges(cwd)
  })
  // Empty chats leave when they lose the focus (like claude.ai).
  let lastActiveChat: string | null = null
  useStore.subscribe((s) => {
    if (s.activeChatId === lastActiveChat) return
    const prev = lastActiveChat
    lastActiveChat = s.activeChatId
    if (prev && s.chats[prev] && isEmptyChat(s.chats[prev], s.sessions)) useStore.getState().closeTab(prev)
  })
  window.desktop.onAgentEvent(({ chatId, gen, message }) => {
    const before = useStore.getState().chats[chatId]
    if (!before) return autoAttach(chatId)
    if (stale(before, gen)) return
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
    maybeNotify(chatId, clip120(lastAssistantText(c)), 'done')
  })
  window.desktop.onPermissionRequest((req) => {
    if (!useStore.getState().chats[req.chatId]) return autoAttach(req.chatId)
    useStore.setState((s) => {
      const c = s.chats[req.chatId]
      if (!c) return
      c.pending.push(req)
      if (s.activeChatId !== req.chatId || !document.hasFocus()) c.unread = true
    })
    maybeNotify(req.chatId, permissionText(req), 'attention')
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
  // ---- remote control
  window.desktop.onRemoteState((e) => {
    useStore.setState((s) => {
      if (e.state === 'off') delete s.remote[e.chatId]
      else s.remote[e.chatId] = e
    })
  })
  window.desktop.onRemoteMessage(({ chatId, text, uuid, images }) => {
    if (!useStore.getState().chats[chatId]) return autoAttach(chatId)
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (!c || c.closed) return
      // The sender already shows its own message.
      if (c.messages.some((m) => m.id === uuid)) return
      const blocks: Block[] | undefined = images?.length ? images.map((im) => ({ kind: 'image', mediaType: im.mediaType, data: im.data })) : undefined
      appendUserMessage(c, uuid, text, blocks)
    })
  })
  window.desktop.onRemoteSetting(({ chatId, model, permissionMode }) => {
    useStore.setState((s) => {
      const c = s.chats[chatId]
      if (!c) return
      if (model) c.requestedModel = model
      if (permissionMode) {
        c.requestedMode = permissionMode
        c.permissionMode = permissionMode
      }
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
      for (const t of c.tasks) {
        if (t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused') continue
        t.status = 'killed'
        t.endedAt = Date.now()
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
