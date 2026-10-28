import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useStore } from '../store'
import Dropdown from './Dropdown'
import { modelLabel, projectName, projectRoot, relativeTime, shortPath } from '../util'
import type { UsageDayRow, UsageHistory } from '@shared/types'

const RANGES = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: 0 },
]
const TOP = 10
const CAT_HUES = [18, 205, 145, 275, 45, 330, 95, 180]
const hue = (i: number): string => `hsl(${CAT_HUES[i % CAT_HUES.length]} 32% var(--chip-l))`

interface Tot {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  messages: number
}
const zero = (): Tot => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, messages: 0 })
const add = (t: Tot, r: Tot): void => {
  t.input += r.input
  t.cacheWrite += r.cacheWrite
  t.cacheRead += r.cacheRead
  t.output += r.output
  t.messages += r.messages
}
/** Cache reads are excluded: they are re-reads of the same context, not new tokens. */
const total = (t: Tot): number => t.input + t.cacheWrite + t.output

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`.replace('.0B', 'B')
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`.replace('.0M', 'M')
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`.replace('.0k', 'k')
  return String(n)
}
const detail = (t: Tot): string =>
  `${t.input.toLocaleString()} input · ${t.cacheWrite.toLocaleString()} cache write · ${t.cacheRead.toLocaleString()} cache read · ${t.output.toLocaleString()} output · ${t.messages.toLocaleString()} messages`

function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function lastDays(n: number): string[] {
  const out: string[] = []
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - (n - 1))
  for (let i = 0; i < n; i++) {
    out.push(dayKey(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

interface Item {
  key: string
  name: string
  tip: string
  /** Folder shown next to the name when several visible rows share it. */
  sub?: string
  tot: Tot
}

function fold(items: Item[]): Item[] {
  const sorted = [...items].sort((a, b) => total(b.tot) - total(a.tot))
  if (sorted.length <= TOP) return sorted
  const top = sorted.slice(0, TOP)
  const rest = sorted.slice(TOP)
  const tot = zero()
  for (const r of rest) add(tot, r.tot)
  return [...top, { key: '\0other', name: `Other (${rest.length})`, tip: rest.map((r) => r.name).join(', '), tot }]
}

function Section({ title, items, grand }: { title: string; items: Item[]; grand: number }) {
  const max = items.length ? total(items[0].tot) : 0
  const counts = new Map<string, number>()
  for (const it of items) counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
  return (
    <section className="uh-section">
      <h4>{title}</h4>
      {items.length === 0 && <div className="muted small">No usage in this range</div>}
      {items.map((it) => {
        const v = total(it.tot)
        return (
          <div key={it.key} className="uh-row" title={`${it.tip}\n${detail(it.tot)}`}>
            <div className="uh-row-head">
              <span className="uh-name">
                {it.name}
                {it.sub && counts.get(it.name)! > 1 && <span className="uh-sub muted">{it.sub}</span>}
              </span>
              <span className="uh-val">{fmt(v)}</span>
              <span className="uh-pct muted">{grand ? Math.round((v / grand) * 100) : 0}%</span>
            </div>
            <span className="uh-bar">
              <span className="uh-fill" style={{ width: `${max ? Math.max(v > 0 ? 1 : 0, (v / max) * 100) : 0}%` }} />
            </span>
          </div>
        )
      })}
    </section>
  )
}

export default function UsageHistoryDialog() {
  const close = useStore((s) => s.closeUsageHistory)
  const projectNames = useStore((s) => s.projectNames)
  const generalDir = useStore((s) => s.generalDir)
  const [range, setRange] = useState('30')
  const [data, setData] = useState<UsageHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [, setTick] = useState(0)
  const [home, setHome] = useState('')
  useEffect(() => {
    void window.desktop.homeDir().then(setHome)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    void window.desktop
      .usageHistory()
      .then((h) => setData(h))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.dd-menu')) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const days = RANGES.find((r) => r.value === range)!.days
  const rows: UsageDayRow[] = useMemo(() => {
    if (!data) return []
    if (!days) return data.rows
    const from = lastDays(days)[0]
    return data.rows.filter((r) => r.day >= from)
  }, [data, days])

  const { sum, projects, models, modelOrder } = useMemo(() => {
    const sum = zero()
    const byProj = new Map<string, Item>()
    const byModel = new Map<string, Item>()
    for (const r of rows) {
      add(sum, { ...r })
      const root = r.cwd ? projectRoot(r.cwd) : ''
      const isChat = !!generalDir && r.cwd === generalDir
      const key = isChat ? '\0chats' : root
      let p = byProj.get(key)
      if (!p) byProj.set(key, (p = { key, name: isChat ? 'Chats' : root ? projectName(projectNames, root) : 'Unknown', tip: isChat ? 'General chats' : root, sub: isChat || !root ? undefined : shortPath(root, home), tot: zero() }))
      add(p.tot, { ...r })
      let m = byModel.get(r.model)
      if (!m) byModel.set(r.model, (m = { key: r.model, name: modelLabel(r.model), tip: r.model, tot: zero() }))
      add(m.tot, { ...r })
    }
    const models = fold([...byModel.values()])
    return {
      sum,
      projects: fold([...byProj.values()]),
      models,
      modelOrder: [...byModel.values()].sort((a, b) => total(b.tot) - total(a.tot)).map((m) => m.key),
    }
  }, [rows, projectNames, generalDir, home])

  const grand = total(sum)
  const chartDays = range === 'today' ? [] : lastDays(range === 'all' ? 90 : days)
  const chart = useMemo(() => {
    if (!chartDays.length) return null
    const perDay = new Map<string, Map<string, number>>()
    for (const r of rows) {
      let m = perDay.get(r.day)
      if (!m) perDay.set(r.day, (m = new Map()))
      m.set(r.model, (m.get(r.model) ?? 0) + r.input + r.cacheWrite + r.output)
    }
    let max = 0
    const cols = chartDays.map((d) => {
      const m = perDay.get(d) ?? new Map<string, number>()
      let t = 0
      for (const v of m.values()) t += v
      max = Math.max(max, t)
      return { day: d, m, t }
    })
    return { cols, max }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, range])

  const upd = data ? (relativeTime(data.scannedAt) === 'now' ? 'just now' : `${relativeTime(data.scannedAt)} ago`) : ''

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal uh-modal">
        <div className="modal-head">
          <h3>Usage history</h3>
          <button className="icon-btn" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="uh-controls">
          <Dropdown className="theme-dd" value={range} options={RANGES.map(({ value, label }) => ({ value, label }))} onChange={setRange} title="Time range" />
          <button className="icon-btn" title="Refresh" disabled={loading} onClick={load}>
            <RefreshCw size={14} className={loading ? 'uh-spin' : ''} />
          </button>
          <span className="muted small">
            {loading ? 'Scanning…' : data ? `${data.files.toLocaleString()} files · updated ${upd}` : ''}
          </span>
        </div>
        <div className="uh-body">
          <div className="uh-summary">
            <div className="uh-total">
              {fmt(grand)} <span className="muted">tokens · cache reads excluded</span>
            </div>
            <div className="muted small">
              {fmt(sum.input)} input · {fmt(sum.cacheWrite)} cache write · {fmt(sum.cacheRead)} cache read · {fmt(sum.output)} output ·{' '}
              {sum.messages.toLocaleString()} messages
            </div>
          </div>
          <div className="uh-cols">
            <Section title="By project" items={projects} grand={grand} />
            <Section title="By model" items={models} grand={grand} />
          </div>
          {chart && (
            <section className="uh-section">
              <h4>Daily{range === 'all' ? ' (last 90 days)' : ''}</h4>
              <div className="uh-chart">
                {chart.cols.map((c) => {
                  const tip = [c.day, ...modelOrder.filter((k) => c.m.get(k)).map((k) => `${modelLabel(k)}: ${fmt(c.m.get(k)!)}`), `Total: ${fmt(c.t)}`].join('\n')
                  return (
                    <div key={c.day} className="uh-col" title={tip}>
                      <div className="uh-stack" style={{ height: `${chart.max ? (c.t / chart.max) * 100 : 0}%` }}>
                        {modelOrder.map((k, i) =>
                          c.m.get(k) ? <span key={k} className="uh-seg" style={{ flexGrow: c.m.get(k), background: hue(i) }} /> : null,
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="uh-axis muted small">
                <span>{chart.cols[0].day}</span>
                <span>{chart.cols[chart.cols.length - 1].day}</span>
              </div>
              <div className="uh-legend small">
                {modelOrder
                  .map((k, i) => ({ k, i }))
                  .filter(({ k }) => chart.cols.some((c) => c.m.get(k)))
                  .map(({ k, i }) => (
                    <span key={k} className="uh-leg">
                      <span className="uh-dot" style={{ background: hue(i) }} />
                      {modelLabel(k)}
                    </span>
                  ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
