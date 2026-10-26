import { useEffect, useRef, useState } from 'react'
import type { PlanUsage, UsageRow } from '../../../shared/types'
import { relativeTime } from '../util'

function until(iso: string | null, now: number): string {
  if (!iso) return ''
  const m = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60000))
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function localStamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' })
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${wd} ${t}`
}

const GROUPS: Record<string, string> = { session: 'Session (5 h)', weekly: 'Weekly' }
const groupTitle = (g: string): string => GROUPS[g] ?? g.charAt(0).toUpperCase() + g.slice(1)
const sevClass = (s: string): string => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : '')

function money(minor: number | null, cur: string | null): string {
  if (minor == null) return '—'
  const v = minor / 100
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur ?? 'USD' }).format(v)
  } catch {
    return `${v.toFixed(2)} ${cur ?? ''}`.trim()
  }
}

function Bar({ row, big }: { row: UsageRow; big?: boolean }) {
  return (
    <span className={`usage-bar ${big ? 'big' : ''}`}>
      <span className={`usage-fill ${sevClass(row.severity)}`} style={{ width: `${Math.min(100, Math.max(row.percent, row.percent > 0 ? 1 : 0))}%` }} />
    </span>
  )
}

/** Claude plan usage (5 h session) in the top bar; hover lists every limit. */
export default function UsageMeter() {
  const [usage, setUsage] = useState<PlanUsage | null>(null)
  const [now, setNow] = useState(Date.now())
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.desktop.getUsage().then((u) => u && setUsage(u))
    const off = window.desktop.onUsage(setUsage)
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(t)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  const show = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (!open) {
      setNow(Date.now())
      if (!usage || Date.now() - usage.fetchedAt > 2 * 60_000) void window.desktop.getUsage(true).then((u) => u && setUsage(u))
    }
    setOpen(true)
  }
  const hide = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 180)
  }

  if (!usage || !usage.available || usage.rows.length === 0) return null
  const main = usage.rows.find((r) => r.group === 'session' || r.kind === 'session') ?? usage.rows.find((r) => r.active)
  if (!main) return null

  const groups: { group: string; rows: UsageRow[] }[] = []
  for (const r of usage.rows) {
    const g = groups.find((x) => x.group === r.group)
    if (g) g.rows.push(r)
    else groups.push({ group: r.group, rows: [r] })
  }
  const sub = usage.subscription ? usage.subscription.charAt(0).toUpperCase() + usage.subscription.slice(1) : ''
  const reset = until(main.resetsAt, now)

  return (
    <div className="ctx-meter-wrap" onMouseEnter={show} onMouseLeave={hide}>
      <div className="ctx-meter">
        <span className="ctx-meter-text">{Math.round(main.percent)}%</span>
        <Bar row={main} />
        {reset && <span className="ctx-meter-text">{reset}</span>}
      </div>
      {open && (
        <div className="ctx-pop usage-pop" onMouseEnter={show} onMouseLeave={hide}>
          <div className="ctx-pop-head">
            <span>Plan usage</span>
            <span className="muted">{sub}</span>
          </div>
          {groups.map((g) => (
            <div key={g.group} className="usage-group">
              <div className="usage-group-title">{groupTitle(g.group)}</div>
              {g.rows.map((r, i) => (
                <div key={`${r.kind}-${i}`} className="usage-row">
                  <div className="usage-row-head">
                    <span>{r.label}</span>
                    <span className="usage-pct">{Math.round(r.percent)}%</span>
                  </div>
                  <Bar row={r} big />
                  {r.resetsAt && (
                    <div className="usage-reset muted">
                      Resets in {until(r.resetsAt, now)} · {localStamp(r.resetsAt)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {usage.extra?.enabled && (
            <div className="usage-row-head">
              <span>Extra usage</span>
              <span className="muted">
                {money(usage.extra.usedCredits, usage.extra.currency)}
                {usage.extra.monthlyLimit != null && ` / ${money(usage.extra.monthlyLimit, usage.extra.currency)}`}
              </span>
            </div>
          )}
          {usage.error && <div className="muted small">Couldn't refresh: {usage.error}</div>}
          <div className="muted small">Updated {relativeTime(usage.fetchedAt) === 'now' ? 'just now' : `${relativeTime(usage.fetchedAt)} ago`}</div>
        </div>
      )}
    </div>
  )
}
