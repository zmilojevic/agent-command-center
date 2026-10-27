import { useEffect, useRef, useState } from 'react'
import { produce } from 'immer'
import { ArrowLeft, ArrowUp } from 'lucide-react'
import type { SubagentTranscript } from '@shared/types'
import { useStore } from '../store'
import { applyTranscript, emptyModel, type ChatModel } from '../reduce'
import { useNow } from '../hooks'
import { modelLabel } from '../util'
import MessageItem from './MessageItem'
import { subagentLine } from './ToolCard'

const NO_PENDING = new Map()

/** Read-only view of one subagent's own transcript, following it live while it runs. */
export default function AgentView({ chatId, toolUseId, onModel }: { chatId: string; toolUseId: string; onModel?: (model: string | undefined) => void }) {
  const cwd = useStore((s) => s.chats[chatId]?.cwd)
  const sessionId = useStore((s) => s.chats[chatId]?.sessionId)
  const agent = useStore((s) => s.chats[chatId]?.subagents.find((a) => a.toolUseId === toolUseId))
  const closeAgentView = useStore((s) => s.closeAgentView)
  const running = agent?.status === 'running'
  const now = useNow(running)
  const [answered, setAnswered] = useState(false)
  const [found, setFound] = useState(false)
  const [model, setModel] = useState<ChatModel>(() => emptyModel())
  const [info, setInfo] = useState<Pick<SubagentTranscript, 'agentType' | 'description'>>({})
  const lastMtime = useRef<number | undefined>(undefined)
  const seq = useRef(0)
  const foundRef = useRef(false)
  const hasAgent = useRef(!!agent)
  hasAgent.current = !!agent
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Poll while running (or not found yet); after it stops running keep polling (mtime-gated) for a 10 s grace
  // period, because the CLI flushes the final assistant line a moment after the status flips.
  useEffect(() => {
    if (!cwd || !sessionId) return
    let stopped = false
    const fetchOnce = async (live: boolean, force: boolean): Promise<void> => {
      const my = ++seq.current
      let res: SubagentTranscript
      try {
        res = await window.desktop.subagentTranscript(cwd, sessionId, toolUseId, force ? undefined : lastMtime.current)
      } catch {
        return
      }
      if (stopped || my !== seq.current) return
      setAnswered(true)
      setFound(res.found)
      foundRef.current = res.found
      if (!res.found && !hasAgent.current) {
        stopped = true
        clearInterval(timer)
        return
      }
      if (!res.found || res.unchanged) return
      lastMtime.current = res.mtimeMs
      onModel?.(res.model)
      setInfo({ agentType: res.agentType, description: res.description })
      setModel(produce(emptyModel(), (d) => applyTranscript(d as ChatModel, res.messages ?? [], { live })))
    }
    // The final fetch after the run ends must re-render with non-live tool states even if the file did not change.
    void fetchOnce(!!running, !running)
    const graceEnd = Date.now() + 10_000
    const timer = setInterval(() => {
      if (!running && foundRef.current && Date.now() > graceEnd) {
        clearInterval(timer)
        return
      }
      void fetchOnce(!!running, false)
    }, 1500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [cwd, sessionId, toolUseId, running, onModel])

  useEffect(() => () => onModel?.(undefined), [onModel])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const type = agent?.type ?? info.agentType
  const title = agent?.description || info.description || type || 'Subagent'
  return (
    <>
      <div className="agent-bar">
        <button
          className="icon-btn"
          title="Back to chat"
          onClick={() => {
            closeAgentView()
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
          }}
        >
          <ArrowLeft size={16} />
        </button>
        <span className="agent-bar-title" title={title}>
          {title}
        </span>
        {type && <span className="agent-type">{type}</span>}
        {agent && <span className="agent-bar-status">{subagentLine(agent, now)}</span>}
      </div>
      <div className="chat-scroll" ref={scroller}>
        <div className="chat-col">
          {!answered && <div className="muted center">Loading subagent transcript…</div>}
          {answered && !found && <div className="muted center">{agent ? "Waiting for the subagent's transcript…" : 'No transcript was saved for this subagent.'}</div>}
          {model.messages.map((m, idx) => (
            <MessageItem
              key={m.id}
              chatId={chatId}
              message={m}
              pendingByTool={NO_PENDING}
              readOnly
              continuation={m.role === 'assistant' && !m.local && model.messages[idx - 1]?.role === 'assistant' && !model.messages[idx - 1]?.local}
            />
          ))}
          {running && (
            <div className="working">
              <span className="spinner" />
              Working…
            </div>
          )}
          <div className="chat-tail" />
        </div>
      </div>
    </>
  )
}

/** Disabled stand-in for the composer while a subagent transcript is shown. */
export function ReadOnlyComposer({ model }: { model?: string }) {
  return (
    <div className="composer-wrap">
      <div className="composer readonly">
        <textarea rows={1} disabled value="" readOnly placeholder="Subagents can't take messages – this view follows its progress" />
        <div className="composer-bar">
          {model && <span className="ro-model">{modelLabel(model)}</span>}
          <div className="grow" />
          <button className="send" disabled>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
