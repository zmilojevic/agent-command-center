import { execFile } from 'node:child_process'
import { claudeBinary } from './claudeBin'
import type { AuthStatus } from '../shared/types'

/** `claude auth status --json`; `out` only when the CLI clearly says logged out, anything else odd is `unknown`. */
export function authStatus(): Promise<AuthStatus> {
  const bin = claudeBinary()
  if (!bin) return Promise.resolve({ state: 'unknown' })
  return new Promise((resolve) => {
    // The CLI exits 1 when logged out but still prints the JSON, so read stdout whatever the exit code.
    execFile(bin, ['auth', 'status', '--json'], { timeout: 15_000, env: process.env, windowsHide: true }, (_err, stdout) => {
      try {
        const j = JSON.parse(String(stdout)) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
        const provider = j.apiProvider
        if (j.loggedIn === true) return resolve({ state: 'in', method: j.authMethod, provider })
        if (j.loggedIn === false && (!provider || provider === 'firstParty')) return resolve({ state: 'out', method: j.authMethod, provider })
      } catch {
        /* fall through */
      }
      resolve({ state: 'unknown' })
    })
  })
}
