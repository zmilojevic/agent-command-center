import { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, rmdir } from 'node:fs/promises'
import { watch } from 'chokidar'
import { listSessions, getSessionMessages, renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk'
import { RunnerRegistry, listAllModels } from './agent'
import { readSessionMeta } from './sessionMeta'
import { UsageService } from './usage'
import { gitChanges, createWorktree, removeWorktree, gitSetStaged, gitDiscardFile, gitDiscardHunk } from './git'
import { launchTools, openInEditor, openTerminal } from './launch'
import { RemoteManager } from './remote'
import { PtyManager } from './pty'
import { CHATS_DIR } from './paths'
import { setupTray, focusWindow } from './tray'
import { resourceFile } from './resources'
import { loadLoginShellEnv } from './shellEnv'
import type { StartChatOptions, PermissionResponse, PermissionMode, UserContent, NotifyRequest, Theme, RemoteEnableInfo } from '../shared/types'

// Keep the profile in <appData>/agent-command-center: the packaged productName ("Agent Command Center") must not
// move it (on Linux this is the same path as before). An explicit --user-data-dir (test copies) wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'agent-command-center'))

// Wayland-native when available (Hyprland), X11 fallback otherwise.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')
}
app.commandLine.appendSwitch('disable-renderer-backgrounding')

let win: BrowserWindow | null = null
let tray: Electron.Tray | null = null
// Set once the app is really quitting; until then closing the window only hides it to the tray.
let quitting = false
const quitApp = (): void => {
  quitting = true
  app.quit()
}
const windowBg = (): string => (nativeTheme.shouldUseDarkColors ? '#1b1a17' : '#faf9f5')

let usageService: UsageService | null = null
const emit = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  if (channel === 'agent:event' && (payload as { message?: { type?: string } })?.message?.type === 'result') usageService?.noteResult()
}
const log = (s: string): void => {
  process.stderr.write(`[claude] ${s}${s.endsWith('\n') ? '' : '\n'}`)
}
// General chats run in this folder; it must exist before any runner starts.
mkdirSync(CHATS_DIR, { recursive: true })
const runners = new RunnerRegistry(emit, log)
const remote = new RemoteManager(runners, emit, log)
const ptys = new PtyManager(emit)
usageService = new UsageService(runners, log, (u) => emit('usage:changed', u))

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 820,
    minHeight: 520,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } } : { frame: false }),
    show: false,
    backgroundColor: windowBg(),
    title: process.env.CCD_WINDOW_TITLE || 'Agent Command Center',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.on('close', (e) => {
    if (quitting || !tray) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => {
    win = null
  })
  if (process.env.CCD_WINDOW_TITLE) win.on('page-title-updated', (e) => e.preventDefault())
  win.once('ready-to-show', () => (process.env.CCD_WINDOW_TITLE ? win?.showInactive() : win?.show()))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// ---- IPC: sessions -------------------------------------------------------

ipcMain.handle('sessions:list', async () => {
  const all = await listSessions({ limit: 2000 })
  return all.filter((s) => s.cwd)
})

ipcMain.handle('sessions:messages', async (_e, sessionId: string, cwd?: string) => {
  return getSessionMessages(sessionId, { dir: cwd })
})

ipcMain.handle('sessions:meta', async (_e, items: { sessionId: string; cwd: string }[]) => {
  const out = await Promise.all(items.map((i) => readSessionMeta(i.sessionId, i.cwd).catch(() => null)))
  return out.filter(Boolean)
})

ipcMain.handle('sessions:rename', async (_e, sessionId: string, title: string, cwd?: string) => {
  await renameSession(sessionId, title, { dir: cwd })
})

ipcMain.handle('sessions:delete', async (_e, sessionId: string, cwd?: string) => {
  await deleteSession(sessionId, { dir: cwd })
})

// Removes a project's transcripts. Claude's own per-project data (e.g. `memory/`) is left
// alone, so the folder is only removed when nothing else is in it.
ipcMain.handle('sessions:deleteProject', async (_e, cwd: string, sessionIds: string[]) => {
  for (const id of sessionIds) {
    try {
      await deleteSession(id, { dir: cwd })
    } catch (err) {
      log(`deleteProject: ${id}: ${String(err)}`)
    }
  }
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  if (!slug) return
  const dir = join(homedir(), '.claude', 'projects', slug)
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    /* already gone */
  }
})

// ---- IPC: chat -----------------------------------------------------------

