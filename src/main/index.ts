import { app, BrowserWindow, Menu, dialog, shell, nativeTheme, nativeImage, Notification } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, rmdir } from 'node:fs/promises'
import { watch } from 'chokidar'
import { listSessions, getSessionMessages, renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk'
import { RunnerRegistry, listAllModels } from './agent'
import { handle, on } from './ipc'
import { registerSharedPrefs } from './sharedPrefs'
import { readSessionMeta } from './sessionMeta'
import { UsageService } from './usage'
import { gitChanges, createWorktree, removeWorktree, gitSetStaged, gitDiscardFile, gitDiscardHunk } from './git'
import { launchTools, openInEditor, openTerminal } from './launch'
import { RemoteManager } from './remote'
import { MobileServer } from './mobile'
import { PtyManager } from './pty'
import { CHATS_DIR } from './paths'
import { setupTray, focusWindow } from './tray'
import { workflowList, workflowRead, workflowSave, workflowDelete, workflowAgents } from './workflows'
import { resourceFile } from './resources'
import { loadLoginShellEnv } from './shellEnv'
import type { WorkflowSaveRequest } from '../shared/workflow'
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
let mobileServer: MobileServer | null = null
const emit = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  mobileServer?.broadcast(channel, payload)
}
const log = (s: string): void => {
  process.stderr.write(`[claude] ${s}${s.endsWith('\n') ? '' : '\n'}`)
}
// General chats run in this folder; it must exist before any runner starts.
mkdirSync(CHATS_DIR, { recursive: true })
const runners = new RunnerRegistry(emit, log)
const remote = new RemoteManager(runners, emit, log)
const ptys = new PtyManager(emit)
mobileServer = new MobileServer(emit, log)
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

handle('sessions:list', async () => {
  const all = await listSessions({ limit: 2000 })
  return all.filter((s) => s.cwd)
})

handle('sessions:messages', async (_ctx, sessionId: string, cwd?: string) => {
  return getSessionMessages(sessionId, { dir: cwd })
})

handle('sessions:meta', async (_ctx, items: { sessionId: string; cwd: string }[]) => {
  const out = await Promise.all(items.map((i) => readSessionMeta(i.sessionId, i.cwd).catch(() => null)))
  return out.filter(Boolean)
})

handle('sessions:rename', async (_ctx, sessionId: string, title: string, cwd?: string) => {
  await renameSession(sessionId, title, { dir: cwd })
})

handle('sessions:delete', async (_ctx, sessionId: string, cwd?: string) => {
  await deleteSession(sessionId, { dir: cwd })
})

