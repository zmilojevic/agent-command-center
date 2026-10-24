import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangedFile, GitChanges } from '../shared/types'

const run = promisify(execFile)
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_FILES_UNTRACKED = 200
const MAX_UNTRACKED_BYTES = 1024 * 1024
const MAX_DIFF_BYTES = 4 * 1024 * 1024

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

/** `git diff --no-index` exits 1 when the files differ; that is not a failure. */
async function gitNoIndex(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch (e) {
    const err = e as { code?: number; stdout?: string }
    if (err.code === 1 && typeof err.stdout === 'string') return err.stdout
    throw e
  }
}

function parseChunk(chunk: string): ChangedFile {
  const lines = chunk.split('\n')
  let oldPath: string | undefined
  let newPath: string | undefined
  let renameFrom: string | undefined
  let renameTo: string | undefined
  let status: ChangedFile['status'] = 'M'
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const l of lines) {
    if (inHunk) {
      if (l.startsWith('+')) additions++
      else if (l.startsWith('-')) deletions++
      continue
    }
    if (l.startsWith('@@')) inHunk = true
    else if (l.startsWith('new file mode')) status = 'A'
    else if (l.startsWith('deleted file mode')) status = 'D'
    else if (l.startsWith('rename from ')) renameFrom = l.slice(12)
    else if (l.startsWith('rename to ')) renameTo = l.slice(10)
    else if (l.startsWith('--- ')) oldPath = l.slice(4).replace(/\t.*$/, '')
    else if (l.startsWith('+++ ')) newPath = l.slice(4).replace(/\t.*$/, '')
  }
  if (renameFrom && renameTo) status = 'R'
  const head = lines[0].replace(/^diff --git /, '')
  const m = /^a\/(.+) b\/(.+)$/.exec(head)
  const strip = (p: string | undefined, pre: string): string | undefined => (p && p !== '/dev/null' ? p.replace(new RegExp(`^${pre}/`), '') : undefined)
  const path = renameTo ?? strip(newPath, 'b') ?? strip(oldPath, 'a') ?? m?.[2] ?? head
  const file: ChangedFile = { path, status, additions, deletions, diff: chunk }
  if (status === 'R') file.oldPath = renameFrom
  if (lines.some((l) => l.startsWith('Binary files ') || l === 'GIT binary patch')) file.binary = true
  return file
}

function splitChunks(out: string): string[] {
  if (!out) return []
  return out
    .split(/^(?=diff --git )/m)
    .filter((c) => c.startsWith('diff --git '))
    .map((c) => c.replace(/\n$/, ''))
}

/** Uncommitted changes of the repository containing `cwd`: tracked diff against HEAD plus untracked files. */
export async function gitChanges(cwd: string): Promise<GitChanges> {
  let root: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { isRepo: false, files: [] }
  }
  try {
    let base = EMPTY_TREE
    try {
      await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
      base = 'HEAD'
    } catch {
      /* no commits yet */
    }
    const tracked = await git(root, ['diff', base, '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'])
    const files = splitChunks(tracked).map(parseChunk)

    const names = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    for (const path of names.slice(0, MAX_FILES_UNTRACKED)) {
      let size = 0
      try {
        size = (await stat(join(root, path))).size
      } catch {
        continue
      }
      if (size > MAX_UNTRACKED_BYTES) {
        files.push({ path, status: '?', additions: 0, deletions: 0, binary: true })
        continue
      }
      const out = await gitNoIndex(root, ['diff', '--no-index', '--no-color', '--', '/dev/null', path])
      const f = parseChunk(splitChunks(out)[0] ?? `diff --git a/${path} b/${path}`)
      files.push({ ...f, path, status: '?', oldPath: undefined })
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    let total = 0
    let truncated = false
    for (const f of files) {
      if (!f.diff) continue
      if (truncated || total + f.diff.length > MAX_DIFF_BYTES) {
        truncated = true
        delete f.diff
      } else total += f.diff.length
    }
    return truncated ? { isRepo: true, root, files, truncated } : { isRepo: true, root, files }
  } catch (e) {
    return { isRepo: true, root, files: [], error: e instanceof Error ? e.message : String(e) }
  }
}
