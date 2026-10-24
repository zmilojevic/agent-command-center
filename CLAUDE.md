# Agent Command Center

Desktop GUI for Claude Code sessions, modelled on the Claude Code tab of Anthropic's Claude desktop app.
Electron 45 + electron-vite + React 19 + TypeScript (ESM throughout), pnpm. Backend is the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`, native linux-x64 binary), so it uses the user's existing Claude Code
subscription login and settings; there is no API key anywhere.

History: started 2026-10-24 as `~/src/claude-code-desktop`, renamed and moved to `~/dev/agent-command-center`
the same day. It replaced the idea of tweaking the GTK `claude-session-manager` (upstream clone still at
`~/src/claude-session-manager`, unused).

## Models for work on this project

- All thinking (investigation, design, planning, review, verifying results) is done by the main session on
  Opus 5.5 at high effort; `.claude/settings.json` pins `model: claude-opus-5-5`, `effortLevel: high`.
- All implementation (code edits) is delegated to the `implementer` subagent (`.claude/agents/implementer.md`:
  Sonnet, medium effort) with a concrete brief: files, intended change, acceptance checks. The main session
  then reviews the diff and runs any UI checks itself.

## Run, build, install

- `pnpm dev` – electron-vite dev server with HMR.
- `pnpm typecheck && pnpm build` – must be clean before handing anything back; `out/` is what the launcher runs,
  so rebuild after every change. A running instance keeps the old renderer until restarted; a Ctrl+R reload
  only swaps the renderer, not the main process.
- Launcher: `~/.local/bin/agent-command-center` (execs `node_modules/.bin/electron <repo>`); menu entry
  `~/.local/share/applications/agent-command-center.desktop` (StartupWMClass `agent-command-center`, icon
  `resources/icon.svg`). Window class and `package.json` name are `agent-command-center`.
- pnpm 12 blocks build scripts by default; `package.json` `pnpm.onlyBuiltDependencies` allows electron/esbuild.
- Never `git commit` or push unless the user asks. Remote `origin` = `git@github.com:zmilojevic/agent-command-center.git`
  (public), branch `main`.

## Layout

- `src/main/index.ts` – BrowserWindow (frameless; renderer draws the title bar; Wayland switches
  `ozone-platform-hint=auto`, `disable-renderer-backgrounding`, `backgroundThrottling:false`), all IPC handlers,
  chokidar watcher on `~/.claude/projects` (file and dir add/change/unlink → `sessions:changed`),
  native notifications (`app:notify` → click sends `notification:click`), `window:action`
  (minimize/maximize/close/reload/devtools).
- `src/main/agent.ts` – `ChatRunner`: one SDK `query()` per open chat in **streaming-input mode** (prompt is a
  `PushQueue` async iterable, so the CLI process lives across turns). Options: cwd, permissionMode
  (+ `allowDangerouslySkipPermissions` when bypass), `includePartialMessages`, `systemPrompt` preset
  `claude_code`, `canUseTool` bridged over IPC, `resume`/`forkSession`, `sessionId` for new chats
  (`opts.sessionId ?? chatId`), `--thinking-display summarized`. Every SDKMessage is forwarded raw as
  `agent:event {chatId, message}`. Each runner has a generation number returned by `chat:start` and stamped on
  its events; a deliberate close emits no `chat:exit` (fixes the "Session process ended" race). After each
  `result` it calls `getContextUsage()` → `chat:context`. `supportedModels()` → `chat:models` (with per-model effort levels), `setEffort` → `applyFlagSettings({effortLevel})`
  (session-only, `null` = model default; start option `effort`, last pick remembered as `lastEffort`),
  `supportedCommands()` → `chat:commands`, `supportedAgents()` → `chat:agents`. `warmCache()` (`chat:warm`) → undocumented `askSideQuestion` (SDK `/btw`): reuses the main cache prefix, writes nothing to the transcript; false if the method is missing or it throws (90 s timeout).
- General chats (claude.ai style, no project): an ordinary SDK session whose cwd is `CHATS_DIR`
  (`src/main/paths.ts` = `~/.local/share/agent-command-center/chats`, created at startup, exposed as `chatsDir()` / `app:chatsDir`).
  Identity is purely `cwd === chatsDir`, so listing/resume/rename/delete/keep-warm/`/clear` work unchanged. `ChatRunner.start()` then
  passes `tools: ['WebSearch','WebFetch']`, `strictMcpConfig`, `settingSources: ['user']` and a custom system prompt
  (`chatSystemPrompt()`: general assistant, web tools, today's date) instead of the `claude_code` preset. Renderer: store `generalDir`
  + `isGeneral(cwd)` + `newGeneralChat()` (uses `lastModel`/`lastEffort`/`lastMode`, never touches `lastCwd`); general chats skip the
  changes panel/git refresh, the composer hides the permission dropdown, `@` agents and the eraser, ChatView shows a "How can I help
  you today?" greeting (centred with the composer via `.chat-pane.fresh` until the first message) and no per-turn stats, the TopBar shows a
  "Chat" label instead of folder/branch. The `WebSearch` ToolCard body renders its `Links: [{title,url}]` JSON as a source list.
- `src/main/sessionMeta.ts` – reads the tail (512 KB) of a transcript `~/.claude/projects/<cwd with
  non-alphanumerics → '-'>/<id>.jsonl` and derives model, effort, context tokens
  (input + cache_read + cache_creation of the last assistant line), last timestamp, and the cache TTL from the
  most recent turn that *wrote* cache entries (`cache_creation.ephemeral_1h_input_tokens` → 1 h, else 5 m;
  default 1 h). Cached by mtime.
- `src/main/git.ts` – `gitChanges(cwd)` (`git:changes`): uncommitted changes of the repo containing cwd = `git diff HEAD`
  (empty tree when there are no commits) split per file + untracked files via `git diff --no-index /dev/null`
  (≤ 200, > 1 MB shown as binary), diff text capped at 4 MB (`truncated`). Never through a shell.
- `src/main/usage.ts` – `UsageService`: plan rate limits via the SDK's
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` on any live runner, else on a
  temporary idle `query()` (cwd home, `persistSession:false`; ~0.5 s, no tokens, no transcript). Normalizes the
  server's `rate_limits.limits[]` rows (fallback: `five_hour`/`seven_day`/`model_scoped`) into `PlanUsage`; polls every
  5 min and after chat results (≤ 1 per 30 s), pushes `usage:changed`; `usage:get` returns the cache.
