import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.BRAIN_DB || "./brain.db";

export function openDb(path = DB_PATH) {
  const dir = path === ":memory:" ? null : path.split("/").slice(0, -1).join("/");
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS schema_v (v INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- fact|preference|project|procedure|episode|question|correction
    key TEXT,                      -- stable slot e.g. pref:style, fact:timezone
    content TEXT NOT NULL,
    entities TEXT DEFAULT '[]',
    source TEXT DEFAULT 'user',    -- user|inferred|reflection|job
    confidence REAL DEFAULT 1.0,
    importance REAL DEFAULT 0.5,
    status TEXT DEFAULT 'active',  -- active|superseded|deleted
    superseded_by INTEGER,
    expires_at INTEGER,            -- epoch ms, null = keep
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type, status);
  CREATE INDEX IF NOT EXISTS idx_mem_key ON memories(key, status);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content);
  CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE rowid = old.id;
  END;
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT 'Chat',
    reflected_through INTEGER DEFAULT 0, -- last message id processed
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL, -- user|assistant|system-note
    content TEXT NOT NULL,
    used_memory_ids TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- reflect|consolidate|digest|moment-check|research
    payload TEXT DEFAULT '{}',
    status TEXT DEFAULT 'queued',  -- queued|running|done|failed|cancelled
    run_at INTEGER NOT NULL,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    dedupe_key TEXT UNIQUE,
    last_error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_at);
  CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    reason TEXT DEFAULT '',
    priority INTEGER DEFAULT 1,    -- 1 low, 2 normal, 3 high
    status TEXT DEFAULT 'queued',  -- queued|delivered|dismissed|postponed|expired
    deliver_after INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,           -- user|brain|job|tool
    action TEXT NOT NULL,
    detail TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at DESC);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  `);
  const row = db.prepare("SELECT COUNT(*) AS n FROM schema_v").get();
  if (row.n === 0) {
    const now = Date.now();
    const seed = [
      ["personality", JSON.stringify({ name: "Steady", tone: "warm, direct, brief", detail: "medium" })],
      ["autonomy", JSON.stringify({ enabled: true, quiet_start: 23, quiet_end: 7, max_moments_per_day: 3, reflect_every_turns: 6 })],
      ["budget", JSON.stringify({ monthly_token_cap: 500000 })],
      ["tools", JSON.stringify({ web_fetch: "auto", memory_tools: "auto" })]
    ];
    const ins = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [k, v] of seed) ins.run(k, v);
    db.prepare("INSERT INTO schema_v (v) VALUES (1)").run();
    db.prepare("INSERT INTO activity (actor, action, detail, created_at) VALUES ('brain','init','{\"v\":1}', ?)").run(now);
  }
}

export function getSetting(db, key, fallback = null) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setSetting(db, key, val) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(val));
}
export function logActivity(db, actor, action, detail = {}) {
  db.prepare("INSERT INTO activity (actor, action, detail, created_at) VALUES (?, ?, ?, ?)").run(actor, action, JSON.stringify(detail), Date.now());
}
