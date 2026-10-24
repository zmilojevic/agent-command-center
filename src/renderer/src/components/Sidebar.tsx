import type React from 'react'
import { Fragment, useMemo, useRef, useState, useEffect } from 'react'
import { Plus, Search, Clock, FolderGit2, FolderPlus, ChevronRight, ChevronDown, Pencil, Trash2, GitFork, FolderOpen, Pin, PinOff, MessageSquarePlus, ChevronsDownUp, ChevronsUpDown, XCircle, FolderX, Flame, Check, MessageCircle } from 'lucide-react'
import { useStore, KEEP_WARM_MAX_IDLE_MS } from '../store'
import type { SessionSummary } from '@shared/types'
import { projectName, relativeTime, shortPath, modelLabel, defaultContextWindow, fmtTokens, fmtElapsed } from '../util'
import type { Subagent } from '../reduce'
import { useNow } from '../hooks'
import { subagentLine } from './ToolCard'
import type { Chat } from '../store'
import type { SessionMeta } from '@shared/types'
import { dotState, DOT_TITLE } from './TopBar'
import Dropdown from './Dropdown'
import { useTooltip } from './Tooltip'

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

/** Focus the composer textarea once it is mounted (retries a few frames after a chat opens). */
function focusComposer(tries = 10) {
  const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (ta) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusComposer(tries - 1))
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
  const [renamingProject, setRenamingProject] = useState<{ cwd: string; name: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const newChat = useStore((s) => s.newChat)
  const newGeneralChat = useStore((s) => s.newGeneralChat)
  const generalDir = useStore((s) => s.generalDir)
  const lastModel = useStore((s) => s.lastModel)
  const lastMode = useStore((s) => s.lastMode)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; g: Group } | null>(null)
  const meta = useStore((s) => s.meta)
  const keepWarm = useStore((s) => s.keepWarm)
  const warmedAt = useStore((s) => s.warmedAt)
  const setKeepWarm = useStore((s) => s.setKeepWarm)
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
      let g = s.cwd === generalDir ? general : byCwd.get(s.cwd)
      if (!g) {
        g = { cwd: s.cwd, name: projectName(projectNames, s.cwd), sessions: [], latest: 0, pinned: false }
        byCwd.set(s.cwd, g)
      }
      g.sessions.push(s)
      g.latest = Math.max(g.latest, s.lastModified)
    }
    // Open chats whose transcript is not on disk yet (new, cleared, forked) get a placeholder row.
    const known = new Set(sessions.map((s) => s.sessionId))
    for (const c of Object.values(chats)) {
      if (!c.sessionId || c.closed || known.has(c.sessionId) || hidden.has(c.sessionId)) continue
      if (q && !`${c.title} ${c.cwd === generalDir ? '' : `${c.cwd} ${projectNames[c.cwd] ?? ''}`} ${c.sessionId}`.toLowerCase().includes(q)) continue
      const s: SessionSummary = { sessionId: c.sessionId, summary: c.title, lastModified: c.createdAt ?? 0, createdAt: c.createdAt, cwd: c.cwd }
      let g = c.cwd === generalDir ? general : byCwd.get(c.cwd)
      if (!g) {
        g = { cwd: c.cwd, name: projectName(projectNames, c.cwd), sessions: [], latest: 0, pinned: false }
        byCwd.set(c.cwd, g)
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
    const items = allGroups.flatMap((g) => g.sessions.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd! })))
    void loadMeta(items)
  }, [allGroups, loadMeta])

  // Summarise the open chats of a project for its collapsed header: waiting-on-you beats busy beats finished-unseen.
  const groupDot = (g: Group): 'ask' | 'busy' | 'on' | null => {
    let state: 'busy' | 'on' | null = null
    for (const x of g.sessions) {
      const c = openBySession[x.sessionId] ? chats[openBySession[x.sessionId]] : undefined
      if (!c) continue
      const d = dotState(c)
      if (d === 'ask') return 'ask'
      if (d === 'busy') state = 'busy'
      else if (d === 'on' && !state) state = 'on'
    }
    return state
  }

  const isCollapsedGroup = (g: Group): boolean => collapsed[g.cwd] ?? (g.sessions.length > 12 && !search)
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
    const raf = requestAnimationFrame(() => {
      document.querySelector('.sidebar .row.active')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, allGroups, collapsed])

  const addProject = async (): Promise<void> => {
    const dir = await window.desktop.pickFolder(pinnedProjects[0])
    if (dir) pinProject(dir)
  }
  const quickChat = (cwd: string): void => {
    void newChat({ cwd, model: lastModel, permissionMode: lastMode })
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
    const count = sessions.filter((x) => x.cwd === g.cwd).length
    if (count === 0) void removeProject(g.cwd)
    else setRemoving({ g, count })
  }
  const commitRemove = async (): Promise<void> => {
    if (!removing) return
    setRemoving(null)
    await removeProject(removing.g.cwd)
  }

  // Keyboard navigation over the visible headers and rows (arrows, Home/End); Right/Left
  // expand/collapse a project, Left on a chat jumps to its project. Typing a character
  // hands focus to the composer so the key lands there (except "/", which focuses search).
  // Up from the first entry returns to the search field; Delete on a chat row deletes it
  // (or just closes a chat without transcript) and focuses the row now at that position.
  const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.group-head, .row')]
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
        if (isHead && isCollapsedGroup(g)) setCollapsed({ ...collapsed, [g.cwd]: false })
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
          setCollapsed({ ...collapsed, [g.cwd]: !isCollapsedGroup(g) })
        }
        return
      case 'Delete': {
        if (isHead) return
        const sess = allGroups.flatMap((x) => x.sessions).find((x) => x.sessionId === el.dataset.sid)
        if (!sess) return
        e.preventDefault()
        const rowIdx = items.filter((x) => x.classList.contains('row')).indexOf(el)
        const head = el.closest<HTMLElement>('.group')?.querySelector<HTMLElement>('.group-head')
        void (async () => {
          if (onDisk.has(sess.sessionId)) await deleteSession(sess)
          else if (openBySession[sess.sessionId]) closeTab(openBySession[sess.sessionId])
          requestAnimationFrame(() => {
            const rows = root.querySelectorAll<HTMLElement>('.row')
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

  // Ctrl+Tab / Ctrl+Shift+Tab cycle a highlight over the rendered rows; the chat opens when Ctrl is released.
  const allGroupsRef = useRef(allGroups)
  allGroupsRef.current = allGroups
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession
  const cycleRef = useRef<{ sid: string; release: 'Control' | 'Meta' } | null>(null)
  useEffect(() => {
    const clear = (): void => {
      cycleRef.current = null
      scrollRef.current?.querySelectorAll('.row.cycle-target').forEach((el) => el.classList.remove('cycle-target'))
    }
    const onDown = (e: KeyboardEvent): void => {
      const root = scrollRef.current
      if (e.key === 'Escape' && cycleRef.current) {
        e.preventDefault()
        e.stopPropagation()
        clear()
        return
      }
      if (e.key !== 'Tab' || !(e.ctrlKey || e.metaKey) || e.altKey || !root) return
      e.preventDefault()
      e.stopPropagation()
      if (document.querySelector('.modal-backdrop, .dd-menu, .context-menu')) return
      const rows = Array.from(root.querySelectorAll<HTMLElement>('.row[data-sid]'))
      if (!rows.length) return
      const cur = cycleRef.current
      const from = cur ? rows.findIndex((r) => r.dataset.sid === cur.sid) : rows.findIndex((r) => r.classList.contains('active'))
      const n = rows.length
      const next = e.shiftKey ? (from < 0 ? n - 1 : (from - 1 + n) % n) : from < 0 ? 0 : (from + 1) % n
      root.querySelectorAll('.row.cycle-target').forEach((el) => el.classList.remove('cycle-target'))
      rows[next].classList.add('cycle-target')
      rows[next].scrollIntoView({ block: 'nearest' })
      cycleRef.current = { sid: rows[next].dataset.sid!, release: cur?.release ?? (e.ctrlKey ? 'Control' : 'Meta') }
    }
    const onUp = (e: KeyboardEvent): void => {
      const cur = cycleRef.current
      if (!cur || e.key !== cur.release) return
      const st = useStore.getState()
      const active = st.activeChatId ? st.chats[st.activeChatId]?.sessionId : undefined
      clear()
      if (cur.sid !== active) {
        const sess = allGroupsRef.current.flatMap((x) => x.sessions).find((x) => x.sessionId === cur.sid)
        if (sess) {
          void openSessionRef.current(sess).then(() => requestAnimationFrame(() => focusComposer()))
          return
        }
      }
      requestAnimationFrame(() => focusComposer())
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
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
      <div
        className={'sb-resize' + (resizing ? ' dragging' : '')}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setSidebarWidth(390)}
      />
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

        {allGroups.map((g) => {
          const isCollapsed = isCollapsedGroup(g)
          return (
            <div className="group" key={g.cwd}>
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
                onClick={() => setCollapsed({ ...collapsed, [g.cwd]: !isCollapsed })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setGroupMenu({ x: e.clientX, y: e.clientY, g })
                }}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
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
              {!isCollapsed && g.sessions.length === 0 && <div className="muted pad small">No recent chats</div>}
              {!isCollapsed &&
                g.sessions.map((s) => {
                  const chat = openBySession[s.sessionId] ? chats[openBySession[s.sessionId]] : undefined
                  const shownAgents = chat ? chat.subagents.filter((a) => !a.hidden) : []
                  return (
                    <Fragment key={s.sessionId}>
                      <SessionRow
                        s={s}
                        chat={chat}
                        active={!!openBySession[s.sessionId] && openBySession[s.sessionId] === activeChatId}
                        meta={meta[s.sessionId]}
                        modelMax={modelMax}
                        now={now}
                        compact={g.general}
                        keepWarm={keepWarm.includes(s.sessionId)}
                        warmedAt={warmedAt[s.sessionId]}
                        onOpen={() => void openSession(s).then(() => requestAnimationFrame(() => focusComposer()))}
                        onMenu={(e) => {
                          e.preventDefault()
                          setMenu({ x: e.clientX, y: e.clientY, s })
                        }}
                        onClose={() => chat && closeTab(chat.chatId)}
                      />
                      {shownAgents.length > 0 && <SubagentList agents={shownAgents} />}
                    </Fragment>
                  )
                })}
            </div>
          )
        })}
      </div>

      {menu && (
        <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => void openSession(menu.s).then(() => {
            setMenu(null)
            requestAnimationFrame(() => focusComposer())
          })}>
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
          {(onDisk.has(menu.s.sessionId) || openBySession[menu.s.sessionId]) && (
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
          {menu.s.cwd !== generalDir && (
            <button onClick={() => void window.desktop.openPath(menu.s.cwd!).then(() => setMenu(null))}>
              <FolderGit2 size={14} /> Open project folder
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
        <button className="btn wide" onClick={() => void addProject()}>
          <FolderPlus size={15} /> Add project
        </button>
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
          <button onClick={() => { setShowNewDialog(true, groupMenu.g.cwd); setGroupMenu(null) }}>
            <Plus size={14} /> New chat here with options…
          </button>
          <button onClick={() => void window.desktop.openPath(groupMenu.g.cwd).then(() => setGroupMenu(null))}>
            <FolderOpen size={14} /> Open folder
          </button>
          <button onClick={() => { setRenamingProject({ cwd: groupMenu.g.cwd, name: groupMenu.g.name }); setGroupMenu(null) }}>
            <Pencil size={14} /> Rename project…
          </button>
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
    </aside>
  )
}

function SessionRow({
  s,
  chat,
  active,
  meta,
  modelMax,
  now,
  compact,
  keepWarm,
  warmedAt,
  onOpen,
  onMenu,
  onClose,
}: {
  s: SessionSummary
  chat?: Chat
  active: boolean
  meta?: SessionMeta
  modelMax: Record<string, number>
  now: number
  /** Chats section: title line only. */
  compact?: boolean
  keepWarm: boolean
  warmedAt?: number
  onOpen: () => void
  onMenu: (e: React.MouseEvent) => void
  onClose: () => void
}) {
  const live = chat && !chat.closed
  const model = (live && chat.model) || meta?.model
  const effort = (live && chat.effort) || meta?.effort
  const busy = live && (chat.status === 'running' || chat.status === 'compacting' || !!chat.pending.length)
  const lastAt = (live && chat.lastResponseAt) || meta?.lastAt || s.lastModified
  const ttl = meta?.cacheTtlMs ?? 300_000
  const cacheLast = Math.max(lastAt || 0, warmedAt ?? 0)
  const cacheLeft = cacheLast ? ttl - (now - cacheLast) : -1
  const warm = !!live && keepWarm && !!lastAt && now - lastAt <= KEEP_WARM_MAX_IDLE_MS
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
  return (
    <button
      className={`row ${active ? 'active' : ''}`}
      data-sid={s.sessionId}
      onClick={onOpen}
      onContextMenu={onMenu}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault() // no autoscroll cursor
      }}
      onAuxClick={(e) => {
        // Middle-click closes an open chat.
        if (e.button === 1 && live) {
          e.preventDefault()
          onClose()
        }
      }}
      title={s.firstPrompt}
    >
      <div className="row-line">
        {live && dotState(chat) !== 'idle' ? <span className={`dot ${dotState(chat)}`} title={DOT_TITLE[dotState(chat)]} /> : <span className="dot slot" />}
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
        <span className="cache" style={cacheStyle} title={warm ? 'Prompt cache lifetime remaining · kept warm' : 'Prompt cache lifetime remaining'}>
          {warm && <Flame size={10} style={{ marginRight: 3, verticalAlign: '-1px' }} />}
          {cache}
        </span>
        <span className="cache row-model">
          {modelLabel(model ?? (live ? chat.requestedModel : undefined))}
          {effort && <span className="row-effort"> · {effort}</span>}
        </span>
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
function SubagentList({ agents }: { agents: Subagent[] }) {
  const now = useNow(agents.some((a) => a.status === 'running'))
  return (
    <div className="subagents">
      {agents.map((a) => (
        <div key={a.toolUseId} className={`subagent ${a.status}`} title={`${a.type ? a.type + ' · ' : ''}${subagentLine(a, now)}`}>
          <span className={`dot ${a.status === 'running' ? 'busy' : a.status === 'failed' ? 'failed' : 'done'}`} />
          <span className="subagent-desc">{a.description || a.type || 'Subagent'}</span>
          {a.status === 'running' && a.lastTool && <span className="subagent-tool">{a.lastTool}</span>}
          <span className="subagent-time">{fmtElapsed((a.endedAt ?? now) - a.startedAt)}</span>
        </div>
      ))}
    </div>
  )
}
