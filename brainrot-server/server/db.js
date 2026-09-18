const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// Creates (or opens) the database. Pass ':memory:' (or falsy) for an
// ephemeral in-memory database — this is what the test suite uses so every
// test starts from a clean slate with no shared state or disk I/O.
function createDb(filePath) {
  const target = filePath && filePath !== ':memory:' ? filePath : ':memory:';
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      money REAL NOT NULL DEFAULT 50,
      eggs_hatched INTEGER NOT NULL DEFAULT 0,
      income_per_sec REAL NOT NULL DEFAULT 0,
      brainrots TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      host_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      pending_deletion TEXT
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at INTEGER NOT NULL,
      online INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (server_id, user_id)
    );
  `);
  return db;
}

module.exports = { createDb };
