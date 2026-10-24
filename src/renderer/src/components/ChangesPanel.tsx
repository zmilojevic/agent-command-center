import { useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { RefreshCw, X, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import type { ChangedFile } from '@shared/types'
import UnifiedDiff from './UnifiedDiff'

const STATUS_LETTER: Record<ChangedFile['status'], string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': 'U' }
const STATUS_TITLE: Record<ChangedFile['status'], string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'Untracked' }

function FilePath({ path }: { path: string }) {
  const i = path.lastIndexOf('/')
  return (
    <span className="cp-path" title={path}>
      {/* rtl keeps the tail visible when long; the LRM marks stop bidi moving the trailing "/" to the front */}
      {i >= 0 && <span className="cp-dir">{'\u200E' + path.slice(0, i + 1) + '\u200E'}</span>}
      <span className="cp-base">{path.slice(i + 1)}</span>
    </span>
  )
}

/** Right-hand panel: uncommitted changes of the active chat's folder with reviewable diffs. */
export default function ChangesPanel({ chatId }: { chatId: string }) {
  const chat = useStore((s) => s.chats[chatId])
  const entry = useStore((s) => (s.chats[chatId] ? s.changes[s.chats[chatId].cwd] : undefined))
  const refreshChanges = useStore((s) => s.refreshChanges)
  const toggleChanges = useStore((s) => s.toggleChanges)
  const sendComments = useStore((s) => s.sendComments)
  const removeComment = useStore((s) => s.removeComment)
  const width = useStore((s) => s.changesWidth)
  const setWidth = useStore((s) => s.setChangesWidth)
  const [dragging, setDragging] = useState(false)
  const [openFiles, setOpenFiles] = useState<Record<string, Record<string, boolean>>>({})
  if (!chat) return null
  const cwd = chat.cwd
  const open = openFiles[cwd] ?? {}
  const toggle = (path: string): void => setOpenFiles((o) => ({ ...o, [cwd]: { ...o[cwd], [path]: !o[cwd]?.[path] } }))
  const files = entry?.files ?? []
  const add = files.reduce((n, f) => n + f.additions, 0)
  const del = files.reduce((n, f) => n + f.deletions, 0)
  const comments = chat.comments

  const onResizeDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
    setDragging(true)
  }
  const onResizeMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const row = e.currentTarget.closest('.main-row')
    if (!row) return
    const r = row.getBoundingClientRect()
    setWidth(Math.min(r.right - e.clientX, r.width * 0.75))
  }
  const onResizeUp = (e: RPointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.userSelect = ''
    setDragging(false)
  }

  return (
    <aside className="changes" style={{ '--cp-w': `${width}px` } as CSSProperties}>
      <div
        className={'cp-resize' + (dragging ? ' dragging' : '')}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setWidth(520)}
      />
      <div className="cp-head">
        <span className="cp-title">Changes</span>
        {files.length > 0 && (
          <span className="cp-sub">
            {files.length} {files.length === 1 ? 'file' : 'files'} <span className="cp-add">+{add}</span> <span className="cp-del">−{del}</span>
          </span>
        )}
        <div className="grow" />
        <button className="icon-btn tiny" title="Refresh" onClick={() => void refreshChanges(cwd)}>
          <RefreshCw size={13} className={entry?.loading ? 'cp-spin' : ''} />
        </button>
        <button className="icon-btn tiny" title="Close (Ctrl+Shift+G)" onClick={toggleChanges}>
          <X size={14} />
        </button>
      </div>
      {comments.length > 0 && (
        <div className="cp-review">
          <span>
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
          <div className="grow" />
          <button className="cp-discard" onClick={() => comments.forEach((c) => removeComment(chatId, c.id))}>
            Discard
          </button>
          <button className="cp-send" onClick={() => sendComments(chatId)}>
            Send to Claude
          </button>
        </div>
      )}
      <div className="cp-body">
        {!entry || (entry.loading && !entry.fetchedAt && !files.length) ? (
          <div className="cp-note">Loading…</div>
        ) : !entry.isRepo ? (
          <div className="cp-note">Not a git repository</div>
        ) : entry.error ? (
          <div className="cp-note cp-error">{entry.error}</div>
        ) : files.length === 0 ? (
          <div className="cp-note">No uncommitted changes</div>
        ) : (
          files.map((f) => {
            const isOpen = !!open[f.path]
            const fileComments = comments.filter((c) => c.path === f.path)
            return (
              <div key={f.path} className="cp-file">
                <button className={`cp-file-row ${isOpen ? 'open' : ''}`} onClick={() => toggle(f.path)}>
                  <ChevronRight size={12} className="cp-chev" />
                  <span className={`cp-status s-${f.status === '?' ? 'U' : f.status}`} title={STATUS_TITLE[f.status]}>
                    {STATUS_LETTER[f.status]}
                  </span>
                  <FilePath path={f.path} />
                  {fileComments.length > 0 && <span className="cp-count">{fileComments.length}</span>}
                  <span className="cp-add">+{f.additions}</span>
                  <span className="cp-del">−{f.deletions}</span>
                </button>
                {isOpen && (
                  <div className="cp-diff">
                    {f.oldPath && <div className="cp-note small">Renamed from {f.oldPath}</div>}
                    {f.binary ? (
                      <div className="cp-note small">Binary file</div>
                    ) : f.diff ? (
                      <UnifiedDiff chatId={chatId} path={f.path} diff={f.diff} comments={fileComments} />
                    ) : (
                      <div className="cp-note small">Diff not loaded (too many changes)</div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
        {entry?.truncated && <div className="cp-note small">Too many changes: diffs of the remaining files are not loaded.</div>}
      </div>
    </aside>
  )
}
