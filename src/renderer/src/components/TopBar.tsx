import { ChevronLeft, Minus, Square, X, GitBranch, Folder, MessageCircle, FolderGit2, ArrowUpCircle, ChartColumn } from 'lucide-react'
import { useStore, isGeneral } from '../store'
import { projectName, shortPath, worktreeOf, modLabel, isPhone } from '../util'
import { useEffect, useState } from 'react'
import ContextMeter from './ContextMeter'
import UsageMeter from './UsageMeter'
import SettingsPopover from './SettingsPopover'
import McpPopover from './McpPopover'
import { openFolderInEditor } from '../openIn'

/** idle renders no dot (just the spacer); waiting-on-you, busy and finished-unseen do. */
export type DotState = 'ask' | 'busy' | 'on' | 'idle'
export const DOT_TITLE: Record<DotState, string> = { ask: 'Waiting for your answer', busy: 'Working', on: 'Finished, not viewed yet', idle: 'Idle' }
export function dotState(c: { status: string; unread: boolean; pending?: unknown[] }): DotState {
  if (c.pending?.length) return 'ask'
  if (c.status === 'running' || c.status === 'compacting') return 'busy'
  return c.unread ? 'on' : 'idle'
}

/** Muted "Update x.y.z" pill left of the gear; opens the release page, the x hides it for that version. */
function UpdatePill() {
  const update = useStore((s) => s.update)
  const dismissed = useStore((s) => s.dismissedUpdate)
  const dismissUpdate = useStore((s) => s.dismissUpdate)
  if (isPhone || !update?.newer || !update.latest || update.latest === dismissed) return null
  return (
    <div className="no-drag">
      <button className="update-pill" title={`Hearth ${update.latest} is available`} onClick={() => update.url && window.open(update.url)}>
        <ArrowUpCircle size={13} />
        <span>Update {update.latest}</span>
        <span
          className="update-pill-x"
          title="Dismiss"
          onClick={(e) => {
            e.stopPropagation()
            dismissUpdate()
          }}
        >
          <X size={11} />
        </span>
      </button>
    </div>
  )
}

export default function TopBar() {
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.projectNames)
  const showCodexUsage = useStore((s) => !!(s.codexStatus?.installed && s.codexStatus.loggedIn && s.codexUsage?.available))
  const toggleChanges = useStore((s) => s.toggleChanges)
  const changes = useStore((s) => {
    const c = s.activeChatId ? s.chats[s.activeChatId] : undefined
    return c ? s.changes[c.cwd] : undefined
  })
  const [home, setHome] = useState('')
  useEffect(() => {
    void window.desktop.homeDir().then(setHome)
  }, [])

  const chat = activeChatId ? chats[activeChatId] : undefined
  const general = useStore((s) => isGeneral(chat?.cwd))
  const wt = chat ? worktreeOf(chat.cwd) : null
  const hasChanges = !!changes?.isRepo && changes.files.length > 0
  const add = hasChanges ? changes!.files.reduce((n, f) => n + f.additions, 0) : 0
  const del = hasChanges ? changes!.files.reduce((n, f) => n + f.deletions, 0) : 0
  const branch = chat?.sessionId ? sessions.find((s) => s.sessionId === chat.sessionId)?.gitBranch : undefined

  const historyBtn = (
    <button className="icon-btn" title="Usage history" onClick={() => useStore.getState().openUsageHistory()}>
      <ChartColumn size={15} />
    </button>
  )

  if (isPhone) {
    return (
      <header className="topbar phone-topbar">
        {chat && (
          <button className="icon-btn phone-back" title="Back" onClick={() => useStore.getState().activate(null)}>
            <ChevronLeft size={22} />
          </button>
        )}
        <span className="phone-title">{chat ? chat.title : 'Hearth'}</span>
        {chat && <ContextMeter chat={chat} />}
        {historyBtn}
        <SettingsPopover />
      </header>
    )
  }

  return (
    <header className="topbar drag">
      <div className="no-drag usage-pair" style={{ marginLeft: 8 }}>
        {historyBtn}
        <UsageMeter label={showCodexUsage} />
        {showCodexUsage && <UsageMeter codex label />}
      </div>
      <div className="grow" />
      {chat && general && (
        <div className="topbar-meta no-drag">
          <span className="meta">
            <MessageCircle size={13} /> <span className="meta-text">Chat</span>
          </span>
        </div>
      )}
      {chat && !general && (
        <div className="topbar-meta no-drag">
          <span className="meta openable topbar-project" title={`${shortPath(chat.cwd, home)} (click to open in editor)`} onClick={() => void openFolderInEditor(chat.cwd)}>
            <Folder size={13} /> <span className="meta-text">{projectName(projectNames, wt?.root ?? chat.cwd)}</span>
          </span>
          {wt && (
            <span className="meta" title={`Git worktree ${wt.name}`}>
              <FolderGit2 size={13} /> <span className="meta-text">{wt.name}</span>
            </span>
          )}
          {hasChanges && (
            <span className="meta openable topbar-changes" title={`Changes (${modLabel('Ctrl+Shift+G')})`} onClick={toggleChanges}>
              <span className="cp-add">+{add}</span> <span className="cp-del">−{del}</span>
            </span>
          )}
          {branch && branch !== 'HEAD' && (
            <span className="meta" title={branch}>
              <GitBranch size={13} /> <span className="meta-text">{branch}</span>
            </span>
          )}
        </div>
      )}
      {chat && !general && chat.engine !== 'codex' && (
        <div className="no-drag">
          <McpPopover chat={chat} />
        </div>
      )}
      {chat && (
        <div className="no-drag">
          <ContextMeter chat={chat} />
        </div>
      )}
      <UpdatePill />
      <div className="no-drag">
        <SettingsPopover />
      </div>
      <div className="win-controls no-drag">
        <button className="icon-btn" onClick={() => window.desktop.window('minimize')} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="icon-btn" onClick={() => window.desktop.window('maximize')} title="Maximize">
          <Square size={12} />
        </button>
        <button className="icon-btn close" onClick={() => window.desktop.window('close')} title="Close">
          <X size={14} />
        </button>
      </div>
    </header>
  )
}
