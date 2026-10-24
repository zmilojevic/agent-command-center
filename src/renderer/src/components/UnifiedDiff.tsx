import { useMemo, useState } from 'react'
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import { useStore, type ReviewComment } from '../store'

type Row =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string }

/** Parse the hunks of one file's unified diff into display rows. */
export function parseUnifiedDiff(diff: string): Row[] {
  const rows: Row[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) {
      inHunk = true
      oldNo = Number(h[1])
      newNo = Number(h[2])
      rows.push({ kind: 'hunk', text: l })
      continue
    }
    if (!inHunk || l === '' || l.startsWith('\\')) continue
    const c = l[0]
    if (c === '+') rows.push({ kind: 'add', newNo: newNo++, text: l.slice(1) })
    else if (c === '-') rows.push({ kind: 'del', oldNo: oldNo++, text: l.slice(1) })
    else rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: l.slice(1) })
  }
  return rows
}

const anchor = (r: Row): { side: 'old' | 'new'; line: number } | null => {
  if (r.kind === 'hunk') return null
  return r.kind === 'del' ? { side: 'old', line: r.oldNo! } : { side: 'new', line: r.newNo! }
}
const keyOf = (side: string, line: number): string => `${side}:${line}`

function CommentEditor({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial)
  const save = (): void => {
    if (text.trim()) onSave(text.trim())
  }
  return (
    <div className="ud-editor">
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="Comment on this line"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="ud-editor-actions">
        <button className="btn small-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn small-btn primary" onClick={save} disabled={!text.trim()}>
          Add
        </button>
      </div>
    </div>
  )
}

function CommentCard({ c, onEdit, onDelete, outdated }: { c: ReviewComment; onEdit: () => void; onDelete: () => void; outdated?: boolean }) {
  return (
    <div className="ud-comment">
      <div className="ud-comment-body">
        {outdated && (
          <div className="ud-comment-where">
            {c.side === 'old' ? 'removed line' : 'line'} {c.line}: <code>{c.lineText.trim().slice(0, 80)}</code>
          </div>
        )}
        {c.text}
      </div>
      <button className="icon-btn tiny" title="Edit" onClick={onEdit}>
        <Pencil size={12} />
      </button>
      <button className="icon-btn tiny" title="Delete" onClick={onDelete}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}

/** One file's diff with hover "+" buttons to attach review comments to lines. */
export default function UnifiedDiff({ chatId, path, diff, comments }: { chatId: string; path: string; diff: string; comments: ReviewComment[] }) {
  const addComment = useStore((s) => s.addComment)
  const updateComment = useStore((s) => s.updateComment)
  const removeComment = useStore((s) => s.removeComment)
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [editing, setEditing] = useState<{ key: string; id?: string } | null>(null)

  const byKey = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const k = keyOf(c.side, c.line)
    byKey.set(k, [...(byKey.get(k) ?? []), c])
  }
  const present = new Set<string>()
  for (const r of rows) {
    const a = anchor(r)
    if (a) present.add(keyOf(a.side, a.line))
  }
  const outdated = comments.filter((c) => !present.has(keyOf(c.side, c.line)))

  return (
    <div className="ud">
      {rows.map((r, i) => {
        if (r.kind === 'hunk') {
          return (
            <div key={i} className="ud-hunk">
              {r.text}
            </div>
          )
        }
        const a = anchor(r)!
        const k = keyOf(a.side, a.line)
        const mine = byKey.get(k) ?? []
        const open = () => setEditing({ key: k })
        return (
          <div key={i}>
            <div className={`ud-row ${r.kind}`}>
              <button className="ud-add" title="Add comment" onClick={open}>
                <MessageSquarePlus size={12} />
              </button>
              <span className="ud-no" onClick={open}>
                {r.oldNo ?? ''}
              </span>
              <span className="ud-no" onClick={open}>
                {r.newNo ?? ''}
              </span>
              <span className="ud-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ''}</span>
              <span className="ud-text">{r.text}</span>
            </div>
            {mine.map((c) =>
              editing?.id === c.id ? (
                <CommentEditor
                  key={c.id}
                  initial={c.text}
                  onSave={(t) => {
                    updateComment(chatId, c.id, t)
                    setEditing(null)
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <CommentCard key={c.id} c={c} onEdit={() => setEditing({ key: k, id: c.id })} onDelete={() => removeComment(chatId, c.id)} />
              ),
            )}
            {editing?.key === k && !editing.id && (
              <CommentEditor
                initial=""
                onSave={(t) => {
                  addComment(chatId, { path, line: a.line, side: a.side, lineText: r.text, text: t })
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        )
      })}
      {outdated.length > 0 && (
        <div className="ud-outdated">
          <div className="ud-outdated-head">Outdated</div>
          {outdated.map((c) =>
            editing?.id === c.id ? (
              <CommentEditor
                key={c.id}
                initial={c.text}
                onSave={(t) => {
                  updateComment(chatId, c.id, t)
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <CommentCard key={c.id} c={c} outdated onEdit={() => setEditing({ key: keyOf(c.side, c.line), id: c.id })} onDelete={() => removeComment(chatId, c.id)} />
            ),
          )}
        </div>
      )}
    </div>
  )
}
