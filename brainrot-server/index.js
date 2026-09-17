const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { createDb } = require('./db');
const auth = require('./auth');
const sm = require('./serverManager');
const { GameRoom, PLOTS_PER_BASE, HATCH_BASE_COST } = require('./gameRoom');

const PORT = process.env.PORT || 8787;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'brainrot.db');

const db = createDb(DB_PATH);

const app = express();

app.use(express.json());

// Serve index.html and other files from the project root
app.use(express.static(__dirname));

app.get('/layout.js', (req, res) => res.sendFile(path.join(__dirname, 'layout.js')));

// ---------------- auth middleware ----------------

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const userId = auth.getUserIdByToken(db, token);
  if (!userId) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Log in first' });
  req.userId = userId;
  next();
}

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      const status = { NOT_FOUND: 404, UNAUTHENTICATED: 401 }[e.code] || 400;
      res.status(status).json({ error: e.code || 'ERROR', message: e.message });
    }
  };
}

// ---------------- auth routes ----------------

app.post('/api/signup', handle((req, res) => {
  const result = auth.signup(db, req.body || {});
  res.json(result);
}));

app.post('/api/login', handle((req, res) => {
  const result = auth.login(db, req.body || {});
  res.json(result);
}));

app.post('/api/logout', requireAuth, handle((req, res) => {
  const authHeader = req.headers.authorization || '';
  auth.logout(db, authHeader.slice(7));
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, handle((req, res) => {
  res.json({ user: auth.publicUser(db, req.userId) });
}));

// ---------------- leaderboards ----------------

app.get('/api/leaderboards', handle((req, res) => {
  const topMoney = db.prepare('SELECT username, money FROM users ORDER BY money DESC LIMIT 10').all();
  const topEggs = db.prepare('SELECT username, eggs_hatched FROM users ORDER BY eggs_hatched DESC LIMIT 10').all();
  const topIncome = db.prepare('SELECT username, income_per_sec FROM users ORDER BY income_per_sec DESC LIMIT 10').all();
  res.json({ topMoney, topEggs, topIncome });
}));

// ---------------- server/lobby routes ----------------

function serverView(row) {
  if (!row) return null;
  const members = sm.getMembers(db, row.id).map(m => ({ userId: m.user_id, username: m.username, online: !!m.online, joinedAt: m.joined_at, isHost: m.user_id === row.host_id }));
  return {
    id: row.id, code: row.code, name: row.name,
    creatorId: row.creator_id, hostId: row.host_id, status: row.status,
    createdAt: row.created_at, lastActiveAt: row.last_active_at,
    members,
    deletion: sm.getDeletionStatus(db, row.id),
  };
}

app.get('/api/servers', requireAuth, handle((req, res) => {
  const rows = sm.listServersForUser(db, req.userId);
  res.json({ servers: rows.map(serverView) });
}));

app.post('/api/servers', requireAuth, handle((req, res) => {
  const server = sm.createServer(db, { creatorId: req.userId, name: (req.body || {}).name });
  res.json({ server: serverView(server) });
}));

app.post('/api/servers/join', requireAuth, handle((req, res) => {
  const server = sm.joinServer(db, { userId: req.userId, code: (req.body || {}).code });
  res.json({ server: serverView(server) });
}));

app.get('/api/servers/:id', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  if (!sm.isMember(db, id, req.userId)) throw Object.assign(new Error('Not a member'), { code: 'NOT_MEMBER' });
  res.json({ server: serverView(sm.getServerById(db, id)) });
}));

app.post('/api/servers/:id/leave', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  const server = sm.leaveServer(db, { serverId: id, userId: req.userId });
  const room = rooms.get(id);
  if (room) {
    room.evictPlayer(req.userId);
    if (room.isEmpty()) { room.destroy(); rooms.delete(id); }
  }
  res.json({ server: serverView(server) });
}));

app.post('/api/servers/:id/transfer-host', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  const server = sm.transferHostManual(db, { serverId: id, requesterId: req.userId, targetUserId: (req.body || {}).targetUserId });
  res.json({ server: serverView(server) });
}));

app.post('/api/servers/:id/delete-vote/start', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  const server = sm.startDeletionVote(db, { serverId: id, requesterId: req.userId });
  res.json({ server: serverView(server) });
}));

app.post('/api/servers/:id/delete-vote/cast', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  const result = sm.castDeletionVote(db, { serverId: id, userId: req.userId, vote: (req.body || {}).vote });
  res.json({ outcome: result.outcome, server: serverView(result.server) });
}));

app.post('/api/servers/:id/delete-vote/cancel', requireAuth, handle((req, res) => {
  const id = Number(req.params.id);
  const server = sm.cancelDeletionVote(db, { serverId: id, requesterId: req.userId });
  res.json({ server: serverView(server) });
}));

app.get('/api/config', (req, res) => {
  res.json({ plotsPerBase: PLOTS_PER_BASE, hatchBaseCost: HATCH_BASE_COST });
});

// ---------------- websocket game protocol ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // serverId -> GameRoom

function getOrCreateRoom(serverId) {
  let room = rooms.get(serverId);
  if (room) return room;
  let roomRef;
  const broadcast = (obj) => {
    const msg = JSON.stringify(obj);
    for (const p of roomRef.players.values()) {
      if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(msg);
    }
  };
  roomRef = new GameRoom(db, serverId, broadcast);
  rooms.set(serverId, roomRef);
  return roomRef;
}

wss.on('connection', (ws, req) => {
  let userId = null;
  let serverId = null;
  let username = null;

  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    serverId = Number(url.searchParams.get('serverId'));
    userId = auth.getUserIdByToken(db, token);
    if (!userId) throw new Error('bad token');
    if (!serverId || !sm.isMember(db, serverId, userId)) throw new Error('not a member');
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED', message: 'Could not join that server' }));
    ws.close();
    return;
  }

  const user = auth.publicUser(db, userId);
  username = user.username;

  let room;
  try {
    room = getOrCreateRoom(serverId);
    const p = room.addPlayer(userId, username, ws);
    sm.setOnline(db, { serverId, userId, online: true });
    ws.send(JSON.stringify({ type: 'you_are', userId, baseSlot: p.baseSlot, plotsPerBase: PLOTS_PER_BASE, username }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', code: e.code || 'JOIN_FAILED', message: e.message }));
    ws.close();
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'input') room.handleInput(userId, msg);
    else if (msg.type === 'hatch') room.hatch(userId);
    else if (msg.type === 'sell' && typeof msg.plotIndex === 'number') room.sell(userId, msg.plotIndex);
  });

  ws.on('close', () => {
    room.markDisconnected(userId);
    try { sm.setOnline(db, { serverId, userId, online: false }); } catch (e) { /* server may have been deleted */ }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Brainrot Heist multiplayer server listening on port ${PORT}`);
});

module.exports = { app, server };
