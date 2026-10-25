// Types shared between the Electron main process and the renderer.

import type { WorkflowFile, WorkflowReadResult, WorkflowSaveRequest, WorkflowSaveResult, WorkflowAgent } from './workflow'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask before changes', hint: 'Prompts for edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits run without asking' },
  { value: 'plan', label: 'Plan mode', hint: 'Read-only until you approve a plan' },
  { value: 'auto', label: 'Auto', hint: 'A classifier approves routine calls' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Everything runs without asking' },
]

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

export interface SessionSummary {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}

export interface SessionMeta {
  sessionId: string
  model?: string
  effort?: string
  contextTokens?: number
  outputTokens?: number
  lastAt?: number
  cacheTtlMs?: number
  gitBranch?: string
  version?: string
  assistantTurns: number
}

export interface ChatContext {
  chatId: string
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  autoCompactThreshold?: number
  /** Breakdown by category (system prompt, tools, messages, free space, …). */
  categories?: ContextCategory[]
}

export interface ContextCategory {
  id?: string
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** A user message content block (Messages API shape) the renderer can send. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type UserContent = string | ContentBlock[]

export interface AgentChoice {
  name: string
  description: string
  model?: string
}

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
}

export interface NotifyRequest {
  chatId: string
  title: string
  body: string
  /** Skip it when the window has focus (the chat is the active one). */
  onlyIfUnfocused?: boolean
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
  parent_agent_id: string | null
}

export interface StartChatOptions {
  chatId: string
  cwd: string
  model?: string
  effort?: EffortLevel
  permissionMode: PermissionMode
  resume?: string
  fork?: boolean
  /** Session id for a new chat; defaults to chatId. */
  sessionId?: string
}

export interface PermissionRequest {
  chatId: string
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseID: string
  suggestions: unknown[]
  canRemember: boolean
  decisionReason?: string
  blockedPath?: string
}

export type PermissionResponse =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; remember?: boolean; mode?: PermissionMode }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

export interface ModelChoice {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  efforts?: EffortLevel[]
}

export interface AgentEvent {
  chatId: string
  /** Generation of the runner that produced it (see startChat). */
  gen?: number
  message: any
}

export interface ChatExit {
  chatId: string
  gen?: number
  error?: string
}

/** App colour theme preference; 'system' follows the OS. */
export type Theme = 'system' | 'light' | 'dark'

export interface UsageRow {
  kind: string
  group: string
  label: string
  percent: number
  resetsAt: string | null
  severity: string
  active: boolean
}
export interface PlanUsage {
  available: boolean
  subscription: string | null
  rows: UsageRow[]
  extra?: { enabled: boolean; usedCredits: number | null; monthlyLimit: number | null; currency: string | null }
  fetchedAt: number
  error?: string
}

export interface ChangedFile {
  path: string
  oldPath?: string
  status: 'M' | 'A' | 'D' | 'R' | '?'
  additions: number
  deletions: number
  binary?: boolean
  diff?: string
  /** Whether the file's changes are in the index: fully, partly or not at all (untracked = none). */
  staged?: 'all' | 'partial' | 'none'
}
export interface GitChanges {
  isRepo: boolean
  root?: string
  files: ChangedFile[]
  truncated?: boolean
  error?: string
}

export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error?: string
  scope?: string
  source?: string
  version?: string
  tools: { name: string; description?: string }[]
}

export interface LaunchTool {
  id: string
  label: string
}
export interface LaunchTools {
  editors: LaunchTool[]
  terminals: LaunchTool[]
}

export type RemoteStateName = 'off' | 'connecting' | 'on' | 'error'

export interface RemoteStateEvent {
  chatId: string
  state: RemoteStateName
  error?: string
  /** The chat's claude.ai/code address while connected. */
  url?: string
}

export interface RemoteEnableInfo {
  sessionId: string
  title: string
  cwd: string
  model?: string
  branch?: string
}

/** Summary of a live runner in the main process (shared between the desktop window and phone clients). */
export interface LiveChat {
  chatId: string
  gen: number
  sessionId?: string
  cwd: string
  status: 'starting' | 'idle' | 'running' | 'compacting'
  pendingCount: number
  model?: string
  permissionMode: PermissionMode
  holders: number
}

export interface AttachResult extends LiveChat {
  pending: PermissionRequest[]
}

