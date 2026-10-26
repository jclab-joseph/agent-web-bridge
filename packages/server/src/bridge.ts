import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentInfo,
  ChatMessage,
  ClientCommand,
  CreateSessionRequest,
  ImageAttachment,
  PermissionResponse,
  ServerEvent,
  SessionInfo,
  SessionStatus,
} from '@agent-web-bridge/protocol'
import type { AgentEvent, AgentProvider, AgentRuntime, UserInput } from './agent'
import { MemorySessionStore, type SessionRecord, type SessionStore } from './store'

export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000

const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES = 10
/** Decoded size limit per image (the Claude API limit). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface BridgeOptions {
  providers: AgentProvider[]
  /** Defaults to an in-memory store. */
  store?: SessionStore
  /** Time a session may sit idle (or wait for a permission answer) before its process is stopped. */
  sessionTtlMs?: number
  /** When set, session working directories must be inside one of these directories. */
  allowedRoots?: string[]
}

/** Server-side context for a command, supplied by the host (see `HandlerOptions.sessionMeta`). */
export interface CommandContext {
  /** Stored with a new session and passed to its provider on every start. */
  meta?: Record<string, unknown>
}

/** Error with an HTTP-style status, raised for invalid client requests. */
export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LiveSession {
  status: SessionStatus
  runtime?: AgentRuntime
  starting?: Promise<AgentRuntime>
  expiresAt?: number
  timer?: ReturnType<typeof setTimeout>
  /** Set while we stop the process ourselves, so its exit is not reported as a crash. */
  stopping?: boolean
}

/**
 * Owns agent sessions: spawns provider runtimes, suspends them after the TTL,
 * resumes them on the next message and fans events out to subscribers.
 */
export class AgentBridge {
  readonly store: SessionStore
  private providers = new Map<string, AgentProvider>()
  private live = new Map<string, LiveSession>()
  private listeners = new Set<(event: ServerEvent) => void>()
  private ttlMs: number
  private allowedRoots?: string[]

  constructor(options: BridgeOptions) {
    for (const provider of options.providers) this.providers.set(provider.info.id, provider)
    this.store = options.store ?? new MemorySessionStore()
    this.ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.allowedRoots = options.allowedRoots?.map((root) => resolve(root))
  }

  get agents(): AgentInfo[] {
    return [...this.providers.values()].map((p) => p.info)
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listSessions(): Promise<SessionInfo[]> {
    const records = await this.store.listSessions()
    return records.map((r) => this.toInfo(r))
  }

  async getSession(id: string): Promise<SessionInfo> {
    return this.toInfo(await this.record(id))
  }

  async listMessages(id: string): Promise<ChatMessage[]> {
    await this.record(id)
    return this.store.listMessages(id)
  }

  /** Runs a client command; returns the created session for `session.create`. */
  async handle(command: ClientCommand, context: CommandContext = {}): Promise<SessionInfo | void> {
    switch (command.type) {
      case 'session.create': {
        const { type: _, ...request } = command
        return this.create(request, context)
      }
      case 'session.send':
        return this.send(command.sessionId, { text: command.text, images: command.images })
      case 'session.interrupt':
        return this.interrupt(command.sessionId)
      case 'session.update': {
        const { model, permissionMode, effort } = command
        return this.update(command.sessionId, { model, permissionMode, effort })
      }
      case 'session.permission': {
        const { decision, message, answers } = command
        return this.respondPermission(command.sessionId, command.requestId, { decision, message, answers })
      }
      case 'session.suspend':
        return this.suspend(command.sessionId, 'Suspended')
      case 'session.delete':
        return this.delete(command.sessionId)
      default:
        throw new BridgeError(400, `Unknown command: ${(command as { type: string }).type}`)
    }
  }

  async create(request: CreateSessionRequest, context: CommandContext = {}): Promise<SessionInfo> {
    const provider = this.provider(request.agentId)
    const cwd = await this.checkCwd(request.cwd)
    checkOption(provider.info.models, request.model, 'model')
    checkOption(provider.info.permissionModes, request.permissionMode, 'permission mode')
    checkOption(provider.info.efforts, request.effort, 'effort')
    const now = Date.now()
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: provider.info.id,
      title: request.prompt ? titleFrom(request.prompt) : '',
      cwd,
      model: request.model ?? provider.info.defaultModel,
      permissionMode: request.permissionMode ?? provider.info.defaultPermissionMode,
      effort: request.effort ?? provider.info.defaultEffort,
      createdAt: now,
      lastActiveAt: now,
      meta: context.meta,
    }
    await this.store.saveSession(record)
    this.live.set(record.id, { status: 'starting' })
    this.publishSession(record)

    // Failures are recorded in the transcript and the session status.
    const start = request.prompt ? this.send(record.id, { text: request.prompt }) : this.ensureRuntime(record.id)
    start.catch(() => {})
    return this.toInfo(record)
  }

