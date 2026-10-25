import type { ChatMessage, SessionInfo } from '@agent-web-bridge/protocol'

export interface SessionRecord extends Omit<SessionInfo, 'status' | 'expiresAt'> {
  providerSessionId?: string
  /** Host data from `CommandContext.meta`; never sent to clients. */
  meta?: Record<string, unknown>
}

/**
 * Persistence for sessions and transcripts, so suspended sessions keep their
 * history and can be resumed after a server restart. Implement it for your DB.
 */
export interface SessionStore {
  listSessions(): Promise<SessionRecord[]>
  getSession(id: string): Promise<SessionRecord | undefined>
  saveSession(session: SessionRecord): Promise<void>
  /** Deletes the session and its messages. */
  deleteSession(id: string): Promise<void>
  /** Inserts messages, replacing any with the same id while keeping their position. */
  saveMessages(sessionId: string, messages: ChatMessage[]): Promise<void>
  /** Messages in insertion order. */
  listMessages(sessionId: string): Promise<ChatMessage[]>
}

/** Keeps everything in process memory; sessions are lost on restart. */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>()
  private messages = new Map<string, Map<string, ChatMessage>>()

  async listSessions() {
    return [...this.sessions.values()].map((s) => structuredClone(s))
  }

  async getSession(id: string) {
    const session = this.sessions.get(id)
    return session && structuredClone(session)
  }

  async saveSession(session: SessionRecord) {
    this.sessions.set(session.id, structuredClone(session))
  }

  async deleteSession(id: string) {
    this.sessions.delete(id)
    this.messages.delete(id)
  }

  async saveMessages(sessionId: string, messages: ChatMessage[]) {
    let byId = this.messages.get(sessionId)
    if (!byId) this.messages.set(sessionId, (byId = new Map()))
    for (const message of messages) byId.set(message.id, structuredClone(message))
  }

  async listMessages(sessionId: string) {
    return [...(this.messages.get(sessionId)?.values() ?? [])].map((m) => structuredClone(m))
  }
}
