import { useState } from 'react'
import { Play } from 'lucide-react'
import { useStore } from '../../store'

/** Starts a new chat in the project root that asks Claude to run the saved workflow (that message is the opt-in the Workflow tool needs). */
export default function RunWorkflowDialog({ root, name, argsHint, onClose }: { root: string; name: string; argsHint?: string; onClose: () => void }) {
  const [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const a = args.trim()
    const text = a ? `Run the saved workflow \`${name}\` with args: ${a}` : `Run the saved workflow \`${name}\` with no args.`
    await useStore.getState().newChat({ cwd: root, permissionMode: useStore.getState().lastMode })
    const chatId = useStore.getState().activeChatId
    if (chatId) await useStore.getState().sendMessage(chatId, text)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal rename-modal"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="modal-head">
          <h3>Run {name}</h3>
        </div>
        <p className="modal-text">Starts a new chat in this project that runs the saved workflow.</p>
        <div className="field">
          <span>Args</span>
          <textarea
            className="wf-textarea"
            autoFocus
            rows={5}
            value={args}
            placeholder={argsHint || 'No args'}
            onChange={(e) => setArgs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void run()
              }
            }}
          />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            <Play size={13} /> Run in a new chat
          </button>
        </div>
      </div>
    </div>
  )
}