  async send(id: string, input: UserInput): Promise<void> {
    const record = await this.record(id)
    const text = input.text?.trim() ?? ''
    const images = input.images?.length ? input.images : undefined
    if (!text && !images) throw new BridgeError(400, 'Message is empty')
    if (images) checkImages(images, this.provider(record.agentId).info.supportsImages)

    const now = Date.now()
    record.lastActiveAt = now
    if (!record.title) record.title = text ? titleFrom(text) : 'Image'
    await this.store.saveSession(record)
    await this.addMessage(id, { id: randomUUID(), kind: 'user', createdAt: now, text, images })

    const runtime = await this.ensureRuntime(id)
    this.setStatus(id, 'busy')
    await runtime.send({ text, images })
  }

  async interrupt(id: string): Promise<void> {
    await this.live.get(id)?.runtime?.interrupt()
  }

  async update(id: string, options: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    const record = await this.record(id)
    const { info } = this.provider(record.agentId)
    checkOption(info.models, options.model, 'model')
    checkOption(info.permissionModes, options.permissionMode, 'permission mode')
    checkOption(info.efforts, options.effort, 'effort')
    if (options.model !== undefined) record.model = options.model
    if (options.permissionMode !== undefined) record.permissionMode = options.permissionMode
    if (options.effort !== undefined) record.effort = options.effort
    await this.store.saveSession(record)
    await this.live.get(id)?.runtime?.update(options)
    this.publishSession(record)
  }

  async respondPermission(id: string, requestId: string, response: PermissionResponse) {
    const runtime = this.live.get(id)?.runtime
    if (!runtime) throw new BridgeError(409, 'Session is not running')
    runtime.respondPermission(requestId, response)
  }

  /** Stops the session's process; the next message resumes it. `reason` is recorded in the transcript. */
  async suspend(id: string, reason?: string): Promise<void> {
    const live = this.live.get(id)
    if (!live?.runtime && !live?.starting) return
    const runtime = live.runtime ?? (await live.starting!.catch(() => undefined))
    if (!runtime) return
    live.stopping = true
    this.clearTtl(live)
    await runtime.stop()
    if (reason) {
      await this.addMessage(id, { id: randomUUID(), kind: 'system', level: 'warn', createdAt: Date.now(), text: reason })
    }
  }

  async delete(id: string): Promise<void> {
    await this.record(id)
    await this.suspend(id)
    this.live.delete(id)
    await this.store.deleteSession(id)
    this.publish({ type: 'session.deleted', sessionId: id })
  }

