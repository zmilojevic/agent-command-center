import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { claudeExecutable } from './claudeBin'
import type { PlanUsage, UsageRow } from '../shared/types'
import type { RunnerRegistry } from './agent'

type Json = Record<string, any>

function severityOf(p: number): string {
  return p >= 90 ? 'critical' : p >= 75 ? 'warning' : 'normal'
}

/** Turns the SDK usage response into the renderer's PlanUsage. */
export function normalizeUsage(res: unknown, now = Date.now()): PlanUsage {
  const r = (res ?? {}) as Json
  const rl: Json = r.rate_limits ?? {}
  const rows: UsageRow[] = []
  if (Array.isArray(rl.limits)) {
    for (const l of rl.limits as Json[]) {
      if (!l || typeof l.percent !== 'number') continue
      const kind = String(l.kind ?? '')
      const label =
        kind === 'session'
          ? 'Current session'
          : kind === 'weekly_all'
            ? 'All models'
            : kind === 'weekly_scoped'
              ? (l.scope?.model?.display_name ?? l.scope?.surface?.display_name ?? 'Scoped')
              : kind.replace(/_/g, ' ')
      rows.push({
        kind,
        group: String(l.group ?? 'other'),
        label,
        percent: l.percent,
        resetsAt: l.resets_at ?? null,
        severity: l.severity ?? severityOf(l.percent),
        active: !!l.is_active,
      })
    }
  } else {
    const add = (kind: string, group: string, label: string, e: Json | null | undefined): void => {
      if (!e || typeof e.utilization !== 'number') return
      rows.push({ kind, group, label, percent: e.utilization, resetsAt: e.resets_at ?? null, severity: severityOf(e.utilization), active: false })
    }
    add('session', 'session', 'Current session', rl.five_hour)
    add('weekly_all', 'weekly', 'All models', rl.seven_day)
    add('weekly_scoped', 'weekly', 'Opus', rl.seven_day_opus)
    add('weekly_scoped', 'weekly', 'Sonnet', rl.seven_day_sonnet)
    for (const m of (rl.model_scoped ?? []) as Json[]) add('weekly_scoped', 'weekly', m?.display_name ?? 'Scoped', m)
  }
  const x: Json | null = rl.extra_usage ?? null
  return {
    available: r.rate_limits_available !== false && rows.length > 0,
    subscription: r.subscription_type ?? null,
    rows,
    extra: x
      ? { enabled: !!x.is_enabled, usedCredits: x.used_credits ?? null, monthlyLimit: x.monthly_limit ?? null, currency: x.currency ?? null }
      : undefined,
    fetchedAt: now,
  }
}

/** Never fetch more often than this (also the forced-refresh threshold). */
const MIN_INTERVAL_MS = 10 * 60_000
/** Refetch at least this often even without transcript activity. */
const IDLE_INTERVAL_MS = 60 * 60_000
const BACKOFF_MAX_MS = 60 * 60_000

export class UsageService {
  private last: PlanUsage | null = null
  private inflight: Promise<PlanUsage | null> | null = null
  private lastActivityAt = 0
  private failures = 0
  private nextAllowedAt = 0

  constructor(
    private runners: RunnerRegistry,
    private log: (s: string) => void,
    private push: (u: PlanUsage) => void,
  ) {}

  start(): void {
    void this.refresh()
    setInterval(() => this.tick(), 60_000).unref?.()
  }

  /** Records that transcripts changed (a session did something); cheap, never fetches. */
  noteActivity(): void {
    this.lastActivityAt = Date.now()
  }

  private tick(): void {
    const now = Date.now()
    if (now < this.nextAllowedAt) return
    const last = this.last
    if (!last) {
      void this.refresh()
      return
    }
    const age = now - last.fetchedAt
    const hasRows = last.rows.length > 0
    if ((hasRows && this.lastActivityAt > last.fetchedAt && age >= MIN_INTERVAL_MS) || age >= IDLE_INTERVAL_MS || (!hasRows && !!last.error)) void this.refresh()
  }

  /** Cached value; fetches only when nothing is cached (outside backoff), or when forced, >= MIN_INTERVAL_MS old and outside backoff. */
  get(force: boolean): Promise<PlanUsage | null> {
    const now = Date.now()
    const ok = now >= this.nextAllowedAt
    if (ok && (!this.last || (force && now - this.last.fetchedAt >= MIN_INTERVAL_MS))) return this.refresh()
    return Promise.resolve(this.last)
  }

  private refresh(): Promise<PlanUsage | null> {
    if (this.inflight) return this.inflight
    const p = this.fetchOnce()
      .then((u) => {
        if (!u.available && u.rows.length === 0 && (this.last?.rows.length ?? 0) > 0) throw new Error('Usage response had no limits')
        this.failures = 0
        this.nextAllowedAt = 0
        this.last = u
        this.push(u)
        return u
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.failures++
        const wait = Math.min(MIN_INTERVAL_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS)
        this.nextAllowedAt = Date.now() + wait
        this.log(`usage: ${msg}; next try in ${Math.round(wait / 60_000)} min`)
        this.last = { available: false, subscription: null, rows: [], ...this.last, fetchedAt: this.last?.fetchedAt ?? Date.now(), error: msg }
        this.push(this.last)
        return this.last
      })
      .finally(() => {
        this.inflight = null
      })
    this.inflight = p
    return p
  }

  private async fetchOnce(): Promise<PlanUsage> {
    const work = (async () => {
      try {
        const viaRunner = this.runners.any()?.usage()
        if (viaRunner) return await viaRunner
      } catch {
        /* fall back to a temporary query */
      }
      return this.viaTemporaryQuery()
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('Timed out fetching usage')), 20_000)
    })
    try {
      return normalizeUsage(await Promise.race([work, timeout]))
    } finally {
      clearTimeout(timer)
    }
  }

  private async viaTemporaryQuery(): Promise<unknown> {
    const log = this.log
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    async function* idle(): AsyncGenerator<never> {
      await gate
    }
    const exe = claudeExecutable()
    const q = query({ prompt: idle(), options: { cwd: homedir(), persistSession: false, stderr: (d) => log(d), ...(exe ? { pathToClaudeCodeExecutable: exe } : {}) } })
    try {
      return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    } finally {
      release()
      try {
        q.close()
      } catch {
        /* already closed */
      }
    }
  }
}