export interface MobileStatus {
  enabled: boolean
  port: number
  running: boolean
  error?: string
  addresses: string[]
  devices: { id: string; name: string; createdAt: number; lastSeen: number }[]
}

export interface PairInfo {
  code: string
  url: string
  expiresAt: number
}

export interface DesktopApi {
  /** `process.platform` of the host (linux, darwin, win32). */
  platform: string
  /** Which client this API instance belongs to: the Electron window or the phone web UI. */
  client: 'desktop' | 'mobile'
  listSessions(): Promise<SessionSummary[]>
  getMessages(sessionId: string, cwd?: string): Promise<TranscriptMessage[]>
  getSessionMeta(items: { sessionId: string; cwd: string }[]): Promise<SessionMeta[]>
  renameSession(sessionId: string, title: string, cwd?: string): Promise<void>
  deleteSession(sessionId: string, cwd?: string): Promise<void>
  /** Delete every listed transcript of a project; its folder under ~/.claude/projects goes too once empty. */
  deleteProject(cwd: string, sessionIds: string[]): Promise<void>
  /** Resolves with the new runner's generation; events of older runners carry smaller ones. */
  startChat(opts: StartChatOptions): Promise<number>
  send(chatId: string, content: UserContent, uuid: string): Promise<void>
  respond(chatId: string, requestId: string, response: PermissionResponse): Promise<void>
  interrupt(chatId: string): Promise<void>
  setModel(chatId: string, model?: string): Promise<void>
  /** 'default' (or undefined) falls back to the model's default effort. */
  setEffort(chatId: string, effort?: string): Promise<void>
  setPermissionMode(chatId: string, mode: PermissionMode): Promise<void>
  /** Releases this client's hold on the chat; the runner closes when no client holds it any more. */
  closeChat(chatId: string): Promise<void>
  /** Joins an already running chat; null when no runner exists. */
  attachChat(chatId: string): Promise<AttachResult | null>
  liveChats(): Promise<LiveChat[]>
  listModels(chatId: string): Promise<ModelChoice[]>
  /** Models available to the account, from a live runner or a temporary idle query (cached 10 min). */
  listAllModels(): Promise<ModelChoice[]>
  listCommands(chatId: string): Promise<SlashCommandInfo[]>
  /** Saved workflows of a project root (`<root>/.claude/workflows`) and the user dir. */
  workflowList(root: string): Promise<WorkflowFile[]>
  workflowRead(path: string): Promise<WorkflowReadResult>
  workflowSave(req: WorkflowSaveRequest): Promise<WorkflowSaveResult>
  /** Error string or null. */
  workflowDelete(path: string): Promise<string | null>
  workflowAgents(root: string): Promise<WorkflowAgent[]>
  listAgents(chatId: string): Promise<AgentChoice[]>
  warmCache(chatId: string): Promise<boolean>
  requestContext(chatId: string): Promise<void>
  getUsage(force?: boolean): Promise<PlanUsage | null>
  /** Uncommitted changes (diff against HEAD plus untracked files) of the repo containing cwd. */
  gitChanges(cwd: string): Promise<GitChanges>
  notify(n: NotifyRequest): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
  openPath(path: string): Promise<void>
  homeDir(): Promise<string>
  chatsDir(): Promise<string>
  window(action: 'minimize' | 'maximize' | 'close' | 'reload' | 'devtools' | 'quit'): void
  /** Mirrors the renderer's theme into Electron's nativeTheme (window background, native widgets). */
  setTheme(theme: Theme): void
  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  onPermissionRequest(cb: (r: PermissionRequest) => void): () => void
  onPermissionCancel(cb: (r: { chatId: string; requestId: string }) => void): () => void
  onChatExit(cb: (e: ChatExit) => void): () => void
  onChatContext(cb: (c: ChatContext) => void): () => void
  onUsage(cb: (u: PlanUsage) => void): () => void
  onSessionsChanged(cb: () => void): () => void
  onNotificationClick(cb: (e: { chatId: string }) => void): () => void
  /** Tray menu "New chat". */
  onTrayNewChat(cb: () => void): () => void
  // ---- @file mentions / plan mode
  /** File/folder suggestions for an `@` mention from the CLI's file index (relative paths, folders end with '/'). */
  fileSuggestions(chatId: string, query: string): Promise<string[]>
  // ---- background tasks
  /** Tail (<= 8 KiB, may contain ANSI escapes) of a background task's output; null when unavailable. */
  taskOutput(chatId: string, taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean } | null>
  stopTask(chatId: string, taskId: string): Promise<void>
  /** Backgrounds the foreground task of that tool call, or all foreground tasks when omitted. */
  backgroundTasks(chatId: string, toolUseId?: string): Promise<boolean>
  // ---- mcp / worktrees
  mcpStatus(chatId: string): Promise<McpServerInfo[]>
  mcpToggle(chatId: string, name: string, enabled: boolean): Promise<void>
  mcpReconnect(chatId: string, name: string): Promise<void>
  /** Creates `<repo root>/.claude/worktrees/<name>` on branch `worktree-<name>` from HEAD. */
  worktreeAdd(cwd: string, name: string): Promise<{ path: string } | { error: string }>
  /** Removes the worktree folder; the branch is kept. */
  worktreeRemove(path: string, force: boolean): Promise<{ error?: string }>
  // ---- changes actions / open in editor (each resolves with an error message or null)
  gitSetStaged(cwd: string, file: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>, staged: boolean): Promise<string | null>
  gitDiscardFile(cwd: string, file: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>): Promise<string | null>
  /** `patch` = one file's diff header plus a single hunk; reverse-applied to the working tree. */
  gitDiscardHunk(cwd: string, patch: string): Promise<string | null>
  appTools(): Promise<LaunchTools>
  openInEditor(path: string, line?: number, editorId?: string): Promise<string | null>
  openTerminal(dir: string, terminalId?: string): Promise<string | null>
  // ---- integrated terminal
  ptyCreate(cwd: string, cols: number, rows: number): Promise<string>
  /** Fire-and-forget (typing latency). */
  ptyWrite(id: string, data: string): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyKill(id: string): Promise<void>
  ptyList(): Promise<PtyInfo[]>
  /** Buffered output (capped) plus the total char count it covers; chunks with `end <= end` are already in it. */
  /** True when the shell itself is the foreground process (idle prompt). */
  ptyIdle(id: string): Promise<boolean>
  ptyReplay(id: string): Promise<{ data: string; end: number }>
  onPtyData(cb: (e: { id: string; data: string; end: number }) => void): () => void
  onPtyExit(cb: (e: { id: string; code: number }) => void): () => void