  /** Stops every running process, e.g. on server shutdown. */
  async close(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.suspend(id, 'Server stopped')))
  }

  private provider(agentId: string): AgentProvider {
    const provider = this.providers.get(agentId)
    if (!provider) throw new BridgeError(400, `Unknown agent: ${agentId}`)
    return provider
  }

  private async record(id: string): Promise<SessionRecord> {
    const record = await this.store.getSession(id)
    if (!record) throw new BridgeError(404, `Session not found: ${id}`)
    return record
  }

  private async checkCwd(cwd: string): Promise<string> {
    if (!cwd || !isAbsolute(cwd)) throw new BridgeError(400, 'Working directory must be an absolute path')
    const path = resolve(cwd)
    const inside = (root: string) => {
      const rel = relative(root, path)
      return !rel.startsWith('..') && !isAbsolute(rel)
    }
    if (this.allowedRoots && !this.allowedRoots.some(inside)) {
      throw new BridgeError(403, `Working directory is outside the allowed roots: ${path}`)
    }
    const info = await stat(path).catch(() => undefined)
    if (!info?.isDirectory()) throw new BridgeError(400, `Not a directory: ${path}`)
    return path
  }

  private ensureRuntime(id: string): Promise<AgentRuntime> {
    let live = this.live.get(id)
    if (!live) this.live.set(id, (live = { status: 'suspended' }))
    if (live.runtime) return Promise.resolve(live.runtime)
    if (live.starting) return live.starting

    const current = live
    current.starting = (async () => {
      const record = await this.record(id)
      const resuming = !!record.providerSessionId
      this.setStatus(id, 'starting')
      try {
        const runtime = await this.provider(record.agentId).start({
          sessionId: record.id,
          cwd: record.cwd,
          model: record.model,
          permissionMode: record.permissionMode,
          effort: record.effort,
          resume: record.providerSessionId,
          meta: record.meta,
          emit: (event) => this.onAgentEvent(id, event),
        })
        current.runtime = runtime
        if (resuming) {
          await this.addMessage(id, { id: randomUUID(), kind: 'system', createdAt: Date.now(), text: 'Session resumed' })
        }
        this.setStatus(id, 'idle')
        return runtime
      } catch (error) {
        const text = `Failed to start agent: ${errorMessage(error)}`
        await this.addMessage(id, { id: randomUUID(), kind: 'system', level: 'error', createdAt: Date.now(), text })
        this.setStatus(id, 'error')
        throw new BridgeError(500, text)
      } finally {
        current.starting = undefined
      }
    })()
    return current.starting
  }

  private onAgentEvent(id: string, event: AgentEvent) {
    switch (event.type) {
      case 'message':
        if (event.partial) {
          this.publish({ type: 'message.upsert', sessionId: id, message: event.message })
        } else {
          void this.addMessage(id, event.message)
        }
        break
      case 'status':
        if (event.status === 'idle') void this.touch(id)
        this.setStatus(id, event.status)
        break
      case 'permission_mode':
        void this.record(id).then(async (record) => {
          if (record.permissionMode === event.mode) return
          record.permissionMode = event.mode
          await this.store.saveSession(record)
          this.publishSession(record)
        })
        break
      case 'provider_session':
        void this.record(id).then((record) => {
          if (record.providerSessionId === event.providerSessionId) return
          record.providerSessionId = event.providerSessionId
          return this.store.saveSession(record)
        })
        break
      case 'exit': {
        const live = this.live.get(id)
        if (!live) break
        const crashed = !live.stopping
        live.runtime = undefined
        live.stopping = false
        this.clearTtl(live)
        this.setStatus(id, 'suspended')
        if (crashed) {
          const text = `Agent process exited${event.error ? `: ${event.error}` : ''}`
          void this.addMessage(id, { id: randomUUID(), kind: 'system', level: 'error', createdAt: Date.now(), text })
        }
        break
      }
    }
  }

  private setStatus(id: string, status: SessionStatus) {
    const live = this.live.get(id)
    if (!live) return
    live.status = status
    this.clearTtl(live)
    if (status === 'idle' || status === 'awaiting_permission') {
      live.expiresAt = Date.now() + this.ttlMs
      live.timer = setTimeout(() => {
        const minutes = Math.round(this.ttlMs / 60_000)
        void this.suspend(id, `Suspended after ${minutes} minute${minutes === 1 ? '' : 's'} without activity`)
      }, this.ttlMs)
      live.timer.unref?.()
    }
    void this.store.getSession(id).then((record) => record && this.publishSession(record))
  }

  private clearTtl(live: LiveSession) {
    clearTimeout(live.timer)
    live.timer = undefined
    live.expiresAt = undefined
  }

  private async touch(id: string) {
    const record = await this.store.getSession(id)
    if (!record) return
    record.lastActiveAt = Date.now()
    await this.store.saveSession(record)
  }

  private async addMessage(id: string, message: ChatMessage) {
    await this.store.saveMessages(id, [message])
    this.publish({ type: 'message.upsert', sessionId: id, message })
  }

  private toInfo(record: SessionRecord): SessionInfo {
    const { providerSessionId: _, meta: __, ...rest } = record
    const live = this.live.get(record.id)
    return {
      ...rest,
      title: record.title || basename(record.cwd) || record.cwd,
      status: live?.status ?? 'suspended',
      expiresAt: live?.expiresAt,
    }
  }

  private publishSession(record: SessionRecord) {
    this.publish({ type: 'session.updated', session: this.toInfo(record) })
  }

  private publish(event: ServerEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

/** Rejects values the agent does not offer, so clients cannot pick e.g. a permission mode the host left out. */
function checkOption(options: { id: string }[], value: string | undefined, what: string) {
  if (value !== undefined && options.length && !options.some((o) => o.id === value)) {
    throw new BridgeError(400, `Unsupported ${what}: ${value}`)
  }
}

function checkImages(images: ImageAttachment[], supported: boolean | undefined) {
  if (!supported) throw new BridgeError(400, 'This agent does not accept images')
  if (images.length > MAX_IMAGES) throw new BridgeError(400, `At most ${MAX_IMAGES} images per message`)
  for (const image of images) {
    if (!IMAGE_TYPES.has(image.mediaType)) throw new BridgeError(400, `Unsupported image type: ${image.mediaType}`)
    if (typeof image.data !== 'string' || (image.data.length * 3) / 4 > MAX_IMAGE_BYTES) {
      throw new BridgeError(400, 'Image is larger than 5 MB')
    }
  }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
