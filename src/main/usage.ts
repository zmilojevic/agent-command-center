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

/** Plan usage is polled at this interval and never fetched more often. */
const MIN_INTERVAL_MS = 2 * 60_000

export class UsageService {
  private last: PlanUsage | null = null
  private inflight: Promise<PlanUsage | null> | null = null

  constructor(
    private runners: RunnerRegistry,
    private log: (s: string) => void,
    private push: (u: PlanUsage) => void,
  ) {}

  start(): void {
    void this.refresh()
    setInterval(() => void this.refresh(), MIN_INTERVAL_MS).unref?.()
  }

  /** Cached value; fetches only when nothing is cached yet, or when forced and the cache is >= MIN_INTERVAL_MS old. */
  get(force: boolean): Promise<PlanUsage | null> {
    if (!this.last || (force && Date.now() - this.last.fetchedAt >= MIN_INTERVAL_MS)) return this.refresh()
    return Promise.resolve(this.last)
  }

  private refresh(): Promise<PlanUsage | null> {
    if (this.inflight) return this.inflight
    const p = this.fetchOnce()
      .then((u) => {
        this.last = u
        this.push(u)
        return u
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.log(`usage: ${msg}`)
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
