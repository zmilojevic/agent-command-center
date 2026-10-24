import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square, Eraser, X, Clock, ImagePlus, CornerDownLeft, Flame } from 'lucide-react'
import Dropdown from './Dropdown'
import ImageThumb from './ImageThumb'
import { useStore, isGeneral } from '../store'
import { EFFORT_LEVELS, PERMISSION_MODES, type PermissionMode, type SlashCommandInfo, type AgentChoice } from '@shared/types'
import { modelLabel } from '../util'
import { dataUrl, readImages } from '../images'

const FALLBACK_MODELS: { value: string; displayName: string; description?: string }[] = [
  { value: 'default', displayName: 'Default' },
  { value: 'fable', displayName: 'Fable' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
]

/** Commands the picker always offers, whatever the CLI reports. */
const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: 'compact', description: 'Summarise the conversation to free up context', argumentHint: '[instructions]' },
  { name: 'clear', description: 'Start a fresh session in this folder', argumentHint: '' },
]

function rankCommands(all: SlashCommandInfo[], q: string): SlashCommandInfo[] {
  const query = q.toLowerCase()
  if (!query) return [...all].sort((a, b) => a.name.localeCompare(b.name))
  const score = (c: SlashCommandInfo): number => {
    const n = c.name.toLowerCase()
    if (n === query) return 0
    if (n.startsWith(query)) return 1
    if (c.aliases?.some((a) => a.toLowerCase().startsWith(query))) return 2
    if (n.includes(query)) return 3
    if (c.description.toLowerCase().includes(query)) return 4
    return -1
  }
  return all
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c)
}

