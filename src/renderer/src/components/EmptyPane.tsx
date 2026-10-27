import { useStore } from '../store'

/** What the chat pane shows with no active chat: a login card when logged out, a first-run hint when nothing exists yet, else nothing. */
export default function EmptyPane({ onNewChat }: { onNewChat: () => void }) {
  const auth = useStore((s) => s.auth)
  const openLogin = useStore((s) => s.openLogin)
  const pinProject = useStore((s) => s.pinProject)
  const pinned = useStore((s) => s.pinnedProjects)
  const fresh = useStore((s) => s.sessions.length === 0 && s.pinnedProjects.length === 0 && Object.keys(s.chats).length === 0)

  if (auth === 'out') {
    return (
      <div className="empty-card">
        <h2>Log in to get started</h2>
        <p>Hearth runs on your Claude Code login and subscription – no API key.</p>
        <button className="btn primary" onClick={openLogin}>
          Log in
        </button>
      </div>
    )
  }
  if (!fresh) return null
  return (
    <div className="empty-card">
      <p>Your Claude Code sessions show up here, grouped by project.</p>
      <div className="empty-card-actions">
        <button className="btn" onClick={onNewChat}>
          New chat
        </button>
        <button
          className="btn"
          onClick={() =>
            void window.desktop.pickFolder(pinned[0]).then((dir) => {
              if (dir) pinProject(dir)
            })
          }
        >
          Add project
        </button>
      </div>
    </div>
  )
}
