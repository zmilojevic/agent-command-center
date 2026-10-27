import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

let cached: string | undefined | null = null

function resolveNative(): string | undefined {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const names = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${exe}`]
  if (process.platform === 'linux') names.push(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude`)
  const requires = [createRequire(import.meta.url)]
  try {
    requires.push(createRequire(requires[0].resolve('@anthropic-ai/claude-agent-sdk')))
  } catch {
    /* only the first resolver */
  }
  for (const req of requires) {
    for (const n of names) {
      try {
        return req.resolve(n)
      } catch {
        /* try the next */
      }
    }
  }
  return undefined
}

/**
 * Packaged apps: the SDK's native binary resolves to a path inside app.asar, which cannot be spawned;
 * the unpacked copy lives in app.asar.unpacked. Undefined in dev (the SDK finds it itself).
 */
export function claudeExecutable(): string | undefined {
  if (cached !== null) return cached
  cached = undefined
  if (!app.isPackaged) return cached
  const found = resolveNative()
  if (!found) return cached
  const fixed = found.replace(new RegExp(`app\\.asar(?=[\\\\/])`), 'app.asar.unpacked')
  if (existsSync(fixed)) cached = fixed
  return cached
}

/** The native `claude` binary to run CLI subcommands with (packaged: unpacked copy; dev: the SDK's own). */
export function claudeBinary(): string | undefined {
  return app.isPackaged ? claudeExecutable() : resolveNative()
}