- `src/preload/index.ts` – exposes `window.desktop` typed as `DesktopApi` in `src/shared/types.ts`.
- `src/renderer/src/reduce.ts` – pure reducer: stream deltas, assistant frames (one block per frame when
  streaming; `finalized` index maps frames to streamed blocks), user tool_result frames, result, system
  init/status/compact_boundary/permission_denied, task/subagent messages, stored transcripts
  (`applyTranscript`, merges consecutive assistant lines with the same message id). Hides user text starting
  with `<command-name>`, `<system-reminder>`, `<local-command-stdout>`… Local slash-command output renders
  as a muted block; the post-`/compact` summary as a collapsed card.
- `src/renderer/src/store.ts` – zustand + immer. Sessions list, `meta` per session, open chats keyed by
  chatId (sessionId inside), `tabs` (internal order only, no UI strip), pending permissions, drafts,
  attachments, queue, subagents, prefs in localStorage (`lastModel`, `pinnedProjects`, `projectOrder`, `projectNames`,
  `collapsedProjects`, `keepWarm` (session ids), `warmedAt` (session id → start of last keep-alive request), `hiddenSessions`, `sessionSortTime`, `openTabs`, `recentHours`, `sidebarWidth`, notifications, `theme`). `lastMode` is always
  `bypassPermissions` on start (user wants every session to run with permissions skipped; the picker can
  still change one session). `restoreTabs()` reopens saved sessions on startup. `clearChat` = `/clear`:
  closes the runner and starts a fresh session (new
  session id, as the CLI does too) in the same tab/folder. The old id goes into `hiddenSessions` (transcript kept on
  disk, never listed in the sidebar) and the new id gets `sessionSortTime[newId]` = the old row's sort time, so the row
  keeps its slot and looks cleared in place (chains work). Both prefs are pruned in `loadSessions` against disk.
