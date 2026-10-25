import { Fragment, useMemo, useState, type ReactElement } from 'react'
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import { useStore, type ReviewComment } from '../store'
import { highlightRows, langForPath } from '../highlight'

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

type LineRow = Exclude<Row, { kind: 'hunk' }>
export type SplitItem = { kind: 'hunk'; text: string } | { kind: 'pair'; left: LineRow | null; right: LineRow | null }

/** Side-by-side pairing: ctx = one paired row, a run of dels followed by adds is paired line by line (filler = null). */
export function splitRows(rows: Row[]): SplitItem[] {
  const out: SplitItem[] = []
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]
    if (r.kind === 'hunk') {
      out.push({ kind: 'hunk', text: r.text })
      i++
    } else if (r.kind === 'ctx') {
      out.push({ kind: 'pair', left: r, right: r })
      i++
    } else {
      const dels: LineRow[] = []
      const adds: LineRow[] = []
      while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++] as LineRow)
      while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++] as LineRow)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ kind: 'pair', left: dels[k] ?? null, right: adds[k] ?? null })
    }
  }
  return out
}

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

/** One patch per hunk: the file's header lines (up to the first @@) plus that single hunk. */
function hunkPatches(diff: string): string[] {
  const lines = diff.split('\n')
  const starts = lines.reduce<number[]>((a, l, i) => (l.startsWith('@@') ? [...a, i] : a), [])
  const header = lines.slice(0, starts[0] ?? 0)
  return starts.map((s, k) => [...header, ...lines.slice(s, starts[k + 1] ?? lines.length)].join('\n') + '\n')
}

/** One file's diff with hover "+" buttons to attach review comments to lines. `onDiscardHunk` adds a hover action on hunk headers. */
export default function UnifiedDiff({
  chatId,
  path,
  diff,
  comments,
  onDiscardHunk,
  layout = 'unified',
}: {
  chatId: string
  path: string
  diff: string
  comments: ReviewComment[]
  onDiscardHunk?: (patch: string) => void
  layout?: 'unified' | 'split'
}) {
  const addComment = useStore((s) => s.addComment)
  const updateComment = useStore((s) => s.updateComment)
  const removeComment = useStore((s) => s.removeComment)
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const patches = useMemo(() => hunkPatches(diff), [diff])
  const hl = useMemo(() => highlightRows(rows, langForPath(path)), [rows, path])
  let hunkNo = -1
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

  const hunkHeader = (key: number, text: string): ReactElement => {
    const patch = patches[++hunkNo]
    return (
      <div key={key} className="ud-hunk-row">
        <div className="ud-hunk">{text}</div>
        {onDiscardHunk && patch && (
          <button className="ud-hunk-discard" onClick={() => onDiscardHunk(patch)}>
            Discard hunk…
          </button>
        )}
      </div>
    )
  }

  /** Comment cards and the new-comment editor of one anchor, rendered under its row. */
  const thread = (r: LineRow): ReactElement => {
    const a = anchor(r)!
    const k = keyOf(a.side, a.line)
    return (
      <Fragment key={k}>
        {(byKey.get(k) ?? []).map((c) =>
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
      </Fragment>
    )
  }

  const half = (r: LineRow | null, side: 'old' | 'new'): ReactElement => {
    if (!r) return <div className="ud-half empty" />
    const a = anchor(r)!
    const open = () => setEditing({ key: keyOf(a.side, a.line) })
    return (
      <div className={`ud-half ${r.kind}`}>
        <button className="ud-add" title="Add comment" onClick={open}>
          <MessageSquarePlus size={12} />
        </button>
        <span className="ud-no" onClick={open}>
          {side === 'old' ? r.oldNo : r.newNo}
        </span>
        <span className="ud-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ''}</span>
        <span className="ud-text">{hl.get(r) ?? r.text}</span>
      </div>
    )
  }

  const items = layout === 'split' ? splitRows(rows) : null

  return (
    <div className={layout === 'split' ? 'ud split' : 'ud'}>
      {items
        ? items.map((it, i) => {
            if (it.kind === 'hunk') return hunkHeader(i, it.text)
            const { left, right } = it
            // ctx has one anchor (new side); otherwise left (old) then right (new)
            const threads = left && left === right ? [left] : [left, right].filter((x): x is LineRow => !!x)
            return (
              <div key={i}>
                <div className="ud-split-row">
                  {half(left, 'old')}
                  {half(right, 'new')}
                </div>
                {threads.map(thread)}
              </div>
            )
          })
        : rows.map((r, i) => {
            if (r.kind === 'hunk') return hunkHeader(i, r.text)
            const a = anchor(r)!
            const open = () => setEditing({ key: keyOf(a.side, a.line) })
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
                  <span className="ud-text">{hl.get(r) ?? r.text}</span>
                </div>
                {thread(r)}
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
