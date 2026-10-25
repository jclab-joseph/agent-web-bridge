import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatMessage, SessionRecord, SessionStore } from '@agent-web-bridge/server'

/** SessionStore on Node's built-in SQLite. Records are stored as JSON. */
export class SqliteSessionStore implements SessionStore {
  private db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (session_id, id)
      );
    `)
  }

  async listSessions() {
    const rows = this.db.prepare('SELECT data FROM sessions').all() as { data: string }[]
    return rows.map((row) => JSON.parse(row.data) as SessionRecord)
  }

  async getSession(id: string) {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined
    return row && (JSON.parse(row.data) as SessionRecord)
  }

  async saveSession(session: SessionRecord) {
    this.db
      .prepare('INSERT INTO sessions (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data')
      .run(session.id, JSON.stringify(session))
  }

  async deleteSession(id: string) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async saveMessages(sessionId: string, messages: ChatMessage[]) {
    const upsert = this.db.prepare(
      'INSERT INTO messages (session_id, id, data) VALUES (?, ?, ?) ON CONFLICT (session_id, id) DO UPDATE SET data = excluded.data',
    )
    for (const message of messages) upsert.run(sessionId, message.id, JSON.stringify(message))
  }

  async listMessages(sessionId: string) {
    const rows = this.db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      data: string
    }[]
    return rows.map((row) => JSON.parse(row.data) as ChatMessage)
  }
}
