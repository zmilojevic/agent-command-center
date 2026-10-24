import { useEffect, useRef, useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { useStore, type Chat } from '../store'
import { defaultContextWindow, fmtTokens } from '../util'

function short(n: number): string {
  return fmtTokens(n).replace(/\.0([kM])$/, '$1')
}

const CAT_HUES = [18, 205, 145, 275, 45, 330, 95, 180]
const catColor = (i: number): string => `hsl(${CAT_HUES[i % CAT_HUES.length]} 32% var(--chip-l))`

/** autoCompactThreshold may arrive as tokens, a percentage or a fraction. */
function thresholdTokens(t: number | undefined, max: number): number | undefined {
  if (t == null || !(t > 0)) return undefined
  if (t <= 1) return t * max
  if (t <= 100) return (t / 100) * max
  return t
}

/** Thin context-usage bar for the top bar, with a breakdown popover on hover. */
export default function ContextMeter({ chat }: { chat: Chat }) {
  const sendMessage = useStore((s) => s.sendMessage)
  const enqueue = useStore((s) => s.enqueue)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const ctx = chat.context
  const compacting = chat.status === 'compacting'
  const max = ctx?.maxTokens || defaultContextWindow(chat.model)
  const used = ctx?.totalTokens ?? 0
  const pct = ctx ? Math.min(100, ctx.percentage ?? (used / max) * 100) : 0
  const threshold = thresholdTokens(ctx?.autoCompactThreshold, max)
  const thresholdPct = threshold ? Math.min(100, (threshold / max) * 100) : undefined

  const show = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hide = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 180)
  }

  const compact = (): void => {
    setOpen(false)
    const busy = chat.status === 'running' || chat.status === 'compacting'
    // While a turn runs, wait for it in the queue; the composer's draft stays.
    if (busy) enqueue(chat.chatId, '/compact', [], false)
    else void sendMessage(chat.chatId, '/compact')
  }

  const lt = chat.lastTurn
  const cats = (ctx?.categories ?? []).filter((c) => c.tokens > 0 && c.kind !== 'deferred')
  const usedCats = cats.filter((c) => c.kind === 'used')
  const colorOf = new Map(usedCats.map((c, i) => [c, catColor(i)]))
  const segments = (): React.ReactNode => {
    if (!usedCats.length) return null
    let left = 0
    return (
      <span className="ctx-segs">
        {usedCats.map((c) => {
          const w = Math.min(100 - left, (c.tokens / max) * 100)
          const el = <span key={c.id ?? c.name} className="ctx-seg" style={{ left: `${left}%`, width: `${Math.max(w, 0)}%`, background: colorOf.get(c) }} />
          left += w
          return el
        })}
      </span>
    )
  }
  const deferred = (ctx?.categories ?? []).filter((c) => c.tokens > 0 && c.kind === 'deferred')

  return (
    <div className="ctx-meter-wrap" onMouseEnter={show} onMouseLeave={hide}>
      <div className={`ctx-meter ${compacting ? 'compacting' : ''}`}>
        <span className="ctx-meter-bar">
          {usedCats.length ? segments() : <span className="ctx-meter-fill" style={{ width: compacting ? '100%' : `${Math.max(pct, ctx ? 1 : 0)}%` }} />}
          {thresholdPct != null && <span className="ctx-meter-mark" style={{ left: `${thresholdPct}%` }} />}
        </span>
        <span className={`ctx-meter-text ${pct >= 80 ? 'hot' : ''}`}>
          {compacting ? 'Compacting…' : ctx ? `${short(used)} / ${short(max)} · ${Math.round(pct)}%` : 'Context —'}
        </span>
      </div>
      {open && (
        <div className="ctx-pop" onMouseEnter={show} onMouseLeave={hide}>
          <div className="ctx-pop-head">
            <span>Context window</span>
            <span className="muted">{ctx ? `${short(used)} of ${short(max)}` : 'not reported yet'}</span>
          </div>
          {ctx && (
            <div className={`ctx-pop-bar ${compacting ? 'compacting' : ''}`}>
              {usedCats.length ? segments() : <span className="ctx-meter-fill" style={{ width: `${Math.max(pct, 1)}%` }} />}
              {thresholdPct != null && <span className="ctx-meter-mark" style={{ left: `${thresholdPct}%` }} />}
            </div>
          )}
          {cats.length > 0 && (
            <table className="ctx-cats">
              <tbody>
                {cats.map((c) => (
                  <tr key={c.id ?? c.name} className={c.kind}>
                    <td>
                      <span className={`ctx-swatch ${c.kind}`} style={colorOf.has(c) ? { background: colorOf.get(c) } : undefined} />
                      {c.name}
                    </td>
                    <td className="num">{short(c.tokens)}</td>
                    <td className="num muted">{c.tokens / max < 0.001 ? '<0.1' : ((c.tokens / max) * 100).toFixed(c.tokens / max < 0.1 ? 1 : 0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {lt && (
            <table className="ctx-cats ctx-last">
              <thead>
                <tr>
                  <td colSpan={2}>Last turn</td>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Input</td>
                  <td className="num">{short(lt.freshInput)}</td>
                </tr>
                <tr>
                  <td>Cache read</td>
                  <td className="num">{short(lt.cacheRead)}</td>
                </tr>
                <tr>
                  <td>Cache write</td>
                  <td className="num">{short(lt.cacheWrite)}</td>
                </tr>
                <tr>
                  <td>Output</td>
                  <td className="num">{short(lt.outputTokens)}</td>
                </tr>
                {lt.inputTokens > 0 && (
                  <tr>
                    <td>Cache hit</td>
                    <td className="num">{Math.round((lt.cacheRead / lt.inputTokens) * 100)}%</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {deferred.length > 0 && (
            <div className="muted small">Deferred (loaded on demand): {deferred.map((c) => `${c.name} ${short(c.tokens)}`).join(', ')}</div>
          )}
          {threshold != null && (
            <div className="muted small">
              Auto-compacts at about {short(threshold)} ({Math.round(thresholdPct ?? 0)}%)
            </div>
          )}
          <div className="ctx-pop-actions">
            <button className="btn small-btn" onClick={compact} disabled={chat.closed || compacting || chat.status === 'starting'} title="Send /compact">
              <Minimize2 size={13} /> Compact
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
