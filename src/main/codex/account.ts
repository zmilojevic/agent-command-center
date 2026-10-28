import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexStatus, ModelChoice, PlanUsage, UsageRow } from '../../shared/types'
import type { EffortLevel } from '../../shared/types'
import { codexBinary, type CodexServer } from './appServer'
import type { CodexAccount, CodexModel, RateLimitSnapshot, RateLimitWindow } from './protocol'

const MODELS_TTL_MS = 10 * 60_000
const USAGE_TTL_MS = 30_000
let modelsCache: { at: number; models: ModelChoice[] } | undefined

/** `model/list` as ModelChoice[] (hidden models left out; efforts are Codex's own strings, `ultra` included). */
export async function listCodexModels(server: CodexServer): Promise<ModelChoice[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models
  const out: ModelChoice[] = []
  let cursor: string | null = null
  do {
    const res: { data: CodexModel[]; nextCursor: string | null } = await server.request('model/list', cursor ? { cursor } : {})
    for (const m of res.data) {
      if (m.hidden) continue
      out.push({
        value: m.model,
        displayName: m.displayName,
        description: m.description,
        supportsEffort: m.supportedReasoningEfforts.length > 0,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) as EffortLevel[],
      })
    }
    cursor = res.nextCursor
  } while (cursor)
  if (out.length) modelsCache = { at: Date.now(), models: out }
  return out
}

const severityOf = (p: number): string => (p >= 90 ? 'critical' : p >= 75 ? 'warning' : 'normal')

function windowLabel(w: RateLimitWindow, fallback: string): string {
  const m = w.windowDurationMins
  if (!m) return fallback
  if (m <= 360) return 'Current session'
  if (m >= 10_000 && m <= 10_200) return 'Weekly'
  return m % 1440 === 0 ? `${m / 1440} d window` : `${Math.round(m / 60)} h window`
}

/** account/rateLimits snapshot to the renderer's PlanUsage. Primary = short window ("session"), secondary = weekly. */
export function normalizeCodexUsage(snaps: RateLimitSnapshot[], now = Date.now()): PlanUsage {
  const rows: UsageRow[] = []
  const add = (kind: string, group: string, label: string, w: RateLimitWindow | null): void => {
    if (!w || typeof w.usedPercent !== 'number') return
    rows.push({ kind, group, label, percent: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null, severity: severityOf(w.usedPercent), active: false })
  }
  snaps.forEach((s, i) => {
    const name = s.limitName ?? s.limitId ?? 'Codex'
    if (i === 0) {
      add('session', 'session', s.primary ? windowLabel(s.primary, 'Current session') : '', s.primary)
      add('weekly_all', 'weekly', s.secondary ? windowLabel(s.secondary, 'Weekly') : '', s.secondary)
    } else {
      add('weekly_scoped', 'other', `${name}${s.primary ? ` (${windowLabel(s.primary, 'short')})` : ''}`, s.primary)
      add('weekly_scoped', 'other', `${name}${s.secondary ? ` (${windowLabel(s.secondary, 'long')})` : ''}`, s.secondary)
    }
  })
  return { available: rows.length > 0, subscription: snaps[0]?.planType ?? null, rows, fetchedAt: now }
}

/** Sparse update: usedPercent from the update, reset time and duration kept from the base window when the update lacks them (unless the old reset has passed). */
function mergeWindow(base: RateLimitWindow | null, upd: RateLimitWindow | null | undefined): RateLimitWindow | null {
  if (!upd) return base
  if (!base) return upd
  const baseReset = base.resetsAt && base.resetsAt * 1000 > Date.now() ? base.resetsAt : null
  return { usedPercent: upd.usedPercent, windowDurationMins: upd.windowDurationMins ?? base.windowDurationMins, resetsAt: upd.resetsAt ?? baseReset }
}

/** Codex login state, models and rate limits over the shared app-server. */
export class CodexAccountService {
  private usageCache: PlanUsage | null = null
  private snapshot: RateLimitSnapshot | null = null
  private others: RateLimitSnapshot[] = []
  private version: string | undefined
  private versionAsked = false

  constructor(
    private server: CodexServer,
    private log: (s: string) => void,
    private push: (u: PlanUsage) => void,
  ) {
    server.onGlobal((method, params) => {
      if (method !== 'account/rateLimits/updated' || !params?.rateLimits) return
      // Sparse update: merge the windows that are present into the last snapshot.
      const u = params.rateLimits as RateLimitSnapshot
      const base: RateLimitSnapshot = this.snapshot ?? { limitId: u.limitId, limitName: u.limitName, primary: null, secondary: null, planType: u.planType }
      this.snapshot = { ...base, primary: mergeWindow(base.primary, u.primary), secondary: mergeWindow(base.secondary, u.secondary), planType: u.planType ?? base.planType }
      this.usageCache = normalizeCodexUsage([this.snapshot, ...this.others])
      this.push(this.usageCache)
    })
  }

  private readVersion(): Promise<string | undefined> {
    if (this.versionAsked) return Promise.resolve(this.version)
    const bin = codexBinary()
    if (!bin) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 10_000, windowsHide: true, shell: process.platform === 'win32' && bin.endsWith('.cmd') }, (_e, out) => {
        this.versionAsked = true
        this.version = String(out).trim().replace(/^codex(-cli)?\s+/i, '') || undefined
        resolve(this.version)
      })
    })
  }

  async status(): Promise<CodexStatus> {
    if (!codexBinary()) return { installed: false, loggedIn: false }
    const version = await this.readVersion()
    try {
      const res = await this.server.request<{ account: CodexAccount | null; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false })
      const a = res.account
      return {
        installed: true,
        version,
        loggedIn: !!a || res.requiresOpenaiAuth === false,
        account: a ? { type: a.type, email: a.email ?? undefined, plan: a.planType } : undefined,
      }
    } catch (e) {
      return { installed: true, version, loggedIn: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async usage(force = false): Promise<PlanUsage | null> {
    if (!codexBinary()) return null
    if (this.usageCache && !force && Date.now() - this.usageCache.fetchedAt < USAGE_TTL_MS) return this.usageCache
    try {
      const res = await this.server.request<{ rateLimits: RateLimitSnapshot; rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null }>('account/rateLimits/read')
      this.snapshot = res.rateLimits
      this.others = Object.values(res.rateLimitsByLimitId ?? {}).filter((s) => s && s.limitId !== res.rateLimits.limitId)
      this.usageCache = normalizeCodexUsage([res.rateLimits, ...this.others])
      return this.usageCache
    } catch (e) {
      this.log(`codex usage: ${e instanceof Error ? e.message : String(e)}`)
      return this.usageCache ? { ...this.usageCache, error: e instanceof Error ? e.message : String(e) } : null
    }
  }

  models(): Promise<ModelChoice[]> {
    return listCodexModels(this.server).catch((e) => {
      this.log(`codex models: ${e instanceof Error ? e.message : String(e)}`)
      return []
    })
  }
}

/** AGENTS.md in cwd or in the git root containing it. */
export async function hasAgentsMd(cwd: string): Promise<boolean> {
  if (!cwd) return false
  if (existsSync(join(cwd, 'AGENTS.md'))) return true
  const root = await new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 3000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null))
  })
  if (!root) return false
  return existsSync(join(root, 'AGENTS.md'))
}
