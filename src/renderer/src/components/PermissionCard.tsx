import type React from 'react'
import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PermissionRequest } from '@shared/types'
import { useStore } from '../store'
import DiffView from './DiffView'
import QuestionCard from './QuestionCard'
import PlanCard from './PlanCard'

const VERBS: Record<string, string> = {
  Bash: 'run a command',
  Edit: 'edit a file',
  Write: 'write a file',
  NotebookEdit: 'edit a notebook',
  Read: 'read a file',
  WebFetch: 'fetch a URL',
  WebSearch: 'search the web',
  Agent: 'start a subagent',
  Task: 'start a subagent',
}

export default function PermissionCard({ request }: { request: PermissionRequest }) {
  const respond = useStore((s) => s.respond)
  const [feedback, setFeedback] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const i = request.input as any

  if (request.toolName === 'AskUserQuestion') return <QuestionCard request={request} />
  if (request.toolName === 'ExitPlanMode') return <PlanCard request={request} />

  const allow = (remember: boolean): void => {
    void respond(request.chatId, request.requestId, { behavior: 'allow', remember })
  }
  const deny = (): void => {
    void respond(request.chatId, request.requestId, {
      behavior: 'deny',
      message: feedback.trim() || 'The user declined this action.',
    })
  }

  const detail = (): React.ReactNode => {
    switch (request.toolName) {
      case 'Bash':
        return (
          <>
            {i.description && <div className="perm-desc">{i.description}</div>}
            <pre className="code">{i.command}</pre>
          </>
        )
      case 'Edit':
        return (
          <>
            <div className="perm-desc mono">{i.file_path}</div>
            <DiffView oldText={String(i.old_string ?? '')} newText={String(i.new_string ?? '')} />
          </>
        )
      case 'Write':
        return (
          <>
            <div className="perm-desc mono">{i.file_path}</div>
            <pre className="code">{String(i.content ?? '').slice(0, 4000)}</pre>
          </>
        )
      case 'Read':
        return <div className="perm-desc mono">{i.file_path}</div>
      case 'WebFetch':
        return <div className="perm-desc mono">{i.url}</div>
      default:
        return <pre className="code">{JSON.stringify(request.input, null, 2)}</pre>
    }
  }

  return (
    <div className="perm">
      <div className="perm-head">
        <ShieldAlert size={15} />
        <span>
          Claude wants to {VERBS[request.toolName] ?? `use ${request.toolName}`}
        </span>
      </div>
      {request.decisionReason && <div className="perm-reason muted small">{request.decisionReason}</div>}
      <div className="perm-detail">{detail()}</div>
      {showFeedback && (
        <textarea
          className="perm-feedback"
          placeholder="Tell Claude what to do instead (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          autoFocus
          rows={2}
        />
      )}
      <div className="perm-actions">
        <button className="btn primary" onClick={() => allow(false)}>
          Allow once
        </button>
        {request.canRemember && (
          <button className="btn" onClick={() => allow(true)} title="Adds a rule to .claude/settings.local.json">
            Always allow
          </button>
        )}
        {!showFeedback ? (
          <button className="btn danger-outline" onClick={() => setShowFeedback(true)}>
            Deny
          </button>
        ) : (
          <button className="btn danger" onClick={deny}>
            Send denial
          </button>
        )}
      </div>
    </div>
  )
}
