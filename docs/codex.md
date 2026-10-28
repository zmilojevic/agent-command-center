# Codex engine

Hearth can run a chat on OpenAI Codex instead of Claude Code. Codex is a fully separate engine: it uses only Codex's own
login (`~/.codex/auth.json`), global config (`~/.codex/config.toml`) and project config (`AGENTS.md`, `.codex/`). Hearth never
reads or imports any Claude Code state for a Codex chat (no `CLAUDE.md`, `.claude/agents`, Claude settings or transcripts) and never
calls the app-server's `externalAgentConfig/*` (its "import from Claude" feature).

## Backend: `codex app-server`

`codex app-server` is a JSON-RPC 2.0 protocol over stdio (one JSON object per line) or a WebSocket (daemon) (the protocol Codex's IDE extensions use). Bindings:
`codex app-server generate-ts --out <dir>` (v2 types under `<dir>/v2`). Hearth does not vendor the bindings; `src/main/codex/protocol.ts`
holds hand-written minimal types for the parts it uses.

- `src/main/codex/appServer.ts` `CodexServer`: one shared app-server connection (lazy, re-established on next use after a disconnect).
  Transports, in order: (1) the user's shared Codex daemon (`codex app-server --listen unix:// --managed-daemon`, started by the terminal
  app) over its control socket `$CODEX_HOME|~/.codex/app-server-control/app-server-control.sock` (a symlink into `/tmp/codex-daemon-<uid>/`):
  `ws` WebSocket with `createConnection: () => net.connect(realpathSync(sock))` (`socketPath` does not work), one JSON object per text frame,
  no `jsonrpc` field, same messages as stdio; (2) if the socket is missing or refuses: `codex app-server daemon start` (execFile, 20 s) and
  one more connect; (3) fallback: a private stdio `codex app-server` child. The transport in use is logged (`codex: transport = …`,
  `server.transport`); `CCD_CODEX_TRANSPORT=stdio` forces (3); Windows always uses stdio. Why the daemon: it keeps threads the terminal
  touched loaded and holds their writer lock (`~/.codex/thread-writer-locks/<id>`) even after the terminal exits, so a private server's
  `thread/resume` fails with "already has an active writer"; on the daemon, resuming an already-loaded thread rejoins it.
  Hearth never stops or restarts the daemon: the idle timeout (10 min) and `stop()` only close Hearth's WebSocket (a private child is killed).
  A disconnect (daemon restarted/updated, child exit) fails in-flight requests and calls every runner's `onExit`; the next use reconnects.
  Handshake `initialize {clientInfo:{name:'hearth',title:'Hearth',version}}` then the `initialized`
  notification. `request(method, params)` → Promise (60 s timeout), notifications and server→client requests are routed by
  `params.threadId` to the subscribed `CodexRunner`; thread-less ones (`account/*`) go to global listeners. stderr of a stdio child → log.
  `unsubscribe(threadId, sub)` drops the local subscription and sends `thread/unsubscribe {threadId}` (releases only Hearth's subscription;
  nothing is archived or deleted); a closing runner interrupts a running turn first. Because the server is shared, a thread can also get
  `turn/started` turns started by the terminal (the runner just goes running → idle) and approval requests another client answers
  (`serverRequest/resolved` cancels Hearth's card).
  Binary: `codex` on PATH (+ `~/.local/bin`, `/usr/bin`, `/usr/local/bin`, `~/.npm-global/bin`); missing = Codex unavailable.
- `src/main/codex/runner.ts` `CodexRunner`: the same public surface as `ChatRunner` (summary, attachInfo, pendingRequests, start,
  send, respond, interrupt, setModel, setEffort, setPermissionMode, listModels, emitContext, close, done, holders, …; methods that
  have no Codex equivalent return empty/false). `RunnerRegistry` creates it when `StartChatOptions.engine === 'codex'`.
  start: `thread/resume {threadId}` (resume), `thread/fork` (fork) or `thread/start {cwd, model?, …mode}`; the thread id is the
  session id. send: `turn/start {threadId, input:[{type:'text',text,text_elements:[]}, {type:'localImage',path}…], clientUserMessageId: uuid}`
  (images are written to a temp file first); while a turn runs, `turn/steer` instead. interrupt: `turn/interrupt`. Model/effort changes
  are passed on the next `turn/start` (`model`, `effort`).
- `src/main/codex/translate.ts` (pure): Codex items → SDK-shaped messages, so the renderer's reducer, ToolCards and PermissionCard work
  unchanged. Used both live (runner) and for stored threads (`sessions:messages` → `thread/read` with turns → `TranscriptMessage[]`).

| Codex | emitted as |
|---|---|
| thread ready | `system/init {session_id: threadId, model, cwd}` |
| `agentMessage` started/delta/completed | `stream_event` message_start (id = itemId) / content_block_start text / text_delta; `assistant` with the final text |
| `reasoning` summary deltas | same, thinking block |
| `commandExecution` | `assistant` tool_use `Bash {command}` (id = itemId); on completion `user` tool_result (aggregatedOutput, `is_error` when exitCode ≠ 0) |
| `fileChange` | tool_use `ApplyPatch {changes:[{path,kind,diff}]}` + tool_result |
| `mcpToolCall` | tool_use `mcp__<server>__<tool>` + tool_result |
| `webSearch` | tool_use `WebSearch {query}` |
| `turn/plan/updated` | tool_use `TodoWrite {todos:[{content,status}]}` (one per turn, updated in place) |
| `userMessage` | live: skipped (renderer already shows it); transcript: `user` line, uuid = clientId ?? id |
| `turn/completed` | `result` (duration, usage from the last `thread/tokenUsage/updated`, `total_cost_usd` 0, error subtype when failed) |
| `thread/tokenUsage/updated` | kept for `emitContext` (`chat:context`: last input total vs `modelContextWindow`) |

Approvals: `item/commandExecution/requestApproval` → `permission:request` toolName `Bash` (input `{command, cwd}`, `decisionReason` = reason),
`item/fileChange/requestApproval` → toolName `ApplyPatch` (changes from the item). `canRemember: true`. allow → `accept` (`acceptForSession`
when remember), deny → `decline` (`cancel` when interrupt). `serverRequest/resolved` cancels a pending card. In `full-access` any approval request that still arrives (turn started under another mode) is accepted for the session automatically, and switching to `full-access` accepts the pending ones.

## Modes

Codex chats have their own mode list (`StartChatOptions.codexMode`): `config` (default: pass no approval/sandbox overrides, so
`~/.codex/config.toml` and the project's `.codex/config.toml` decide), `read-only` (read-only + on-request), `auto` (workspace-write +
on-request), `full-access` (danger-full-access + never). Changing it applies to the next turn (`turn/start` `approvalPolicy`/`sandboxPolicy`).

## Setup from scratch

- `codex:status` → `{installed, version?, loggedIn, account?}` (`account/read`). Not installed → the Codex choice is hidden.
- Not logged in → "Log in to Codex" dialog = the existing `LoginDialog` on a hidden pty running `codex login`.
- Project without `AGENTS.md` (at `projectRoot(cwd)`): an empty Codex chat shows "This project has no AGENTS.md – Initialize" which sends
  Hearth's init prompt (asks Codex to inspect the repo and write `AGENTS.md`). Otherwise whatever the project has is used.

## Sessions

`sessions:list` appends Codex threads (`thread/list`, newest 300 by `updated_at`, source kinds cli/vscode/appServer; `src/main/codex/sessions.ts`) as
`SessionSummary` (the renderer's session row type) with `engine:'codex'` (summary = name ?? preview, cwd, created/updated, branch). Cached 3 s, invalidated by the
rollout watcher; any failure = no Codex rows (never breaks the Claude list); the phone lists, opens and starts them too (full Codex support except `codex login`, which is desktop-only: the phone shows a "log in on the desktop" card). `sessions:rename` → `thread/name/set`,
`sessions:delete` / `deleteProject` → `thread/delete`, `sessions:messages` → `thread/read` with turns → `threadToTranscript`, `sessions:meta` → model/effort from
the listed thread (no cache TTL). Codex threads started in the Codex TUI show up too. A chokidar watcher on `~/.codex/sessions` (depth 4) emits `sessions:changed`.

Routing of session ids: `sessions:messages|meta|rename|delete` take an optional trailing `engine` argument (`'codex'` forces Codex). When omitted, main decides by a
set of known Codex thread ids (filled by `sessions:list` and by every started/resumed `CodexRunner`); the renderer should pass `engine` explicitly once it knows it.

Account IPC: `codex:status` (`account/read` + `codex --version`), `codex:login` (hidden pty `codex login`, PHONE_BLOCKED), `codex:usage` (`account/rateLimits/read`:
primary window = row kind `session`, secondary = `weekly_all`, other buckets = `weekly_scoped`; sparse `account/rateLimits/updated` is merged and pushed as
`codex:usageChanged`), `codex:models` (`model/list`, hidden models dropped; efforts are Codex's own strings, which include `ultra`, beyond `EffortLevel`),
`codex:hasAgentsMd(cwd)`.

## Implementation notes (phase 1)

- Framing: lines of JSON without a `jsonrpc` field in both directions; `initialize {clientInfo, capabilities:{experimentalApi:false, requestAttestation:false}}` then
  `{"method":"initialized"}`. The server also pushes thread-less notifications (`remoteControl/status/changed`, `account/updated`), which go to global listeners.
- `Runner` interface (`src/main/runnerTypes.ts`) is implemented by `ChatRunner` and `CodexRunner`; `RunnerRegistry` holds `Runner`s, `getClaude()`/`any()` return
  Claude runners only (Remote Control, plan usage and the Claude model list never use a Codex runner). `LiveChat`/`attachInfo` carry `engine` and `codexMode`.
- Codex item ids are the message ids, one SDK message per item (a turn = several assistant messages). Stream events also carry `api_message_id`.
- Approvals: only command and file-change approvals are handled; `item/permissions/*`, `item/tool/requestUserInput`, MCP elicitations and the legacy
  `applyPatchApproval`/`execCommandApproval` requests get a JSON-RPC error reply. Request ids are exposed as `codex-<rpcId>`.
- Mode: `config` sends no overrides, so switching from another mode back to `config` cannot unset what was already sent to the thread; it applies again after a resume.
  `setPermissionMode` (`chat:setPermissionMode`) takes the `CodexMode` string for Codex chats.
- Result usage is the last token-usage report's `last` breakdown (fresh input = input - cached - cache write); `chat:context` percentage = last total / model context window.
- Closing a runner interrupts a running turn but does not send `thread/unsubscribe` (it could race with a restart resuming the same thread); the shared server is
  stopped after 10 min with no runners and on quit.
- Smoke test: `node scripts/codex-smoke.mjs` (bundles the real runner with vite, one tiny turn on an ephemeral read-only thread in a scratch dir).

## Renderer

- Store (`store.ts`): `Chat.engine` (`'claude'` default) and `Chat.codexMode`; `engine` comes from `SessionSummary.engine` on open/resume/fork (and from `LiveChat.engine` on attach),
  and goes into `StartChatOptions` (`engine`, `codexMode`). `getMessages/getSessionMeta/renameSession/deleteSession` always pass `engine`. `openTabs` keeps only session ids:
  the engine is derived from the sessions list on restore. A new Codex chat has `sessionId` undefined until the runner's `system/init` reports the thread id (reducer sets it),
  so the sidebar row, `openTabs` and keep-warm all use the real id. `/clear` on a Codex chat: close runner, hide the old thread id (`hiddenSessions`), start a fresh thread in the
  same slot; the sort slot is applied to the new id when its init arrives (`codexSortSlot`).
- Gating: `codexStatus` (`codex:status`, checked at startup, when a Codex chat starts and after `codex login`); every Codex option (dialog toggle, project engine, "New Codex chat",
  etc.) is hidden unless `installed`. General chats, tray and Ctrl+N stay Claude-only; the phone has full Codex support except `codex login` (desktop only, the phone shows a "log in on the desktop" card). Skipped for Codex chats: keep-warm tick, Remote Control, cold-cache confirm,
  MCP popover, `@` agents/files, slash picker, plan mode (Alt+M), Ctrl+B, tasks strip, Compact button, per-turn cost.
- Prefs: `lastCodexModel`, `lastCodexEffort`, `lastCodexMode` (never read at startup: Codex chats always start in `full-access`, like Claude's bypass; separate from the Claude ones); `projectDefaults[root].engine` (absent = claude; its model/effort belong to that engine, and
  `modelFor/effortFor(cwd, engine)` ignore a default made for the other engine). `newChat` without an explicit engine uses `engineFor(cwd)`, so the project "+" and the empty-project
  button follow the project default; the project menu offers the other engine ("New Codex chat" / "New Claude chat").
- Composer for Codex: model Dropdown from the chat's `listModels` (falls back to the store's `codexModels`, `codex:models`), effort levels from the model's own list (`ultra` included;
  "default" resolves to the model reported by init), mode Dropdown = `CODEX_MODES` via `setPermissionMode`. The eraser, Ctrl+K/L/Alt+Delete and typed `/clear` still work.
- Sidebar: muted "codex" chip instead of the cache pill; context % chip only when meta/live context has it; no Keep warm / Remote control in the row menu; Fork works (thread/fork).
- TopBar: the Claude UsageMeter is always shown; a second one for `codexUsage` (`codex:usage`, pushed by `codex:usageChanged`) sits next to it whenever Codex is installed and logged in, both with engine labels. Main refreshes it on rollout activity (>= 2 min apart), hourly, with a 10 min back-off after errors. ContextMeter works from `chat:context`.
- `ApplyPatch` tool card and permission card render `PatchView` (`components/PatchView.tsx`): per file a `--hl-path` header (click = open in editor) and the diff via
  `parseUnifiedDiff` / `highlightRows` (content without hunks is shown as all added / removed). Bash, WebSearch, TodoWrite and `mcp__*` cards work unchanged.
- Setup: `CodexLoginCard` (ChatView, when `codexStatus.loggedIn === false`, set at start or by a Codex turn failing with an auth-looking error) opens `LoginDialog provider="codex"`
  (store `loginProvider`; re-checks `codex:status` on pty exit); `AgentsMdCard` (above the composer of an empty project Codex chat, `codex:hasAgentsMd`) with an "Initialize" button.
  Styles: `styles/codex.css`.
