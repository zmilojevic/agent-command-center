import { FileDiff, SquareTerminal } from 'lucide-react'
import { modLabel } from '../util'
import { useStore } from '../store'

export default function ToolStrip() {
  const changesOpen = useStore((s) => s.changesOpen)
  const toggleChanges = useStore((s) => s.toggleChanges)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const toggleTerminal = useStore((s) => s.toggleTerminal)
  return (
    <nav className="tool-strip">
      <button
        className={`tool-btn ${changesOpen ? 'on' : ''}`}
        title={`Changes (${modLabel('Ctrl+Shift+G')})`}
        onClick={toggleChanges}
      >
        <FileDiff size={18} />
      </button>
      <button className={`tool-btn ${terminalOpen ? 'on' : ''}`} title="Terminal (Ctrl+`)" onClick={toggleTerminal}>
        <SquareTerminal size={18} />
      </button>
    </nav>
  )
}
