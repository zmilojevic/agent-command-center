import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { useStore, wireEvents, isGeneral } from './store'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ChatView from './components/ChatView'
import Composer from './components/Composer'
import Welcome from './components/Welcome'
import NewSessionDialog from './components/NewSessionDialog'
import ErrorBoundary from './components/ErrorBoundary'
import FindBar from './components/FindBar'
import ChangesPanel from './components/ChangesPanel'

/** Focus the composer textarea once it is mounted (retries a few frames after a chat opens). */
function focusComposer(tries = 10): void {
  const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (ta) ta.focus()
  else if (tries > 0) requestAnimationFrame(() => focusComposer(tries - 1))
}

export default function App() {
  const activeChatId = useStore((s) => s.activeChatId)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const showNewDialog = useStore((s) => s.showNewDialog)
  const loadSessions = useStore((s) => s.loadSessions)
  const restoreTabs = useStore((s) => s.restoreTabs)
  const setShowNewDialog = useStore((s) => s.setShowNewDialog)
  const newGeneralChat = useStore((s) => s.newGeneralChat)
  const generalActive = useStore((s) => !!s.activeChatId && isGeneral(s.chats[s.activeChatId]?.cwd))
  const freshGeneral = useStore((s) => {
    const c = s.activeChatId ? s.chats[s.activeChatId] : undefined
    return !!c && isGeneral(c.cwd) && c.transcriptLoaded && c.messages.length === 0
  })
  const closeTab = useStore((s) => s.closeTab)
  const findOpen = useStore((s) => s.findOpen)
  const setFindOpen = useStore((s) => s.setFindOpen)
  const changesOpen = useStore((s) => s.changesOpen)
  const toggleChanges = useStore((s) => s.toggleChanges)

  useEffect(() => {
    wireEvents()
    void window.desktop
      .chatsDir()
      .then((dir) => useStore.setState({ generalDir: dir }))
      .then(loadSessions)
      .then(restoreTabs)
  }, [loadSessions, restoreTabs])

  useEffect(
    () =>
      window.desktop.onTrayNewChat(() => {
        void newGeneralChat().then(() => requestAnimationFrame(() => focusComposer()))
      }),
    [newGeneralChat],
  )

  useEffect(() => {
    // Shared guard for chat-level global hotkeys (Ctrl/Alt+W, Alt+Delete): returns the active chat when the
    // key may fire (no overlay open; inside a text field only for the empty composer), else undefined.
    const chatHotkeyTarget = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const chat = st.activeChatId ? st.chats[st.activeChatId] : undefined
      if (!chat) return undefined
      if (document.querySelector('.modal-backdrop, .dd-menu, .context-menu')) return undefined
      const t = e.target instanceof HTMLElement ? e.target : null
      const inText = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (inText && !(t.matches('.composer textarea') && !chat.draft.trim() && chat.attachments.length === 0)) return undefined
      return chat
    }
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newGeneralChat()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        window.desktop.window('quit')
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        window.desktop.window('devtools')
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        const st = useStore.getState()
        if (st.activeChatId && !isGeneral(st.chats[st.activeChatId]?.cwd)) toggleChanges()
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        window.desktop.window('reload')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (!useStore.getState().activeChatId) return
        if (useStore.getState().findOpen) window.dispatchEvent(new Event('ccd-find-focus'))
        else setFindOpen(true)
      } else if (!e.shiftKey && e.code === 'KeyW' && (mod ? !e.altKey : e.altKey) && !e.defaultPrevented) {
        e.preventDefault()
        const chat = chatHotkeyTarget(e)
        if (!chat) return
        const st = useStore.getState()
        const summary = st.sessions.find((x) => x.sessionId === chat.sessionId)
        if (summary) void st.deleteSession(summary)
        else closeTab(chat.chatId)
        requestAnimationFrame(() => {
          if (useStore.getState().activeChatId) focusComposer()
        })
      } else if (e.altKey && !mod && !e.shiftKey && e.key === 'Delete' && !e.defaultPrevented) {
        const chat = chatHotkeyTarget(e)
        if (!chat) return
        e.preventDefault()
        void useStore.getState().clearChat(chat.chatId)
        requestAnimationFrame(() => {
          if (useStore.getState().activeChatId) focusComposer()
        })
      } else if (e.key === 'Escape' && useStore.getState().showNewDialog) {
        setShowNewDialog(false)
      } else if (e.key === 'Escape' && useStore.getState().findOpen) {
        setFindOpen(false)
      }
    }
    // Linux/Chromium pastes the primary selection on middle-button mouseup into the focused editable
    // (e.g. the composer after middle-clicking a sidebar row). A default-prevented mouseup skips that
    // paste; auxclick still fires. Text fields themselves keep the native behaviour.
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 1) return
      const t = e.target as Element | null
      if (t?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouseUp, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouseUp, true)
    }
  }, [newGeneralChat, setShowNewDialog, closeTab, setFindOpen, toggleChanges])

  return (
    <div className="app" style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}>
      <ErrorBoundary name="Sidebar">
        <Sidebar />
      </ErrorBoundary>
      <main className="main">
        <TopBar />
        <div className="main-row">
          <div className={`chat-pane ${freshGeneral ? 'fresh' : ''}`}>
            <ErrorBoundary name="Chat" key={activeChatId ?? 'welcome'}>
              {activeChatId ? (
                <>
                  <div className="chat-area">
                    {findOpen && <FindBar chatId={activeChatId} />}
                    <ChatView chatId={activeChatId} />
                  </div>
                  <Composer chatId={activeChatId} />
                </>
              ) : (
                <Welcome />
              )}
            </ErrorBoundary>
          </div>
          {changesOpen && activeChatId && !generalActive && (
            <ErrorBoundary name="Changes" key={`changes-${activeChatId}`}>
              <ChangesPanel chatId={activeChatId} />
            </ErrorBoundary>
          )}
        </div>
      </main>
      {showNewDialog && <NewSessionDialog />}
    </div>
  )
}
