const { BrainrotLayout } = require('./layout');
const { baseCenter, plotWorldPos, spawnPos, PLOTS_PER_BASE } = BrainrotLayout;

const TICK_MS = 150;
const STEAL_RANGE = 2.7;
const DEFEND_RANGE = 3.2; // owner within this range of the plot interrupts a theft in progress
const STEAL_TIME = 2.3;
const MAX_SPEED = 7.5; // slightly above the client's own move speed to absorb latency jitter
const HATCH_BASE_COST = 40;
const MAX_HATCH_COST = 5000;

const BRAINROT_POOL = {
  common: [
    { name: 'Spaghetto Rollino', emoji: '🍝', shape: 'blob', income: 1.0 },
    { name: 'Scootero Buffo', emoji: '🛵', shape: 'wheelbot', income: 1.3 },
    { name: 'Panino Turbato', emoji: '🥖', shape: 'loaf', income: 1.6 },
    { name: 'Formaggio Saltante', emoji: '🧀', shape: 'wedge', income: 1.8 },
  ],
  rare: [
    { name: 'Trombonzo Volante', emoji: '🎺', shape: 'horn', income: 4.0 },
    { name: 'Motorino Espresso', emoji: '☕', shape: 'wheelbot', income: 5.0 },
    { name: 'Violino Selvaggio', emoji: '🎻', shape: 'stringed', income: 6.5 },
  ],
  epic: [
    { name: 'Sirena Meccanica', emoji: '⚙️', shape: 'crystal', income: 14 },
    { name: 'Vulcano Ballerino', emoji: '🌋', shape: 'spike', income: 17 },
    { name: 'Chitarra Fantasma', emoji: '🎸', shape: 'stringed', income: 20 },
  ],
  legendary: [
    { name: 'Imperatore Focaccia', emoji: '👑', shape: 'crown', income: 38 },
    { name: 'Drago di Provolone', emoji: '🐉', shape: 'winged', income: 45 },
  ],
  secret: [
    { name: 'Supremo Multiverso', emoji: '🌌', shape: 'orb', income: 120 },
  ],
};

function rollRarity() {
  const r = Math.random() * 100;
  if (r < 1) return 'secret';
  if (r < 5) return 'legendary';
  if (r < 17) return 'epic';
  if (r < 45) return 'rare';
  return 'common';
}
function rollBrainrot() {
  const rarity = rollRarity();
  const pool = BRAINROT_POOL[rarity];
  const base = pool[Math.floor(Math.random() * pool.length)];
  return { ...base, rarity };
}
function computeIncome(brainrots) {
  return brainrots.reduce((sum, b) => sum + (b ? b.income : 0), 0);
}
function emptyBase() {
  return Array.from({ length: PLOTS_PER_BASE }, () => null);
}

function loadUserEconomy(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  let brainrots;
  try {
    brainrots = JSON.parse(u.brainrots);
    if (!Array.isArray(brainrots) || brainrots.length !== PLOTS_PER_BASE) throw new Error('shape');
  } catch (e) {
    brainrots = emptyBase();
  }
  return { money: u.money, eggsHatched: u.eggs_hatched, brainrots };
}
function saveUserEconomy(db, userId, econ) {
  db.prepare('UPDATE users SET money = ?, eggs_hatched = ?, income_per_sec = ?, brainrots = ? WHERE id = ?')
    .run(econ.money, econ.eggsHatched, computeIncome(econ.brainrots), JSON.stringify(econ.brainrots), userId);
}

