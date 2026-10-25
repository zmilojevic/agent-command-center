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
- pnpm 12 blocks build scripts by default and ignores `package.json` `pnpm.onlyBuiltDependencies`; the allowlist is `allowBuilds` in
  `pnpm-workspace.yaml` (electron, esbuild, node-pty allowed; electron-winstaller explicitly `false`). `node-pty` is native and must match
  Electron's ABI: `postinstall` / `pnpm rebuild:native` run `electron-rebuild -f -w node-pty` (needs a C++ toolchain); electron-vite keeps it
  external (`externalizeDepsPlugin`). Smoke test: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "const p=require('node-pty');
  const t=p.spawn('/bin/sh',['-c','echo pty-ok'],{});t.onData(d=>process.stdout.write(d));t.onExit(()=>process.exit(0))"`.
- Cross-platform packaging (added 2026-10-25): `electron-builder.yml` (productName "Agent Command Center" only there, never in
  package.json; `extraResources` = `resources/` → `<resourcesPath>/resources`; `asarUnpack` node-pty + `@anthropic-ai/claude-agent-sdk-*`;
  `npmRebuild: false`), `pnpm dist:linux|mac|win` (must run on that OS: node-pty and the SDK's per-platform optional binary).
  CI `.github/workflows/build.yml` (manual dispatch or `v*` tag → artifacts + draft release); unsigned unless repo secrets
  `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_*` (mac, notarized) or `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` exist; unsigned mac = ad-hoc
  (`-c.mac.identity=-`). The `android` job builds the APK too (artifact `agent-command-center-android`, attached to the release). Icons: `scripts/make-icons.sh` → `build/icon.png` (1024, mac padding), `build/icon.ico`,
  `resources/trayTemplate{,@2x}.png` (mac menu bar). Local check: `pnpm exec electron-builder --linux dir` → `dist/linux-unpacked`.
- Never `git commit` or push unless the user asks. Remote `origin` = `git@github.com:zmilojevic/agent-command-center.git`
  (public), branch `main`.

## Layout

- `src/main/index.ts` – BrowserWindow (frameless; renderer draws the title bar; Wayland switches
  `ozone-platform-hint=auto`, `disable-renderer-backgrounding`, `backgroundThrottling:false`), all IPC handlers,
  chokidar watcher on `~/.claude/projects` (file and dir add/change/unlink → `sessions:changed`),
  native notifications (`app:notify` → click sends `notification:click`) (icon: `/usr/share/icons/hicolor/256x256/apps/claude-desktop.png` if installed, else `resources/icon.png` rendered from `icon.svg`; without an icon the daemon shows a bell), `window:action`
  (minimize/maximize/close/reload/devtools).
- Platforms: Linux is primary and its behaviour must not change; macOS/Windows support is code-complete but untested by the author.
  Main: `userData` pinned to `<appData>/agent-command-center` (unless `--user-data-dir`); `resources.ts` `resourceFile()` (packaged →
  `process.resourcesPath`); `claudeBin.ts` `claudeExecutable()` → `pathToClaudeCodeExecutable` for every `query()` when packaged (the SDK's
  resolved binary is inside app.asar, the spawnable copy in `app.asar.unpacked`); `shellEnv.ts` imports the login shell env on macOS
  (Finder launches get launchd's PATH; `CCD_SKIP_SHELL_ENV=1` skips); mac = `hiddenInset` title bar + traffic lights, minimal app menu
  (no Cmd+W/R/N/F accelerators – the renderer owns them), Dock `activate` re-shows the hidden window; Windows = AppUserModelId,
  pwsh/powershell terminal; `CHATS_DIR` = `<appData>/agent-command-center/chats` off Linux; Remote Control reads the token from the
  macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) before the file; `launch.ts` has per-platform
  editor/terminal defs (mac `.app` bundles via `open -a`, Windows PATHEXT and `.cmd` via `cmd.exe /d /s /c`); git paths go through
  `resolve()` (git prints `C:/…`). Renderer: `window.desktop.platform` → `<html data-platform>`, `styles/platform.css`, `isMac`/`isWin`
  and `modLabel()` (⌘ labels) in `util.ts`; path helpers accept `\` and drive letters.
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
- Worktree chats: `git.ts` `createWorktree(cwd, name)` (`git:worktreeAdd`) makes `<main repo root>/.claude/worktrees/<name>` on branch `worktree-<name>` from HEAD (same as Claude Code's `--worktree`; root = parent of `--git-common-dir`, so it also works from inside a worktree) and appends `.claude/worktrees/` once to `.git/info/exclude` (never `.gitignore`); `removeWorktree(path, force)` (`git:worktreeRemove`) keeps the branch. A worktree chat is an ordinary session whose cwd is the worktree path; the renderer identifies it with `worktreeOf(cwd)` / `projectRoot(cwd)` (`util.ts`). Sidebar groups sessions by `projectRoot`, so they sit under their project; rows show a small `wt-chip` with the worktree name; project menu "New chat in worktree…" (name dialog prefilled `wt-xxxx`, error shown inline), row menu "Remove worktree…" (worktree rows only: closes the chat, force-removes the folder, keeps branch and transcripts). "Remove project…" deletes the transcripts of its worktree cwds too (one `deleteProject` per cwd). TopBar shows the root's project name plus a worktree label. Styles for MCP/worktree UI live in `styles/mcp-worktree.css`.
- `src/main/remote.ts` – Remote Control (continue a project chat from claude.ai/code or the Claude mobile app). `RemoteManager`
  (`remote:enable(chatId, {sessionId,title,cwd,model,branch})` / `remote:disable`, event `remote:state {chatId,state:'off'|'connecting'|'on'|'error',error?,url?}`)
  keeps one `RemoteBridge` per chat. It uses the SDK's alpha `@anthropic-ai/claude-agent-sdk/bridge`: `createCodeSession` (title, cwd, model; no git
  context) -> `fetchRemoteCredentials` -> `attachBridgeSession`. The `cse_*` id per session id is persisted in `<userData>/remote-sessions.json`, so
  re-enabling / restarting re-attaches the same claude.ai session (URL `https://claude.ai/code/session_<id>`, same id with `cse_` -> `session_`). The
  bridge hangs off the runner through the small `RemoteHooks` tap in `agent.ts` (`runner.remote`: every forwarded SDKMessage, local sends,
  permission request/done, close). Outbound: assistant/user/system init+compact_boundary messages are `write()`n (no `stream_event` partials), `result`
  -> `sendResult()` + `reportState('idle')`, a turn start -> `running`, a pending permission -> `sendControlRequest(can_use_tool)` + `requires_action`
  (cancel via `sendControlCancelRequest` when answered/cancelled locally). Inbound: user message -> `runner.send` + `chat:remoteMessage` (renderer shows the
  bubble via the shared `appendUserMessage`), `control_response` -> `runner.respond` + `permission:cancel`, interrupt, set model / permission mode
  (`remote:setting` event updates the Dropdowns), rename -> `renameSession` + `sessions:changed`. JWT is refreshed proactively (3 h at most; each
  fetch bumps the epoch) and on close codes 401 / 4090 / 4094 via `reconnectTransport`; other close codes -> error state. Renderer: pref `remoteSessions`
  (session ids, like `keepWarm`), `remote` state per chat, restored in `startRunner`; Smartphone button in the composer toolbar (project chats only),
  row context menu "Remote control", Smartphone badge in the row's chip line. Not carried over by `/clear` (new session id). The runner closing closes the bridge.
  Token handling: the OAuth access token is read fresh from `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, checked against `expiresAt`) for
  each bridge HTTP call only; it is never logged, written or sent to the renderer. Expired -> error "Claude login token expired – send a message in any
  chat to refresh it" (the CLI refreshes it on its next API call). Base URL is hardcoded `https://api.anthropic.com` (the CLI's default).
- `src/main/sessionMeta.ts` – reads the tail (512 KB) of a transcript `~/.claude/projects/<cwd with
  non-alphanumerics → '-'>/<id>.jsonl` and derives model, effort, context tokens
  (input + cache_read + cache_creation of the last assistant line), last timestamp, and the cache TTL from the
  most recent turn that *wrote* cache entries (`cache_creation.ephemeral_1h_input_tokens` → 1 h, else 5 m;
  default 1 h). Cached by mtime.
- `src/main/tray.ts` – tray icon (`resources/icon.png` at 32 px, StatusNotifierItem) with menu Show/hide, New chat (`tray:newChat` →
  renderer `newGeneralChat()` + composer focus), Quit. Left click = `toggleWindow`: no window → create; hidden/minimized → show+focus;
  visible on Hyprland (`HYPRLAND_INSTANCE_SIGNATURE`) → `hyprctl clients -j` (pid === process.pid) vs `hyprctl activeworkspace -j`:
  same workspace → hide to tray, other workspace → focus (Lua `hyprctl dispatch 'hl.dsp.focus({window=...})'` must print `ok`,
  fallback `focuswindow pid:<pid>`); no hyprctl/window not found or non-Hyprland → `isFocused()` ? hide : show+focus. All hyprctl calls
  use execFile arg arrays, 1.5 s timeout. `focusWindow()` is also used by notification clicks and `second-instance`. Decision is logged
  as `tray: action=… ws=… active=…`; `CCD_TRAY_DRY_RUN=1` logs it without hiding/showing/focusing. Closing the window (also the
  renderer's close button) hides to tray unless quitting (`before-quit`, tray Quit, `window:action 'quit'`); `window-all-closed` does
  not quit while the tray exists (no tray host → old behaviour, close quits). Runners keep running while hidden. Single instance via
  `requestSingleInstanceLock()` (per user-data-dir; skipped when `ELECTRON_RENDERER_URL` is set, i.e. `pnpm dev`).
- `src/main/pty.ts` – `PtyManager` (integrated terminal): one `node-pty` shell per id (`$SHELL` or bash, interactive, cwd or home, env = process.env
  minus `ELECTRON_*`/`CCD_*`, `TERM=xterm-256color`, `COLORTERM=truecolor`). IPC `pty:create|write|resize|kill|list|replay` (`write`/`resize` are
  `ipcRenderer.send`), events `pty:data {id,data,end}` (batched ~10 ms; `end` = cumulative char count) and `pty:exit {id,code}`. A 200 KB ring
  buffer per terminal backs `pty:replay`, so after a renderer reload the xterm is re-filled (chunks with `end <=` the replay's `end` are dropped; live chunks arriving meanwhile are queued until the replay is parsed, and xterm's answers to queries inside the replayed output - CPR, DECRQM, DA - are muted via `Entry.muted` until the `term.write` callback so they never reach the shell as input).
  An exited shell stays listed until `pty:kill`. All killed on `before-quit` / `will-quit`; shells survive window hide and reloads.
- Right column: `RightDock` (App.tsx) holds `ChangesPanel` and `TerminalPanel`; it owns the draggable left edge (`changesWidth` pref, capped 60 %,
  double-click = 520). Both open = stacked in `.dock-pane` wrappers split by a horizontal `.dock-split` handle (6-7 px hit area over the hairline, row-resize, accent-muted line on hover; drag sets pref `dockSplit` = top fraction, default 0.5, each pane keeps >= 120 px, double-click = 0.5); the width handle works with either panel alone. Terminals refit on every dock resize (ResizeObserver, per animation frame). Neither shows for general chats. `ToolStrip` = IntelliJ-style 44 px icon column at the far right of `.main-row` (project chats only) with Changes and Terminal toggles; the `+A −D` totals sit in the TopBar left of the branch (click = toggle the changes panel); styles in `styles/toolstrip.css`. Terminal side:
  `terminals.ts` keeps one xterm `Terminal` per pty id in a module registry (never React state; `mountTerminal` moves `term.element` into the
  panel, FitAddon on a 50 ms debounced ResizeObserver, theme resolved from CSS vars and re-applied on `data-theme` changes, web links open via
  `window.open` → `shell.openExternal`); store `terminals[cwd] = {tabs:{id,shell,n}[], active, counter}` (not persisted), pref `terminalOpen`,
  `toggleTerminal/newTerminal/killTerminal/restoreTerminals`. `TerminalPanel` = header (title, tabs "zsh 1", "+", close) + xterm; opening for a
  folder without shells creates one; killing the last shell of the visible folder closes the panel. After a shell exits the view shows
  "[process exited with code N]" and the next keypress removes the tab. Styles: `styles/terminal.css`.
- `src/main/git.ts` – `gitChanges(cwd)` (`git:changes`): uncommitted changes of the repo containing cwd = `git diff HEAD`
  (empty tree when there are no commits) split per file + untracked files via `git diff --no-index /dev/null`
  (≤ 200, > 1 MB shown as binary), diff text capped at 4 MB (`truncated`). Never through a shell.
- `src/main/git.ts` also has the panel actions (all return an error string or null, never through a shell): `gitSetStaged` (`add` / `restore --staged`, `rm --cached` before the first commit), `gitDiscardFile` (M/D `restore --source=HEAD --staged --worktree`, A `rm -f`, untracked `fs.rm` inside the repo root only, R restores oldPath + `rm -f` new), `gitDiscardHunk` (`apply -R --recount` of one hunk's patch on stdin, worktree only). `gitChanges` fills `ChangedFile.staged` (`all|partial|none`).
- `src/main/launch.ts` – detects editors (subl, code, zed, cursor, idea, codium) and terminals (kitty, alacritty, foot, ghostty, wezterm, konsole, gnome-terminal) by scanning PATH plus `~/.local/bin`, `/usr/bin`; `app:tools`, `app:openInEditor(path, line?, editorId?)` (absolute paths only; falls back to `shell.openPath` when none/`system`), `app:openTerminal(dir, terminalId?)`. Spawned detached, stdio ignored, no shell. Renderer helpers in `src/renderer/src/openIn.ts`; prefs `editor` / `terminal` (ids, '' = first detected) with Dropdowns in the gear menu.
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
  with `<command-name>`, `<system-reminder>`, `<local-command-stdout>`… Non-subagent tasks (`task_type` other than `local_agent`) go to `ChatModel.tasks` (`BgTask`) from task_started/updated/notification and `background_tasks_changed` (replace semantics: unknown live ids are added, tracked backgrounded ones that vanished are marked completed; it arrives *before* task_started). Local slash-command output renders
  as a muted block; the post-`/compact` summary as a collapsed card.
- `src/renderer/src/store.ts` – zustand + immer. Sessions list, `meta` per session, open chats keyed by
  chatId (sessionId inside), `tabs` (internal order only, no UI strip), pending permissions, drafts,
  attachments, queue, subagents, prefs in localStorage (`lastModel`, `pinnedProjects`, `projectOrder`, `projectNames`,
  `collapsedProjects`, `keepWarm` (session ids), `warmedAt` (session id → start of last keep-alive request), `projectDefaults`, `hiddenSessions`, `sessionSortTime`, `openTabs`, `recentHours`, `sidebarWidth`, notifications, `theme`). `lastMode` is always
  `bypassPermissions` on start (user wants every session to run with permissions skipped; the picker can
  still change one session). `restoreTabs()` reopens saved sessions on startup. `clearChat` = `/clear`:
  closes the runner and starts a fresh session (new
  session id, as the CLI does too) in the same tab/folder. The old id goes into `hiddenSessions` (transcript kept on
  disk, never listed in the sidebar) and the new id gets `sessionSortTime[newId]` = the old row's sort time, so the row
  keeps its slot and looks cleared in place (chains work). Both prefs are pruned in `loadSessions` against disk.
- `src/renderer/src/components/` – `UsageMeter` (top bar, left: "5h N% · time to reset", hover = all session/weekly rows), `Sidebar` (projects, rows, drag-reorder, context menus, subagent list,
  time-window Dropdown in the header, Add project footer), `TopBar` (folder/branch, `ContextMeter`,
  `SettingsPopover` (theme Dropdown + notifications switch), `McpPopover` (plug button, project chats only: `mcpServerStatus()` rows with status dot, scope chip, expandable tool list, enable switch via `toggleMcpServer`, reconnect via `reconnectMcpServer`; IPC `chat:mcpStatus/mcpToggle/mcpReconnect`, trimmed `McpServerInfo` without config/headers; refreshes on open, after actions and on chat status changes), window controls; exports `dotState`), `ChatView`, `FindBar`, `MessageItem`,
  `ToolCard` (running Bash gets a "Run in background" button), `TasksStrip` (pills above the composer for background shells/monitors/workflows, click = output popover with Stop / Copy), `DiffView`, `ChangesPanel` + `UnifiedDiff` (right-hand git changes panel with line comments), `PermissionCard`, `QuestionCard`, `Markdown` (react-markdown + gfm +
  rehype-highlight), `Composer` (slash picker, attachments, queue, model/effort/mode Dropdowns, eraser = `/clear`),
  `NewSessionDialog`, `Dropdown` (custom; **never use native `<select>`**), `ErrorBoundary`,
  `ImageThumb`.
- `src/renderer/src/theme.ts` – `initTheme()` (called in `main.tsx` before render) resolves the `theme` pref
  (`system` | `light` | `dark`) and stamps `<html data-theme="light|dark">`; all palette CSS keys off that attribute
  (no `prefers-color-scheme` queries in `styles.css`). It also sends `app:theme` so main sets
  `nativeTheme.themeSource` and the window `backgroundColor`; with `system` the OS media query drives it.
- `src/renderer/src/images.ts`, `hooks.ts`, `util.ts` (`modelLabel`, `relativeTime`, `defaultContextWindow`:
  1M for the Claude 5 family, 200k otherwise, until the CLI reports the real window).
- `scripts/dev-launch.sh [prod|dev|stop]` and `scripts/ui-driver.mjs <scenario>` (puppeteer-core on port 9333).
- `CCD_LOG_EVENTS=1` logs raw SDK messages to stderr; `window.__ccd.getState()` exposes the store in DevTools.
- Phone companion (design: `docs/mobile.md`): the phone is another client of the main process over a WebSocket.
  `src/shared/channels.ts` = single table of every `DesktopApi` method (`INVOKES`/`SENDS`/`EVENTS`) + `PHONE_BLOCKED` (window, theme, folder picker, openPath/editor/terminal, notify, all `pty:*`) and `DESKTOP_ONLY_EVENTS`; the preload and the phone shim are both generated from it, so a new IPC method is added there first. `src/main/ipc.ts`: `handle`/`on` register once (Electron IPC + a map), `dispatch(channel, ctx, args)`, `CallCtx.client` = `'desktop'` | `'phone:<deviceId>'`.
  `RunnerRegistry` keeps `holders` per runner (`start`/`attach` add, `release` removes, closes at none), `list()`/`chat:live` + debounced `chat:liveChanged`, exited runners are skipped, reaper closes phone-only idle runners after 30 min. `chat:send` echoes `chat:remoteMessage {origin,images}` to everyone (clients dedupe by uuid), `respond` emits `permission:cancel`. Renderer: `openSession` attaches (`attachLive`) when `liveChats()` has the session; desktop auto-attaches in the background to events of unknown chats (`closedHere` stops re-attach after a local close); phone re-attaches all chats on `onReconnected`.
  `src/main/mobile.ts` `MobileServer`: settings `<userData>/mobile.json` (`enabled`, port 47615, devices with sha256 token hashes), http + `ws` on `/ws`, peers limited to loopback/RFC1918/100.64/10, serves the built `out/renderer` (`/` = `mobile.html`), pairing code (8 chars, 5 min, 5 tries) -> `{pair}` -> `{paired, token}`, then `{auth, token}`; after auth `invoke`/`send` frames go through `dispatch` (blocked: `PHONE_BLOCKED`, `mobile:*`), `emit` also `broadcast`s events (skips `DESKTOP_ONLY_EVENTS`, stalled sockets). Gear menu "Phone access" + `PairDialog` (QR via `uqr`).
  Shared prefs: sidebar-shaping prefs (`SHARED_PREFS` in `channels.ts`: hiddenSessions, sessionSortTime, pinnedProjects, projectOrder, projectNames,
  projectDefaults, recentHours) live in main (`src/main/sharedPrefs.ts`, `<userData>/shared-prefs.json`, `prefs:get|set`, event `prefs:changed`) so the
  phone lists the same chats; `prefs.set` mirrors them there, `syncSharedPrefs()` runs before `loadSessions` (desktop seeds missing keys, the phone never
  does) and on phone reconnect; only the desktop prunes hiddenSessions/sessionSortTime. collapsedProjects stays per device.
  Android APK: `android/` (Java WebView shell, AGP 9.4.1 / Gradle 9.8.2 wrapper, minSdk 30, target 36), built by `scripts/build-apk.sh`
  (`JAVA_HOME=~/.local/share/jdk-21`, `ANDROID_HOME=~/Android/Sdk`; system JDK 27 is too new for Gradle) → `~/Downloads/agent-command-center.apk`. CI: `android` job in build.yml, artifact `agent-command-center-android`, release-signed when secrets `ANDROID_KEYSTORE_BASE64`/`ANDROID_KEYSTORE_PASSWORD`/`ANDROID_KEY_ALIAS`/`ANDROID_KEY_PASSWORD` exist (build.gradle reads `ANDROID_KEYSTORE_FILE` etc.), else debug-signed with a per-run key.
  Phone UI = second renderer entry `mobile.html` -> `src/renderer/src/mobile/entry.ts` (pairing screen, token in localStorage `ccd.mobile.token`) installs `window.desktop` from `shim.ts` and only then `import('../main')`. App code must never import `mobile/shim` (it would split the shim into a chunk that pulls in the main chunk and runs it before `window.desktop` exists; use `window.desktop.connectionState`/`onConnectionState`). The page is served over plain http, an insecure context: `crypto.randomUUID` is polyfilled in `entry.ts`, use `copyText` (util.ts) instead of `navigator.clipboard`. `isPhone` (util.ts) switches off keep-warm, Remote Control, terminals, changes panel, notifications, folder/editor actions, composer autofocus; layout in `styles/phone.css` under `[data-client="mobile"]`. `scripts/mobile-smoke.mjs <url> <code>` checks pairing, auth, allowlist and that the mobile entry does not import the desktop chunk.

## SDK facts learned the hard way

- Remote Control: the CLI's `--remote-control` / `/remote-control` only exist in the interactive REPL (passing it via `extraArgs` in SDK mode is
  silently ignored), but hosts can do it themselves with `@anthropic-ai/claude-agent-sdk/bridge` (alpha; see its `bridge.d.ts`). Verified with a
  prototype using only the OAuth token from `~/.claude/.credentials.json` and no trusted-device token: `createCodeSession` returns a `cse_*` id,
  `fetchRemoteCredentials` returns `{worker_jwt, api_base_url: https://api.anthropic.com, expires_in: 46800 (13 h), worker_epoch: 1}`, `attachBridgeSession`
  connects (`isConnected()` turns true after the first flush), writes/`sendResult`/`reportState` succeed. A possible `untrusted_device` failure (server flag
  `sessions_elevated_auth_enforcement`) is surfaced verbatim in the UI; not worked around.
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
- Background tasks: `system/task_started|task_updated|task_notification|background_tasks_changed` carry `task_type` (`local_bash`, `local_agent`, `local_workflow`, `monitor_mcp`, ...). Verified shapes: `task_updated.patch.status` = `killed` after `stopTask`, then `task_notification` `status:'stopped'` with `output_file`, then `background_tasks_changed` with an empty list. `q.getTaskOutput(taskId)` (undocumented, not in the types) returns `{output, total_bytes, truncated}` (last <= 8 KiB, ANSI possible); `stopTask` resolves undefined; `backgroundTasks(toolUseId?)` moves foreground tasks to the background. IPC `chat:taskOutput|stopTask|backgroundTasks`.
- Slash commands typed by the user go to the CLI unchanged as the user message; `/cost` → `/usage` alias etc.
  Their output is not stored in the transcript.
- The CLI expands `@path` file mentions (and `@"path with spaces"`) in headless user messages itself, so the composer only inserts text.
  Its file index is reachable via the undocumented control request `(query as any).request({subtype:'file_suggestions', query})` →
  `response.suggestions[{path}]` (folders end with '/', empty query = top-level entries, some hits are absolute paths; the first calls after
  startup return [] while the index builds, ~0.5 s). Wrapped as `ChatRunner.fileSuggestions` (`chat:files`).
- In plan mode `canUseTool` is called for `ExitPlanMode` (input `{plan}`); an allow result with `updatedPermissions:[{type:'setMode',mode,destination:'session'}]`
  switches the session mode (`PermissionResponse` allow `mode`).

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
  section, no tab strip anywhere. Projects: order is frozen (every project's slot is saved in `projectOrder` the first time it shows up, new ones go on top once; activity never reorders), drag to reorder (saved; pinned projects always come first in their own dragged order, drags only reorder within the pinned or the unpinned section, a new pin goes to the bottom of the pinned section, unpinning puts the project at the top of the rest), "Rename project…" via context menu (display name only: `projectNames` pref, cwd → name, empty or the folder name = reset; the folder on disk is never renamed, identity stays the cwd; shown in sidebar, top bar, new-session dialog, matched by search; dropped on Remove project), project menu "Default model & effort…" (dialog with model/effort Dropdowns, "Last used" = follow `lastModel`/`lastEffort`; stored in `projectDefaults` by project root; applies to new chats, resumed/forked chats and worktree chats of that project, not to the composer pickers, which still set lastModel/lastEffort; dropped on Remove project; model list via `app:models` = any live runner or a temporary idle query, cached 10 min), pin/unpin via context menu (pinned
  projects stay listed without recent chats; an empty expanded project shows the same centered muted "New chat" button, which starts a chat in that project and focuses the composer; it auto-collapses after 30 s, not while searching and never the Chats section), new-chat icon always visible on the header, collapsed headers
  show a busy/unread dot, faint gradient hairlines between projects (stronger) and chats (fainter),
  "Add project" button in the footer. Chat rows are indented 10 px, title 15 px, two lines: title + time
  (time = last response finished, hidden while working) and chips: context-used % (green→orange-red as it
  fills), cache pill ("cache · 35m left" / "cache cold", hue from orange-red at 0 % to green at ≥80 % of TTL
  left, very low saturation, no fill), model·effort grey chip, branch on the right. Dots: orange pulsing =
  working, green = finished and not yet seen (seen = active chat + focused window), nothing when idle, with an
  invisible spacer so titles don't jump. Chats sorted by creation time (newest first); a `/clear` clears the row in
  place: new session id under the hood, old transcript hidden from the sidebar but kept on disk, row keeps its slot via
  `sessionSortTime`. An empty chat (no messages, draft, attachments or transcript on disk — new or just cleared) is closed as soon as another chat (or none) becomes active, so its placeholder row disappears. Collapsed state, open chats and active chat are remembered.
  Deleting a transcript asks no confirmation. "Remove project…" (project context menu) confirms with a dialog,
  then closes its chats, deletes all its transcripts (`sessions:deleteProject`; the `~/.claude/projects/<slug>` dir
  only if left empty, so `memory/` survives) and drops it from pins and `projectOrder`; a pinned project with no
  transcripts is removed without asking.
  Keyboard in the sidebar list: Up/Down/Home/End move over visible headers and rows, Right expands a collapsed
  project (or steps into its first chat), Left collapses it (or jumps from a chat to its project), Enter/Space
  toggles a project or opens a chat. Opening a chat from the sidebar (click, Enter/Space, menu Open/Fork) moves focus to the composer (`focusComposer` in Sidebar; background opens and arrow navigation leave focus alone, and the Composer autofocus still skips while focus is in the sidebar so Delete can move to the next row); typing a printable key on a focused row also moves focus to the composer. Arrow keys pressed anywhere else (not in an input/textarea,
  dialog, dropdown or context menu) also drive the list, starting from the active chat's row (else the first entry). Opening a chat expands its project and scrolls to its row once; later session updates never re-expand/re-scroll, and startup tab restore opens chats in the background so a chat clicked meanwhile keeps the focus.
  `/` outside a text field focuses the search; Down from search enters the list and Up from the first entry returns to it; middle-click on a chat row = Ctrl+W on it (deletes its transcript, or closes it if none); middle-click never pastes the primary selection except directly onto a text field (App mouseup guard); Delete on a chat row deletes it (closing its chat; a chat with no transcript yet is just closed) and focus moves to the next row; Delete on a project does nothing.
- Chats section (sidebar): after all projects, always shown (when empty it shows a centered half-width, muted (transparent, grey text) "New chat" button; hidden only when a search matches nothing in it),
  header with a MessageCircle icon, not draggable/pinnable/in `projectOrder`, no path tooltip, same time window/search/sort/dots/keyboard
  navigation; rows are compact (title + time, no chips); its menu only offers New chat. Footer: full-width "New chat" (`Ctrl N`, focuses the
  composer) above "Add project". With no active chat the chat pane is empty (no welcome screen).
- Composer: Enter sends, Shift+Enter newline, Esc while working stops the turn (same as the Stop button; an open picker closes first), Up/Down in an empty composer recall earlier prompts of that chat, `/` opens the command picker, eraser button (also Alt+Delete, Ctrl+K, Ctrl+L) = `/clear`,
  messages typed while busy are queued. Sending while the prompt cache is cold (same `max(lastAt, warmedAt) + TTL` test as the snowflake; not for `/` commands or queued messages) first asks in a `ColdCacheConfirm` modal ("expired N ago", ~context tokens; Send anyway = Enter, Cancel = Esc keeps the draft, third button "Clear context & send" = `/clear` then sends the message into the new session). `@` opens the agent picker (from `supportedAgents()`, `chat:agents`), inserts `@agent-<name>` which the CLI routes to that subagent; mentions render as a muted pill. The same `@` token also lists files (project chats only; regex accepts path characters and the `@"quoted` form): agents first, then up to 12 files from `chat:files` (debounced 80 ms, stale answers dropped by sequence number, one retry after 600 ms on an empty answer, index warmed once per runner generation). Picking a file inserts `@path ` (quoted if it has whitespace); a folder inserts `@dir/` and keeps the picker open. `@path` tokens in sent user messages render as the same pill (`Markdown files` prop). Shift+Tab in the composer (project chats, no picker open) toggles plan mode, remembering the previous mode (default bypass). `ExitPlanMode` permission requests render as `PlanCard` (plan Markdown, approve as accept edits / bypass / ask before edits = allow + `mode`, Ctrl+Enter = accept edits, "Keep planning" = deny with feedback); in the transcript `ExitPlanMode` is a collapsed "Plan" card and `EnterPlanMode` a muted one-liner. New CSS for these lives in `src/renderer/src/styles/mentions-plan.css`.
- Changes panel (Ctrl+Shift+G or the Changes button in the right tool strip): uncommitted changes of the active
  chat's repo, refreshed on chat activation, after every `result`, on open and via its refresh button. Click a diff
  line (or its hover button) to add a comment; "Send to Claude" sends all of the chat's comments as one numbered
  message (queued while busy). Comments live on the chat, unpersisted; lines that vanish after a refresh list under
  "Outdated". Width is draggable on its left edge (`changesWidth` pref, double-click = 520), capped at 60 % of the row.
- Changes panel actions: per-file stage checkbox (muted, partial = minus) and "N staged" in the header; hover on a file header = Open in editor, "Discard changes…"; hover on a hunk header = "Discard hunk…" (not for untracked/binary); both confirm in a modal (Enter confirms, Esc cancels); errors show inline above the list. Header "Commit…" Dropdown (Commit / Commit and push) sends Claude a short commit request (queued while busy). Open-in-editor entry points: ToolCard path of Read/Write/Edit/NotebookEdit (Read at `offset`), inline-code paths in project chats (click; `path:line[:col]`, relative to the chat's folder), TopBar folder name (editor), sidebar project menu (Open in editor / Open in terminal / Open folder).
- Dots also have a steady blue `ask` state (`--ask`) when a chat has a pending permission/question; it beats busy.
  Context meter bar is segmented by category (muted per-category hues on `--chip-l`); popover adds the last
  turn's input / cache read / cache write / output and cache-hit %.
- Keep cache warm (per chat, by session id): flame button in the composer toolbar and "Keep cache warm" in the row context menu (turning it on for a closed chat opens it in the background); the cache pill gets a small flame while active. The composer flame turns into a muted blue snowflake (`.icon-btn.cold`, `--ask`) once the cache is cold (also on the sidebar pill when keep-warm is on). `tickKeepWarm` (every 30 s) warms at TTL − min(5 m, 20 % of TTL), only while the chat is idle with nothing pending, never re-warms a cold cache, gives up after 12 h without a real turn (`KEEP_WARM_MAX_IDLE_MS`), pauses while the chat is closed; failures retry after 2 min. Cache time left everywhere = `max(lastAt, warmedAt)`; `/clear` carries the flag to the new session id.
- Terminal (project chats only; tool strip terminal icon "Terminal (Ctrl+`)" toggles it, the sidebar project menu keeps "Open in terminal" = external app):
  Ctrl+` closed → open + focus; open but focus elsewhere → focus it; open and focused → close and focus the composer. While focus is inside
  `.term-panel` every App-level hotkey is skipped (App `onKey` returns early; sidebar arrows, `/`, PlanCard Ctrl+Enter already skip textareas, which
  xterm's helper is; the middle-click mouseup guard skips `.term-panel` so primary-selection paste works) EXCEPT Ctrl+`, Ctrl+Shift+G and
  Ctrl+Tab / Ctrl+Shift+Tab (sidebar capture listener); xterm's `attachCustomKeyEventHandler` returns false for those so the shell never sees
  them. Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes (`navigator.clipboard`, native paste prevented).
- Run in terminal: shell-language code blocks (sh/bash/zsh/shell/console/fish/powershell) and finished Bash tool cards in project chats
  (desktop only) have a `SquareTerminal` button: store `runInTerminal(cwd, text, run)` opens the panel, reuses the folder's active shell (new
  one if none/exited, waits for its first output ≤ 2 s), `pasteToTerminal` (xterm `paste`, bracketed when the shell enabled it) + Enter,
  then focuses it. Shift+click pastes without running. `shellCommandText` (util.ts) strips `$ ` prompts (mixed blocks keep only `$ ` lines).
- Keyboard: Ctrl+N new general chat (project sessions: sidebar project button), Ctrl+Shift+G changes panel, Ctrl+Tab / Ctrl+Shift+Tab open the next/previous visible sidebar row on every press (no need to release Ctrl), Ctrl+W / Alt+W delete the active chat's transcript (closes it if it has none; inside a text field only when it's the empty composer), Alt+Delete / Ctrl+K / Ctrl+L = `/clear` (same text-field rule), Ctrl+B in the composer while a turn runs = move foreground tasks to the background (`backgroundTasks`), Ctrl+F find, Ctrl+Q really quit (closing the window only hides it to the tray), Ctrl+R reload,
  Ctrl+Shift+I DevTools, Esc closes dialogs/pickers/find. On the phone Enter inserts a newline (send button only).

## Testing without disturbing the user (Hyprland)

- The user usually has the app running (and sometimes a fullscreen game on the focused monitor). **Never
  `pkill -x electron` or run `scripts/dev-launch.sh` while their instance is up** (both kill every electron).
  Check first: `hyprctl clients -j | jq '.[] | select(.class=="agent-command-center")'`.
- Start an isolated copy with `scripts/test-launch.sh [port] [profile-dir]` (defaults 9334, `/tmp/ccd-test/profile`;
  own localStorage). It registers a Hyprland window rule so the test window opens silently on the main window's
  workspace with no initial focus (the user's explicit wish), launches electron with `CCD_WINDOW_TITLE=CCD-TEST`
  (main uses it as the window title, ignores `<title>` changes, `showInactive()`), and prints the electron pid, the
  workspaces and the focused window. Never move or focus windows; no need to set `document.title`. Connect with
  puppeteer-core (`protocolTimeout: 180000`); `page.click()` can hang on such a hidden window, so click via
  `page.evaluate(() => el.click())`. Kill only the printed pid afterwards. Screenshots via `page.screenshot()`
  (slow when the window is hidden, but works); never `grim` the screen.
- To inspect the user's live instance without restarting it: `kill -USR1 <main pid>` opens the Node inspector
  on 127.0.0.1:9229; evaluate with `process.getBuiltinModule('node:module').createRequire(<repo>/package.json)`
  → `require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(...)` (dynamic
  `import()` is not available there). `webContents.insertCSS` can hot-patch styles.
- Keep test prompts tiny (real tokens); use a scratch folder for anything that edits files; `haiku` is fine.
- `pkill -f` with a pattern that also appears in the running shell command kills the shell itself.

## Known gaps

- macOS/Windows builds were never run by the author (only built in CI); no auto-update; unsigned by default; mac arm64 only.
- Subagents tracked only for chats opened in the app, not reconstructed from old transcripts.
- No rewind
  (candidate next features, in roughly that order of value).
- Notification click → focus+activate chat is wired but was never exercised by a script.
- "Always allow" and "Delete transcript" paths were never run end to end in tests (destructive).
