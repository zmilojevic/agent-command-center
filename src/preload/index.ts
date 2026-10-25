import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types'
import { INVOKES, SENDS, EVENTS } from '../shared/channels'

const on = <T>(channel: string) => (cb: (payload: T) => void) => {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: Record<string, unknown> = { platform: process.platform, client: 'desktop' }
for (const [name, ch] of Object.entries(INVOKES)) api[name] = (...a: unknown[]) => ipcRenderer.invoke(ch, ...a)
for (const [name, ch] of Object.entries(SENDS)) api[name] = (...a: unknown[]) => ipcRenderer.send(ch, ...a)
for (const [name, ch] of Object.entries(EVENTS)) api[name] = on(ch)

contextBridge.exposeInMainWorld('desktop', api as unknown as DesktopApi)
