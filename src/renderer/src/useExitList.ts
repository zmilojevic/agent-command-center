import { useEffect, useRef, useState } from 'react'

export interface ExitEntry<T> {
  item: T
  key: string
  leaving: boolean
}

interface Opts<T> {
  /** How long a removed entry stays in the output (default 200). */
  ms?: number
  /** A change of this value drops removed entries immediately (search text, filters). */
  resetKey?: string
  /** Removed entries are dropped immediately when a key was added in the same group in the same update (replacement). */
  groupOf?: (t: T) => string
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Current items in order plus recently removed ones (`leaving: true`, last snapshot), each kept right after its nearest
 * surviving previous neighbour so it stays in place while its exit animation runs.
 */
export function useExitList<T>(items: T[], keyOf: (t: T) => string, opts: Opts<T> = {}): ExitEntry<T>[] {
  const ms = opts.ms ?? 200
  const resetKey = opts.resetKey ?? ''
  const [, setTick] = useState(0)
  const st = useRef<{ out: ExitEntry<T>[]; sig: string | null; reset: string; timers: Map<string, ReturnType<typeof setTimeout>> }>({
    out: [],
    sig: null,
    reset: resetKey,
    timers: new Map(),
  })
  const s = st.current

  const keys = items.map(keyOf)
  const sig = keys.join('\n')
  if (s.sig !== sig || s.reset !== resetKey) {
    const cur = new Set(keys)
    const prev = s.out
    const prevKeys = new Set(prev.map((e) => e.key))
    const resetChanged = s.reset !== resetKey
    const noAnim = resetChanged || reducedMotion()
    const addedGroups = new Set<string>()
    let anyAdded = false
    for (let i = 0; i < items.length; i++) {
      if (prevKeys.has(keys[i])) continue
      anyAdded = true
      if (opts.groupOf) addedGroups.add(opts.groupOf(items[i]))
    }
    const out: ExitEntry<T>[] = items.map((item, i) => ({ item, key: keys[i], leaving: false }))
    const present = new Set(keys)
    for (let i = 0; i < prev.length; i++) {
      const e = prev[i]
      if (cur.has(e.key)) {
        // came back: no longer leaving
        const t = s.timers.get(e.key)
        if (t) {
          clearTimeout(t)
          s.timers.delete(e.key)
        }
        continue
      }
      let keep = e.leaving
      if (!e.leaving) {
        const replaced = opts.groupOf ? addedGroups.has(opts.groupOf(e.item)) : anyAdded
        keep = !noAnim && !replaced
        if (keep) {
          const key = e.key
          s.timers.set(
            key,
            setTimeout(() => {
              s.timers.delete(key)
              s.out = s.out.filter((x) => x.key !== key)
              setTick((n) => n + 1)
            }, ms),
          )
        }
      }
      if (!keep) {
        const t = s.timers.get(e.key)
        if (t) {
          clearTimeout(t)
          s.timers.delete(e.key)
        }
        continue
      }
      let at = 0
      for (let j = i - 1; j >= 0; j--) {
        if (!present.has(prev[j].key)) continue
        at = out.findIndex((x) => x.key === prev[j].key) + 1
        break
      }
      out.splice(at, 0, { item: e.item, key: e.key, leaving: true })
      present.add(e.key)
    }
    if (resetChanged) {
      for (const t of s.timers.values()) clearTimeout(t)
      s.timers.clear()
    }
    s.out = out
    s.sig = sig
    s.reset = resetKey
  } else {
    // same key set: refresh the snapshots of the live entries
    const byKey = new Map(items.map((it, i) => [keys[i], it]))
    for (const e of s.out) if (!e.leaving) e.item = byKey.get(e.key) as T
  }

  useEffect(() => {
    const timers = s.timers
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [s])

  return s.out.map((e) => ({ ...e }))
}

const animated = new WeakSet<HTMLElement>()

/** Collapse height + fade for an element that just turned leaving (call from a ref callback; runs once per element). */
export function animateOut(el: HTMLElement | null, ms = 180): void {
  if (!el || animated.has(el)) return
  animated.add(el)
  el.animate(
    [
      { height: el.offsetHeight + 'px', opacity: 1 },
      { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' },
    ],
    { duration: ms, easing: 'ease', fill: 'forwards' },
  )
}

/** Undo `animateOut` on an element that is no longer leaving (its key came back and the DOM node was reused). */
export function resetOut(el: HTMLElement | null): void {
  if (!el || !animated.has(el)) return
  el.getAnimations().forEach((a) => a.cancel())
  animated.delete(el)
}
