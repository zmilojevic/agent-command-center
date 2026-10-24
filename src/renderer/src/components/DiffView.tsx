import { diffLines } from 'diff'

export default function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = diffLines(oldText, newText)
  const rows: { kind: 'add' | 'del' | 'ctx'; text: string }[] = []
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n')
    for (const l of lines) rows.push({ kind: p.added ? 'add' : p.removed ? 'del' : 'ctx', text: l })
  }
  return (
    <pre className="diff">
      {rows.map((r, i) => (
        <div key={i} className={`diff-line ${r.kind}`}>
          <span className="diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
          {r.text}
        </div>
      ))}
    </pre>
  )
}
