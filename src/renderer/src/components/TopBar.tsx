import { Minus, Square, X, GitBranch, Folder, FileDiff, MessageCircle, FolderGit2, SquareTerminal } from 'lucide-react'
import { useStore, isGeneral } from '../store'
import { projectName, shortPath, worktreeOf } from '../util'
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

export default function TopBar() {
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.projectNames)
  const changesOpen = useStore((s) => s.changesOpen)
  const toggleChanges = useStore((s) => s.toggleChanges)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const toggleTerminal = useStore((s) => s.toggleTerminal)
  const changes = useStore((s) => (activeChatId && s.chats[activeChatId] ? s.changes[s.chats[activeChatId].cwd] : undefined))
  const [home, setHome] = useState('')
  useEffect(() => {
    void window.desktop.homeDir().then(setHome)
  }, [])

  const chat = activeChatId ? chats[activeChatId] : undefined
  const general = useStore((s) => isGeneral(chat?.cwd))
  const wt = chat ? worktreeOf(chat.cwd) : null
  const branch = chat?.sessionId ? sessions.find((s) => s.sessionId === chat.sessionId)?.gitBranch : undefined

  return (
    <header className="topbar drag">
      <div className="no-drag" style={{ marginLeft: 8 }}>
        <UsageMeter />
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
          <span className="meta openable" title={`${shortPath(chat.cwd, home)} (click to open in editor)`} onClick={() => void openFolderInEditor(chat.cwd)}>
            <Folder size={13} /> <span className="meta-text">{projectName(projectNames, wt?.root ?? chat.cwd)}</span>
          </span>
          {wt && (
            <span className="meta" title={`Git worktree ${wt.name}`}>
              <FolderGit2 size={13} /> <span className="meta-text">{wt.name}</span>
            </span>
          )}
          <button className={`icon-btn tiny ${terminalOpen ? 'on' : ''}`} title="Terminal (Ctrl+`)" onClick={toggleTerminal}>
            <SquareTerminal size={14} />
          </button>
          {branch && branch !== 'HEAD' && (
            <span className="meta" title={branch}>
              <GitBranch size={13} /> <span className="meta-text">{branch}</span>
            </span>
          )}
        </div>
      )}
      {chat && !general && (
        <div className="no-drag">
          <McpPopover chat={chat} />
        </div>
      )}
      {chat && !general && (
        <button className={`changes-btn no-drag ${changesOpen ? 'on' : ''}`} title="Changes (Ctrl+Shift+G)" onClick={toggleChanges}>
          <FileDiff size={14} />
          {changes?.isRepo && changes.files.length > 0 && (
            <span className="changes-count">
              <span className="cp-add">+{changes.files.reduce((n, f) => n + f.additions, 0)}</span>{' '}
              <span className="cp-del">−{changes.files.reduce((n, f) => n + f.deletions, 0)}</span>
            </span>
          )}
        </button>
      )}
      {chat && (
        <div className="no-drag">
          <ContextMeter chat={chat} />
        </div>
      )}
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
