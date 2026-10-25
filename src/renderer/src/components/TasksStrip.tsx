import { useEffect, useRef, useState } from 'react'
import { Terminal, Activity, Workflow, ListTree, Loader, Check, X, Ban, Copy } from 'lucide-react'
import { useStore } from '../store'
import { useNow } from '../hooks'
import { fmtDuration } from '../util'
import type { BgTask } from '../reduce'

const ENDED_VISIBLE_MS = 10 * 60 * 1000
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

const live = (t: BgTask): boolean => t.status === 'running' || t.status === 'pending' || t.status === 'paused'

function TypeIcon({ type }: { type: string }) {
  if (type === 'local_bash' || type === 'local_command') return <Terminal size={12} />
  if (type.startsWith('monitor')) return <Activity size={12} />
  if (type === 'local_workflow') return <Workflow size={12} />
  return <ListTree size={12} />
}

function StatusIcon({ task }: { task: BgTask }) {
  if (live(task)) return <Loader size={12} className="spin" />
  if (task.status === 'completed') return <Check size={12} />
  if (task.status === 'failed') return <X size={12} />
  return <Ban size={12} />
}

const TYPE_LABEL: Record<string, string> = {
  local_bash: 'Shell command',
  local_command: 'Command',
  local_workflow: 'Workflow',
  monitor_mcp: 'Monitor (MCP)',
  monitor_ws: 'Monitor (WebSocket)',
  remote_agent: 'Remote agent',
}

function TaskPopover({ chatId, task, now, onClose }: { chatId: string; task: BgTask; now: number; onClose: () => void }) {
  const [output, setOutput] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const running = live(task)

  // Poll while the task runs; the effect re-runs once when it ends to fetch the final tail.
  useEffect(() => {
    let dead = false
    const load = async (): Promise<void> => {
      const r = await window.desktop.taskOutput(chatId, task.taskId)
      if (dead) return
      setOutput(r ? r.output.replace(ANSI, '').replace(/\r(?!\n)/g, '\n') : '')
      setTruncated(!!r?.truncated)
    }
    void load()
    if (!running) {
      return () => {
        dead = true
      }
    }
    const t = setInterval(() => void load(), 1500)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [chatId, task.taskId, running])

  useEffect(() => {
    const el = pre.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [output])

  const end = task.endedAt ?? now
  return (
    <div className="task-pop">
      <div className="task-pop-head">
        <TypeIcon type={task.type} />
        <span className="task-pop-title" title={task.description}>{task.description || task.taskId}</span>
      </div>
      <div className="task-pop-meta muted">
        {TYPE_LABEL[task.type] ?? task.type} · {task.status} · {fmtDuration(Math.max(0, end - task.startedAt))}
        {task.error ? ` · ${task.error}` : ''}
      </div>
      <pre
        className="task-pop-out"
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {output == null ? 'Loading…' : (truncated ? '… (earlier output cut)\n' : '') + (output || '(no output yet)')}
      </pre>
      <div className="task-pop-actions">
        {running && (
          <button className="task-pop-btn" onClick={() => void window.desktop.stopTask(chatId, task.taskId)}>
            Stop
          </button>
        )}
        <button className="task-pop-btn" onClick={() => void navigator.clipboard.writeText(output ?? '')}>
          <Copy size={12} /> Copy output
        </button>
        <button className="task-pop-btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

/** Pills for background shells, monitors and workflows above the composer. */
export default function TasksStrip({ chatId }: { chatId: string }) {
  const tasks = useStore((s) => s.chats[chatId]?.tasks)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const anyRunning = !!tasks?.some((t) => !t.ambient && live(t))
  const now = useNow(!!tasks?.length, anyRunning ? 1000 : 15000)
  const visible = (tasks ?? []).filter(
    (t) => !t.ambient && !dismissed.has(t.taskId) && (live(t) || now - (t.endedAt ?? 0) < ENDED_VISIBLE_MS),
  )
  const openTask = visible.find((t) => t.taskId === openId)

  useEffect(() => {
    if (!openId) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpenId(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openId])

  if (!visible.length) return null
  return (
    <div className="tasks-strip" ref={root}>
      {openTask && <TaskPopover chatId={chatId} task={openTask} now={now} onClose={() => setOpenId(null)} />}
      {visible.map((t) => (
        <div key={t.taskId} className={`task-pill ${live(t) ? 'running' : 'ended'} ${openId === t.taskId ? 'on' : ''}`}>
          <button className="task-pill-main" title={t.description} onClick={() => setOpenId(openId === t.taskId ? null : t.taskId)}>
            <span className="task-pill-type"><TypeIcon type={t.type} /></span>
            <span className="task-pill-text">{t.description || t.taskId}</span>
            <span className="task-pill-time">{fmtDuration(Math.max(0, (t.endedAt ?? now) - t.startedAt))}</span>
            {!live(t) && <span className={`task-pill-status ${t.status}`}><StatusIcon task={t} /></span>}
          </button>
          {!live(t) && (
            <button
              className="task-pill-x"
              title="Dismiss"
              onClick={() => {
                setDismissed((d) => new Set(d).add(t.taskId))
                if (openId === t.taskId) setOpenId(null)
              }}
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
