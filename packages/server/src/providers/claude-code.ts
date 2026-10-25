import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AssistantMessage,
  ChatMessage,
  PermissionResponse,
  Question,
  SelectOption,
  SessionStatus,
  ToolMessage,
} from '@agent-web-bridge/protocol'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentProvider, AgentRuntime, AgentStartOptions, UserInput } from '../agent'
import { errorMessage } from '../bridge'
import { AsyncQueue } from '../queue'

/** Agent SDK options the provider lets the host set; the rest it manages itself. */
export type ClaudeQueryOptions = Omit<
  Options,
  'cwd' | 'model' | 'permissionMode' | 'resume' | 'sessionId' | 'canUseTool' | 'includePartialMessages'
>

/** The session an agent process is started for. */
export type ClaudeSessionContext = Omit<AgentStartOptions, 'emit'>

export interface ToolAuthorizationRequest {
  toolName: string
  input: Record<string, unknown>
  session: ClaudeSessionContext
  /** Set when a subagent makes the call. */
  agentId?: string
  signal: AbortSignal
}

export interface ClaudeCodeProviderOptions {
  /**
   * Agent SDK options for every session, or a function that computes them per
   * session (from `session.meta`, `session.cwd`, ...). This is where CLI flags
   * (`extraArgs`), tool lists (`allowedTools`, `disallowedTools`, `tools`),
   * `settings`, `settingSources`, `hooks`, `mcpServers`, `systemPrompt` and
   * `pathToClaudeCodeExecutable` go.
   */
  queryOptions?: ClaudeQueryOptions | ((session: ClaudeSessionContext) => ClaudeQueryOptions | Promise<ClaudeQueryOptions>)
  /**
   * Variables to set (or, with `undefined`, remove) in the agent process
   * environment. Unlike the SDK's `env` option, which replaces the whole
   * environment, these are applied on top of `process.env` (or on top of
   * `queryOptions.env` when that is given).
   */
  env?: Record<string, string | undefined>
  /**
   * Settles a tool call on the server before the user is asked: return a
   * `PermissionResult` to allow or deny it, or `undefined` to ask the user.
   * Only called for calls Claude Code would prompt for, i.e. not for those
   * already allowed by the permission mode, `allowedTools` or settings rules.
   */
  authorizeTool?: (
    request: ToolAuthorizationRequest,
  ) => PermissionResult | undefined | Promise<PermissionResult | undefined>
  models?: SelectOption[]
  permissionModes?: SelectOption[]
  /** Offer the `bypassPermissions` mode, in which the agent runs every tool without asking. */
  allowBypassPermissions?: boolean
}

const DEFAULT_MODEL = 'default'
const MAX_TOOL_OUTPUT = 20_000
const PARTIAL_FLUSH_MS = 80
const ASK_USER_QUESTION = 'AskUserQuestion'

