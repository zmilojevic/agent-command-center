import { useMemo } from 'react'
import { diffLines } from 'diff'
import { highlightRows, langForPath } from '../highlight'

export default function DiffView({ oldText, newText, path }: { oldText: string; newText: string; path?: string }) {
  const rows = useMemo(() => {
    const out: { kind: 'add' | 'del' | 'ctx'; text: string }[] = []
    for (const p of diffLines(oldText, newText)) {
      const lines = p.value.replace(/\n$/, '').split('\n')
      for (const l of lines) out.push({ kind: p.added ? 'add' : p.removed ? 'del' : 'ctx', text: l })
    }
    return out
  }, [oldText, newText])
  const hl = useMemo(() => highlightRows(rows, path ? langForPath(path) : null), [rows, path])
  return (
    <pre className="diff">
      {rows.map((r, i) => (
        <div key={i} className={`diff-line ${r.kind}`}>
          <span className="diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
          {hl.get(r) ?? r.text}
        </div>
      ))}
    </pre>
  )
}
