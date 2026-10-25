import type {
  AgentInfo,
  ChatMessage,
  ImageAttachment,
  PermissionResponse,
  SessionStatus,
} from '@agent-web-bridge/protocol'

/**
 * Adapter for one agent SDK. Implement this to add a new kind of agent;
 * see `@agent-web-bridge/server/claude-code` for the Claude Agent SDK one.
 */
export interface AgentProvider {
  readonly info: AgentInfo
  /** Spawns an agent process. With `resume`, continues a previous provider session. */
  start(options: AgentStartOptions): Promise<AgentRuntime>
}

export interface AgentStartOptions {
  /** Bridge session id (a UUID). Providers may reuse it as their own session id. */
  sessionId: string
  cwd: string
  model?: string
  permissionMode?: string
  /** Provider session id reported by a previous runtime through `provider_session`. */
  resume?: string
  /** Server-side data the host attached when creating the session (never sent to clients). */
  meta?: Record<string, unknown>
  emit(event: AgentEvent): void
}

export type AgentEvent =
  /**
   * New message, or an update to a message with the same id. `partial` marks
   * in-progress updates (streamed text) that need not be persisted.
   */
  | { type: 'message'; message: ChatMessage; partial?: boolean }
  | { type: 'status'; status: Extract<SessionStatus, 'idle' | 'busy' | 'awaiting_permission'> }
  /** Id the store must keep so the session can be resumed after it is suspended. */
  | { type: 'provider_session'; providerSessionId: string }
  /** The permission mode in effect changed on the agent's side, e.g. on leaving plan mode. */
  | { type: 'permission_mode'; mode: string }
  /** The process ended, either through `stop()` or on its own. */
  | { type: 'exit'; error?: string }

export interface UserInput {
  text: string
  images?: ImageAttachment[]
}

/** A live agent process for one session. */
export interface AgentRuntime {
  send(input: UserInput): Promise<void>
  interrupt(): Promise<void>
  update(options: { model?: string; permissionMode?: string }): Promise<void>
  respondPermission(requestId: string, response: PermissionResponse): void
  /** Stops the process. The session stays resumable. */
  stop(): Promise<void>
}
