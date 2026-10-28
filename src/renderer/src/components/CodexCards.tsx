import { useEffect, useState } from 'react'
import { AlertTriangle, FilePlus2 } from 'lucide-react'
import { useStore, isGeneral } from '../store'
import { isPhone } from '../util'

/** Sent by the AGENTS.md card's "Initialize" button. */
export const AGENTS_MD_PROMPT =
  'Explore this repository and create an AGENTS.md at its root for future coding agents: project purpose, layout, how to build/run/test, code style and conventions, and anything non-obvious. Keep it concise. Do not read or copy CLAUDE.md or anything under .claude/.'

/** "Log in to Codex" card (chat pane) while `codex:status` says logged out. */
export function CodexLoginCard() {
  const loggedOut = useStore((s) => s.codexStatus?.loggedIn === false)
  if (!loggedOut) return null
  return (
    <div className="error-box codex-login-card">
      <AlertTriangle size={14} />
      <span>Codex isn't logged in, or the login expired.{isPhone ? ' Log in on the desktop.' : ''}</span>
      {!isPhone && (
        <button className="btn" onClick={() => useStore.getState().openLogin('codex')}>
          Log in to Codex
        </button>
      )}
    </div>
  )
}

/** Muted card above the composer of an empty Codex project chat whose project has no AGENTS.md. */
export function AgentsMdCard({ chatId }: { chatId: string }) {
  const show = useStore((s) => {
    const c = s.chats[chatId]
    return !!c && c.engine === 'codex' && !isGeneral(c.cwd) && c.transcriptLoaded && c.messages.length === 0 && !c.closed
  })
  const cwd = useStore((s) => s.chats[chatId]?.cwd)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    setMissing(false)
    if (!show || !cwd) return
    let alive = true
    void window.desktop
      .codexHasAgentsMd(cwd)
      .then((has) => alive && setMissing(!has))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [show, cwd, chatId])
  if (!show || !missing) return null
  return (
    <div className="agents-md-card">
      <FilePlus2 size={14} />
      <span>This project has no AGENTS.md</span>
      <button className="btn" onClick={() => void useStore.getState().sendMessage(chatId, AGENTS_MD_PROMPT)}>
        Initialize
      </button>
    </div>
  )
}