  // ---- remote control
  remoteEnable(chatId: string, info: RemoteEnableInfo): Promise<void>
  remoteDisable(chatId: string): Promise<void>
  onRemoteState(cb: (e: RemoteStateEvent) => void): () => void
  /** A user message typed on claude.ai/the phone (already queued for the CLI). */
  onRemoteMessage(cb: (e: { chatId: string; text: string; uuid: string; images?: { mediaType: string; data: string }[]; origin?: string }) => void): () => void
  /** The set of live runners changed (debounced). */
  onLiveChanged(cb: (l: LiveChat[]) => void): () => void
  // ---- phone access (desktop window only)
  mobileStatus(): Promise<MobileStatus>
  mobileSetEnabled(on: boolean): Promise<MobileStatus>
  mobilePairStart(): Promise<PairInfo>
  mobileRevoke(id: string): Promise<MobileStatus>
  onMobileChanged(cb: (s: MobileStatus) => void): () => void
  getSharedPrefs(): Promise<Record<string, unknown>>
  setSharedPref(key: string, json: string): Promise<void>
  onSharedPrefChanged(cb: (e: { key: string; value: unknown }) => void): () => void
  /** Phone shim only: fires after the socket reconnected and re-authenticated. */
  onReconnected?(cb: () => void): () => void
  /** Phone shim only: state of the socket to the desktop. */
  connectionState?(): 'connecting' | 'open' | 'closed'
  onConnectionState?(cb: (s: 'connecting' | 'open' | 'closed') => void): () => void
  /** Model / permission mode changed from claude.ai. */
  onRemoteSetting(cb: (e: { chatId: string; model?: string; permissionMode?: PermissionMode }) => void): () => void
}

export interface PtyInfo {
  id: string
  cwd: string
  pid: number
  /** Shell binary name, e.g. "zsh". */
  shell: string
  exited: boolean
  code?: number
}