- `src/renderer/src/components/` – `UsageMeter` (top bar, left: "5h N% · time to reset", hover = all session/weekly rows), `Sidebar` (projects, rows, drag-reorder, context menus, subagent list,
  time-window Dropdown in the header, Add project footer), `TopBar` (folder/branch, `ContextMeter`,
  `SettingsPopover` (theme Dropdown + notifications switch), window controls; exports `dotState`), `ChatView`, `FindBar`, `MessageItem`,
  `ToolCard`, `DiffView`, `ChangesPanel` + `UnifiedDiff` (right-hand git changes panel with line comments), `PermissionCard`, `QuestionCard`, `Markdown` (react-markdown + gfm +
  rehype-highlight), `Composer` (slash picker, attachments, queue, model/effort/mode Dropdowns, eraser = `/clear`),
  `NewSessionDialog`, `Welcome`, `Dropdown` (custom; **never use native `<select>`**), `ErrorBoundary`,
  `ImageThumb`.
- `src/renderer/src/theme.ts` – `initTheme()` (called in `main.tsx` before render) resolves the `theme` pref
  (`system` | `light` | `dark`) and stamps `<html data-theme="light|dark">`; all palette CSS keys off that attribute
  (no `prefers-color-scheme` queries in `styles.css`). It also sends `app:theme` so main sets
  `nativeTheme.themeSource` and the window `backgroundColor`; with `system` the OS media query drives it.
- `src/renderer/src/images.ts`, `hooks.ts`, `util.ts` (`modelLabel`, `relativeTime`, `defaultContextWindow`:
  1M for the Claude 5 family, 200k otherwise, until the CLI reports the real window).
- `scripts/dev-launch.sh [prod|dev|stop]` and `scripts/ui-driver.mjs <scenario>` (puppeteer-core on port 9333).
- `CCD_LOG_EVENTS=1` logs raw SDK messages to stderr; `window.__ccd.getState()` exposes the store in DevTools.

## SDK facts learned the hard way

- `listSessions()` with no `dir` spans all projects (fast, ~30 ms for 450 sessions); `getSessionMessages`
  needs `dir: cwd`. Sessions without a cwd are filtered out.
- In streaming-input mode the `system init` message only arrives at the start of the first turn, so a resumed
  chat is marked idle as soon as the runner is up; model/version fill in later.
- `permissionMode` from user settings is `bypassPermissions`; the app always passes the mode explicitly.
  With bypass, `canUseTool` is never called for tools (SDK warns), but `AskUserQuestion` still comes through.
- `AskUserQuestion` is answered via `canUseTool` → `{behavior:'allow', updatedInput:{questions, answers}}`,
  answers keyed by question text, multi-select joined with ", ".
- `total_cost_usd` on `result` is cumulative for the session; per-turn cost is the difference.
- Transcript assistant lines carry `effort`, `perTurnEffort`, `requestedModel`, `gitBranch`, `timestamp`,
  `message.usage`.
- `askSideQuestion` side questions keep the main prompt cache warm (verified: after 9 min with a 5 m TTL the warmed session read the full 21.6k prefix from cache, the control rewrote ~15k). They emit only `control_request_progress` / `rate_limit_event` stream events (ignored by the reducer) and no transcript lines.
- Slash commands typed by the user go to the CLI unchanged as the user message; `/cost` → `/usage` alias etc.
  Their output is not stored in the transcript.

## UI conventions the user has asked for

- Themes: System (default) / Light / Dark from the gear menu. Sidebar chip text lightness comes from `--chip-l`
  (60 % dark, 42 % light) so the hue-coded cache/context chips stay readable on both.
