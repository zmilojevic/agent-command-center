import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface TrayDeps {
  getWindow: () => BrowserWindow | null
  createWindow: () => void
  quit: () => void
  log: (s: string) => void
  emit: (channel: string, payload: unknown) => void
}

const onHyprland = (): boolean => !!process.env.HYPRLAND_INSTANCE_SIGNATURE
const dryRun = (): boolean => process.env.CCD_TRAY_DRY_RUN === '1'

function hyprctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('hyprctl', args, { timeout: 1500 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

/** Raises our window on Hyprland (switching to its workspace), else the plain Electron way. */
export async function focusWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (onHyprland()) {
    const lua = `hl.dsp.focus({ window = (function() for _,w in ipairs(hl.get_windows()) do if w.pid == ${process.pid} then return w end end end)() })`
    try {
      if ((await hyprctl(['dispatch', lua])).trim() === 'ok') return
    } catch {
      /* try the classic form */
    }
    try {
      if ((await hyprctl(['dispatch', 'focuswindow', `pid:${process.pid}`])).trim() === 'ok') return
    } catch {
      /* fall through */
    }
  }
  win.show()
  win.focus()
}

/** Workspace ids of our window and the active workspace, or null when hyprctl cannot tell. */
async function hyprWorkspaces(): Promise<{ ours: number; active: number } | null> {
  if (!onHyprland()) return null
  try {
    const clients = JSON.parse(await hyprctl(['clients', '-j'])) as { pid: number; mapped?: boolean; workspace?: { id: number } }[]
    const mine = clients.find((c) => c.pid === process.pid && c.mapped !== false)
    const active = JSON.parse(await hyprctl(['activeworkspace', '-j'])) as { id: number }
    if (!mine?.workspace || typeof active?.id !== 'number') return null
    return { ours: mine.workspace.id, active: active.id }
  } catch {
    return null
  }
}

export function setupTray(deps: TrayDeps): Tray | null {
  const { getWindow, createWindow, quit, log, emit } = deps
  let tray: Tray
  try {
    const path = join(app.getAppPath(), 'resources', 'icon.png')
    let img = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
    if (!img.isEmpty()) img = img.resize({ width: 32, height: 32 })
    tray = new Tray(img)
  } catch (err) {
    log(`tray: unavailable: ${String(err)}`)
    return null
  }
  tray.setToolTip('Agent Command Center')

  const show = async (): Promise<BrowserWindow | null> => {
    let win = getWindow()
    if (!win || win.isDestroyed()) {
      createWindow()
      win = getWindow()
    }
    if (win) await focusWindow(win)
    return win
  }

  const toggle = async (): Promise<void> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) {
      log('tray: action=show (no window)')
      if (!dryRun()) await show()
      return
    }
    let action: 'show' | 'hide' | 'focus'
    let info = ''
    if (!win.isVisible() || win.isMinimized()) {
      action = 'show'
    } else {
      const ws = await hyprWorkspaces()
      if (ws) {
        action = ws.ours === ws.active ? 'hide' : 'focus'
        info = ` ws=${ws.ours} active=${ws.active}`
      } else {
        action = win.isFocused() ? 'hide' : 'focus'
      }
    }
    log(`tray: action=${action}${info}${dryRun() ? ' (dry run)' : ''}`)
    if (dryRun()) return
    if (action === 'hide') win.hide()
    else await focusWindow(win)
  }

  tray.on('click', () => void toggle())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / hide', click: () => void toggle() },
      {
        label: 'New chat',
        click: () => {
          void show().then((w) => {
            if (w) emit('tray:newChat', null)
          })
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]),
  )
  return tray
}