ipcMain.handle('chat:start', (_e, opts: StartChatOptions) => runners.start(opts))
ipcMain.handle('chat:send', (_e, chatId: string, content: UserContent, uuid: string) => {
  runners.get(chatId)?.send(content, uuid)
})
ipcMain.handle('chat:respond', (_e, chatId: string, requestId: string, response: PermissionResponse) => {
  runners.get(chatId)?.respond(requestId, response)
})
ipcMain.handle('chat:interrupt', (_e, chatId: string) => runners.get(chatId)?.interrupt())
ipcMain.handle('chat:setModel', (_e, chatId: string, model?: string) => runners.get(chatId)?.setModel(model))
ipcMain.handle('chat:setEffort', (_e, chatId: string, effort?: string) => runners.get(chatId)?.setEffort(effort))
ipcMain.handle('chat:setPermissionMode', (_e, chatId: string, mode: PermissionMode) =>
  runners.get(chatId)?.setPermissionMode(mode),
)
ipcMain.handle('chat:close', (_e, chatId: string) => runners.close(chatId))
ipcMain.handle('chat:models', (_e, chatId: string) => runners.get(chatId)?.listModels() ?? [])
ipcMain.handle('app:models', () => listAllModels(runners, log))
ipcMain.handle('chat:commands', (_e, chatId: string) => runners.get(chatId)?.listCommands() ?? [])
ipcMain.handle('chat:agents', (_e, chatId: string) => runners.get(chatId)?.listAgents() ?? [])
ipcMain.handle('chat:files', (_e, chatId: string, query: string) => runners.get(chatId)?.fileSuggestions(query) ?? [])
ipcMain.handle('chat:warm', (_e, chatId: string) => runners.get(chatId)?.warmCache() ?? false)
ipcMain.handle('chat:taskOutput', (_e, chatId: string, taskId: string) => runners.get(chatId)?.taskOutput(taskId) ?? null)
ipcMain.handle('chat:stopTask', (_e, chatId: string, taskId: string) => runners.get(chatId)?.stopTask(taskId))
ipcMain.handle('chat:backgroundTasks', (_e, chatId: string, toolUseId?: string) => runners.get(chatId)?.backgroundTasks(toolUseId) ?? false)
ipcMain.handle('chat:context', (_e, chatId: string) => runners.get(chatId)?.emitContext())

// ---- IPC: mcp / worktrees
ipcMain.handle('chat:mcpStatus', async (_e, chatId: string) => {
  try {
    return (await runners.get(chatId)?.mcpStatus()) ?? []
  } catch (err) {
    log(`mcpStatus: ${String(err)}`)
    return []
  }
})
ipcMain.handle('chat:mcpToggle', (_e, chatId: string, name: string, enabled: boolean) =>
  runners.get(chatId)?.toggleMcp(name, enabled).catch((err) => log(`mcpToggle: ${String(err)}`)),
)
ipcMain.handle('chat:mcpReconnect', (_e, chatId: string, name: string) =>
  runners.get(chatId)?.reconnectMcp(name).catch((err) => log(`mcpReconnect: ${String(err)}`)),
)
ipcMain.handle('git:worktreeAdd', (_e, cwd: string, name: string) => createWorktree(cwd, name))
ipcMain.handle('git:worktreeRemove', (_e, path: string, force: boolean) => removeWorktree(path, force))
// ---- IPC: remote control

ipcMain.handle('remote:enable', (_e, chatId: string, info: RemoteEnableInfo) => remote.enable(chatId, info))
ipcMain.handle('remote:disable', (_e, chatId: string) => remote.disable(chatId))

ipcMain.handle('usage:get', (_e, force?: boolean) => usageService!.get(!!force))

// ---- IPC: desktop notifications -------------------------------------------

// Notifications are kept referenced until dismissed; a collected one loses its click handler.
const liveNotifications = new Set<Notification>()
// Claude's logo from the system icon theme (claude-desktop package) if installed, else our own icon.
const NOTIFY_ICON_CANDIDATES = [
  ...(process.platform === 'linux' ? ['/usr/share/icons/hicolor/256x256/apps/claude-desktop.png'] : []),
  resourceFile('icon.png')
]
let notifyIcon: Electron.NativeImage | undefined | null = null
function notificationIcon(): Electron.NativeImage | undefined {
  if (notifyIcon !== null) return notifyIcon
  notifyIcon = undefined
  for (const path of NOTIFY_ICON_CANDIDATES) {
    if (!existsSync(path)) continue
    const img = nativeImage.createFromPath(path)
    if (!img.isEmpty()) {
      notifyIcon = img
      break
    }
  }
  return notifyIcon
}
ipcMain.handle('app:notify', (_e, n: NotifyRequest) => {
  if (!Notification.isSupported()) return
  // The renderer's document.hasFocus() stays true on Wayland when the window is on
  // another workspace, so the window manager's view decides.
  if (n.onlyIfUnfocused && win && !win.isDestroyed() && win.isFocused()) return
  const notif = new Notification({ title: n.title, body: n.body, silent: false, icon: notificationIcon() })
  const drop = (): void => {
    liveNotifications.delete(notif)
  }
  notif.on('click', () => {
    drop()
    if (win && !win.isDestroyed()) void focusWindow(win)
    emit('notification:click', { chatId: n.chatId })
  })
  notif.on('close', drop)
  liveNotifications.add(notif)
  notif.show()
})

