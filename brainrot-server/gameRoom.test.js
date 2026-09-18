const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { GameRoom, PLOTS_PER_BASE, BELT_TRAVEL_TIME } = require('../server/gameRoom');
const { BrainrotLayout } = require('../server/layout');

function makeUser(db, name, money = 50) {
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, money, eggs_hatched, income_per_sec, brainrots, created_at)
    VALUES (?, 'x', ?, 0, 0, ?, ?)
  `).run(name, money, JSON.stringify(Array(PLOTS_PER_BASE).fill(null)), Date.now());
  return info.lastInsertRowid;
}

function makeRoom(db) {
  const room = new GameRoom(db, 1, () => {});
  room.destroy(); // we drive ticks manually so tests are deterministic
  room.beltSpawnTimer = Infinity; // tests spawn belt items explicitly unless testing spawn timing itself
  return room;
}

test('selling refunds cash and frees the plot', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  const p = room.players.get(alice);
  p.economy.brainrots[0] = { name: 'x', shape: 'blob', income: 5, rarity: 'common' };
  room.sell(alice, 0);
  assert.equal(p.economy.brainrots[0], null);
  assert.equal(p.economy.money, 100 + 60); // 5*12
});

test('income accrues over ticks proportional to owned brainrots', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  const p = room.players.get(alice);
  p.economy.brainrots[0] = { name: 'x', shape: 'blob', income: 10, rarity: 'common' };
  const before = p.economy.money;
  for (let i = 0; i < 20; i++) room.tick(); // 20 * 0.05s min-tick = ~1s of income at the 10/s rate
  assert.ok(p.economy.money > before + 0.5, `expected income to accrue, got ${p.economy.money - before}`);
});

test('a thief camping an unattended plot eventually steals it', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const bob = makeUser(db, 'bob', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  room.addPlayer(bob, 'bob', null);
  const a = room.players.get(alice), b = room.players.get(bob);
  a.economy.brainrots[0] = { name: 'x', shape: 'blob', income: 5, rarity: 'common' };

  const plotPos = BrainrotLayout.plotWorldPos(a.baseSlot, 0);
  b.x = plotPos.x; b.z = plotPos.z; b.wantSteal = true;
  a.x = -9999; a.z = -9999; // alice is far away from her own base — undefended

  for (let i = 0; i < 60; i++) room.tick(); // 60 * 0.05s = 3s, comfortably over STEAL_TIME
  assert.equal(a.economy.brainrots[0], null);
  assert.equal(b.economy.brainrots.filter(Boolean).length, 1);
});

test('the owner standing near their own plot interrupts a theft in progress', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const bob = makeUser(db, 'bob', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  room.addPlayer(bob, 'bob', null);
  const a = room.players.get(alice), b = room.players.get(bob);
  a.economy.brainrots[0] = { name: 'x', shape: 'blob', income: 5, rarity: 'common' };

  const plotPos = BrainrotLayout.plotWorldPos(a.baseSlot, 0);
  b.x = plotPos.x; b.z = plotPos.z; b.wantSteal = true;
  a.x = plotPos.x; a.z = plotPos.z; // alice is standing right at her own plot

  for (let i = 0; i < 60; i++) room.tick();
  assert.notEqual(a.economy.brainrots[0], null); // never stolen
  assert.equal(b.economy.brainrots.filter(Boolean).length, 0);
});

test('evicting a player frees their base slot for a new joiner', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice');
  const bob = makeUser(db, 'bob');
  const room = makeRoom(db);
  const a = room.addPlayer(alice, 'alice', null);
  room.evictPlayer(alice);
  const b = room.addPlayer(bob, 'bob', null);
  assert.equal(b.baseSlot, a.baseSlot);
});

test('the room enforces a maximum of 6 players', () => {
  const db = createDb(':memory:');
  const room = makeRoom(db);
  for (let i = 0; i < 6; i++) room.addPlayer(makeUser(db, 'p' + i), 'p' + i, null);
  const seventh = makeUser(db, 'seventh');
  assert.throws(() => room.addPlayer(seventh, 'seventh', null), (e) => e.code === 'ROOM_FULL');
});

// ---------------- conveyor belt ----------------

test('a spawned belt item advances along the belt over time', () => {
  const db = createDb(':memory:');
  const room = makeRoom(db);
  room.spawnBeltItem();
  assert.equal(room.belt.length, 1);
  assert.equal(room.belt[0].t, 0);
  room.updateBelt(BELT_TRAVEL_TIME / 4); // one quarter of the full travel time
  assert.ok(Math.abs(room.belt[0].t - 0.25) < 0.01);
});

test('an unclaimed belt item despawns once it reaches the far end', () => {
  const db = createDb(':memory:');
  const room = makeRoom(db);
  const seen = [];
  room.broadcast = (msg) => seen.push(msg);
  room.spawnBeltItem();
  room.updateBelt(BELT_TRAVEL_TIME + 1); // push it past the end in one step
  assert.equal(room.belt.length, 0);
  assert.ok(seen.some(m => m.type === 'event' && m.kind === 'belt_despawn'));
});

test('a player standing where a belt item currently is claims it into an open plot', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice');
  const room = makeRoom(db);
  const a = room.addPlayer(alice, 'alice', null);
  room.spawnBeltItem();
  const midPos = BrainrotLayout.beltPositionAt(0.5);
  room.belt[0].t = 0.5;
  a.x = midPos.x; a.z = midPos.z;

  const events = [];
  room.broadcast = (msg) => events.push(msg);
  room.updateBelt(0.001); // negligible travel, just enough to run the claim check

  assert.equal(room.belt.length, 0); // claimed, removed from the belt
  assert.equal(a.economy.brainrots.filter(Boolean).length, 1);
  assert.ok(events.some(m => m.type === 'event' && m.kind === 'claimed' && m.userId === alice));
});

test('claiming with a full base converts the item to a cash bonus instead', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 0);
  const room = makeRoom(db);
  const a = room.addPlayer(alice, 'alice', null);
  a.economy.brainrots = a.economy.brainrots.map(() => ({ name: 'x', shape: 'blob', income: 1, rarity: 'common' }));

  room.spawnBeltItem();
  const midPos = BrainrotLayout.beltPositionAt(0.5);
  room.belt[0].t = 0.5;
  a.x = midPos.x; a.z = midPos.z;
  room.updateBelt(0.001);

  assert.equal(room.belt.length, 0);
  assert.ok(a.economy.money > 0, 'expected a cash bonus since the base was full');
});

test('two players equidistant-ish from a belt item: only one claims it, never both', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice');
  const bob = makeUser(db, 'bob');
  const room = makeRoom(db);
  const a = room.addPlayer(alice, 'alice', null);
  const b = room.addPlayer(bob, 'bob', null);
  room.spawnBeltItem();
  const midPos = BrainrotLayout.beltPositionAt(0.5);
  room.belt[0].t = 0.5;
  a.x = midPos.x; a.z = midPos.z;
  b.x = midPos.x + 0.1; b.z = midPos.z;
  room.updateBelt(0.001);

  const aHas = a.economy.brainrots.filter(Boolean).length;
  const bHas = b.economy.brainrots.filter(Boolean).length;
  assert.equal(aHas + bHas, 1, 'exactly one player should have claimed the item');
});

test('a belt item spawns on its own after enough time passes', () => {
  const db = createDb(':memory:');
  const room = new GameRoom(db, 1, () => {});
  room.destroy();
  room.beltSpawnTimer = 0.5;
  room.updateBelt(1); // more than enough to cross the spawn threshold
  assert.equal(room.belt.length, 1);
});
