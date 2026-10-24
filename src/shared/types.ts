// Types shared between the Electron main process and the renderer.

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
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; remember?: boolean }
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
}
export interface GitChanges {
  isRepo: boolean
  root?: string
  files: ChangedFile[]
  truncated?: boolean
  error?: string
}

export interface DesktopApi {
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
  closeChat(chatId: string): Promise<void>
  listModels(chatId: string): Promise<ModelChoice[]>
  listCommands(chatId: string): Promise<SlashCommandInfo[]>
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
  window(action: 'minimize' | 'maximize' | 'close' | 'reload' | 'devtools'): void
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
}
