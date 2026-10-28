import { useMemo } from 'react'
import { highlightRows, langForPath } from '../highlight'
import { activeProjectCwd, openFileInEditor } from '../openIn'
import { isPhone } from '../util'
import { parseUnifiedDiff } from './UnifiedDiff'

export interface PatchChange {
  path: string
  kind?: string
  diff?: string
  move_path?: string
}

type PRow = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

const MAX_ROWS = 400

/** Rows of one Codex file change: its unified diff when it has hunks, else the whole content as added / removed / plain lines. */
function rowsOf(c: PatchChange): PRow[] {
  const diff = c.diff ?? ''
  if (/^@@ /m.test(diff)) return parseUnifiedDiff(diff).map((r) => ({ kind: r.kind, text: r.text }))
  const lines = diff.replace(/\n$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return []
  const kind = c.kind === 'add' ? 'add' : c.kind === 'delete' ? 'del' : 'ctx'
  return lines.map((text) => ({ kind, text }))
}

function PatchFile({ chatId, c }: { chatId: string; c: PatchChange }) {
  const all = useMemo(() => rowsOf(c), [c.diff, c.kind])
  const rows = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all
  const hl = useMemo(() => highlightRows(rows, langForPath(c.path)), [rows, c.path])
  const cwd = activeProjectCwd(chatId)
  const openable = !!cwd && !isPhone
  return (
    <section className="patch-file">
      <div className="patch-head">
        <span className="patch-kind">{c.kind ?? 'update'}</span>
        <span
          className={`patch-path${openable ? ' openable' : ''}`}
          title={openable ? 'Open in editor' : c.path}
          onClick={openable ? () => void openFileInEditor(c.path, cwd!) : undefined}
        >
          {c.path}
        </span>
        {c.move_path && <span className="patch-move muted">→ {c.move_path}</span>}
      </div>
      {rows.length > 0 && (
        <pre className="diff">
          {rows.map((r, i) =>
            r.kind === 'hunk' ? (
              <div key={i} className="diff-line hunk">
                {r.text}
              </div>
            ) : (
              <div key={i} className={`diff-line ${r.kind}`}>
                <span className="diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                {hl.get(r) ?? r.text}
              </div>
            ),
          )}
          {all.length > rows.length && <div className="diff-line hunk">… {all.length - rows.length} more lines</div>}
        </pre>
      )}
    </section>
  )
}

/** Codex `ApplyPatch` input ({changes:[{path,kind,diff}]}): one section per file. */
export default function PatchView({ chatId, input }: { chatId: string; input: unknown }) {
  const changes = ((input as { changes?: PatchChange[] } | null)?.changes ?? []).filter((c) => c && typeof c.path === 'string')
  if (!changes.length) return <div className="muted small">No file changes.</div>
  return (
    <div className="patch">
      {changes.map((c, k) => (
        <PatchFile key={`${c.path}:${k}`} chatId={chatId} c={c} />
      ))}
    </div>
  )
}
