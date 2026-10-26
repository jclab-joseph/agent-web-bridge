// Draft wire types shared between the server and client libraries.

export type SessionStatus =
  /** Agent process is spawning or resuming. */
  | 'starting'
  /** Process is alive and waiting for input; the TTL is counting down. */
  | 'idle'
  /** Agent is working on a turn. */
  | 'busy'
  /** Agent is blocked on a tool permission decision. */
  | 'awaiting_permission'
  /** Process was stopped after the TTL; the next message resumes it. */
  | 'suspended'
  | 'error'

export interface SelectOption {
  id: string
  label: string
  description?: string
}

/** Describes an agent provider (claude-code, ...) and what it supports. */
export interface AgentInfo {
  id: string
  name: string
  models: SelectOption[]
  permissionModes: SelectOption[]
  /** Reasoning effort levels; empty when the agent has no such setting. */
  efforts: SelectOption[]
  defaultModel?: string
  defaultPermissionMode?: string
  defaultEffort?: string
  /** Whether user messages may carry images. */
  supportsImages?: boolean
}

export interface SessionInfo {
  id: string
  agentId: string
  title: string
  cwd: string
  model?: string
  permissionMode?: string
  effort?: string
  status: SessionStatus
  createdAt: number
  lastActiveAt: number
  /** Epoch ms at which the process will be suspended. Set while idle or awaiting permission. */
  expiresAt?: number
}

export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ImageAttachment {
  mediaType: ImageMediaType
  /** Base64 without the `data:` prefix. */
  data: string
}

/** A multiple-choice question the agent asks the user (Claude's AskUserQuestion). */
export interface Question {
  question: string
  /** Short label, e.g. "Auth method". */
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string; preview?: string }[]
}

export interface PermissionRequest {
  id: string
  status: 'pending' | 'allowed' | 'denied'
  /** Prompt sentence from the agent, e.g. "Claude wants to read foo.txt". */
  title?: string
  /** Whether the provider can remember an "always allow" rule for this tool. */
  canAlwaysAllow?: boolean
  /** Set when the request is a question: answer it with `answers` instead of a plain allow. */
  questions?: Question[]
  /** The answers given, by question text. */
  answers?: Record<string, string>
}

export type PermissionDecision = 'allow' | 'allow_always' | 'deny'

export interface PermissionResponse {
  decision: PermissionDecision
  /** Reason given to the agent on deny. */
  message?: string
  /** Answers to `PermissionRequest.questions`, by question text. Multiple choices are joined with ", ". */
  answers?: Record<string, string>
}

interface BaseMessage {
  id: string
  createdAt: number
  /** Id of the tool call this message is nested in, e.g. the call that started a subagent. */
  parentId?: string
}

export interface UserMessage extends BaseMessage {
  kind: 'user'
  text: string
  images?: ImageAttachment[]
}

export interface AssistantMessage extends BaseMessage {
  kind: 'assistant'
  text: string
}

export interface ThinkingMessage extends BaseMessage {
  kind: 'thinking'
  text: string
}

export interface ToolMessage extends BaseMessage {
  kind: 'tool'
  name: string
  input: unknown
  status: ToolStatus
  output?: string
  permission?: PermissionRequest
}

export interface SystemMessage extends BaseMessage {
  kind: 'system'
  text: string
  level?: 'info' | 'warn' | 'error'
}

export type ChatMessage = UserMessage | AssistantMessage | ThinkingMessage | ToolMessage | SystemMessage

export interface CreateSessionRequest {
  agentId: string
  cwd: string
  model?: string
  permissionMode?: string
  effort?: string
  prompt?: string
}

/** Client → server. */
export type ClientCommand =
  | ({ type: 'session.create' } & CreateSessionRequest)
  | { type: 'session.send'; sessionId: string; text: string; images?: ImageAttachment[] }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.update'; sessionId: string; model?: string; permissionMode?: string; effort?: string }
  | ({ type: 'session.permission'; sessionId: string; requestId: string } & PermissionResponse)
  | { type: 'session.suspend'; sessionId: string }
  | { type: 'session.delete'; sessionId: string }

/** Server → client. */
export type ServerEvent =
  /** First event on every (re)connect. `now` lets clients correct for clock skew. */
  | { type: 'hello'; now: number; agents: AgentInfo[]; sessions: SessionInfo[] }
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'message.upsert'; sessionId: string; message: ChatMessage }
