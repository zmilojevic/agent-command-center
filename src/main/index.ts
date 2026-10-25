import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, rmdir } from 'node:fs/promises'
import { watch } from 'chokidar'
import { listSessions, getSessionMessages, renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk'
import { RunnerRegistry } from './agent'
import { readSessionMeta } from './sessionMeta'
import { UsageService } from './usage'
import { gitChanges } from './git'
import { CHATS_DIR } from './paths'
import type { StartChatOptions, PermissionResponse, PermissionMode, UserContent, NotifyRequest, Theme } from '../shared/types'

// Wayland-native when available (Hyprland), X11 fallback otherwise.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

let win: BrowserWindow | null = null
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
usageService = new UsageService(runners, log, (u) => emit('usage:changed', u))

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 820,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: windowBg(),
    title: 'Agent Command Center',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
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
ipcMain.handle('chat:commands', (_e, chatId: string) => runners.get(chatId)?.listCommands() ?? [])
ipcMain.handle('chat:agents', (_e, chatId: string) => runners.get(chatId)?.listAgents() ?? [])
ipcMain.handle('chat:warm', (_e, chatId: string) => runners.get(chatId)?.warmCache() ?? false)
ipcMain.handle('chat:context', (_e, chatId: string) => runners.get(chatId)?.emitContext())

ipcMain.handle('usage:get', (_e, force?: boolean) => usageService!.get(!!force))

// ---- IPC: desktop notifications -------------------------------------------

// Notifications are kept referenced until dismissed; a collected one loses its click handler.
const liveNotifications = new Set<Notification>()
// Claude's logo from the system icon theme (claude-desktop package) if installed, else our own icon.
const NOTIFY_ICON_CANDIDATES = [
  '/usr/share/icons/hicolor/256x256/apps/claude-desktop.png',
  join(app.getAppPath(), 'resources', 'icon.png')
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
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
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
ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
ipcMain.handle('app:home', () => homedir())
ipcMain.handle('app:chatsDir', () => CHATS_DIR)
ipcMain.on('app:theme', (_e, theme: Theme) => {
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(windowBg())
})
ipcMain.on('window:action', (_e, action: 'minimize' | 'maximize' | 'close' | 'reload' | 'devtools') => {
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
  watch(dir, { depth: 1, ignoreInitial: true, ignored: (p) => p.includes('/subagents') })
    .on('add', ping)
    .on('change', ping)
    .on('unlink', ping)
    .on('addDir', ping)
    .on('unlinkDir', ping)
}

app.whenReady().then(() => {
  // Notification daemons look up the app icon and name through the desktop entry.
  if (process.platform === 'linux') app.setDesktopName('agent-command-center.desktop')

  createWindow()
  watchSessions()
  usageService?.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  runners.closeAll()
  app.quit()
})
app.on('before-quit', () => runners.closeAll())
