const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function validateUsername(username) {
  const u = (username || '').trim();
  if (u.length < 3 || u.length > 20) throw err('BAD_USERNAME', 'Username must be 3-20 characters');
  if (!/^[a-zA-Z0-9_]+$/.test(u)) throw err('BAD_USERNAME', 'Username may only contain letters, numbers, and underscore');
  return u;
}
function validatePassword(password) {
  if (!password || password.length < 6 || password.length > 200) {
    throw err('BAD_PASSWORD', 'Password must be at least 6 characters');
  }
}

function publicUser(db, userId) {
  const u = db.prepare(
    'SELECT id, username, money, eggs_hatched, income_per_sec, brainrots, created_at FROM users WHERE id = ?'
  ).get(userId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    money: u.money,
    eggsHatched: u.eggs_hatched,
    incomePerSec: u.income_per_sec,
    brainrots: JSON.parse(u.brainrots),
    createdAt: u.created_at,
  };
}

function createSession(db, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return { token, user: publicUser(db, userId) };
}

function signup(db, { username, password }) {
  const uname = validateUsername(username);
  validatePassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (existing) throw err('USERNAME_TAKEN', 'That username is already taken');

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, money, eggs_hatched, income_per_sec, brainrots, created_at)
    VALUES (?, ?, 50, 0, 0, '[]', ?)
  `).run(uname, hash, Date.now());
  return createSession(db, info.lastInsertRowid);
}

function login(db, { username, password }) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user) throw err('INVALID_CREDENTIALS', 'Invalid username or password');
  if (!bcrypt.compareSync(password || '', user.password_hash)) {
    throw err('INVALID_CREDENTIALS', 'Invalid username or password');
  }
  return createSession(db, user.id);
}

// Resolves a bearer token to a user id. This is the ONLY way the rest of the
// server should ever learn "who is making this request" — nothing here reads
// an identity claim out of a request body.
function getUserIdByToken(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  return row ? row.user_id : null;
}

function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { signup, login, getUserIdByToken, logout, publicUser };
