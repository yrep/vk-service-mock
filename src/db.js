import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function nowIso() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS group_integrations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT    NOT NULL,              -- bapi88 user id
  email                TEXT    NOT NULL DEFAULT '',
  group_id             INTEGER NOT NULL UNIQUE,       -- VK community id
  token                TEXT    NOT NULL,
  server_id            INTEGER,
  confirmation_code    TEXT,
  is_server_configured INTEGER NOT NULL DEFAULT 0,
  callbacks            TEXT,                          -- comma separated list
  binder_path          TEXT,
  alias                TEXT    UNIQUE,                -- mock-only friendly name
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS vk_user (
  id          INTEGER PRIMARY KEY,                    -- VK user id
  first_name  TEXT,
  last_name   TEXT,
  screen_name TEXT,
  sex         INTEGER,                                -- 1 = female, 2 = male
  city        TEXT,
  alias       TEXT UNIQUE,                            -- mock-only friendly name
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL,
  peer_id         INTEGER NOT NULL,                   -- VK user id / thread
  vk_user_id      INTEGER NOT NULL,
  alias           TEXT UNIQUE,                        -- mock-only friendly name
  last_item       INTEGER NOT NULL DEFAULT 0,         -- last conversation_message_id
  messages_count  INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (group_id, peer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  direction         TEXT    NOT NULL,                 -- incoming | outgoing
  group_id          INTEGER NOT NULL,
  chat_id           INTEGER,
  from_id           INTEGER NOT NULL,
  to_id             INTEGER NOT NULL,
  peer_id           INTEGER,
  thread            INTEGER,
  item              INTEGER,                          -- conversation_message_id
  text              TEXT    NOT NULL DEFAULT '',
  outgoing          INTEGER NOT NULL DEFAULT 0,
  hook_type         TEXT,
  source            TEXT,
  payload           TEXT,                             -- JSON: hook sent / body received
  delivery_url      TEXT,
  delivery_ok       INTEGER,
  delivery_status   INTEGER,
  delivery_response TEXT,
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_group  ON messages (group_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_peer   ON messages (peer_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages (direction, id);
CREATE INDEX IF NOT EXISTS idx_chats_group     ON chats (group_id);
`;

export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function resetDatabase(db, { keepAutoincrement = false } = {}) {
  for (const table of ['messages', 'chats', 'vk_user', 'group_integrations']) {
    db.exec(`DELETE FROM ${table};`);
  }
  if (!keepAutoincrement) {
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('messages','chats','group_integrations');`);
  }
}
