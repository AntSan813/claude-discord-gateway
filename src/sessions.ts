import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

export interface SessionRecord {
  channelId: string
  sessionId: string
  projectName: string
  updatedAt: string
}

export interface SavedSession {
  label: string
  sessionId: string
  projectName: string
  savedAt: string
}

export class SessionStore {
  private db: Database.Database

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        channel_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saved_sessions (
        channel_id TEXT NOT NULL,
        label TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        saved_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (channel_id, label)
      )
    `)
  }

  get(channelId: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM sessions WHERE channel_id = ?")
      .get(channelId) as { session_id: string } | undefined

    return row?.session_id ?? null
  }

  set(channelId: string, sessionId: string, projectName: string): void {
    this.db
      .prepare(
        `
        INSERT INTO sessions (channel_id, session_id, project_name, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(channel_id) DO UPDATE SET
          session_id = excluded.session_id,
          project_name = excluded.project_name,
          updated_at = datetime('now')
      `
      )
      .run(channelId, sessionId, projectName)
  }

  clear(channelId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId)
  }

  getAll(): SessionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT channel_id, session_id, project_name, updated_at FROM sessions"
      )
      .all() as Array<{
      channel_id: string
      session_id: string
      project_name: string
      updated_at: string
    }>

    return rows.map(row => ({
      channelId: row.channel_id,
      sessionId: row.session_id,
      projectName: row.project_name,
      updatedAt: row.updated_at,
    }))
  }

  save(channelId: string, label: string): boolean {
    const row = this.db
      .prepare(
        "SELECT session_id, project_name FROM sessions WHERE channel_id = ?"
      )
      .get(channelId) as
      | { session_id: string; project_name: string }
      | undefined

    if (!row) return false

    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO saved_sessions (channel_id, label, session_id, project_name, saved_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `
      )
      .run(channelId, label, row.session_id, row.project_name)

    return true
  }

  listSaved(channelId: string): SavedSession[] {
    const rows = this.db
      .prepare(
        "SELECT label, session_id, project_name, saved_at FROM saved_sessions WHERE channel_id = ? ORDER BY saved_at DESC"
      )
      .all(channelId) as Array<{
      label: string
      session_id: string
      project_name: string
      saved_at: string
    }>

    return rows.map(row => ({
      label: row.label,
      sessionId: row.session_id,
      projectName: row.project_name,
      savedAt: row.saved_at,
    }))
  }

  restore(channelId: string, label: string): boolean {
    const row = this.db
      .prepare(
        "SELECT session_id, project_name FROM saved_sessions WHERE channel_id = ? AND label = ?"
      )
      .get(channelId, label) as
      | { session_id: string; project_name: string }
      | undefined

    if (!row) return false

    this.set(channelId, row.session_id, row.project_name)

    this.db
      .prepare("DELETE FROM saved_sessions WHERE channel_id = ? AND label = ?")
      .run(channelId, label)

    return true
  }

  close(): void {
    this.db.close()
  }
}
