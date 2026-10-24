import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { useStore } from '../store'

const HL = 'ccd-search'
const HL_CURRENT = 'ccd-search-current'

function clearHighlights(): void {
  CSS.highlights?.delete(HL)
  CSS.highlights?.delete(HL_CURRENT)
}

/** Every case-insensitive occurrence of q in the text nodes under root. */
function findRanges(root: Element, q: string): Range[] {
  const needle = q.toLowerCase()
  const out: Range[] = []
  if (!needle) return out
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data.toLowerCase()
    let i = text.indexOf(needle)
    while (i !== -1) {
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + needle.length)
      out.push(r)
      i = text.indexOf(needle, i + needle.length)
    }
  }
  return out
}

/**
 * Ctrl+F find bar over the chat. Matches are painted with the CSS Custom
 * Highlight API, so the message DOM is never modified.
 */
export default function FindBar({ chatId }: { chatId: string }) {
  const setFindOpen = useStore((s) => s.setFindOpen)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(0)
  const ranges = useRef<Range[]>([])
  const input = useRef<HTMLInputElement>(null)
  const currentRef = useRef(0)
  currentRef.current = current

  const paint = useCallback((idx: number, scroll: boolean) => {
    const rs = ranges.current
    if (!CSS.highlights) return
    if (!rs.length) {
      clearHighlights()
      return
    }
    CSS.highlights.set(HL, new Highlight(...rs))
    const cur = rs[idx]
    CSS.highlights.set(HL_CURRENT, new Highlight(cur))
    if (!scroll) return
    const scroller = document.querySelector('.chat-scroll')
    if (!scroller) return
    const box = scroller.getBoundingClientRect()
    const r = cur.getBoundingClientRect()
    if (r.top < box.top + 40 || r.bottom > box.bottom - 40) {
      scroller.scrollTop += r.top - box.top - box.height / 2
    }
  }, [])

  const run = useCallback(
    (q: string, keepIndex: boolean, scroll: boolean) => {
      const root = document.querySelector('.chat-col')
      ranges.current = root ? findRanges(root, q) : []
      const n = ranges.current.length
      const idx = n === 0 ? 0 : keepIndex ? Math.min(currentRef.current, n - 1) : 0
      setCount(n)
      setCurrent(idx)
      paint(idx, scroll)
    },
    [paint],
  )

  // New query or chat: search from the top.
  useEffect(() => {
    run(query, false, true)
  }, [query, chatId, run])

  // Messages stream in while the bar is open: re-run, debounced, keeping the position.
  useEffect(() => {
    const root = document.querySelector('.chat-col')
    if (!root || !query) return
    let t: ReturnType<typeof setTimeout> | null = null
    const mo = new MutationObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => run(query, true, false), 250)
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      if (t) clearTimeout(t)
    }
  }, [query, chatId, run])

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    const refocus = (): void => {
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('ccd-find-focus', refocus)
    return () => {
      window.removeEventListener('ccd-find-focus', refocus)
      clearHighlights()
    }
  }, [])

  const step = (dir: 1 | -1): void => {
    const n = ranges.current.length
    if (!n) return
    const idx = (current + dir + n) % n
    setCurrent(idx)
    paint(idx, true)
  }

  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        value={query}
        placeholder="Find in chat"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setFindOpen(false)
          }
        }}
      />
      <span className="find-count">{query ? (count ? `${current + 1} / ${count}` : 'No matches') : ''}</span>
      <button className="icon-btn tiny" title="Previous (Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn tiny" title="Next (Enter)" disabled={!count} onClick={() => step(1)}>
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn tiny" title="Close (Esc)" onClick={() => setFindOpen(false)}>
        <X size={14} />
      </button>
    </div>
  )
}
