import type {
  AgentInfo,
  ChatMessage,
  ClientCommand,
  CreateSessionRequest,
  ImageAttachment,
  PermissionResponse,
  ServerEvent,
  SessionInfo,
} from '@agent-web-bridge/protocol'
import { getCurrentInstance, onBeforeUnmount, onMounted, reactive } from 'vue'

export interface AgentBridgeClientOptions {
  /** Where the server handler is mounted, e.g. `/api/agent`. */
  baseUrl: string
  /** Send cookies on cross-origin requests. */
  withCredentials?: boolean
  /** Extra headers for command and transcript requests (EventSource cannot send headers). */
  headers?: () => Record<string, string>
}

export interface AgentBridgeState {
  /** Whether the event stream is open. It reconnects on its own. */
  connected: boolean
  agents: AgentInfo[]
  sessions: SessionInfo[]
  /** Transcripts of sessions loaded with `loadMessages`, kept live afterwards. */
  messages: Record<string, ChatMessage[]>
}

export type AgentBridgeClient = ReturnType<typeof createAgentBridgeClient>

export function createAgentBridgeClient(options: AgentBridgeClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const state = reactive<AgentBridgeState>({ connected: false, agents: [], sessions: [], messages: {} })
  const loaded = new Set<string>()
  let source: EventSource | undefined
  /** Client clock minus server clock, applied to `expiresAt`. */
  let skew = 0

  function connect() {
    if (source) return
    source = new EventSource(`${baseUrl}/events`, { withCredentials: options.withCredentials })
    source.onmessage = (event) => apply(JSON.parse(event.data) as ServerEvent)
    source.onerror = () => (state.connected = false)
  }

  function disconnect() {
    source?.close()
    source = undefined
    state.connected = false
  }

  function apply(event: ServerEvent) {
    switch (event.type) {
      case 'hello':
        skew = Date.now() - event.now
        state.agents = event.agents
        state.sessions = event.sessions.map(localTime)
        state.connected = true
        // Events may have been missed while disconnected.
        for (const id of loaded) {
          if (state.sessions.some((s) => s.id === id)) void loadMessages(id, { force: true })
          else forget(id)
        }
        break
      case 'session.updated':
        upsertSession(event.session)
        break
      case 'session.deleted':
        state.sessions = state.sessions.filter((s) => s.id !== event.sessionId)
        forget(event.sessionId)
        break
      case 'message.upsert': {
        const list = state.messages[event.sessionId]
        if (list) upsertMessage(list, event.message)
        break
      }
    }
  }

  function localTime(session: SessionInfo): SessionInfo {
    return session.expiresAt ? { ...session, expiresAt: session.expiresAt + skew } : session
  }

  function upsertSession(session: SessionInfo) {
    const index = state.sessions.findIndex((s) => s.id === session.id)
    if (index === -1) state.sessions.push(localTime(session))
    else state.sessions[index] = localTime(session)
  }

  function forget(id: string) {
    loaded.delete(id)
    delete state.messages[id]
  }

  /** Fetches a transcript once; after that it is kept up to date by events. */
  async function loadMessages(id: string, { force = false } = {}) {
    if (loaded.has(id) && !force) return
    loaded.add(id)
    state.messages[id] ??= []
    const fetched = await request<ChatMessage[]>(`/sessions/${encodeURIComponent(id)}/messages`)
    // Messages that arrived as events during the fetch are at least as new as the fetched ones.
    const live = new Map((state.messages[id] ?? []).map((m) => [m.id, m]))
    const merged = fetched.map((m) => live.get(m.id) ?? m)
    const fetchedIds = new Set(fetched.map((m) => m.id))
    for (const m of live.values()) if (!fetchedIds.has(m.id)) merged.push(m)
    if (loaded.has(id)) state.messages[id] = merged
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials: options.withCredentials ? 'include' : 'same-origin',
      headers: { 'content-type': 'application/json', ...options.headers?.(), ...init?.headers },
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
    return body as T
  }

  function command<T = { ok: true }>(command: ClientCommand) {
    return request<T>('/commands', { method: 'POST', body: JSON.stringify(command) })
  }

  return {
    state,
    connect,
    disconnect,
    loadMessages,
    async create(request: CreateSessionRequest): Promise<SessionInfo> {
      const { session } = await command<{ session: SessionInfo }>({ type: 'session.create', ...request })
      upsertSession(session)
      return session
    },
    send: (sessionId: string, text: string, images?: ImageAttachment[]) =>
      command({ type: 'session.send', sessionId, text, images: images?.length ? images : undefined }),
    interrupt: (sessionId: string) => command({ type: 'session.interrupt', sessionId }),
    update: (sessionId: string, options: { model?: string; permissionMode?: string }) =>
      command({ type: 'session.update', sessionId, ...options }),
    respondPermission: (sessionId: string, requestId: string, response: PermissionResponse) =>
      command({ type: 'session.permission', sessionId, requestId, ...response }),
    suspend: (sessionId: string) => command({ type: 'session.suspend', sessionId }),
    remove: (sessionId: string) => command({ type: 'session.delete', sessionId }),
  }
}

/** Creates a client that is connected while the calling component is mounted. */
export function useAgentBridge(options: AgentBridgeClientOptions): AgentBridgeClient {
  const client = createAgentBridgeClient(options)
  if (getCurrentInstance()) {
    onMounted(client.connect)
    onBeforeUnmount(client.disconnect)
  }
  return client
}

function upsertMessage(list: ChatMessage[], message: ChatMessage) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.id === message.id) {
      list[i] = message
      return
    }
  }
  list.push(message)
}
