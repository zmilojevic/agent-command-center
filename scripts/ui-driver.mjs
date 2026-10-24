// UI test driver: connects to a running app started with
// --remote-debugging-port=9333 (see scripts/dev-launch.sh) and runs a scenario.
// Usage: node scripts/ui-driver.mjs <scenario> [args]
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

// Screenshots and the scratch project the test chats run in (never a real folder of the user's).
const S = process.env.CCD_SHOTS ?? '/tmp/ccd-test'
const PROJ = `${S}/proj`
mkdirSync(PROJ, { recursive: true })
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null, protocolTimeout: 180000 })
const pages = await browser.pages()
const page = pages.find((p) => p.url().includes('index.html') || p.url().startsWith('http://localhost')) ?? pages[0]
const problems = []
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) {
    console.log('[console]', m.type(), m.text())
    if (m.type() === 'error') problems.push(m.text())
  }
})
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message)
  problems.push(e.message)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${S}/${name}.png` })
  console.log('shot', `${S}/${name}.png`)
}
const store = (fn, ...args) => page.evaluate(fn, ...args)
const activeChat = () =>
  store(() => {
    const s = window.__ccd.getState()
    const c = s.chats[s.activeChatId]
    if (!c) return null
    return {
      chatId: c.chatId,
      sessionId: c.sessionId,
      status: c.status,
      closed: !!c.closed,
      model: c.model,
      permissionMode: c.permissionMode,
      error: c.error,
      pending: c.pending.map((p) => p.toolName),
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        blocks: m.blocks.map((b) => (b.kind === 'tool_use' ? { tool: b.name, status: b.status, result: b.result?.text?.slice(0, 120) } : { [b.kind]: b.text.slice(0, 160) })),
      })),
    }
  })

async function newChat({ cwd = PROJ, model, mode } = {}) {
  await page.keyboard.down('Control')
  await page.keyboard.press('n')
  await page.keyboard.up('Control')
  await page.waitForSelector('.modal', { timeout: 3000 })
  await page.click('.modal .field input', { count: 3 })
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await page.keyboard.type(cwd)
  const selects = await page.$$('.modal .field-grid select')
  if (model) await selects[0].select(model)
  if (mode) await selects[1].select(mode)
  await page.click('.modal-actions .btn.primary')
  await page.waitForSelector('.composer textarea', { timeout: 5000 })
  // wait for the CLI to initialise
  for (let i = 0; i < 60; i++) {
    const c = await activeChat()
    if (c && c.status !== 'starting') break
    await sleep(500)
  }
}

async function send(text) {
  await page.click('.composer textarea')
  await page.type('.composer textarea', text)
  await page.keyboard.press('Enter')
}

/**
 * Wait for the turn to end. onPerm(kind) is called for each permission/question
 * card that appears; it should act on it. Returns the final store snapshot.
 */
async function waitTurn({ onPerm, timeout = 180000, shotPrefix } = {}) {
  const t0 = Date.now()
  let last = ''
  let sawRunning = false
  while (Date.now() - t0 < timeout) {
    await sleep(800)
    const st = await page.evaluate(() => ({
      perm: document.querySelector('.perm.question') ? 'question' : document.querySelector('.perm') ? 'perm' : '',
      working: !!document.querySelector('.working'),
      tools: [...document.querySelectorAll('.tool')].map((e) => `${e.querySelector('.tool-name')?.textContent}:${e.className.replace('tool ', '')}`),
      err: document.querySelector('.error-box')?.textContent ?? '',
      stats: document.querySelector('.turn-stats')?.textContent ?? '',
    }))
    if (st.working) sawRunning = true
    const key = JSON.stringify(st)
    if (key !== last) {
      console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', key)
      last = key
    }
    if (st.perm && onPerm) {
      if (shotPrefix) await shot(`${shotPrefix}-${st.perm}`)
      await onPerm(st.perm)
      await sleep(600)
      continue
    }
    if (sawRunning && !st.working && !st.perm) break
  }
  return activeChat()
}

const allowOnce = async () => page.click('.perm-actions .btn.primary')
const tail = () => page.evaluate(() => document.querySelector('.chat-col')?.innerText.slice(-1500))
const scenario = process.argv[2] ?? 'welcome'

try {
  if (scenario === 'welcome') {
    await sleep(500)
    await shot('welcome')
  }

  if (scenario === 'newchat') {
    await newChat({ mode: 'default' })
    await shot('empty-chat')
    await send('Read hello.py and add a type hint to greet, then run it with python3. Keep your reply short.')
    const c = await waitTurn({ onPerm: allowOnce, shotPrefix: 'newchat' })
    await page.$$eval('.tool-head', (els) => els.forEach((e) => e.click()))
    await sleep(300)
    await shot('newchat-after')
    console.log(JSON.stringify(c, null, 1))
    console.log('--- tail ---\n' + (await tail()))
  }

  if (scenario === 'resume') {
    // open a session by search text (argv[3]) from the sidebar
    const q = process.argv[3] ?? 'agent-monitor-ctest'
    await page.click('.search input', { count: 3 })
    await page.type('.search input', q)
    await sleep(400)
    const rows = await page.$$('.group:not(:has(.group-head.static)) .row')
    console.log('matching rows', rows.length)
    await rows[Number(process.argv[4] ?? 0)].click()
    for (let i = 0; i < 60; i++) {
      const c = await activeChat()
      if (c && c.status !== 'starting') break
      await sleep(500)
    }
    await page.click('.search input', { count: 3 })
    await page.keyboard.press('Backspace')
    await sleep(500)
    await shot('resumed')
    const before = await activeChat()
    console.log('before', before.messages.length, 'messages', JSON.stringify(before.messages.slice(-4)))
    await send('Reply with one word: pong')
    const after = await waitTurn({ onPerm: allowOnce })
    await shot('resumed-after')
    console.log('after', after.messages.length, 'messages', JSON.stringify(after.messages.slice(before.messages.length - 1)))
    const ids = after.messages.map((m) => m.id)
    console.log('duplicate ids:', ids.length - new Set(ids).size)
    const texts = after.messages.map((m) => m.role + JSON.stringify(m.blocks))
    console.log('duplicate contents:', texts.length - new Set(texts).size)
  }

  if (scenario === 'ask') {
    await newChat({ mode: 'default' })
    await send('Use the AskUserQuestion tool to ask me which of red, green or blue I prefer, then reply with my answer.')
    const c = await waitTurn({
      shotPrefix: 'ask',
      onPerm: async (kind) => {
        if (kind !== 'question') return allowOnce()
        const opts = await page.$$('.perm.question .option')
        for (const o of opts) {
          const t = await o.evaluate((e) => e.textContent)
          if (/green/i.test(t)) {
            await o.click()
            break
          }
        }
        await sleep(200)
        await shot('ask-picked')
        await page.click('.perm.question .perm-actions .btn.primary')
      },
    })
    await page.$$eval('.tool-head', (els) => els.forEach((e) => e.click()))
    await sleep(300)
    await shot('ask-after')
    console.log(JSON.stringify(c.messages.slice(-3), null, 1))
  }

  if (scenario === 'deny') {
    await newChat({ mode: 'default' })
    await send('Run `echo hi > hi.txt` with the Bash tool. If I deny a command, follow my feedback and try again.')
    let denied = false
    const c = await waitTurn({
      shotPrefix: 'deny',
      onPerm: async () => {
        if (denied) return allowOnce()
        await page.click('.perm-actions .btn.danger-outline')
        await page.type('.perm-feedback', 'use printf instead')
        await shot('deny-feedback')
        await page.click('.perm-actions .btn.danger')
        denied = true
      },
    })
    await page.$$eval('.tool-head', (els) => els.forEach((e) => e.click()))
    await sleep(300)
    await shot('deny-after')
    console.log(JSON.stringify(c.messages, null, 1))
  }

  if (scenario === 'stop') {
    await newChat({ mode: 'default' })
    await send('Write a 600-word essay about the history of the Unix shell. Do not use any tools.')
    for (let i = 0; i < 60; i++) {
      const len = await page.evaluate(() => document.querySelector('.chat-col')?.innerText.length ?? 0)
      if (len > 600) break
      await sleep(500)
    }
    await shot('stop-mid')
    await page.click('.send.stop')
    console.log('clicked stop')
    for (let i = 0; i < 40; i++) {
      const c = await activeChat()
      if (c.status === 'idle') break
      await sleep(500)
    }
    let c = await activeChat()
    console.log('after stop status', c.status, 'closed', c.closed, 'error', c.error)
    await shot('stop-after')
    await send('Reply with one word: pong')
    c = await waitTurn({})
    console.log('after follow-up', JSON.stringify(c.messages.slice(-3)), c.status, c.error)
    await shot('stop-followup')
  }

  if (scenario === 'switch') {
    await newChat({ mode: 'default', model: 'haiku' })
    await send('Reply with one word: one')
    let c = await waitTurn({})
    console.log('turn1 model', c.model, 'mode', c.permissionMode)
    const selects = await page.$$('.composer select')
    await selects[0].select('sonnet')
    await selects[1].select('acceptEdits')
    await sleep(500)
    await shot('switch-selects')
    await send('Create a file named switched.txt containing the word ok, then reply done.')
    c = await waitTurn({ onPerm: allowOnce, shotPrefix: 'switch' })
    console.log('turn2 model', c.model, 'mode', c.permissionMode, JSON.stringify(c.messages.slice(-2)))
    await shot('switch-after')
  }

  if (scenario === 'fork') {
    const q = process.argv[3] ?? 'agent-monitor-ctest'
    await page.click('.search input', { count: 3 })
    await page.type('.search input', q)
    await sleep(400)
    const rows = await page.$$('.group:not(:has(.group-head.static)) .row')
    await rows[Number(process.argv[4] ?? 0)].click({ button: 'right' })
    await sleep(300)
    await shot('fork-menu')
    const items = await page.$$('.context-menu button')
    if (!items.length) throw new Error('context menu did not open')
    const prevActive = (await activeChat())?.chatId
    for (const it of items) if (/Fork/.test(await it.evaluate((e) => e.textContent))) await it.click()
    for (let i = 0; i < 60; i++) {
      const c = await activeChat()
      if (c && c.chatId !== prevActive) break
      await sleep(250)
    }
    if ((await activeChat())?.chatId === prevActive) throw new Error('fork did not open a new chat')
    for (let i = 0; i < 60; i++) {
      const c = await activeChat()
      if (c && c.status !== 'starting') break
      await sleep(500)
    }
    await page.click('.search input', { count: 3 })
    await page.keyboard.press('Backspace')
    const before = await activeChat()
    await send('Reply with one word: forked')
    const c = await waitTurn({})
    console.log('fork sessionId before', before.sessionId, 'after', c.sessionId, 'msgs', before.messages.length, '->', c.messages.length)
    await shot('fork-after')
  }

  if (scenario === 'rename') {
    const q = process.argv[3]
    await page.click('.search input', { count: 3 })
    await page.type('.search input', q)
    await sleep(400)
    const rows = await page.$$('.group:not(:has(.group-head.static)) .row')
    await rows[0].click({ button: 'right' })
    const items = await page.$$('.context-menu button')
    if (!items.length) throw new Error('context menu did not open')
    for (const it of items) if (/Rename/.test(await it.evaluate((e) => e.textContent))) await it.click()
    await page.waitForSelector('.rename-modal input')
    await page.click('.rename-modal input', { count: 3 })
    await page.type('.rename-modal input', process.argv[4] ?? 'Renamed by driver')
    await shot('rename')
    await page.keyboard.press('Enter')
    await sleep(1500)
    console.log(await page.evaluate(() => [...document.querySelectorAll('.row-title')].map((e) => e.textContent).slice(0, 8)))
  }

  if (scenario === 'state') {
    console.log(JSON.stringify(await activeChat(), null, 1))
  }

  if (scenario === 'prompt') {
    // node scripts/ui-driver.mjs prompt <model> <text>
    await newChat({ mode: 'default', model: process.argv[3] })
    await send(process.argv[4])
    const c = await waitTurn({ onPerm: allowOnce, shotPrefix: 'prompt' })
    await shot('prompt-after')
    console.log(JSON.stringify(c, null, 1))
  }

  if (scenario === 'eval') {
    console.log(await page.evaluate(process.argv[3]))
  }

  if (scenario === 'shot') {
    await shot(process.argv[3] ?? 'shot')
  }
} finally {
  console.log(problems.length ? `PROBLEMS: ${problems.length}` : 'no console errors')
  browser.disconnect()
}