// Removes a project's transcripts. Claude's own per-project data (e.g. `memory/`) is left
// alone, so the folder is only removed when nothing else is in it.
handle('sessions:deleteProject', async (_ctx, cwd: string, sessionIds: string[]) => {
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

handle('chat:start', (ctx, opts: StartChatOptions) => runners.start(opts, ctx.client))
handle('chat:attach', (ctx, chatId: string) => runners.attach(chatId, ctx.client))
handle('chat:live', () => runners.list())
handle('chat:send', (ctx, chatId: string, content: UserContent, uuid: string) => {
  const runner = runners.get(chatId)
  if (!runner) return
  runner.send(content, uuid)
  const blocks = typeof content === 'string' ? [] : content
  const text = typeof content === 'string' ? content : blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
  const images = blocks.flatMap((b) => (b.type === 'image' ? [{ mediaType: b.source.media_type, data: b.source.data }] : []))
  emit('chat:remoteMessage', { chatId, uuid, text, ...(images.length ? { images } : {}), origin: ctx.client })
})
handle('chat:respond', (_ctx, chatId: string, requestId: string, response: PermissionResponse) => {
  runners.get(chatId)?.respond(requestId, response)
})
handle('chat:interrupt', (_ctx, chatId: string) => runners.get(chatId)?.interrupt())
handle('chat:setModel', (_ctx, chatId: string, model?: string) => {
  emit('remote:setting', { chatId, model: model ?? 'default' })
  return runners.get(chatId)?.setModel(model)
})
handle('chat:setEffort', (_ctx, chatId: string, effort?: string) => runners.get(chatId)?.setEffort(effort))
handle('chat:setPermissionMode', (_ctx, chatId: string, mode: PermissionMode) => {
  emit('remote:setting', { chatId, permissionMode: mode })
  return runners.get(chatId)?.setPermissionMode(mode)
})
handle('chat:close', (ctx, chatId: string) => runners.release(chatId, ctx.client))
handle('chat:models', (_ctx, chatId: string) => runners.get(chatId)?.listModels() ?? [])
handle('app:models', () => listAllModels(runners, log))
handle('workflow:list', (_ctx, root: string) => workflowList(root))
handle('workflow:read', (_ctx, path: string) => workflowRead(path))
handle('workflow:save', (_ctx, req: WorkflowSaveRequest) => workflowSave(req))
handle('workflow:delete', (_ctx, path: string) => workflowDelete(path))
handle('workflow:agents', (_ctx, root: string) => workflowAgents(root, log))
handle('chat:commands', (_ctx, chatId: string) => runners.get(chatId)?.listCommands() ?? [])
handle('chat:agents', (_ctx, chatId: string) => runners.get(chatId)?.listAgents() ?? [])
handle('chat:files', (_ctx, chatId: string, query: string) => runners.get(chatId)?.fileSuggestions(query) ?? [])
handle('chat:warm', (_ctx, chatId: string) => runners.get(chatId)?.warmCache() ?? false)
handle('chat:taskOutput', (_ctx, chatId: string, taskId: string) => runners.get(chatId)?.taskOutput(taskId) ?? null)
handle('chat:stopTask', (_ctx, chatId: string, taskId: string) => runners.get(chatId)?.stopTask(taskId))
handle('chat:backgroundTasks', (_ctx, chatId: string, toolUseId?: string) => runners.get(chatId)?.backgroundTasks(toolUseId) ?? false)
handle('chat:context', (_ctx, chatId: string) => runners.get(chatId)?.emitContext())

// ---- IPC: mcp / worktrees
handle('chat:mcpStatus', async (_ctx, chatId: string) => {
  try {
    return (await runners.get(chatId)?.mcpStatus()) ?? []
  } catch (err) {
    log(`mcpStatus: ${String(err)}`)
    return []
  }
})
handle('chat:mcpToggle', (_ctx, chatId: string, name: string, enabled: boolean) =>
  runners.get(chatId)?.toggleMcp(name, enabled).catch((err) => log(`mcpToggle: ${String(err)}`)),
)
handle('chat:mcpReconnect', (_ctx, chatId: string, name: string) =>
  runners.get(chatId)?.reconnectMcp(name).catch((err) => log(`mcpReconnect: ${String(err)}`)),
)
handle('git:worktreeAdd', (_ctx, cwd: string, name: string) => createWorktree(cwd, name))
handle('git:worktreeRemove', (_ctx, path: string, force: boolean) => removeWorktree(path, force))
// ---- IPC: remote control

handle('remote:enable', (_ctx, chatId: string, info: RemoteEnableInfo) => remote.enable(chatId, info))
handle('remote:disable', (_ctx, chatId: string) => remote.disable(chatId))

// ---- IPC: phone access (desktop only; the socket refuses the mobile: prefix)
registerSharedPrefs(emit)
handle('mobile:status', () => mobileServer!.status())
handle('mobile:setEnabled', (_ctx, on: boolean) => mobileServer!.setEnabled(!!on))
handle('mobile:pairStart', () => mobileServer!.pairStart())
handle('mobile:revoke', (_ctx, id: string) => mobileServer!.revoke(id))

handle('usage:get', (_ctx, force?: boolean) => usageService!.get(!!force))

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
handle('app:notify', (_ctx, n: NotifyRequest) => {
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

handle('dialog:pickFolder', async (_ctx, defaultPath?: string) => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath && existsSync(defaultPath) ? defaultPath : homedir(),
  })
  return r.canceled ? null : r.filePaths[0]
})
handle('git:changes', (_ctx, cwd: string) => gitChanges(cwd))
// ---- IPC: git actions / open in editor
handle('git:setStaged', (_ctx, cwd: string, file: Parameters<typeof gitSetStaged>[1], staged: boolean) => gitSetStaged(cwd, file, staged))
handle('git:discardFile', (_ctx, cwd: string, file: Parameters<typeof gitDiscardFile>[1]) => gitDiscardFile(cwd, file))
handle('git:discardHunk', (_ctx, cwd: string, patch: string) => gitDiscardHunk(cwd, patch))
handle('app:tools', () => launchTools())
handle('app:openInEditor', (_ctx, path: string, line?: number, editorId?: string) => openInEditor(path, line, editorId))
handle('app:openTerminal', (_ctx, dir: string, terminalId?: string) => openTerminal(dir, terminalId))
// ---- IPC: integrated terminal
handle('pty:create', (_ctx, cwd: string, cols: number, rows: number) => ptys.create(cwd, cols, rows))
on('pty:write', (_ctx, id: string, data: string) => ptys.write(id, data))
on('pty:resize', (_ctx, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
handle('pty:kill', (_ctx, id: string) => ptys.kill(id))
handle('pty:list', () => ptys.list())
handle('pty:replay', (_ctx, id: string) => ptys.replay(id))
handle('pty:idle', (_ctx, id: string) => ptys.isIdle(id))
handle('shell:openPath', (_ctx, p: string) => shell.openPath(p))
handle('app:home', () => homedir())
handle('app:chatsDir', () => CHATS_DIR)
on('app:theme', (_ctx, theme: Theme) => {
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(windowBg())
})
on('window:action', (_ctx, action: 'minimize' | 'maximize' | 'close' | 'reload' | 'devtools' | 'quit') => {
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
    void mobileServer?.start()
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
  mobileServer?.stop()
  runners.closeAll()
  ptys.killAll()
})
app.on('will-quit', () => ptys.killAll())
