// Server-authoritative multiplayer lobby logic for Brainrot Heist 3D.
//
// Every function here takes a `db` handle first and plain data after that —
// there is no concept of "trust the client" anywhere in this file. The HTTP/WS
// layer (index.js) is responsible for resolving `userId` from a verified
// session token before calling into any of these functions; nothing here ever
// accepts an identity claim from a request body.

const MAX_PLAYERS = 6;
// Ambiguous characters (0/O, 1/I/L) are excluded so codes are easy to read and type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}
function now() { return Date.now(); }

function generateCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function generateUniqueCode(db) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = generateCode();
    const existing = db.prepare('SELECT id FROM servers WHERE code = ?').get(code);
    if (!existing) return code;
  }
  throw err('CODE_SPACE_EXHAUSTED', 'Could not generate a unique server code, try again');
}

function getServerById(db, serverId) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
}
function getServerByCode(db, code) {
  if (!code) return undefined;
  return db.prepare('SELECT * FROM servers WHERE code = ?').get(String(code).trim().toUpperCase());
}
function getMembers(db, serverId) {
  return db.prepare(`
    SELECT sm.server_id, sm.user_id, sm.joined_at, sm.online, u.username
    FROM server_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = ?
    ORDER BY sm.joined_at ASC
  `).all(serverId);
}
function countMembers(db, serverId) {
  return db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(serverId).c;
}
function isMember(db, serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}
function listServersForUser(db, userId) {
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ? AND s.status != 'deleted'
    ORDER BY s.last_active_at DESC
  `).all(userId);
}

function createServer(db, { creatorId, name }) {
  const cleanName = (name || '').trim().slice(0, 40) || "Unnamed Server";
  const code = generateUniqueCode(db);
  const ts = now();
  const info = db.prepare(`
    INSERT INTO servers (code, name, creator_id, host_id, status, created_at, last_active_at, pending_deletion)
    VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
  `).run(code, cleanName, creatorId, creatorId, ts, ts);
  const serverId = info.lastInsertRowid;
  db.prepare('INSERT INTO server_members (server_id, user_id, joined_at, online) VALUES (?, ?, ?, 1)')
    .run(serverId, creatorId, ts);
  return getServerById(db, serverId);
}

function joinServer(db, { userId, code }) {
  const server = getServerByCode(db, code);
  if (!server || server.status === 'deleted') throw err('NOT_FOUND', 'Server not found');

  const already = isMember(db, server.id, userId);
  if (!already) {
    if (countMembers(db, server.id) >= MAX_PLAYERS) throw err('SERVER_FULL', 'This server already has 6/6 players');
  }
  const ts = now();
  if (already) {
    db.prepare('UPDATE server_members SET online = 1 WHERE server_id = ? AND user_id = ?').run(server.id, userId);
  } else {
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at, online) VALUES (?, ?, ?, 1)')
      .run(server.id, userId, ts);
  }
  db.prepare("UPDATE servers SET status = 'active', last_active_at = ? WHERE id = ?").run(ts, server.id);
  return getServerById(db, server.id);
}

// Longest-connected eligible member becomes host; falls back to "any remaining
// member" if nobody is currently online, so the server always has a host on
// record even while empty of active connections.
function chooseNextHost(db, serverId, excludeUserId) {
  const members = getMembers(db, serverId).filter(m => m.user_id !== excludeUserId);
  if (members.length === 0) return null;
  const online = members.filter(m => m.online);
  const pool = (online.length ? online : members).slice().sort((a, b) => a.joined_at - b.joined_at);
  return pool[0].user_id;
}

function leaveServer(db, { serverId, userId }) {
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  if (!isMember(db, serverId, userId)) throw err('NOT_MEMBER', 'Not a member of this server');

  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
  const ts = now();
  const remaining = countMembers(db, serverId);

  if (server.host_id === userId && remaining > 0) {
    const nextHost = chooseNextHost(db, serverId, userId);
    if (nextHost) db.prepare('UPDATE servers SET host_id = ? WHERE id = ?').run(nextHost, serverId);
  }

  const pending = parsePending(getServerById(db, serverId));
  if (pending && pending.initiatorId === userId) {
    // The person who asked for the deletion left — cancel the request rather
    // than leaving it orphaned or letting someone else's approvals finish it.
    db.prepare('UPDATE servers SET pending_deletion = NULL WHERE id = ?').run(serverId);
  } else if (pending) {
    checkAndMaybeExecuteDeletion(db, serverId);
  }

  if (remaining === 0) {
    db.prepare("UPDATE servers SET status = 'empty', last_active_at = ? WHERE id = ?").run(ts, serverId);
  } else {
    db.prepare('UPDATE servers SET last_active_at = ? WHERE id = ?').run(ts, serverId);
  }
  return getServerById(db, serverId);
}

// For socket connect/disconnect — membership is preserved either way, this
// only toggles presence and, if the host just went offline, hands host status
// to someone else so the lobby never depends on one connection staying alive.
function setOnline(db, { serverId, userId, online }) {
  if (!isMember(db, serverId, userId)) throw err('NOT_MEMBER', 'Not a member of this server');
  db.prepare('UPDATE server_members SET online = ? WHERE server_id = ? AND user_id = ?')
    .run(online ? 1 : 0, serverId, userId);
  const server = getServerById(db, serverId);
  if (!online && server.host_id === userId) {
    const nextHost = chooseNextHost(db, serverId, userId);
    if (nextHost) db.prepare('UPDATE servers SET host_id = ? WHERE id = ?').run(nextHost, serverId);
  }
  return getServerById(db, serverId);
}

function transferHostManual(db, { serverId, requesterId, targetUserId }) {
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  if (server.host_id !== requesterId) throw err('NOT_HOST', 'Only the current host can transfer host status');
  const target = db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, targetUserId);
  if (!target) throw err('NOT_MEMBER', 'Target is not a member of this server');
  if (!target.online) throw err('TARGET_OFFLINE', 'Target must be online to receive host status');
  db.prepare('UPDATE servers SET host_id = ?, last_active_at = ? WHERE id = ?').run(targetUserId, now(), serverId);
  return getServerById(db, serverId);
}

// ---------------- shared-consent deletion voting ----------------

function parsePending(server) {
  return server && server.pending_deletion ? JSON.parse(server.pending_deletion) : null;
}

function getDeletionStatus(db, serverId) {
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  const pending = parsePending(server);
  if (!pending) return null;
  const members = getMembers(db, serverId);
  const required = members.filter(m => m.user_id !== pending.initiatorId);
  const approvedCount = required.filter(m => pending.votes[m.user_id] === 'approved').length;
  return {
    initiatorId: pending.initiatorId,
    startedAt: pending.startedAt,
    votes: pending.votes,
    requiredVoterIds: required.map(m => m.user_id),
    approvedCount,
    neededCount: required.length,
  };
}

function startDeletionVote(db, { serverId, requesterId }) {
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  if (server.host_id !== requesterId) throw err('NOT_HOST', 'Only the host can start a deletion vote');
  if (parsePending(server)) throw err('VOTE_IN_PROGRESS', 'A deletion vote is already in progress');

  const members = getMembers(db, serverId);
  if (members.length <= 1) {
    // Nobody else to ask — the host is the only member, so the request resolves immediately.
    db.prepare("UPDATE servers SET status = 'deleted', pending_deletion = NULL, last_active_at = ? WHERE id = ?")
      .run(now(), serverId);
    return getServerById(db, serverId);
  }
  const pending = { initiatorId: requesterId, startedAt: now(), votes: {} };
  db.prepare('UPDATE servers SET pending_deletion = ?, last_active_at = ? WHERE id = ?')
    .run(JSON.stringify(pending), now(), serverId);
  return getServerById(db, serverId);
}

function checkAndMaybeExecuteDeletion(db, serverId) {
  const status = getDeletionStatus(db, serverId);
  if (!status) return 'none';
  if (status.neededCount === 0 || status.approvedCount >= status.neededCount) {
    db.prepare("UPDATE servers SET status = 'deleted', pending_deletion = NULL, last_active_at = ? WHERE id = ?")
      .run(now(), serverId);
    return 'deleted';
  }
  return 'pending';
}

function castDeletionVote(db, { serverId, userId, vote }) {
  if (vote !== 'approved' && vote !== 'denied') throw err('BAD_VOTE', 'Vote must be "approved" or "denied"');
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  const pending = parsePending(server);
  if (!pending) throw err('NO_VOTE', 'No deletion vote is in progress');
  if (!isMember(db, serverId, userId)) throw err('NOT_MEMBER', 'Not a member of this server');
  if (userId === pending.initiatorId) throw err('INITIATOR_CANNOT_VOTE', 'The host who started the vote does not also approve it');

  if (vote === 'denied') {
    db.prepare('UPDATE servers SET pending_deletion = NULL, last_active_at = ? WHERE id = ?').run(now(), serverId);
    return { outcome: 'cancelled', server: getServerById(db, serverId) };
  }

  // Overwriting the same key means a second vote from the same player can
  // never inflate the approval count — this map can only ever hold one
  // entry per member.
  pending.votes[userId] = 'approved';
  db.prepare('UPDATE servers SET pending_deletion = ?, last_active_at = ? WHERE id = ?')
    .run(JSON.stringify(pending), now(), serverId);

  const outcome = checkAndMaybeExecuteDeletion(db, serverId);
  return { outcome, server: getServerById(db, serverId), status: getDeletionStatus(db, serverId) };
}

function cancelDeletionVote(db, { serverId, requesterId }) {
  const server = getServerById(db, serverId);
  if (!server) throw err('NOT_FOUND', 'Server not found');
  const pending = parsePending(server);
  if (!pending) throw err('NO_VOTE', 'No deletion vote is in progress');
  if (requesterId !== pending.initiatorId && requesterId !== server.host_id) {
    throw err('FORBIDDEN', 'Not allowed to cancel this vote');
  }
  db.prepare('UPDATE servers SET pending_deletion = NULL, last_active_at = ? WHERE id = ?').run(now(), serverId);
  return getServerById(db, serverId);
}

module.exports = {
  MAX_PLAYERS,
  generateUniqueCode,
  getServerById, getServerByCode, getMembers, countMembers, isMember, listServersForUser,
  createServer, joinServer, leaveServer, setOnline, transferHostManual, chooseNextHost,
  startDeletionVote, castDeletionVote, cancelDeletionVote, getDeletionStatus,
};
