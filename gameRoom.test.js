const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { GameRoom, PLOTS_PER_BASE } = require('../server/gameRoom');
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
  return room;
}

test('hatching deducts cost and fills the first open slot', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  room.hatch(alice);
  const p = room.players.get(alice);
  assert.equal(p.economy.money, 60); // 100 - 40 base cost
  assert.equal(p.economy.eggsHatched, 1);
  assert.equal(p.economy.brainrots.filter(Boolean).length, 1);
});

test('hatching fails cleanly when the player cannot afford it', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 10);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  room.hatch(alice);
  const p = room.players.get(alice);
  assert.equal(p.economy.money, 10); // unchanged
  assert.equal(p.economy.eggsHatched, 0);
});

test('hatching fails cleanly when the base is full', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100000);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  const p = room.players.get(alice);
  p.economy.brainrots = p.economy.brainrots.map(() => ({ name: 'x', shape: 'blob', income: 1, rarity: 'common' }));
  const moneyBefore = p.economy.money;
  room.hatch(alice);
  assert.equal(p.economy.money, moneyBefore); // nothing spent
});

test('selling refunds cash and frees the plot', () => {
  const db = createDb(':memory:');
  const alice = makeUser(db, 'alice', 100);
  const room = makeRoom(db);
  room.addPlayer(alice, 'alice', null);
  room.hatch(alice);
  const p = room.players.get(alice);
  const idx = p.economy.brainrots.findIndex(Boolean);
  const income = p.economy.brainrots[idx].income;
  const moneyBefore = p.economy.money;
  room.sell(alice, idx);
  assert.equal(p.economy.brainrots[idx], null);
  assert.equal(p.economy.money, moneyBefore + Math.round(income * 12));
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
