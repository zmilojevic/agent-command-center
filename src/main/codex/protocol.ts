// Minimal hand-written types for the parts of the `codex app-server` JSON-RPC protocol Hearth uses.
// Reference: `codex app-server generate-ts --out <dir>` (v2 types under <dir>/v2). Not vendored on purpose.
// Framing: one JSON object per line over stdio; the `jsonrpc` field is omitted in both directions.

export type RpcId = number | string

export interface RpcRequest {
  id: RpcId
  method: string
  params?: unknown
}
export interface RpcNotification {
  method: string
  params?: unknown
}
export interface RpcResponse {
  id: RpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'localImage'; path: string }

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
export interface ThreadTokenUsage {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export type ThreadItem =
  | { type: 'userMessage'; id: string; clientId: string | null; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: 'inProgress' | 'completed' | 'failed'
      arguments: unknown
      result: { content: unknown[]; structuredContent: unknown } | null
      error: { message: string } | null
    }
  | { type: 'webSearch'; id: string; query: string; action?: { type: string; query?: string | null; queries?: string[] | null; url?: string | null; pattern?: string | null } | null }
  | { type: string; id: string; [k: string]: unknown }

export interface Turn {
  id: string
  items: ThreadItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message: string; additionalDetails?: string | null } | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

export interface Thread {
  id: string
  preview: string
  ephemeral: boolean
  modelProvider: string
  model: string | null
  reasoningEffort: string | null
  createdAt: number
  updatedAt: number
  path: string | null
  cwd: string
  name: string | null
  gitInfo?: { branch?: string | null } | null
  turns: Turn[]
}

export interface ThreadStartedResponse {
  thread: Thread
  model: string
  reasoningEffort: string | null
  cwd: string
}

export interface ReasoningEffortOption {
  reasoningEffort: string
  description: string
}
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: ReasoningEffortOption[]
  defaultReasoningEffort: string
  isDefault: boolean
}

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
export interface RateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  planType: string | null
}

export interface CodexAccount {
  type: 'apiKey' | 'chatgpt' | 'amazonBedrock' | 'gcp'
  email?: string | null
  planType?: string
}
