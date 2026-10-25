import { useEffect, useState } from 'react'
import { modLabel } from '../util'
import { ClipboardList } from 'lucide-react'
import type { PermissionMode, PermissionRequest } from '@shared/types'
import { useStore } from '../store'
import Markdown from './Markdown'

export default function PlanCard({ request }: { request: PermissionRequest }) {
  const respond = useStore((s) => s.respond)
  const [feedback, setFeedback] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const plan = String((request.input as any).plan ?? '')

  const approve = (mode: PermissionMode): void => {
    void respond(request.chatId, request.requestId, { behavior: 'allow', mode })
  }
  const keepPlanning = (): void => {
    const f = feedback.trim()
    void respond(request.chatId, request.requestId, {
      behavior: 'deny',
      message: f ? `The user wants to keep planning. Feedback: ${f}` : 'The user wants to keep planning. Revise the plan before proceeding.',
    })
  }

  // Ctrl+Enter = primary approve (not while typing feedback).
  useEffect(() => {
    if (showFeedback) return
    const h = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || t.isContentEditable)) return
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        approve('acceptEdits')
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  return (
    <div className="perm plan-card">
      <div className="perm-head">
        <ClipboardList size={15} />
        <span>Claude's plan</span>
      </div>
      <div className="plan-body">
        <Markdown text={plan} />
      </div>
      {showFeedback && (
        <textarea
          className="perm-feedback"
          placeholder="What should change in the plan? (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          autoFocus
          rows={2}
        />
      )}
      <div className="perm-actions">
        <button className="btn primary" onClick={() => approve('acceptEdits')} title={modLabel('Ctrl+Enter')}>
          Approve · accept edits
        </button>
        <button className="btn" onClick={() => approve('bypassPermissions')}>
          Approve · bypass permissions
        </button>
        <button className="btn" onClick={() => approve('default')}>
          Approve · ask before edits
        </button>
        {!showFeedback ? (
          <button className="btn danger-outline" onClick={() => setShowFeedback(true)}>
            Keep planning
          </button>
        ) : (
          <button className="btn danger" onClick={keepPlanning}>
            Send feedback
          </button>
        )}
      </div>
    </div>
  )
}
