import { ipcMain } from 'electron'

/** `client` is 'desktop' for Electron IPC and 'phone:<deviceId>' for the socket. */
export interface CallCtx {
  client: string
}

type Fn = (ctx: CallCtx, ...args: any[]) => unknown
const handlers = new Map<string, { fn: Fn; kind: 'invoke' | 'send' }>()

/** Registers an invoke handler (Electron IPC and the dispatch map). */
export function handle(channel: string, fn: Fn): void {
  handlers.set(channel, { fn, kind: 'invoke' })
  ipcMain.handle(channel, (_e, ...args) => fn({ client: 'desktop' }, ...args))
}

/** Registers a fire-and-forget handler. */
export function on(channel: string, fn: (ctx: CallCtx, ...args: any[]) => void): void {
  handlers.set(channel, { fn, kind: 'send' })
  ipcMain.on(channel, (_e, ...args) => fn({ client: 'desktop' }, ...args))
}

export async function dispatch(channel: string, ctx: CallCtx, args: unknown[]): Promise<unknown> {
  const h = handlers.get(channel)
  if (!h) throw new Error('unknown channel')
  return h.fn(ctx, ...args)
}
