// Hearth's own notification chime: warm "ember" mallet notes, Web Audio only (no files).
let ctx: AudioContext | null = null

const NOTES = {
  done: [987.77, 659.25], // B5 -> E5, falling
  attention: [659.25, 987.77, 1318.51], // E5 -> B5 -> E6, rising
}
const GAPS = { done: 0.12, attention: 0.09 }

export function playChime(kind: 'done' | 'attention'): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const c = ctx
    const t0 = c.currentTime + 0.02
    const nodes: AudioNode[] = []
    const master = c.createGain()
    master.gain.value = 0.16
    master.connect(c.destination)
    nodes.push(master)
    let end = t0
    NOTES[kind].forEach((f, i) => {
      const t = t0 + i * GAPS[kind]
      const lp = c.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 2600
      lp.Q.value = 0.7
      lp.connect(master)
      nodes.push(lp)
      // fundamental + two partials, the higher ones die faster
      for (const [mult, gain, decay] of [[1, 1, 0.9], [2, 0.22, 0.45], [3.01, 0.06, 0.25]]) {
        const o = c.createOscillator()
        const g = c.createGain()
        o.frequency.value = f * mult
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(gain, t + 0.006)
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
        o.connect(g).connect(lp)
        o.start(t)
        o.stop(t + decay + 0.02)
        nodes.push(o, g)
        end = Math.max(end, t + decay + 0.02)
      }
      if (i === 0) {
        // soft crackle at the first onset
        const len = Math.ceil(c.sampleRate * 0.025)
        const buf = c.createBuffer(1, len, c.sampleRate)
        const d = buf.getChannelData(0)
        for (let k = 0; k < len; k++) d[k] = Math.random() * 2 - 1
        const src = c.createBufferSource()
        const bp = c.createBiquadFilter()
        const g = c.createGain()
        src.buffer = buf
        bp.type = 'bandpass'
        bp.frequency.value = 1800
        bp.Q.value = 1.2
        g.gain.setValueAtTime(0.05, t)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.025)
        src.connect(bp).connect(g).connect(master)
        src.start(t)
        nodes.push(src, bp, g)
      }
    })
    setTimeout(() => nodes.forEach((n) => n.disconnect()), (end - c.currentTime) * 1000 + 100)
  } catch {
    // audio is best effort
  }
}
