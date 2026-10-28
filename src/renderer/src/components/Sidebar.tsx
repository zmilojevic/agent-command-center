import type React from 'react'
import { Fragment, useMemo, useRef, useState, useEffect } from 'react'
import { Plus, Search, Clock, FolderGit2, FolderPlus, ChevronRight, Pencil, Trash2, GitFork, FolderOpen, Pin, PinOff, MessageSquarePlus, ChevronsDownUp, ChevronsUpDown, XCircle, FolderX, Flame, Snowflake, Check, MessageCircle, GitBranchPlus, Code, SquareTerminal, Smartphone, SlidersHorizontal, Workflow } from 'lucide-react'
import { openFolderInEditor, openTerminalAt } from '../openIn'
import { useStore, KEEP_WARM_MAX_IDLE_MS, isGeneral, engineFor } from '../store'
import { EFFORT_LEVELS, type SessionSummary, type LiveChat, type ModelChoice, type Engine } from '@shared/types'
import { latestModels, projectName, projectRoot, worktreeOf, relativeTime, shortPath, modelLabel, defaultContextWindow, fmtTokens, fmtElapsed, isMac, isPhone } from '../util'
import type { Subagent } from '../reduce'
import { useNow } from '../hooks'
import { useExitList, animateOut, resetOut } from '../useExitList'
import { subagentLine } from './ToolCard'
import type { Chat } from '../store'
import type { SessionMeta } from '@shared/types'
import { dotState, DOT_TITLE, type DotState } from './TopBar'
import Dropdown from './Dropdown'
import { useTooltip } from './Tooltip'

// An expanded project with no listed chats collapses itself after this long.
const EMPTY_COLLAPSE_MS = 5_000

const WINDOWS = [
  { hours: 6, label: 'Last 6 hours' },
  { hours: 14, label: 'Last 14 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last week' },
  { hours: 0, label: 'All sessions' },
]

interface Group {
  cwd: string
  name: string
  sessions: SessionSummary[]
  latest: number
  pinned: boolean
  /** The "Chats" section: general conversations, listed after all projects. */
  general?: boolean
}

const notInert = (x: HTMLElement): boolean => !x.closest('[inert]')

// Animated expand/collapse of a project's body. Children stay mounted while closing; the first render never animates.
function GroupBody({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      let r2 = 0
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(r1)
        cancelAnimationFrame(r2)
      }
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 200)
    return () => clearTimeout(t)
  }, [open])
  if (!mounted) return null
  return (
    <div className={`group-body${shown ? ' open' : ''}`} inert={!open}>
      <div className="group-body-inner">{children}</div>
    </div>
  )
}

/** Focus the composer textarea once it is mounted (retries a few frames after a chat opens). */
function focusComposer(tries = 10) {
  if (isPhone) return // would pop the on-screen keyboard over the conversation
  const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (ta) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusComposer(tries - 1))
}

/**
 * Focus the composer as soon as the opened session is the active chat. openSession only resolves
 * after the runner has started (seconds for a resume), and the Composer's own chatId effect skips
 * focus while the clicked sidebar row holds it, so waiting for the promise left the prompt unfocused.
 */
function focusWhenActive(sessionId: string, tries = 150) {
  if (isPhone) return
  const st = useStore.getState()
  const c = st.activeChatId ? st.chats[st.activeChatId] : undefined
  if (c?.sessionId === sessionId) focusComposer()
  else if (tries > 0) setTimeout(() => focusWhenActive(sessionId, tries - 1), 16)
}

function openAndFocus(open: (s: SessionSummary) => Promise<void>, s: SessionSummary) {
  focusWhenActive(s.sessionId)
  void open(s).then(() => requestAnimationFrame(() => focusComposer()))
}

