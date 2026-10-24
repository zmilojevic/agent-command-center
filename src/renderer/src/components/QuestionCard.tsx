import { useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { PermissionRequest } from '@shared/types'
import { useStore } from '../store'

interface Q {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export default function QuestionCard({ request }: { request: PermissionRequest }) {
  const respond = useStore((s) => s.respond)
  const questions = ((request.input as any).questions ?? []) as Q[]
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (q: Q, label: string): void => {
    const cur = picked[q.question] ?? []
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label]
    setPicked({ ...picked, [q.question]: next })
  }

  const answerFor = (q: Q): string => {
    const o = (other[q.question] ?? '').trim()
    const sel = picked[q.question] ?? []
    if (o && sel.length) return [...sel, o].join(', ')
    if (o) return o
    return sel.join(', ')
  }
  const complete = questions.every((q) => answerFor(q))

  const submit = (): void => {
    const answers: Record<string, string> = {}
    for (const q of questions) answers[q.question] = answerFor(q)
    void respond(request.chatId, request.requestId, {
      behavior: 'allow',
      updatedInput: { questions, answers },
    })
  }

  return (
    <div className="perm question">
      <div className="perm-head">
        <MessageCircleQuestion size={15} />
        <span>Claude has a question</span>
      </div>
      {questions.map((q) => (
        <div className="q" key={q.question}>
          {q.header && <span className="chip">{q.header}</span>}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label)
              return (
                <button key={o.label} className={`option ${on ? 'on' : ''}`} onClick={() => toggle(q, o.label)}>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-desc">{o.description}</span>}
                </button>
              )
            })}
          </div>
          <input
            className="q-other"
            placeholder={q.multiSelect ? 'Add your own answer (optional)' : 'Or type your own answer'}
            value={other[q.question] ?? ''}
            onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && complete) submit()
            }}
          />
        </div>
      ))}
      <div className="perm-actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>
          Send answer{questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  )
}
