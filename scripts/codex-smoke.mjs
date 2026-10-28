// Smoke test of the Codex engine (src/main/codex): bundles the real runner with vite (no electron needed), starts
// `codex app-server`, lists threads, runs one tiny turn on an ephemeral thread in a scratch dir (read-only) and prints
// the translated SDK-shaped messages. Uses the model from ~/.codex/config.toml. Costs a few real tokens.
//   node scripts/codex-smoke.mjs
//   node scripts/codex-smoke.mjs --resume <threadId>   read-only: thread/resume + thread/unsubscribe on an existing thread (no message sent)
// Prints the transport in use (shared daemon socket or private stdio; CCD_CODEX_TRANSPORT=stdio forces stdio).
import { build } from 'vite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const out = mkdtempSync(join(tmpdir(), 'codex-smoke-bundle-'))
const scratch = mkdtempSync(join(tmpdir(), 'codex-smoke-'))
let server

try {
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: { ssr: join(root, 'src/main/codex/smokeEntry.ts'), outDir: out, emptyOutDir: true, minify: false, target: 'node22' },
  })
  const { CodexServer, CodexRunner, listCodexSessions, listCodexModels, codexMessages } = await import(pathToFileURL(join(out, 'smokeEntry.js')).href)
  const log = (s) => process.stderr.write(`[log] ${s}\n`)
  server = new CodexServer(log, '0.0.0-smoke')
  await server.ensure()
  console.log(`initialized, transport: ${server.transport}`)

  const ri = process.argv.indexOf('--resume')
  if (ri > 0) {
    const threadId = process.argv[ri + 1]
    const res = await server.request('thread/resume', { threadId })
    console.log(`resume ok: thread ${res.thread.id} status=${JSON.stringify(res.thread.status)} cwd=${res.cwd}`)
    const sub = { onNotification() {}, onRequest() {}, onExit() {} }
    server.subscribe(threadId, sub)
    server.unsubscribe(threadId, sub)
    await new Promise((r) => setTimeout(r, 500))
    console.log('unsubscribed; RESUME CHECK OK')
    process.exitCode = 0
    throw new Error('__done__')
  }

  const threads = await listCodexSessions(server, log)
  console.log(`threads: ${threads.length}${threads[0] ? ` (newest: ${JSON.stringify(threads[0].summary.slice(0, 50))} in ${threads[0].cwd})` : ''}`)
  if (threads[0]) {
    const tr = await codexMessages(server, threads[0].sessionId)
    console.log(`transcript of newest thread: ${tr.length} lines (${[...new Set(tr.map((l) => l.type))].join(', ')})`)
  }
  const models = await listCodexModels(server)
  console.log(`models: ${models.map((m) => m.value).join(', ')}`)

  const events = []
  const emit = (channel, payload) => {
    events.push({ channel, payload })
    const m = payload?.message
    const brief = m ? `${m.type}${m.subtype ? '/' + m.subtype : ''}${m.event ? '/' + m.event.type : ''}` : ''
    console.log(`emit ${channel} ${brief} ${JSON.stringify(m ?? payload).slice(0, 260)}`)
  }
  const runner = new CodexRunner({ chatId: 'smoke', cwd: scratch, permissionMode: 'default', engine: 'codex', codexMode: 'read-only', ephemeral: true }, server, emit, log, 1)
  runner.start()
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('thread did not start')), 30_000)
    const iv = setInterval(() => {
      if (runner.status === 'idle') (clearTimeout(t), clearInterval(iv), res())
      if (runner.exited) (clearTimeout(t), clearInterval(iv), rej(new Error('runner exited during start')))
    }, 50)
  })
  console.log(`thread ${runner.sessionId} ready, model ${runner.lastModel}`)
  const done = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('turn timed out')), 120_000)
    const orig = emit
    runner.emit = (c, p) => {
      orig(c, p)
      if (c === 'agent:event' && p.message.type === 'result') (clearTimeout(t), res(p.message))
      if (c === 'chat:exit') (clearTimeout(t), rej(new Error(`chat:exit ${p.error}`)))
    }
  })
  runner.send('Reply with just the word pong', 'smoke-uuid-1')
  const result = await done
  const text = events
    .filter((e) => e.channel === 'agent:event' && e.payload.message.type === 'assistant')
    .flatMap((e) => e.payload.message.message.content.filter((b) => b.type === 'text').map((b) => b.text))
    .join('')
  console.log(`\nresult: subtype=${result.subtype} is_error=${result.is_error} usage=${JSON.stringify(result.usage)}`)
  console.log(`assistant text: ${JSON.stringify(text)}`)
  if (!/pong/i.test(text) || result.is_error) throw new Error('unexpected reply')
  await runner.close()
  console.log('SMOKE OK')
} catch (e) {
  if (e?.message !== '__done__') {
    console.error('SMOKE FAILED:', e)
    process.exitCode = 1
  }
} finally {
  server?.stop()
  rmSync(out, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode ?? 0), 200)
}
