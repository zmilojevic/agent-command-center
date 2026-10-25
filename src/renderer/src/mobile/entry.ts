// Phone entry: pair or authenticate, install the WebSocket-backed window.desktop, and only then load the app.
import { connect, installDesktop, pair } from './shim'

// crypto.randomUUID is secure-context only; the page is served over plain http on the LAN.
if (typeof crypto.randomUUID !== 'function') {
  ;(crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}

const KEY = 'ccd.mobile.token'

function defaultName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  return 'Phone'
}

function pairingScreen(): Promise<string> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1b1a17;color:#ecebe5;font-family:Inter,system-ui,-apple-system,Roboto,sans-serif;padding:16px;box-sizing:border-box'
    const input = 'width:100%;box-sizing:border-box;border:1px solid #45433d;border-radius:8px;padding:10px 12px;background:#1b1a17;color:#ecebe5;font-size:16px;outline:none'
    root.innerHTML = `
      <form style="width:100%;max-width:360px;background:#262521;border:1px solid #343330;border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:14px">
        <div style="font-size:17px;font-weight:600">Pair with desktop</div>
        <div style="font-size:13px;color:#bdbab0;line-height:1.5">Open Phone access in the desktop app's settings, choose Pair phone and enter the code shown there.</div>
        <label style="font-size:13px;color:#bdbab0;display:flex;flex-direction:column;gap:6px">Code
          <input id="p-code" autocomplete="off" autocapitalize="characters" spellcheck="false" style="${input};font-family:ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase" />
        </label>
        <label style="font-size:13px;color:#bdbab0;display:flex;flex-direction:column;gap:6px">Device name
          <input id="p-name" autocomplete="off" maxlength="40" style="${input}" />
        </label>
        <div id="p-err" style="font-size:13px;color:#e2896c;min-height:18px"></div>
        <button id="p-go" type="submit" style="border:1px solid #d97757;background:#d97757;color:#1b1a17;border-radius:8px;padding:10px;font-size:15px;font-weight:600">Pair</button>
      </form>`
    document.body.appendChild(root)
    const code = root.querySelector<HTMLInputElement>('#p-code')!
    const name = root.querySelector<HTMLInputElement>('#p-name')!
    const err = root.querySelector<HTMLElement>('#p-err')!
    const go = root.querySelector<HTMLButtonElement>('#p-go')!
    code.value = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair') ?? ''
    name.value = defaultName()
    root.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault()
      err.textContent = ''
      go.disabled = true
      try {
        const token = await pair(code.value.trim(), name.value.trim() || defaultName())
        root.remove()
        resolve(token)
      } catch (ex) {
        err.textContent = ex instanceof Error ? ex.message : String(ex)
        go.disabled = false
      }
    })
  })
}

async function main(): Promise<void> {
  let token = localStorage.getItem(KEY)
  let hello: { platform: string; deviceId: string } | null = null
  while (!hello) {
    if (!token) {
      token = await pairingScreen()
      localStorage.setItem(KEY, token)
      history.replaceState(null, '', location.pathname + location.search)
    }
    try {
      hello = await connect(token)
    } catch (e) {
      if ((e as { code?: number }).code !== 4401) throw e
      localStorage.removeItem(KEY)
      token = null
    }
  }
  installDesktop(hello.platform)
  await import('../main')
}

void main()