- Muted everything: no bright colors, soft borders, rounded pills. Accent `--accent` (#d97757 dark /
  #c9663f light) only for the busy dot, send button and small marks; focus borders use `--accent-muted`.
  Chat and session-title text use `--text-2`, not the brightest tone.
- Chat colors are subtle, low-saturation `--hl-*` vars per theme (own hljs palette for both themes, no highlight.js
  theme CSS): inline code `--hl-code` (warm), inline code that `looksLikePath` (`util.ts`) and Read/Write/Edit/WebFetch
  tool headers `--hl-path` (dusty blue), Glob/Grep patterns `--hl-string`, Bash command `--hl-code`; bold/headings `--text`.
- Sidebar (always shown: no hide button or shortcut, by user request; 390 px default; drag its right edge to resize 320–640 px, `sidebarWidth` pref, double-click = 390): header = time-window Dropdown (default last 14 h; search ignores the window) +
  collapse/expand-all button. No logo, no "New chat" button at the top, no chat counts (except a muted "(N)" after a collapsed project's name = its listed chats), no "Open"
  section, no tab strip anywhere. Projects: order is frozen (every project's slot is saved in `projectOrder` the first time it shows up, new ones go on top once; activity never reorders), drag to reorder (saved; pinned projects always come first in their own dragged order, drags only reorder within the pinned or the unpinned section, a new pin goes to the bottom of the pinned section, unpinning puts the project at the top of the rest), "Rename project…" via context menu (display name only: `projectNames` pref, cwd → name, empty or the folder name = reset; the folder on disk is never renamed, identity stays the cwd; shown in sidebar, top bar, Welcome, new-session dialog, matched by search; dropped on Remove project), pin/unpin via context menu (pinned
  projects stay listed without recent chats), new-chat icon always visible on the header, collapsed headers
  show a busy/unread dot, faint gradient hairlines between projects (stronger) and chats (fainter),
  "Add project" button in the footer. Chat rows are indented 10 px, title 15 px, two lines: title + time
  (time = last response finished, hidden while working) and chips: context-used % (green→orange-red as it
  fills), cache pill ("cache · 35m left" / "cache cold", hue from orange-red at 0 % to green at ≥80 % of TTL
  left, very low saturation, no fill), model·effort grey chip, branch on the right. Dots: orange pulsing =
  working, green = finished and not yet seen (seen = active chat + focused window), nothing when idle, with an
  invisible spacer so titles don't jump. Chats sorted by creation time (newest first); a `/clear` clears the row in
  place: new session id under the hood, old transcript hidden from the sidebar but kept on disk, row keeps its slot via
  `sessionSortTime`. Collapsed state, open chats and active chat are remembered.
  Deleting a transcript asks no confirmation. "Remove project…" (project context menu) confirms with a dialog,
  then closes its chats, deletes all its transcripts (`sessions:deleteProject`; the `~/.claude/projects/<slug>` dir
  only if left empty, so `memory/` survives) and drops it from pins and `projectOrder`; a pinned project with no
  transcripts is removed without asking.
  Keyboard in the sidebar list: Up/Down/Home/End move over visible headers and rows, Right expands a collapsed
  project (or steps into its first chat), Left collapses it (or jumps from a chat to its project), Enter/Space
  toggles a project or opens a chat. Opening a chat from the sidebar (click, Enter/Space, menu Open/Fork) moves focus to the composer (`focusComposer` in Sidebar; background opens and arrow navigation leave focus alone, and the Composer autofocus still skips while focus is in the sidebar so Delete can move to the next row); typing a printable key on a focused row also moves focus to the composer. Arrow keys pressed anywhere else (not in an input/textarea,
  dialog, dropdown or context menu) also drive the list, starting from the active chat's row (else the first entry). Opening a chat expands its project and scrolls to its row once; later session updates never re-expand/re-scroll, and startup tab restore opens chats in the background so a chat clicked meanwhile keeps the focus.
  `/` outside a text field focuses the search; Down from search enters the list and Up from the first entry returns to it; Delete on a chat row deletes it (closing its chat; a chat with no transcript yet is just closed) and focus moves to the next row; Delete on a project does nothing.
- Chats section (sidebar): after all projects, always shown ("No recent chats" when empty; hidden only when a search matches nothing in it),
  header with a MessageCircle icon, not draggable/pinnable/in `projectOrder`, no path tooltip, same time window/search/sort/dots/keyboard
  navigation; rows are compact (title + time, no chips); its menu only offers New chat. Footer: full-width "New chat" (`Ctrl N`, focuses the
  composer) above "Add project". Welcome's primary button is "New chat" (general), with a plain "New project session…" button opening the dialog.
- Composer: Enter sends, Shift+Enter newline, Esc while working stops the turn (same as the Stop button; an open picker closes first), Up/Down in an empty composer recall earlier prompts of that chat, `/` opens the command picker, eraser button (also Ctrl+Backspace) = `/clear`,
  messages typed while busy are queued. `@` opens the agent picker (from `supportedAgents()`, `chat:agents`), inserts `@agent-<name>` which the CLI routes to that subagent; mentions render as a muted pill.
- Changes panel (Ctrl+Shift+G or the `+A −D` button left of the context meter): uncommitted changes of the active
  chat's repo, refreshed on chat activation, after every `result`, on open and via its refresh button. Click a diff
  line (or its hover button) to add a comment; "Send to Claude" sends all of the chat's comments as one numbered
  message (queued while busy). Comments live on the chat, unpersisted; lines that vanish after a refresh list under
  "Outdated". Width is draggable on its left edge (`changesWidth` pref, double-click = 520), capped at 60 % of the row.
- Dots also have a steady blue `ask` state (`--ask`) when a chat has a pending permission/question; it beats busy.
  Context meter bar is segmented by category (muted per-category hues on `--chip-l`); popover adds the last
  turn's input / cache read / cache write / output and cache-hit %.
- Keep cache warm (per chat, by session id): flame button in the composer toolbar and "Keep cache warm" in the row context menu (turning it on for a closed chat opens it in the background); the cache pill gets a small flame while active. `tickKeepWarm` (every 30 s) warms at TTL − min(5 m, 20 % of TTL), only while the chat is idle with nothing pending, never re-warms a cold cache, gives up after 12 h without a real turn (`KEEP_WARM_MAX_IDLE_MS`), pauses while the chat is closed; failures retry after 2 min. Cache time left everywhere = `max(lastAt, warmedAt)`; `/clear` carries the flag to the new session id.
- Keyboard: Ctrl+N new general chat (project sessions: sidebar project button / "New project session…" on Welcome), Ctrl+Shift+G changes panel, Ctrl+Tab / Ctrl+Shift+Tab cycle through the visible sidebar rows (highlight moves while Ctrl is held, the chat opens on release; Esc cancels), Ctrl+W close active chat, Ctrl+Delete deletes the active chat's transcript (closes it if it has none; inside a text field only when it's the empty composer), Ctrl+Backspace = `/clear` (same text-field rule as Ctrl+Delete), Ctrl+F find, Ctrl+R reload,
  Ctrl+Shift+I DevTools, Esc closes dialogs/pickers/find.

## Testing without disturbing the user (Hyprland)

- The user usually has the app running (and sometimes a fullscreen game on the focused monitor). **Never
  `pkill -x electron` or run `scripts/dev-launch.sh` while their instance is up** (both kill every electron).
  Check first: `hyprctl clients -j | jq '.[] | select(.class=="agent-command-center")'`.
- Start an isolated copy instead: `electron . --remote-debugging-port=9334 --user-data-dir=<scratch>/profile`
  (own localStorage), connect with puppeteer-core (`protocolTimeout: 180000`), set `document.title` to a
  unique string, then move it to the terminal's workspace without focusing:
  `hyprctl dispatch 'hl.dsp.window.move({ workspace = 7, window = (function() for _,w in ipairs(hl.get_windows()) do if w.title == "CCD-TEST" then return w end end end)(), silent = true })'`.
  Hyprland runs a Lua config: classic dispatcher syntax prints an error on stdout and exits 0, so check for
  `ok`. Never `hl.dsp.focus`. Kill only that pid afterwards. Screenshots via `page.screenshot()` (slow when
  the window is hidden, but works); never `grim` the screen.
- To inspect the user's live instance without restarting it: `kill -USR1 <main pid>` opens the Node inspector
  on 127.0.0.1:9229; evaluate with `process.getBuiltinModule('node:module').createRequire(<repo>/package.json)`
  → `require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(...)` (dynamic
  `import()` is not available there). `webContents.insertCSS` can hot-patch styles.
- Keep test prompts tiny (real tokens); use a scratch folder for anything that edits files; `haiku` is fine.
- `pkill -f` with a pattern that also appears in the running shell command kills the shell itself.

## Known gaps

- Linux only, no packaged build (`pnpm package` → unpacked dir).
- Subagents tracked only for chats opened in the app, not reconstructed from old transcripts.
- No `@` file mentions (`@` is agents only), no rewind, no plan-mode cards, no tray icon
  (candidate next features, in roughly that order of value).
- Notification click → focus+activate chat is wired but was never exercised by a script.
- "Always allow" and "Delete transcript" paths were never run end to end in tests (destructive).
