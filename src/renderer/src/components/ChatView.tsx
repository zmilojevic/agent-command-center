import { useEffect, useRef } from 'react'
import { useStore, isGeneral } from '../store'
import MessageItem from './MessageItem'
import PermissionCard from './PermissionCard'
import { fmtCost, fmtDuration, fmtTokens } from '../util'
import { AlertTriangle } from 'lucide-react'

export default function ChatView({ chatId }: { chatId: string }) {
  const chat = useStore((s) => s.chats[chatId])
  const general = useStore((s) => isGeneral(s.chats[chatId]?.cwd))
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [chatId])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  useEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatId])

  if (!chat) return null
  const pendingByTool = new Map(chat.pending.map((p) => [p.toolUseID, p]))
  const orphanPending = chat.pending.filter((p) => !chat.messages.some((m) => m.blocks.some((b) => b.kind === 'tool_use' && b.id === p.toolUseID)))
  const busy = chat.status === 'running' || chat.status === 'compacting'

  return (
    <div className="chat-scroll" ref={scroller}>
      <div className="chat-col">
        {!chat.transcriptLoaded && <div className="muted center">Loading transcript…</div>}
        {chat.transcriptLoaded && chat.messages.length === 0 && (
          <div className="empty-chat">
            <div className="empty-mark">✦</div>
            <h2>{general ? 'How can I help you today?' : 'What are we working on?'}</h2>
            <p className="muted">{general ? 'Web search is on' : `Claude Code is ready in ${chat.cwd}`}</p>
          </div>
        )}
        {chat.messages.map((m, idx) => (
          <MessageItem
            key={m.id}
            chatId={chatId}
            message={m}
            pendingByTool={pendingByTool}
            continuation={m.role === 'assistant' && !m.local && chat.messages[idx - 1]?.role === 'assistant' && !chat.messages[idx - 1]?.local}
          />
        ))}
        {orphanPending.map((p) => (
          <PermissionCard key={p.requestId} request={p} />
        ))}
        {busy && (
          <div className="working">
            <span className="spinner" />
            {chat.status === 'compacting' ? 'Compacting context…' : 'Working…'}
          </div>
        )}
        {chat.error && (
          <div className="error-box">
            <AlertTriangle size={14} /> <span>{chat.error}</span>
          </div>
        )}
        {chat.closed && (
          <div className="muted center small">Session process ended. Send a message to start it again.</div>
        )}
        {!busy && !general && chat.lastTurn && (
          <div className="turn-stats muted small">
            {fmtDuration(chat.lastTurn.durationMs)} · {fmtTokens(chat.lastTurn.inputTokens)} in / {fmtTokens(chat.lastTurn.outputTokens)} out · {fmtCost(chat.lastTurn.cost)} this turn
          </div>
        )}
        <div className="chat-tail" />
      </div>
    </div>
  )
}
