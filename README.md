# Agent Command Center

A desktop GUI for [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions, modelled on the
Claude Code tab of the Claude desktop app. It runs on Linux (Wayland or X11) with Electron and talks to
Claude Code through the Claude Agent SDK, so it uses your existing Claude Code login and settings.

What it does:

- Lists every Claude Code session on the machine (`~/.claude/projects`), grouped by project folder, with search.
  The list refreshes by itself when sessions change on disk.
- Opens a session with its full transcript and continues it, or forks it into a new chat.
- Starts new chats in any folder, with a chosen model and permission mode.
- Streams replies as they are written: Markdown with code highlighting, thinking summaries, and tool cards
  (Bash command and output, Edit diffs, Write content, todo lists, and so on).
- Asks before tools run, as the CLI does: Allow once, Always allow (saved to `.claude/settings.local.json`),
  or Deny with an optional note telling Claude what to do instead. `AskUserQuestion` gets its own question card.
- Switches model and permission mode mid-session, stops a running turn, and keeps several chats open at once.
  Open chats are switched from the sidebar (there is no tab strip); right-click or middle-click a row to close it.
- Renames and deletes sessions from the sidebar's right-click menu.
- Slash commands: typing `/` opens a picker with the session's commands (from the CLI, with argument hints
  and descriptions). Commands go to the CLI as typed; local command output (`/cost`, `/context`, …) appears as
  a muted block. `/clear` is handled by the app and starts a fresh session.
- Images in prompts: paste, drop or attach images; they show as thumbnails above the message, are downscaled
  to 2000 px (JPEG) when larger, and open full size when clicked, also in stored transcripts.
- Subagents: each Agent/Task call is listed under its session in the sidebar while the chat is open (busy or
  done, description, current tool, elapsed time), and its tool card shows what the subagent is doing and how
  many tool calls it made.
- Context meter in the top bar (used / window, percentage); hovering shows the breakdown by category, the
  auto-compact threshold and a Compact button. The sidebar's first chip shows the context used per session.
- Message queue: Enter while Claude works queues the message; queued messages show above the composer, can be
  removed or sent at once ("Send now" folds them into the running turn), and go out one per finished turn.
- Desktop notifications when a turn ends or Claude asks for permission or has a question, unless that chat
  is in view; clicking one brings the window up on that chat. Toggle in the gear menu.
- Find in chat (Ctrl+F) with highlighted matches.

## Requirements

- The Claude Code CLI, installed and logged in (`claude` works in a terminal). No API key is needed;
  the app uses the same subscription login.
- Node.js 20 or newer and pnpm.

## Install and run

```sh
pnpm install          # installs Electron and the Agent SDK (with its native CLI binary)
pnpm dev              # dev server with hot reload
pnpm build            # production build into out/
pnpm typecheck        # TypeScript checks for main, preload and renderer
```

After `pnpm build`, start the built app with:

```sh
node_modules/.bin/electron .
```

or install the launcher once:

```sh
cat > ~/.local/bin/agent-command-center <<'SH'
#!/bin/sh
exec /path/to/agent-command-center/node_modules/.bin/electron /path/to/agent-command-center "$@"
SH
chmod +x ~/.local/bin/agent-command-center
```

A matching desktop entry (`~/.local/share/applications/agent-command-center.desktop`) uses
`Exec=agent-command-center`, `Icon=<repo>/resources/icon.svg` and `StartupWMClass=agent-command-center`.
The launcher runs whatever is in `out/`, so run `pnpm build` again after pulling changes.

## Install a packaged build

Packaged builds for Linux (AppImage, deb), macOS (Apple silicon, dmg/zip) and Windows (NSIS installer) come
from the `Build` GitHub Actions workflow: download them from the run's artifacts, or from the draft release
that a `v*` tag push creates. They are unsigned unless signing secrets are configured (below). You still need
the Claude Code CLI login (see Requirements).

- Linux: `chmod +x agent-command-center-*.AppImage && ./agent-command-center-*.AppImage`, or `sudo apt install ./agent-command-center-*.deb`.
- macOS: open the dmg and drag the app to Applications. An unsigned build is blocked by Gatekeeper: run
  `xattr -cr "/Applications/Agent Command Center.app"` once, or right-click the app and choose Open.
- Windows: run the installer. SmartScreen may warn for an unsigned build: "More info" then "Run anyway".
  Install Git for Windows as well; Claude Code's Bash tool uses Git Bash.

