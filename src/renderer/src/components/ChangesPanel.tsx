import { useEffect, useState } from 'react'
import { modLabel } from '../util'
import { RefreshCw, X, ChevronRight, Check, Minus, Undo2, ExternalLink } from 'lucide-react'
import { useStore } from '../store'
import type { ChangedFile } from '@shared/types'
import UnifiedDiff from './UnifiedDiff'
import Dropdown from './Dropdown'
import { openFileInEditor } from '../openIn'

type Confirm = { file: ChangedFile; patch?: string }

const COMMIT_OPTIONS = [
  { value: 'commit', label: 'Commit' },
  { value: 'push', label: 'Commit and push' },
]

function DiscardConfirm({ confirm, onCancel, onConfirm }: { confirm: Confirm; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const hunk = confirm.patch !== undefined
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal rename-modal">
        <div className="modal-head">
          <h3>{hunk ? 'Discard this hunk?' : 'Discard changes?'}</h3>
        </div>
        <p className="modal-text">
          {hunk ? 'This reverts one hunk of ' : confirm.file.status === '?' ? 'This deletes the untracked file ' : 'This throws away all uncommitted changes of '}
          <span className="mono">{confirm.file.path}</span>. It cannot be undone.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" autoFocus onClick={onConfirm}>
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}

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
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [openFiles, setOpenFiles] = useState<Record<string, Record<string, boolean>>>({})
  if (!chat) return null
  const cwd = chat.cwd
  const open = openFiles[cwd] ?? {}
  const toggle = (path: string): void => setOpenFiles((o) => ({ ...o, [cwd]: { ...o[cwd], [path]: !o[cwd]?.[path] } }))
  const files = entry?.files ?? []
  const add = files.reduce((n, f) => n + f.additions, 0)
  const del = files.reduce((n, f) => n + f.deletions, 0)
  const comments = chat.comments
  const stagedCount = files.filter((f) => f.staged === 'all' || f.staged === 'partial').length

  /** Runs a repo action, shows its error inline and refreshes the panel. */
  const act = async (fn: () => Promise<string | null>): Promise<void> => {
    setActionError(null)
    const err = await fn().catch((e) => (e instanceof Error ? e.message : String(e)))
    if (err) setActionError(err)
    await refreshChanges(cwd)
  }
  const ref = (f: ChangedFile) => ({ path: f.path, oldPath: f.oldPath, status: f.status })
  const doDiscard = (): void => {
    const c = confirm
    setConfirm(null)
    if (!c) return
    void act(() => (c.patch !== undefined ? window.desktop.gitDiscardHunk(cwd, c.patch) : window.desktop.gitDiscardFile(cwd, ref(c.file))))
  }
  const askCommit = (mode: string): void => {
    const st = useStore.getState()
    const base = stagedCount > 0 ? 'Commit the staged changes' : 'Stage and commit all current changes'
    const text = `${base} with a concise, descriptive commit message (look at the diff and recent \`git log\` style first).${mode === 'push' ? ' Then push to the remote.' : ''}`
    const c = st.chats[chatId]
    if (c && (c.status === 'running' || c.status === 'compacting')) st.enqueue(chatId, text, [], false)
    else void st.sendMessage(chatId, text)
  }

  return (
    <section className="changes">
      <div className="cp-head">
        <span className="cp-title">Changes</span>
        {files.length > 0 && (
          <span className="cp-sub">
            {files.length} {files.length === 1 ? 'file' : 'files'} <span className="cp-add">+{add}</span> <span className="cp-del">−{del}</span>
          </span>
        )}
        {stagedCount > 0 && <span className="cp-staged">{stagedCount} staged</span>}
        <div className="grow" />
        {files.length > 0 && (
          <Dropdown className="cp-commit-dd" value="" options={COMMIT_OPTIONS} labelOverride="Commit…" onChange={askCommit} title="Ask Claude to commit" />
        )}
        <button className="icon-btn tiny" title="Refresh" onClick={() => void refreshChanges(cwd)}>
          <RefreshCw size={13} className={entry?.loading ? 'cp-spin' : ''} />
        </button>
        <button className="icon-btn tiny" title={`Close (${modLabel('Ctrl+Shift+G')})`} onClick={toggleChanges}>
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
      {actionError && (
        <div className="cp-action-error">
          <span>{actionError}</span>
          <button className="icon-btn tiny" title="Dismiss" onClick={() => setActionError(null)}>
            <X size={12} />
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
                <div className="cp-file-head">
                <button
                  className={`cp-check ${f.staged === 'all' ? 'on' : f.staged === 'partial' ? 'partial' : ''}`}
                  title={f.staged === 'all' ? 'Unstage' : 'Stage'}
                  onClick={() => void act(() => window.desktop.gitSetStaged(cwd, ref(f), f.staged !== 'all'))}
                >
                  {f.staged === 'all' ? <Check size={11} /> : f.staged === 'partial' ? <Minus size={11} /> : null}
                </button>
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
                <span className="cp-file-actions">
                  {f.status !== 'D' && (
                    <button className="icon-btn tiny" title="Open in editor" onClick={() => void openFileInEditor(f.path, entry?.root ?? cwd)}>
                      <ExternalLink size={12} />
                    </button>
                  )}
                  <button className="icon-btn tiny" title="Discard changes…" onClick={() => setConfirm({ file: f })}>
                    <Undo2 size={12} />
                  </button>
                </span>
                </div>
                {isOpen && (
                  <div className="cp-diff">
                    {f.oldPath && <div className="cp-note small">Renamed from {f.oldPath}</div>}
                    {f.binary ? (
                      <div className="cp-note small">Binary file</div>
                    ) : f.diff ? (
                      <UnifiedDiff
                        chatId={chatId}
                        path={f.path}
                        diff={f.diff}
                        comments={fileComments}
                        onDiscardHunk={f.status === '?' ? undefined : (patch) => setConfirm({ file: f, patch })}
                      />
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
      {confirm && <DiscardConfirm confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={doDiscard} />}
    </section>
  )
}
