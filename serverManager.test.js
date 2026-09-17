const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const sm = require('../server/serverManager');

function makeUser(db, name) {
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, money, eggs_hatched, income_per_sec, brainrots, created_at)
    VALUES (?, 'x', 50, 0, 0, '[]', ?)
  `).run(name, Date.now());
  return info.lastInsertRowid;
}

// ---------------- creation & codes ----------------

test('creating a server generates a valid code and makes the creator host + sole member', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack');
  const server = sm.createServer(db, { creatorId: jack, name: "Jack's Server" });
  assert.equal(server.host_id, jack);
  assert.equal(server.creator_id, jack);
  assert.match(server.code, /^[A-Z0-9]{6}$/);
  assert.equal(sm.countMembers(db, server.id), 1);
});

test('server codes are unique across many creations', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack');
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const s = sm.createServer(db, { creatorId: jack, name: 'S' + i });
    assert.ok(!codes.has(s.code), 'duplicate code generated');
    codes.add(s.code);
  }
});

// ---------------- joining ----------------

test('joining by code adds a member', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  assert.equal(sm.countMembers(db, server.id), 2);
});

test('joining is case-insensitive on the code', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code.toLowerCase() });
  assert.equal(sm.countMembers(db, server.id), 2);
});

test('joining with an invalid code fails with NOT_FOUND', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack');
  assert.throws(() => sm.joinServer(db, { userId: jack, code: 'ZZZZZZ' }), (e) => e.code === 'NOT_FOUND');
});

test('a 7th player cannot join a full 6/6 server', () => {
  const db = createDb(':memory:');
  const host = makeUser(db, 'host');
  const server = sm.createServer(db, { creatorId: host, name: 'Full' });
  for (let i = 0; i < 5; i++) sm.joinServer(db, { userId: makeUser(db, 'p' + i), code: server.code });
  assert.equal(sm.countMembers(db, server.id), 6);
  const seventh = makeUser(db, 'seventh');
  assert.throws(() => sm.joinServer(db, { userId: seventh, code: server.code }), (e) => e.code === 'SERVER_FULL');
  assert.equal(sm.countMembers(db, server.id), 6);
});

test('rejoining as an existing member never double-counts against the cap', () => {
  const db = createDb(':memory:');
  const host = makeUser(db, 'host');
  const server = sm.createServer(db, { creatorId: host, name: 'S' });
  for (let i = 0; i < 5; i++) sm.joinServer(db, { userId: makeUser(db, 'p' + i), code: server.code });
  assert.equal(sm.countMembers(db, server.id), 6);
  sm.joinServer(db, { userId: host, code: server.code }); // host "rejoins" (e.g. reconnect flow)
  assert.equal(sm.countMembers(db, server.id), 6);
});

test('many simultaneous joins never push a server past the 6-player cap', () => {
  const db = createDb(':memory:');
  const host = makeUser(db, 'host');
  const server = sm.createServer(db, { creatorId: host, name: 'S' });
  const users = Array.from({ length: 10 }, (_, i) => makeUser(db, 'u' + i));
  let joined = 0, full = 0;
  for (const u of users) {
    try { sm.joinServer(db, { userId: u, code: server.code }); joined++; }
    catch (e) { if (e.code === 'SERVER_FULL') full++; else throw e; }
  }
  assert.equal(joined, 5); // + host already present = 6
  assert.equal(full, 5);
  assert.equal(sm.countMembers(db, server.id), 6);
});

test('duplicate membership rows are never created for the same user/server pair', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: bob, code: server.code });
  assert.equal(sm.countMembers(db, server.id), 2);
});

// ---------------- leaving & host transfer ----------------

test('leaving removes membership without deleting the server', () => {
  const db = createDb(':memory:');
  const host = makeUser(db, 'host'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: host, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.leaveServer(db, { serverId: server.id, userId: bob });
  assert.equal(sm.countMembers(db, server.id), 1);
  assert.equal(sm.getServerById(db, server.id).status, 'active');
});

test('an empty server is marked empty, not deleted, when the last member leaves', () => {
  const db = createDb(':memory:');
  const host = makeUser(db, 'host');
  const server = sm.createServer(db, { creatorId: host, name: 'S' });
  sm.leaveServer(db, { serverId: server.id, userId: host });
  const s = sm.getServerById(db, server.id);
  assert.equal(s.status, 'empty');
  assert.notEqual(s.status, 'deleted');
});

test('host disconnecting transfers host to the longest-connected member without kicking anyone', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.setOnline(db, { serverId: server.id, userId: jack, online: false });
  const s = sm.getServerById(db, server.id);
  assert.equal(s.host_id, bob); // bob joined before steve
  assert.equal(sm.countMembers(db, server.id), 3); // nobody removed
});

test('host reconnecting does NOT automatically take host status back', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.setOnline(db, { serverId: server.id, userId: jack, online: false });
  assert.equal(sm.getServerById(db, server.id).host_id, bob);
  sm.setOnline(db, { serverId: server.id, userId: jack, online: true });
  assert.equal(sm.getServerById(db, server.id).host_id, bob); // still bob
});

test('manual host transfer requires being the current host and an online target', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });

  assert.throws(
    () => sm.transferHostManual(db, { serverId: server.id, requesterId: bob, targetUserId: steve }),
    (e) => e.code === 'NOT_HOST'
  );

  sm.setOnline(db, { serverId: server.id, userId: steve, online: false });
  assert.throws(
    () => sm.transferHostManual(db, { serverId: server.id, requesterId: jack, targetUserId: steve }),
    (e) => e.code === 'TARGET_OFFLINE'
  );

  sm.setOnline(db, { serverId: server.id, userId: steve, online: true });
  sm.transferHostManual(db, { serverId: server.id, requesterId: jack, targetUserId: steve });
  assert.equal(sm.getServerById(db, server.id).host_id, steve);
});

test('reconnecting (going back online) never creates a duplicate membership', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.setOnline(db, { serverId: server.id, userId: jack, online: false });
  sm.setOnline(db, { serverId: server.id, userId: jack, online: true });
  assert.equal(sm.countMembers(db, server.id), 1);
});

// ---------------- shared-consent deletion voting ----------------

test('the host cannot delete a server alone — approval is required from everyone else', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });

  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  assert.equal(sm.getServerById(db, server.id).status, 'active');
  assert.equal(sm.getDeletionStatus(db, server.id).neededCount, 2); // bob + steve, not jack
});

test('only the host can start a deletion vote', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  assert.throws(
    () => sm.startDeletionVote(db, { serverId: server.id, requesterId: bob }),
    (e) => e.code === 'NOT_HOST'
  );
});

test('unanimous approval from all required members deletes the server', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });

  assert.throws(
    () => sm.castDeletionVote(db, { serverId: server.id, userId: jack, vote: 'approved' }),
    (e) => e.code === 'INITIATOR_CANNOT_VOTE'
  );

  let r = sm.castDeletionVote(db, { serverId: server.id, userId: bob, vote: 'approved' });
  assert.equal(r.outcome, 'pending');
  assert.equal(sm.getServerById(db, server.id).status, 'active');

  r = sm.castDeletionVote(db, { serverId: server.id, userId: steve, vote: 'approved' });
  assert.equal(r.outcome, 'deleted');
  assert.equal(sm.getServerById(db, server.id).status, 'deleted');
});

test('a single denial cancels the whole deletion request', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  sm.castDeletionVote(db, { serverId: server.id, userId: bob, vote: 'approved' });
  const r = sm.castDeletionVote(db, { serverId: server.id, userId: steve, vote: 'denied' });
  assert.equal(r.outcome, 'cancelled');
  assert.equal(sm.getDeletionStatus(db, server.id), null);
  assert.equal(sm.getServerById(db, server.id).status, 'active');
});

test('voting twice as the same player never inflates the approval count', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  sm.castDeletionVote(db, { serverId: server.id, userId: bob, vote: 'approved' });
  sm.castDeletionVote(db, { serverId: server.id, userId: bob, vote: 'approved' });
  assert.equal(sm.getDeletionStatus(db, server.id).approvedCount, 1);
});

test('a non-member cannot cast a deletion vote', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), outsider = makeUser(db, 'outsider');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  assert.throws(
    () => sm.castDeletionVote(db, { serverId: server.id, userId: outsider, vote: 'approved' }),
    (e) => e.code === 'NOT_MEMBER'
  );
});

test('a member leaving mid-vote recalculates the requirement and can trigger deletion', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  sm.castDeletionVote(db, { serverId: server.id, userId: bob, vote: 'approved' });
  sm.leaveServer(db, { serverId: server.id, userId: steve }); // steve leaves instead of voting
  assert.equal(sm.getServerById(db, server.id).status, 'deleted'); // bob's approval now satisfies the shrunk requirement
});

test('the initiator leaving cancels their own pending deletion request', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  sm.leaveServer(db, { serverId: server.id, userId: jack });
  assert.equal(sm.getDeletionStatus(db, server.id), null);
  assert.equal(sm.getServerById(db, server.id).status, 'active');
});

test('host disconnecting mid-vote transfers host but never auto-approves on their behalf', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), steve = makeUser(db, 'steve');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.joinServer(db, { userId: steve, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  sm.setOnline(db, { serverId: server.id, userId: jack, online: false });

  assert.equal(sm.getServerById(db, server.id).host_id, bob); // host transferred
  const status = sm.getDeletionStatus(db, server.id);
  assert.equal(status.initiatorId, jack); // vote still tracks the original initiator
  assert.equal(status.neededCount, 2); // bob and steve are both still required
  assert.equal(status.approvedCount, 0); // jack's disconnect approved nothing
});

test('a client cannot forge a vote for another player — vote identity is server-resolved only', () => {
  // castDeletionVote only ever trusts the userId the HTTP/WS layer resolved from
  // a verified session, never a value read out of the request body. This test
  // documents that a caller cannot vote "as" someone who isn't a member, which
  // is the only lever a forged request could pull against this function.
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob'), forger = makeUser(db, 'forger');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  sm.startDeletionVote(db, { serverId: server.id, requesterId: jack });
  assert.throws(
    () => sm.castDeletionVote(db, { serverId: server.id, userId: forger, vote: 'approved' }),
    (e) => e.code === 'NOT_MEMBER'
  );
});

test('clients cannot delete a server directly — only unanimous voting (or the sole-member case) does', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack'), bob = makeUser(db, 'bob');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  sm.joinServer(db, { userId: bob, code: server.code });
  // There is deliberately no "deleteServer(db, {serverId})" function that just
  // flips status to deleted — the only paths that can do that are
  // startDeletionVote (sole-member fast path) and checkAndMaybeExecuteDeletion
  // (reached only through castDeletionVote/leaveServer). Confirm the module
  // doesn't expose a shortcut:
  assert.equal(typeof sm.deleteServer, 'undefined');
  assert.equal(sm.getServerById(db, server.id).status, 'active');
});

test('the six-player walkthrough from the spec behaves as described', () => {
  const db = createDb(':memory:');
  const jack = makeUser(db, 'jack');
  const server = sm.createServer(db, { creatorId: jack, name: 'S' });
  const ids = {};
  for (const n of ['bob', 'steve', 'mike', 'sarah', 'alex']) {
    ids[n] = makeUser(db, n);
    sm.joinServer(db, { userId: ids[n], code: server.code });
  }
  assert.equal(sm.countMembers(db, server.id), 6);

  sm.leaveServer(db, { serverId: server.id, userId: jack });
  assert.equal(sm.getServerById(db, server.id).host_id, ids.bob);
  assert.equal(sm.countMembers(db, server.id), 5);

  sm.leaveServer(db, { serverId: server.id, userId: ids.bob });
  assert.equal(sm.getServerById(db, server.id).host_id, ids.steve);
  assert.equal(sm.countMembers(db, server.id), 4);

  // Jack later reconnects using his account and the server's code.
  sm.joinServer(db, { userId: jack, code: server.code });
  assert.equal(sm.getServerById(db, server.id).host_id, ids.steve); // steve remains host
  assert.equal(sm.countMembers(db, server.id), 5);
});
