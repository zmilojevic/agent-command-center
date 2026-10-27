import type React from 'react'
import { useState } from 'react'
import {
  Terminal,
  FileText,
  FilePen,
  FilePlus,
  Search,
  FolderSearch,
  Globe,
  Bot,
  ListTodo,
  Wrench,
  MessageCircleQuestion,
  Check,
  X,
  Ban,
  ChevronRight,
  ChevronDown,
  Sparkles,
  ClipboardList,
  SquareTerminal,
  ScrollText,
} from 'lucide-react'
import type { ToolBlock, Subagent } from '../reduce'
import { toolSummary } from '../reduce'
import { useStore } from '../store'
import { useNow } from '../hooks'
import { activeProjectCwd, openFileInEditor } from '../openIn'
import { fmtElapsed, isPhone } from '../util'
import Markdown from './Markdown'
import type { PermissionRequest } from '@shared/types'
import DiffView from './DiffView'
import PermissionCard from './PermissionCard'

const ICONS: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: FileText,
  Edit: FilePen,
  NotebookEdit: FilePen,
  Write: FilePlus,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Bot,
  Task: Bot,
  TodoWrite: ListTodo,
  AskUserQuestion: MessageCircleQuestion,
  Skill: Sparkles,
  ExitPlanMode: ClipboardList,
  EnterPlanMode: ClipboardList,
}

const MAX = 6000

function clip(s: string): string {
  return s.length > MAX ? s.slice(0, MAX) + `\n… (${s.length - MAX} more characters)` : s
}

/** One line on what a subagent is doing: "Running Bash · 3 tool calls · 12s". */
export function subagentLine(a: Subagent, now: number): string {
  const parts: string[] = []
  if (a.status === 'running') parts.push(a.activity || (a.lastTool ? `Using ${a.lastTool}` : 'Starting'))
  else parts.push(a.status === 'done' ? 'Finished' : 'Failed')
  if (!a.restored) parts.push(a.toolCalls === 1 ? '1 tool call' : `${a.toolCalls} tool calls`)
  parts.push(fmtElapsed((a.endedAt ?? now) - a.startedAt))
  return parts.join(' · ')
}