class GameRoom {
  constructor(db, serverId, broadcastFn) {
    this.db = db;
    this.serverId = serverId;
    this.broadcast = broadcastFn; // (obj) => void — sends JSON to every connected socket in this room
    this.players = new Map(); // userId -> runtime state (persists across disconnects until evicted)
    this.freeSlots = [0, 1, 2, 3, 4, 5];
    this.stealState = new Map(); // `${thiefId}:${victimId}:${plotIndex}` -> { progress }
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  destroy() { clearInterval(this.timer); }

  addPlayer(userId, username, ws) {
    const existing = this.players.get(userId);
    if (existing) {
      existing.ws = ws;
      existing.connected = true;
      return existing;
    }
    if (this.freeSlots.length === 0) {
      throw Object.assign(new Error('Room is full'), { code: 'ROOM_FULL' });
    }
    const slot = this.freeSlots.shift();
    const econ = loadUserEconomy(this.db, userId);
    const spawn = spawnPos(slot);
    const p = {
      userId, username, ws, connected: true, baseSlot: slot,
      x: spawn.x, z: spawn.z, facing: 0, moving: false, wantSteal: false,
      lastInputAt: Date.now(),
      economy: econ,
    };
    this.players.set(userId, p);
    return p;
  }

  markDisconnected(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    p.connected = false;
    p.ws = null;
    saveUserEconomy(this.db, userId, p.economy);
  }

  // Called when the player's *membership* in the server is removed (not just
  // a dropped connection) — frees their base slot for someone else.
  evictPlayer(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    saveUserEconomy(this.db, userId, p.economy);
    this.freeSlots.push(p.baseSlot);
    this.freeSlots.sort((a, b) => a - b);
    this.players.delete(userId);
    for (const key of [...this.stealState.keys()]) {
      const [thiefId, victimId] = key.split(':').map(Number);
      if (thiefId === userId || victimId === userId) this.stealState.delete(key);
    }
  }

  isEmpty() { return this.players.size === 0; }

  handleInput(userId, msg) {
    const p = this.players.get(userId);
    if (!p) return;
    const now = Date.now();
    const dt = Math.max(0.001, Math.min(0.5, (now - p.lastInputAt) / 1000));
    p.lastInputAt = now;

    if (typeof msg.x === 'number' && typeof msg.z === 'number' && Number.isFinite(msg.x) && Number.isFinite(msg.z)) {
      const dist = Math.hypot(msg.x - p.x, msg.z - p.z);
      const maxDist = MAX_SPEED * dt;
      if (dist > maxDist * 1.2 && dist > 0) {
        // Don't trust a jump bigger than physically possible — clamp toward it instead.
        const ratio = maxDist / dist;
        p.x += (msg.x - p.x) * ratio;
        p.z += (msg.z - p.z) * ratio;
      } else {
        p.x = msg.x;
        p.z = msg.z;
      }
    }
    if (typeof msg.facing === 'number' && Number.isFinite(msg.facing)) p.facing = msg.facing;
    p.moving = !!msg.moving;
    p.wantSteal = !!msg.steal;
  }

  hatch(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    const cost = Math.min(MAX_HATCH_COST, Math.round(HATCH_BASE_COST * Math.pow(1.15, p.economy.eggsHatched)));
    if (p.economy.money < cost) {
      this.sendTo(userId, { type: 'error', code: 'NOT_ENOUGH_CASH', message: 'Not enough cash' });
      return;
    }
    const slotIndex = p.economy.brainrots.findIndex(b => !b);
    if (slotIndex === -1) {
      this.sendTo(userId, { type: 'error', code: 'BASE_FULL', message: 'Base is full — sell one first' });
      return;
    }
    p.economy.money -= cost;
    p.economy.eggsHatched += 1;
    const def = rollBrainrot();
    p.economy.brainrots[slotIndex] = def;
    saveUserEconomy(this.db, userId, p.economy);
    this.broadcast({ type: 'event', kind: 'hatched', userId, plotIndex: slotIndex, brainrot: def });
  }

  sell(userId, plotIndex) {
    const p = this.players.get(userId);
    if (!p || plotIndex < 0 || plotIndex >= PLOTS_PER_BASE) return;
    const item = p.economy.brainrots[plotIndex];
    if (!item) return;
    const cash = Math.round(item.income * 12);
    p.economy.money += cash;
    p.economy.brainrots[plotIndex] = null;
    saveUserEconomy(this.db, userId, p.economy);
    this.broadcast({ type: 'event', kind: 'sold', userId, plotIndex, cash });
  }

  tick() {
    const now = Date.now();
    const dt = Math.max(0.05, Math.min(1, (now - this.lastTick) / 1000));
    this.lastTick = now;

    for (const p of this.players.values()) {
      const income = computeIncome(p.economy.brainrots);
      if (income > 0) p.economy.money += income * dt;
    }

    for (const thief of this.players.values()) {
      if (!thief.connected || !thief.wantSteal) continue;
      let target = null, bestDist = Infinity;
      for (const victim of this.players.values()) {
        if (victim.userId === thief.userId) continue;
        for (let i = 0; i < victim.economy.brainrots.length; i++) {
          if (!victim.economy.brainrots[i]) continue;
          const pos = plotWorldPos(victim.baseSlot, i);
          const d = Math.hypot(thief.x - pos.x, thief.z - pos.z);
          if (d < STEAL_RANGE && d < bestDist) { bestDist = d; target = { victim, plotIndex: i }; }
        }
      }
      // Decay/drop progress for anything this thief isn't actively on top of right now.
      for (const key of [...this.stealState.keys()]) {
        if (!key.startsWith(`${thief.userId}:`)) continue;
        const stillValid = target && key === `${thief.userId}:${target.victim.userId}:${target.plotIndex}`;
        if (!stillValid) this.stealState.delete(key);
      }
      if (!target) continue;

      const owner = target.victim;
      const plotPos = plotWorldPos(owner.baseSlot, target.plotIndex);
      const ownerNearby = Math.hypot(owner.x - plotPos.x, owner.z - plotPos.z) < DEFEND_RANGE;
      const key = `${thief.userId}:${owner.userId}:${target.plotIndex}`;
      if (ownerNearby) {
        if (this.stealState.delete(key)) {
          this.broadcast({ type: 'event', kind: 'caught', thiefId: thief.userId, victimId: owner.userId });
        }
        continue;
      }
      const cur = this.stealState.get(key) || { progress: 0 };
      cur.progress += dt / STEAL_TIME;
      if (cur.progress >= 1) {
        this.stealState.delete(key);
        const item = owner.economy.brainrots[target.plotIndex];
        owner.economy.brainrots[target.plotIndex] = null;
        const openSlot = thief.economy.brainrots.findIndex(b => !b);
        if (openSlot !== -1) {
          thief.economy.brainrots[openSlot] = item;
        } else {
          thief.economy.money += Math.round(item.income * 15);
        }
        saveUserEconomy(this.db, owner.userId, owner.economy);
        saveUserEconomy(this.db, thief.userId, thief.economy);
        this.broadcast({ type: 'event', kind: 'stolen', thiefId: thief.userId, victimId: owner.userId, plotIndex: target.plotIndex, brainrot: item });
      } else {
        this.stealState.set(key, cur);
      }
    }

    this.broadcastState();
  }

  sendTo(userId, obj) {
    const p = this.players.get(userId);
    if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }

  broadcastState() {
    const players = [...this.players.values()]
      .filter(p => p.connected)
      .map(p => ({ userId: p.userId, username: p.username, baseSlot: p.baseSlot, x: p.x, z: p.z, facing: p.facing, moving: p.moving }));
    const bases = [...this.players.values()].map(p => ({
      userId: p.userId, username: p.username, baseSlot: p.baseSlot, connected: p.connected,
      money: p.economy.money, incomePerSec: computeIncome(p.economy.brainrots),
      eggsHatched: p.economy.eggsHatched, brainrots: p.economy.brainrots,
    }));
    const steals = [...this.stealState.entries()].map(([key, v]) => {
      const [thiefId, victimId, plotIndex] = key.split(':').map(Number);
      return { thiefId, victimId, plotIndex, progress: Math.min(1, v.progress) };
    });
    this.broadcast({ type: 'room_state', players, bases, steals, serverTime: Date.now() });
  }
}

module.exports = { GameRoom, PLOTS_PER_BASE, HATCH_BASE_COST, MAX_HATCH_COST, STEAL_TIME, STEAL_RANGE, DEFEND_RANGE };
