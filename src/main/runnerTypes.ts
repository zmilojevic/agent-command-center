import type { AgentChoice, AttachResult, LiveChat, McpServerInfo, ModelChoice, PermissionRequest, PermissionResponse, SlashCommandInfo, UserContent } from '../shared/types'

/**
 * What RunnerRegistry and the IPC handlers need from a chat runner. Implemented by `ChatRunner` (Claude, agent.ts) and
 * `CodexRunner` (codex/runner.ts); methods without an equivalent in an engine return empty / false.
 */
export interface Runner {
  readonly chatId: string
  readonly gen: number
  /** Client ids ('desktop', 'phone:<id>') that use this runner; it closes when the last one releases it. */
  readonly holders: Set<string>
  /** Resolves once the backend process loop has ended (or at once if it never started). */
  readonly done: Promise<void>
  sessionId: string | undefined
  status: LiveChat['status']
  lastActivity: number
  /** The backend loop has ended (crash or deliberate close); the runner is dead but may still be in the registry. */
  exited: boolean
  summary(): LiveChat
  attachInfo(): AttachResult
  pendingRequests(): PermissionRequest[]
  start(): void
  send(content: UserContent, uuid: string): void
  respond(requestId: string, response: PermissionResponse): void
  emitContext(): Promise<void>
  interrupt(): Promise<void>
  setModel(model?: string): Promise<void>
  setEffort(effort?: string): Promise<void>
  /** Claude: a PermissionMode; Codex: a CodexMode. */
  setPermissionMode(mode: string): Promise<void>
  listModels(): Promise<ModelChoice[]>
  listCommands(): Promise<SlashCommandInfo[]>
  listAgents(): Promise<AgentChoice[]>
  fileSuggestions(query: string): Promise<string[]>
  mcpStatus(): Promise<McpServerInfo[]>
  toggleMcp(name: string, enabled: boolean): Promise<void>
  reconnectMcp(name: string): Promise<void>
  warmCache(): Promise<boolean>
  taskOutput(taskId: string): Promise<{ output: string; total_bytes: number; truncated: boolean } | null>
  stopTask(taskId: string): Promise<void>
  backgroundTasks(toolUseId?: string): Promise<boolean>
  /** Resolves when the backend has exited, or after a few seconds so a hung process never blocks the caller. */
  close(): Promise<void>
}