/** Pulls the `Links: [{"title","url"}, …]` array out of a WebSearch result; null when absent or malformed. */
function parseSearchLinks(text: string): { title: string; url: string }[] | null {
  const start = text.indexOf('Links: [')
  if (start < 0) return null
  const open = text.indexOf('[', start)
  // Bracket-match to the closing ']' (skipping brackets inside JSON strings).
  let depth = 0
  let inStr = false
  for (let k = open; k < text.length; k++) {
    const ch = text[k]
    if (inStr) {
      if (ch === '\\') k++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) {
      try {
        const arr = JSON.parse(text.slice(open, k + 1))
        const links = (Array.isArray(arr) ? arr : []).filter((l) => l && typeof l.url === 'string').map((l) => ({ title: String(l.title ?? l.url), url: l.url as string }))
        return links.length ? links : null
      } catch {
        return null
      }
    }
  }
  return null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function SearchResults({ text }: { text: string }) {
  const links = parseSearchLinks(text)
  if (!links) return <pre className="code out">{clip(text) || '(no output)'}</pre>
  return (
    <ul className="search-links">
      {links.map((l, k) => (
        <li key={k}>
          <a href={l.url} target="_blank" rel="noreferrer">
            {l.title}
          </a>{' '}
          <span className="search-host">{hostOf(l.url)}</span>
        </li>
      ))}
    </ul>
  )
}

function AgentBody({ block, agent }: { block: ToolBlock; agent?: Subagent }) {
  const i = block.input as any
  return (
    <>
      {agent && (
        <div className="agent-facts">
          {agent.type && <span className="agent-type">{agent.type}</span>}
          {agent.lastTool && <span>last tool: {agent.lastTool}</span>}
          {agent.tokens != null && <span>{agent.tokens.toLocaleString()} tokens</span>}
        </div>
      )}
      {i.prompt && (
        <details className="agent-prompt">
          <summary>Prompt</summary>
          <pre className="code">{clip(String(i.prompt))}</pre>
        </details>
      )}
      {block.result && block.result.text.startsWith('Async agent launched') ? (
        agent?.summary ? (
          <div className="agent-result"><Markdown text={clip(agent.summary)} /></div>
        ) : (
          <div className="muted small">Runs in the background; its report comes back when it finishes.</div>
        )
      ) : block.result &&
        (block.result.isError ? <pre className="code out err">{clip(block.result.text)}</pre> : <div className="agent-result"><Markdown text={clip(block.result.text)} /></div>)}
    </>
  )
}

export default function ToolCard({ chatId, block, pending, readOnly }: { chatId: string; block: ToolBlock; pending?: PermissionRequest; readOnly?: boolean }) {
  const [open, setOpen] = useState(false)
  const isAgent = block.name === 'Agent' || block.name === 'Task'
  const agent = useStore((s) => (isAgent ? s.chats[chatId]?.subagents.find((a) => a.toolUseId === block.id) : undefined))
  const now = useNow(agent?.status === 'running')
  const chatBusy = useStore((s) => s.chats[chatId]?.status === 'running')
  const Icon = ICONS[block.name] ?? Wrench
  const summary = toolSummary(block)
  const i = block.input as any
  const openable = ['Read', 'Write', 'Edit', 'NotebookEdit'].includes(block.name) && !!summary && !!activeProjectCwd(chatId)

  const StatusIcon = block.status === 'done' ? Check : block.status === 'error' ? X : block.status === 'denied' ? Ban : null

  const body = (): React.ReactNode => {
    switch (block.name) {
      case 'Agent':
      case 'Task':
        return <AgentBody block={block} agent={agent} />
      case 'Bash':
        return (
          <>
            <pre className="code cmd">{i.command}</pre>
            {block.result && <pre className={`code out ${block.result.isError ? 'err' : ''}`}>{clip(block.result.text) || '(no output)'}</pre>}
          </>
        )
      case 'Edit':
        return (
          <>
            <DiffView oldText={String(i.old_string ?? '')} newText={String(i.new_string ?? '')} path={typeof i.file_path === 'string' ? i.file_path : undefined} />
            {block.result?.isError && <pre className="code out err">{clip(block.result.text)}</pre>}
          </>
        )
      case 'Write':
        return (
          <>
            <pre className="code">{clip(String(i.content ?? ''))}</pre>
            {block.result?.isError && <pre className="code out err">{clip(block.result.text)}</pre>}
          </>
        )
      case 'TodoWrite':
        return (
          <ul className="todos">
            {(i.todos ?? []).map((t: any, k: number) => (
              <li key={k} className={t.status}>
                <span className="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '○'}</span>
                {t.content}
              </li>
            ))}
          </ul>
        )
      case 'ExitPlanMode':
        return (
          <>
            <div className="agent-result"><Markdown text={clip(String(i.plan ?? ''))} /></div>
            {block.result?.isError && <pre className="code out err">{clip(block.result.text)}</pre>}
          </>
        )
      case 'AskUserQuestion':
        return (
          <div className="qa-summary">
            {(i.questions ?? []).map((q: any, k: number) => (
              <div key={k}>
                <b>{q.question}</b>
                {i.answers?.[q.question] && <span> → {String(i.answers[q.question])}</span>}
              </div>
            ))}
            {block.result && <pre className="code out">{clip(block.result.text)}</pre>}
          </div>
        )
      case 'WebSearch':
        if (block.result && !block.result.isError) return <SearchResults text={block.result.text} />
        if (block.result) return <pre className="code out err">{clip(block.result.text) || '(no output)'}</pre>
        return <pre className="code">{JSON.stringify(block.input, null, 2)}</pre>
      case 'Read':
      case 'Glob':
      case 'Grep':
      case 'WebFetch':
        // The header already names the file / pattern / URL; show just the output.
        if (block.result) return <pre className={`code out ${block.result.isError ? 'err' : ''}`}>{clip(block.result.text) || '(no output)'}</pre>
        return <pre className="code">{JSON.stringify(block.input, null, 2)}</pre>
      default:
        return (
          <>
            <pre className="code">{block.partialJson && !Object.keys(block.input).length ? block.partialJson : JSON.stringify(block.input, null, 2)}</pre>
            {block.result && <pre className={`code out ${block.result.isError ? 'err' : ''}`}>{clip(block.result.text) || '(no output)'}</pre>}
          </>
        )
    }
  }

  if (block.name === 'EnterPlanMode') {
    return (
      <div className="tool plan-entered">
        <Icon size={13} className="tool-icon" /> Entered plan mode
      </div>
    )
  }

  return (
    <div className={`tool ${block.status} ${pending ? 'needs-permission' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} className="chev" /> : <ChevronRight size={13} className="chev" />}
        <Icon size={14} className="tool-icon" />
        <span className="tool-name">{block.name === 'ExitPlanMode' ? 'Plan' : block.name}</span>
        <span
          className={`tool-summary ${['Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch'].includes(block.name) ? 'path' : ['Glob', 'Grep'].includes(block.name) ? 'pattern' : ''}${openable ? ' openable' : ''}`}
          title={openable ? 'Open in editor' : undefined}
          onClick={
            openable
              ? (e) => {
                  e.stopPropagation()
                  const line = block.name === 'Read' && Number(i.offset) > 0 ? Number(i.offset) : undefined
                  void openFileInEditor(summary, activeProjectCwd(chatId) ?? '/', line)
                }
              : undefined
          }
        >
          {summary}
        </span>
        {block.name === 'Bash' && block.status === 'running' && !pending && !i.run_in_background && chatBusy && !readOnly && (
          <span
            className="bg-btn"
            role="button"
            title="Keep it running in the background and continue (Ctrl+B)"
            onClick={(e) => {
              e.stopPropagation()
              void window.desktop.backgroundTasks(chatId, block.id)
            }}
          >
            Run in background
          </span>
        )}
        {block.name === 'Bash' && block.status !== 'running' && !isPhone && !!activeProjectCwd(chatId) && !!i.command && (
          <span
            className="run-term-btn"
            role="button"
            title="Run in terminal (Shift+click: paste without running)"
            onClick={(e) => {
              e.stopPropagation()
              const cwd = activeProjectCwd(chatId)
              if (cwd) void useStore.getState().runInTerminal(cwd, String(i.command), !e.shiftKey)
            }}
          >
            <SquareTerminal size={13} />
          </span>
        )}
        {isAgent && !readOnly && (!!block.result || !!agent) && (
          <span
            className="run-term-btn"
            role="button"
            title="Open subagent transcript"
            onClick={(e) => {
              e.stopPropagation()
              useStore.getState().openAgentView(chatId, block.id)
            }}
          >
            <ScrollText size={13} />
          </span>
        )}
        {agent && <span className="agent-live">{subagentLine(agent, now)}</span>}
        {(agent ? agent.status === 'running' : block.status === 'running') && !pending && <span className="spinner small" />}
        {StatusIcon && !(agent && agent.status === 'running') && <StatusIcon size={13} className="tool-status" />}
      </button>
      {open && <div className="tool-body">{body()}</div>}
      {pending && <PermissionCard request={pending} />}
    </div>
  )
}
