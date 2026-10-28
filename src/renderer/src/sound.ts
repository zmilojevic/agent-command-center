// Hearth's own notification chime: a struck singing bowl (inharmonic sine partials, the
// higher ones dying faster), Web Audio only (no files).
let ctx: AudioContext | null = null

// [freqMultiplier, peakGain, decaySeconds]
const PARTIALS = [
  [0.5, 0.35, 2.4],
  [1, 1, 2.0],
  [2.0, 0.35, 1.3],
  [2.76, 0.28, 0.9],
  [5.4, 0.1, 0.4],
  [8.93, 0.04, 0.2],
]
// [frequency Hz, offset s] per strike
const STRIKES: Record<'done' | 'attention', [number, number][]> = {
  done: [[440, 0]], // A4
  attention: [[659.25, 0], [659.25, 0.16]], // E5 twice
}

export function playChime(kind: 'done' | 'attention'): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const c = ctx
    const t0 = c.currentTime + 0.02
    const nodes: AudioNode[] = []
    const master = c.createGain()
    master.gain.value = 0.09
    master.connect(c.destination)
    nodes.push(master)
    let end = t0
    for (const [f, offset] of STRIKES[kind]) {
      const t = t0 + offset
      for (const [mult, peak, decay] of PARTIALS) {
        const o = c.createOscillator()
        const g = c.createGain()
        o.frequency.value = f * mult
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(peak, t + 0.004)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004 + decay)
        o.connect(g).connect(master)
        o.start(t)
        o.stop(t + 0.004 + decay + 0.05)
        nodes.push(o, g)
        end = Math.max(end, t + 0.004 + decay + 0.05)
      }
    }
    setTimeout(() => nodes.forEach((n) => n.disconnect()), (end - c.currentTime) * 1000 + 100)
  } catch {
    // audio is best effort
  }
}
