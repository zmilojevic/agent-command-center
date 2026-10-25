import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, stat, readFile, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
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
    root = resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())
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

    const { cached, worktree } = await stagedSets(root)
    for (const f of files) f.staged = stagedState(f, cached, worktree)

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

// ---- worktrees -------------------------------------------------------------

const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,60}$/
const errText = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string }
  return (err.stderr || err.message || String(e)).trim()
}

/** Claude Code's convention: `<root>/.claude/worktrees/<name>` on branch `worktree-<name>`, created from HEAD. */
export async function createWorktree(cwd: string, name: string): Promise<{ path: string } | { error: string }> {
  try {
    if (!WORKTREE_NAME.test(name) || name === '.' || name === '..') {
      return { error: 'Use 1-60 letters, digits, dots, dashes or underscores.' }
    }
    // Always the main checkout, even when cwd is itself inside a linked worktree.
    const common = resolve((await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    const root = dirname(common)
    const path = join(root, '.claude', 'worktrees', name)
    if (existsSync(path)) return { error: `A worktree named "${name}" already exists.` }
    // Keep the parent repo's status clean: exclude locally, never touch .gitignore.
    const excludeFile = join(common, 'info', 'exclude')
    const line = '.claude/worktrees/'
    let current = ''
    try {
      current = await readFile(excludeFile, 'utf8')
    } catch {
      /* no file yet */
    }
    if (!current.split('\n').some((l) => l.trim() === line)) {
      await mkdir(join(common, 'info'), { recursive: true })
      await appendFile(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
    }
    await git(root, ['worktree', 'add', '-b', `worktree-${name}`, path, 'HEAD'])
    return { path }
  } catch (e) {
    return { error: errText(e) }
  }
}

/** Removes the worktree folder (branch stays). Runs from the main repo root, not from the worktree itself. */
export async function removeWorktree(path: string, force: boolean): Promise<{ error?: string }> {
  try {
    const common = resolve((await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
    await git(dirname(common), ['worktree', 'remove', ...(force ? ['--force'] : []), path])
    return {}
  } catch (e) {
    return { error: errText(e) }
  }
}

// ---- changes actions: staging, discard ----------------------------------------------------------

async function repoRoot(cwd: string): Promise<string> {
  return resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Sets of paths with staged / unstaged differences (renames split into delete + add). */
async function stagedSets(root: string): Promise<{ cached: Set<string>; worktree: Set<string> }> {
  const list = async (args: string[]): Promise<Set<string>> =>
    new Set((await git(root, ['diff', '--no-renames', '--name-only', '-z', ...args])).split('\0').filter(Boolean))
  return { cached: await list(['--cached']), worktree: await list([]) }
}

type FileRef = Pick<ChangedFile, 'path' | 'oldPath' | 'status'>

function stagedState(f: FileRef, cached: Set<string>, worktree: Set<string>): 'all' | 'partial' | 'none' {
  if (f.status === '?') return 'none'
  const paths = f.oldPath ? [f.path, f.oldPath] : [f.path]
  const inCached = paths.filter((p) => cached.has(p)).length
  if (inCached === 0) return 'none'
  if (inCached === paths.length && !paths.some((p) => worktree.has(p))) return 'all'
  return 'partial'
}

/** Stage or unstage one file. Returns an error message or null. */
export async function gitSetStaged(cwd: string, file: FileRef, staged: boolean): Promise<string | null> {
  try {
    const root = await repoRoot(cwd)
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
    if (staged) {
      if (file.status === 'R' && file.oldPath) await git(root, ['rm', '--cached', '-q', '--ignore-unmatch', '--', file.oldPath])
      await git(root, file.status === 'D' ? ['add', '-A', '--', file.path] : ['add', '--', file.path])
    } else if (await hasHead(root)) {
      await git(root, ['restore', '--staged', '--', ...paths])
    } else {
      await git(root, ['rm', '--cached', '-r', '-q', '--', file.path])
    }
    return null
  } catch (e) {
    return errText(e)
  }
}

/** Throw away all uncommitted changes of one file. Returns an error message or null. */
export async function gitDiscardFile(cwd: string, file: FileRef): Promise<string | null> {
  try {
    const root = await repoRoot(cwd)
    if (file.status === '?') {
      const abs = resolve(root, file.path)
      if (!abs.startsWith(root + sep)) return 'Path is outside the repository'
      await rm(abs, { force: true })
    } else if (file.status === 'A') {
      await git(root, ['rm', '-f', '-q', '--', file.path])
    } else if (file.status === 'R' && file.oldPath) {
      await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.oldPath])
      await git(root, ['rm', '-f', '-q', '--', file.path])
    } else {
      await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path])
    }
    return null
  } catch (e) {
    return errText(e)
  }
}

/** Reverse-apply a one-hunk patch (file header + hunk) to the working tree only. */
export async function gitDiscardHunk(cwd: string, patch: string): Promise<string | null> {
  try {
    const root = await repoRoot(cwd)
    return await new Promise<string | null>((done) => {
      const p = spawn('git', ['apply', '-R', '--recount', '--whitespace=nowarn', '-'], { cwd: root })
      let err = ''
      p.stderr.on('data', (d) => (err += d))
      p.on('error', (e) => done(e.message))
      p.on('close', (code) => done(code === 0 ? null : err.trim() || `git apply exited with ${code}`))
      p.stdin.on('error', () => {})
      p.stdin.end(patch.endsWith('\n') ? patch : patch + '\n')
    })
  } catch (e) {
    return errText(e)
  }
}
