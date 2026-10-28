import { useEffect, useRef } from 'react'
import { useStore, isGeneral } from '../store'
import MessageItem from './MessageItem'
import PermissionCard from './PermissionCard'
import { fmtCost, fmtDuration, fmtTokens, isPhone } from '../util'
import { AlertTriangle, Bot } from 'lucide-react'
import { subagentLine } from './ToolCard'
import { useNow } from '../hooks'

function SubagentsLive({ chatId, busy }: { chatId: string; busy: boolean }) {
  const all = useStore((s) => s.chats[chatId]?.subagents)
  const running = (all ?? []).filter((a) => a.status === 'running')
  const now = useNow(running.length > 0)
  if (running.length === 0) return null
  return (
    <div className="subagents-live">
      {!busy && (
        <div className="working">
          <span className="spinner" />
          {`Waiting for ${running.length} ${running.length === 1 ? 'subagent' : 'subagents'}…`}
        </div>
      )}
      {running.map((a) => (
        <div
          key={a.toolUseId}
          role="button"
          tabIndex={0}
          className="subagent-live-row"
          title={`${a.type ? a.type + ' · ' : ''}${subagentLine(a, now)}`}
          onClick={() => useStore.getState().openAgentView(chatId, a.toolUseId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              useStore.getState().openAgentView(chatId, a.toolUseId)
            }
          }}
        >
          <Bot size={13} />
          <span className="subagent-live-desc">{a.description || a.type || 'Subagent'}</span>
          <span className="subagent-live-line">{subagentLine(a, now)}</span>
        </div>
      ))}
    </div>
  )
}

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
        <SubagentsLive chatId={chatId} busy={busy} />
        {chat.error && (
          <div className="error-box">
            <AlertTriangle size={14} />{' '}
            {chat.error === 'authentication_failed' && !isPhone ? (
              <>
                <span>Claude Code isn't logged in, or the login expired.</span>
                <button className="btn" onClick={() => useStore.getState().openLogin()}>
                  Log in
                </button>
              </>
            ) : (
              <span>{chat.error}</span>
            )}
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
