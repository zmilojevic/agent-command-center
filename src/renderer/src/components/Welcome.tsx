import { MessageSquarePlus, Clock } from 'lucide-react'
import { useStore } from '../store'
import { relativeTime, projectName } from '../util'

export default function Welcome() {
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.projectNames)
  const openSession = useStore((s) => s.openSession)
  const setShowNewDialog = useStore((s) => s.setShowNewDialog)
  const newGeneralChat = useStore((s) => s.newGeneralChat)
  const generalDir = useStore((s) => s.generalDir)
  const recent = sessions.slice(0, 8)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">✦</div>
        <h1>Good to see you</h1>
        <p className="muted">Start a new chat or pick up where you left off.</p>
        <button className="btn primary big" onClick={() => void newGeneralChat()}>
          <MessageSquarePlus size={18} /> New chat
          <kbd>Ctrl N</kbd>
        </button>
        <button className="btn plain" onClick={() => setShowNewDialog(true)}>
          New project session…
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-head">
              <Clock size={13} /> Recent
            </div>
            {recent.map((s) => (
              <button key={s.sessionId} className="recent-row" onClick={() => void openSession(s)}>
                <span className="recent-title">{s.customTitle || s.summary || s.firstPrompt || 'Untitled'}</span>
                <span className="recent-meta">
                  {s.cwd === generalDir ? 'Chat' : s.cwd ? projectName(projectNames, s.cwd) : ''} · {relativeTime(s.lastModified)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
