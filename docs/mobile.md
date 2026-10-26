# Phone companion (design)

An Android client for the desktop app. The user reaches the PC over Tailscale. Tailscale runs on another device on the
home network and routes to the PC's LAN address (192.168.1.7), so the server listens on the LAN with token auth.
Remote Control (claude.ai) is not involved.

## Shape

- The desktop main process runs a `MobileServer` (`src/main/mobile.ts`). It is an HTTP server for the phone UI
  (`out/renderer/mobile.html` + shared chunks) plus a WebSocket at `/ws`. The socket carries the same calls and events
  as Electron IPC: the phone is just another client of the main process.
- The phone UI is the same React renderer built from a second entry (`src/renderer/mobile.html`). It installs a
  WebSocket-backed `window.desktop` (`src/renderer/src/mobile/shim.ts`) before the app module loads.
- The APK (`android/`) is a plain Java WebView shell (no Capacitor, no AndroidX). It loads the UI from the desktop's
  URL (default `http://192.168.1.7:47615/`, editable on a load error or via the "Server address" launcher shortcut) and
  pairs once like the browser does (the token lives in the WebView's localStorage). Build: `scripts/build-apk.sh` →
  `~/Downloads/hearth.apk` (debug-signed with `~/.android/debug.keystore`; updates must use the same key).
  A foreground service for notifications is a later step.

## Channels

`src/shared/channels.ts` is the single table of `DesktopApi` methods. Each entry is `{ channel, kind: 'invoke' | 'send' }`;
each event entry is `{ channel }`. The preload and the phone shim are both generated from it. In main, `src/main/ipc.ts`
registers each handler once through `handle(channel, (ctx, ...args) => …)` / `on(channel, (ctx, ...args) => …)`.
`ctx = { client }`, where `client` is `'desktop'` for Electron IPC and `'phone:<deviceId>'` for the socket. The
WebSocket dispatches into the same map. Phone calls are limited to an allowlist (`PHONE_CHANNELS`). They cannot use
window actions, the folder picker, the theme, open-in-editor/terminal/openPath, the PTY channels or `app:notify`.

`emit(channel, payload)` goes to the window and to every authenticated socket. The exception is `pty:data` /
`pty:exit`, which stay on the desktop.

## Shared runners (both clients on one chat)

Chat ids are still minted by the client that starts a chat. The main process keeps track of who uses each runner:

- `RunnerRegistry` records, per runner: `holders: Set<client>`, `sessionId` (from `opts.sessionId ?? opts.resume ?? chatId`,
  then updated from the `session_id` of SDK messages, which covers forks), `cwd`, `status`
  (`starting|idle|running|compacting`, from the SDK `system/status` messages, user sends and `result`), the permission
  requests still pending (full `PermissionRequest` payloads), and the last model / permission mode set.
- `chat:start` (ctx) adds the caller as a holder. `chat:attach(chatId)` adds the caller and returns
  `{ chatId, gen, sessionId, cwd, status, pending, model?, permissionMode? }`, or `null` if no runner exists.
  `chat:live()` lists the same summary for every runner, without `pending` and with `pendingCount`.
  `chat:close(chatId)` (ctx) removes the caller. The runner is closed only when no holder is left.
- `chat:send` from any client emits `chat:remoteMessage { chatId, uuid, text, images?, origin }`. Every client appends
  the message unless one with that uuid already exists. `chat:respond` emits `permission:cancel` for that request to
  everyone. `chat:setModel` / `chat:setPermissionMode` emit `remote:setting`.
- Reaper: a runner whose only holders are phones is closed after 30 min idle (status idle, nothing pending).
- `chat:liveChanged` is emitted (debounced 300 ms) whenever the live list changes, so the phone sidebar can show busy
  and ask dots for chats it has not attached.

Renderer:

- `openSession` first calls `chat:live`. If a runner exists for that session id, the client attaches to it: it creates
  the chat under the runner's `chatId`, loads the transcript, sets `gen`, `status`, `pending`, model and mode, and does
  not start a runner. This also fixes desktop reloads, which used to start a second CLI process for every restored tab.
- Desktop only: an `agent:event` or `chat:remoteMessage` for an unknown chatId whose runner is live makes the desktop
  attach in the background, once per chatId. The desktop sidebar, notifications and lifetime therefore cover chats
  started from the phone.
- Phone: when the socket reconnects, every open chat is attached again and its transcript reloaded. Chats whose runner
  is gone are marked closed; sending to them resumes the session, as today.
- Phone does not run keep-warm, Remote Control toggles, terminals, the changes panel or desktop notifications.

## Security

- Off by default. "Phone access" lives in the gear menu. The setting is in `<userData>/mobile.json`:
  `{ enabled, port (default 47615), devices: [{ id, name, tokenHash (sha256), createdAt, lastSeen }] }`.
- It binds `0.0.0.0` but refuses any peer that is not loopback, RFC 1918 or 100.64/10.
- Pairing: "Pair phone" creates a one-time code (5 minutes). It is shown as a QR code for
  `http://<lan-ip>:<port>/#pair=<code>`, with the URL and code also as text. The phone sends `{ type: 'pair', code, name }`
  and gets `{ deviceId, token }` (32 random bytes, base64url), which it keeps in localStorage. Each later connection
  starts with `{ type: 'auth', token }`, and nothing else is handled before it succeeds. Devices can be revoked, which
  closes their sockets.
- Static files are served without auth: they are the open-source UI and hold no data.

## Wire format

Client → server: `{ id, type: 'invoke', channel, args }`, `{ type: 'send', channel, args }`.
Server → client: `{ id, type: 'result', ok, value | error }`, `{ type: 'event', channel, payload }`.
