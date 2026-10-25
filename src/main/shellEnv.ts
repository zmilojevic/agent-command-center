import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const SKIP = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD'])

/**
 * macOS apps started from Finder/Dock get launchd's minimal PATH; import the login shell's environment
 * so git, editors and the Bash tool inside sessions find Homebrew etc. No-op elsewhere.
 */
export async function loadLoginShellEnv(log: (s: string) => void): Promise<void> {
  if (process.platform !== 'darwin' || process.env.CCD_SKIP_SHELL_ENV === '1') return
  const MARK = randomBytes(8).toString('hex')
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        shell,
        ['-ilc', `printf '%s' ${MARK}; command env -0; printf '%s' ${MARK}`],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: process.env, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
    const a = out.indexOf(MARK)
    const b = out.lastIndexOf(MARK)
    if (a < 0 || b <= a) throw new Error('markers not found')
    for (const entry of out.slice(a + MARK.length, b).split('\0')) {
      const i = entry.indexOf('=')
      if (i <= 0) continue
      const k = entry.slice(0, i)
      if (k.startsWith('ELECTRON_') || k.startsWith('CCD_') || SKIP.has(k)) continue
      process.env[k] = entry.slice(i + 1)
    }
  } catch (e) {
    log(`shellEnv: could not load login shell environment: ${String(e)}`)
  }
}
