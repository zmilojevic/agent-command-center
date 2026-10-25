import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

/**
 * One xterm instance per pty id, kept outside React so switching chats or closing the panel never loses
 * the buffer. `mountTerminal` moves the instance's DOM into whatever container is current.
 */
interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  opened: boolean
  exited: boolean
  /** True while replayed output is being parsed: xterm's answers to queries inside it must not reach the shell. */
  muted: boolean
  /** Output received before the replay finished is queued, then written if `end` is beyond the replay. */
  replaying: boolean
  queue: ({ data: string; end: number } | { exit: number })[]
  lastEnd: number
  /** Called when the user presses a key after the shell exited (removes the tab). */
  onDismiss?: () => void
}

const entries = new Map<string, Entry>()

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Resolve any CSS colour (var(), color-mix(), ...) to #rrggbb via the computed style and a 1px canvas. */
function resolveColor(value: string): string {
  const probe = document.createElement('span')
  probe.style.color = value
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return computed
  ctx.fillStyle = '#000'
  ctx.fillStyle = computed
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

const ANSI_DARK = [
  '#3a3935', '#c9786a', '#94b496', '#cdb77c', '#86a6c8', '#b494b8', '#7fb0ae', '#bdbab0',
  '#5a5852', '#dc9082', '#a9c7aa', '#dec993', '#9fbbd9', '#c8abcc', '#98c4c2', '#ecebe5',
]
const ANSI_LIGHT = [
  '#3b3a36', '#b2503f', '#4f8a5c', '#9a7a2a', '#3f6fa8', '#8a5c92', '#3a8582', '#6b6860',
  '#5c5952', '#c0614f', '#5f9c6c', '#ad8d3c', '#5b88bd', '#9d72a5', '#55999a', '#8a877e',
]

function terminalTheme(): ITheme {
  const dark = document.documentElement.dataset.theme === 'dark'
  const bg = resolveColor('var(--bg-2)')
  const p = dark ? ANSI_DARK : ANSI_LIGHT
  return {
    background: bg,
    foreground: resolveColor(css('--text-2') || '#bdbab0'),
    cursor: resolveColor('var(--accent-muted)'),
    cursorAccent: bg,
    selectionBackground: dark ? 'rgba(236, 235, 229, 0.2)' : 'rgba(31, 30, 27, 0.16)',
    black: p[0], red: p[1], green: p[2], yellow: p[3], blue: p[4], magenta: p[5], cyan: p[6], white: p[7],
    brightBlack: p[8], brightRed: p[9], brightGreen: p[10], brightYellow: p[11], brightBlue: p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
  }
}

const EXIT_NOTE = (code: number): string => `\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`

function writeExit(e: Entry, code: number): void {
  e.exited = true
  e.term.write(EXIT_NOTE(code))
}

/** The entry for a pty id, created (with a replay of the main-process ring buffer) on first use. */
export function ensureTerminal(id: string, exitedCode?: number): Entry {
  const e = entries.get(id)
  if (e) {
    if (exitedCode !== undefined && !e.exited && !e.replaying) writeExit(e, exitedCode)
    else if (exitedCode !== undefined && !e.exited) e.queue.push({ exit: exitedCode })
    return e
  }
  const term = new Terminal({
    fontFamily: css('--mono') || 'monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: terminalTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_ev, uri) => void window.open(uri)))
  const entry: Entry = { id, term, fit, opened: false, exited: false, muted: true, replaying: true, queue: [], lastEnd: 0 }
  entries.set(id, entry)

  term.onData((d) => {
    if (entry.muted) return
    if (entry.exited) entry.onDismiss?.()
    else window.desktop.ptyWrite(id, d)
  })
  term.onBinary((d) => {
    if (!entry.muted && !entry.exited) window.desktop.ptyWrite(id, d)
  })
  term.onResize(({ cols, rows }) => window.desktop.ptyResize(id, cols, rows))
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const k = ev.key
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (k === '`' || ev.code === 'Backquote')) return false // app toggle (window listener)
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k.toLowerCase() === 'g') return false // app: changes panel
    if (ev.ctrlKey && k === 'Tab') return false // app: next/previous chat
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k.toLowerCase() === 'c') {
      ev.preventDefault()
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && k.toLowerCase() === 'v') {
      ev.preventDefault() // stops the native paste event, which would paste a second time
      void navigator.clipboard.readText().then((t) => t && !entry.exited && term.paste(t))
      return false
    }
    return true
  })

  void window.desktop.ptyReplay(id).then(({ data, end }) => {
    const finish = (): void => {
      entry.muted = false
      entry.lastEnd = end
      entry.replaying = false
      const queued = entry.queue
      entry.queue = []
      for (const q of queued) {
        if ('exit' in q) writeExit(entry, q.exit)
        else if (q.end > entry.lastEnd) {
          term.write(q.data)
          entry.lastEnd = q.end
        }
      }
      if (exitedCode !== undefined && !entry.exited) writeExit(entry, exitedCode)
    }
    // Live chunks stay queued (replaying) until the replay is fully parsed; answers xterm generates meanwhile are dropped.
    if (data) term.write(data, finish)
    else finish()
  })
  return entry
}

let wired = false
/** Subscribes to pty output/exit and theme changes once. */
export function initTerminals(): void {
  if (wired) return
  wired = true
  window.desktop.onPtyData(({ id, data, end }) => {
    const e = ensureTerminal(id)
    if (e.replaying) e.queue.push({ data, end })
    else if (end > e.lastEnd) {
      e.term.write(data)
      e.lastEnd = end
    }
  })
  window.desktop.onPtyExit(({ id, code }) => {
    const e = ensureTerminal(id)
    if (e.replaying) e.queue.push({ exit: code })
    else if (!e.exited) writeExit(e, code)
  })
  new MutationObserver(() => {
    const theme = terminalTheme()
    for (const e of entries.values()) e.term.options.theme = theme
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

export function setDismissHandler(id: string, fn: () => void): void {
  const e = entries.get(id)
  if (e) e.onDismiss = fn
}

/** Attach the terminal to `container` (opens it the first time, otherwise moves its element) and fit it. */
export function mountTerminal(id: string, container: HTMLElement): void {
  const e = ensureTerminal(id)
  if (!e.opened) {
    e.term.open(container)
    e.opened = true
  } else if (e.term.element && e.term.element.parentElement !== container) {
    container.appendChild(e.term.element)
  }
  fitTerminal(id)
  e.term.refresh(0, Math.max(0, e.term.rows - 1))
}

export function unmountTerminal(id: string): void {
  entries.get(id)?.term.element?.remove()
}

export function fitTerminal(id: string): void {
  const e = entries.get(id)
  if (!e?.opened || !e.term.element?.isConnected) return
  try {
    e.fit.fit()
  } catch {
    /* container not laid out yet */
  }
}

export function focusTerminal(id: string): boolean {
  const e = entries.get(id)
  if (!e?.opened || !e.term.element?.isConnected) return false
  e.term.focus()
  return true
}

export function disposeTerminal(id: string): void {
  const e = entries.get(id)
  if (!e) return
  entries.delete(id)
  e.term.dispose()
}

/** True when the keyboard focus sits inside a terminal panel. */
export function terminalHasFocus(): boolean {
  return !!document.activeElement?.closest('.term-panel')
}
