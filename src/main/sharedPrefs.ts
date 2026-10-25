/** Sidebar-shaping prefs shared by every client (desktop + phones); persisted in <userData>/shared-prefs.json. */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from './ipc'
import { SHARED_PREFS } from '../shared/channels'

const file = (): string => join(app.getPath('userData'), 'shared-prefs.json')

function load(): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function registerSharedPrefs(emit: (channel: string, payload: unknown) => void): void {
  const data = load()
  handle('prefs:get', () => data)
  handle('prefs:set', (_ctx, key: string, json: string) => {
    if (!SHARED_PREFS.includes(key)) return
    let value: unknown
    try {
      value = JSON.parse(json)
    } catch {
      return
    }
    data[key] = value
    try {
      writeFileSync(file(), JSON.stringify(data))
    } catch {
      /* ignore */
    }
    emit('prefs:changed', { key, value })
  })
}