const MODELS: SelectOption[] = [
  { id: DEFAULT_MODEL, label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

const PERMISSION_MODES: SelectOption[] = [
  { id: 'default', label: 'Ask', description: 'Ask before running tools' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edit files without asking' },
  { id: 'plan', label: 'Plan', description: 'Read and plan only' },
  { id: 'auto', label: 'Auto', description: 'A classifier approves routine actions and asks about the rest' },
]

const BYPASS_MODE: SelectOption = { id: 'bypassPermissions', label: 'Bypass', description: 'Run every tool without asking' }

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions = {}): AgentProvider {
  return {
    info: {
      id: 'claude-code',
      name: 'Claude Code',
      models: options.models ?? MODELS,
      permissionModes:
        options.permissionModes ?? (options.allowBypassPermissions ? [...PERMISSION_MODES, BYPASS_MODE] : PERMISSION_MODES),
      defaultModel: DEFAULT_MODEL,
      defaultPermissionMode: 'default',
      supportsImages: true,
    },
    start: (startOptions) => ClaudeCodeRuntime.start(startOptions, options),
  }
}

async function resolveQueryOptions(
  { emit: _, ...session }: AgentStartOptions,
  provider: ClaudeCodeProviderOptions,
): Promise<Options> {
  const host =
    typeof provider.queryOptions === 'function' ? await provider.queryOptions(session) : (provider.queryOptions ?? {})
  let env = host.env
  if (provider.env) {
    env = { ...(env ?? process.env) }
    for (const [key, value] of Object.entries(provider.env)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
  return {
    forwardSubagentText: true,
    ...host,
    env,
    cwd: session.cwd,
    model: sdkModel(session.model),
    permissionMode: session.permissionMode as PermissionMode | undefined,
    allowDangerouslySkipPermissions: host.allowDangerouslySkipPermissions ?? provider.allowBypassPermissions,
    ...(session.resume ? { resume: session.resume } : { sessionId: session.sessionId }),
    includePartialMessages: true,
  }
}

interface PendingPermission {
  resolve(result: PermissionResult): void
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
}

type RuntimeStatus = Extract<SessionStatus, 'idle' | 'busy' | 'awaiting_permission'>

class ClaudeCodeRuntime implements AgentRuntime {
  private input = new AsyncQueue<SDKUserMessage>()
  private query: Query
  private done!: Promise<void>
  private ready = false
  private startError?: string
  private status?: RuntimeStatus
  private permissions = new Map<string, PendingPermission>()
  /** Tool calls that have not produced a result yet, by tool_use id. */
  private tools = new Map<string, ToolMessage>()
  /** Assistant text being streamed, by message id. */
  private streaming = new Map<string, AssistantMessage>()
  private dirty = new Set<string>()
  private flushTimer?: ReturnType<typeof setTimeout>
  private streamMessageId?: string
  /** Set by `interrupt()` so the aborted turn's result is not reported as a failure. */
  private interrupted = false
  /** Mode in effect as last reported by the CLI. */
  private mode?: string
  /** Mode we asked for and the CLI has not reported yet, to notice when it is unavailable (auto). */
  private requestedMode?: string
  /** Next content block index per API message id, to give complete blocks the ids their streamed versions had. */
  private blockIndex = new Map<string, number>()

  static async start(options: AgentStartOptions, provider: ClaudeCodeProviderOptions): Promise<ClaudeCodeRuntime> {
    const runtime = new ClaudeCodeRuntime(options, provider, await resolveQueryOptions(options, provider))
    runtime.done = runtime.pump()
    try {
      await Promise.race([
        runtime.query.initializationResult(),
        runtime.done.then(() => {
          throw new Error(runtime.startError ?? 'Agent exited during startup')
        }),
      ])
    } catch (error) {
      runtime.query.close()
      throw error
    }
    runtime.ready = true
    return runtime
  }

  private constructor(
    private options: AgentStartOptions,
    private provider: ClaudeCodeProviderOptions,
    queryOptions: Options,
  ) {
    this.query = query({ prompt: this.input, options: { ...queryOptions, canUseTool: this.canUseTool } })
    this.mode = this.requestedMode = queryOptions.permissionMode
  }

  async send({ text, images }: UserInput) {
    this.setStatus('busy')
    const content = images?.length
      ? [
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
          })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    })
  }

  async interrupt() {
    this.interrupted = true
    this.denyAll('Interrupted by the user')
    await this.query.interrupt()
  }

  async update(options: { model?: string; permissionMode?: string }) {
    if (options.model !== undefined) await this.query.setModel(sdkModel(options.model))
    if (options.permissionMode !== undefined) {
      this.requestedMode = options.permissionMode
      await this.query.setPermissionMode(options.permissionMode as PermissionMode)
    }
  }

  respondPermission(requestId: string, { decision, message, answers }: PermissionResponse) {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    const tool = this.tools.get(requestId)
    const isQuestion = !!tool?.permission?.questions
    const allowed = decision !== 'deny' && (!isQuestion || !!answers)
    if (tool?.permission) {
      this.upsertTool(requestId, {
        status: allowed ? 'running' : 'denied',
        permission: { ...tool.permission, status: allowed ? 'allowed' : 'denied', answers: allowed ? answers : undefined },
      })
    }
    pending.resolve(
      allowed
        ? {
            behavior: 'allow',
            updatedInput: answers ? { ...pending.input, answers } : pending.input,
            updatedPermissions: decision === 'allow_always' ? pending.suggestions : undefined,
          }
        : {
            behavior: 'deny',
            message: message || (isQuestion ? 'The user declined to answer.' : 'The user denied this action.'),
          },
    )
    if (!this.permissions.size && this.status === 'awaiting_permission') this.setStatus('busy')
  }

  async stop() {
    this.denyAll('Session stopped')
    this.input.end()
    this.query.close()
    await Promise.race([this.done, new Promise((resolve) => setTimeout(resolve, 5000))])
  }

  private canUseTool: CanUseTool = async (toolName, input, context) => {
    const { signal, suggestions, toolUseID, title, suppressAlwaysAllowRule, agentID } = context
    if (this.provider.authorizeTool) {
      const { emit: _, ...session } = this.options
      const decided = await this.provider.authorizeTool({ toolName, input, session, agentId: agentID, signal })
      if (decided) return decided
    }

    const questions = toolName === ASK_USER_QUESTION ? toQuestions(input.questions) : undefined
    this.upsertTool(toolUseID, {
      name: toolName,
      input,
      status: 'pending',
      permission: {
        id: toolUseID,
        status: 'pending',
        title,
        canAlwaysAllow: !questions && !!suggestions?.length && !suppressAlwaysAllowRule,
        questions,
      },
    })
    this.setStatus('awaiting_permission')
    return new Promise((resolve) => {
      this.permissions.set(toolUseID, { resolve, input, suggestions })
      signal.addEventListener('abort', () => this.respondPermission(toolUseID, { decision: 'deny', message: 'Aborted' }), {
        once: true,
      })
    })
  }

  private async pump() {
    let error: string | undefined
    try {
      for await (const message of this.query) this.handle(message)
    } catch (e) {
      error = errorMessage(e)
    } finally {
      this.denyAll('Session stopped')
      this.flush()
      if (this.ready) this.emit({ type: 'exit', error })
      else this.startError = error
    }
  }

  private handle(message: SDKMessage) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.emit({ type: 'provider_session', providerSessionId: message.session_id })
          this.onPermissionMode(message.permissionMode)
        } else if (message.subtype === 'status' && message.permissionMode) {
          this.onPermissionMode(message.permissionMode)
        }
        break
      case 'stream_event':
        // Subagent replies arrive as whole messages (forwardSubagentText), so only the main thread streams.
        if (!message.parent_tool_use_id) this.onStreamEvent(message.event)
        break
      case 'assistant':
        this.onAssistant(message)
        break
      case 'user':
        this.onToolResults(message.message.content)
        break
      case 'result':
        this.onResult(message)
        break
    }
  }

  /** Tracks mode changes made by the CLI itself (leaving plan mode) or a requested mode it cannot use. */
  private onPermissionMode(mode: PermissionMode) {
    const requested = this.requestedMode
    this.requestedMode = undefined
    if (requested && requested !== mode) {
      const text = `${requested === 'auto' ? 'Auto mode' : `Permission mode "${requested}"`} is not available here; using "${mode}".`
      this.emitMessage({ id: randomUUID(), kind: 'system', level: 'warn', createdAt: Date.now(), text })
    }
    if (mode === this.mode) return
    this.mode = mode
    this.emit({ type: 'permission_mode', mode })
  }

  private onStreamEvent(event: SDKPartialAssistantMessage['event']) {
    switch (event.type) {
      case 'message_start':
        this.streamMessageId = event.message.id
        this.setStatus('busy')
        break
      case 'content_block_start':
        if (event.content_block.type === 'text' && this.streamMessageId) {
          const id = `${this.streamMessageId}:${event.index}`
          this.streaming.set(id, { id, kind: 'assistant', createdAt: Date.now(), text: event.content_block.text })
        }
        break
      case 'content_block_delta':
        if (event.delta.type === 'text_delta' && this.streamMessageId) {
          const id = `${this.streamMessageId}:${event.index}`
          const message = this.streaming.get(id)
          if (!message) break
          message.text += event.delta.text
          this.dirty.add(id)
          this.flushTimer ??= setTimeout(() => this.flush(), PARTIAL_FLUSH_MS)
        }
        break
    }
  }

  /** Sends accumulated streamed text. */
  private flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const id of this.dirty) {
      const message = this.streaming.get(id)
      if (message) this.emit({ type: 'message', message: { ...message }, partial: true })
    }
    this.dirty.clear()
  }

  private onAssistant(message: SDKAssistantMessage) {
    const messageId = message.message.id
    const nested = message.parent_tool_use_id ? { parentId: message.parent_tool_use_id } : {}
    for (const block of message.message.content) {
      const index = this.blockIndex.get(messageId) ?? 0
      this.blockIndex.set(messageId, index + 1)
      const id = `${messageId}:${index}`
      if (block.type === 'text') {
        const streamed = this.streaming.get(id)
        this.streaming.delete(id)
        this.dirty.delete(id)
        this.emitMessage({ id, kind: 'assistant', createdAt: streamed?.createdAt ?? Date.now(), text: block.text, ...nested })
      } else if (block.type === 'thinking' && block.thinking) {
        this.emitMessage({ id, kind: 'thinking', createdAt: Date.now(), text: block.thinking, ...nested })
      } else if (block.type === 'tool_use') {
        this.upsertTool(block.id, { name: block.name, input: block.input, ...nested })
      }
    }
    if (message.error) {
      this.emitMessage({ id: randomUUID(), kind: 'system', level: 'error', createdAt: Date.now(), text: `Agent error: ${message.error}` })
    }
    this.setStatus('busy')
  }

  private onToolResults(content: SDKUserMessage['message']['content']) {
    if (typeof content === 'string') return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const tool = this.tools.get(block.tool_use_id)
      if (!tool) continue
      this.upsertTool(block.tool_use_id, {
        status: tool.status === 'denied' ? 'denied' : block.is_error ? 'error' : 'success',
        output: toolOutput(block.content),
      })
      this.tools.delete(block.tool_use_id)
    }
  }

  private onResult(message: SDKResultMessage) {
    if (this.interrupted) {
      this.interrupted = false
      this.emitMessage({ id: randomUUID(), kind: 'system', createdAt: Date.now(), text: 'Interrupted' })
    } else if (message.subtype !== 'success') {
      const detail = message.errors.length ? `: ${message.errors.join('; ')}` : ''
      this.emitMessage({ id: randomUUID(), kind: 'system', level: 'error', createdAt: Date.now(), text: `Turn failed (${message.subtype})${detail}` })
    } else if (message.is_error) {
      this.emitMessage({ id: randomUUID(), kind: 'system', level: 'error', createdAt: Date.now(), text: message.result })
    }
    this.blockIndex.clear()
    this.setStatus('idle')
  }

  private upsertTool(id: string, patch: Partial<ToolMessage>) {
    let tool = this.tools.get(id)
    if (!tool) {
      tool = { id, kind: 'tool', createdAt: Date.now(), name: 'tool', input: {}, status: 'running' }
      this.tools.set(id, tool)
    }
    Object.assign(tool, patch)
    this.emitMessage({ ...tool })
  }

  private denyAll(message: string) {
    for (const id of [...this.permissions.keys()]) this.respondPermission(id, { decision: 'deny', message })
  }

  private setStatus(status: RuntimeStatus) {
    if (this.status === status) return
    this.status = status
    this.emit({ type: 'status', status })
  }

  private emitMessage(message: ChatMessage) {
    this.emit({ type: 'message', message })
  }

  private emit(event: AgentEvent) {
    this.options.emit(event)
  }
}

function sdkModel(model: string | undefined): string | undefined {
  return model && model !== DEFAULT_MODEL ? model : undefined
}

/** Reads AskUserQuestion input defensively; it comes from the model. */
function toQuestions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value)) return undefined
  const questions = value.flatMap((q): Question[] => {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return []
    const options = q.options
      .filter((o: { label?: unknown }) => o && typeof o.label === 'string')
      .map((o: { label: string; description?: unknown; preview?: unknown }) => ({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : undefined,
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      }))
    return [{ question: q.question, header: typeof q.header === 'string' ? q.header : undefined, multiSelect: !!q.multiSelect, options }]
  })
  return questions.length ? questions : undefined
}

function toolOutput(content: unknown): string | undefined {
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join('\n')
  } else return undefined
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text
}
