// One-time move of user data from the app's former name (agent-command-center) to hearth.
// Pure node (no electron import) so it can be bundled and tested on its own. Never throws.
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

const slug = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-')
const isRealDir = (p: string): boolean => {
  try {
    const s = lstatSync(p)
    return s.isDirectory() && !s.isSymbolicLink()
  } catch {
    return false
  }
}
const present = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function legacyInstanceRunning(dir: string): boolean {
  let target: string
  try {
    target = readlinkSync(join(dir, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1])
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) out.push(p)
  }
}

/** Rewrites the old general-chats path to the new one in the transcripts, then moves the project dir to the new slug. */
export function rewriteTranscripts(claudeDir: string, oldChats: string, newChats: string, log: (m: string) => void): void {
  try {
    const OP = join(claudeDir, 'projects', slug(oldChats))
    const NP = join(claudeDir, 'projects', slug(newChats))
    if (!isRealDir(OP) || OP === NP) return
    const from = JSON.stringify(oldChats).slice(1, -1)
    const to = JSON.stringify(newChats).slice(1, -1)
    const files: string[] = []
    walk(OP, files)
    let rewritten = 0
    for (const f of files) {
      try {
        const text = readFileSync(f, 'utf8')
        if (!text.includes(from)) continue
        const tmp = `${f}.hearth-tmp`
        writeFileSync(tmp, text.split(from).join(to))
        renameSync(tmp, f)
        rewritten++
      } catch (e) {
        log(`migrate: could not rewrite ${f}: ${(e as Error).message}`)
      }
    }
    let moved = 0
    if (!present(NP)) {
      renameSync(OP, NP)
      moved = 1
    } else {
      for (const name of readdirSync(OP)) {
        if (present(join(NP, name))) continue
        renameSync(join(OP, name), join(NP, name))
        moved++
      }
      try {
        rmdirSync(OP)
      } catch {
        /* not empty */
      }
    }
    log(`migrate: transcripts: ${files.length} files scanned, ${rewritten} rewritten, ${moved} entries moved`)
  } catch (e) {
    log(`migrate: transcripts failed: ${(e as Error).message}`)
  }
}

export function migrateLegacyData(o: {
  appData: string
  home: string
  claudeDir: string
  platform: NodeJS.Platform
  log: (m: string) => void
}): { userData: string } {
  const L = join(o.appData, 'agent-command-center')
  const N = join(o.appData, 'hearth')
  try {
    if (isRealDir(L) && !present(N)) {
      if (legacyInstanceRunning(L)) {
        o.log('migrate: legacy instance is running, not migrating yet')
        return { userData: L }
      }
      try {
        renameSync(L, N)
      } catch (e) {
        o.log(`migrate: cannot move ${L}: ${(e as Error).message}`)
        return { userData: L }
      }
      o.log(`migrate: moved ${L} -> ${N}`)
      try {
        symlinkSync(N, L, o.platform === 'win32' ? 'junction' : 'dir')
      } catch (e) {
        o.log(`migrate: legacy symlink failed: ${(e as Error).message}`)
      }

      const linux = o.platform === 'linux'
      const LC = linux ? join(o.home, '.local/share/agent-command-center/chats') : join(L, 'chats')
      const NC = linux ? join(o.home, '.local/share/hearth/chats') : join(N, 'chats')
      if (linux) {
        try {
          if (isRealDir(LC)) {
            try {
              rmdirSync(NC) // an empty placeholder created by an earlier start of the new build
            } catch {
              /* missing or not empty */
            }
          }
          if (isRealDir(LC) && !present(NC)) {
            mkdirSync(dirname(NC), { recursive: true })
            renameSync(LC, NC)
            o.log(`migrate: moved ${LC} -> ${NC}`)
            try {
              rmdirSync(dirname(LC))
            } catch {
              /* not empty */
            }
          }
        } catch (e) {
          o.log(`migrate: chats dir move failed: ${(e as Error).message}`)
        }
      }
      rewriteTranscripts(o.claudeDir, LC, NC, o.log)
    }
  } catch (e) {
    o.log(`migrate: failed: ${(e as Error).message}`)
  }
  return { userData: N }
}
