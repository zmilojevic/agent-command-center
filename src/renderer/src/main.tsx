import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { initTheme } from './theme'
import './styles.css'
import './styles/mentions-plan.css'
import './styles/tasks.css'
import './styles/mcp-worktree.css'
import './styles/changes-open.css'
import './styles/remote.css'
import './styles/terminal.css'
import './styles/toolstrip.css'
import './styles/platform.css'

document.documentElement.dataset.platform = window.desktop.platform

// Apply the saved theme before the first paint so the window never flashes the wrong palette.
initTheme()

// Exposed for the UI test driver (scripts/ui-driver.mjs) and DevTools debugging.
;(window as unknown as { __ccd: typeof useStore }).__ccd = useStore

// Dropping a file outside the composer would navigate the window to it.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