function rankAgents(all: AgentChoice[], q: string): AgentChoice[] {
  const query = q.toLowerCase().replace(/^agent-/, '')
  if (!query) return [...all].sort((a, b) => a.name.localeCompare(b.name))
  const score = (a: AgentChoice): number => {
    const n = a.name.toLowerCase()
    if (n === query) return 0
    if (n.startsWith(query)) return 1
    if (n.includes(query)) return 2
    if (a.description.toLowerCase().includes(query)) return 3
    return -1
  }
  return all
    .map((a) => ({ a, s: score(a) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || x.a.name.localeCompare(y.a.name))
    .map((x) => x.a)
}

export default function Composer({ chatId }: { chatId: string }) {
  const chat = useStore((s) => s.chats[chatId])
  const metaEffort = useStore((s) => (chat?.sessionId ? s.meta[chat.sessionId]?.effort : undefined))
  const sendMessage = useStore((s) => s.sendMessage)
  const enqueue = useStore((s) => s.enqueue)
  const removeQueued = useStore((s) => s.removeQueued)
  const sendQueuedNow = useStore((s) => s.sendQueuedNow)
  const addAttachments = useStore((s) => s.addAttachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const interrupt = useStore((s) => s.interrupt)
  const setModel = useStore((s) => s.setModel)
  const setEffort = useStore((s) => s.setEffort)
  const setMode = useStore((s) => s.setMode)
  const setDraft = useStore((s) => s.setDraft)
  const clearChat = useStore((s) => s.clearChat)
  const setKeepWarm = useStore((s) => s.setKeepWarm)
  const keepWarm = useStore((s) => (chat?.sessionId ? s.keepWarm.includes(chat.sessionId) : false))
  const general = useStore((s) => isGeneral(s.chats[chatId]?.cwd))
  const ta = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [hi, setHi] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [caret, setCaret] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)

  useEffect(() => {
    // Don't steal focus from the sidebar (e.g. Delete closed the active chat and focus moved
    // to the next row); opening a chat from the sidebar focuses the composer explicitly.
    if (document.activeElement?.closest('.sidebar')) return
    ta.current?.focus()
  }, [chatId])

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [chat?.draft])

  const draft = chat?.draft ?? ''
  const slashQuery = /^\/\S*$/.test(draft) ? draft.slice(1) : null

  const allCommands = useMemo<SlashCommandInfo[]>(() => {
    if (!chat) return []
    const list: SlashCommandInfo[] = chat.commands.length
      ? [...chat.commands]
      : (chat.slashCommands ?? []).map((name) => ({ name, description: '', argumentHint: '' }))
    for (const b of BUILTIN_COMMANDS) if (!list.some((c) => c.name === b.name)) list.push(b)
    // The CLI can list a name twice (built-in and user-defined); keep the first.
    const seen = new Set<string>()
    return list.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
  }, [chat?.commands, chat?.slashCommands])

  const matches = useMemo(() => (slashQuery == null ? [] : rankCommands(allCommands, slashQuery)), [allCommands, slashQuery])
  const slashOpen = slashQuery != null && !dismissed && matches.length > 0

  // @agent mentions: the token ending at the caret, e.g. "fix this @exp".
  const mentionMatch = slashQuery == null && !general ? /(^|\s)@([\w.:-]*)$/.exec(draft.slice(0, caret)) : null
  const mentionQuery = mentionMatch ? mentionMatch[2] : null
  const agentMatches = useMemo(
    () => (mentionQuery == null ? [] : rankAgents(chat?.agents ?? [], mentionQuery)),
    [chat?.agents, mentionQuery],
  )
  const mentionOpen = mentionQuery != null && !mentionDismissed && agentMatches.length > 0
  const pickerOpen = slashOpen || mentionOpen
  const listLen = slashOpen ? matches.length : agentMatches.length

  // Prompt history (Up/Down like a terminal): sent prompts of this chat, newest last.
  const history = useMemo<string[]>(() => {
    const out: string[] = []
    for (const m of chat?.messages ?? []) {
      if (m.role !== 'user') continue
      const text = m.blocks
        .filter((b) => b.kind === 'text' && b.text !== '*[image attached]*')
        .map((b) => (b as { text: string }).text)
        .join('\n')
      if (text.trim() && out[out.length - 1] !== text) out.push(text)
    }
    return out
  }, [chat?.messages])
  // Index into `history` while recalling, -1 when not navigating.
  const histIdx = useRef(-1)
  useEffect(() => {
    histIdx.current = -1
  }, [chatId])

  const recall = (idx: number): void => {
    histIdx.current = idx
    setDraft(chatId, idx < 0 ? '' : history[idx])
    requestAnimationFrame(() => {
      const el = ta.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  useEffect(() => {
    setHi(0)
    if (slashQuery == null) setDismissed(false)
  }, [slashQuery])

  useEffect(() => {
    setHi(0)
    if (mentionQuery == null) setMentionDismissed(false)
  }, [mentionQuery])

  useEffect(() => {
    menuRef.current?.querySelector('.dd-item.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi, pickerOpen])

  if (!chat) return null
  const busy = chat.status === 'running' || chat.status === 'compacting'
  const hasContent = draft.trim().length > 0 || chat.attachments.length > 0
  const canSend = hasContent

  const submit = (): void => {
    const text = draft.trim()
    const images = chat.attachments
    if (!text && !images.length) return
    histIdx.current = -1
    if (text === '/clear') {
      setDraft(chatId, '')
      void clearChat(chatId)
      return
    }
    // While Claude works, messages wait in the queue and go out one per finished turn.
    if (busy) enqueue(chatId, text, images)
    else void sendMessage(chatId, text, images, true)
  }

  const pick = (c: SlashCommandInfo): void => {
    setDraft(chatId, `/${c.name} `)
    setDismissed(true)
    ta.current?.focus()
  }

  const pickAgent = (a: AgentChoice): void => {
    if (!mentionMatch) return
    const start = caret - mentionMatch[2].length - 1
    const insert = `@agent-${a.name} `
    setDraft(chatId, draft.slice(0, start) + insert + draft.slice(caret))
    const pos = start + insert.length
    setCaret(pos)
    setMentionDismissed(true)
    ta.current?.focus()
    requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos))
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const imgs = await readImages(files.filter((f) => f.type.startsWith('image/')))
    if (imgs.length) addAttachments(chatId, imgs)
  }

  const models = chat.models.length ? chat.models : FALLBACK_MODELS
  const currentModel = chat.requestedModel ?? 'default'
  const modelInfo = chat.models.find((m) => m.value.toLowerCase() === currentModel.toLowerCase())
  const effortLevels = modelInfo?.efforts?.length ? EFFORT_LEVELS.filter((e) => modelInfo.efforts!.includes(e.value)) : EFFORT_LEVELS
  // Until the CLI reports its models, assume effort is supported.
  const showEffort = !modelInfo || modelInfo.supportsEffort === true
  const currentEffort = chat.requestedEffort ?? 'default'
  const effortName = (v?: string): string | undefined => EFFORT_LEVELS.find((e) => e.value === v)?.label ?? v
  const currentMode = (chat.permissionMode as PermissionMode) ?? chat.requestedMode

  return (
    <div
      className="composer-wrap"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDropping(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      {chat.queue.length > 0 && (
        <div className="queue">
          {chat.queue.map((q) => (
            <div className="queued" key={q.id}>
              <Clock size={13} className="queued-icon" />
              <span className="queued-text" title={q.text}>
                {q.text || 'Image'}
              </span>
              {q.images.length > 0 && <span className="queued-meta">{q.images.length === 1 ? '1 image' : `${q.images.length} images`}</span>}
              <button className="queued-btn" title="Send now: Claude folds it into the running turn" onClick={() => void sendQueuedNow(chatId, q.id)}>
                <CornerDownLeft size={12} /> Send now
              </button>
              <button className="queued-x" title="Remove from queue" onClick={() => removeQueued(chatId, q.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={`composer ${dropping ? 'dropping' : ''}`}>
        {mentionOpen && (
          <div className="dd-menu dd-up slash-menu" role="listbox" ref={menuRef}>
            {agentMatches.map((a, i) => (
              <button
                type="button"
                key={a.name}
                role="option"
                aria-selected={i === hi}
                className={`dd-item ${i === hi ? 'hi' : ''}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickAgent(a)}
              >
                <span className="dd-item-text">
                  <span className="dd-item-label">
                    <span className="slash-name">@agent-{a.name}</span>
                    {a.model && a.model !== 'inherit' && <span className="slash-hint">{a.model}</span>}
                  </span>
                  {a.description && <span className="dd-item-desc">{a.description}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {slashOpen && (
          <div className="dd-menu dd-up slash-menu" role="listbox" ref={menuRef}>
            {matches.map((c, i) => (
              <button
                type="button"
                key={c.name}
                role="option"
                aria-selected={i === hi}
                className={`dd-item ${i === hi ? 'hi' : ''}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
              >
                <span className="dd-item-text">
                  <span className="dd-item-label">
                    <span className="slash-name">/{c.name}</span>
                    {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
                  </span>
                  {c.description && <span className="dd-item-desc">{c.description}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        {chat.attachments.length > 0 && (
          <div className="attachments">
            {chat.attachments.map((a) => (
              <div className="attachment" key={a.id}>
                <ImageThumb src={dataUrl(a.mediaType, a.data)} alt={a.name} />
                <button className="attachment-x" title="Remove image" onClick={() => removeAttachment(chatId, a.id)}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={draft}
          placeholder={busy ? 'Claude is working — Enter queues the message, Esc stops' : general ? 'Message Claude…' : 'Message Claude… (Enter to send, / for commands, @ for agents, paste or drop images)'}
          onChange={(e) => {
            setDraft(chatId, e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (!files.length) return
            e.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={(e) => {
            if (!pickerOpen && e.key === 'Escape' && busy) {
              e.preventDefault()
              void interrupt(chatId)
              return
            }
            if (pickerOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const dir = e.key === 'ArrowDown' ? 1 : -1
                setHi((h) => (h + dir + listLen) % listLen)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                if (slashOpen) setDismissed(true)
                else setMentionDismissed(true)
                return
              }
              if (mentionOpen && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
                const a = agentMatches[hi]
                if (a) {
                  e.preventDefault()
                  pickAgent(a)
                  return
                }
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                const c = matches[hi]
                // Enter on a fully typed command sends it; otherwise complete the name.
                if (e.key === 'Enter' && c && (slashQuery === c.name || (slashQuery != null && c.aliases?.includes(slashQuery)))) {
                  e.preventDefault()
                  submit()
                  return
                }
                if (c) {
                  e.preventDefault()
                  pick(c)
                  return
                }
              }
            }
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
              const cur = histIdx.current
              const navigating = cur >= 0 && cur < history.length && draft === history[cur]
              if (!navigating) histIdx.current = -1
              if (e.key === 'ArrowUp' && history.length && (navigating || draft === '')) {
                e.preventDefault()
                recall(navigating ? Math.max(cur - 1, 0) : history.length - 1)
                return
              }
              if (e.key === 'ArrowDown' && navigating) {
                e.preventDefault()
                recall(cur + 1 < history.length ? cur + 1 : -1)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
        />
        <div className="composer-bar">
          <Dropdown
            placement="up"
            title="Model"
            value={currentModel}
            labelOverride={currentModel === 'default' && chat.model ? modelLabel(chat.model) : undefined}
            options={[
              ...(models.some((m) => m.value === 'default') ? [] : [{ value: 'default', label: 'Default' }]),
              ...models.map((m) => ({ value: m.value, label: m.displayName, description: m.description })),
            ]}
            onChange={(v) => void setModel(chatId, v)}
          />
          {showEffort && (
            <Dropdown
              placement="up"
              title="Effort"
              value={currentEffort}
              labelOverride={
                currentEffort === 'default'
                  ? (chat.effort ?? metaEffort)
                    ? `${effortName(chat.effort ?? metaEffort)} effort`
                    : 'Default effort'
                  : `${effortName(currentEffort)} effort`
              }
              options={[
                { value: 'default', label: 'Default', description: "The model's default effort" },
                ...effortLevels.map((e) => ({ value: e.value, label: e.label })),
              ]}
              onChange={(v) => void setEffort(chatId, v)}
            />
          )}
          {!general && (
            <Dropdown
              placement="up"
              title="Permission mode"
              value={currentMode}
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.hint }))}
              onChange={(v) => void setMode(chatId, v as PermissionMode)}
            />
          )}
          <div className="grow" />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <button
            className={`icon-btn${keepWarm ? ' on warm' : ''}`}
            disabled={!chat?.sessionId}
            title={keepWarm ? 'Keeping the prompt cache warm (click to stop)' : 'Keep the prompt cache warm while idle'}
            onClick={() => chat?.sessionId && setKeepWarm(chat.sessionId, !keepWarm)}
          >
            <Flame size={16} />
          </button>
          <button className="icon-btn" title="Attach images (or paste / drop them)" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={16} />
          </button>
          {!general && (
            <button className="icon-btn" title="Clear the conversation (/clear)" onClick={() => void clearChat(chatId)}>
              <Eraser size={16} />
            </button>
          )}
          {busy && hasContent && (
            <button className="send queue-btn" title="Queue message (Enter)" onClick={submit}>
              <Clock size={15} />
            </button>
          )}
          {busy ? (
            <button className="send stop" title="Stop" onClick={() => void interrupt(chatId)}>
              <Square size={14} />
            </button>
          ) : (
            <button className="send" title="Send" disabled={!canSend} onClick={submit}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
