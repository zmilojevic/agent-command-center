#!/usr/bin/env node
// Speaks the phone protocol against a running instance: node scripts/mobile-smoke.mjs <url> <code>
// <url> is the base address (http://host:port, a trailing /#pair=... is fine). Does not start Electron.
import WebSocket from 'ws'

const [urlArg, code] = process.argv.slice(2)
if (!urlArg || !code) {
  console.error('usage: node scripts/mobile-smoke.mjs <url> <code>')
  process.exit(2)
}
const u = new URL(urlArg)
const wsUrl = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed++
}

const open = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
const next = (ws) => new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
// Next message of the given type (events may interleave).
const nextOf = (ws, type) =>
  new Promise((resolve) => {
    const h = (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === type) {
        ws.off('message', h)
        resolve(m)
      }
    }
    ws.on('message', h)
  })

let id = 0
const invoke = async (ws, channel, ...args) => {
  const myId = ++id
  const p = new Promise((resolve) => {
    const h = (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === 'result' && m.id === myId) {
        ws.off('message', h)
        resolve(m)
      }
    }
    ws.on('message', h)
  })
  ws.send(JSON.stringify({ id: myId, type: 'invoke', channel, args }))
  return p
}

// Page is served
const page = await fetch(u.origin + '/')
check(page.ok && (await page.text()).includes('<div id="root">'), `GET / serves mobile.html (${page.status})`)

// The phone entry must not statically pull in the desktop entry chunk (it would run before window.desktop exists).
{
  const entryOf = (html) => /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1]
  const abs = (src, from) => new URL(src, from).href
  const mobileUrl = u.origin + '/mobile.html'
  const mEntry = entryOf(await (await fetch(mobileUrl)).text())
  const iRes = await fetch(u.origin + '/index.html')
  const dEntry = iRes.ok ? entryOf(await iRes.text()) : undefined
  if (!mEntry || !dEntry) check(false, 'could not find the entry scripts of mobile.html / index.html')
  else {
    const mUrl = abs(mEntry, mobileUrl)
    const dUrl = abs(dEntry, u.origin + '/index.html')
    const seen = new Set([mUrl])
    const queue = [mUrl]
    let bad = null
    for (let depth = 0; depth < 2 && queue.length; depth++) {
      for (const f of queue.splice(0)) {
        const src = await (await fetch(f)).text()
        for (const m of src.matchAll(/(?:^|[;}\n])\s*(?:import|export)\s*[^'"()]*?from\s*["'](\.[^"']+)["']|(?:^|[;}\n])\s*import\s*["'](\.[^"']+)["']/g)) {
          const dep = abs(m[1] ?? m[2], f)
          if (dep === dUrl) bad = f
          if (!seen.has(dep)) {
            seen.add(dep)
            queue.push(dep)
          }
        }
      }
    }
    check(!bad, `mobile entry does not statically import the desktop entry chunk${bad ? ` (${bad} does)` : ''}`)
  }
}

// Wrong code is refused
{
  const ws = await open()
  ws.send(JSON.stringify({ type: 'pair', code: 'WRONGCODE', name: 'smoke' }))
  const m = await next(ws)
  check(m.type === 'error', `wrong code refused (${m.error})`)
  ws.close()
}

// Pair
const ws0 = await open()
ws0.send(JSON.stringify({ type: 'pair', code, name: 'smoke-test' }))
const paired = await next(ws0)
check(paired.type === 'paired' && !!paired.token, 'pair with code')
ws0.close()
if (paired.type !== 'paired') process.exit(1)

// Unauthenticated invoke closes with 4401
{
  const ws = await open()
  const closed = new Promise((resolve) => ws.once('close', resolve))
  ws.send(JSON.stringify({ id: 1, type: 'invoke', channel: 'sessions:list', args: [] }))
  check((await closed) === 4401, 'invoke before auth closes with 4401')
}

// Auth
const ws = await open()
ws.send(JSON.stringify({ type: 'auth', token: paired.token }))
const hello = await nextOf(ws, 'hello')
check(hello.type === 'hello' && hello.deviceId === paired.deviceId, `auth (platform ${hello.platform})`)

const sessions = await invoke(ws, 'sessions:list')
check(sessions.ok && Array.isArray(sessions.value), `sessions:list -> ${sessions.ok ? sessions.value.length : sessions.error} sessions`)
const live = await invoke(ws, 'chat:live')
check(live.ok && Array.isArray(live.value), `chat:live -> ${live.ok ? live.value.length : live.error} live chats`)

for (const ch of ['window:action', 'pty:create', 'mobile:status']) {
  const r = await invoke(ws, ch, 'quit')
  check(!r.ok && r.error === 'not allowed', `${ch} refused (${r.error})`)
}
const unk = await invoke(ws, 'no:such')
check(!unk.ok, `unknown channel errors (${unk.error})`)

ws.close()
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
console.log(`note: device "smoke-test" stays paired; revoke it in the gear menu (Phone access).`)
process.exit(failed ? 1 : 0)