export default function Sidebar() {
  const tooltip = useTooltip()
  const sessions = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.sessionsLoaded)
  const hiddenSessions = useStore((s) => s.hiddenSessions)
  const sessionSortTime = useStore((s) => s.sessionSortTime)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const recentHours = useStore((s) => s.recentHours)
  const setRecentHours = useStore((s) => s.setRecentHours)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const agentView = useStore((s) => s.agentView)
  const openSession = useStore((s) => s.openSession)
  const closeTab = useStore((s) => s.closeTab)
  const setShowNewDialog = useStore((s) => s.setShowNewDialog)
  const pinnedProjects = useStore((s) => s.pinnedProjects)
  const pinProject = useStore((s) => s.pinProject)
  const unpinProject = useStore((s) => s.unpinProject)
  const projectOrder = useStore((s) => s.projectOrder)
  const setProjectOrder = useStore((s) => s.setProjectOrder)
  const projectNames = useStore((s) => s.projectNames)
  const renameProject = useStore((s) => s.renameProject)
  const [defaultsFor, setDefaultsFor] = useState<{ cwd: string; name: string } | null>(null)
  const [renamingProject, setRenamingProject] = useState<{ cwd: string; name: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const newChat = useStore((s) => s.newChat)
  const codexOn = useStore((s) => !!s.codexStatus?.installed)
  const newGeneralChat = useStore((s) => s.newGeneralChat)
  const generalDir = useStore((s) => s.generalDir)
  const lastMode = useStore((s) => s.lastMode)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; g: Group } | null>(null)
  const meta = useStore((s) => s.meta)
  const keepWarm = useStore((s) => s.keepWarm)
  const liveRunners = useStore((s) => s.live)
  const warmedAt = useStore((s) => s.warmedAt)
  const setKeepWarm = useStore((s) => s.setKeepWarm)
  const remoteSessions = useStore((s) => s.remoteSessions)
  const remoteStates = useStore((s) => s.remote)
  const setRemote = useStore((s) => s.setRemote)
  const modelMax = useStore((s) => s.modelMax)
  const loadMeta = useStore((s) => s.loadMeta)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const renameSession = useStore((s) => s.renameSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const removeProject = useStore((s) => s.removeProject)
  const [removing, setRemoving] = useState<{ g: Group; count: number } | null>(null)
  // ---- worktrees
  const [wtNew, setWtNew] = useState<{ cwd: string; name: string; error?: string; busy?: boolean } | null>(null)
  const [wtRemove, setWtRemove] = useState<{ chatId?: string; path: string; name: string; error?: string; busy?: boolean } | null>(null)
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('collapsedProjects') ?? '{}')
    } catch {
      return {}
    }
  })
  const setCollapsed = (next: Record<string, boolean>): void => {
    setCollapsedState(next)
    try {
      localStorage.setItem('collapsedProjects', JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }
  const emptyTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionSummary } | null>(null)
  const [home, setHome] = useState('')
  const [renaming, setRenaming] = useState<{ s: SessionSummary; title: string } | null>(null)

  useEffect(() => {
    void window.desktop.homeDir().then(setHome)
  }, [])

  const openBySession = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of Object.values(chats)) if (c.sessionId && !c.closed) m[c.sessionId] = c.chatId
    return m
  }, [chats])

  const onDisk = useMemo(() => new Set(sessions.map((s) => s.sessionId)), [sessions])

  // Projects in their saved order, then the general "Chats" group (always, unless a search matches nothing in it).
  const allGroups = useMemo<Group[]>(() => {
    const q = search.trim().toLowerCase()
    // Search ignores the time window; browsing applies it.
    const cutoff = q || recentHours <= 0 ? 0 : Date.now() - recentHours * 3600_000
    const hidden = new Set(hiddenSessions)
    const byCwd = new Map<string, Group>()
    const general: Group = { cwd: generalDir, name: 'Chats', sessions: [], latest: 0, pinned: false, general: true }
    for (const dir of pinnedProjects) {
      if (dir === generalDir) continue
      if (q && !`${dir} ${projectNames[dir] ?? ''}`.toLowerCase().includes(q)) continue
      byCwd.set(dir, { cwd: dir, name: projectName(projectNames, dir), sessions: [], latest: 0, pinned: true })
    }
    for (const s of sessions) {
      if (!s.cwd || hidden.has(s.sessionId)) continue
      if (s.lastModified < cutoff) continue
      if (q) {
        const hay = `${s.customTitle ?? ''} ${s.summary ?? ''} ${s.firstPrompt ?? ''} ${s.cwd === generalDir ? '' : `${s.cwd} ${projectNames[s.cwd] ?? ''}`} ${s.sessionId}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      const root = projectRoot(s.cwd)
      let g = s.cwd === generalDir ? general : byCwd.get(root)
      if (!g) {
        g = { cwd: root, name: projectName(projectNames, root), sessions: [], latest: 0, pinned: false }
        byCwd.set(root, g)
      }
      g.sessions.push(s)
      g.latest = Math.max(g.latest, s.lastModified)
    }
    // Open chats whose transcript is not on disk yet (new, cleared, forked) get a placeholder row.
    const known = new Set(sessions.map((s) => s.sessionId))
    for (const c of Object.values(chats)) {
      if (!c.sessionId || c.closed || known.has(c.sessionId) || hidden.has(c.sessionId)) continue
      if (q && !`${c.title} ${c.cwd === generalDir ? '' : `${c.cwd} ${projectNames[c.cwd] ?? ''}`} ${c.sessionId}`.toLowerCase().includes(q)) continue
      const s: SessionSummary = { sessionId: c.sessionId, summary: c.title, lastModified: c.createdAt ?? 0, createdAt: c.createdAt, cwd: c.cwd, ...(c.engine === 'codex' ? { engine: 'codex' as const } : {}) }
      const root = projectRoot(c.cwd)
      let g = c.cwd === generalDir ? general : byCwd.get(root)
      if (!g) {
        g = { cwd: root, name: projectName(projectNames, root), sessions: [], latest: 0, pinned: false }
        byCwd.set(root, g)
      }
      g.sessions.push(s)
      g.latest = Math.max(g.latest, s.lastModified)
    }
    const out = [...byCwd.values()]
    // Newest-created first; a cleared chat's replacement session inherits the old row's
    // sort time (sessionSortTime), so it keeps its slot.
    const sortTime = (x: SessionSummary): number => sessionSortTime[x.sessionId] ?? x.createdAt ?? x.lastModified
    out.push(general)
    for (const g of out) g.sessions.sort((a, b) => sortTime(b) - sortTime(a))
    // Projects keep their saved order no matter which one was active last; a project
    // seen for the first time goes to the top once and is then frozen in place too.
    const projects = out.filter((g) => !g.general)
    projects.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ia = projectOrder.indexOf(a.cwd)
      const ib = projectOrder.indexOf(b.cwd)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return 1
      if (ib !== -1) return -1
      return b.latest - a.latest
    })
    return q && general.sessions.length === 0 ? projects : [...projects, general]
  }, [sessions, chats, search, recentHours, pinnedProjects, projectOrder, projectNames, hiddenSessions, sessionSortTime, generalDir])
  const groups = useMemo(() => allGroups.filter((g) => !g.general), [allGroups])
  // Exit transitions: removed rows / projects stay (leaving) until their collapse animation has run.
  const exitReset = search + '|' + recentHours
  const shownGroups = useExitList(allGroups, (g) => g.cwd, { resetKey: exitReset })
  const shownRows = useExitList(
    allGroups.flatMap((g) => g.sessions.map((s) => ({ cwd: g.cwd, s }))),
    (x) => x.s.sessionId,
    { resetKey: exitReset, groupOf: (x) => x.cwd },
  )
  const rowsByCwd = useMemo(() => {
    const m = new Map<string, typeof shownRows>()
    for (const e of shownRows) {
      const l = m.get(e.item.cwd)
      if (l) l.push(e)
      else m.set(e.item.cwd, [e])
    }
    return m
  }, [shownRows])

  // Persist the slot of every project as soon as it shows up so activity never reorders it.
  useEffect(() => {
    const fresh = groups.map((g) => g.cwd).filter((c) => !projectOrder.includes(c))
    if (fresh.length) setProjectOrder([...fresh, ...projectOrder])
  }, [groups, projectOrder, setProjectOrder])

  const samePinState = (a: string, b: string): boolean =>
    groups.find((g) => g.cwd === a)?.pinned === groups.find((g) => g.cwd === b)?.pinned

  const moveProject = (from: string, before: string): void => {
    if (from === before) return
    const order = groups.map((g) => g.cwd).filter((c) => c !== from)
    const idx = order.indexOf(before)
    order.splice(idx === -1 ? order.length : idx, 0, from)
    // Keep projects that are currently hidden by the filter in their old relative place.
    const hidden = projectOrder.filter((c) => !order.includes(c))
    setProjectOrder([...order, ...hidden])
  }

  useEffect(() => {
    const items = allGroups.flatMap((g) => g.sessions.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd!, ...(x.engine ? { engine: x.engine } : {}) })))
    void loadMeta(items)
  }, [allGroups, loadMeta])

  // Summarise the open chats of a project for its collapsed header: waiting-on-you beats busy beats finished-unseen.
  const groupDot = (g: Group): 'ask' | 'busy' | 'on' | null => {
    let state: 'busy' | 'on' | null = null
    for (const x of g.sessions) {
      const c = openBySession[x.sessionId] ? chats[openBySession[x.sessionId]] : undefined
      if (!c) {
        const l = liveRunners[x.sessionId]
        if (l?.pendingCount) return 'ask'
        if (l && (l.status === 'running' || l.status === 'compacting')) state = 'busy'
        continue
      }
      const d = dotState(c)
      if (d === 'ask') return 'ask'
      if (d === 'busy') state = 'busy'
      else if (d === 'on' && !state) state = 'on'
    }
    return state
  }

  const isCollapsedGroup = (g: Group): boolean => collapsed[g.cwd] ?? (g.sessions.length > 12 && !search)
  const prevCounts = useRef<{ key: string; counts: Map<string, number> }>({ key: exitReset, counts: new Map() })
  const collapseNow = (cwd: string): void =>
    setCollapsedState((prev) => {
      const next = { ...prev, [cwd]: true }
      try {
        localStorage.setItem('collapsedProjects', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  useEffect(() => {
    const timers = emptyTimers.current
    const prev = prevCounts.current
    const sameFilter = prev.key === exitReset
    const emptied = new Set<string>()
    if (sameFilter && !search.trim()) {
      for (const g of allGroups) {
        if (!g.general && (prev.counts.get(g.cwd) ?? 0) > 0 && g.sessions.length === 0 && !isCollapsedGroup(g)) emptied.add(g.cwd)
      }
    }
    prevCounts.current = { key: exitReset, counts: new Map(allGroups.map((g) => [g.cwd, g.sessions.length])) }
    for (const cwd of emptied) collapseNow(cwd)
    const eligible = new Set(
      allGroups
        .filter((g) => !g.general && !search.trim() && g.sessions.length === 0 && !isCollapsedGroup(g) && !emptied.has(g.cwd))
        .map((g) => g.cwd)
    )
    for (const [cwd, t] of timers) {
      if (!eligible.has(cwd)) {
        clearTimeout(t)
        timers.delete(cwd)
      }
    }
    for (const cwd of eligible) {
      if (timers.has(cwd)) continue
      timers.set(
        cwd,
        setTimeout(() => {
          timers.delete(cwd)
          collapseNow(cwd)
        }, EMPTY_COLLAPSE_MS)
      )
    }
  }, [allGroups, collapsed, search, recentHours])
  useEffect(() => {
    const timers = emptyTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])
  const allCollapsed = allGroups.length > 0 && allGroups.every(isCollapsedGroup)

  // When the user switches chat, expand its project if needed and scroll its row into
  // view, once. Later session updates must not re-expand or re-scroll anything.
  const activeSessionId = activeChatId ? chats[activeChatId]?.sessionId : undefined
  const revealedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!activeSessionId || revealedFor.current === activeSessionId) return
    const g = allGroups.find((x) => x.sessions.some((y) => y.sessionId === activeSessionId))
    if (!g) return
    if (isCollapsedGroup(g)) {
      setCollapsed({ ...collapsed, [g.cwd]: false })
      return // re-runs once the rows exist
    }
    revealedFor.current = activeSessionId
    const reveal = (): void => document.querySelector('.sidebar .row.active')?.scrollIntoView({ block: 'nearest' })
    const raf = requestAnimationFrame(reveal)
    // a just-expanded body is still growing from 0fr; scroll again once the transition is done
    const timer = setTimeout(reveal, 220)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [activeSessionId, allGroups, collapsed])

  const addProject = async (): Promise<void> => {
    const dir = await window.desktop.pickFolder(pinnedProjects[0])
    if (dir) pinProject(dir)
  }
  const quickChat = (cwd: string): void => {
    void newChat({ cwd, permissionMode: lastMode })
  }
  const expandGroup = (g: Group): void => {
    setCollapsed({ ...collapsed, [g.cwd]: false })
    if (g.sessions.length === 0 && !search.trim()) {
      if (g.general) void newGeneralChat()
      else quickChat(g.cwd)
      requestAnimationFrame(() => focusComposer())
    }
  }

  useEffect(() => {
    if (!menu && !groupMenu) return
    const close = (): void => {
      setMenu(null)
      setGroupMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // Register on the next tick: React flushes this effect synchronously while the
    // opening contextmenu event is still bubbling, which would close the menu at once.
    const t = setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('keydown', onKey)
      window.addEventListener('blur', close)
    })
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu, groupMenu])

  // window.prompt() is not supported in Electron, so renaming uses a small modal.
  const onRename = async (s: SessionSummary): Promise<void> => {
    setRenaming({ s, title: s.customTitle || s.summary || '' })
  }
  const commitRename = async (): Promise<void> => {
    if (!renaming) return
    const t = renaming.title.trim()
    setRenaming(null)
    if (t) await renameSession(renaming.s, t)
  }
  const commitRenameProject = (): void => {
    if (!renamingProject) return
    renameProject(renamingProject.cwd, renamingProject.name)
    setRenamingProject(null)
  }
  const onDelete = async (s: SessionSummary): Promise<void> => {
    await deleteSession(s)
  }
  // Counts every transcript of the folder, not just those inside the time window.
  const onRemoveProject = (g: Group): void => {
    const count = sessions.filter((x) => x.cwd && projectRoot(x.cwd) === g.cwd).length
    if (count === 0) void removeProject(g.cwd)
    else setRemoving({ g, count })
  }
  const commitWtNew = async (): Promise<void> => {
    if (!wtNew || wtNew.busy) return
    const name = wtNew.name.trim()
    setWtNew({ ...wtNew, name, busy: true, error: undefined })
    const res = await window.desktop.worktreeAdd(wtNew.cwd, name)
    if ('error' in res) {
      setWtNew({ ...wtNew, name, error: res.error })
      return
    }
    setWtNew(null)
    quickChat(res.path)
    requestAnimationFrame(() => focusComposer())
  }
  const commitWtRemove = async (): Promise<void> => {
    if (!wtRemove || wtRemove.busy) return
    setWtRemove({ ...wtRemove, busy: true, error: undefined })
    if (wtRemove.chatId) closeTab(wtRemove.chatId)
    const res = await window.desktop.worktreeRemove(wtRemove.path, true)
    if (res.error) setWtRemove({ ...wtRemove, error: res.error })
    else setWtRemove(null)
  }
  const commitRemove = async (): Promise<void> => {
    if (!removing) return
    setRemoving(null)
    await removeProject(removing.g.cwd)
  }

  // Keyboard navigation over the visible headers and rows (arrows, Home/End); Right/Left
  // expand/collapse a project, Left on a chat jumps to its project. Typing a character
  // hands focus to the composer so the key lands there (except "/", which focuses search).
  // Up from the first entry returns to the search field; Delete (without Alt) on a chat row deletes it
  // (or just closes a chat without transcript) and focuses the row now at that position.
  const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.group-head, .row')].filter(notInert)
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.group-head, .row')
    if (el) navigate(e.currentTarget, el, e)
  }
  const navigate = (root: HTMLElement, el: HTMLElement, e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void }): void => {
    const items = focusables(root)
    const i = items.indexOf(el)
    const isHead = el.classList.contains('group-head')
    const cwd = isHead ? el.dataset.cwd! : el.closest<HTMLElement>('.group')?.querySelector<HTMLElement>('.group-head')?.dataset.cwd
    const g = allGroups.find((x) => x.cwd === cwd)
    const move = (j: number): void => {
      e.preventDefault()
      items[Math.max(0, Math.min(items.length - 1, j))]?.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(i + 1)
      case 'ArrowUp':
        if (i === 0) {
          e.preventDefault()
          return searchRef.current?.focus()
        }
        return move(i - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(items.length - 1)
      case 'ArrowRight':
        if (!g) return
        e.preventDefault()
        if (isHead && isCollapsedGroup(g)) expandGroup(g)
        else if (isHead) items[i + 1]?.classList.contains('row') && items[i + 1].focus()
        return
      case 'ArrowLeft':
        if (!g) return
        e.preventDefault()
        if (isHead) setCollapsed({ ...collapsed, [g.cwd]: true })
        else el.closest<HTMLElement>('.group')?.querySelector<HTMLElement>('.group-head')?.focus()
        return
      case 'Enter':
      case ' ':
        if (isHead && g) {
          e.preventDefault()
          if (isCollapsedGroup(g)) expandGroup(g)
          else setCollapsed({ ...collapsed, [g.cwd]: true })
        }
        return
      case 'Delete': {
        if (isHead || e.altKey) return
        const sess = allGroups.flatMap((x) => x.sessions).find((x) => x.sessionId === el.dataset.sid)
        if (!sess) return
        e.preventDefault()
        const rowIdx = items.filter((x) => x.classList.contains('row')).indexOf(el)
        const head = el.closest<HTMLElement>('.group')?.querySelector<HTMLElement>('.group-head')
        void (async () => {
          if (onDisk.has(sess.sessionId)) await deleteSession(sess)
          else if (openBySession[sess.sessionId]) closeTab(openBySession[sess.sessionId])
          requestAnimationFrame(() => {
            const rows = [...root.querySelectorAll<HTMLElement>('.row')].filter(notInert)
            if (rows.length) rows[Math.min(rowIdx, rows.length - 1)].focus()
            else if (head?.isConnected) head.focus()
            else searchRef.current?.focus()
          })
        })()
        return
      }
      default:
        if (e.key !== '/' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
        }
    }
  }

  // Arrow keys pressed anywhere outside a text field, menu or dialog drive the list too,
  // starting from the active chat's row (or the first entry).
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const root = scrollRef.current
      const t = e.target as HTMLElement | null
      if (!root || !t || root.contains(t)) return
      if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .modal-backdrop, .dd-menu, .context-menu')) return
      if (document.querySelector('.modal-backdrop, .dd-menu, .context-menu')) return
      const items = focusables(root)
      if (!items.length) return
      const start = root.querySelector<HTMLElement>('.row.active')
      e.preventDefault()
      if (!start) return items[0].focus()
      start.focus()
      navigateRef.current(root, start, e)
    }
    // "/" outside a text field focuses the search input.
    const onSlash = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      if (document.querySelector('.modal-backdrop, .dd-menu, .context-menu')) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onSlash)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onSlash)
    }
  }, [])

  // Tab / Shift+Tab (bubble phase, so composer pickers that complete with Tab have already called preventDefault) and
  // Ctrl+Tab / Ctrl+Shift+Tab (capture phase, works everywhere incl. terminal and text fields) open the next/previous
  // rendered row immediately on every press. `lastTarget` is the row opened by the previous press (React may not
  // have re-rendered yet); it is only trusted for 1 s.
  const allGroupsRef = useRef(allGroups)
  allGroupsRef.current = allGroups
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession
  const lastTargetRef = useRef<{ sid: string; at: number } | null>(null)
  useEffect(() => {
    const step = (e: KeyboardEvent): void => {
      const root = scrollRef.current
      if (!root) return
      const rows = Array.from(root.querySelectorAll<HTMLElement>('.row[data-sid]')).filter(notInert)
      if (!rows.length) return
      const st = useStore.getState()
      const active = st.activeChatId ? st.chats[st.activeChatId]?.sessionId : undefined
      const lt = lastTargetRef.current
      const last = lt && Date.now() - lt.at < 1000 ? lt.sid : null
      const startSid = last && rows.some((r) => r.dataset.sid === last) ? last : active
      const from = startSid ? rows.findIndex((r) => r.dataset.sid === startSid) : -1
      const n = rows.length
      const next = e.shiftKey ? (from < 0 ? n - 1 : (from - 1 + n) % n) : from < 0 ? 0 : (from + 1) % n
      const sid = rows[next].dataset.sid!
      rows[next].scrollIntoView({ block: 'nearest' })
      lastTargetRef.current = { sid, at: Date.now() }
      if (sid === active) return
      const sess = allGroupsRef.current.flatMap((x) => x.sessions).find((x) => x.sessionId === sid)
      if (sess) openAndFocus(openSessionRef.current, sess)
    }
    const overlayOpen = (): boolean => !!document.querySelector('.modal-backdrop, .dd-menu, .context-menu')
    const onCtrlDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !(e.ctrlKey || (e.metaKey && !isMac)) || e.altKey || !scrollRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (overlayOpen()) return
      step(e)
    }
    const onPlainDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || !scrollRef.current) return
      const t = e.target as HTMLElement | null
      if (t?.closest('.term-panel')) return
      if (t?.closest('input, select, [contenteditable=""], [contenteditable="true"]')) return
      if (t?.closest('textarea') && !t.matches('.composer textarea')) return
      if (overlayOpen()) return
      e.preventDefault()
      step(e)
    }
    window.addEventListener('keydown', onCtrlDown, true)
    window.addEventListener('keydown', onPlainDown)
    return () => {
      window.removeEventListener('keydown', onCtrlDown, true)
      window.removeEventListener('keydown', onPlainDown)
    }
  }, [])

  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    setResizing(true)
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizing) return
    const sb = e.currentTarget.closest('.sidebar')
    if (!sb) return
    setSidebarWidth(Math.min(e.clientX - sb.getBoundingClientRect().left, window.innerWidth * 0.5))
  }
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    setResizing(false)
  }

  return (
    <aside className="sidebar">
      {!isPhone && <div
        className={'sb-resize' + (resizing ? ' dragging' : '')}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setSidebarWidth(390)}
      />}
      {tooltip.node}
      <div className="sidebar-head drag">
        <Dropdown
          className="no-drag window-select"
          title="Show sessions active within this window"
          icon={<Clock size={13} />}
          value={String(recentHours)}
          options={WINDOWS.map((w) => ({ value: String(w.hours), label: w.label }))}
          onChange={(v) => setRecentHours(Number(v))}
        />
        <div className="head-actions no-drag">
          <button
            className="icon-btn"
            title={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
            onClick={() => {
              const next: Record<string, boolean> = {}
              for (const g of allGroups) next[g.cwd] = !allCollapsed
              setCollapsed(next)
            }}
          >
            {allCollapsed ? <ChevronsUpDown size={16} /> : <ChevronsDownUp size={16} />}
          </button>
        </div>
      </div>

      <div className="sidebar-actions">
        <label className="search">
          <Search size={14} />
          <input
            ref={searchRef}
            placeholder="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' || !scrollRef.current) return
              const first = focusables(scrollRef.current)[0]
              if (!first) return
              e.preventDefault()
              first.focus()
            }}
          />
        </label>
      </div>

      <div className="sidebar-scroll" ref={scrollRef} onKeyDown={onListKey}>
        {!loaded && <div className="muted pad">Loading sessions…</div>}
        {loaded && allGroups.length === 0 && (
          <div className="muted pad">
            {search ? 'No sessions match.' : recentHours > 0 ? `No sessions in the last ${recentHours} hours.` : 'No sessions found.'}
          </div>
        )}

        {shownGroups.map(({ item: g, leaving: groupLeaving }) => {
          const isCollapsed = isCollapsedGroup(g)
          const bucket = groupLeaving ? g.sessions.map((s) => ({ item: { cwd: g.cwd, s }, key: s.sessionId, leaving: false })) : (rowsByCwd.get(g.cwd) ?? [])
          return (
            <div
              className={`group${groupLeaving ? ' leaving' : ''}`}
              key={g.cwd}
              inert={groupLeaving}
              ref={(el) => (groupLeaving ? animateOut(el) : resetOut(el))}
            >
              <div
                className={`group-head ${dragOver === g.cwd && dragging !== g.cwd ? 'drag-over' : ''} ${dragging === g.cwd ? 'dragging' : ''}`}
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                data-cwd={g.cwd}
                draggable={!g.general}
                {...(g.general ? {} : tooltip.bind(<span className="mono">{shortPath(g.cwd, home)}</span>))}
                onDragStart={(e) => {
                  if (g.general) return e.preventDefault()
                  tooltip.hide()
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', g.cwd)
                  setDragging(g.cwd)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDragOver(null)
                }}
                onDragOver={(e) => {
                  if (g.general || !dragging || !samePinState(dragging, g.cwd)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOver !== g.cwd) setDragOver(g.cwd)
                }}
                onDragLeave={() => {
                  if (dragOver === g.cwd) setDragOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (g.general) return
                  const from = e.dataTransfer.getData('text/plain') || dragging
                  if (from && samePinState(from, g.cwd)) moveProject(from, g.cwd)
                  setDragging(null)
                  setDragOver(null)
                }}
                onClick={() => (isCollapsed ? expandGroup(g) : setCollapsed({ ...collapsed, [g.cwd]: true }))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setGroupMenu({ x: e.clientX, y: e.clientY, g })
                }}
              >
                <ChevronRight size={14} className="chev" />
                {g.general ? <MessageCircle size={14} /> : g.pinned ? <Pin size={13} className="pin-icon" /> : <FolderGit2 size={14} />}
                <span className="group-title">
                  <span className="group-name">{g.name}</span>
                  {isCollapsed && g.sessions.length > 0 && <span className="count">({g.sessions.length})</span>}
                </span>
                {isCollapsed && groupDot(g) && <span className={`dot ${groupDot(g)}`} title={DOT_TITLE[groupDot(g)!]} />}
                <button
                  className="group-new"
                  title={g.general ? 'New chat' : 'New chat in this project'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (g.general) void newGeneralChat()
                    else quickChat(g.cwd)
                  }}
                >
                  <MessageSquarePlus size={14} />
                </button>
              </div>
              <GroupBody open={!isCollapsed}>
                {bucket.length === 0 && (
                  <div className="group-empty">
                    <button
                      className="btn"
                      onClick={() => {
                        if (g.general) void newGeneralChat()
                        else quickChat(g.cwd)
                        requestAnimationFrame(() => focusComposer())
                      }}
                    >
                      <MessageSquarePlus size={15} /> New chat
                    </button>
                  </div>
                )}
                {bucket.map(({ item: { s }, leaving }) => {
                    const chat = openBySession[s.sessionId] ? chats[openBySession[s.sessionId]] : undefined
                    const shownAgents = chat ? chat.subagents.filter((a) => !a.hidden || (agentView?.chatId === chat.chatId && agentView.toolUseId === a.toolUseId)) : []
                    return (
                      <Fragment key={s.sessionId}>
                        <SessionRow
                          s={s}
                          leaving={leaving}
                          chat={chat}
                          liveInfo={liveRunners[s.sessionId]}
                          active={!!openBySession[s.sessionId] && openBySession[s.sessionId] === activeChatId && agentView?.chatId !== activeChatId}
                          meta={meta[s.sessionId]}
                          modelMax={modelMax}
                          now={now}
                          compact={g.general}
                          keepWarm={keepWarm.includes(s.sessionId)}
                          remote={remoteSessions.includes(s.sessionId) ? (chat ? (remoteStates[chat.chatId]?.state ?? 'connecting') : 'on') : undefined}
                          warmedAt={warmedAt[s.sessionId]}
                          onOpen={() => openAndFocus(openSession, s)}
                          onMenu={(e) => {
                            e.preventDefault()
                            setMenu({ x: e.clientX, y: e.clientY, s })
                          }}
                          onDelete={() => {
                            if (onDisk.has(s.sessionId)) void deleteSession(s)
                            else if (openBySession[s.sessionId]) closeTab(openBySession[s.sessionId])
                          }}
                        />
                        {!leaving && chat && shownAgents.length > 0 && <SubagentList chatId={chat.chatId} agents={shownAgents} />}
                      </Fragment>
                    )
                  })}
              </GroupBody>
            </div>
          )
        })}
      </div>

      {menu && (
        <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => {
            setMenu(null)
            openAndFocus(openSession, menu.s)
          }}>
            <FolderOpen size={14} /> Open
          </button>
          {openBySession[menu.s.sessionId] && (
            <button
              onClick={() => {
                closeTab(openBySession[menu.s.sessionId])
                setMenu(null)
              }}
            >
              <XCircle size={14} /> Close chat
            </button>
          )}
          {!isPhone && menu.s.engine !== 'codex' && (onDisk.has(menu.s.sessionId) || openBySession[menu.s.sessionId]) && (
            <button
              onClick={() => {
                const on = !keepWarm.includes(menu.s.sessionId)
                setKeepWarm(menu.s.sessionId, on)
                if (on && !openBySession[menu.s.sessionId]) void openSession(menu.s, false, true)
                setMenu(null)
              }}
            >
              <Flame size={14} /> Keep cache warm
              {keepWarm.includes(menu.s.sessionId) && <Check size={14} style={{ marginLeft: 'auto' }} />}
            </button>
          )}
          {!isPhone && menu.s.engine !== 'codex' && !isGeneral(menu.s.cwd) && (onDisk.has(menu.s.sessionId) || openBySession[menu.s.sessionId]) && (
            <button
              onClick={() => {
                const on = !remoteSessions.includes(menu.s.sessionId)
                setRemote(menu.s.sessionId, on)
                if (on && !openBySession[menu.s.sessionId]) void openSession(menu.s, false, true)
                setMenu(null)
              }}
            >
              <Smartphone size={14} /> Remote control
              {remoteSessions.includes(menu.s.sessionId) && <Check size={14} style={{ marginLeft: 'auto' }} />}
            </button>
          )}
          {onDisk.has(menu.s.sessionId) && (
            <button onClick={() => void openSession(menu.s, true).then(() => {
              setMenu(null)
              requestAnimationFrame(() => focusComposer())
            })}>
              <GitFork size={14} /> Fork into new chat
            </button>
          )}
          {onDisk.has(menu.s.sessionId) && (
            <button onClick={() => void onRename(menu.s).then(() => setMenu(null))}>
              <Pencil size={14} /> Rename…
            </button>
          )}
          {!isPhone && menu.s.cwd !== generalDir && (
            <button onClick={() => void window.desktop.openPath(menu.s.cwd!).then(() => setMenu(null))}>
              <FolderGit2 size={14} /> Open project folder
            </button>
          )}
          {menu.s.cwd && worktreeOf(menu.s.cwd) && (
            <button
              onClick={() => {
                setWtRemove({ chatId: openBySession[menu.s.sessionId], path: menu.s.cwd!, name: worktreeOf(menu.s.cwd!)!.name })
                setMenu(null)
              }}
            >
              <FolderX size={14} /> Remove worktree…
            </button>
          )}
          {onDisk.has(menu.s.sessionId) && (
            <>
              <div className="sep" />
              <button className="danger" onClick={() => void onDelete(menu.s).then(() => setMenu(null))}>
                <Trash2 size={14} /> Delete transcript
              </button>
            </>
          )}
        </div>
      )}
      <div className="sidebar-foot">
        <button
          className="btn wide"
          onClick={() => {
            void newGeneralChat()
            requestAnimationFrame(() => focusComposer())
          }}
        >
          <MessageSquarePlus size={15} /> New chat
        </button>
        {!isPhone && (
          <button className="btn wide" onClick={() => void addProject()}>
            <FolderPlus size={15} /> Add project
          </button>
        )}
      </div>

      {groupMenu && (
        <div className="context-menu" style={{ left: Math.min(groupMenu.x, window.innerWidth - 230), top: Math.min(groupMenu.y, window.innerHeight - 220) }} onClick={(e) => e.stopPropagation()}>
          {groupMenu.g.general ? (
            <button onClick={() => { void newGeneralChat(); setGroupMenu(null) }}>
              <MessageSquarePlus size={14} /> New chat
            </button>
          ) : (
            <>
          <button onClick={() => { quickChat(groupMenu.g.cwd); setGroupMenu(null) }}>
            <MessageSquarePlus size={14} /> New chat here
          </button>
          {codexOn && (
            <button onClick={() => { void newChat({ cwd: groupMenu.g.cwd, permissionMode: lastMode, engine: engineFor(groupMenu.g.cwd) === 'codex' ? 'claude' : 'codex' }); setGroupMenu(null) }}>
              <MessageSquarePlus size={14} /> {engineFor(groupMenu.g.cwd) === 'codex' ? 'New Claude chat' : 'New Codex chat'}
            </button>
          )}
          <button onClick={() => { setShowNewDialog(true, groupMenu.g.cwd); setGroupMenu(null) }}>
            <Plus size={14} /> New chat here with options…
          </button>
          <button onClick={() => { setWtNew({ cwd: groupMenu.g.cwd, name: `wt-${Math.random().toString(16).slice(2, 6)}` }); setGroupMenu(null) }}>
            <GitBranchPlus size={14} /> New chat in worktree…
          </button>
          {!isPhone && (
            <>
          <button onClick={() => void window.desktop.openPath(groupMenu.g.cwd).then(() => setGroupMenu(null))}>
            <FolderOpen size={14} /> Open folder
          </button>
          <button onClick={() => { void openFolderInEditor(groupMenu.g.cwd); setGroupMenu(null) }}>
            <Code size={14} /> Open in editor
          </button>
          <button onClick={() => { void openTerminalAt(groupMenu.g.cwd); setGroupMenu(null) }}>
            <SquareTerminal size={14} /> Open in terminal
          </button>
          <button onClick={() => { useStore.getState().openWorkflows(groupMenu.g.cwd); setGroupMenu(null) }}>
            <Workflow size={14} /> Workflows…
          </button>
            </>
          )}
          <button onClick={() => { setRenamingProject({ cwd: groupMenu.g.cwd, name: groupMenu.g.name }); setGroupMenu(null) }}>
            <Pencil size={14} /> Rename project…
          </button>
          {!groupMenu.g.general && (
            <button onClick={() => { setDefaultsFor({ cwd: groupMenu.g.cwd, name: groupMenu.g.name }); setGroupMenu(null) }}>
              <SlidersHorizontal size={14} /> Default model &amp; effort…
            </button>
          )}
          <div className="sep" />
          {groupMenu.g.pinned ? (
            <button onClick={() => { unpinProject(groupMenu.g.cwd); setGroupMenu(null) }}>
              <PinOff size={14} /> Unpin project
            </button>
          ) : (
            <button onClick={() => { pinProject(groupMenu.g.cwd); setGroupMenu(null) }}>
              <Pin size={14} /> Pin project
            </button>
          )}
          <div className="sep" />
          <button className="danger" onClick={() => { onRemoveProject(groupMenu.g); setGroupMenu(null) }}>
            <FolderX size={14} /> Remove project…
          </button>
            </>
          )}
        </div>
      )}
      {removing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setRemoving(null)}>
          <div className="modal rename-modal">
            <div className="modal-head">
              <h3>Remove {removing.g.name}?</h3>
            </div>
            <p className="modal-text">
              This deletes {removing.count === 1 ? 'its one transcript' : `all ${removing.count} transcripts`} under{' '}
              <span className="mono">{shortPath(removing.g.cwd, home)}</span> and closes any open chat in it. The folder itself and
              Claude's project memory are kept.
            </p>
            <div className="modal-actions">
              <button className="btn" autoFocus onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void commitRemove()}>
                Remove project
              </button>
            </div>
          </div>
        </div>
      )}
      {wtNew && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setWtNew(null)}>
          <div className="modal rename-modal">
            <div className="modal-head">
              <h3>New chat in worktree</h3>
            </div>
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={wtNew.name}
                onChange={(e) => setWtNew({ ...wtNew, name: e.target.value, error: undefined })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitWtNew()
                  else if (e.key === 'Escape') setWtNew(null)
                }}
              />
            </label>
            <p className="modal-text muted">
              Creates <span className="mono">.claude/worktrees/{wtNew.name.trim() || '…'}</span> on a new branch{' '}
              <span className="mono">worktree-{wtNew.name.trim() || '…'}</span> from HEAD, so this chat's file changes stay apart from the others.
            </p>
            {wtNew.error && <div className="wt-error">{wtNew.error}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setWtNew(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void commitWtNew()} disabled={!wtNew.name.trim() || wtNew.busy}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {wtRemove && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setWtRemove(null)}>
          <div className="modal rename-modal">
            <div className="modal-head">
              <h3>Remove worktree {wtRemove.name}?</h3>
            </div>
            <p className="modal-text">
              This deletes the folder <span className="mono">{shortPath(wtRemove.path, home)}</span> including any uncommitted changes in it and closes
              its chat. The branch <span className="mono">worktree-{wtRemove.name}</span> and the chat transcripts are kept.
            </p>
            {wtRemove.error && <div className="wt-error">{wtRemove.error}</div>}
            <div className="modal-actions">
              <button className="btn" autoFocus onClick={() => setWtRemove(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void commitWtRemove()} disabled={wtRemove.busy}>
                Remove worktree
              </button>
            </div>
          </div>
        </div>
      )}
      {renaming && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setRenaming(null)}>
          <div className="modal rename-modal">
            <div className="modal-head">
              <h3>Rename session</h3>
            </div>
            <label className="field">
              <span>Title</span>
              <input
                autoFocus
                value={renaming.title}
                onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  else if (e.key === 'Escape') setRenaming(null)
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void commitRename()} disabled={!renaming.title.trim()}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
      {renamingProject && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setRenamingProject(null)}>
          <div className="modal rename-modal">
            <div className="modal-head">
              <h3>Rename project</h3>
            </div>
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={renamingProject.name}
                onChange={(e) => setRenamingProject({ ...renamingProject, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRenameProject()
                  else if (e.key === 'Escape') setRenamingProject(null)
                }}
              />
            </label>
            <p className="modal-text muted">
              Only changes the name shown here; the folder <span className="mono">{shortPath(renamingProject.cwd, home)}</span> is not renamed. Leave empty to use the folder name.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRenamingProject(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={commitRenameProject}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
      {defaultsFor && <ProjectDefaultsDialog cwd={defaultsFor.cwd} name={defaultsFor.name} onClose={() => setDefaultsFor(null)} />}
    </aside>
  )
}

function ProjectDefaultsDialog({ cwd, name, onClose }: { cwd: string; name: string; onClose: () => void }) {
  const stored = useStore((s) => s.projectDefaults[cwd])
  const lastModel = useStore((s) => s.lastModel)
  const lastCodexModel = useStore((s) => s.lastCodexModel)
  const codexOn = useStore((s) => !!s.codexStatus?.installed)
  const codexModels = useStore((s) => s.codexModels)
  const setProjectDefaults = useStore((s) => s.setProjectDefaults)
  const [engine, setEngine] = useState<Engine>(stored?.engine === 'codex' && codexOn ? 'codex' : 'claude')
  const [model, setModel] = useState(stored?.model ?? '')
  const [effort, setEffort] = useState(stored?.effort ?? '')
  const [claudeModels, setClaudeModels] = useState<ModelChoice[]>([])
  const codex = engine === 'codex'
  const models = codex ? codexModels : claudeModels

  useEffect(() => {
    let alive = true
    // Open chats already know the list; use it unless main answers with one (it may be missing after a renderer-only reload).
    const known = Object.values(useStore.getState().chats).find((c) => c.engine !== 'codex' && c.models.length)?.models
    if (known) setClaudeModels(known)
    void window.desktop
      .listAllModels()
      .then((m) => alive && m.length && setClaudeModels(m))
      .catch(() => {})
    void useStore.getState().loadCodexModels()
    return () => {
      alive = false
    }
  }, [])

  const switchEngine = (e: Engine): void => {
    if (e === engine) return
    setEngine(e)
    // Model and effort belong to the engine.
    setModel('')
    setEffort('')
  }

  const labelOf = (v: string): string => models.find((m) => m.value === v)?.displayName ?? (v === 'default' ? 'Default' : modelLabel(v))
  const modelOptions: { value: string; label: string; description?: string }[] = [{ value: '', label: 'Last used', description: labelOf(codex ? lastCodexModel : lastModel) }]
  if (!models.some((m) => m.value === 'default')) modelOptions.push({ value: 'default', label: 'Default' })
  for (const m of latestModels(models)) modelOptions.push({ value: m.value, label: m.displayName, description: m.description })
  if (model && !modelOptions.some((o) => o.value === model)) modelOptions.push({ value: model, label: modelLabel(model) })

  const info = models.find((m) => m.value.toLowerCase() === model.toLowerCase())
  const effortName = (v: string): string => EFFORT_LEVELS.find((e) => e.value === v)?.label ?? v.charAt(0).toUpperCase() + v.slice(1)
  const levels: { value: string; label: string }[] = codex
    ? (info?.efforts ?? []).map((v) => ({ value: v, label: effortName(v) }))
    : info?.efforts?.length
      ? EFFORT_LEVELS.filter((e) => info.efforts!.includes(e.value))
      : EFFORT_LEVELS
  const showEffort = codex ? !model || model === 'default' || levels.length > 0 : !info || info.supportsEffort !== false
  const effortOptions = [
    { value: '', label: 'Last used' },
    { value: 'default', label: 'Default', description: "The model's default effort" },
    ...levels.map((e) => ({ value: e.value as string, label: e.label })),
  ]
  if (effort && !effortOptions.some((o) => o.value === effort)) effortOptions.push({ value: effort, label: effort })

  const save = (): void => {
    setProjectDefaults(cwd, { model: model || undefined, effort: showEffort ? effort || undefined : undefined, engine })
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal rename-modal"
        onKeyDown={(e) => {
          // Enter on a Dropdown opens/picks in it (it preventDefaults while open); only elsewhere does it save.
          if (e.key === 'Enter' && !e.defaultPrevented && !(e.target as Element).closest('.dd')) save()
          else if (e.key === 'Escape') onClose()
        }}
      >
        <div className="modal-head">
          <h3>Default model &amp; effort</h3>
        </div>
        <p className="modal-text muted">{name}</p>
        {codexOn && (
          <div className="field">
            <span>Engine</span>
            <Dropdown
              className="dd-field"
              value={engine}
              options={[
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
              ]}
              onChange={(v) => switchEngine(v as Engine)}
            />
          </div>
        )}
        <div className="field">
          <span>Model</span>
          <Dropdown className="dd-field" value={model} options={modelOptions} onChange={setModel} />
        </div>
        {showEffort && (
          <div className="field">
            <span>Effort</span>
            <Dropdown className="dd-field" value={effort} options={effortOptions} onChange={setEffort} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  s,
  leaving,
  chat,
  liveInfo,
  active,
  meta,
  modelMax,
  now,
  compact,
  keepWarm,
  remote,
  warmedAt,
  onOpen,
  onMenu,
  onDelete,
}: {
  s: SessionSummary
  /** Removed from the list; collapsing out, not interactive. */
  leaving?: boolean
  chat?: Chat
  /** Runner in the main process for a session this client has not opened. */
  liveInfo?: LiveChat
  active: boolean
  meta?: SessionMeta
  modelMax: Record<string, number>
  now: number
  /** Chats section: title line only. */
  compact?: boolean
  keepWarm: boolean
  /** Remote Control switched on for this session (state of the live connection, if any). */
  remote?: string
  warmedAt?: number
  onOpen: () => void
  onMenu: (e: React.MouseEvent) => void
  onDelete: () => void
}) {
  const live = chat && !chat.closed
  const model = (live && chat.model) || meta?.model
  const effort = (live && chat.effort) || meta?.effort
  const liveBusy = !live && !!liveInfo && (liveInfo.status === 'running' || liveInfo.status === 'compacting' || liveInfo.pendingCount > 0)
  const busy = (live && (chat.status === 'running' || chat.status === 'compacting' || !!chat.pending.length)) || liveBusy
  const dot: DotState = live ? dotState(chat) : liveInfo ? (liveInfo.pendingCount > 0 ? 'ask' : liveBusy ? 'busy' : 'idle') : 'idle'
  const lastAt = (live && chat.lastResponseAt) || meta?.lastAt || s.lastModified
  const ttl = meta?.cacheTtlMs ?? 300_000
  const cacheLast = Math.max(lastAt || 0, warmedAt ?? 0)
  const cacheLeft = cacheLast ? ttl - (now - cacheLast) : -1
  const warm = !!live && keepWarm && !!lastAt && now - lastAt <= KEEP_WARM_MAX_IDLE_MS
  const frozen = !!live && keepWarm && cacheLeft <= 0
  const cache = cacheLeft > 0 ? `cache · ${Math.max(1, Math.round(cacheLeft / 60_000))}m left` : 'cache cold'
  // Orange-red with nothing left, green from 80% of the lifetime remaining.
  const frac = Math.max(0, Math.min(1, cacheLeft / ttl / 0.8))
  const cacheHue = Math.round(12 + frac * 128)
  const cacheStyle = {
    color: `hsl(${cacheHue} 22% var(--chip-l))`,
    borderColor: `hsl(${cacheHue} 20% 50% / 0.35)`,
    background: 'transparent',
  }
  // Context used: live numbers from the CLI when the chat is open, else the transcript's last turn.
  const liveCtx = live && chat.context ? chat.context : undefined
  const used = liveCtx ? liveCtx.totalTokens : meta?.contextTokens
  const ctxModel = model ?? (live ? chat.requestedModel : undefined)
  let ctxMax = liveCtx?.maxTokens || (ctxModel && modelMax[ctxModel]) || defaultContextWindow(ctxModel)
  if (used != null) ctxMax = Math.max(ctxMax, used)
  const ctxFrac = used != null && ctxMax ? used / ctxMax : -1
  // Green while little is used, drifting to orange-red as the window fills.
  const ctxHue = Math.round(140 - Math.max(0, Math.min(1, ctxFrac / 0.8)) * 128)
  const ctxStyle = {
    color: `hsl(${ctxHue} 22% var(--chip-l))`,
    borderColor: `hsl(${ctxHue} 20% 50% / 0.35)`,
    background: 'transparent',
  }
  const title = s.customTitle || s.summary || s.firstPrompt || 'Untitled'
  const wt = s.cwd ? worktreeOf(s.cwd) : null
  return (
    <button
      className={`row ${active ? 'active' : ''}${leaving ? ' leaving' : ''}`}
      inert={leaving}
      ref={(el) => (leaving ? animateOut(el) : resetOut(el))}
      data-sid={s.sessionId}
      onClick={onOpen}
      onContextMenu={onMenu}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault() // no autoscroll cursor
      }}
      onAuxClick={(e) => {
        // Middle-click = Ctrl+W on this row (delete the transcript, or close a chat that has none).
        if (e.button === 1) {
          e.preventDefault()
          onDelete()
        }
      }}
      title={s.firstPrompt}
    >
      <div className="row-line">
        {dot !== 'idle' ? <span className={`dot ${dot}`} title={DOT_TITLE[dot]} /> : <span className="dot slot" />}
        <span className="row-title">{title}</span>
        {!busy && <span className="row-time" title="Last response finished">{relativeTime(lastAt)}</span>}
      </div>
      {!compact && (
      <div className="row-line row-sub">
        <span className="dot slot" />
        {ctxFrac >= 0 && used != null && (
          <span className="cache" style={ctxStyle} title={`${fmtTokensShort(used)} of ${fmtTokensShort(ctxMax)} context used`}>
            {Math.round(ctxFrac * 100)}%
          </span>
        )}
        {s.engine === 'codex' ? (
          <span className="engine-chip" title="Runs on Codex">codex</span>
        ) : (
        <span className="cache" style={cacheStyle} title={warm ? 'Prompt cache lifetime remaining · kept warm' : 'Prompt cache lifetime remaining'}>
          {frozen ? (
            <Snowflake size={10} style={{ marginRight: 3, verticalAlign: '-1px', color: 'color-mix(in srgb, var(--ask) 80%, var(--muted))' }} />
          ) : (
            warm && <Flame size={10} style={{ marginRight: 3, verticalAlign: '-1px' }} />
          )}
          {cache}
        </span>
        )}
        <span className="cache row-model">
          {modelLabel(model ?? (live ? chat.requestedModel : undefined))}
          {effort && <span className="row-effort"> · {effort}</span>}
        </span>
        {wt && (
          <span className="wt-chip" title={`Git worktree ${wt.name}`}>
            <FolderGit2 size={10} />
            <span>{wt.name}</span>
          </span>
        )}
        {remote && (
          <span className={`row-remote ${remote}`} title={remote === 'on' ? 'Remote Control on' : remote === 'error' ? 'Remote Control error' : 'Remote Control'}>
            <Smartphone size={11} />
          </span>
        )}
        {(s.gitBranch || meta?.gitBranch) && s.gitBranch !== 'HEAD' && <span className="row-branch">{s.gitBranch || meta?.gitBranch}</span>}
      </div>
      )}
    </button>
  )
}

function fmtTokensShort(n: number): string {
  return fmtTokens(n).replace(/\.0([kM])$/, '$1')
}

/** Subagents of an open chat, nested under its row; finished ones stay dimmed until the main turn ends. */
function SubagentList({ chatId, agents }: { chatId: string; agents: Subagent[] }) {
  const now = useNow(agents.some((a) => a.status === 'running'))
  const viewing = useStore((s) => (s.agentView?.chatId === chatId ? s.agentView.toolUseId : null))
  const openAgentView = useStore((s) => s.openAgentView)
  return (
    <div className="subagents">
      {agents.map((a) => (
        <div
          key={a.toolUseId}
          role="button"
          className={`subagent ${a.status}${viewing === a.toolUseId ? ' active' : ''}`}
          onClick={() => openAgentView(chatId, a.toolUseId)}
          title={`${a.type ? a.type + ' · ' : ''}${subagentLine(a, now)}`}>
          <span className={`dot ${a.status === 'running' ? 'busy' : a.status === 'failed' ? 'failed' : 'done'}`} />
          <span className="subagent-desc">{a.description || a.type || 'Subagent'}</span>
          {a.status === 'running' && a.lastTool && <span className="subagent-tool">{a.lastTool}</span>}
          <span className="subagent-time">{fmtElapsed((a.endedAt ?? now) - a.startedAt)}</span>
        </div>
      ))}
    </div>
  )
}
