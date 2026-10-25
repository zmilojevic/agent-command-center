import { join, resolve, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { readdir, readFile, writeFile, rename, rm, stat, mkdir } from 'node:fs/promises'
import { withIdleQuery } from './agent'
import { parseWorkflowFile, generateWorkflow } from '../shared/workflow'
import type { WorkflowFile, WorkflowReadResult, WorkflowSaveRequest, WorkflowSaveResult, WorkflowAgent, WorkflowScope } from '../shared/workflow'

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const userDir = (): string => join(configDir(), 'workflows')
const projectDir = (root: string): string => join(root, '.claude', 'workflows')

/** A workflow file path: a .js file directly in `<x>/.claude/workflows` or in the user's workflows dir. */
function allowedPath(p: unknown): string | null {
  if (typeof p !== 'string' || !isAbsolute(p)) return null
  const full = resolve(p)
  if (!full.endsWith('.js')) return null
  const parent = dirname(full)
  if (parent === resolve(userDir())) return full
  if (basename(parent) === 'workflows' && basename(dirname(parent)) === '.claude') return full
  return null
}

async function listDir(dir: string, scope: WorkflowScope): Promise<WorkflowFile[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.js'))
  } catch {
    return []
  }
  const res: WorkflowFile[] = []
  for (const n of names) {
    const path = join(dir, n)
    try {
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      if (!st.isFile()) continue
      const { kind, meta } = parseWorkflowFile(text)
      res.push({ name: n.slice(0, -3), scope, path, description: meta.description, mtime: st.mtimeMs, kind })
    } catch {
      /* unreadable file: skip */
    }
  }
  return res
}

export async function workflowList(root: string): Promise<WorkflowFile[]> {
  const project = typeof root === 'string' && isAbsolute(root) ? await listDir(projectDir(root), 'project') : []
  const user = await listDir(userDir(), 'user')
  const byName = (a: WorkflowFile, b: WorkflowFile): number => a.name.localeCompare(b.name)
  return [...project.sort(byName), ...user.sort(byName)]
}

export async function workflowRead(path: string): Promise<WorkflowReadResult> {
  const p = allowedPath(path)
  if (!p) throw new Error('Not a workflow file')
  const code = await readFile(p, 'utf8')
  const { graph, kind, meta } = parseWorkflowFile(code)
  if (!meta.name) meta.name = basename(p, '.js')
  return { code, ...(graph ? { graph } : {}), kind, meta }
}

export async function workflowSave(req: WorkflowSaveRequest): Promise<WorkflowSaveResult> {
  try {
    const { root, scope, graph, force } = req
    if (!graph || !NAME_RE.test(graph.name)) return { ok: false, error: 'Invalid workflow name' }
    if (scope !== 'project' && scope !== 'user') return { ok: false, error: 'Invalid scope' }
    if (scope === 'project' && (typeof root !== 'string' || !isAbsolute(root))) return { ok: false, error: 'Invalid project folder' }
    let previous: string | null = null
    if (req.previousPath) {
      previous = allowedPath(req.previousPath)
      if (!previous) return { ok: false, error: 'Invalid previous path' }
    }
    const dir = scope === 'project' ? projectDir(root) : userDir()
    const target = join(dir, `${graph.name}.js`)
    if (!force) {
      let existing: string | null = null
      try {
        existing = await readFile(target, 'utf8')
      } catch {
        /* no such file */
      }
      if (existing !== null) {
        const kind = parseWorkflowFile(existing).kind
        const same = previous !== null && resolve(previous) === resolve(target)
        if (kind === 'edited' || kind === 'script') return { ok: false, conflict: kind }
        if (!same) return { ok: false, conflict: 'exists' }
      }
    }
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${graph.name}.js.${process.pid}.tmp`)
    try {
      await writeFile(tmp, generateWorkflow(graph), 'utf8')
      await rename(tmp, target)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    if (previous && resolve(previous) !== resolve(target)) await rm(previous, { force: true })
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function workflowDelete(path: string): Promise<string | null> {
  const p = allowedPath(path)
  if (!p) return 'Not a workflow file'
  try {
    await rm(p, { force: true })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Names of the agents defined by the `*.md` files of a directory (frontmatter `name:`, else the file stem). */
async function agentNames(dir: string): Promise<Set<string>> {
  const names = new Set<string>()
  let files: string[]
  try {
    files = (await readdir(dir)).filter((n) => n.endsWith('.md'))
  } catch {
    return names
  }
  for (const f of files) {
    let name = f.slice(0, -3)
    try {
      const text = await readFile(join(dir, f), 'utf8')
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      const m = fm && /^name:\s*(.+?)\s*$/m.exec(fm[1])
      if (m) name = m[1].replace(/^(['"])(.*)\1$/, '$2')
    } catch {
      /* use the file stem */
    }
    names.add(name)
  }
  return names
}

const agentsCache = new Map<string, { at: number; agents: WorkflowAgent[] }>()

/** Agents available to a workflow run in `root` (SDK registry via a temporary idle query, cached 60 s per root). */
export async function workflowAgents(root: string, log: (s: string) => void): Promise<WorkflowAgent[]> {
  if (typeof root !== 'string' || !isAbsolute(root)) return []
  const hit = agentsCache.get(root)
  if (hit && Date.now() - hit.at < 60_000) return hit.agents
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('Timed out listing agents')), 20_000)
  })
  try {
    const [list, project, user] = await Promise.all([
      Promise.race([withIdleQuery(root, log, (q) => q.supportedAgents()), timeout]),
      agentNames(join(root, '.claude', 'agents')),
      agentNames(join(configDir(), 'agents')),
    ])
    const agents: WorkflowAgent[] = list.map((a) => ({
      name: a.name,
      description: a.description,
      ...(a.model ? { model: a.model } : {}),
      source: project.has(a.name) ? 'project' : user.has(a.name) ? 'user' : 'other',
    }))
    if (agents.length) agentsCache.set(root, { at: Date.now(), agents })
    return agents
  } catch (e) {
    log(`workflow:agents failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  } finally {
    clearTimeout(timer)
  }
}