// ---- IPC: misc -----------------------------------------------------------

ipcMain.handle('dialog:pickFolder', async (_e, defaultPath?: string) => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : homedir(),
  })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('git:changes', (_e, cwd: string) => gitChanges(cwd))
// ---- IPC: git actions / open in editor
ipcMain.handle('git:setStaged', (_e, cwd: string, file: Parameters<typeof gitSetStaged>[1], staged: boolean) => gitSetStaged(cwd, file, staged))
ipcMain.handle('git:discardFile', (_e, cwd: string, file: Parameters<typeof gitDiscardFile>[1]) => gitDiscardFile(cwd, file))
ipcMain.handle('git:discardHunk', (_e, cwd: string, patch: string) => gitDiscardHunk(cwd, patch))
ipcMain.handle('app:tools', () => launchTools())
ipcMain.handle('app:openInEditor', (_e, path: string, line?: number, editorId?: string) => openInEditor(path, line, editorId))
ipcMain.handle('app:openTerminal', (_e, dir: string, terminalId?: string) => openTerminal(dir, terminalId))
// ---- IPC: integrated terminal
ipcMain.handle('pty:create', (_e, cwd: string, cols: number, rows: number) => ptys.create(cwd, cols, rows))
ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))
ipcMain.handle('pty:list', () => ptys.list())
ipcMain.handle('pty:replay', (_e, id: string) => ptys.replay(id))
ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
ipcMain.handle('app:home', () => homedir())
ipcMain.handle('app:chatsDir', () => CHATS_DIR)
ipcMain.on('app:theme', (_e, theme: Theme) => {
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(windowBg())
})
ipcMain.on('window:action', (_e, action: 'minimize' | 'maximize' | 'close' | 'reload' | 'devtools' | 'quit') => {
  if (action === 'quit') return quitApp()
  if (!win) return
  if (action === 'reload') return win.webContents.reload()
  if (action === 'devtools') return win.webContents.toggleDevTools()
  if (action === 'minimize') win.minimize()
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  else win.close()
})

// ---- Session file watcher ------------------------------------------------

function watchSessions(): void {
  const dir = join(homedir(), '.claude', 'projects')
  if (!existsSync(dir)) return
  let timer: NodeJS.Timeout | null = null
  const ping = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => emit('sessions:changed', null), 800)
  }
  watch(dir, { depth: 1, ignoreInitial: true, ignored: (p) => /[\\/]subagents/.test(p) })
    .on('add', ping)
    .on('change', ping)
    .on('unlink', ping)
    .on('addDir', ping)
    .on('unlinkDir', ping)
}

// One instance per user-data-dir (test copies use their own). Dev runs skip the lock.
if (!process.env.ELECTRON_RENDERER_URL && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) void focusWindow(win)
    else if (app.isReady()) {
      createWindow()
      if (win) void focusWindow(win)
    }
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.zmilojevic.agent-command-center')
    if (process.platform === 'darwin') {
      await loadLoginShellEnv(log)
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Agent Command Center',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Quit Agent Command Center', accelerator: 'Cmd+Q', click: quitApp },
            ],
          },
          { role: 'editMenu' },
          { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
        ]),
      )
    }
    // Notification daemons look up the app icon and name through the desktop entry.
    if (process.platform === 'linux') app.setDesktopName('agent-command-center.desktop')

    createWindow()
    tray = setupTray({
      getWindow: () => win,
      createWindow,
      quit: quitApp,
      log,
      emit,
    })
    watchSessions()
    usageService?.start()
    app.on('activate', () => {
      if (process.platform === 'darwin' && win && !win.isDestroyed()) void focusWindow(win)
      else if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // With a tray the app lives on; without one the old behaviour applies.
  if (tray && !quitting) return
  runners.closeAll()
  ptys.killAll()
  app.quit()
})
app.on('before-quit', () => {
  quitting = true
  runners.closeAll()
  ptys.killAll()
})
app.on('will-quit', () => ptys.killAll())
