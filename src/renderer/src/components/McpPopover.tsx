import { useCallback, useEffect, useRef, useState } from 'react'
import { Plug, RefreshCw, ChevronRight } from 'lucide-react'
import type { McpServerInfo } from '@shared/types'
import type { Chat } from '../store'

const STATUS_TITLE: Record<McpServerInfo['status'], string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs authentication',
  pending: 'Connecting',
  disabled: 'Disabled',
}

/** Plug button in the top bar: MCP servers of the active project chat, with enable/disable and reconnect. */
export default function McpPopover({ chat }: { chat: Chat }) {
  const { chatId, status } = chat
  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setServers(await window.desktop.mcpStatus(chatId))
  }, [chatId])

  // Count/dot stay current across chat switches and turns; an open popover refreshes the same way.
  useEffect(() => {
    setServers(null)
    setExpanded(null)
  }, [chatId])
  useEffect(() => {
    void refresh()
  }, [refresh, status, open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const act = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name)
    try {
      await fn()
    } finally {
      await refresh()
      setBusy(null)
    }
  }

  const list = servers ?? []
  const connected = list.filter((s) => s.status === 'connected').length
  const problem = list.some((s) => s.status === 'failed' || s.status === 'needs-auth')

  return (
    <div className="settings mcp" ref={root}>
      <button className={`icon-btn mcp-btn ${open ? 'on' : ''}`} title="MCP servers" onClick={() => setOpen(!open)}>
        <Plug size={14} />
        {list.length > 0 && <span className="mcp-count">{connected}</span>}
        {problem && <span className="mcp-dot" />}
      </button>
      {open && (
        <div className="settings-pop mcp-pop">
          <div className="mcp-head">MCP servers</div>
          {servers && list.length === 0 && <div className="muted small mcp-empty">No MCP servers configured</div>}
          {!servers && <div className="muted small mcp-empty">Loading…</div>}
          {list.map((s) => {
            const isOpen = expanded === s.name
            const canExpand = s.tools.length > 0
            return (
              <div className="mcp-server" key={s.name}>
                <div className="mcp-row">
                  <button
                    className="mcp-main"
                    disabled={!canExpand}
                    onClick={() => setExpanded(isOpen ? null : s.name)}
                    title={canExpand ? 'Show tools' : undefined}
                  >
                    <ChevronRight size={12} className={`mcp-chev ${isOpen ? 'open' : ''} ${canExpand ? '' : 'hidden'}`} />
                    <span className={`mcp-status ${s.status}`} title={STATUS_TITLE[s.status]} />
                    <span className="mcp-name" title={s.name}>{s.name}</span>
                    {(s.scope || s.source) && <span className="mcp-chip">{s.scope ?? s.source}</span>}
                    {canExpand && <span className="mcp-tools-n">{s.tools.length} tools</span>}
                  </button>
                  {s.status !== 'disabled' && s.status !== 'pending' && (
                    <button
                      className="icon-btn"
                      title="Reconnect"
                      disabled={busy === s.name}
                      onClick={() => void act(s.name, () => window.desktop.mcpReconnect(chatId, s.name))}
                    >
                      <RefreshCw size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={s.status !== 'disabled'}
                    title={s.status === 'disabled' ? 'Enable' : 'Disable'}
                    disabled={busy === s.name}
                    className={`switch ${s.status !== 'disabled' ? 'on' : ''}`}
                    onClick={() => void act(s.name, () => window.desktop.mcpToggle(chatId, s.name, s.status === 'disabled'))}
                  >
                    <span className="knob" />
                  </button>
                </div>
                {s.status === 'failed' && <div className="mcp-note err">{s.error || 'Connection failed'}</div>}
                {s.status === 'needs-auth' && <div className="mcp-note">needs authentication – run /mcp in a terminal</div>}
                {isOpen && (
                  <ul className="mcp-tools">
                    {s.tools.map((t) => (
                      <li key={t.name}>
                        <span className="mcp-tool-name">{t.name}</span>
                        {t.description && <span className="mcp-tool-desc">{t.description.split('\n')[0]}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
