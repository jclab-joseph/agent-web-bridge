import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentInfo,
  ChatMessage,
  ClientCommand,
  CreateSessionRequest,
  FileAttachment,
  ImageAttachment,
  PermissionResponse,
  ServerEvent,
  SessionInfo,
  SessionStatus,
} from '@agent-web-bridge/protocol'
import type { AgentEvent, AgentProvider, AgentRuntime, UploadedFile, UserInput } from './agent'
import { MemorySessionStore, type SessionRecord, type SessionStore } from './store'

export const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000

const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES = 10
/** Decoded size limit per image (the Claude API limit). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FILES = 20
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export interface BridgeOptions {
  providers: AgentProvider[]
  /** Defaults to an in-memory store. */
  store?: SessionStore
  /** Time a session may sit idle (or wait for a permission answer) before its process is stopped. */
  sessionTtlMs?: number
  /** When set, session working directories must be inside one of these directories. */
  allowedRoots?: string[]
  /**
   * Scratch directory for files users upload (any kind, not only images). Each session
   * gets its own subdirectory, which its agent may read and which is removed with the
   * session. File uploads are off when this is not set.
   */
  uploadDir?: string
  /** Largest accepted upload, in bytes. Default 100 MB. */
  maxUploadBytes?: number
}

/** A message from a client; files are uploaded beforehand and referenced by id. */
export interface SendInput {
  text: string
  images?: ImageAttachment[]
  files?: Pick<FileAttachment, 'id'>[]
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
  private uploadDir?: string
  readonly maxUploadBytes: number

  constructor(options: BridgeOptions) {
    for (const provider of options.providers) this.providers.set(provider.info.id, provider)
    this.store = options.store ?? new MemorySessionStore()
    this.ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.allowedRoots = options.allowedRoots?.map((root) => resolve(root))
    this.uploadDir = options.uploadDir ? resolve(options.uploadDir) : undefined
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  }

  get agents(): AgentInfo[] {
    return [...this.providers.values()].map((p) => ({ ...p.info, supportsFiles: this.acceptsFiles(p) }))
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
        return this.send(command.sessionId, { text: command.text, images: command.images, files: command.files })
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

  async send(id: string, input: SendInput): Promise<void> {
    const record = await this.record(id)
    const text = input.text?.trim() ?? ''
    const images = input.images?.length ? input.images : undefined
    if (!text && !images && !input.files?.length) throw new BridgeError(400, 'Message is empty')
    if (images) checkImages(images, this.provider(record.agentId).info.supportsImages)
    const files = input.files?.length ? await this.resolveFiles(record, input.files) : undefined

    const now = Date.now()
    record.lastActiveAt = now
    if (!record.title) record.title = text ? titleFrom(text) : images ? 'Image' : titleFrom(files![0]!.name)
    await this.store.saveSession(record)
    // Clients see the files without their server paths.
    const attachments = files?.map(({ path: _, ...file }) => file)
    await this.addMessage(id, { id: randomUUID(), kind: 'user', createdAt: now, text, images, files: attachments })

    const runtime = await this.ensureRuntime(id)
    this.setStatus(id, 'busy')
    await runtime.send({ text, images, files } satisfies UserInput)
  }

  /**
   * Saves a file as `<uploadDir>/<session id>/<name>`, so a following `send` can attach it.
   * A name already taken in the session gets a suffix (`report-1.pdf`, `report-2.pdf`, ...);
   * the stored name is the file's id. `data` is read to the end, or until it passes `maxUploadBytes`.
   */
  async uploadFile(id: string, name: string, data: AsyncIterable<Uint8Array>): Promise<FileAttachment> {
    const record = await this.record(id)
    const dir = this.sessionUploadDir(record)
    await mkdir(dir, { recursive: true })
    const { handle, name: stored } = await createUnique(dir, safeFileName(name))
    const path = join(dir, stored)
    let size = 0
    try {
      try {
        for await (const chunk of data) {
          size += chunk.byteLength
          if (size > this.maxUploadBytes) {
            throw new BridgeError(413, `File is larger than ${formatSize(this.maxUploadBytes)}`)
          }
          await handle.write(chunk)
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
    return { id: stored, name: stored, size }
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
    if (this.uploadDir) await rm(join(this.uploadDir, id), { recursive: true, force: true })
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

  private acceptsFiles(provider: AgentProvider): boolean {
    return !!this.uploadDir && !!provider.info.supportsFiles
  }

  private sessionUploadDir(record: SessionRecord): string {
    if (!this.acceptsFiles(this.provider(record.agentId))) throw new BridgeError(400, 'This agent does not accept files')
    return join(this.uploadDir!, record.id)
  }

  /** Looks up files uploaded to the session; their name and size are taken from disk, not from the client. */
  private async resolveFiles(record: SessionRecord, files: Pick<FileAttachment, 'id'>[]): Promise<UploadedFile[]> {
    const dir = this.sessionUploadDir(record)
    if (files.length > MAX_FILES) throw new BridgeError(400, `At most ${MAX_FILES} files per message`)
    return Promise.all(
      files.map(async ({ id }) => {
        // The id is the stored name, so it must be a plain name inside the session's directory.
        if (typeof id !== 'string' || safeFileName(id) !== id) throw new BridgeError(400, 'Invalid file id')
        const path = join(dir, id)
        const info = await stat(path).catch(() => undefined)
        if (!info?.isFile()) throw new BridgeError(400, `Uploaded file not found: ${id}`)
        return { id, name: id, size: info.size, path }
      }),
    )
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
        const provider = this.provider(record.agentId)
        const uploadDir = this.acceptsFiles(provider) ? join(this.uploadDir!, record.id) : undefined
        if (uploadDir) await mkdir(uploadDir, { recursive: true })
        const runtime = await provider.start({
          sessionId: record.id,
          cwd: record.cwd,
          uploadDir,
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

/** Keeps the client's file name (the agent sees it) but makes it a single safe path segment. */
function safeFileName(name: string): string {
  const cleaned = basename(String(name).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file'
  // Most file systems allow 255 bytes per name; leave room for a `-N` suffix.
  if (Buffer.byteLength(cleaned) <= 200) return cleaned
  const [stem, ext] = splitExtension(cleaned)
  let short = stem
  while (Buffer.byteLength(short + ext) > 200) short = short.slice(0, -1)
  return short + ext
}

/** `report.pdf` → [`report`, `.pdf`]; a leading dot (`.env`) is not an extension. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 && name.length - dot <= 16 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** Creates `name` in `dir`, or `name-1`, `name-2`, ... (before the extension) when it exists. */
async function createUnique(dir: string, name: string): Promise<{ handle: FileHandle; name: string }> {
  const [stem, ext] = splitExtension(name)
  for (let n = 0; ; n++) {
    const candidate = n ? `${stem}-${n}${ext}` : name
    try {
      // `wx` fails if the file exists, so concurrent uploads of one name cannot take the same slot.
      return { handle: await open(join(dir, candidate), 'wx'), name: candidate }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