Build locally on the matching OS (each platform needs its own native binaries): `pnpm dist:linux`,
`pnpm dist:mac` or `pnpm dist:win`; output goes to `dist/`. Icons are generated from `resources/icon.svg` by
`scripts/make-icons.sh` (needs `rsvg-convert` and ImageMagick); the outputs are committed.
`pnpm dist:mac -c.mac.identity=-` ad-hoc signs a local build.

Signing in CI: add repository secrets. macOS: `CSC_LINK` (base64 .p12 of a Developer ID Application certificate),
`CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization.
Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`. Without them the workflow builds unsigned (macOS ad-hoc signed).

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+N | New chat |
| Ctrl+W | Close the current chat |
| Ctrl+F | Find in chat (Enter next, Shift+Enter previous, Esc closes) |
| Enter | Send the message, or queue it while Claude is working |
| Shift+Enter | New line in the message |
| `/` | Command picker: Up/Down to move, Tab or Enter to complete, Esc to close |
| Ctrl+V | Paste an image from the clipboard into the message |
| Middle-click a sidebar row | Close that chat |
| Esc | Close the new-chat dialog, rename dialog, context menu, find bar or image overlay |

## Architecture

Electron 45, electron-vite, React 19, TypeScript, ESM throughout.

- `src/main/index.ts`: the window (frameless, the title bar is drawn by the renderer), IPC handlers for
  sessions (`listSessions`, `getSessionMessages`, `renameSession`, `deleteSession` from the SDK), chats,
  the folder picker and window controls, and a chokidar watcher on `~/.claude/projects` that tells the
  renderer to reload the session list.
- `src/main/agent.ts`: `ChatRunner`, one SDK `query()` per open chat in streaming-input mode, so the CLI
  process stays alive across turns. It passes the cwd, model, permission mode and resume/fork options,
  bridges `canUseTool` to the renderer (`permission:request`, answered by `chat:respond`), and forwards
  every SDK message as `agent:event`. Each runner has a generation number (returned by `chat:start` and sent
  with its events) so events of a replaced runner are ignored; a deliberate close sends no `chat:exit`.
  `chat:commands` returns `supportedCommands()`, `chat:context` pushes `getContextUsage()` with its categories,
  and `app:notify` shows a native notification (click sends `notification:click`). Thinking is requested as summaries (`--thinking-display summarized`).
- `src/preload/index.ts`: exposes `window.desktop` (typed as `DesktopApi` in `src/shared/types.ts`).
- `src/renderer/src/reduce.ts`: a pure reducer that turns live SDK messages (stream deltas, assistant
  frames, tool results, results, system messages) and stored transcripts into the chat model the UI renders.
- `src/renderer/src/store.ts`: zustand + immer store for sessions, open chats, tabs, pending permission
  requests and drafts.
- `src/renderer/src/images.ts`: reads, downscales and base64-encodes image attachments.
- `src/renderer/src/components/`: `Sidebar`, `TopBar`, `ContextMeter`, `SettingsPopover`, `ChatView`, `FindBar`,
  `MessageItem`, `ImageThumb`, `ToolCard`, `DiffView`, `PermissionCard`, `QuestionCard`, `Markdown`, `Composer`,
  `NewSessionDialog`, `Welcome`.
- `scripts/dev-launch.sh`: starts the app (`prod`, the default, or `dev`) with remote debugging on port 9333.
  On Hyprland it places the window on a given workspace without taking focus (`CCD_WORKSPACE`, default 7);
  `scripts/dev-launch.sh stop` stops it again.
- `scripts/ui-driver.mjs`: puppeteer-core scenarios against the running app (`newchat`, `resume`, `ask`,
  `deny`, `stop`, `switch`, `fork`, `rename`, `prompt`, `eval`, `shot`), saving screenshots to `CCD_SHOTS`.

Debugging: set `CCD_LOG_EVENTS=1` to log every raw SDK message (truncated) to the main process's stderr.
The renderer store is available in DevTools as `window.__ccd.getState()`.

## Known limitations

- No auto-update; packaged builds are unsigned by default, and the macOS and Windows ones have not been tested by the author.
- Subagents are tracked only for chats opened in the app; a resumed transcript does not list earlier ones.
- There are no file `@` mentions.
- Output of local slash commands is not part of the stored transcript, so it is gone after reopening a session.
- Thinking text appears only where the model and account return thinking summaries.
- The session list shows sessions that have a recorded working directory; resuming a session whose
  folder no longer exists shows an error instead of starting.
- The per-turn cost is derived from the SDK's cumulative `total_cost_usd`; an interrupted turn's partial
  output is not included in it.
- Queued messages cannot be edited, only removed or sent at once, and the queue is not saved across restarts.
